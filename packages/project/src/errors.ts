/**
 * Structured project storage results.
 *
 * Every expected storage, validation, confinement, revision, lock, and I/O
 * failure is returned as a value. Public methods catch unexpected failures and
 * convert them to `project.internal` instead of throwing.
 */

import type { ValidationIssue } from '@gxaditya/vamp-schema';

export const PROJECT_ERROR_CODES = [
  'project.config.invalid',
  'project.root.invalid',
  'project.root.not_found',
  'project.root.not_directory',
  'project.id.invalid',
  'project.not_found',
  'project.exists',
  'project.limit.projects',
  'project.limit.enumeration',
  'project.metadata.missing',
  'project.metadata.too_large',
  'project.metadata.malformed',
  'project.metadata.unsupported',
  'project.metadata.invalid',
  'project.revision.invalid',
  'project.revision.conflict',
  'project.song.missing',
  'project.song.malformed_json',
  'project.song.too_large',
  'project.song.unreadable',
  'project.song.invalid',
  'project.song.unsupported_version',
  'project.edit.track_not_found',
  'project.edit.pattern_not_found',
  'project.edit.duplicate_track',
  'project.edit.duplicate_pattern',
  'project.edit.note_not_found',
  'project.edit.invalid',
  'project.path.invalid',
  'project.path.confined',
  'project.asset.missing',
  'project.asset.not_file',
  'project.asset.too_large',
  'project.asset.unreadable',
  'project.lock.busy',
  'project.lock.invalid',
  'project.lock.failed',
  'project.io.failed',
  'project.io.commit_failed',
  'project.internal',
] as const;

export type ProjectErrorCode = (typeof PROJECT_ERROR_CODES)[number];

export interface ProjectError {
  readonly ok: false;
  readonly code: ProjectErrorCode;
  readonly message: string;
  readonly hint: string;
  /** Present when the failure belongs to a named project. */
  readonly projectId?: string;
  /** Project-relative path or JSON Pointer, depending on the failure. */
  readonly path?: string;
  readonly expectedRevision?: number;
  readonly actualRevision?: number;
  /** Complete schema validation issues for `project.song.invalid` failures. */
  readonly issues?: readonly ValidationIssue[];
  /** Extra machine-readable detail that is safe to show to an agent. */
  readonly detail?: string;
}

export type ProjectResult<T> = { readonly ok: true; readonly value: T } | ProjectError;

export function success<T>(value: T): ProjectResult<T> {
  return { ok: true, value };
}

export function failure(
  code: ProjectErrorCode,
  message: string,
  hint: string,
  extra: {
    readonly projectId?: string;
    readonly path?: string;
    readonly expectedRevision?: number;
    readonly actualRevision?: number;
    readonly issues?: readonly ValidationIssue[];
    readonly detail?: string;
  } = {},
): ProjectError {
  return {
    ok: false,
    code,
    message,
    hint,
    ...(extra.projectId === undefined ? {} : { projectId: extra.projectId }),
    ...(extra.path === undefined ? {} : { path: extra.path }),
    ...(extra.expectedRevision === undefined ? {} : { expectedRevision: extra.expectedRevision }),
    ...(extra.actualRevision === undefined ? {} : { actualRevision: extra.actualRevision }),
    ...(extra.issues === undefined ? {} : { issues: extra.issues }),
    ...(extra.detail === undefined ? {} : { detail: extra.detail }),
  };
}

export function internalError(error: unknown): ProjectError {
  const detail = error instanceof Error ? error.message : String(error);
  return failure(
    'project.internal',
    'Project storage hit an unexpected internal failure.',
    'Retry the operation. If it persists, report the failure with the operation name and project id.',
    { detail },
  );
}
