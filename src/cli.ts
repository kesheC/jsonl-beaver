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
import { InputError, InvalidLineError, resolveSource, STDIN_SENTINEL } from "./stream.js";
import { discardOpenTempFiles, installPipeGuard, openOutputSink, OutputError, type OutputSink } from "./output.js";
import { formatBytes, formatCount, prettyJson, renderStat, renderAgg, compactJson, flattenForCsv } from "./format.js";
import { ArgError, parseArgs, parseInteger, type OptionSpec } from "./args.js";
import { parsePath } from "./path.js";
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
  jlb head    <file|-> [-n N] [--pretty] [--json] [--skip-invalid]
  jlb filter  <file|-> --where "expr" [--limit N] [--pretty] [--json]
  jlb agg     <file|-> [--by field] [--count|--sum f|--avg f|--p95 f]
              [--where "expr"] [--top N] [--json]
  jlb to-csv  <file|-> --fields a,b.c [--where "expr"] [--limit N] [-o file]
  jlb to-jsonl <file|-> --fields a,b.c [--where "expr"] [--limit N] [--pretty]

  jlb --help | jlb --version

Options, and the commands that read them:
  -w, --where <expr>    Filter expression   (filter, agg, to-csv, to-jsonl)
      --where-file <f>  Read the expression from a file   (same four)
      --skip-invalid    Skip malformed lines   (every command)
      --progress        stderr tick every 1M lines   (every command)
  -o, --out <file>      Write to a file   (every command)
      --quiet           Suppress the footer   (every command)
      --json            JSON on stdout   (stat, head, filter, agg)
  -t, --top <n>         Rows in the report, >= 1   (stat, agg)
  -n, --lines <n>       Records to print, default 10   (head)
  -l, --limit <n>       Stop after n records   (filter, to-csv, to-jsonl)
      --pretty          Indented JSON   (head, filter, to-jsonl)
  -f, --fields <list>   Columns to emit   (to-csv, to-jsonl)
      --by <field>      Group by   (agg)
      --count           Count per group   (agg)
      --sum/--avg/--p95 <field>   One metric per group   (agg)

  An option outside its list is rejected with exit 2, not ignored: a filter
  that silently did nothing would look like a filter that matched everything.

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

function reportBadLine(
  bad: { line: number; excerpt: string; reason: string },
  quiet: boolean,
  json: boolean,
  skipping: boolean,
): void {
  if (quiet) return;
  // Without --skip-invalid the run aborts and `main().catch` prints the error
  // (with the hint about --skip-invalid); printing here as well would double
  // every malformed line.
  if (!skipping) return;
  if (json) {
    process.stderr.write(
      `${compactJson({ level: "warn", type: "invalid-line", line: bad.line, reason: bad.reason, excerpt: bad.excerpt, skipped: skipping })}\n`,
    );
    return;
  }
  // The wording has to match what actually happens next: without
  // --skip-invalid the run aborts, so "skipping" would be a lie.
  process.stderr.write(`jlb: ${skipping ? "skipping" : "malformed"} line ${bad.line}: ${bad.reason}\n`);
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

/**
 * Split a `--fields` value.
 *
 * Empty segments are dropped on purpose, not by accident: `--fields a,,b` and
 * `--fields a,b,` both mean `a,b`. A doubled or trailing comma is the most
 * common way to mistype a list, and an empty name is never a field anyone can
 * read from a record, so rejecting the whole invocation would only cost the
 * user a round trip. An all-empty value (`--fields ""`, `--fields "   "`,
 * `--fields ",,"`) is still an error: there is nothing left to select.
 */
function parseFieldList(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  const fields = raw.split(",").map((f) => f.trim()).filter((f) => f !== "");
  if (fields.length === 0) throw new ArgError("--fields needs at least one field name");
  return fields;
}

/**
 * The options each command actually reads.
 *
 * This table is the contract, not a summary of the help text: every entry is
 * backed by a read in that command's branch of the dispatch in `main`
 * (`flags.top`, `parsed.values.get("by")`, and so on). An option that is not
 * listed for a command has no code path looking at it, so accepting it would
 * print a normal report and look like it worked -- which is exactly the trap
 * `--limit` was already guarded against. Keeping the data here lets the error
 * message quote the commands that do use the option without drifting.
 */
const COMMAND_OPTIONS: Record<string, readonly string[]> = {
  // top -> fields.toSorted down to N, json at the report. Nothing else.
  stat: ["top", "json", "skip-invalid", "progress", "out", "quiet"],
  // lines -> runHead, pretty -> emit, json -> only the "stopped after N" note.
  head: ["lines", "pretty", "json", "skip-invalid", "progress", "out", "quiet"],
  filter: [
    "where",
    "where-file",
    "limit",
    "pretty",
    "json",
    "skip-invalid",
    "progress",
    "out",
    "quiet",
  ],
  agg: [
    "by",
    "count",
    "sum",
    "avg",
    "p95",
    "where",
    "where-file",
    "top",
    "json",
    "skip-invalid",
    "progress",
    "out",
    "quiet",
  ],
  // No --json: the "row(s) written" footer is unconditional, so accepting it
  // would promise machine-readable output that never arrives.
  "to-csv": ["fields", "where", "where-file", "limit", "skip-invalid", "progress", "out", "quiet"],
  "to-jsonl": [
    "fields",
    "where",
    "where-file",
    "limit",
    "pretty",
    "skip-invalid",
    "progress",
    "out",
    "quiet",
  ],
};

/** Every option that has to be justified by a command, in --help order. */
const SCOPED_OPTIONS: readonly string[] = GLOBAL_OPTIONS.map((option) => option.name).filter(
  (name) => name !== "help",
);

/** "a, b and c" -- the same shape the --limit message has always used. */
function listCommands(names: readonly string[]): string {
  if (names.length === 1) return names[0]!;
  return names.slice(0, -1).join(", ") + " and " + names[names.length - 1]!;
}

/**
 * Reject options the command never reads.
 *
 * The alternative -- accepting them and printing a normal report -- is worse
 * than an error, because `stat --where 'status >= 500'` returning the whole
 * file looks like a filter that matched everything.
 */
function rejectUnusedOptions(command: string, parsed: ReturnType<typeof parseArgs>): void {
  const used = new Set(COMMAND_OPTIONS[command]!);
  for (const option of SCOPED_OPTIONS) {
    if (used.has(option)) continue;
    if (!parsed.values.has(option) && !parsed.flags.has(option)) continue;
    if (option === "version") {
      throw new ArgError(`--version is not supported by ${command}; it applies to "jlb --version" on its own`);
    }
    const accepting = Object.keys(COMMAND_OPTIONS).filter((name) => COMMAND_OPTIONS[name]!.includes(option));
    throw new ArgError(`--${option} is not supported by ${command}; it applies to ${listCommands(accepting)}`);
  }
}

interface CommandConfig {
  lines: number;
  fields: string[];
}

/**
 * Run every check that can reject the invocation, before any output file is
 * opened. Keeping this separate from the dispatch is what makes `-o` safe:
 * a bad flag combination, a missing input or a malformed --where all exit 2
 * with the target file untouched.
 */
/** One wording for the one situation an unknown command can be met. */
function unknownCommandMessage(command: string): string {
  return `unknown command: ${command} (try jlb --help)`;
}

/**
 * Name an unknown command before judging anything else about the invocation.
 *
 * The command is what decides which of the remaining arguments are meaningful,
 * so the order of the complaints matters: `jlb bogus` used to be answered with
 * "bogus: missing <file|-> argument", which reads as "the command was fine,
 * you just forgot the file" and never says the command does not exist.
 */
function assertKnownCommand(command: string): void {
  if (Object.hasOwn(COMMAND_OPTIONS, command)) return;
  throw new ArgError(unknownCommandMessage(command));
}

function validateForCommand(
  command: string,
  parsed: ReturnType<typeof parseArgs>,
  flags: GlobalFlags,
  where: string | undefined,
): CommandConfig {
  switch (command) {
    case "stat":
    case "head":
    case "filter":
    case "agg":
    case "to-csv":
    case "to-jsonl":
      break;
    default:
      throw new ArgError(unknownCommandMessage(command));
  }

  // Silently ignoring an option the command never reads would look like it
  // worked; every scope error comes from COMMAND_OPTIONS, in --help order.
  rejectUnusedOptions(command, parsed);
  if (flags.limit !== undefined && flags.limit < 0) throw new ArgError("--limit must be >= 0");
  // A non-positive --top used to mean "all rows" in one place and "no fields"
  // in another, which then printed a misleading empty-fields report.
  if (flags.top !== undefined && flags.top < 1) throw new ArgError("--top must be >= 1");

  const rawLines = parsed.values.get("lines");
  const lines = rawLines !== undefined ? parseInteger(rawLines, "lines") : 10;
  if (lines < 0) throw new ArgError("--lines must be >= 0");

  let fields: string[] = [];
  if (command === "to-csv" || command === "to-jsonl") {
    fields = parseFieldList(parsed.values.get("fields"));
    if (fields.length === 0) throw new ArgError(`${command}: --fields a,b,c is required`);
    // Same check --by gets. Without it a typo like "a..b" silently becomes a
    // literal CSV header and every row comes out empty.
    for (const field of fields) {
      if (parsePath(field) === null) throw new ArgError(`${command}: invalid --fields path: ${field}`);
    }
  }

  const by = parsed.values.get("by");
  if (by !== undefined && parsePath(by) === null) {
    throw new ArgError(`invalid --by field path: ${by}`);
  }

  if (command === "filter" && where === undefined) {
    throw new ArgError("filter: --where <expr> is required");
  }

  if (command === "agg") {
    const metrics = ["sum", "avg", "p95"].filter((name) => parsed.values.get(name) !== undefined);
    if (metrics.length > 1) throw new ArgError("agg: pick at most one of --sum / --avg / --p95");
    if (parsed.values.get("by") === undefined && metrics.length === 0 && !parsed.flags.has("count")) {
      throw new ArgError("agg: nothing to compute - pass --count, --sum, --avg or --p95");
    }
  }

  return { lines, fields };
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

  // The command is judged before its arguments: a typo in the command name
  // should not come back as "you forgot the file".
  assertKnownCommand(command);

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
    onBadLine: (bad: import("./stream.js").BadLine) => reportBadLine(bad, quiet, flags.json, flags.skipInvalid),
  };
  const outPath = parsed.values.get("out");

  // ---- Validation phase ---------------------------------------------------
  // Everything that can be rejected is rejected here, before the output file
  // is opened. Opening `-o` first is what used to truncate the target when a
  // later argument or the input file turned out to be wrong.
  const config = validateForCommand(command, parsed, flags, where);
  const source = await resolveSource(input);
  // Compile the filter once, too: a bad --where must not create the file.
  const predicate = where === undefined ? undefined : compileExpr(where);

  // ---- Write phase --------------------------------------------------------
  const sink: OutputSink = await openOutputSink(outPath, source);
  const write = (text: string): void => sink.write(text);

  let code = 0;
  try {
    code = await (async (): Promise<number> => {
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
        const result = await runHead(input, config.lines, {
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
        const result = await runFilter(input, {
          ...common,
          whereNode: predicate!,
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
        const result = await runToCsv(input, {
          ...common,
          fields: config.fields,
          where,
          limit: flags.limit,
          emit: (line) => write(line + "\n"),
        });
        if (!quiet) process.stderr.write(`jlb: ${formatCount(result.rows)} row(s) written\n`);
        return 0;
      }

      case "to-jsonl": {
        const result = await runToJsonl(input, {
          ...common,
          fields: config.fields,
          where,
          limit: flags.limit,
          pretty: flags.pretty,
          emit: (line) => write(line + "\n"),
        });
        if (!quiet) process.stderr.write(`jlb: ${formatCount(result.rows)} row(s) written\n`);
        return 0;
      }

      default:
        throw new ArgError(unknownCommandMessage(command));
      }
    })();
  } catch (error) {
    // Discard the partial temp file. The target keeps whatever it had.
    await sink.abort();
    throw error;
  }

  // Only now does the temp file replace the target.
  await sink.commit();
  return code;
}

// A downstream consumer that stops reading (`jlb filter ... | head -2`) closes
// the pipe; Node turns that into an EPIPE error event. Without a listener the
// event is unhandled and kills the process, which for `-o` meant a false
// failure plus a leftover .jlb-tmp: the run died before commit().
//
// stdout carries the payload, so a closed pipe means "the reader has what it
// wants" and the run ends successfully. stderr only carries warnings and
// progress, so an EPIPE there is swallowed and the command finishes normally.
installPipeGuard(process.stdout, true);
installPipeGuard(process.stderr, false);

// SIGINT/SIGTERM skip the normal abort path, so the temp file has to be removed
// here. Idempotent on purpose: both signals can arrive during the same shutdown.
function installSignalCleanup(signal: NodeJS.Signals, exitCode: number): void {
  process.on(signal, () => {
    discardOpenTempFiles();
    process.exit(exitCode);
  });
}

installSignalCleanup("SIGINT", 130);
installSignalCleanup("SIGTERM", 143);

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
    if (error instanceof InputError || error instanceof OutputError) {
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
