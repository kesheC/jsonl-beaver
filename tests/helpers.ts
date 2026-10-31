import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

/** Every test gets its own throwaway directory; nothing touches the real filesystem. */
export async function makeTempDir(prefix = "jlb-test-"): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

export async function writeJsonl(dir: string, name: string, records: readonly unknown[]): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
  return file;
}

export async function writeText(dir: string, name: string, text: string): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(file, text, "utf8");
  return file;
}

export async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/** Collect a stream of strings written by a command implementation. */
export function collector(): { lines: string[]; push: (line: string) => void } {
  const lines: string[] = [];
  return { lines, push: (line: string) => lines.push(line) };
}
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Absolute path to the built CLI entry point. */
export const CLI_PATH = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run the real built binary. The CLI-level regressions (the -o data-loss bug,
 * EPIPE, the error-message shape) live in argument handling, which the library
 * functions cannot exercise — only a child process can.
 */
export async function runCli(args: readonly string[], options: { cwd?: string; stdin?: string } = {}): Promise<CliResult> {
  if (!existsSync(CLI_PATH)) {
    throw new Error(`missing ${CLI_PATH}; run "npm run build" before "npm test"`);
  }
  return await new Promise<CliResult>((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], { cwd: options.cwd ?? process.cwd() });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    if (options.stdin !== undefined) child.stdin.end(options.stdin);
    else child.stdin.end();
  });
}