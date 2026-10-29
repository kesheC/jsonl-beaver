/**
 * Command implementations.
 *
 * Each command is a function of (input, options) plus an output sink, so the
 * same code backs the CLI and the library API and can be tested without a
 * child process. Nothing here touches `process.argv` or calls `process.exit`.
 */

import { compileExpr, type CompiledExpr } from "./expr.js";
import { getByPath, parsePath } from "./path.js";
import { streamJsonl, type BadLine, type StreamOptions, type StreamStats } from "./stream.js";
import { Aggregator, StatAccumulator, type GroupStat, type StatResult } from "./agg.js";
import { csvEscape, compactJson, flattenForCsv, prettyJson } from "./format.js";

export interface CommonOptions {
  skipInvalid?: boolean;
  onBadLine?: (bad: BadLine) => void;
  progressEvery?: number;
  progressSink?: NodeJS.WritableStream;
  onBytes?: (bytes: number) => void;
}

function toStreamOptions(options: CommonOptions): StreamOptions {
  return {
    skipInvalid: options.skipInvalid,
    onBadLine: options.onBadLine,
    progressEvery: options.progressEvery,
    progressSink: options.progressSink,
    onBytes: options.onBytes,
  };
}

/** Internal control-flow signal used to break out of the for-await loop early. */
class StopIteration extends Error {
  constructor() {
    super("stop");
    this.name = "StopIteration";
  }
}

function rethrowUnlessStop(error: unknown): void {
  if (!(error instanceof StopIteration)) throw error;
}

function compileOptional(where: string | undefined, node: CompiledExpr | undefined): CompiledExpr | null {
  if (node !== undefined) return node;
  return where !== undefined ? compileExpr(where) : null;
}

export interface StatOptions extends CommonOptions {
  /** How many field rows to keep (default 30). */
  topFields?: number;
}

/** `jlb stat` — one pass, bounded memory. */
export async function collectStat(input: string, options: StatOptions = {}): Promise<StatResult> {
  const accumulator = new StatAccumulator();
  const topFields = options.topFields ?? 30;
  const result = await streamJsonl(
    input,
    (value, _lineNumber, raw) => {
      accumulator.addLine(raw);
      accumulator.addRecord(value);
    },
    toStreamOptions(options),
  );
  accumulator.total = result.total;
  accumulator.invalid = result.invalid;
  accumulator.bytes = result.bytes;
  const stat = accumulator.result();
  stat.fields = stat.fields.slice(0, topFields);
  return stat;
}

export interface HeadResult {
  /** Records emitted to the consumer. */
  emitted: number;
  /** True when reading stopped because the requested count was reached. */
  partial: boolean;
}

/** `jlb head -n N` — stops reading as soon as N records are emitted. */
export async function runHead(
  input: string,
  count: number,
  options: CommonOptions & { emit: (record: unknown) => void },
): Promise<HeadResult> {
  let emitted = 0;
  let partial = false;
  if (count <= 0) return { emitted: 0, partial: false };
  try {
    await streamJsonl(
      input,
      (value) => {
        options.emit(value);
        emitted++;
        if (emitted >= count) {
          partial = true;
          throw new StopIteration();
        }
      },
      toStreamOptions(options),
    );
  } catch (error) {
    rethrowUnlessStop(error);
  }
  return { emitted, partial };
}

export interface FilterOptions extends CommonOptions {
  where?: string;
  whereNode?: CompiledExpr;
  limit?: number;
  emit: (record: unknown) => void;
}

export interface FilterResult {
  matched: number;
  scanned: number;
  valid: number;
}

/** `jlb filter --where ...` — the predicate is compiled once, then applied per line. */
export async function runFilter(input: string, options: FilterOptions): Promise<FilterResult> {
  const predicate = compileOptional(options.where, options.whereNode);
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  let matched = 0;
  let scanned = 0;
  let valid = 0;
  if (limit <= 0) return { matched: 0, scanned: 0, valid: 0 };
  try {
    const stats = await streamJsonl(
      input,
      (value) => {
        scanned++;
        if (predicate !== null && !predicate(value)) return;
        options.emit(value);
        matched++;
        if (matched >= limit) throw new StopIteration();
      },
      toStreamOptions(options),
    );
    valid = stats.valid;
  } catch (error) {
    rethrowUnlessStop(error);
  }
  return { matched, scanned, valid };
}

export interface AggRunOptions extends CommonOptions {
  by?: string;
  sum?: string;
  avg?: string;
  p95?: string;
  top?: number;
  where?: string;
  whereNode?: CompiledExpr;
}

export interface AggResult {
  groups: GroupStat[];
  totalGroups: number;
  scanned: number;
  valid: number;
  metric: "count" | "sum" | "avg" | "p95";
}

/** `jlb agg --by ... --count/--sum/--avg/--p95`. */
export async function runAgg(input: string, options: AggRunOptions): Promise<AggResult> {
  if (options.by !== undefined && parsePath(options.by) === null) {
    throw new Error(`invalid --by field path: ${options.by}`);
  }
  const aggregator = new Aggregator({ by: options.by, sum: options.sum, avg: options.avg, p95: options.p95 });
  const predicate = compileOptional(options.where, options.whereNode);
  let scanned = 0;
  const stats = await streamJsonl(
    input,
    (value) => {
      scanned++;
      if (predicate !== null && !predicate(value)) return;
      aggregator.add(value, getByPath);
    },
    toStreamOptions(options),
  );
  const groups = aggregator.results(options.top ?? 20);
  const metric: AggResult["metric"] =
    options.sum !== undefined ? "sum" : options.avg !== undefined ? "avg" : options.p95 !== undefined ? "p95" : "count";
  return { groups, totalGroups: aggregator.size, scanned, valid: stats.valid, metric };
}

export interface ExportOptions extends CommonOptions {
  fields: string[];
  where?: string;
  whereNode?: CompiledExpr;
  limit?: number;
  /** Receives one already-formatted line (no trailing newline). */
  emit: (line: string) => void;
}

/** `jlb to-csv` — header first, then one row per matching record. */
export async function runToCsv(input: string, options: ExportOptions): Promise<{ rows: number }> {
  const predicate = compileOptional(options.where, options.whereNode);
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  let rows = 0;
  options.emit(options.fields.map(csvEscape).join(","));
  if (limit <= 0) return { rows: 0 };
  try {
    await streamJsonl(
      input,
      (value) => {
        if (predicate !== null && !predicate(value)) return;
        options.emit(options.fields.map((field) => csvEscape(flattenForCsv(getByPath(value, field)))).join(","));
        rows++;
        if (rows >= limit) throw new StopIteration();
      },
      toStreamOptions(options),
    );
  } catch (error) {
    rethrowUnlessStop(error);
  }
  return { rows };
}

/** `jlb to-jsonl --fields a,b` — reshape records, dropping everything else. */
export async function runToJsonl(
  input: string,
  options: ExportOptions & { pretty?: boolean },
): Promise<{ rows: number }> {
  const predicate = compileOptional(options.where, options.whereNode);
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  let rows = 0;
  if (limit <= 0) return { rows: 0 };
  try {
    await streamJsonl(
      input,
      (value) => {
        if (predicate !== null && !predicate(value)) return;
        const shaped: Record<string, unknown> = {};
        for (const field of options.fields) {
          const resolved = getByPath(value, field);
          shaped[field] = resolved === undefined ? null : resolved;
        }
        options.emit(options.pretty ? prettyJson(shaped) : compactJson(shaped));
        rows++;
        if (rows >= limit) throw new StopIteration();
      },
      toStreamOptions(options),
    );
  } catch (error) {
    rethrowUnlessStop(error);
  }
  return { rows };
}

export type { StreamStats };
