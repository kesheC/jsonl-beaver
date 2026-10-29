import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectStat, runAgg, runFilter, runHead, runToCsv, runToJsonl } from "../src/commands.js";
import { InputError, InvalidLineError } from "../src/stream.js";
import { cleanup, makeTempDir, writeJsonl, writeText } from "./helpers.js";

let dir: string;

beforeEach(async () => {
  dir = await makeTempDir();
});

afterEach(async () => {
  await cleanup(dir);
});

const appRecords = [
  { level: "info", status: 200, dur: 10, path: "/api/users" },
  { level: "error", status: 500, dur: 800, path: "/api/orders" },
  { level: "warn", status: 404, dur: 120, path: "/api/login" },
  { level: "error", status: 502, dur: 900, path: "/api/orders" },
  { level: "info", status: 200, dur: 15, path: "/health" },
];

describe("collectStat", () => {
  it("counts lines, fields and lengths", async () => {
    const file = await writeJsonl(dir, "app.jsonl", appRecords);
    const stat = await collectStat(file);
    expect(stat.total).toBe(5);
    expect(stat.valid).toBe(5);
    expect(stat.invalid).toBe(0);
    expect(stat.maxDepth).toBe(1);
    expect(stat.fieldCount).toBe(4);
    expect(stat.fields[0]!.rate).toBeGreaterThan(0);
    expect(stat.lengthMax).toBeGreaterThan(0);
    expect(stat.bytes).toBeGreaterThan(0);
  });

  it("returns zeros for an empty file", async () => {
    const file = await writeText(dir, "empty.jsonl", "");
    const stat = await collectStat(file);
    expect(stat.total).toBe(0);
    expect(stat.valid).toBe(0);
    expect(stat.fields).toEqual([]);
  });

  it("ignores blank lines instead of counting them as invalid", async () => {
    const file = await writeText(dir, "blanks.jsonl", '{"a":1}\n\n\n{"a":2}\n');
    const stat = await collectStat(file);
    expect(stat.total).toBe(2);
    expect(stat.valid).toBe(2);
    expect(stat.invalid).toBe(0);
  });

  it("fails on the first malformed line by default", async () => {
    const file = await writeText(dir, "bad.jsonl", '{"a":1}\nnot json\n');
    await expect(collectStat(file)).rejects.toBeInstanceOf(InvalidLineError);
  });

  it("skips malformed lines and reports them when asked", async () => {
    const file = await writeText(dir, "bad2.jsonl", '{"a":1}\nnot json\n{"a":3}\n');
    const seen: number[] = [];
    const stat = await collectStat(file, { skipInvalid: true, onBadLine: (bad) => seen.push(bad.line) });
    expect(stat.total).toBe(3);
    expect(stat.valid).toBe(2);
    expect(stat.invalid).toBe(1);
    expect(seen).toEqual([2]);
  });

  it("rejects a directory and a missing file with a clear message", async () => {
    await expect(collectStat(dir)).rejects.toBeInstanceOf(InputError);
    await expect(collectStat(`${dir}/nope.jsonl`)).rejects.toThrow(/no such file/);
  });

  it("truncates the returned field list", async () => {
    const file = await writeJsonl(dir, "many.jsonl", [{ a: 1, b: 2, c: 3 }]);
    const stat = await collectStat(file, { topFields: 2 });
    expect(stat.fields).toHaveLength(2);
    expect(stat.fieldCount).toBe(3);
  });
});

describe("runHead", () => {
  it("emits exactly n records and stops early", async () => {
    const file = await writeJsonl(dir, "app.jsonl", appRecords);
    const seen: unknown[] = [];
    const result = await runHead(file, 2, { emit: (r) => seen.push(r) });
    expect(result.emitted).toBe(2);
    expect(result.partial).toBe(true);
    expect(seen).toHaveLength(2);
  });

  it("emits everything when n exceeds the file", async () => {
    const file = await writeJsonl(dir, "small.jsonl", appRecords.slice(0, 2));
    const seen: unknown[] = [];
    const result = await runHead(file, 100, { emit: (r) => seen.push(r) });
    expect(result.emitted).toBe(2);
    expect(result.partial).toBe(false);
    expect(seen).toHaveLength(2);
  });

  it("emits nothing for n = 0", async () => {
    const file = await writeJsonl(dir, "app.jsonl", appRecords);
    const seen: unknown[] = [];
    expect((await runHead(file, 0, { emit: (r) => seen.push(r) })).emitted).toBe(0);
    expect(seen).toEqual([]);
  });
});

describe("runFilter", () => {
  it("matches a numeric comparison", async () => {
    const file = await writeJsonl(dir, "app.jsonl", appRecords);
    const seen: { status: number }[] = [];
    const result = await runFilter(file, {
      where: "status >= 500",
      emit: (r) => seen.push(r as { status: number }),
    });
    expect(result.matched).toBe(2);
    expect(seen.map((r) => r.status)).toEqual([500, 502]);
  });

  it("combines conditions with and", async () => {
    const file = await writeJsonl(dir, "app.jsonl", appRecords);
    const seen: { path: string }[] = [];
    await runFilter(file, {
      where: 'level = error and path includes "/orders"',
      emit: (r) => seen.push(r as { path: string }),
    });
    expect(seen).toHaveLength(2);
  });

  it("honours --limit and stops scanning", async () => {
    const file = await writeJsonl(dir, "app.jsonl", appRecords);
    const seen: unknown[] = [];
    const result = await runFilter(file, { where: "dur > 0", limit: 2, emit: (r) => seen.push(r) });
    expect(result.matched).toBe(2);
    expect(seen).toHaveLength(2);
  });

  it("passes everything through without a where clause", async () => {
    const file = await writeJsonl(dir, "app.jsonl", appRecords);
    const seen: unknown[] = [];
    const result = await runFilter(file, { emit: (r) => seen.push(r) });
    expect(result.matched).toBe(appRecords.length);
    expect(result.scanned).toBe(appRecords.length);
  });

  it("reports zero matches rather than failing", async () => {
    const file = await writeJsonl(dir, "app.jsonl", appRecords);
    const result = await runFilter(file, { where: "status > 9000", emit: () => {} });
    expect(result.matched).toBe(0);
  });
});

describe("runAgg", () => {
  it("counts by field", async () => {
    const file = await writeJsonl(dir, "app.jsonl", appRecords);
    const result = await runAgg(file, { by: "level" });
    expect(result.metric).toBe("count");
    expect(result.groups.map((g) => [g.key, g.count])).toEqual([
      ["error", 2],
      ["info", 2],
      ["warn", 1],
    ]);
  });

  it("sums and averages a metric", async () => {
    const file = await writeJsonl(dir, "app.jsonl", appRecords);
    const sum = await runAgg(file, { by: "level", sum: "dur" });
    expect(sum.groups.find((g) => g.key === "error")!.sum).toBe(1700);
    const avg = await runAgg(file, { by: "level", avg: "dur" });
    expect(avg.metric).toBe("avg");
    expect(avg.groups.find((g) => g.key === "error")!.avg).toBe(850);
  });

  it("computes p95 per group", async () => {
    const file = await writeJsonl(dir, "app.jsonl", appRecords);
    const result = await runAgg(file, { by: "level", p95: "dur" });
    expect(result.metric).toBe("p95");
    expect(result.groups.find((g) => g.key === "info")!.p95Group).toBe(15);
  });

  it("aggregates globally when no --by is given", async () => {
    const file = await writeJsonl(dir, "app.jsonl", appRecords);
    const result = await runAgg(file, { sum: "dur" });
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]!.sum).toBe(1845);
  });

  it("combines --where with --by", async () => {
    const file = await writeJsonl(dir, "app.jsonl", appRecords);
    const result = await runAgg(file, { by: "path", where: "status >= 500" });
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]!.key).toBe("/api/orders");
    expect(result.groups[0]!.count).toBe(2);
  });

  it("respects --top", async () => {
    const file = await writeJsonl(dir, "app.jsonl", appRecords);
    const result = await runAgg(file, { by: "path", top: 2 });
    expect(result.groups).toHaveLength(2);
    // Four distinct paths: /api/users, /api/orders, /api/login, /health.
    expect(result.totalGroups).toBe(4);
  });

  it("rejects an invalid --by path", async () => {
    const file = await writeJsonl(dir, "app.jsonl", appRecords);
    await expect(runAgg(file, { by: "a..b" })).rejects.toThrow(/invalid --by/);
  });
});

describe("runToCsv", () => {
  it("writes a header then one row per record", async () => {
    const file = await writeJsonl(dir, "app.jsonl", appRecords);
    const lines: string[] = [];
    const result = await runToCsv(file, { fields: ["level", "status"], emit: (l) => lines.push(l) });
    expect(result.rows).toBe(5);
    expect(lines[0]).toBe("level,status");
    expect(lines[1]).toBe("info,200");
  });

  it("resolves nested fields and blanks missing ones", async () => {
    const file = await writeJsonl(dir, "nested.jsonl", [{ user: { id: 7 }, tag: "a" }, { tag: "b" }]);
    const lines: string[] = [];
    await runToCsv(file, { fields: ["user.id", "tag"], emit: (l) => lines.push(l) });
    expect(lines).toEqual(["user.id,tag", "7,a", ",b"]);
  });

  it("escapes commas and quotes coming from data", async () => {
    const file = await writeJsonl(dir, "dirty.jsonl", [{ msg: 'hello, "world"' }]);
    const lines: string[] = [];
    await runToCsv(file, { fields: ["msg"], emit: (l) => lines.push(l) });
    expect(lines[1]).toBe('"hello, ""world"""');
  });

  it("applies a filter and a limit", async () => {
    const file = await writeJsonl(dir, "app.jsonl", appRecords);
    const lines: string[] = [];
    const result = await runToCsv(file, {
      fields: ["status"],
      where: "status >= 500",
      limit: 1,
      emit: (l) => lines.push(l),
    });
    expect(result.rows).toBe(1);
    expect(lines).toEqual(["status", "500"]);
  });
});

describe("runToJsonl", () => {
  it("reshapes records to the requested fields", async () => {
    const file = await writeJsonl(dir, "app.jsonl", [{ a: 1, b: 2, c: 3 }]);
    const lines: string[] = [];
    await runToJsonl(file, { fields: ["a", "c"], emit: (l) => lines.push(l) });
    expect(JSON.parse(lines[0]!)).toEqual({ a: 1, c: 3 });
  });

  it("emits null for missing fields", async () => {
    const file = await writeJsonl(dir, "sparse.jsonl", [{ a: 1 }]);
    const lines: string[] = [];
    await runToJsonl(file, { fields: ["a", "gone"], emit: (l) => lines.push(l) });
    expect(JSON.parse(lines[0]!)).toEqual({ a: 1, gone: null });
  });

  it("pretty-prints when asked", async () => {
    const file = await writeJsonl(dir, "sparse.jsonl", [{ a: 1 }]);
    const lines: string[] = [];
    await runToJsonl(file, { fields: ["a"], pretty: true, emit: (l) => lines.push(l) });
    expect(lines[0]).toContain("\n  \"a\": 1\n");
  });
});
