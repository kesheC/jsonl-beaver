/**
 * jsonl-beaver — public library API.
 *
 * The CLI (`jlb`) is a thin wrapper over these exports. Nothing in this module
 * reads `process.argv` or calls `process.exit`, so embedding the streaming
 * engine in your own pipeline is a two-line affair:
 *
 * ```ts
 * import { collectStat, runFilter } from "jsonl-beaver";
 * const stat = await collectStat("huge.ndjson");
 * console.log(stat.total, stat.invalid);
 * ```
 */

export { parsePath, getByPath, getBySegments, type PathSegment } from "./path.js";
export { compileExpr, evaluateExpr, ExprError, type CompiledExpr, type ExprValue } from "./expr.js";
export {
  streamJsonl,
  resolveSource,
  InputError,
  InvalidLineError,
  STDIN_SENTINEL,
  type BadLine,
  type StreamOptions,
  type StreamStats,
} from "./stream.js";
export {
  StatAccumulator,
  Aggregator,
  LengthHistogram,
  Reservoir,
  depthOf,
  typeOf,
  toNumber,
  stringifyKey,
  MAX_TRACKED_FIELDS,
  RESERVOIR_SIZE,
  EXACT_LENGTH_LIMIT,
  type FieldType,
  type FieldStat,
  type StatResult,
  type GroupStat,
  type AggOptions,
} from "./agg.js";
export {
  csvEscape,
  toCsv,
  flattenForCsv,
  formatBytes,
  formatCount,
  formatNumber,
  formatPercent,
  displayWidth,
  padEndWide,
  padStartWide,
  renderTable,
  renderStat,
  renderAgg,
  prettyJson,
  compactJson,
} from "./format.js";
export {
  collectStat,
  runHead,
  runFilter,
  runAgg,
  runToCsv,
  runToJsonl,
  type CommonOptions,
  type StatOptions,
  type FilterOptions,
  type ExportOptions,
} from "./commands.js";

/** Package version, kept in sync with package.json by `npm version`. */
export const VERSION = "0.1.1";