/**
 * Small, reusable command-line option parser.
 *
 * Commands are non-interactive. Global `--json` and `--help` are recognized for
 * every command, and command-specific options are described with a spec list so
 * Task 12 can add `render` without changing the parsing contract.
 */

export type OptionKind = 'boolean' | 'string';

export interface CliOptionSpec {
  /** Canonical option name without leading dashes. */
  readonly name: string;
  readonly kind: OptionKind;
  /** Optional single-character aliases without the leading dash. */
  readonly aliases?: readonly string[];
}

export interface ParsedArgs {
  readonly positionals: readonly string[];
  readonly values: ReadonlyMap<string, string | true>;
  readonly json: boolean;
  readonly help: boolean;
}

export interface UsageProblem {
  readonly code: string;
  readonly message: string;
  readonly hint: string;
}

export type ParseArgsResult =
  | { readonly ok: true; readonly value: ParsedArgs }
  | { readonly ok: false; readonly error: UsageProblem };

interface ResolvedOption {
  readonly name: string;
  readonly kind: OptionKind;
}

const GLOBAL_OPTIONS: readonly CliOptionSpec[] = Object.freeze([
  { name: 'json', kind: 'boolean' },
  { name: 'help', kind: 'boolean', aliases: ['h'] },
]);

function usageHint(command: string): string {
  return `Run "vamp ${command} --help" for usage.`;
}

function unknownOption(command: string, display: string): UsageProblem {
  return {
    code: 'cli.usage.unknown_option',
    message: `unknown option "${display}"`,
    hint: usageHint(command),
  };
}

/**
 * Parse command arguments. This validates option syntax only. Positional count
 * and required arguments are command concerns so `--help` can short-circuit
 * before required arguments are enforced.
 */
export function parseArgs(
  command: string,
  args: readonly string[],
  specs: readonly CliOptionSpec[] = [],
): ParseArgsResult {
  const options = new Map<string, ResolvedOption>();
  for (const spec of [...GLOBAL_OPTIONS, ...specs]) {
    const resolved: ResolvedOption = { name: spec.name, kind: spec.kind };
    options.set(spec.name, resolved);
    for (const alias of spec.aliases ?? []) {
      options.set(alias, resolved);
    }
  }

  const values = new Map<string, string | true>();
  const positionals: string[] = [];
  let positionalOnly = false;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === undefined) {
      break;
    }
    if (positionalOnly) {
      positionals.push(token);
      continue;
    }
    if (token === '--') {
      positionalOnly = true;
      continue;
    }
    if (token.startsWith('--')) {
      const body = token.slice(2);
      const equals = body.indexOf('=');
      const rawName = equals === -1 ? body : body.slice(0, equals);
      const display = equals === -1 ? token : `--${rawName}`;
      const option = options.get(rawName);
      if (option === undefined || rawName.length === 0) {
        return { ok: false, error: unknownOption(command, display) };
      }
      if (option.kind === 'boolean') {
        if (equals !== -1) {
          return {
            ok: false,
            error: {
              code: 'cli.usage.invalid_option_value',
              message: `option "--${rawName}" does not take a value`,
              hint: usageHint(command),
            },
          };
        }
        values.set(option.name, true);
        continue;
      }

      if (equals !== -1) {
        const attached = body.slice(equals + 1);
        if (attached.length === 0) {
          return {
            ok: false,
            error: {
              code: 'cli.usage.missing_option_value',
              message: `option "--${rawName}" requires a value`,
              hint: `Pass --${rawName} <value> or --${rawName}=<value>. ${usageHint(command)}`,
            },
          };
        }
        values.set(option.name, attached);
        continue;
      }

      const next = args[index + 1];
      if (next === undefined || (next.startsWith('-') && next !== '-')) {
        return {
          ok: false,
          error: {
            code: 'cli.usage.missing_option_value',
            message: `option "--${rawName}" requires a value`,
            hint: `Pass --${rawName} <value>. Use --${rawName}=<value> when the value begins with a dash. ${usageHint(command)}`,
          },
        };
      }
      values.set(option.name, next);
      index += 1;
      continue;
    }
    if (token.startsWith('-') && token !== '-') {
      const alias = token.slice(1);
      const option = options.get(alias);
      if (option === undefined || alias.length === 0) {
        return { ok: false, error: unknownOption(command, token) };
      }
      if (option.kind !== 'boolean') {
        return { ok: false, error: unknownOption(command, token) };
      }
      values.set(option.name, true);
      continue;
    }
    positionals.push(token);
  }

  return {
    ok: true,
    value: {
      positionals,
      values,
      json: values.get('json') === true,
      help: values.get('help') === true,
    },
  };
}

export function getStringOption(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.values.get(name);
  return typeof value === 'string' ? value : undefined;
}

export function hasFlag(parsed: ParsedArgs, name: string): boolean {
  return parsed.values.get(name) === true;
}
