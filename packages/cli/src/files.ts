/**
 * Bounded, non-interactive song file access for `validate`, `info`, and
 * `render`.
 *
 * The commands inspect a JSON song file supplied on the command line. They do
 * not resolve project-relative asset paths and they do not write anything. The
 * read is bounded to the same 8 MiB song limit used by `@gxaditya/vamp-project`, rejects
 * symbolic links, and validates UTF-8 and JSON syntax. `validate` and `info`
 * also run the shared `@gxaditya/vamp-schema` validator with the engine instrument
 * registry; `render` passes the parsed document to the shared engine operation
 * so schema validation happens once at that boundary.
 */

import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { resolve } from 'node:path';

import { INSTRUMENT_REGISTRY_VALIDATION } from '@gxaditya/vamp-engine';
import {
  validateSong,
  type IssueCode,
  type ValidationIssue,
  type ValidationSuccess,
} from '@gxaditya/vamp-schema';
import { DEFAULT_PROJECT_LIMITS } from '@gxaditya/vamp-project';

import type { CliError, StructuredValue } from './output.js';

/** Standalone song files use the same bound as a project's song.json. */
export const MAX_SONG_FILE_BYTES = DEFAULT_PROJECT_LIMITS.maxSongBytes;

export interface ReadSongFile {
  /** The path exactly as supplied by the caller. */
  readonly file: string;
  /** The resolved absolute path that was read. */
  readonly resolvedPath: string;
  /** The parsed JSON document, before schema validation. */
  readonly document: unknown;
}

export type ReadSongDocumentResult =
  | { readonly ok: true; readonly value: ReadSongFile }
  | {
      readonly ok: false;
      readonly error: CliError;
      readonly warnings: readonly ValidationIssue[];
    };

export interface LoadedSong {
  /** The path exactly as supplied by the caller. */
  readonly file: string;
  /** The resolved absolute path that was read. */
  readonly resolvedPath: string;
  readonly validation: ValidationSuccess;
}

export type LoadSongResult =
  | { readonly ok: true; readonly value: LoadedSong }
  | {
      readonly ok: false;
      readonly error: CliError;
      readonly warnings: readonly ValidationIssue[];
    };

type BoundedRead =
  | { readonly ok: true; readonly data: Buffer }
  | {
      readonly ok: false;
      readonly kind: 'missing' | 'not_file' | 'symlink' | 'too_large' | 'unreadable';
      readonly bytes?: number;
      readonly detail?: string;
    };

function isFileSystemError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function detailOf(detail: string | undefined): { readonly detail?: StructuredValue } {
  return detail === undefined ? {} : { detail };
}

async function readBoundedRegularFile(
  absolutePath: string,
  maxBytes: number,
): Promise<BoundedRead> {
  let info;
  try {
    info = await lstat(absolutePath);
  } catch (error) {
    if (isFileSystemError(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      return { ok: false, kind: 'missing' };
    }
    return {
      ok: false,
      kind: 'unreadable',
      ...(isFileSystemError(error) && typeof error.code === 'string' ? { detail: error.code } : {}),
    };
  }
  if (info.isSymbolicLink()) {
    return { ok: false, kind: 'symlink' };
  }
  if (!info.isFile()) {
    return { ok: false, kind: 'not_file' };
  }
  if (info.size > maxBytes) {
    return { ok: false, kind: 'too_large', bytes: info.size };
  }

  let handle;
  try {
    const noFollow = process.platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0);
    handle = await open(absolutePath, constants.O_RDONLY | noFollow);
    const handleInfo = await handle.stat();
    if (!handleInfo.isFile()) {
      return { ok: false, kind: 'not_file' };
    }
    if (handleInfo.size > maxBytes) {
      return { ok: false, kind: 'too_large', bytes: handleInfo.size };
    }

    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const remaining = maxBytes + 1 - total;
      if (remaining <= 0) {
        return { ok: false, kind: 'too_large', bytes: total };
      }
      const chunk = Buffer.alloc(Math.min(64 * 1024, remaining));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
      if (bytesRead === 0) {
        break;
      }
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > maxBytes) {
      return { ok: false, kind: 'too_large', bytes: total };
    }
    return { ok: true, data: Buffer.concat(chunks, total) };
  } catch (error) {
    if (isFileSystemError(error) && error.code === 'ELOOP') {
      return { ok: false, kind: 'symlink' };
    }
    if (isFileSystemError(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      return { ok: false, kind: 'missing' };
    }
    return {
      ok: false,
      kind: 'unreadable',
      ...(isFileSystemError(error) && typeof error.code === 'string' ? { detail: error.code } : {}),
    };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function fileError(
  file: string,
  resolvedPath: string,
  code: string,
  message: string,
  hint: string,
  details: Readonly<Record<string, StructuredValue>> = {},
): CliError {
  return {
    code,
    message,
    hint,
    path: file,
    details: { ...details, resolvedPath },
  };
}

function unsupportedVersionCode(issues: readonly ValidationIssue[]): boolean {
  return issues.some((issue) => {
    const code: IssueCode = issue.code;
    return code === 'schema.version.missing' || code === 'schema.version.unsupported';
  });
}

/**
 * Read and parse one standalone JSON song file without validating it.
 *
 * The read is bounded, rejects final symbolic links, and validates UTF-8 and
 * JSON syntax. Callers that need schema validation use `loadSongFile`, while
 * render passes the parsed document to the shared engine pipeline so
 * validation happens exactly once at the engine boundary.
 */
export async function readSongDocument(input: string): Promise<ReadSongDocumentResult> {
  if (input.length === 0 || input.includes('\0')) {
    return {
      ok: false,
      error: {
        code: 'cli.file.invalid_path',
        message: 'The song file path is empty or contains a NUL byte.',
        hint: 'Pass a regular JSON file path.',
        path: input,
      },
      warnings: [],
    };
  }

  const resolvedPath = resolve(process.cwd(), input);
  const read = await readBoundedRegularFile(resolvedPath, MAX_SONG_FILE_BYTES);

  if (!read.ok) {
    switch (read.kind) {
      case 'missing':
        return {
          ok: false,
          error: fileError(
            input,
            resolvedPath,
            'cli.file.missing',
            `Song file "${input}" does not exist.`,
            'Check the path. The file is resolved from the current working directory.',
          ),
          warnings: [],
        };
      case 'not_file':
        return {
          ok: false,
          error: fileError(
            input,
            resolvedPath,
            'cli.file.not_file',
            `Song file "${input}" is not a regular file.`,
            'Pass a JSON file, not a directory or device.',
          ),
          warnings: [],
        };
      case 'symlink':
        return {
          ok: false,
          error: fileError(
            input,
            resolvedPath,
            'cli.file.symlink',
            `Song file "${input}" is a symbolic link.`,
            'Pass the real file path. Validation and inspection do not follow symlinks.',
          ),
          warnings: [],
        };
      case 'too_large':
        return {
          ok: false,
          error: fileError(
            input,
            resolvedPath,
            'cli.file.too_large',
            `Song file "${input}" exceeds the ${MAX_SONG_FILE_BYTES} byte limit.`,
            'Reduce the song or split the work. Oversized files are rejected before parsing.',
            { limitBytes: MAX_SONG_FILE_BYTES, ...detailOf(String(read.bytes ?? 'unknown')) },
          ),
          warnings: [],
        };
      case 'unreadable':
      default:
        return {
          ok: false,
          error: fileError(
            input,
            resolvedPath,
            'cli.file.unreadable',
            `Song file "${input}" could not be read.`,
            'Check file permissions and that the file is accessible.',
            detailOf(read.detail),
          ),
          warnings: [],
        };
    }
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(read.data);
  } catch {
    return {
      ok: false,
      error: fileError(
        input,
        resolvedPath,
        'cli.file.invalid_utf8',
        `Song file "${input}" is not valid UTF-8.`,
        'Save the song as UTF-8 JSON.',
      ),
      warnings: [],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    return {
      ok: false,
      error: fileError(
        input,
        resolvedPath,
        'cli.file.malformed_json',
        `Song file "${input}" is not valid JSON.`,
        'Fix the JSON syntax and retry. The file was not modified.',
        detailOf(error instanceof Error ? error.message : undefined),
      ),
      warnings: [],
    };
  }

  return {
    ok: true,
    value: { file: input, resolvedPath, document: parsed },
  };
}

/**
 * Read, parse, and validate one standalone JSON song file.
 *
 * Expected failures are structured values. The file is never rewritten and no
 * defaults are applied to the parsed document.
 */
export async function loadSongFile(input: string): Promise<LoadSongResult> {
  const read = await readSongDocument(input);
  if (!read.ok) {
    return read;
  }

  const { file, resolvedPath, document } = read.value;
  const validation = validateSong(document, INSTRUMENT_REGISTRY_VALIDATION);
  if (!validation.ok) {
    const versionProblem = unsupportedVersionCode(validation.errors);
    const error: CliError = {
      code: versionProblem ? 'cli.validation.unsupported_version' : 'cli.validation.invalid',
      message: versionProblem
        ? `Song file "${file}" uses a missing or unsupported schemaVersion.`
        : `Song file "${file}" failed SongSchemaV1 validation.`,
      hint: versionProblem
        ? 'Use schemaVersion "1.0.0" or migrate the file explicitly. Vamp never rewrites a saved file automatically.'
        : 'Fix every reported issue. Paths are JSON Pointers into the song document.',
      path: file,
      issues: validation.errors,
      details: { resolvedPath },
    };
    return { ok: false, error, warnings: validation.warnings };
  }

  return {
    ok: true,
    value: { file, resolvedPath, validation },
  };
}

export interface SongCounts {
  readonly tracks: number;
  readonly midiTracks: number;
  readonly drumTracks: number;
  readonly patterns: number;
  readonly placements: number;
  readonly freeNotes: number;
  readonly patternNotes: number;
  readonly authoredNotes: number;
}

/** Counts derived from a validated song without expanding pattern placements. */
export function countSong(validation: ValidationSuccess): SongCounts {
  const song = validation.song;
  const tracks = song.tracks.length;
  const midiTracks = song.tracks.filter((track) => track.kind === 'midi').length;
  const drumTracks = song.tracks.filter((track) => track.kind === 'drums').length;
  const patterns = song.patterns?.length ?? 0;
  let placements = 0;
  let freeNotes = 0;
  for (const track of song.tracks) {
    placements += track.placements?.length ?? 0;
    freeNotes += track.notes?.length ?? 0;
  }
  const patternNotes = (song.patterns ?? []).reduce(
    (total, pattern) => total + pattern.notes.length,
    0,
  );
  return {
    tracks,
    midiTracks,
    drumTracks,
    patterns,
    placements,
    freeNotes,
    patternNotes,
    authoredNotes: freeNotes + patternNotes,
  };
}
