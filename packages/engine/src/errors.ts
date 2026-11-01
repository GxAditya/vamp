import type { IssueParams, ValidationIssue } from '@gxaditya/vamp-schema';

/**
 * Stable compile-time issue codes.
 *
 * Validation issues keep their `@gxaditya/vamp-schema` codes and are passed through
 * unchanged. These codes only cover failures that belong to the compile step:
 * options, defensive reference checks, compile-time resource guards, and
 * derived values that must remain finite.
 */
export const COMPILE_ISSUE_CODES = Object.freeze([
  'compile.input.invalid',
  'compile.options.invalid',
  'compile.pattern.unresolved',
  'compile.limit.authored_notes',
  'compile.limit.expanded_notes',
  'compile.limit.duration',
  'compile.output.non_finite',
] as const);

export type CompileIssueCode = (typeof COMPILE_ISSUE_CODES)[number];

/** A compile issue uses the same JSON-serializable shape as a validation issue. */
export interface CompileIssue {
  readonly code: CompileIssueCode;
  readonly severity: 'error';
  readonly path: string;
  readonly message: string;
  readonly hint: string;
  readonly params?: IssueParams;
}

/**
 * Shared alias for adapters that render either a schema validation issue or a
 * compile issue through one path. The compiler result keeps the two arrays
 * separate and type-safe.
 */
export type CompileFailureIssue = ValidationIssue | CompileIssue;

export function createCompileIssue(
  code: CompileIssueCode,
  path: string,
  message: string,
  hint: string,
  params?: IssueParams,
): CompileIssue {
  return {
    code,
    severity: 'error',
    path,
    message,
    hint,
    ...(params === undefined ? {} : { params }),
  };
}

function compareStrings(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/**
 * Deterministic ordering for compile issues: JSON Pointer path, then code, then
 * message. This matches the ordering convention of schema validation issues, so
 * a consumer can render either array without a second sorting rule.
 */
export function compareCompileIssues(
  left: CompileFailureIssue,
  right: CompileFailureIssue,
): number {
  return (
    compareStrings(left.path, right.path) ||
    compareStrings(left.code, right.code) ||
    compareStrings(left.message, right.message)
  );
}

export function normalizeCompileIssues(issues: readonly CompileIssue[]): CompileIssue[] {
  return [...issues].sort(compareCompileIssues);
}
