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
