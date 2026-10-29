/**
 * Bounded-memory statistics and grouping.
 *
 * Every structure in this file has a fixed memory ceiling. That is the whole
 * reason the tool can chew a multi-gigabyte file without exploding:
 *
 *  - field names are capped (`MAX_TRACKED_FIELDS`), overflow is counted, never swallowed;
 *  - line lengths use an exact histogram below `EXACT_LENGTH_LIMIT` and
 *    quarter-octave buckets above it (fixed 16 KiB of memory);
 *  - p95 of a numeric field uses a deterministic reservoir of at most
 *    `RESERVOIR_SIZE` samples, which is *exact* for groups with fewer than that
 *    many observations and an unbiased estimate beyond it.
 */

export const MAX_TRACKED_FIELDS = 5000;
export const EXACT_LENGTH_LIMIT = 4096;
export const RESERVOIR_SIZE = 4096;

export type FieldType = "string" | "number" | "boolean" | "null" | "object" | "array";

export interface FieldStat {
  /** How many records contained this field at the top level. */
  present: number;
  /** Count per JSON type seen for this field. */
  types: Record<FieldType, number>;
}

export interface StatResult {
  total: number;
  valid: number;
  invalid: number;
  bytes: number;
  /** Distinct top-level field names seen (capped). */
  fieldCount: number;
  /** True when more than `MAX_TRACKED_FIELDS` distinct names were seen. */
  fieldsTruncated: boolean;
  /** Occurrence rate, sorted by frequency descending. */
  fields: { name: string; present: number; rate: number; types: Record<FieldType, number> }[];
  /** Max nesting depth of any value (a flat object is depth 1). */
  maxDepth: number;
  lengthP50: number;
  lengthP95: number;
  lengthMax: number;
}

/** Exact for len < limit, quarter-octave buckets above it. Constant memory. */
export class LengthHistogram {
  private readonly exact = new Uint32Array(EXACT_LENGTH_LIMIT);
  private readonly coarse = new Uint32Array(512);
  private count = 0;
  private max = 0;

  add(length: number): void {
    if (length < 0) return;
    this.count++;
    if (length > this.max) this.max = length;
    if (length < EXACT_LENGTH_LIMIT) {
      this.exact[length] = (this.exact[length] ?? 0) + 1;
      return;
    }
    const bucket = coarseIndex(length);
    this.coarse[bucket] = (this.coarse[bucket] ?? 0) + 1;
  }

  get total(): number {
    return this.count;
  }

  get maximum(): number {
    return this.max;
  }

  /** Nearest-rank percentile, with bucket midpoints above the exact range. */
  percentile(p: number): number {
    if (this.count === 0) return 0;
    const target = Math.min(this.count, Math.max(1, Math.ceil((p / 100) * this.count)));
    let seen = 0;
    for (let len = 0; len < EXACT_LENGTH_LIMIT; len++) {
      const n = this.exact[len] ?? 0;
      if (n === 0) continue;
      seen += n;
      if (seen >= target) return len;
    }
    for (let bucket = 0; bucket < this.coarse.length; bucket++) {
      const n = this.coarse[bucket] ?? 0;
      if (n === 0) continue;
      seen += n;
      if (seen >= target) return Math.min(this.max, bucketMidpoint(bucket));
    }
    return this.max;
  }
}

function coarseIndex(length: number): number {
  const octave = Math.floor(Math.log2(length) * 4) - Math.floor(Math.log2(EXACT_LENGTH_LIMIT) * 4);
  const clamped = octave < 0 ? 0 : octave >= 512 ? 511 : octave;
  return clamped;
}

function bucketMidpoint(bucket: number): number {
  const base = Math.floor(Math.log2(EXACT_LENGTH_LIMIT) * 4) + bucket;
  return Math.round(2 ** ((base + 0.5) / 4));
}

export function typeOf(value: unknown): FieldType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "string": return "string";
    case "number": return "number";
    case "boolean": return "boolean";
    default: return "object";
  }
}

function emptyTypes(): Record<FieldType, number> {
  return { string: 0, number: 0, boolean: 0, null: 0, object: 0, array: 0 };
}

/** Max nesting depth. Scalars are depth 0, a flat object depth 1. */
export function depthOf(value: unknown): number {
  if (value === null || typeof value !== "object") return 0;
  let deepest = 0;
  const stack: { node: unknown; depth: number }[] = [{ node: value, depth: 1 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (depth > deepest) deepest = depth;
    if (node === null || typeof node !== "object") continue;
    const children = Array.isArray(node) ? node : Object.values(node as Record<string, unknown>);
    for (const child of children) {
      if (child !== null && typeof child === "object") stack.push({ node: child, depth: depth + 1 });
    }
  }
  return deepest;
}

export class StatAccumulator {
  private fields = new Map<string, FieldStat>();
  private readonly lengths = new LengthHistogram();
  total = 0;
  valid = 0;
  invalid = 0;
  bytes = 0;
  maxDepth = 0;
  fieldsTruncated = false;

  addLine(raw: string): void {
    this.lengths.add(raw.length);
  }

  addRecord(value: unknown): void {
    this.valid++;
    const depth = depthOf(value);
    if (depth > this.maxDepth) this.maxDepth = depth;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return;
    for (const key of Object.keys(value as Record<string, unknown>)) {
      let stat = this.fields.get(key);
      if (stat === undefined) {
        if (this.fields.size >= MAX_TRACKED_FIELDS) {
          this.fieldsTruncated = true;
          continue;
        }
        stat = { present: 0, types: emptyTypes() };
        this.fields.set(key, stat);
      }
      stat.present++;
      stat.types[typeOf((value as Record<string, unknown>)[key])]++;
    }
  }

  result(): StatResult {
    const total = this.total;
    const fields = [...this.fields.entries()]
      .map(([name, stat]) => ({
        name,
        present: stat.present,
        rate: total === 0 ? 0 : stat.present / total,
        types: { ...stat.types },
      }))
      .sort((a, b) => b.present - a.present || a.name.localeCompare(b.name));
    return {
      total,
      valid: this.valid,
      invalid: this.invalid,
      bytes: this.bytes,
      fieldCount: this.fields.size,
      fieldsTruncated: this.fieldsTruncated,
      fields,
      maxDepth: this.maxDepth,
      lengthP50: this.lengths.percentile(50),
      lengthP95: this.lengths.percentile(95),
      lengthMax: this.lengths.maximum,
    };
  }
}

function hashSeed(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic reservoir sampler.
 *
 * The PRNG is seeded from the group key, so the same input always yields the
 * same estimate — tests stay reproducible and two runs on one file agree.
 */
export class Reservoir {
  private readonly items: number[] = [];
  private seen = 0;
  private readonly random: () => number;

  constructor(private readonly capacity: number = RESERVOIR_SIZE, seed = 1) {
    this.random = mulberry32(seed);
  }

  add(value: number): void {
    this.seen++;
    if (this.items.length < this.capacity) {
      this.items.push(value);
      return;
    }
    const slot = Math.floor(this.random() * this.seen);
    if (slot < this.capacity) this.items[slot] = value;
  }

  get count(): number {
    return this.seen;
  }

  /** True when every observation was kept, i.e. the percentile is exact. */
  get exact(): boolean {
    return this.seen <= this.capacity;
  }

  percentile(p: number): number {
    if (this.items.length === 0) return Number.NaN;
    const sorted = [...this.items].sort((a, b) => a - b);
    const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
    return sorted[rank - 1]!;
  }
}

export interface GroupStat {
  key: string;
  count: number;
  sum: number;
  min: number;
  max: number;
  avg: number;
  /** p95 of the aggregated field; NaN when no numeric observations. */
  p95Group: number;
  numericCount: number;
}

export interface AggOptions {
  /** Field path used to build the group key. */
  by?: string;
  /** Field path whose numbers are summed/averaged. */
  sum?: string;
  avg?: string;
  p95?: string;
}

export class Aggregator {
  private readonly groups = new Map<string, { count: number; sum: number; min: number; max: number; reservoir: Reservoir }>();

  constructor(private readonly options: AggOptions) {}

  add(record: unknown, resolve: (record: unknown, path: string) => unknown): void {
    const keyValue = this.options.by === undefined ? "*" : resolve(record, this.options.by);
    const key = stringifyKey(keyValue);
    let group = this.groups.get(key);
    if (group === undefined) {
      group = { count: 0, sum: 0, min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY, reservoir: new Reservoir(RESERVOIR_SIZE, hashSeed(key)) };
      this.groups.set(key, group);
    }
    group.count++;

    const numericPath = this.options.sum ?? this.options.avg ?? this.options.p95;
    if (numericPath === undefined) return;
    const raw = resolve(record, numericPath);
    const numeric = toNumber(raw);
    if (numeric === null) return;
    group.sum += numeric;
    if (numeric < group.min) group.min = numeric;
    if (numeric > group.max) group.max = numeric;
    group.reservoir.add(numeric);
  }

  get size(): number {
    return this.groups.size;
  }

  results(top: number): GroupStat[] {
    const rows: GroupStat[] = [];
    for (const [key, group] of this.groups) {
      const numericCount = group.reservoir.count;
      rows.push({
        key,
        count: group.count,
        sum: group.sum,
        min: numericCount === 0 ? Number.NaN : group.min,
        max: numericCount === 0 ? Number.NaN : group.max,
        avg: numericCount === 0 ? Number.NaN : group.sum / numericCount,
        p95Group: group.reservoir.percentile(95),
        numericCount,
      });
    }
    rows.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
    return top > 0 ? rows.slice(0, top) : rows;
  }
}

export function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    if (value.trim() === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function stringifyKey(value: unknown): string {
  if (value === undefined) return "(missing)";
  if (value === null) return "(null)";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
