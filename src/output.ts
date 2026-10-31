/**
 * Output sinks.
 *
 * Opening the destination is deliberately separated from running a command.
 * The file is only touched once every argument, the input source and the
 * filter expression have been validated, and the bytes go to a temporary file
 * that is renamed into place only on success. A mistyped command line can
 * therefore never truncate an existing file, and a crash mid-write leaves the
 * previous contents intact instead of a half-written file.
 */

import { createWriteStream, unlinkSync, type WriteStream } from "node:fs";
import { readdir, rename, realpath, stat, unlink } from "node:fs/promises";
import * as path from "node:path";
import process from "node:process";

/** Raised for anything the user can fix on the command line (bad -o target, ...). */
export class OutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutputError";
  }
}

export interface OutputSink {
  /** True when the sink owns a file on disk (which is renamed into place). */
  readonly isFile: boolean;
  write(text: string): void;
  /** Flush, then atomically move the temporary file into place. */
  commit(): Promise<void>;
  /** Discard everything written so far; the target file is left untouched. */
  abort(): Promise<void>;
}

/**
 * Temp files that currently exist on disk, so a signal handler can remove them.
 *
 * A crash (SIGINT/SIGTERM) never runs the normal abort path, which is why the
 * registry exists: without it an interrupted run leaves a `.name.<pid>.jlb-tmp`
 * sibling behind in the user's directory.
 */
const openTemps = new Set<string>();

/** Remove every temp file still open; safe to call more than once. */
export function discardOpenTempFiles(): void {
  for (const tempPath of openTemps) {
    try {
      unlinkSync(tempPath);
    } catch {
      // Already renamed into place or never created: nothing to do.
    }
  }
  openTemps.clear();
}

/**
 * Turn an EPIPE on stdout/stderr into something harmless.
 *
 * A downstream consumer that stops reading (`jlb filter ... | head -2`) closes
 * the pipe, and Node turns that into an "error" event on the stream. Without a
 * listener that event is unhandled and kills the process before commit(), which
 * used to leave the temp file behind. stdout is where the payload goes, so an
 * EPIPE there ends the run successfully; stderr is only logging, so it is
 * swallowed and the command carries on.
 */
export function installPipeGuard(stream: NodeJS.WritableStream, exitOnPipeClose: boolean): void {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") {
      if (exitOnPipeClose) {
        discardOpenTempFiles();
        process.exit(0);
      }
      return;
    }
    throw error;
  });
}

/** Suffix shared by every temp file this program creates. */
const TEMP_SUFFIX = "jlb-tmp";

/**
 * Is this pid still running? Used to decide whether a leftover temp file
 * belongs to a live run or to a crash. `process.kill(pid, 0)` throws ESRCH only
 * when the process is gone; EPERM means it exists but belongs to someone else.
 */
function isPidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Recover from a previous crash.
 *
 * On Linux/macOS the SIGINT/SIGTERM handlers in `cli.ts` remove the temp file
 * themselves. Windows has no such luxury: `TerminateProcess` ends the process
 * without running a single line of JavaScript, so a killed run cannot clean up
 * after itself. Sweeping the directory on the next run is the only reliable
 * recovery, and it never touches a temp file whose owning process still exists.
 */
async function sweepStaleTempFiles(directory: string, basename: string): Promise<void> {
  const prefix = `.${basename}.`;
  const suffix = `.${TEMP_SUFFIX}`;
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith(prefix) || !entry.endsWith(suffix)) continue;
    const middle = entry.slice(prefix.length, entry.length - suffix.length);
    const parts = middle.split(".");
    if (parts.length !== 2) continue;
    const pid = Number.parseInt(parts[0]!, 36);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    if (isPidAlive(pid)) continue; // a concurrent run still owns it
    try {
      await unlink(path.join(directory, entry));
    } catch {
      // Raced with another cleanup: nothing to do.
    }
  }
}

/** Turn an errno into the kind of phrase the rest of the CLI prints. */
function describe(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EISDIR") return "is a directory";
  if (code === "ENOENT") return "no such file or directory";
  if (code === "EACCES" || code === "EPERM") return "permission denied";
  if (code === "ENOSPC") return "no space left on device";
  const message = error instanceof Error ? error.message : String(error);
  return message;
}

class StdoutSink implements OutputSink {
  readonly isFile = false;
  write(text: string): void {
    process.stdout.write(text);
  }
  async commit(): Promise<void> {
    // Nothing to flush: process.exit is never called, so Node drains stdout
    // before the process ends.
  }
  async abort(): Promise<void> {
    // Nothing was buffered by us; leave stdout alone.
  }
}

class FileSink implements OutputSink {
  readonly isFile = true;
  private failure: Error | null = null;
  private settled = false;

  constructor(
    private readonly stream: WriteStream,
    private readonly tempPath: string,
    private readonly finalPath: string,
    private readonly label: string,
  ) {
    stream.on("error", (error: Error) => {
      this.failure ??= error;
    });
  }

  /** Called once the temp file has left the filesystem (renamed or unlinked). */
  private forget(): void {
    openTemps.delete(this.tempPath);
  }

  write(text: string): void {
    this.stream.write(text);
  }

  async commit(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.stream.once("finish", () => resolve());
      this.stream.once("error", () => resolve());
      this.stream.end();
    });
    this.settled = true;
    if (this.failure !== null) {
      await this.discard();
      throw new OutputError(`cannot write ${this.label}: ${describe(this.failure)}`);
    }
    try {
      await rename(this.tempPath, this.finalPath);
      this.forget();
    } catch (error) {
      await this.discard();
      throw new OutputError(`cannot write ${this.label}: ${describe(error)}`);
    }
  }

  async abort(): Promise<void> {
    if (!this.settled) {
      this.settled = true;
      if (!this.stream.closed) {
        await new Promise<void>((resolve) => {
          this.stream.once("close", () => resolve());
          this.stream.destroy();
        });
      }
    }
    await this.discard();
  }

  private async discard(): Promise<void> {
    try {
      await unlink(this.tempPath);
    } catch {
      // Already renamed, or never created: nothing to clean up.
    }
    this.forget();
  }
}

async function realpathOrResolve(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch {
    return path.resolve(target);
  }
}

/**
 * Create the sink for `-o`, or a stdout sink when no path was given.
 *
 * `source` is the already-validated input; passing it in lets us refuse to
 * overwrite the very file we are about to read (a self-inflicted data loss that
 * is otherwise easy to type: `jlb head -n 5 -o app.jsonl app.jsonl`).
 */
export async function openOutputSink(
  outPath: string | undefined,
  source: { kind: "stdin" | "file"; path?: string },
): Promise<OutputSink> {
  if (outPath === undefined) return new StdoutSink();
  // "jlb head -n 1 -o 'app.jsonl '" used to create a sibling file whose name
  // ends in a space and to miss the self-overwrite guard below, because the
  // input path was trimmed by the shell habit while the output was not.
  const target = outPath.trim();
  if (target === "") throw new OutputError("cannot write : empty --out path");
  if (target === "-") return new StdoutSink();
  const finalPath = path.resolve(target);

  if (source.kind === "file" && source.path !== undefined) {
    const inputReal = await realpathOrResolve(source.path);
    const outputReal = await realpathOrResolve(finalPath);
    if (inputReal === outputReal) {
      throw new OutputError(`refusing to write to the input file: ${target}`);
    }
  }

  // Fail with one clean line instead of an async EISDIR from the write stream.
  try {
    const info = await stat(finalPath);
    if (info.isDirectory()) throw new OutputError(`cannot write ${target}: is a directory`);
  } catch (error) {
    if (error instanceof OutputError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new OutputError(`cannot write ${target}: ${describe(error)}`);
    }
  }

  const directory = path.dirname(finalPath);
  const basename = path.basename(finalPath);
  await sweepStaleTempFiles(directory, basename);

  // <pid36>.<rand6>: the pid lets the next run tell a live sibling from a
  // crash leftover (see sweepStaleTempFiles).
  const suffix = `${process.pid.toString(36)}.${Math.random().toString(36).slice(2, 8)}`;
  const tempPath = path.join(directory, `.${basename}.${suffix}.${TEMP_SUFFIX}`);
  const stream = createWriteStream(tempPath, { encoding: "utf8", flags: "wx" });
  try {
    await new Promise<void>((resolve, reject) => {
      stream.once("open", () => resolve());
      stream.once("error", reject);
    });
  } catch (error) {
    stream.destroy();
    throw new OutputError(`cannot write ${target}: ${describe(error)}`);
  }
  openTemps.add(tempPath);
  return new FileSink(stream, tempPath, finalPath, target);
}
