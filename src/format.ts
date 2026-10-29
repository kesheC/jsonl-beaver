/**
 * Output formatting: CSV, pretty JSON, and the aligned tables `jlb stat` /
 * `jlb agg` print to a terminal.
 *
 * Everything is a pure string transform so it can be unit-tested without
 * spawning a process.
 */

import type { GroupStat, StatResult } from "./agg.js";

/**
 * Quote a CSV field per RFC 4180. Note the callers' convention: values that need
 * no quoting are emitted bare, which keeps machine output diff-friendly.
 */
export function csvEscape(value: unknown): string {
  if (value === undefined || value === null) return "";
  let text: string;
  if (typeof value === "string") text = value;
  else if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") text = String(value);
  else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  // A field starting with =, +, - or @ is a spreadsheet formula injection risk.
  // Prefixing with a single quote is the conventional mitigation and is only
  // applied to strings that would otherwise look like a formula.
  if (/^[=+\-@]/.test(text) && typeof value === "string") text = `'${text}`;
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/** Build a full CSV document (header + rows) with CRLF line endings. */
export function toCsv(fields: readonly string[], rows: readonly unknown[][], eol = "\r\n"): string {
  const lines: string[] = [fields.map(csvEscape).join(",")];
  for (const row of rows) lines.push(row.map(csvEscape).join(","));
  return lines.length === 0 ? "" : lines.join(eol) + eol;
}

/** Resolve a field path against a record and stringify it for flat export. */
export function flattenForCsv(value: unknown): string | number | boolean | null {
  if (value === undefined) return "";
  if (value === null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Human byte sizes: 1024-based, one decimal above KiB. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB", "PiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** Numbers get thousands separators; everything else is left alone. */
export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  return n.toLocaleString("en-US");
}

/** Compact number for percentages / averages: at most 2 decimals. */
export function formatNumber(n: number, decimals = 2): string {
  if (!Number.isFinite(n)) return "n/a";
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(decimals);
}

export function formatPercent(ratio: number, decimals = 1): string {
  if (!Number.isFinite(ratio)) return "n/a";
  return `${(ratio * 100).toFixed(decimals)}%`;
}

/** Pad to width, accounting for wide CJK glyphs occupying two terminal cells. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    width += isWide(code) ? 2 : 1;
  }
  return width;
}

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f900 && code <= 0x1f9ff)
  );
}

export function padEndWide(text: string, width: number): string {
  const pad = width - displayWidth(text);
  return pad > 0 ? text + " ".repeat(pad) : text;
}

export function padStartWide(text: string, width: number): string {
  const pad = width - displayWidth(text);
  return pad > 0 ? " ".repeat(pad) + text : text;
}

/** Render an aligned table with a header rule. Empty input yields "". */
export function renderTable(header: readonly string[], rows: readonly (readonly string[])[], align: readonly ("left" | "right")[] = []): string {
  if (header.length === 0) return "";
  const widths = header.map((h, i) => {
    let width = displayWidth(h);
    for (const row of rows) width = Math.max(width, displayWidth(row[i] ?? ""));
    return width;
  });
  const layout = (row: readonly string[]): string =>
    row
      .map((cell, i) => {
        const width = widths[i] ?? 0;
        return align[i] === "right" ? padStartWide(cell ?? "", width) : padEndWide(cell ?? "", width);
      })
      .join("  ")
      .trimEnd();
  const separator = widths.map((w) => "─".repeat(w)).join("  ");
  return [layout(header), separator, ...rows.map(layout)].join("\n");
}

/** The `jlb stat` text report. */
export function renderStat(stat: StatResult, topFields = 30): string {
  const lines: string[] = [];
  lines.push("Summary");
  lines.push(`  lines         ${formatCount(stat.total)}`);
  lines.push(`  valid         ${formatCount(stat.valid)}`);
  // No hint text here: the per-line messages on stderr already explain what was
  // skipped, and this block is what `--skip-invalid` runs print.
  lines.push(`  invalid       ${formatCount(stat.invalid)}`);
  // stdin has no knowable length up front; printing "0 B" would be a lie.
  lines.push(`  size          ${stat.bytes === 0 && stat.total > 0 ? "(stdin)" : formatBytes(stat.bytes)}`);
  lines.push(`  fields        ${stat.fieldCount}${stat.fieldsTruncated ? ` (capped at 5000; more exist)` : ""}`);
  lines.push(`  max depth     ${stat.maxDepth}`);
  lines.push("");
  lines.push("Line length (chars)");
  lines.push(`  p50 ${formatCount(stat.lengthP50)}   p95 ${formatCount(stat.lengthP95)}   max ${formatCount(stat.lengthMax)}`);
  lines.push("");
  if (stat.fields.length === 0) {
    lines.push("Fields: none (no top-level object records)");
    return lines.join("\n");
  }
  lines.push(`Top fields (${Math.min(topFields, stat.fields.length)} of ${stat.fieldCount})`);
  const shown = stat.fields.slice(0, topFields);
  const rows = shown.map((field) => {
    const types = Object.entries(field.types)
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name, n]) => `${name}:${formatNumber((n / Math.max(1, field.present)) * 100, 0)}%`)
      .join(" ");
    return [field.name, formatCount(field.present), formatPercent(field.rate), types];
  });
  lines.push(renderTable(["FIELD", "COUNT", "RATE", "TYPES"], rows, ["left", "right", "right", "left"]));
  return lines.join("\n");
}

/** The `jlb agg` text report. */
export function renderAgg(groups: readonly GroupStat[], options: { by?: string; metric: string; top: number; truncated: boolean; totalGroups: number }): string {
  const lines: string[] = [];
  if (groups.length === 0) return "No matching records.";
  const header = [options.by === undefined ? "(all)" : options.by.toUpperCase(), "COUNT"];
  const align: ("left" | "right")[] = ["left", "right"];
  const showMetric = options.metric !== "count";
  if (showMetric) {
    header.push(options.metric.toUpperCase());
    align.push("right");
  }
  const rows = groups.map((group) => {
    const row = [group.key, formatCount(group.count)];
    if (showMetric) {
      if (options.metric === "sum") row.push(formatNumber(group.sum));
      else if (options.metric === "avg") row.push(formatNumber(group.avg));
      else if (options.metric === "p95") row.push(formatNumber(group.p95Group));
      else row.push("");
    }
    return row;
  });
  lines.push(renderTable(header, rows, align));
  if (options.truncated) {
    lines.push("");
    lines.push(`Showing top ${options.top} of ${formatCount(options.totalGroups)} groups.`);
  }
  return lines.join("\n");
}

/** Pretty-print a JSON value using 2 spaces, tolerating circular-free input. */
export function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? "null";
}

/** One-line JSON, the shape you want when piping into another tool. */
export function compactJson(value: unknown): string {
  return JSON.stringify(value) ?? "null";
}
