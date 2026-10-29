import { describe, expect, it } from "vitest";
import { compileExpr, evaluateExpr, ExprError } from "../src/expr.js";

describe("expression DSL", () => {
  it("compares numbers with all six operators", () => {
    const record = { dur: 500 };
    expect(evaluateExpr("dur > 499", record)).toBe(true);
    expect(evaluateExpr("dur >= 500", record)).toBe(true);
    expect(evaluateExpr("dur < 501", record)).toBe(true);
    expect(evaluateExpr("dur <= 500", record)).toBe(true);
    expect(evaluateExpr("dur = 500", record)).toBe(true);
    expect(evaluateExpr("dur == 500", record)).toBe(true);
    expect(evaluateExpr("dur != 500", record)).toBe(false);
  });

  it("treats bare words as string literals so level=error works unquoted", () => {
    expect(evaluateExpr("level=error", { level: "error" })).toBe(true);
    expect(evaluateExpr("level=error", { level: "warn" })).toBe(false);
    expect(evaluateExpr('level="error"', { level: "error" })).toBe(true);
  });

  it("compares numeric strings as numbers", () => {
    expect(evaluateExpr("status >= 500", { status: "503" })).toBe(true);
    expect(evaluateExpr("status >= 500", { status: "200" })).toBe(false);
  });

  it("honours and/or precedence: and binds tighter than or", () => {
    // a or b and c  ==  a or (b and c)
    expect(evaluateExpr("a=true or b=true and c=true", { a: true, b: false, c: false })).toBe(true);
    expect(evaluateExpr("a=true or b=true and c=true", { a: false, b: true, c: false })).toBe(false);
    expect(evaluateExpr("a=true or b=true and c=true", { a: false, b: true, c: true })).toBe(true);
  });

  it("honours parentheses", () => {
    expect(evaluateExpr("(a=true or b=true) and c=true", { a: false, b: true, c: false })).toBe(false);
    expect(evaluateExpr("(a=true or b=true) and c=true", { a: false, b: true, c: true })).toBe(true);
  });

  it("supports not and nested not", () => {
    expect(evaluateExpr("not level=debug", { level: "info" })).toBe(true);
    expect(evaluateExpr("not level=debug", { level: "debug" })).toBe(false);
    expect(evaluateExpr("not not a=1", { a: 1 })).toBe(true);
  });

  it("resolves nested paths and array indices", () => {
    const record = { user: { role: "admin", tags: ["a", "b"] }, items: [{ id: 7 }] };
    expect(evaluateExpr("user.role=admin", record)).toBe(true);
    expect(evaluateExpr("user.tags[1]=b", record)).toBe(true);
    expect(evaluateExpr("user.tags.1=b", record)).toBe(true);
    expect(evaluateExpr("items[0].id=7", record)).toBe(true);
    expect(evaluateExpr("items[0].id=8", record)).toBe(false);
  });

  it("supports includes for substring, array membership and object keys", () => {
    expect(evaluateExpr('path includes "/api/"', { path: "/api/users" })).toBe(true);
    expect(evaluateExpr('path includes "/api/"', { path: "/health" })).toBe(false);
    expect(evaluateExpr("tags includes b", { tags: ["a", "b"] })).toBe(true);
    expect(evaluateExpr("meta includes host", { meta: { host: "x" } })).toBe(true);
  });

  it("handles a bare path as a truthiness test", () => {
    expect(evaluateExpr("error", { error: "boom" })).toBe(true);
    expect(evaluateExpr("error", { error: "" })).toBe(false);
    expect(evaluateExpr("error", {})).toBe(false);
    expect(evaluateExpr("count", { count: 0 })).toBe(false);
  });

  it("treats a missing field as no-match except for !=", () => {
    expect(evaluateExpr("gone = 1", {})).toBe(false);
    expect(evaluateExpr("gone != 1", {})).toBe(true);
    expect(evaluateExpr("gone > 1", {})).toBe(false);
  });

  it("parses quoted strings containing spaces and escapes", () => {
    expect(evaluateExpr('msg = "hello world"', { msg: "hello world" })).toBe(true);
    expect(evaluateExpr("msg = 'it\\'s fine'", { msg: "it's fine" })).toBe(true);
  });

  it("compiles once and reuses the closure", () => {
    const predicate = compileExpr("status >= 500");
    expect(predicate.source).toBe("status >= 500");
    expect(predicate({ status: 500 })).toBe(true);
    expect(predicate({ status: 200 })).toBe(false);
  });

  it("reports syntax errors with a position", () => {
    expect(() => compileExpr("status >=")).toThrow(ExprError);
    expect(() => compileExpr("(a=1")).toThrow(/missing closing parenthesis/);
    expect(() => compileExpr("a=1)")).toThrow(ExprError);
    expect(() => compileExpr("")).toThrow(/empty/);
    expect(() => compileExpr("a # 1")).toThrow(ExprError);
  });

  it("reports unterminated strings", () => {
    expect(() => compileExpr('msg = "oops')).toThrow(/unterminated string/);
  });
});
