import { describe, expect, it } from "vitest";
import {
  csvEscape,
  displayWidth,
  formatBytes,
  formatCount,
  formatNumber,
  formatPercent,
  padEndWide,
  renderAgg,
  renderStat,
  renderTable,
  toCsv,
} from "../src/format.js";
import { Aggregator, type StatResult } from "../src/agg.js";
import { getByPath } from "../src/path.js";

describe("csvEscape", () => {
  it("leaves plain values alone", () => {
    expect(csvEscape("abc")).toBe("abc");
    expect(csvEscape(42)).toBe("42");
    expect(csvEscape(true)).toBe("true");
  });

  it("quotes commas", () => {
    expect(csvEscape("a,b")).toBe('"a,b"');
  });

  it("doubles embedded quotes", () => {
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
  });

  it("quotes newlines and carriage returns", () => {
    expect(csvEscape("a\nb")).toBe('"a\nb"');
    expect(csvEscape("a\rb")).toBe('"a\rb"');
  });

  it("renders missing values as empty and objects as JSON", () => {
    expect(csvEscape(undefined)).toBe("");
    expect(csvEscape(null)).toBe("");
    expect(csvEscape({ a: 1 })).toBe('"{""a"":1}"');
  });

  it("neutralises spreadsheet formula injection in strings", () => {
    expect(csvEscape("=1+1")).toBe("'=1+1");
    expect(csvEscape("@x")).toBe("'@x");
    // A plain negative number must stay a number.
    expect(csvEscape(-5)).toBe("-5");
  });
});

describe("toCsv", () => {
  it("writes a header and CRLF rows", () => {
    const csv = toCsv(["a", "b"], [[1, 2], [3, 4]]);
    expect(csv).toBe("a,b\r\n1,2\r\n3,4\r\n");
  });

  it("returns just the header when there are no rows", () => {
    expect(toCsv(["a"], [])).toBe("a\r\n");
  });
});

describe("number and size formatting", () => {
  it("formats byte sizes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(1024)).toBe("1.0 KiB");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(1024 * 1024 * 3)).toBe("3.0 MiB");
    expect(formatBytes(1024 ** 3)).toBe("1.0 GiB");
  });

  it("formats counts and ratios", () => {
    expect(formatCount(1000)).toBe("1,000");
    expect(formatCount(1234567)).toBe("1,234,567");
    expect(formatPercent(0.5)).toBe("50.0%");
    expect(formatPercent(0.1234, 2)).toBe("12.34%");
    expect(formatNumber(200)).toBe("200");
    expect(formatNumber(200.5)).toBe("200.50");
    expect(formatNumber(Number.NaN)).toBe("n/a");
  });

  it("measures widened CJK glyphs as two cells", () => {
    expect(displayWidth("abc")).toBe(3);
    expect(displayWidth("中文")).toBe(4);
    expect(padEndWide("中", 4)).toBe("中  ");
  });
});

describe("renderTable", () => {
  it("aligns columns and adds a rule", () => {
    const table = renderTable(["NAME", "N"], [["ab", "1"], ["c", "22"]], ["left", "right"]);
    const lines = table.split("\n");
    expect(lines).toHaveLength(4);
    // Column 0 is 4 wide ("NAME"), column 1 is 2 wide ("22"), joined by 2 spaces.
    expect(lines[0]).toBe("NAME   N");
    expect(lines[2]).toBe("ab     1");
    expect(lines[3]).toBe("c     22");
  });

  it("returns an empty string for no columns", () => {
    expect(renderTable([], [])).toBe("");
  });
});

const statFixture: StatResult = {
  total: 2,
  valid: 2,
  invalid: 0,
  bytes: 2048,
  fieldCount: 2,
  fieldsTruncated: false,
  fields: [
    { name: "level", present: 2, rate: 1, types: { string: 2, number: 0, boolean: 0, null: 0, object: 0, array: 0 } },
    { name: "status", present: 1, rate: 0.5, types: { string: 0, number: 1, boolean: 0, null: 0, object: 0, array: 0 } },
  ],
  maxDepth: 1,
  lengthP50: 40,
  lengthP95: 60,
  lengthMax: 61,
};

describe("renderStat", () => {
  it("prints a summary, a length block and a field table", () => {
    const text = renderStat(statFixture, 30);
    expect(text).toContain("lines         2");
    expect(text).toContain("size          2.0 KiB");
    expect(text).toContain("p50 40");
    expect(text).toContain("level");
    expect(text).toContain("string:100%");
    expect(text).toContain("number:100%");
  });

  it("handles a file with no object records", () => {
    const text = renderStat({ ...statFixture, fields: [], fieldCount: 0, maxDepth: 0 }, 30);
    expect(text).toContain("Fields: none");
  });

  it("truncates the field list to the requested count", () => {
    const text = renderStat(statFixture, 1);
    expect(text).toContain("Top fields (1 of 2)");
    expect(text).not.toContain("status");
  });
});

describe("renderAgg", () => {
  it("renders a count table", () => {
    const aggregator = new Aggregator({ by: "level" });
    for (const record of [{ level: "info" }, { level: "info" }, { level: "error" }]) aggregator.add(record, getByPath);
    const text = renderAgg(aggregator.results(20), {
      by: "level",
      metric: "count",
      top: 20,
      truncated: false,
      totalGroups: aggregator.size,
    });
    // Compare trimmed cells so the assertion does not re-encode column padding.
    const rows = text
      .split("\n")
      .slice(2)
      .map((line) => line.trim().split(/\s+/));
    expect(rows).toEqual([
      ["info", "2"],
      ["error", "1"],
    ]);
  });

  it("renders a metric column when one is requested", () => {
    const aggregator = new Aggregator({ by: "user", sum: "dur" });
    aggregator.add({ user: "a", dur: 5 }, getByPath);
    const text = renderAgg(aggregator.results(20), {
      by: "user",
      metric: "sum",
      top: 20,
      truncated: false,
      totalGroups: 1,
    });
    expect(text).toContain("SUM");
    expect(text).toContain("5");
  });

  it("reports the truncated group count", () => {
    const aggregator = new Aggregator({ by: "k" });
    for (let i = 0; i < 5; i++) aggregator.add({ k: `g${i}` }, getByPath);
    const text = renderAgg(aggregator.results(2), {
      by: "k",
      metric: "count",
      top: 2,
      truncated: true,
      totalGroups: 5,
    });
    expect(text).toContain("Showing top 2 of 5 groups.");
  });

  it("says so when nothing matched", () => {
    expect(
      renderAgg([], { by: "k", metric: "count", top: 20, truncated: false, totalGroups: 0 }),
    ).toBe("No matching records.");
  });
});
