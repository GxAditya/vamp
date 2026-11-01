/**
 * Consistent human and JSON output for every CLI command.
 *
 * Human success output goes to stdout. Human failure output goes to stderr.
 * With `--json`, stdout contains exactly one JSON document (a success or error
 * envelope) and expected failures write nothing to stderr. Exit codes are
 * stable: 0 success, 1 validation/file/project/runtime failure, 2 usage error.
 */

import type { ValidationIssue } from '@gxaditya/vamp-schema';

export const EXIT_SUCCESS = 0 as const;
export const EXIT_FAILURE = 1 as const;
export const EXIT_USAGE = 2 as const;

export type ExitCode = typeof EXIT_SUCCESS | typeof EXIT_FAILURE | typeof EXIT_USAGE;

export type StructuredValue = string | number | boolean | null;

export interface CliError {
  /** Stable machine code, for example `cli.file.missing` or `project.exists`. */
  readonly code: string;
  readonly message: string;
  readonly hint: string;
  /** Input path or project-relative path related to the failure. */
  readonly path?: string;
  /** Complete shared schema issues for validation failures. */
  readonly issues?: readonly ValidationIssue[];
  /** Additional safe, machine-readable context. */
  readonly details?: Readonly<Record<string, StructuredValue>>;
}

export interface CliSuccessEnvelope<T> {
  readonly command: string;
  readonly ok: true;
  readonly data: T;
  readonly warnings: readonly ValidationIssue[];
}

export interface CliErrorEnvelope {
  readonly command: string;
  readonly ok: false;
  readonly error: CliError;
  readonly warnings: readonly ValidationIssue[];
}

export type CliEnvelope<T> = CliSuccessEnvelope<T> | CliErrorEnvelope;

export interface CommandSuccess<T> {
  readonly kind: 'success';
  readonly data: T;
  readonly warnings: readonly ValidationIssue[];
  readonly human: string;
}

export interface CommandFailure {
  readonly kind: 'failure';
  readonly error: CliError;
  readonly warnings: readonly ValidationIssue[];
  readonly exitCode: typeof EXIT_FAILURE | typeof EXIT_USAGE;
  readonly human: string;
}

export interface CommandText {
  readonly kind: 'text';
  readonly text: string;
}

export type CommandOutcome<T> = CommandSuccess<T> | CommandFailure | CommandText;

export function success<T>(
  data: T,
  warnings: readonly ValidationIssue[],
  human: string,
): CommandSuccess<T> {
  return { kind: 'success', data, warnings, human };
}

export function failure(
  error: CliError,
  human: string,
  options: {
    readonly warnings?: readonly ValidationIssue[];
    readonly exitCode?: typeof EXIT_FAILURE | typeof EXIT_USAGE;
  } = {},
): CommandFailure {
  return {
    kind: 'failure',
    error,
    warnings: options.warnings ?? [],
    exitCode: options.exitCode ?? EXIT_FAILURE,
    human,
  };
}

export function text(value: string): CommandText {
  return { kind: 'text', text: value };
}

export function usageFailure(command: string, error: CliError): CommandFailure {
  return failure(error, formatError(command, error), { exitCode: EXIT_USAGE });
}

function ensureNewline(value: string): string {
  return value.endsWith('\n') ? value : `${value}\n`;
}

export function writeStdout(value: string): void {
  process.stdout.write(ensureNewline(value));
}

export function writeStderr(value: string): void {
  process.stderr.write(ensureNewline(value));
}

export function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function formatIssue(issue: ValidationIssue): string {
  const pointer = issue.path === '' ? '(document root)' : issue.path;
  return `  - [${issue.code}] ${pointer}: ${issue.message}\n    Hint: ${issue.hint}`;
}

export function formatWarnings(warnings: readonly ValidationIssue[]): string {
  if (warnings.length === 0) {
    return 'Warnings: none';
  }
  const label = warnings.length === 1 ? 'Warning' : 'Warnings';
  return `${label} (${warnings.length}):\n${warnings.map(formatIssue).join('\n')}`;
}

export function formatError(command: string, error: CliError): string {
  const lines = [`vamp ${command}: ${error.message}`];
  if (error.path !== undefined) {
    lines.push(`Path: ${error.path}`);
  }
  if (error.issues !== undefined && error.issues.length > 0) {
    lines.push(error.issues.map(formatIssue).join('\n'));
  }
  if (error.hint.length > 0) {
    lines.push(`Hint: ${error.hint}`);
  }
  return lines.join('\n');
}

/**
 * Write one command outcome and return the process exit code.
 */
export function emitOutcome<T>(
  command: string,
  json: boolean,
  outcome: CommandOutcome<T>,
): ExitCode {
  if (outcome.kind === 'text') {
    writeStdout(outcome.text);
    return EXIT_SUCCESS;
  }

  if (json) {
    if (outcome.kind === 'success') {
      const envelope: CliSuccessEnvelope<T> = {
        command,
        ok: true,
        data: outcome.data,
        warnings: outcome.warnings,
      };
      writeJson(envelope);
    } else {
      const envelope: CliErrorEnvelope = {
        command,
        ok: false,
        error: outcome.error,
        warnings: outcome.warnings,
      };
      writeJson(envelope);
    }
    return outcome.kind === 'success' ? EXIT_SUCCESS : outcome.exitCode;
  }

  if (outcome.kind === 'success') {
    writeStdout(outcome.human);
    return EXIT_SUCCESS;
  }
  writeStderr(outcome.human);
  return outcome.exitCode;
}

export function internalFailure(error: unknown, command: string): CommandFailure {
  const detail = error instanceof Error ? error.message : String(error);
  const structured: CliError = {
    code: 'cli.internal',
    message: 'The CLI hit an unexpected internal failure.',
    hint: 'Retry the command. If the failure persists, report it with the command name and the message below.',
    details: { detail },
  };
  return failure(structured, formatError(command, structured));
}
