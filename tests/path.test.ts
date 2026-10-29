import { describe, expect, it } from "vitest";
import { getByPath, parsePath } from "../src/path.js";

describe("field paths", () => {
  it("parses dotted paths into segments", () => {
    expect(parsePath("a.b.c")).toEqual(["a", "b", "c"]);
    expect(parsePath("level")).toEqual(["level"]);
  });

  it("parses bracket and dotted array indices identically", () => {
    expect(parsePath("items[0].id")).toEqual(["items", 0, "id"]);
    expect(parsePath("items.0.id")).toEqual(["items", 0, "id"]);
  });

  it("rejects malformed paths", () => {
    expect(parsePath("")).toBeNull();
    expect(parsePath("   ")).toBeNull();
    expect(parsePath("a..b")).toBeNull();
    expect(parsePath("a.")).toBeNull();
    expect(parsePath("a[0")).toBeNull();
  });

  it("resolves values, including missing ones", () => {
    const record = { a: { b: { c: 42 } }, items: [{ id: 7 }, { id: 8 }] };
    expect(getByPath(record, "a.b.c")).toBe(42);
    expect(getByPath(record, "items[1].id")).toBe(8);
    expect(getByPath(record, "a.missing.c")).toBeUndefined();
    expect(getByPath(record, "items[9]")).toBeUndefined();
  });

  it("does not throw when walking through a scalar", () => {
    expect(getByPath({ a: 5 }, "a.b")).toBeUndefined();
    expect(getByPath(null, "a")).toBeUndefined();
  });
});
