/**
 * Nested field path resolution.
 *
 * Supports dotted access (`a.b.c`) and array indexing in either syntax:
 * `items[0].id` or `items.0.id`. Missing keys resolve to `undefined` instead of
 * throwing, so a filter over heterogeneous log lines never dies on one bad record.
 */

const PATH_TOKEN = /\[(-?\d+)\]|[^.[\]]+/g;

export type PathSegment = string | number;

/**
 * Parse a field path into segments. Returns `null` for an empty/invalid path so
 * callers can report a clear CLI error instead of silently matching nothing.
 */
export function parsePath(path: string): PathSegment[] | null {
  if (typeof path !== "string") return null;
  const trimmed = path.trim();
  if (trimmed === "") return null;
  const segments: PathSegment[] = [];
  const re = new RegExp(PATH_TOKEN.source, "g");
  let match: RegExpExecArray | null;
  let consumed = 0;
  while ((match = re.exec(trimmed)) !== null) {
    // Reject gaps such as "a..b" or "a[x]" that the tokenizer would happily skip over.
    const gap = trimmed.slice(consumed, match.index);
    if (segments.length > 0 && (!match[0].startsWith("[") ? gap !== "." : gap !== "")) return null;
    if (segments.length === 0 && match.index !== 0) return null;
    if (match[1] !== undefined) {
      const index = Number(match[1]);
      if (!Number.isSafeInteger(index)) return null;
      segments.push(index);
    } else if (/^-?\d+$/.test(match[0])) {
      // `items.0.id` is documented as equivalent to `items[0].id`, so a purely
      // numeric dotted segment becomes an index. Objects with numeric-looking
      // keys still resolve: `getBySegments` falls back to a string lookup.
      const index = Number(match[0]);
      segments.push(Number.isSafeInteger(index) ? index : match[0]);
    } else {
      segments.push(match[0]);
    }
    consumed = match.index + match[0].length;
  }
  if (segments.length === 0 || consumed !== trimmed.length) return null;
  return segments;
}

/** Resolve a parsed path against a decoded JSON value. */
export function getBySegments(value: unknown, segments: readonly PathSegment[]): unknown {
  let current: unknown = value;
  for (const seg of segments) {
    if (current === null || current === undefined) return undefined;
    if (typeof seg === "number") {
      if (Array.isArray(current)) {
        current = current[seg < 0 ? current.length + seg : seg];
      } else if (typeof current === "object") {
        // Numeric object keys ("0", "1", …) are legal JSON; honour them.
        current = (current as Record<string, unknown>)[String(seg)];
      } else {
        return undefined;
      }
    } else {
      if (typeof current !== "object" || Array.isArray(current)) return undefined;
      current = (current as Record<string, unknown>)[seg];
    }
  }
  return current;
}

/** Convenience wrapper: resolve `"a.b[0].c"` against a value. */
export function getByPath(value: unknown, path: string): unknown {
  const segments = parsePath(path);
  if (segments === null) return undefined;
  return getBySegments(value, segments);
}
