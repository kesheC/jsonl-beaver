import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InvalidLineError, resolveSource, STDIN_SENTINEL, streamJsonl } from "../src/stream.js";
import { cleanup, makeTempDir, writeText } from "./helpers.js";

let dir: string;

beforeEach(async () => {
  dir = await makeTempDir();
});

afterEach(async () => {
  await cleanup(dir);
});

/** Feed text through the stdin code path exactly as a shell pipe would. */
function stdinFrom(text: string): Readable {
  return Readable.from([Buffer.from(text, "utf8")]);
}

describe("resolveSource", () => {
  it("accepts a regular file and reports its size", async () => {
    const file = await writeText(dir, "a.jsonl", '{"a":1}\n');
    const resolved = await resolveSource(file);
    expect(resolved.kind).toBe("file");
    expect(resolved.bytes).toBe(8);
  });

  it("treats - as stdin", async () => {
    expect((await resolveSource(STDIN_SENTINEL)).kind).toBe("stdin");
  });

  it("rejects a directory", async () => {
    await expect(resolveSource(dir)).rejects.toThrow(/is a directory/);
  });

  it("rejects a missing file", async () => {
    await expect(resolveSource(`${dir}/missing.jsonl`)).rejects.toThrow(/no such file/);
  });
});

describe("streamJsonl", () => {
  it("yields every decoded record in order", async () => {
    const file = await writeText(dir, "a.jsonl", '{"n":1}\n{"n":2}\n{"n":3}\n');
    const seen: number[] = [];
    const stats = await streamJsonl(file, (value) => {
      seen.push((value as { n: number }).n);
    });
    expect(seen).toEqual([1, 2, 3]);
    expect(stats.total).toBe(3);
    expect(stats.valid).toBe(3);
    expect(stats.invalid).toBe(0);
  });

  it("streams from a stdin pipe", async () => {
    const seen: unknown[] = [];
    const stats = await streamJsonl(
      STDIN_SENTINEL,
      (value) => {
        seen.push(value);
      },
      { stdin: stdinFrom('{"a":1}\n{"a":2}\n') },
    );
    expect(seen).toHaveLength(2);
    expect(stats.valid).toBe(2);
  });

  it("handles CRLF line endings", async () => {
    const file = await writeText(dir, "crlf.jsonl", '{"a":1}\r\n{"a":2}\r\n');
    const seen: unknown[] = [];
    const stats = await streamJsonl(file, (value) => {
      seen.push(value);
    });
    expect(stats.valid).toBe(2);
    expect(seen).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("strips a UTF-8 BOM on the first line", async () => {
    const file = await writeText(dir, "bom.jsonl", '\uFEFF{"a":1}\n');
    const seen: unknown[] = [];
    await streamJsonl(file, (value) => {
      seen.push(value);
    });
    expect(seen).toEqual([{ a: 1 }]);
  });

  it("counts malformed lines and throws by default", async () => {
    const file = await writeText(dir, "bad.jsonl", '{"a":1}\n{oops\n');
    await expect(streamJsonl(file, () => {})).rejects.toBeInstanceOf(InvalidLineError);
  });

  it("reports the line number and an excerpt for a bad line", async () => {
    const file = await writeText(dir, "bad2.jsonl", '{"a":1}\n{oops\n');
    try {
      await streamJsonl(file, () => {});
      throw new Error("expected a throw");
    } catch (error) {
      const bad = (error as InvalidLineError).bad;
      expect(bad.line).toBe(2);
      expect(bad.excerpt).toBe("{oops");
      expect(bad.reason.length).toBeGreaterThan(0);
    }
  });

  it("skips malformed lines when asked and still counts them", async () => {
    const file = await writeText(dir, "bad3.jsonl", '{"a":1}\n{oops\n{"a":3}\n');
    const seen: unknown[] = [];
    const reported: number[] = [];
    const stats = await streamJsonl(
      file,
      (value) => {
        seen.push(value);
      },
      { skipInvalid: true, onBadLine: (bad) => reported.push(bad.line) },
    );
    expect(stats.valid).toBe(2);
    expect(stats.invalid).toBe(1);
    expect(reported).toEqual([2]);
    expect(seen).toHaveLength(2);
  });

  it("handles an empty file without yielding anything", async () => {
    const file = await writeText(dir, "empty.jsonl", "");
    const stats = await streamJsonl(file, () => {});
    expect(stats.total).toBe(0);
    expect(stats.valid).toBe(0);
  });

  it("accepts JSON scalars as valid records", async () => {
    const file = await writeText(dir, "scalars.jsonl", '1\n"two"\ntrue\nnull\n[1,2]\n');
    const seen: unknown[] = [];
    const stats = await streamJsonl(file, (value) => {
      seen.push(value);
    });
    expect(stats.valid).toBe(5);
    expect(seen).toEqual([1, "two", true, null, [1, 2]]);
  });

  it("reports progress ticks at the requested interval", async () => {
    const lines = Array.from({ length: 5 }, (_, i) => JSON.stringify({ i })).join("\n") + "\n";
    const file = await writeText(dir, "five.jsonl", lines);
    const ticks: string[] = [];
    const sink = { write: (chunk: string) => ticks.push(chunk) } as unknown as NodeJS.WritableStream;
    await streamJsonl(file, () => {}, { progressEvery: 2, progressSink: sink });
    expect(ticks).toHaveLength(2);
    expect(ticks[0]).toContain("2 lines");
  });
});
