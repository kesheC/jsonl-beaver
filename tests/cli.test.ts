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

describe("closed stderr pipe", () => {
  it("still commits the output file when the stderr reader goes away", async () => {
    // 50 valid + 50 malformed lines: every malformed one writes to stderr, so a
    // closed reader is guaranteed to produce an EPIPE mid-run.
    const lines: string[] = [];
    for (let i = 0; i < 50; i++) lines.push(JSON.stringify({ i }));
    for (let i = 0; i < 50; i++) lines.push("{bad" + i);
    const file = await writeText(dir, "noisy.jsonl", lines.join("\n") + "\n");
    const target = path.join(dir, "noisy-out.csv");
    const result = await runCli(
      ["to-csv", "--fields", "i", "--skip-invalid", "-o", target, file],
      { cwd: dir, closeStderrAfterFirstChunk: true },
    );
    expect(result.code).toBe(0);
    const { readFile: read } = await import("node:fs/promises");
    expect((await read(target, "utf8")).split("\n").filter((line) => line !== "")).toHaveLength(51);
    const { readdir } = await import("node:fs/promises");
    expect((await readdir(dir)).filter((name) => name.includes("jlb-tmp"))).toEqual([]);
  });
});

describe("stale temp files", () => {
  it("sweeps a leftover temp file from a dead run", async () => {
    const { readdir, writeFile: writeF } = await import("node:fs/promises");
    const target = path.join(dir, "swept.csv");
    // pid 999999 does not exist, so its temp file is a crash leftover.
    const stale = path.join(dir, ".swept.csv.zzz.abc123.jlb-tmp");
    await writeF(stale, "junk", "utf8");
    const result = await runCli(["to-csv", "--fields", "n", "-o", target, records], { cwd: dir });
    expect(result.code).toBe(0);
    expect(await readFile(target, "utf8")).toBe("n\n1\n2\n3\n");
    expect((await readdir(dir)).filter((name) => name.includes("jlb-tmp"))).toEqual([]);
  });

  it("keeps a temp file whose owner is still running", async () => {
    const { readdir, writeFile: writeF } = await import("node:fs/promises");
    const target = path.join(dir, "live.csv");
    const alivePid = process.pid.toString(36);
    const live = path.join(dir, `.live.csv.${alivePid}.abc123.jlb-tmp`);
    await writeF(live, "junk", "utf8");
    try {
      const result = await runCli(["to-csv", "--fields", "n", "-o", target, records], { cwd: dir });
      expect(result.code).toBe(0);
      expect(await readdir(dir)).toContain(path.basename(live));
    } finally {
      const { rm } = await import("node:fs/promises");
      await rm(live, { force: true });
    }
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

  it("rejects a malformed --fields path like --by does", async () => {
    // "[0]" is deliberately absent: a bare index is a legal path into a
    // top-level array record.
    for (const bad of ["a..b", "", "a[x]", ".a", "a."]) {
      const result = await runCli(["to-csv", "--fields", bad, records], { cwd: dir });
      if (bad === "") {
        expect(result.code).toBe(2);
        expect(result.stderr).toContain("--fields");
        continue;
      }
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("invalid --fields path");
      expect(result.stderr).not.toContain("    at ");
    }
  });

  it("rejects a malformed --by path with exit 2, not 1", async () => {
    const result = await runCli(["agg", "--by", "a..b", "--count", records], { cwd: dir });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("invalid --by field path");
    expect(result.stderr).not.toContain("    at ");
  });

  it("trims surrounding whitespace from the -o target", async () => {
    const { readdir } = await import("node:fs/promises");
    const result = await runCli(["head", "-n", "1", "-o", `${path.join(dir, "trimmed.jsonl")}  `, records], { cwd: dir });
    expect(result.code).toBe(0);
    expect(await readFile(path.join(dir, "trimmed.jsonl"), "utf8")).toBe('{"n":1}\n');
    // No sibling file whose name ends in a space.
    expect((await readdir(dir)).filter((name) => name.trim() !== name)).toEqual([]);
  });

  it("still refuses to overwrite the input once the target is trimmed", async () => {
    const file = await writeText(dir, "trimin.jsonl", '{"n":1}\n{"n":2}\n');
    const before = await readFile(file, "utf8");
    const result = await runCli(["head", "-n", "1", "-o", `${file} `, file], { cwd: dir });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("refusing to write to the input file");
    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("treats --version as a standalone command, not a per-command flag", async () => {
    for (const argv of [["stat", records, "--version"], ["stat", "--version"]]) {
      const result = await runCli(argv, { cwd: dir });
      expect(result.code, argv.join(" ")).toBe(2);
      expect(result.stderr, argv.join(" ")).toContain("--version is not supported by stat");
      expect(result.stderr, argv.join(" ")).toContain("jlb --version");
    }
  });

  it("rejects an unknown command before touching the output file", async () => {
    const target = path.join(dir, "nope.out");
    const result = await runCli(["explode", "-o", target, records], { cwd: dir });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("unknown command");
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  // Regression: `jlb bogus` with no file was answered with
  // "bogus: missing <file|-> argument", which reads as a fine command with a
  // forgotten operand and never says the command does not exist.
  it("names the command, not the missing file, when the command itself is wrong", async () => {
    for (const argv of [["bogus"], ["bogus", records], ["bogus", "-o", path.join(dir, "x.out"), records]]) {
      const result = await runCli(argv, { cwd: dir });
      expect(result.code, argv.join(" ")).toBe(2);
      expect(result.stderr, argv.join(" ")).toContain("unknown command: bogus");
      expect(result.stderr, argv.join(" ")).not.toContain("missing <file|->");
    }
  });

  it("still reports a missing file for a command that does exist", async () => {
    const result = await runCli(["stat"], { cwd: dir });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("stat: missing <file|-> argument");
  });

  // Regression: `jlb bogus --help` printed the whole usage page and exited 0,
  // so a misspelled command was answered as a request for help.
  it("does not let --help hide a command that does not exist", async () => {
    for (const argv of [["bogus", "--help"], ["bogus", "-h"], ["bogus", "--help", records]]) {
      const result = await runCli(argv, { cwd: dir });
      expect(result.code, argv.join(" ")).toBe(2);
      expect(result.stdout, argv.join(" ")).toBe("");
      expect(result.stderr, argv.join(" ")).toContain("unknown command: bogus");
    }
  });

  // Regression: a dash-shaped first word was reported as an unknown *command*,
  // which sends the reader looking for a subcommand instead of at the spelling.
  it("reads a dash-shaped first word as a misspelled option", async () => {
    for (const argv of [["--bogus"], ["--versoin"], ["-Q"]]) {
      const result = await runCli(argv, { cwd: dir });
      expect(result.code, argv.join(" ")).toBe(2);
      expect(result.stderr, argv.join(" ")).toContain("unknown option: " + argv[0]);
      expect(result.stderr, argv.join(" ")).not.toContain("unknown command");
    }
  });
});

/**
 * The scope table lives in src/cli.ts, so these expectations are written out by
 * hand on purpose: a test that imported COMMAND_OPTIONS would agree with
 * whatever the implementation says, including a typo. The lists below are what
 * the dispatch in `main` actually reads.
 */
describe("a flag the command never reads is rejected, not ignored", () => {
  const READ: Record<string, string[]> = {
    stat: ["top", "json", "skip-invalid", "progress", "out", "quiet"],
    head: ["lines", "pretty", "json", "skip-invalid", "progress", "out", "quiet"],
    filter: ["where", "where-file", "limit", "pretty", "json", "skip-invalid", "progress", "out", "quiet"],
    agg: ["by", "count", "sum", "avg", "p95", "where", "where-file", "top", "json", "skip-invalid", "progress", "out", "quiet"],
    "to-csv": ["fields", "where", "where-file", "limit", "skip-invalid", "progress", "out", "quiet"],
    "to-jsonl": ["fields", "where", "where-file", "limit", "pretty", "skip-invalid", "progress", "out", "quiet"],
  };
  const SCOPED = [
    "skip-invalid", "json", "progress", "pretty", "version", "top", "limit", "where",
    "where-file", "by", "count", "sum", "avg", "p95", "fields", "lines", "out", "quiet",
  ];

  let whereFile = "";

  /** A value each option accepts, so the only thing that can fail is the scope check. */
  function argsFor(option: string): string[] {
    switch (option) {
      case "top":
      case "limit":
      case "lines":
        return ["--" + option, "2"];
      case "where":
        return ["--where", "n=1"];
      case "where-file":
        return ["--where-file", whereFile];
      case "by":
      case "sum":
      case "avg":
      case "p95":
      case "fields":
        return ["--" + option, "n"];
      case "out":
        return ["--out", path.join(dir, "never-written.out")];
      default:
        return ["--" + option];
    }
  }

  it("rejects every combination outside the table, naming the flag and the commands that take it", async () => {
    whereFile = await writeText(dir, "predicate.txt", "n = 1\n");
    const cases: { command: string; option: string }[] = [];
    for (const command of Object.keys(READ)) {
      for (const option of SCOPED) {
        if (!READ[command]!.includes(option)) cases.push({ command, option });
      }
    }
    // 70-odd child processes; run them in batches so the suite stays quick.
    const results: { command: string; option: string; code: number | null; stderr: string }[] = [];
    for (let i = 0; i < cases.length; i += 8) {
      const batch = cases.slice(i, i + 8);
      const settled = await Promise.all(
        batch.map(async (item) => {
          const result = await runCli([item.command, ...argsFor(item.option), records], { cwd: dir });
          return { ...item, code: result.code, stderr: result.stderr };
        }),
      );
      results.push(...settled);
    }
    expect(results.length).toBeGreaterThan(50);
    for (const result of results) {
      const label = `${result.command} --${result.option}`;
      expect.soft(result.code, label + " should be rejected").toBe(2);
      expect.soft(result.stderr, label + " should name the flag").toContain(
        `--${result.option} is not supported by ${result.command}`,
      );
      expect.soft(result.stderr, label + " should not print a stack").not.toContain("    at ");
    }
  });

  it("names the commands that do read the flag", async () => {
    const cases: [string, string[], string][] = [
      ["stat", ["--where", "n=1"], "--where is not supported by stat; it applies to filter, agg, to-csv and to-jsonl"],
      ["head", ["--top", "2"], "--top is not supported by head; it applies to stat and agg"],
      ["head", ["--where", "n=1"], "--where is not supported by head; it applies to filter, agg, to-csv and to-jsonl"],
      ["to-csv", ["--json"], "--json is not supported by to-csv; it applies to stat, head, filter and agg"],
      ["to-jsonl", ["--json"], "--json is not supported by to-jsonl; it applies to stat, head, filter and agg"],
      ["agg", ["--pretty"], "--pretty is not supported by agg; it applies to head, filter and to-jsonl"],
      ["filter", ["--top", "2"], "--top is not supported by filter; it applies to stat and agg"],
    ];
    for (const [command, args, message] of cases) {
      const result = await runCli([command, ...args, records], { cwd: dir });
      expect(result.code).toBe(2);
      expect(result.stderr.trim()).toBe("jlb: " + message);
    }
  });

  it("leaves the -o target alone when a scope error fires", async () => {
    const target = await writeText(dir, "scope-kept.txt", "keep me\n");
    const result = await runCli(["stat", "-o", target, "--by", "n", records], { cwd: dir });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--by is not supported by stat");
    expect(await readFile(target, "utf8")).toBe("keep me\n");
    await expect(stat(path.join(dir, "never-written.out"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("still accepts the options each command does read", async () => {
    const ok: string[][] = [
      ["stat", "--top", "1", "--json"],
      ["head", "-n", "1", "--pretty"],
      ["filter", "--where", "n=1", "--limit", "1", "--json"],
      ["agg", "--by", "n", "--count", "--where", "n=1", "--top", "1", "--json"],
      ["to-csv", "--fields", "n", "--where", "n=1", "--limit", "1"],
      ["to-jsonl", "--fields", "n", "--where", "n=1", "--limit", "1", "--pretty"],
    ];
    for (const args of ok) {
      const result = await runCli([args[0]!, ...args.slice(1), records], { cwd: dir });
      expect(result.code, args.join(" ")).toBe(0);
      expect(result.stdout.length, args.join(" ")).toBeGreaterThan(0);
    }
  });

  it("keeps --json meaningful on head: it suppresses the stopped-early note", async () => {
    const withNote = await runCli(["head", "-n", "1", records], { cwd: dir });
    expect(withNote.stderr).toContain("jlb: stopped after 1 record(s)");
    const silent = await runCli(["head", "-n", "1", "--json", records], { cwd: dir });
    expect(silent.code).toBe(0);
    expect(silent.stderr).toBe("");
    expect(silent.stdout).toBe(withNote.stdout);
  });
});

describe("--json failure documents", () => {
  // A failure used to be a line on stderr written where it was detected, so
  // `jlb stat --json /missing.jsonl` exited 2 with an empty stdout and a
  // wrapper could not tell a failed run from an empty file.
  it("answers a --json caller with a document even when the run fails", async () => {
    const missing = path.join(dir, "no-such-file.jsonl");
    const cases: [string[], string][] = [
      [["stat", "--json", missing], "no such file"],
      [["stat", "--json", "--bogus", records], "unknown option: --bogus"],
      [["--json", "--bogus"], "unknown option: --bogus"],
      [["stat", "--json", "--version", records], "--version is not supported"],
      [["stat", "--json", "--by", "n", records], "--by is not supported by stat"],
      [["filter", "--json", "--where", "n ==", records], "bad --where expression"],
    ];
    for (const [args, expected] of cases) {
      const result = await runCli(args, { cwd: dir });
      expect(result.code, args.join(" ")).toBe(2);
      const parsed = JSON.parse(result.stdout) as { error: { message: string; exitCode: number } };
      expect(parsed.error.message, args.join(" ")).toContain(expected);
      expect(parsed.error.exitCode, args.join(" ")).toBe(2);
      expect(result.stderr, args.join(" ")).toContain("jlb: ");
    }
  });

  it("keeps stdout empty on failure when --json was not asked for", async () => {
    const result = await runCli(["stat", path.join(dir, "no-such-file.jsonl")], { cwd: dir });
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("jlb: no such file");
  });

  it("does not mistake a --json after the separator for the caller's own flag", async () => {
    const result = await runCli(["stat", "--bogus", "--", "--json"], { cwd: dir });
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
  });
});