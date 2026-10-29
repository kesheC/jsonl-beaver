/**
 * The `--where` expression DSL.
 *
 * Grammar (lowest to highest precedence):
 *
 *   expr        := orExpr
 *   orExpr      := andExpr ( 'or' andExpr )*
 *   andExpr     := notExpr ( 'and' notExpr )*
 *   notExpr     := 'not' notExpr | primary
 *   primary     := '(' expr ')' | comparison | path
 *   comparison  := path op value | path 'includes' value
 *   op          := '=' | '==' | '!=' | '>' | '>=' | '<' | '<='
 *
 * The parser is a hand-written recursive descent parser that produces an AST,
 * which is then compiled into a closure. Compiling once and reusing the closure
 * per record is the whole point: parsing 10M lines must not re-parse the
 * expression 10M times.
 */

import { parsePath, getBySegments, type PathSegment } from "./path.js";

export type ExprValue = unknown;

export interface CompiledExpr {
  /** Evaluate against one decoded JSON record. */
  (record: unknown): boolean;
  /** The normalized expression text this closure was compiled from. */
  readonly source: string;
}

export class ExprError extends Error {
  readonly position: number;
  constructor(message: string, position: number) {
    super(message);
    this.name = "ExprError";
    this.position = position;
  }
}

type TokenType = "path" | "number" | "string" | "op" | "word" | "lparen" | "rparen";

interface Token {
  type: TokenType;
  value: string;
  pos: number;
}

const COMPARISON_OPS = new Set(["=", "==", "!=", ">", ">=", "<", "<="]);
const PATH_HEAD = /[A-Za-z_$]/;
const PATH_BODY = /[A-Za-z0-9_$]/;

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
      continue;
    }
    if (ch === "(") {
      tokens.push({ type: "lparen", value: ch, pos: i });
      i++;
      continue;
    }
    if (ch === ")") {
      tokens.push({ type: "rparen", value: ch, pos: i });
      i++;
      continue;
    }
    // Two-character operators first so ">=" is never read as ">" then "=".
    const two = source.slice(i, i + 2);
    if (two === "!=" || two === ">=" || two === "<=" || two === "==") {
      tokens.push({ type: "op", value: two, pos: i });
      i += 2;
      continue;
    }
    if (ch === "=" || ch === ">" || ch === "<") {
      tokens.push({ type: "op", value: ch, pos: i });
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let value = "";
      let j = i + 1;
      let closed = false;
      while (j < source.length) {
        const c = source[j]!;
        if (c === "\\" && j + 1 < source.length) {
          const next = source[j + 1]!;
          value += next === "n" ? "\n" : next === "t" ? "\t" : next;
          j += 2;
          continue;
        }
        if (c === quote) {
          closed = true;
          j++;
          break;
        }
        value += c;
        j++;
      }
      if (!closed) throw new ExprError("unterminated string literal", i);
      tokens.push({ type: "string", value, pos: i });
      i = j;
      continue;
    }
    if (ch >= "0" && ch <= "9" || (ch === "-" && source[i + 1] !== undefined && source[i + 1]! >= "0" && source[i + 1]! <= "9")) {
      let j = i + 1;
      while (j < source.length && /[0-9._eE+-]/.test(source[j]!)) {
        // Only absorb +/- when it directly follows an exponent marker.
        const c = source[j]!;
        if ((c === "+" || c === "-") && !/[eE]/.test(source[j - 1]!)) break;
        j++;
      }
      const raw = source.slice(i, j);
      const num = Number(raw);
      if (!Number.isFinite(num)) throw new ExprError(`invalid number "${raw}"`, i);
      tokens.push({ type: "number", value: raw, pos: i });
      i = j;
      continue;
    }
    if (PATH_HEAD.test(ch)) {
      let j = i + 1;
      while (j < source.length) {
        const c = source[j]!;
        if (PATH_BODY.test(c)) {
          j++;
          continue;
        }
        if (c === "." && source[j + 1] !== undefined && PATH_BODY.test(source[j + 1]!)) {
          j += 2;
          while (j < source.length && PATH_BODY.test(source[j]!)) j++;
          continue;
        }
        if (c === "[") {
          let k = j + 1;
          while (k < source.length && source[k] !== "]") k++;
          if (k >= source.length) throw new ExprError("unterminated array index", j);
          j = k + 1;
          continue;
        }
        break;
      }
      const raw = source.slice(i, j);
      // A bare identifier with no dots or brackets may be a keyword. Emitting it
      // as `word` is what lets `and`/`or`/`not`/`includes` act as operators
      // instead of being mistaken for field paths.
      const lower = raw.toLowerCase();
      const isBare = !raw.includes(".") && !raw.includes("[");
      const isKeyword = lower === "and" || lower === "or" || lower === "not" || lower === "includes";
      tokens.push({ type: isBare && isKeyword ? "word" : "path", value: raw, pos: i });
      i = j;
      continue;
    }
    throw new ExprError(`unexpected character "${ch}"`, i);
  }
  return tokens;
}

type Node =
  | { kind: "or"; left: Node; right: Node }
  | { kind: "and"; left: Node; right: Node }
  | { kind: "not"; operand: Node }
  | { kind: "truthy"; segments: PathSegment[] }
  | { kind: "compare"; segments: PathSegment[]; op: string; value: ExprValue }
  | { kind: "includes"; segments: PathSegment[]; value: ExprValue };

class Parser {
  private index = 0;
  constructor(private readonly tokens: Token[], private readonly source: string) {}

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }

  private next(): Token | undefined {
    return this.tokens[this.index++];
  }

  private isWord(token: Token | undefined, word: string): boolean {
    return token !== undefined && token.type === "word" && token.value.toLowerCase() === word;
  }

  parse(): Node {
    const node = this.parseOr();
    const trailing = this.peek();
    if (trailing !== undefined) {
      throw new ExprError(`unexpected token "${trailing.value}"`, trailing.pos);
    }
    return node;
  }

  private parseOr(): Node {
    let left = this.parseAnd();
    while (this.isWord(this.peek(), "or")) {
      this.next();
      const right = this.parseAnd();
      left = { kind: "or", left, right };
    }
    return left;
  }

  private parseAnd(): Node {
    let left = this.parseNot();
    while (this.isWord(this.peek(), "and")) {
      this.next();
      const right = this.parseNot();
      left = { kind: "and", left, right };
    }
    return left;
  }

  private parseNot(): Node {
    if (this.isWord(this.peek(), "not")) {
      this.next();
      return { kind: "not", operand: this.parseNot() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Node {
    const token = this.peek();
    if (token === undefined) {
      throw new ExprError("unexpected end of expression", this.source.length);
    }
    if (token.type === "lparen") {
      this.next();
      const inner = this.parseOr();
      const closing = this.next();
      if (closing === undefined || closing.type !== "rparen") {
        throw new ExprError("missing closing parenthesis", token.pos);
      }
      return inner;
    }
    if (this.isWord(token, "true") || this.isWord(token, "false") || this.isWord(token, "null")) {
      throw new ExprError(`literal "${token.value}" cannot stand alone as a condition`, token.pos);
    }
    if (token.type === "word") {
      // A stray `and`/`or`/`includes` where a condition was expected.
      throw new ExprError(`unexpected keyword "${token.value}"`, token.pos);
    }
    if (token.type !== "path") {
      throw new ExprError(`expected a field path, got "${token.value}"`, token.pos);
    }
    this.next();
    const segments = parsePath(token.value);
    if (segments === null) throw new ExprError(`invalid field path "${token.value}"`, token.pos);

    const following = this.peek();
    if (following !== undefined && following.type === "op" && COMPARISON_OPS.has(following.value)) {
      this.next();
      const value = this.parseValueNode();
      const op = following.value === "==" ? "=" : following.value;
      return { kind: "compare", segments, op, value };
    }
    if (this.isWord(following, "includes")) {
      this.next();
      const value = this.parseValueNode();
      return { kind: "includes", segments, value };
    }
    return { kind: "truthy", segments };
  }

  private parseValueNode(): ExprValue {
    const token = this.next();
    if (token === undefined) {
      throw new ExprError("expected a value after operator", this.source.length);
    }
    if (token.type === "string") return token.value;
    if (token.type === "number") return Number(token.value);
    if (token.type === "path" || token.type === "word") {
      // A bare word on the right-hand side is a string literal, which is what
      // makes `level=error` (no quotes) work. The three JSON literals are the
      // exception, so `cached=true` compares against a real boolean.
      const lower = token.value.toLowerCase();
      if (lower === "true") return true;
      if (lower === "false") return false;
      if (lower === "null") return null;
      return token.value;
    }
    throw new ExprError(`expected a value, got "${token.value}"`, token.pos);
  }
}

function isNumeric(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === "boolean") return value ? 1 : 0;
  return null;
}

function looselyEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  const ln = asNumber(left);
  const rn = asNumber(right);
  if (ln !== null && rn !== null) return ln === rn;
  if (typeof left === "string" && typeof right === "string") return left === right;
  if (left === null || right === null) return false;
  if (typeof left === "object" && typeof right === "object") {
    // Structural comparison keeps `tags=["a","b"]` style filters usable.
    try {
      return JSON.stringify(left) === JSON.stringify(right);
    } catch {
      return false;
    }
  }
  return false;
}

function orderCompare(left: unknown, op: string, right: unknown): boolean {
  if (left === undefined || left === null) return false;
  const ln = asNumber(left);
  const rn = asNumber(right);
  if (ln !== null && rn !== null) {
    switch (op) {
      case ">": return ln > rn;
      case ">=": return ln >= rn;
      case "<": return ln < rn;
      case "<=": return ln <= rn;
      default: return false;
    }
  }
  if (typeof left === "string" || typeof right === "string") {
    const a = String(left);
    const b = String(right);
    switch (op) {
      case ">": return a > b;
      case ">=": return a >= b;
      case "<": return a < b;
      case "<=": return a <= b;
      default: return false;
    }
  }
  return false;
}

function truthy(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value !== "";
  return true;
}

function includes(left: unknown, right: unknown): boolean {
  if (left === undefined || left === null) return false;
  if (typeof left === "string") return left.includes(String(right));
  if (Array.isArray(left)) {
    return left.some((item) => looselyEqual(item, right) || (typeof item === "string" && item.includes(String(right))));
  }
  if (typeof left === "object") {
    return Object.prototype.hasOwnProperty.call(left, String(right));
  }
  return false;
}

function compileNode(node: Node): (record: unknown) => boolean {
  switch (node.kind) {
    case "or": {
      const left = compileNode(node.left);
      const right = compileNode(node.right);
      return (record) => left(record) || right(record);
    }
    case "and": {
      const left = compileNode(node.left);
      const right = compileNode(node.right);
      return (record) => left(record) && right(record);
    }
    case "not": {
      const operand = compileNode(node.operand);
      return (record) => !operand(record);
    }
    case "truthy": {
      const segments = node.segments;
      return (record) => truthy(getBySegments(record, segments));
    }
    case "compare": {
      const { segments, op, value } = node;
      return (record) => {
        const left = getBySegments(record, segments);
        // `!` mirrors SQL-ish intuition: an absent field is "different from" any
        // present value. Everything else treats absent as no-match.
        if (left === undefined) return op === "!=";
        if (op === "=") return looselyEqual(left, value);
        if (op === "!=") return !looselyEqual(left, value);
        return orderCompare(left, op, value);
      };
    }
    case "includes": {
      const { segments, value } = node;
      return (record) => includes(getBySegments(record, segments), value);
    }
  }
}

/**
 * Compile a `--where` expression into a predicate closure.
 *
 * @throws {ExprError} when the expression is syntactically invalid.
 */
export function compileExpr(source: string): CompiledExpr {
  if (typeof source !== "string" || source.trim() === "") {
    throw new ExprError("expression is empty", 0);
  }
  const tokens = tokenize(source);
  if (tokens.length === 0) throw new ExprError("expression is empty", 0);
  const ast = new Parser(tokens, source).parse();
  const predicate = compileNode(ast);
  const compiled = ((record: unknown) => predicate(record)) as { (record: unknown): boolean; readonly source: string };
  Object.defineProperty(compiled, "source", { value: source, enumerable: true });
  return compiled as CompiledExpr;
}

/** Convenience: compile and immediately test a single record. */
export function evaluateExpr(source: string, record: unknown): boolean {
  return compileExpr(source)(record);
}

export { isNumeric };
