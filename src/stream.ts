/**
 * Bounded-memory streaming JSONL reader.
 *
 * Nothing here ever loads a whole file: input flows through
 * `createReadStream` -> `readline` -> for-await, so peak memory is a function of
 * the widest single line, not of the file size. A 4 GB file and a 4 MB file use
 * the same amount of heap.
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import * as path from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

/** The literal `-` means "read stdin", the way every good Unix tool does it. */
export const STDIN_SENTINEL = "-";

export interface SourceSpec {
  /** A file path, or `-` for stdin. */
  input: string;
}

export interface BadLine {
  /** 1-based line number in the physical file. */
  line: number;
  /** Up to 200 characters of the offending line. */
  excerpt: string;
  /** Human-readable parser message. */
  reason: string;
}

export interface RecordHandler {
  (value: unknown, lineNumber: number, raw: string): void | Promise<void>;
}

export interface BadLineHandler {
  (bad: BadLine): void;
}

export interface StreamOptions {
  /** Skip malformed lines instead of aborting. Counted on the stats object. */
  skipInvalid?: boolean;
  /** Called for every malformed line (always, even when skipping). */
  onBadLine?: BadLineHandler;
  /** Report progress to stderr every N lines. 0 or undefined disables it. */
  progressEvery?: number;
  /** Sink for progress messages; defaults to stderr. */
  progressSink?: NodeJS.WritableStream;
  /** Called once with the total number of bytes read (0 for stdin). */
  onBytes?: (bytes: number) => void;
  /**
   * Injectable stdin. Defaults to `process.stdin`; tests pass a `Readable` so
   * pipe behaviour can be exercised without spawning a process.
   */
  stdin?: Readable;
}

export interface StreamStats {
  /** Physical lines seen, excluding a trailing empty line. */
  total: number;
  /** Lines that parsed into a JSON value. */
  valid: number;
  /** Lines that did not parse (counted whether or not they were skipped). */
  invalid: number;
  /** Bytes read from a regular file (0 when streaming stdin). */
  bytes: number;
  /** Bytes retained from stdin when the source was a pipe. */
  stdinBytes: number;
}

export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

/**
 * Validate the source before we start, so "file not found" never looks like
 * "no valid records". Directories and stdin are handled explicitly.
 */
export async function resolveSource(input: string): Promise<{ kind: "stdin" | "file"; bytes: number; path?: string }> {
  if (input === STDIN_SENTINEL) return { kind: "stdin", bytes: 0 };
  const absolute = path.resolve(input);
  let info;
  try {
    info = await stat(absolute);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new InputError(`no such file: ${input}`);
    if (code === "EACCES") throw new InputError(`permission denied: ${input}`);
    throw new InputError(`cannot read ${input}: ${(error as Error).message}`);
  }
  if (info.isDirectory()) throw new InputError(`${input} is a directory, not a JSONL file`);
  return { kind: "file", bytes: info.size, path: absolute };
}

function openStream(input: string, stdin?: Readable): Readable {
  if (input === STDIN_SENTINEL) return stdin ?? process.stdin;
  return createReadStream(path.resolve(input), { encoding: "utf8", highWaterMark: 1 << 16 });
}

function describeParseError(error: unknown): string {
  const message = (error as Error)?.message ?? String(error);
  // Node's JSON.parse messages are informative but wordy; keep the first clause.
  const cut = message.indexOf(" in JSON at position");
  return cut > 0 ? message.slice(0, cut) : message;
}

function excerptOf(raw: string): string {
  const text = raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;
  return text.replace(/\r$/, "");
}

/**
 * Stream a JSONL source and hand every decoded record to `onRecord`.
 *
 * Blank lines are ignored (they are not "invalid" — trailing newlines are
 * normal). A malformed line either throws (default) or is skipped and reported
 * through `onBadLine`, which is what `--skip-invalid` turns on.
 */
export async function streamJsonl(
  input: string,
  onRecord: RecordHandler,
  options: StreamOptions = {},
): Promise<StreamStats> {
  const { skipInvalid = false, onBadLine, progressEvery = 0, progressSink = process.stderr, onBytes, stdin } = options;
  const resolved = await resolveSource(input);
  if (onBytes) onBytes(resolved.bytes);

  const stats: StreamStats = { total: 0, valid: 0, invalid: 0, bytes: resolved.bytes, stdinBytes: 0 };
  const stream = openStream(input, stdin);
  const interface_ = createInterface({ input: stream, crlfDelay: Infinity, terminal: false });

  try {
    for await (const rawLine of interface_) {
      const line = rawLine.charCodeAt(0) === 0xfeff ? rawLine.slice(1) : rawLine;
      if (line.trim() === "") continue;

      stats.total++;
      if (progressEvery > 0 && stats.total % progressEvery === 0) {
        progressSink.write(`[jlb] ${stats.total.toLocaleString("en-US")} lines\n`);
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        stats.invalid++;
        const bad: BadLine = { line: stats.total, excerpt: excerptOf(line), reason: describeParseError(error) };
        if (onBadLine) onBadLine(bad);
        if (!skipInvalid) throw new InvalidLineError(bad);
        continue;
      }

      stats.valid++;
      await onRecord(parsed, stats.total, line);
    }
  } finally {
    // readline closes on 'close'; destroy explicitly so an aborted early exit
    // (e.g. `head -n 5`) does not leak the descriptor.
    interface_.close();
    if (input !== STDIN_SENTINEL && !stream.destroyed) stream.destroy();
  }

  return stats;
}

/** Thrown when a line is not valid JSON and `--skip-invalid` was not given. */
export class InvalidLineError extends Error {
  readonly bad: BadLine;
  constructor(bad: BadLine) {
    super(`line ${bad.line}: ${bad.reason}`);
    this.name = "InvalidLineError";
    this.bad = bad;
  }
}
