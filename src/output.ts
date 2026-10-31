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

import { createWriteStream, type WriteStream } from "node:fs";
import { rename, realpath, stat, unlink } from "node:fs/promises";
import * as path from "node:path";

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
  if (outPath === undefined || outPath === "-") return new StdoutSink();
  const finalPath = path.resolve(outPath);

  if (source.kind === "file" && source.path !== undefined) {
    const inputReal = await realpathOrResolve(source.path);
    const outputReal = await realpathOrResolve(finalPath);
    if (inputReal === outputReal) {
      throw new OutputError(`refusing to write to the input file: ${outPath}`);
    }
  }

  // Fail with one clean line instead of an async EISDIR from the write stream.
  try {
    const info = await stat(finalPath);
    if (info.isDirectory()) throw new OutputError(`cannot write ${outPath}: is a directory`);
  } catch (error) {
    if (error instanceof OutputError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new OutputError(`cannot write ${outPath}: ${describe(error)}`);
    }
  }

  const suffix = `${process.pid.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const tempPath = path.join(path.dirname(finalPath), `.${path.basename(finalPath)}.${suffix}.jlb-tmp`);
  const stream = createWriteStream(tempPath, { encoding: "utf8", flags: "wx" });
  try {
    await new Promise<void>((resolve, reject) => {
      stream.once("open", () => resolve());
      stream.once("error", reject);
    });
  } catch (error) {
    stream.destroy();
    throw new OutputError(`cannot write ${outPath}: ${describe(error)}`);
  }
  return new FileSink(stream, tempPath, finalPath, outPath);
}
