/**
 * Lexical validation for project identifiers and enclosed paths.
 *
 * These checks are intentionally conservative and platform-neutral. They reject
 * Windows device names and separators even on POSIX, so a project cannot become
 * unsafe when moved to another supported platform.
 */

import { isAbsolute, sep } from 'node:path';

import { failure, success, type ProjectResult } from './errors.js';
import { MAX_PROJECT_ID_LENGTH, MAX_PROJECT_PATH_LENGTH } from './limits.js';

const PROJECT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const WINDOWS_INVALID_CHARS = /[<>:"|?*\\]/;
const WINDOWS_RESERVED = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'CLOCK$',
  'CONIN$',
  'CONOUT$',
  ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`),
  'COM¹',
  'COM²',
  'COM³',
  'LPT¹',
  'LPT²',
  'LPT³',
]);

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/** True when a single filename segment is a Windows reserved device name. */
export function isWindowsReservedName(segment: string): boolean {
  const stem = segment.split('.', 1)[0] ?? '';
  const normalized = stem.replace(/[ .]+$/u, '').toUpperCase();
  return WINDOWS_RESERVED.has(normalized);
}

/** True when a single segment is safe on all supported platforms. */
export function isSafePathSegment(segment: string): boolean {
  if (
    typeof segment !== 'string' ||
    segment.length === 0 ||
    segment === '.' ||
    segment === '..' ||
    segment.length > 255 ||
    Buffer.byteLength(segment, 'utf8') > 255 ||
    hasControlCharacters(segment) ||
    WINDOWS_INVALID_CHARS.test(segment) ||
    segment.endsWith('.') ||
    segment.endsWith(' ') ||
    isWindowsReservedName(segment)
  ) {
    return false;
  }
  return true;
}

/** True for a lowercase, portable project identifier. */
export function isValidProjectId(projectId: unknown): projectId is string {
  return (
    typeof projectId === 'string' &&
    projectId.length > 0 &&
    projectId.length <= MAX_PROJECT_ID_LENGTH &&
    PROJECT_ID_PATTERN.test(projectId) &&
    !isWindowsReservedName(projectId)
  );
}

export function validateProjectId(projectId: unknown): ProjectResult<string> {
  if (isValidProjectId(projectId)) {
    return success(projectId);
  }
  return failure(
    'project.id.invalid',
    `Project id ${JSON.stringify(projectId)} is not a valid Vamp project id.`,
    `Use 1 to ${MAX_PROJECT_ID_LENGTH} lowercase ASCII letters, digits, dots, hyphens, or underscores. Start and end with a letter or digit. Do not use Windows device names such as CON or NUL.`,
    typeof projectId === 'string' ? { path: projectId } : {},
  );
}

/** True when `candidate` equals or is below `root` after lexical resolution. */
export function isInsidePath(root: string, candidate: string): boolean {
  const comparableRoot = process.platform === 'win32' ? root.toLowerCase() : root;
  const comparableCandidate = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
  if (comparableCandidate === comparableRoot) {
    return true;
  }
  const prefix = comparableRoot.endsWith(sep) ? comparableRoot : `${comparableRoot}${sep}`;
  return comparableCandidate.startsWith(prefix);
}

export interface ValidatedRelativePath {
  /** Original forward-slash path, preserved for caller-facing results. */
  readonly relativePath: string;
  /** Segments after lexical validation, including the required prefix. */
  readonly segments: readonly string[];
}

export interface RelativePathOptions {
  /** Required first path segment, for example "assets" or "renders". */
  readonly prefix: string;
  /** Whether the prefix alone is allowed. */
  readonly allowBarePrefix: boolean;
}

/**
 * Validate a project-relative path that must stay below a named directory.
 * Absolute paths, drive prefixes, UNC prefixes, backslashes, NUL bytes, empty
 * segments, dot segments, traversal, control characters, and Windows device
 * names are rejected lexically before any filesystem access.
 */
export function validateProjectRelativePath(
  relativePath: unknown,
  options: RelativePathOptions,
): ProjectResult<ValidatedRelativePath> {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    return failure(
      'project.path.invalid',
      'A project-relative path must be a non-empty string.',
      `Use a forward-slash path beginning with "${options.prefix}/".`,
    );
  }
  if (relativePath.length > MAX_PROJECT_PATH_LENGTH) {
    return failure(
      'project.path.invalid',
      `The path is ${relativePath.length} characters; the limit is ${MAX_PROJECT_PATH_LENGTH}.`,
      'Use a shorter path inside the project.',
      { path: relativePath },
    );
  }
  if (hasControlCharacters(relativePath)) {
    return failure(
      'project.path.confined',
      'The path contains a NUL or control character.',
      'Use plain printable path characters.',
      { path: relativePath },
    );
  }
  if (
    relativePath.includes('\\') ||
    isAbsolute(relativePath) ||
    /^[a-zA-Z]:/.test(relativePath) ||
    relativePath.startsWith('/')
  ) {
    return failure(
      'project.path.confined',
      `Path "${relativePath}" is absolute or uses a non-portable separator.`,
      `Use a relative forward-slash path beginning with "${options.prefix}/".`,
      { path: relativePath },
    );
  }

  const segments = relativePath.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    return failure(
      'project.path.confined',
      `Path "${relativePath}" contains an empty, dot, or traversal segment.`,
      'Use plain path segments with no "." or "..".',
      { path: relativePath },
    );
  }
  if (segments[0] !== options.prefix) {
    return failure(
      'project.path.confined',
      `Path "${relativePath}" is outside the required "${options.prefix}" directory.`,
      `Use a path beginning with "${options.prefix}/".`,
      { path: relativePath },
    );
  }
  if (segments.length === 1 && !options.allowBarePrefix) {
    return failure(
      'project.path.invalid',
      `Path "${relativePath}" does not name a file below "${options.prefix}".`,
      `Use a path beginning with "${options.prefix}/".`,
      { path: relativePath },
    );
  }
  if (!segments.every(isSafePathSegment)) {
    return failure(
      'project.path.confined',
      `Path "${relativePath}" contains a dangerous filename segment.`,
      'Remove control characters, Windows reserved names, trailing dots or spaces, and characters such as :, *, ?, <, >, |, or ".',
      { path: relativePath },
    );
  }

  return success({ relativePath, segments });
}
