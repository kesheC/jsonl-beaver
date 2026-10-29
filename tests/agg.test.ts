import { describe, expect, it } from "vitest";
import { Aggregator, depthOf, LengthHistogram, Reservoir, StatAccumulator, toNumber, typeOf } from "../src/agg.js";
import { getByPath } from "../src/path.js";

describe("stats primitives", () => {
  it("classifies JSON types", () => {
    expect(typeOf("x")).toBe("string");
    expect(typeOf(1)).toBe("number");
    expect(typeOf(true)).toBe("boolean");
    expect(typeOf(null)).toBe("null");
    expect(typeOf({})).toBe("object");
    expect(typeOf([])).toBe("array");
  });

  it("computes max nesting depth", () => {
    expect(depthOf(1)).toBe(0);
    expect(depthOf(null)).toBe(0);
    expect(depthOf({ a: 1 })).toBe(1);
    expect(depthOf({ a: { b: { c: 1 } } })).toBe(3);
    expect(depthOf({ a: [{ b: 1 }] })).toBe(3);
  });

  it("computes exact percentiles for small inputs", () => {
    const histogram = new LengthHistogram();
    for (let i = 1; i <= 100; i++) histogram.add(i);
    expect(histogram.total).toBe(100);
    expect(histogram.maximum).toBe(100);
    expect(histogram.percentile(50)).toBe(50);
    expect(histogram.percentile(95)).toBe(95);
    expect(histogram.percentile(100)).toBe(100);
  });

  it("estimates percentiles beyond the exact range without unbounded memory", () => {
    const histogram = new LengthHistogram();
    for (let i = 0; i < 1000; i++) histogram.add(8000);
    const p50 = histogram.percentile(50);
    expect(p50).toBeGreaterThan(4000);
    expect(p50).toBeLessThanOrEqual(8000);
    expect(histogram.maximum).toBe(8000);
  });

  it("coerces numerics and rejects non-numerics", () => {
    expect(toNumber(5)).toBe(5);
    expect(toNumber("5")).toBe(5);
    expect(toNumber(true)).toBe(1);
    expect(toNumber("")).toBeNull();
    expect(toNumber("abc")).toBeNull();
    expect(toNumber({})).toBeNull();
  });

  it("keeps every sample while under the reservoir capacity", () => {
    const reservoir = new Reservoir(10, 42);
    for (let i = 1; i <= 10; i++) reservoir.add(i);
    expect(reservoir.exact).toBe(true);
    expect(reservoir.count).toBe(10);
    expect(reservoir.percentile(100)).toBe(10);
  });

  it("is deterministic for the same seed once sampling starts", () => {
    const build = (): number[] => {
      const reservoir = new Reservoir(8, 7);
      for (let i = 0; i < 500; i++) reservoir.add(i);
      return [reservoir.percentile(50), reservoir.percentile(95)];
    };
    expect(build()).toEqual(build());
  });
});

describe("StatAccumulator", () => {
  const accumulate = (records: unknown[]) => {
    const accumulator = new StatAccumulator();
    for (const record of records) {
      const raw = JSON.stringify(record);
      accumulator.addLine(raw);
      accumulator.addRecord(record);
    }
    accumulator.total = records.length;
    return accumulator.result();
  };

  it("counts field presence and per-field type distribution", () => {
    const result = accumulate([
      { level: "info", status: 200 },
      { level: "warn", status: "500" },
      { level: "error" },
    ]);
    expect(result.total).toBe(3);
    expect(result.valid).toBe(3);
    expect(result.maxDepth).toBe(1);
    const level = result.fields.find((f) => f.name === "level")!;
    expect(level.present).toBe(3);
    expect(level.rate).toBe(1);
    expect(level.types.string).toBe(3);
    const status = result.fields.find((f) => f.name === "status")!;
    expect(status.present).toBe(2);
    expect(status.types.number).toBe(1);
    expect(status.types.string).toBe(1);
  });

  it("sorts fields by frequency and breaks ties by name", () => {
    const result = accumulate([{ b: 1, a: 2 }, { b: 3 }]);
    expect(result.fields.map((f) => f.name)).toEqual(["b", "a"]);
  });

  it("returns zeros for an empty input", () => {
    const result = accumulate([]);
    expect(result.total).toBe(0);
    expect(result.fields).toEqual([]);
    expect(result.lengthP50).toBe(0);
    expect(result.maxDepth).toBe(0);
  });
});

describe("Aggregator", () => {
  const run = (records: unknown[], options: Parameters<typeof buildAgg>[0]) => {
    const aggregator = buildAgg(options);
    for (const record of records) aggregator.add(record, getByPath);
    return aggregator.results(20);
  };
  const buildAgg = (options: { by?: string; sum?: string; avg?: string; p95?: string }) => new Aggregator(options);

  const records = [
    { user: "a", dur: 100 },
    { user: "a", dur: 300 },
    { user: "b", dur: 50 },
    { user: "a", dur: 200 },
    { user: "b", dur: 150 },
  ];

  it("counts groups", () => {
    const groups = run(records, { by: "user" });
    expect(groups.map((g) => [g.key, g.count])).toEqual([
      ["a", 3],
      ["b", 2],
    ]);
  });

  it("sums, averages and percentiles per group", () => {
    const sum = run(records, { by: "user", sum: "dur" });
    expect(sum[0]!.sum).toBe(600);
    expect(sum[0]!.min).toBe(100);
    expect(sum[0]!.max).toBe(300);
    const avg = run(records, { by: "user", avg: "dur" });
    expect(avg[0]!.avg).toBe(200);
    const p95 = run(records, { by: "user", p95: "dur" });
    expect(p95[0]!.p95Group).toBe(300);
  });

  it("buckets missing group keys instead of dropping them", () => {
    const groups = run([{ dur: 1 }, { user: "a", dur: 2 }], { by: "user" });
    expect(groups.map((g) => g.key).sort()).toEqual(["(missing)", "a"]);
  });

  it("ignores non-numeric values for numeric metrics", () => {
    const groups = run([{ user: "a", dur: "nope" }, { user: "a", dur: 10 }], { by: "user", sum: "dur" });
    expect(groups[0]!.count).toBe(2);
    expect(groups[0]!.sum).toBe(10);
    expect(groups[0]!.numericCount).toBe(1);
  });

  it("respects the top limit", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ user: `u${i}` }));
    const aggregator = buildAgg({ by: "user" });
    for (const record of many) aggregator.add(record, getByPath);
    expect(aggregator.size).toBe(30);
    expect(aggregator.results(5)).toHaveLength(5);
    expect(aggregator.results(0)).toHaveLength(30);
  });
});
