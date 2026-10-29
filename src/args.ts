/**
 * A tiny, dependency-free argument parser.
 *
 * Deliberately not a general-purpose framework: it understands `--flag`,
 * `--key value`, `--key=value`, short `-n 10`, `--` terminator and positional
 * arguments, and it reports the offending token instead of guessing.
 */

export interface ParsedArgs {
  /** Positional arguments in order. */
  positionals: string[];
  /** Flags with values, keyed without leading dashes. */
  values: Map<string, string>;
  /** Boolean flags, keyed without leading dashes. */
  flags: Set<string>;
}

export class ArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgError";
  }
}

export interface OptionSpec {
  /** Long name without dashes, e.g. `where`. */
  name: string;
  /** Optional short alias, e.g. `n`. */
  short?: string;
  /** True when the option takes a value. */
  takesValue: boolean;
  /** Alternative names that resolve to this option. */
  aliases?: string[];
}

export function parseArgs(argv: readonly string[], spec: readonly OptionSpec[]): ParsedArgs {
  const byName = new Map<string, OptionSpec>();
  for (const option of spec) {
    byName.set(option.name, option);
    if (option.short !== undefined) byName.set(option.short, option);
    for (const alias of option.aliases ?? []) byName.set(alias, option);
  }

  const parsed: ParsedArgs = { positionals: [], values: new Map(), flags: new Set() };
  let index = 0;
  while (index < argv.length) {
    const token = argv[index]!;
    if (token === "--") {
      parsed.positionals.push(...argv.slice(index + 1));
      break;
    }
    if (token === "-" || !token.startsWith("-")) {
      parsed.positionals.push(token);
      index++;
      continue;
    }
    const isLong = token.startsWith("--");
    const body = isLong ? token.slice(2) : token.slice(1);
    const eq = body.indexOf("=");
    const name = eq >= 0 ? body.slice(0, eq) : body;
    const inlineValue = eq >= 0 ? body.slice(eq + 1) : undefined;
    const option = byName.get(name);
    if (option === undefined) {
      throw new ArgError(`unknown option: ${isLong ? "--" : "-"}${name}`);
    }
    if (!option.takesValue) {
      if (inlineValue !== undefined) throw new ArgError(`option --${option.name} does not take a value`);
      parsed.flags.add(option.name);
      index++;
      continue;
    }
    if (inlineValue !== undefined) {
      parsed.values.set(option.name, inlineValue);
      index++;
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined) throw new ArgError(`option --${option.name} requires a value`);
    parsed.values.set(option.name, next);
    index += 2;
  }
  return parsed;
}

/** Parse an integer option, rejecting `12abc`, `1.5` and empty strings. */
export function parseInteger(raw: string, optionName: string): number {
  if (!/^-?\d+$/.test(raw.trim())) throw new ArgError(`--${optionName} expects an integer, got "${raw}"`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new ArgError(`--${optionName} is out of range: ${raw}`);
  return value;
}
