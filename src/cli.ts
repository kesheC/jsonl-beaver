#!/usr/bin/env node
/**
 * `jlb` — the command line front end.
 *
 * This file only parses arguments, wires streams together and formats reports.
 * All behaviour lives in `commands.ts` / `stream.ts` / `agg.ts`, which is what
 * makes the same engine usable as a library.
 */

import process from "node:process";
import { collectStat, runHead, runFilter, runAgg, runToCsv, runToJsonl } from "./commands.js";
import { compileExpr, ExprError } from "./expr.js";
import { InputError, InvalidLineError } from "./stream.js";
import { formatBytes, formatCount, prettyJson, renderStat, renderAgg, compactJson, flattenForCsv } from "./format.js";
import { ArgError, parseArgs, parseInteger, type OptionSpec } from "./args.js";
import { VERSION } from "./index.js";

const GLOBAL_OPTIONS: OptionSpec[] = [
  { name: "skip-invalid", takesValue: false },
  { name: "json", takesValue: false },
  { name: "progress", takesValue: false },
  { name: "pretty", takesValue: false },
  { name: "help", short: "h", takesValue: false },
  { name: "version", short: "V", takesValue: false },
  { name: "top", short: "t", takesValue: true },
  { name: "limit", short: "l", takesValue: true },
  { name: "where", short: "w", takesValue: true },
  { name: "where-file", takesValue: true },
  { name: "by", takesValue: true },
  { name: "count", takesValue: false },
  { name: "sum", takesValue: true },
  { name: "avg", takesValue: true },
  { name: "p95", takesValue: true },
  { name: "fields", short: "f", takesValue: true },
  { name: "lines", short: "n", takesValue: true },
  { name: "out", short: "o", takesValue: true },
  { name: "quiet", short: "q", takesValue: false },
];

const HELP = `jlb — streaming JSONL log analytics

Usage:
  jlb stat    <file|-> [--top N] [--json] [--skip-invalid]
  jlb head    <file|-> [-n N] [--pretty] [--skip-invalid]
  jlb filter  <file|-> --where "expr" [--limit N] [--pretty] [--json]
  jlb agg     <file|-> [--by field] [--count|--sum f|--avg f|--p95 f]
              [--top N] [--where "expr"] [--json]
  jlb to-csv  <file|-> --fields a,b.c [--where "expr"] [--limit N] [-o file]
  jlb to-jsonl <file|-> --fields a,b.c [--where "expr"] [--limit N] [--pretty]

  jlb --help | jlb --version

Common options:
  -w, --where <expr>    Filter expression (also valid for agg/to-csv/to-jsonl)
      --where-file <f>  Read the expression from a file
      --skip-invalid    Skip malformed lines instead of failing on the first one
      --json            Machine-readable JSON on stdout instead of a table
      --progress        Print a progress tick to stderr every 1M lines
  -l, --limit <n>       Stop after n matching records
  -t, --top <n>         Rows in stat (fields) / agg (groups) output
  -o, --out <file>      Write output to a file instead of stdout
      --quiet           Suppress the summary footer

Where expressions:
  status>=500 and level=error
  level != "debug" or dur > 500
  (status = 500 or status = 502) and not cached
  path includes "/api/" and user.role = admin
  items[0].id = 7

  Operators: = == != > >= < <= includes and or not ( )
  Numbers, single- or double-quoted strings; true / false / null are literals.

Field paths:
  a.b.c            nested objects
  items[0].id      array index
  items.0.id       same thing

Notes:
  "-" reads stdin, so "cat app.jsonl | jlb stat -" works.
  Memory stays bounded regardless of input size.
`;

interface GlobalFlags {
  skipInvalid: boolean;
  json: boolean;
  progress: boolean;
  pretty: boolean;
  limit?: number;
  top?: number;
}

function readGlobals(parsed: ReturnType<typeof parseArgs>): GlobalFlags {
  const flags: GlobalFlags = {
    skipInvalid: parsed.flags.has("skip-invalid"),
    json: parsed.flags.has("json"),
    progress: parsed.flags.has("progress"),
    pretty: parsed.flags.has("pretty"),
  };
  const limit = parsed.values.get("limit");
  if (limit !== undefined) flags.limit = parseInteger(limit, "limit");
  const top = parsed.values.get("top");
  if (top !== undefined) flags.top = parseInteger(top, "top");
  return flags;
}

function progressWriter(enabled: boolean): NodeJS.WritableStream | undefined {
  return enabled ? process.stderr : undefined;
}

function reportBadLine(bad: { line: number; excerpt: string; reason: string }, quiet: boolean, json: boolean): void {
  if (quiet) return;
  if (json) {
    process.stderr.write(`${compactJson({ level: "warn", type: "invalid-line", line: bad.line, reason: bad.reason, excerpt: bad.excerpt })}\n`);
    return;
  }
  process.stderr.write(`jlb: skipping line ${bad.line}: ${bad.reason}\n`);
  process.stderr.write(`     ${bad.excerpt}\n`);
}

async function readWhere(parsed: ReturnType<typeof parseArgs>): Promise<string | undefined> {
  const inline = parsed.values.get("where");
  const fromFile = parsed.values.get("where-file");
  if (inline !== undefined && fromFile !== undefined) {
    throw new ArgError("use either --where or --where-file, not both");
  }
  if (fromFile !== undefined) {
    const { readFile } = await import("node:fs/promises");
    try {
      const text = await readFile(fromFile, "utf8");
      return text.trim();
    } catch {
      throw new ArgError(`cannot read --where-file: ${fromFile}`);
    }
  }
  return inline;
}

function parseFieldList(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  const fields = raw.split(",").map((f) => f.trim()).filter((f) => f !== "");
  if (fields.length === 0) throw new ArgError("--fields needs at least one field name");
  return fields;
}

async function main(argv: readonly string[]): Promise<number> {
  if (argv.length === 0) {
    process.stdout.write(HELP);
    return 2;
  }

  const command = argv[0]!;
  if (command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  if (command === "--version" || command === "-V" || command === "version") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  const parsed = parseArgs(argv.slice(1), GLOBAL_OPTIONS);
  if (parsed.flags.has("help")) {
    process.stdout.write(HELP);
    return 0;
  }
  const flags = readGlobals(parsed);
  const quiet = parsed.flags.has("quiet");

  const input = parsed.positionals[0];
  if (input === undefined) throw new ArgError(`${command}: missing <file|-> argument`);
  if (parsed.positionals.length > 1 && command !== "head") {
    throw new ArgError(`${command}: unexpected argument "${parsed.positionals[1]}"`);
  }

  const where = await readWhere(parsed);
  const common = {
    skipInvalid: flags.skipInvalid,
    progressEvery: flags.progress ? 1_000_000 : 0,
    progressSink: process.stderr,
    onBadLine: (bad: import("./stream.js").BadLine) => reportBadLine(bad, quiet, flags.json),
  };

  const outPath = parsed.values.get("out");
  const sink = outPath !== undefined ? (await import("node:fs")).createWriteStream(outPath, { encoding: "utf8" }) : null;
  const write = (text: string): void => {
    if (sink !== null) sink.write(text);
    else process.stdout.write(text);
  };

  try {
    switch (command) {
      case "stat": {
        const stat = await collectStat(input, { ...common, topFields: flags.top ?? 30 });
        if (flags.json) {
          write(prettyJson({ ...stat, fields: stat.fields.slice(0, flags.top ?? 30) }) + "\n");
        } else {
          write(renderStat(stat, flags.top ?? 30) + "\n");
        }
        return 0;
      }

      case "head": {
        const rawCount = parsed.values.get("lines");
        const count = rawCount !== undefined ? parseInteger(rawCount, "lines") : 10;
        if (count < 0) throw new ArgError("--lines must be >= 0");
        const result = await runHead(input, count, {
          ...common,
          emit: (record) => {
            write((flags.pretty ? prettyJson(record) : compactJson(record)) + "\n");
          },
        });
        if (!quiet && !flags.json && result.partial) {
          process.stderr.write(`jlb: stopped after ${result.emitted} record(s)\n`);
        }
        return 0;
      }

      case "filter": {
        if (where === undefined) throw new ArgError("filter: --where <expr> is required");
        const predicate = compileExpr(where);
        const result = await runFilter(input, {
          ...common,
          whereNode: predicate,
          limit: flags.limit,
          emit: (record) => {
            write((flags.pretty ? prettyJson(record) : compactJson(record)) + "\n");
          },
        });
        if (!quiet && flags.json) {
          process.stderr.write(`${compactJson({ type: "summary", matched: result.matched, scanned: result.scanned })}\n`);
        } else if (!quiet) {
          process.stderr.write(`jlb: ${formatCount(result.matched)} matched of ${formatCount(result.scanned)} scanned\n`);
        }
        return 0;
      }

      case "agg": {
        const by = parsed.values.get("by");
        const sum = parsed.values.get("sum");
        const avg = parsed.values.get("avg");
        const p95 = parsed.values.get("p95");
        const metricCount = [sum, avg, p95].filter((v) => v !== undefined).length;
        if (metricCount > 1) throw new ArgError("agg: pick at most one of --sum / --avg / --p95");
        if (by === undefined && metricCount === 0 && !parsed.flags.has("count")) {
          throw new ArgError("agg: nothing to compute — pass --count, --sum, --avg or --p95");
        }
        const result = await runAgg(input, {
          ...common,
          by,
          sum,
          avg,
          p95,
          top: flags.top ?? 20,
          where,
        });
        if (flags.json) {
          // Emit only the metric that was requested; a "sum" for a count-only
          // grouping would just be a row of nulls.
          const groups = result.groups.map((group) => {
            const row: Record<string, unknown> = { key: group.key, count: group.count };
            if (result.metric === "sum") row.sum = group.sum;
            if (result.metric === "avg") row.avg = group.avg;
            if (result.metric === "p95") row.p95 = group.p95Group;
            if (result.metric !== "count") {
              row.min = group.min;
              row.max = group.max;
              row.numericCount = group.numericCount;
            }
            return row;
          });
          write(
            prettyJson({
              metric: result.metric,
              by: by ?? null,
              totalGroups: result.totalGroups,
              groups,
            }) + "\n",
          );
        } else {
          write(
            renderAgg(result.groups, {
              by,
              metric: result.metric,
              top: flags.top ?? 20,
              truncated: result.totalGroups > (flags.top ?? 20),
              totalGroups: result.totalGroups,
            }) + "\n",
          );
        }
        if (!quiet && flags.json && result.totalGroups > (flags.top ?? 20)) {
          process.stderr.write(`jlb: showing top ${flags.top ?? 20} of ${formatCount(result.totalGroups)} groups\n`);
        }
        return 0;
      }

      case "to-csv": {
        const fields = parseFieldList(parsed.values.get("fields"));
        if (fields.length === 0) throw new ArgError("to-csv: --fields a,b,c is required");
        const result = await runToCsv(input, {
          ...common,
          fields,
          where,
          limit: flags.limit,
          emit: (line) => write(line + "\n"),
        });
        if (!quiet) process.stderr.write(`jlb: ${formatCount(result.rows)} row(s) written\n`);
        return 0;
      }

      case "to-jsonl": {
        const fields = parseFieldList(parsed.values.get("fields"));
        if (fields.length === 0) throw new ArgError("to-jsonl: --fields a,b,c is required");
        const result = await runToJsonl(input, {
          ...common,
          fields,
          where,
          limit: flags.limit,
          pretty: flags.pretty,
          emit: (line) => write(line + "\n"),
        });
        if (!quiet) process.stderr.write(`jlb: ${formatCount(result.rows)} row(s) written\n`);
        return 0;
      }

      default:
        throw new ArgError(`unknown command: ${command} (try jlb --help)`);
    }
  } finally {
    if (sink !== null) {
      await new Promise<void>((resolve) => sink.end(resolve));
    }
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof ArgError) {
      process.stderr.write(`jlb: ${error.message}\n`);
      process.exitCode = 2;
      return;
    }
    if (error instanceof ExprError) {
      process.stderr.write(`jlb: bad --where expression at column ${error.position + 1}: ${error.message}\n`);
      process.exitCode = 2;
      return;
    }
    if (error instanceof InputError) {
      process.stderr.write(`jlb: ${error.message}\n`);
      process.exitCode = 2;
      return;
    }
    if (error instanceof InvalidLineError) {
      process.stderr.write(`jlb: ${error.message}\n`);
      process.stderr.write(`     ${error.bad.excerpt}\n`);
      process.stderr.write("     (pass --skip-invalid to skip malformed lines)\n");
      process.exitCode = 1;
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`jlb: ${message}\n`);
    process.exitCode = 1;
  });
