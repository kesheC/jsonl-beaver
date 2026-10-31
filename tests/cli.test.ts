import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { cleanup, makeTempDir, writeJsonl, writeText, runCli } from "./helpers.js";

let dir = "";
let records = "";

beforeAll(async () => {
  dir = await makeTempDir("jlb-cli-");
  records = await writeJsonl(dir, "records.jsonl", [{ n: 1 }, { n: 2 }, { n: 3 }]);
});

afterAll(async () => {
  await cleanup(dir);
});

describe("-o safety", () => {
  it("leaves an existing output file untouched when the input does not exist", async () => {
    const target = await writeText(dir, "report.csv", "row1\nrow2\nrow3\n");
    const result = await runCli(["to-csv", "--fields", "n", "-o", target, path.join(dir, "typo-100.jsonl")], { cwd: dir });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("jlb: no such file");
    expect(await readFile(target, "utf8")).toBe("row1\nrow2\nrow3\n");
  });

  it("does not create the output file when the input is missing", async () => {
    const target = path.join(dir, "never-created.jsonl");
    const result = await runCli(["filter", "--where", "n=1", "-o", target, path.join(dir, "typo.jsonl")], { cwd: dir });
    expect(result.code).toBe(2);
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not create the output file when --where does not compile", async () => {
    const target = path.join(dir, "badwhere.jsonl");
    const result = await runCli(["filter", "--where", "n ==", "-o", target, records], { cwd: dir });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("bad --where expression");
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to overwrite the input file in place", async () => {
    const target = await writeText(dir, "inplace.jsonl", Array.from({ length: 100 }, (_, i) => JSON.stringify({ i })).join("\n") + "\n");
    const before = await readFile(target, "utf8");
    const result = await runCli(["head", "-n", "5", "-o", target, target], { cwd: dir });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("refusing to write to the input file");
    expect(await readFile(target, "utf8")).toBe(before);
  });

  it("writes the file and leaves no temp file behind", async () => {
    const target = path.join(dir, "out.csv");
    const result = await runCli(["to-csv", "--fields", "n", "-o", target, records], { cwd: dir });
    expect(result.code).toBe(0);
    expect(await readFile(target, "utf8")).toBe("n\n1\n2\n3\n");
    const { readdir } = await import("node:fs/promises");
    const names = await readdir(dir);
    expect(names.filter((name) => name.includes("jlb-tmp"))).toEqual([]);
  });
});

describe("output errors", () => {
  it("reports a directory target on one clean line", async () => {
    const result = await runCli(["to-csv", "--fields", "n", "-o", dir, records], { cwd: dir });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("jlb: cannot write");
    expect(result.stderr).toContain("is a directory");
    expect(result.stderr).not.toContain("Error: EISDIR");
    expect(result.stderr).not.toContain("    at ");
  });

  it("reports a missing parent directory on one clean line", async () => {
    const result = await runCli(["to-csv", "--fields", "n", "-o", path.join(dir, "nodir", "x.csv"), records], { cwd: dir });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("no such file or directory");
    expect(result.stderr).not.toContain("    at ");
  });
});

describe("broken pipe", () => {
  it("exits 0 when the reader closes the pipe early", async () => {
    const big = await writeJsonl(dir, "big.jsonl", Array.from({ length: 4000 }, (_, i) => ({ i })));
    const script = [
      "set -o pipefail 2>/dev/null || true",
      `"${process.execPath}" "${path.join(process.cwd(), "dist", "cli.js")}" filter --where "i>=0" "${big}" -q | head -2 > /dev/null`,
      "echo code=${PIPESTATUS[0]}",
    ].join("\n");
    const { spawnSync } = await import("node:child_process");
    const result = spawnSync("bash", ["-c", script], { encoding: "utf8" });
    if (result.error !== undefined || result.status !== 0) return; // no bash: skip silently
    expect(result.stdout).toContain("code=0");
    expect(result.stderr).not.toContain("EPIPE");
  });
});

describe("malformed line reporting", () => {
  it("reports the physical line number, not the record ordinal", async () => {
    const file = await writeText(dir, "gaps.jsonl", '{"a":1}\n\n\n{oops\n');
    const result = await runCli(["stat", file], { cwd: dir });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("line 4");
    expect(result.stderr).not.toContain("line 2:");
  });

  it("says malformed (not skipping) when the run aborts", async () => {
    const file = await writeText(dir, "abort.jsonl", '{"a":1}\n{oops\n');
    const result = await runCli(["stat", file], { cwd: dir });
    expect(result.code).toBe(1);
    expect(result.stderr).not.toContain("skipping line");
    expect(result.stderr).toContain("(pass --skip-invalid to skip malformed lines)");
  });

  it("says skipping when --skip-invalid is set", async () => {
    const file = await writeText(dir, "skip.jsonl", '{"a":1}\n{oops\n{"a":3}\n');
    const result = await runCli(["stat", file, "--skip-invalid"], { cwd: dir });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("skipping line 2");
  });
});

describe("prototype-free field lookup", () => {
  const protoKeys = ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__", "isPrototypeOf", "toLocaleString"];

  it.each(protoKeys)("--where %s matches nothing", async (key) => {
    const file = await writeJsonl(dir, "proto.jsonl", [{ a: 1 }, { a: 2 }]);
    const result = await runCli(["filter", "--where", key, file, "-q"], { cwd: dir });
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  it("still matches a real field named like a prototype key", async () => {
    const file = await writeJsonl(dir, "shadow.jsonl", [{ constructor: "yes" }, { a: 1 }]);
    const result = await runCli(["filter", "--where", "constructor", file, "-q"], { cwd: dir });
    expect(result.stdout.trim()).toBe('{"constructor":"yes"}');
  });

  it("groups prototype-named --by under (missing) instead of crashing", async () => {
    const file = await writeJsonl(dir, "proto2.jsonl", [{ a: 1 }, { a: 2 }]);
    const result = await runCli(["agg", "--by", "constructor", file], { cwd: dir });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("(missing)");
    expect(result.stderr).not.toContain("length");
  });
});

describe("argument validation", () => {
  it("rejects --top 0 and --top -1", async () => {
    for (const bad of ["0", "-1"]) {
      const result = await runCli(["stat", records, "--top", bad], { cwd: dir });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("--top must be >= 1");
    }
  });

  it("rejects --limit on commands that do not stream records", async () => {
    const result = await runCli(["stat", records, "--limit", "2"], { cwd: dir });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--limit is not supported by stat");
  });

  it("rejects an unknown command before touching the output file", async () => {
    const target = path.join(dir, "nope.out");
    const result = await runCli(["explode", "-o", target, records], { cwd: dir });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("unknown command");
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });
});