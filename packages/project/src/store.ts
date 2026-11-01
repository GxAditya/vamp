/**
 * Filesystem-first project storage.
 *
 * A configured projects root contains one directory per project. Each project
 * holds `song.json`, `assets/`, `renders/`, and a private `.vamp-project.json`
 * metadata file. All song mutations validate a complete candidate song, write
 * through same-directory temporary files, and publish the revision metadata
 * last. Persisted mutations require an expected revision and serialize writers
 * with a bounded lock file.
 */

import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, realpath, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import {
  validateSong,
  type Instrument,
  type Note,
  type Pattern,
  type SongSchemaV1,
  type Track,
  type ValidateSongOptions,
  type ValidationIssue,
  type ValidationResult,
} from '@gxaditya/vamp-schema';

import { stageAtomicWrite, writeFileAtomic } from './atomic.js';
import {
  failure,
  internalError,
  success,
  type ProjectError,
  type ProjectResult,
} from './errors.js';
import {
  DEFAULT_PROJECT_LIMITS,
  MAX_PROJECT_ROOT_LENGTH,
  PROJECT_LAYOUT,
  type ProjectLimits,
  type ProjectLimitsInput,
} from './limits.js';
import { acquireProjectLock } from './lock.js';
import {
  isInsidePath,
  isValidProjectId,
  validateProjectId,
  validateProjectRelativePath,
} from './paths.js';

export interface ProjectSummary {
  readonly projectId: string;
  readonly revision: number;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProjectSnapshot extends ProjectSummary {
  /** The validated authored song. No storage-only fields are added. */
  readonly song: SongSchemaV1;
  /** Schema warnings for the current song. */
  readonly warnings: readonly ValidationIssue[];
}

export interface ProjectLocation {
  readonly projectId: string;
  readonly rootDirectory: string;
  readonly directory: string;
  readonly songPath: string;
  readonly assetsDirectory: string;
  readonly rendersDirectory: string;
}

export interface ResolvedProjectAsset {
  /** Absolute path after realpath resolution. */
  readonly absolutePath: string;
  /** The caller-provided project-relative path, using forward slashes. */
  readonly relativePath: string;
  readonly bytes: number;
}

export interface ReadProjectAsset extends ResolvedProjectAsset {
  readonly data: Uint8Array;
}

export interface ResolvedRenderDirectory {
  /** Absolute canonical destination. It may not exist yet. */
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly exists: boolean;
}

export interface ProjectStoreOptions {
  /** Absolute configured projects root. The directory must already exist. */
  readonly root: string;
  /** Optional overrides for storage and lock bounds. */
  readonly limits?: ProjectLimitsInput;
  /** Schema validation options, for example a curated builtin allowlist. */
  readonly validation?: ValidateSongOptions;
}

export interface CreateProjectOptions {
  readonly projectId: string;
  readonly song: unknown;
}

export interface RevisionedProjectOptions {
  readonly expectedRevision: number;
}

export interface UpdateSongOptions extends RevisionedProjectOptions {
  /** A complete replacement song. It is validated before any write. */
  readonly song: unknown;
}

export interface AddTrackOptions extends RevisionedProjectOptions {
  readonly track: Track;
  /** Insertion index. Defaults to the end. */
  readonly index?: number;
}

export interface TrackChanges {
  readonly name?: string;
  readonly channel?: number;
  readonly volume?: number;
  readonly pan?: number;
  readonly mute?: boolean;
  readonly solo?: boolean;
}

export interface UpdateTrackOptions extends RevisionedProjectOptions {
  readonly trackId: string;
  /** A patch over the listed scalar fields. Unknown fields are rejected. */
  readonly changes: TrackChanges;
}

export interface RemoveTrackOptions extends RevisionedProjectOptions {
  readonly trackId: string;
}

export interface AddNotesOptions extends RevisionedProjectOptions {
  readonly trackId: string;
  /** Free notes appended to the track. Pattern notes are changed with setPattern. */
  readonly notes: readonly Note[];
  readonly index?: number;
}

export interface UpdateNoteOptions extends RevisionedProjectOptions {
  readonly trackId: string;
  /** Zero-based position in the current revision of track.notes. */
  readonly noteIndex: number;
  readonly note: Note;
}

export interface RemoveNoteOptions extends RevisionedProjectOptions {
  readonly trackId: string;
  /** Zero-based position in the current revision of track.notes. */
  readonly noteIndex: number;
}

export interface SetPatternOptions extends RevisionedProjectOptions {
  /** Replaces the pattern with the same id, or appends a new pattern. */
  readonly pattern: Pattern;
}

export interface RemovePatternOptions extends RevisionedProjectOptions {
  readonly patternId: string;
}

export interface SetInstrumentOptions extends RevisionedProjectOptions {
  readonly trackId: string;
  readonly instrument: Instrument;
}

export interface ReadAssetOptions {
  /** Optional byte ceiling. It can tighten but not exceed the store limit. */
  readonly maxBytes?: number;
}

interface ProjectMetadata {
  readonly projectId: string;
  readonly revision: number;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface LocatedProject {
  readonly projectId: string;
  readonly rootReal: string;
  readonly directory: string;
}

interface BoundedReadFailure {
  readonly ok: false;
  readonly kind: 'missing' | 'not_file' | 'symlink' | 'too_large' | 'unreadable';
  readonly bytes?: number;
  readonly detail?: string;
}

type BoundedRead = { readonly ok: true; readonly data: Buffer } | BoundedReadFailure;

interface LoadedSong {
  readonly validation: Extract<ValidationResult, { ok: true }>;
  readonly raw: Buffer;
}

type SongMutation = (song: SongSchemaV1) => ProjectResult<SongSchemaV1>;

const TRACK_CHANGE_KEYS = new Set(['name', 'channel', 'volume', 'pan', 'mute', 'solo']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFileSystemError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function fileSystemErrorCode(error: unknown): string | undefined {
  if (isFileSystemError(error) && typeof error.code === 'string') {
    return error.code;
  }
  return undefined;
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && !Number.isNaN(Date.parse(value));
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isValidRevision(value: unknown): value is number {
  return isPositiveSafeInteger(value);
}

function sortByProjectId(left: ProjectSummary, right: ProjectSummary): number {
  if (left.projectId < right.projectId) {
    return -1;
  }
  if (left.projectId > right.projectId) {
    return 1;
  }
  return 0;
}

function cloneJsonValue<T>(value: T, label: string): ProjectResult<T> {
  try {
    return success(structuredClone(value));
  } catch {
    return failure(
      'project.edit.invalid',
      `${label} is not a JSON-serializable value.`,
      'Pass plain JSON data with no functions, class instances, or cycles.',
    );
  }
}

function withProjectId(error: ProjectError, projectId: string): ProjectError {
  return error.projectId === undefined ? { ...error, projectId } : error;
}

function findTrackIndex(song: SongSchemaV1, trackId: string): number {
  return song.tracks.findIndex((track) => track.id === trackId);
}

function findPatternIndex(song: SongSchemaV1, patternId: string): number {
  return (song.patterns ?? []).findIndex((pattern) => pattern.id === patternId);
}

async function readBoundedFile(path: string, maxBytes: number): Promise<BoundedRead> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (isFileSystemError(error) && error.code === 'ENOENT') {
      return { ok: false, kind: 'missing' };
    }
    const lstatCode = fileSystemErrorCode(error);
    return {
      ok: false,
      kind: 'unreadable',
      ...(lstatCode === undefined ? {} : { detail: lstatCode }),
    };
  }
  if (info.isSymbolicLink()) {
    return { ok: false, kind: 'symlink' };
  }
  if (!info.isFile()) {
    return { ok: false, kind: 'not_file' };
  }

  let handle;
  try {
    const noFollow = process.platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0);
    handle = await open(path, constants.O_RDONLY | noFollow);
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
    if (isFileSystemError(error) && error.code === 'ENOENT') {
      return { ok: false, kind: 'missing' };
    }
    const readCode = fileSystemErrorCode(error);
    return {
      ok: false,
      kind: 'unreadable',
      ...(readCode === undefined ? {} : { detail: readCode }),
    };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function describeDetail(detail: string | undefined): { readonly detail?: string } {
  return detail === undefined ? {} : { detail };
}

/**
 * Normalize and validate limits. Invalid configuration becomes a stored error
 * rather than a constructor throw.
 */
function resolveLimits(input: ProjectLimitsInput | undefined): {
  readonly limits: ProjectLimits;
  readonly error: ProjectError | null;
} {
  const limits: ProjectLimits = {
    maxSongBytes: input?.maxSongBytes ?? DEFAULT_PROJECT_LIMITS.maxSongBytes,
    maxMetadataBytes: input?.maxMetadataBytes ?? DEFAULT_PROJECT_LIMITS.maxMetadataBytes,
    maxAssetBytes: input?.maxAssetBytes ?? DEFAULT_PROJECT_LIMITS.maxAssetBytes,
    maxProjects: input?.maxProjects ?? DEFAULT_PROJECT_LIMITS.maxProjects,
    maxDirectoryEntries: input?.maxDirectoryEntries ?? DEFAULT_PROJECT_LIMITS.maxDirectoryEntries,
    lockTimeoutMs: input?.lockTimeoutMs ?? DEFAULT_PROJECT_LIMITS.lockTimeoutMs,
    staleLockMs: input?.staleLockMs ?? DEFAULT_PROJECT_LIMITS.staleLockMs,
  };
  const positive = [
    'maxSongBytes',
    'maxMetadataBytes',
    'maxAssetBytes',
    'maxDirectoryEntries',
    'staleLockMs',
  ] as const;
  for (const key of positive) {
    if (!isPositiveSafeInteger(limits[key])) {
      return {
        limits,
        error: failure(
          'project.config.invalid',
          `Project limit "${key}" must be a positive safe integer.`,
          'Use a positive byte, entry, or millisecond bound.',
        ),
      };
    }
  }
  if (!Number.isSafeInteger(limits.maxProjects) || limits.maxProjects < 0) {
    return {
      limits,
      error: failure(
        'project.config.invalid',
        'Project limit "maxProjects" must be a non-negative safe integer.',
        'Use 0 to reject all projects, or a larger project count.',
      ),
    };
  }
  if (!Number.isSafeInteger(limits.lockTimeoutMs) || limits.lockTimeoutMs < 0) {
    return {
      limits,
      error: failure(
        'project.config.invalid',
        'Project lockTimeoutMs must be a non-negative safe integer.',
        'Use a bounded wait such as 2000 milliseconds.',
      ),
    };
  }
  if (limits.lockTimeoutMs > 60_000) {
    return {
      limits,
      error: failure(
        'project.config.invalid',
        'Project lockTimeoutMs must not exceed 60,000 milliseconds.',
        'Use a shorter bounded wait so callers cannot hang indefinitely.',
      ),
    };
  }
  return { limits: Object.freeze(limits), error: null };
}

export class ProjectStore {
  readonly root: string;
  readonly limits: ProjectLimits;

  private readonly validationOptions: ValidateSongOptions;
  private readonly configError: ProjectError | null;

  constructor(options: ProjectStoreOptions) {
    this.root = typeof options?.root === 'string' ? options.root : '';
    const resolvedLimits = resolveLimits(options?.limits);
    this.limits = resolvedLimits.limits;
    this.validationOptions = options?.validation ?? {};
    this.configError =
      resolvedLimits.error ??
      (typeof this.root !== 'string' ||
      this.root.length === 0 ||
      this.root.length > MAX_PROJECT_ROOT_LENGTH ||
      this.root.includes('\0') ||
      !isAbsolute(this.root)
        ? failure(
            'project.root.invalid',
            'The configured projects root must be an absolute path without NUL bytes.',
            'Configure an absolute, existing directory so project ids resolve to the same place regardless of the process working directory.',
            { path: this.root },
          )
        : null);
  }

  /** Create a project directory and its initial validated song. */
  async create(options: CreateProjectOptions): Promise<ProjectResult<ProjectSnapshot>> {
    return this.run(() => this.createInternal(options));
  }

  /** Read one project's validated song and private revision metadata. */
  async get(projectId: string): Promise<ProjectResult<ProjectSnapshot>> {
    return this.run(() => this.getInternal(projectId));
  }

  /** List complete projects, sorted by project id. */
  async list(): Promise<ProjectResult<readonly ProjectSummary[]>> {
    return this.run(() => this.listInternal());
  }

  /** Resolve the confined absolute locations for a project. */
  async getLocation(projectId: string): Promise<ProjectResult<ProjectLocation>> {
    return this.run(async () => {
      const located = await this.locateProject(projectId);
      if (!located.ok) {
        return located;
      }
      const assets = await this.resolveEnclosedDirectory(
        located.value.directory,
        PROJECT_LAYOUT.assetsDirectory,
        projectId,
      );
      if (!assets.ok) {
        return assets;
      }
      const renders = await this.resolveEnclosedDirectory(
        located.value.directory,
        PROJECT_LAYOUT.rendersDirectory,
        projectId,
      );
      if (!renders.ok) {
        return renders;
      }

      const lexicalSongPath = join(located.value.directory, PROJECT_LAYOUT.songFile);
      let songInfo;
      try {
        songInfo = await lstat(lexicalSongPath);
      } catch (error) {
        return failure(
          'project.song.missing',
          `Project "${projectId}" has no ${PROJECT_LAYOUT.songFile}.`,
          'Restore song.json or create a new project.',
          {
            projectId,
            path: PROJECT_LAYOUT.songFile,
            ...describeDetail(fileSystemErrorCode(error)),
          },
        );
      }
      if (songInfo.isSymbolicLink()) {
        return failure(
          'project.path.confined',
          'song.json is a symbolic link.',
          'Keep the canonical song file as a regular file inside the project directory.',
          { projectId, path: PROJECT_LAYOUT.songFile },
        );
      }
      if (!songInfo.isFile()) {
        return failure(
          'project.song.unreadable',
          'song.json is not a regular file.',
          'Restore song.json as a regular file inside the project directory.',
          { projectId, path: PROJECT_LAYOUT.songFile },
        );
      }
      const songPath = await realpath(lexicalSongPath).catch(() => null);
      if (!songPath || !isInsidePath(located.value.directory, songPath)) {
        return failure(
          'project.path.confined',
          'song.json resolves outside the project directory.',
          'Keep the canonical song file inside the project directory.',
          { projectId, path: PROJECT_LAYOUT.songFile },
        );
      }

      return success({
        projectId,
        rootDirectory: located.value.rootReal,
        directory: located.value.directory,
        songPath,
        assetsDirectory: assets.value,
        rendersDirectory: renders.value,
      });
    });
  }

  /** Replace the complete song with a validated new revision. */
  async updateSong(
    projectId: string,
    options: UpdateSongOptions,
  ): Promise<ProjectResult<ProjectSnapshot>> {
    return this.run(() =>
      this.mutateSong(projectId, options.expectedRevision, () => {
        const validated = validateSong(options.song, this.validationOptions);
        if (!validated.ok) {
          return withProjectId(this.songValidationFailure(validated), projectId);
        }
        return success(validated.song);
      }),
    );
  }

  /** Append or insert a complete track. Its id must be unique. */
  async addTrack(
    projectId: string,
    options: AddTrackOptions,
  ): Promise<ProjectResult<ProjectSnapshot>> {
    return this.run(() =>
      this.mutateSong(projectId, options.expectedRevision, (song) => {
        if (!isRecord(options.track) || typeof options.track.id !== 'string') {
          return failure(
            'project.edit.invalid',
            'A track must be an object with a string id.',
            'Pass a complete SongSchemaV1 track object.',
          );
        }
        if (findTrackIndex(song, options.track.id) >= 0) {
          return failure(
            'project.edit.duplicate_track',
            `Track id "${options.track.id}" already exists.`,
            'Choose a new track id or edit the existing track.',
            { path: `/tracks`, detail: options.track.id },
          );
        }
        const index = options.index ?? song.tracks.length;
        if (!Number.isInteger(index) || index < 0 || index > song.tracks.length) {
          return failure(
            'project.edit.invalid',
            `Track insertion index ${String(index)} is outside 0 through ${song.tracks.length}.`,
            'Use a valid zero-based insertion index or omit it to append.',
            { path: '/tracks' },
          );
        }
        const cloned = cloneJsonValue(options.track, 'The track');
        if (!cloned.ok) {
          return cloned;
        }
        song.tracks.splice(index, 0, cloned.value);
        return success(song);
      }),
    );
  }

  /** Patch the scalar mix and naming fields of one track. */
  async updateTrack(
    projectId: string,
    options: UpdateTrackOptions,
  ): Promise<ProjectResult<ProjectSnapshot>> {
    return this.run(() =>
      this.mutateSong(projectId, options.expectedRevision, (song) => {
        const index = findTrackIndex(song, options.trackId);
        if (index < 0) {
          return this.trackNotFound(options.trackId);
        }
        if (
          typeof options.changes !== 'object' ||
          options.changes === null ||
          Array.isArray(options.changes)
        ) {
          return failure(
            'project.edit.invalid',
            'Track changes must be an object.',
            'Provide one or more of name, channel, volume, pan, mute, or solo.',
          );
        }
        const changes = options.changes;
        const keys = Object.keys(changes);
        if (keys.length === 0 || keys.some((key) => !TRACK_CHANGE_KEYS.has(key))) {
          return failure(
            'project.edit.invalid',
            'Track changes contain no supported fields or an unknown field.',
            'Use only name, channel, volume, pan, mute, or solo. Use setInstrument for instruments.',
            { path: `/tracks/${index}` },
          );
        }
        const track = song.tracks[index];
        if (!track) {
          return this.trackNotFound(options.trackId);
        }
        let applied = false;
        if (changes.name !== undefined) {
          track.name = changes.name;
          applied = true;
        }
        if (changes.channel !== undefined) {
          track.channel = changes.channel;
          applied = true;
        }
        if (changes.volume !== undefined) {
          track.volume = changes.volume;
          applied = true;
        }
        if (changes.pan !== undefined) {
          track.pan = changes.pan;
          applied = true;
        }
        if (changes.mute !== undefined) {
          track.mute = changes.mute;
          applied = true;
        }
        if (changes.solo !== undefined) {
          track.solo = changes.solo;
          applied = true;
        }
        if (!applied) {
          return failure(
            'project.edit.invalid',
            'Track changes did not define any value to apply.',
            'Provide at least one supported field with a defined value.',
            { path: `/tracks/${index}` },
          );
        }
        return success(song);
      }),
    );
  }

  /** Remove one track. Placements in the song are validated after the edit. */
  async removeTrack(
    projectId: string,
    options: RemoveTrackOptions,
  ): Promise<ProjectResult<ProjectSnapshot>> {
    return this.run(() =>
      this.mutateSong(projectId, options.expectedRevision, (song) => {
        const index = findTrackIndex(song, options.trackId);
        if (index < 0) {
          return this.trackNotFound(options.trackId);
        }
        song.tracks.splice(index, 1);
        return success(song);
      }),
    );
  }

  /**
   * Append or insert free notes on a track. Notes have no schema ids, so their
   * identity is `(trackId, noteIndex)` at a specific revision.
   */
  async addNotes(
    projectId: string,
    options: AddNotesOptions,
  ): Promise<ProjectResult<ProjectSnapshot>> {
    return this.run(() =>
      this.mutateSong(projectId, options.expectedRevision, (song) => {
        const trackIndex = findTrackIndex(song, options.trackId);
        if (trackIndex < 0) {
          return this.trackNotFound(options.trackId);
        }
        if (!Array.isArray(options.notes) || options.notes.length === 0) {
          return failure(
            'project.edit.invalid',
            'addNotes requires a non-empty array of notes.',
            'Pass at least one { pitch, start, duration, velocity? } object.',
          );
        }
        const track = song.tracks[trackIndex];
        if (!track) {
          return this.trackNotFound(options.trackId);
        }
        const notes = track.notes ?? [];
        const index = options.index ?? notes.length;
        if (!Number.isInteger(index) || index < 0 || index > notes.length) {
          return failure(
            'project.edit.invalid',
            `Note insertion index ${String(index)} is outside 0 through ${notes.length}.`,
            'Use a valid zero-based insertion index or omit it to append.',
            { path: `/tracks/${trackIndex}/notes` },
          );
        }
        const cloned = cloneJsonValue(options.notes, 'The notes');
        if (!cloned.ok) {
          return cloned;
        }
        notes.splice(index, 0, ...cloned.value);
        track.notes = notes;
        return success(song);
      }),
    );
  }

  /** Replace one free note by its revision-stable positional index. */
  async updateNote(
    projectId: string,
    options: UpdateNoteOptions,
  ): Promise<ProjectResult<ProjectSnapshot>> {
    return this.run(() =>
      this.mutateSong(projectId, options.expectedRevision, (song) => {
        const trackIndex = findTrackIndex(song, options.trackId);
        if (trackIndex < 0) {
          return this.trackNotFound(options.trackId);
        }
        const track = song.tracks[trackIndex];
        const noteIndex = options.noteIndex;
        if (
          !track ||
          !Array.isArray(track.notes) ||
          !Number.isInteger(noteIndex) ||
          noteIndex < 0 ||
          noteIndex >= track.notes.length
        ) {
          return this.noteNotFound(options.trackId, noteIndex);
        }
        const cloned = cloneJsonValue(options.note, 'The note');
        if (!cloned.ok) {
          return cloned;
        }
        track.notes[noteIndex] = cloned.value;
        return success(song);
      }),
    );
  }

  /** Remove one free note by its revision-stable positional index. */
  async removeNote(
    projectId: string,
    options: RemoveNoteOptions,
  ): Promise<ProjectResult<ProjectSnapshot>> {
    return this.run(() =>
      this.mutateSong(projectId, options.expectedRevision, (song) => {
        const trackIndex = findTrackIndex(song, options.trackId);
        if (trackIndex < 0) {
          return this.trackNotFound(options.trackId);
        }
        const track = song.tracks[trackIndex];
        const noteIndex = options.noteIndex;
        if (
          !track ||
          !Array.isArray(track.notes) ||
          !Number.isInteger(noteIndex) ||
          noteIndex < 0 ||
          noteIndex >= track.notes.length
        ) {
          return this.noteNotFound(options.trackId, noteIndex);
        }
        track.notes.splice(noteIndex, 1);
        if (track.notes.length === 0) {
          delete track.notes;
        }
        return success(song);
      }),
    );
  }

  /** Replace a pattern by id, or append a new pattern. The id never changes. */
  async setPattern(
    projectId: string,
    options: SetPatternOptions,
  ): Promise<ProjectResult<ProjectSnapshot>> {
    return this.run(() =>
      this.mutateSong(projectId, options.expectedRevision, (song) => {
        if (!isRecord(options.pattern) || typeof options.pattern.id !== 'string') {
          return failure(
            'project.edit.invalid',
            'A pattern must be an object with a string id.',
            'Pass a complete SongSchemaV1 pattern object.',
          );
        }
        const cloned = cloneJsonValue(options.pattern, 'The pattern');
        if (!cloned.ok) {
          return cloned;
        }
        const patterns = song.patterns ?? [];
        const index = findPatternIndex(song, options.pattern.id);
        if (index >= 0) {
          patterns[index] = cloned.value;
        } else {
          patterns.push(cloned.value);
        }
        song.patterns = patterns;
        return success(song);
      }),
    );
  }

  /** Remove one pattern. Placements that reference it are validated afterwards. */
  async removePattern(
    projectId: string,
    options: RemovePatternOptions,
  ): Promise<ProjectResult<ProjectSnapshot>> {
    return this.run(() =>
      this.mutateSong(projectId, options.expectedRevision, (song) => {
        const patterns = song.patterns ?? [];
        const index = findPatternIndex(song, options.patternId);
        if (index < 0) {
          return failure(
            'project.edit.pattern_not_found',
            `Pattern id "${options.patternId}" does not exist.`,
            'Read the current song and use an existing pattern id.',
            { path: '/patterns', detail: options.patternId },
          );
        }
        patterns.splice(index, 1);
        if (patterns.length === 0) {
          delete song.patterns;
        } else {
          song.patterns = patterns;
        }
        return success(song);
      }),
    );
  }

  /** Replace one track instrument. */
  async setInstrument(
    projectId: string,
    options: SetInstrumentOptions,
  ): Promise<ProjectResult<ProjectSnapshot>> {
    return this.run(() =>
      this.mutateSong(projectId, options.expectedRevision, (song) => {
        const index = findTrackIndex(song, options.trackId);
        if (index < 0) {
          return this.trackNotFound(options.trackId);
        }
        if (!isRecord(options.instrument)) {
          return failure(
            'project.edit.invalid',
            'An instrument must be an object.',
            'Pass a complete SongSchemaV1 instrument object.',
            { path: `/tracks/${index}/instrument` },
          );
        }
        const cloned = cloneJsonValue(options.instrument, 'The instrument');
        if (!cloned.ok) {
          return cloned;
        }
        const track = song.tracks[index];
        if (!track) {
          return this.trackNotFound(options.trackId);
        }
        track.instrument = cloned.value;
        return success(song);
      }),
    );
  }

  /**
   * Resolve an existing asset path from the song, relative to the project
   * directory and required to stay below `assets/`.
   */
  async resolveAsset(
    projectId: string,
    relativePath: string,
  ): Promise<ProjectResult<ResolvedProjectAsset>> {
    return this.run(() => this.resolveAssetInternal(projectId, relativePath));
  }

  /** Read one confined asset with a byte bound. */
  async readAsset(
    projectId: string,
    relativePath: string,
    options: ReadAssetOptions = {},
  ): Promise<ProjectResult<ReadProjectAsset>> {
    return this.run(async () => {
      const limit = options.maxBytes ?? this.limits.maxAssetBytes;
      if (!isPositiveSafeInteger(limit) || limit > this.limits.maxAssetBytes) {
        return failure(
          'project.config.invalid',
          `The requested asset limit must be between 1 and ${this.limits.maxAssetBytes} bytes.`,
          'Use the configured asset bound or a smaller byte ceiling.',
          { projectId },
        );
      }
      const resolved = await this.resolveAssetInternal(projectId, relativePath);
      if (!resolved.ok) {
        return resolved;
      }
      const read = await readBoundedFile(resolved.value.absolutePath, limit);
      if (!read.ok) {
        if (read.kind === 'too_large') {
          return failure(
            'project.asset.too_large',
            `Asset "${relativePath}" exceeds the ${limit} byte limit.`,
            'Use a smaller asset or raise maxAssetBytes deliberately.',
            {
              projectId,
              path: relativePath,
              detail: String(read.bytes ?? 'unknown'),
            },
          );
        }
        if (read.kind === 'missing') {
          return failure(
            'project.asset.missing',
            `Asset "${relativePath}" does not exist.`,
            'Provision the asset inside the project assets directory. Vamp never downloads assets implicitly.',
            { projectId, path: relativePath },
          );
        }
        return failure(
          'project.asset.unreadable',
          `Asset "${relativePath}" could not be read.`,
          'Check file type and permissions.',
          { projectId, path: relativePath, ...describeDetail(read.detail) },
        );
      }
      return success({
        absolutePath: resolved.value.absolutePath,
        relativePath,
        bytes: read.data.length,
        data: read.data,
      });
    });
  }

  /**
   * Resolve a render destination below the project's `renders/` directory. The
   * directory may not exist yet; its nearest existing ancestor is checked for
   * symlink escapes.
   */
  async resolveRenderDirectory(
    projectId: string,
    relativePath: string = PROJECT_LAYOUT.rendersDirectory,
  ): Promise<ProjectResult<ResolvedRenderDirectory>> {
    return this.run(async () => {
      const located = await this.locateProject(projectId);
      if (!located.ok) {
        return located;
      }
      const validated = validateProjectRelativePath(relativePath, {
        prefix: PROJECT_LAYOUT.rendersDirectory,
        allowBarePrefix: true,
      });
      if (!validated.ok) {
        return withProjectId(validated, projectId);
      }
      const renders = await this.resolveEnclosedDirectory(
        located.value.directory,
        PROJECT_LAYOUT.rendersDirectory,
        projectId,
      );
      if (!renders.ok) {
        return renders;
      }
      const candidate =
        validated.value.segments.length === 1
          ? renders.value
          : resolve(renders.value, ...validated.value.segments.slice(1));
      if (!isInsidePath(renders.value, candidate)) {
        return failure(
          'project.path.confined',
          `Render destination "${relativePath}" resolves outside the renders directory.`,
          'Use a path below renders/.',
          { projectId, path: relativePath },
        );
      }
      const canonical = await this.resolveConfinedCandidate(
        candidate,
        renders.value,
        renders.value,
        projectId,
        relativePath,
      );
      if (!canonical.ok) {
        return canonical;
      }
      if (canonical.value.exists) {
        const info = await stat(canonical.value.absolutePath).catch(() => null);
        if (!info || !info.isDirectory()) {
          return failure(
            'project.path.invalid',
            `Render destination "${relativePath}" exists but is not a directory.`,
            'Choose an unused directory below renders/.',
            { projectId, path: relativePath },
          );
        }
      }
      return success({
        absolutePath: canonical.value.absolutePath,
        relativePath,
        exists: canonical.value.exists,
      });
    });
  }

  private async run<T>(operation: () => Promise<ProjectResult<T>>): Promise<ProjectResult<T>> {
    try {
      return await operation();
    } catch (error) {
      return internalError(error);
    }
  }

  private async rootDirectory(): Promise<ProjectResult<string>> {
    if (this.configError) {
      return this.configError;
    }
    let rootReal: string;
    try {
      rootReal = await realpath(resolve(this.root));
    } catch (error) {
      if (isFileSystemError(error) && error.code === 'ENOENT') {
        return failure(
          'project.root.not_found',
          `The configured projects root "${this.root}" does not exist.`,
          'Create the projects root before storing projects.',
          { path: this.root },
        );
      }
      return failure(
        'project.io.failed',
        `The configured projects root "${this.root}" could not be resolved.`,
        'Check root permissions and symlink targets.',
        { path: this.root },
      );
    }
    const info = await stat(rootReal).catch(() => null);
    if (!info) {
      return failure(
        'project.root.not_found',
        `The configured projects root "${this.root}" does not exist.`,
        'Create the projects root before storing projects.',
        { path: this.root },
      );
    }
    if (!info.isDirectory()) {
      return failure(
        'project.root.not_directory',
        `The configured projects root "${this.root}" is not a directory.`,
        'Configure a directory that will contain one subdirectory per project.',
        { path: this.root },
      );
    }
    return success(rootReal);
  }

  private async locateProject(projectId: string): Promise<ProjectResult<LocatedProject>> {
    const idResult = validateProjectId(projectId);
    if (!idResult.ok) {
      return idResult;
    }
    const rootResult = await this.rootDirectory();
    if (!rootResult.ok) {
      return rootResult;
    }
    const rootReal = rootResult.value;
    const directory = resolve(rootReal, projectId);
    if (!isInsidePath(rootReal, directory) || directory === rootReal) {
      return failure(
        'project.path.confined',
        `Project id "${projectId}" resolves outside the projects root.`,
        'Use a plain lowercase project id with no path separators.',
        { projectId, path: projectId },
      );
    }

    let info;
    try {
      info = await lstat(directory);
    } catch (error) {
      if (isFileSystemError(error) && error.code === 'ENOENT') {
        return failure(
          'project.not_found',
          `Project "${projectId}" does not exist.`,
          'List projects to discover valid ids or create the project first.',
          { projectId },
        );
      }
      return failure(
        'project.io.failed',
        `Project "${projectId}" could not be inspected.`,
        'Check projects root permissions.',
        { projectId },
      );
    }
    if (info.isSymbolicLink()) {
      return failure(
        'project.path.confined',
        `Project "${projectId}" is a symbolic link.`,
        'Project directories must be real directories inside the projects root. Symlinked project directories are rejected.',
        { projectId },
      );
    }
    if (!info.isDirectory()) {
      return failure(
        'project.path.invalid',
        `Project "${projectId}" is not a directory.`,
        'Remove the conflicting entry or choose another project id.',
        { projectId },
      );
    }

    let directoryReal: string;
    try {
      directoryReal = await realpath(directory);
    } catch (error) {
      return failure(
        'project.path.confined',
        `Project "${projectId}" could not be resolved to a real path.`,
        'Replace broken links or the conflicting entry with a real project directory.',
        { projectId, ...describeDetail(isFileSystemError(error) ? error.code : undefined) },
      );
    }
    if (!isInsidePath(rootReal, directoryReal) || directoryReal === rootReal) {
      return failure(
        'project.path.confined',
        `Project "${projectId}" resolves outside the projects root.`,
        'Keep project directories inside the configured root.',
        { projectId },
      );
    }
    return success({ projectId, rootReal, directory: directoryReal });
  }

  private async readMetadata(located: LocatedProject): Promise<ProjectResult<ProjectMetadata>> {
    const path = join(located.directory, PROJECT_LAYOUT.metadataFile);
    const read = await readBoundedFile(path, this.limits.maxMetadataBytes);
    if (!read.ok) {
      if (read.kind === 'missing') {
        return failure(
          'project.metadata.missing',
          `Project "${located.projectId}" has no ${PROJECT_LAYOUT.metadataFile}.`,
          'The project directory is incomplete or not a Vamp project. Restore the metadata file or create a new project.',
          { projectId: located.projectId, path: PROJECT_LAYOUT.metadataFile },
        );
      }
      if (read.kind === 'too_large') {
        return failure(
          'project.metadata.too_large',
          `Project metadata exceeds ${this.limits.maxMetadataBytes} bytes.`,
          'Restore a valid metadata file written by Vamp. Oversized metadata is not loaded.',
          {
            projectId: located.projectId,
            path: PROJECT_LAYOUT.metadataFile,
            detail: String(read.bytes ?? 'unknown'),
          },
        );
      }
      return failure(
        'project.metadata.invalid',
        `Project metadata could not be read as a regular file.`,
        'Keep .vamp-project.json as a regular file, not a symlink, directory, or device.',
        { projectId: located.projectId, path: PROJECT_LAYOUT.metadataFile },
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(read.data.toString('utf8')) as unknown;
    } catch (error) {
      return failure(
        'project.metadata.malformed',
        `Project metadata is not valid JSON.`,
        'Restore the metadata file from a backup or create a new project. The file was not rewritten.',
        {
          projectId: located.projectId,
          path: PROJECT_LAYOUT.metadataFile,
          ...describeDetail(error instanceof Error ? error.message : undefined),
        },
      );
    }
    if (!isRecord(parsed)) {
      return failure(
        'project.metadata.invalid',
        'Project metadata must be a JSON object.',
        'Restore a metadata file written by Vamp.',
        { projectId: located.projectId, path: PROJECT_LAYOUT.metadataFile },
      );
    }
    if (parsed.format !== PROJECT_LAYOUT.metadataFormat) {
      return failure(
        'project.metadata.invalid',
        'Project metadata has an unrecognized format marker.',
        `Expected format "${PROJECT_LAYOUT.metadataFormat}". This directory may not be a Vamp project.`,
        { projectId: located.projectId, path: PROJECT_LAYOUT.metadataFile },
      );
    }
    if (parsed.formatVersion !== PROJECT_LAYOUT.metadataFormatVersion) {
      return failure(
        'project.metadata.unsupported',
        `Project metadata formatVersion ${JSON.stringify(parsed.formatVersion)} is not supported.`,
        `This build supports formatVersion ${PROJECT_LAYOUT.metadataFormatVersion}. Do not downgrade or rewrite the project automatically.`,
        { projectId: located.projectId, path: PROJECT_LAYOUT.metadataFile },
      );
    }
    if (parsed.projectId !== located.projectId) {
      return failure(
        'project.metadata.invalid',
        'Project metadata identity does not match its directory name.',
        'Do not copy or rename project directories outside the project API.',
        { projectId: located.projectId, path: PROJECT_LAYOUT.metadataFile },
      );
    }
    if (!isValidRevision(parsed.revision)) {
      return failure(
        'project.revision.invalid',
        `Project revision ${JSON.stringify(parsed.revision)} is not a positive safe integer.`,
        'Restore valid revision metadata. Revisions start at 1 and only increment.',
        {
          projectId: located.projectId,
          path: PROJECT_LAYOUT.metadataFile,
          ...(typeof parsed.revision === 'number' ? { actualRevision: parsed.revision } : {}),
        },
      );
    }
    if (
      typeof parsed.title !== 'string' ||
      !isIsoTimestamp(parsed.createdAt) ||
      !isIsoTimestamp(parsed.updatedAt)
    ) {
      return failure(
        'project.metadata.invalid',
        'Project metadata is missing a title or valid timestamps.',
        'Restore a metadata file written by Vamp.',
        { projectId: located.projectId, path: PROJECT_LAYOUT.metadataFile },
      );
    }
    return success({
      projectId: located.projectId,
      revision: parsed.revision,
      title: parsed.title,
      createdAt: parsed.createdAt,
      updatedAt: parsed.updatedAt,
    });
  }

  private async readSong(located: LocatedProject): Promise<ProjectResult<LoadedSong>> {
    const path = join(located.directory, PROJECT_LAYOUT.songFile);
    const read = await readBoundedFile(path, this.limits.maxSongBytes);
    if (!read.ok) {
      if (read.kind === 'missing') {
        return failure(
          'project.song.missing',
          `Project "${located.projectId}" has no ${PROJECT_LAYOUT.songFile}.`,
          'Restore song.json or create a new project.',
          { projectId: located.projectId, path: PROJECT_LAYOUT.songFile },
        );
      }
      if (read.kind === 'too_large') {
        return failure(
          'project.song.too_large',
          `Song JSON exceeds ${this.limits.maxSongBytes} bytes.`,
          'Edit the project through Vamp or reduce the song. Oversized songs are rejected before parsing.',
          {
            projectId: located.projectId,
            path: PROJECT_LAYOUT.songFile,
            detail: String(read.bytes ?? 'unknown'),
          },
        );
      }
      if (read.kind === 'symlink') {
        return failure(
          'project.path.confined',
          'song.json is a symbolic link.',
          'Keep the canonical song file as a regular file inside the project directory.',
          { projectId: located.projectId, path: PROJECT_LAYOUT.songFile },
        );
      }
      return failure(
        'project.song.unreadable',
        `Project song could not be read as a regular file.`,
        'Check file type and permissions.',
        {
          projectId: located.projectId,
          path: PROJECT_LAYOUT.songFile,
          ...describeDetail(read.detail),
        },
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(read.data.toString('utf8')) as unknown;
    } catch (error) {
      return failure(
        'project.song.malformed_json',
        'song.json is not valid JSON.',
        'Fix the JSON syntax or restore the file. The project was not rewritten.',
        {
          projectId: located.projectId,
          path: PROJECT_LAYOUT.songFile,
          ...describeDetail(error instanceof Error ? error.message : undefined),
        },
      );
    }

    const validated = validateSong(parsed, this.validationOptions);
    if (!validated.ok) {
      return this.songValidationFailure(validated, located.projectId);
    }
    return success({ validation: validated, raw: read.data });
  }

  private songValidationFailure(
    result: Extract<ValidationResult, { ok: false }>,
    projectId?: string,
  ): ProjectError {
    const unsupported = result.errors.some((issue) => issue.code.startsWith('schema.version.'));
    const message = unsupported
      ? 'The song uses a missing or unsupported schemaVersion.'
      : 'The resulting song failed schema validation.';
    const hint = unsupported
      ? 'Use schemaVersion "1.0.0" or migrate the song explicitly. Vamp never rewrites a saved file automatically.'
      : 'Fix the reported issues. No file or revision was changed.';
    return failure(
      unsupported ? 'project.song.unsupported_version' : 'project.song.invalid',
      message,
      hint,
      {
        ...(projectId === undefined ? {} : { projectId }),
        path: PROJECT_LAYOUT.songFile,
        issues: result.errors,
      },
    );
  }

  private async getInternal(projectId: string): Promise<ProjectResult<ProjectSnapshot>> {
    const located = await this.locateProject(projectId);
    if (!located.ok) {
      return located;
    }
    const metadata = await this.readMetadata(located.value);
    if (!metadata.ok) {
      return metadata;
    }
    const song = await this.readSong(located.value);
    if (!song.ok) {
      return song;
    }
    return success(
      this.snapshot(metadata.value, song.value.validation.song, song.value.validation.warnings),
    );
  }

  private async createInternal(
    options: CreateProjectOptions,
  ): Promise<ProjectResult<ProjectSnapshot>> {
    const idResult = validateProjectId(options.projectId);
    if (!idResult.ok) {
      return idResult;
    }
    const validated = validateSong(options.song, this.validationOptions);
    if (!validated.ok) {
      return this.songValidationFailure(validated);
    }
    const rootResult = await this.rootDirectory();
    if (!rootResult.ok) {
      return rootResult;
    }
    const rootReal = rootResult.value;
    if (this.limits.maxProjects === 0) {
      return failure(
        'project.limit.projects',
        'The projects root is configured to accept zero projects.',
        'Raise maxProjects deliberately before creating a project.',
      );
    }
    const count = await this.countProjectDirectories(rootReal);
    if (!count.ok) {
      return count;
    }
    if (count.value >= this.limits.maxProjects) {
      return failure(
        'project.limit.projects',
        `The projects root already contains ${count.value} project director${count.value === 1 ? 'y' : 'ies'}, reaching the limit of ${this.limits.maxProjects}.`,
        'Delete unused projects deliberately or raise maxProjects.',
      );
    }

    const directory = resolve(rootReal, options.projectId);
    let created = false;
    try {
      try {
        await mkdir(directory, { mode: 0o700 });
        created = true;
      } catch (error) {
        if (isFileSystemError(error) && error.code === 'EEXIST') {
          return failure(
            'project.exists',
            `Project "${options.projectId}" already exists.`,
            'Use get or update for the existing project, or choose another id.',
            { projectId: options.projectId },
          );
        }
        return failure(
          'project.io.failed',
          `Could not create project directory "${options.projectId}".`,
          'Check projects root permissions and free space.',
          {
            projectId: options.projectId,
            ...describeDetail(fileSystemErrorCode(error)),
          },
        );
      }

      await mkdir(join(directory, PROJECT_LAYOUT.assetsDirectory), { mode: 0o700 });
      await mkdir(join(directory, PROJECT_LAYOUT.rendersDirectory), { mode: 0o700 });

      const assetCheck = await this.validateSongAssetReferences(
        { projectId: options.projectId, rootReal, directory },
        validated.song,
      );
      if (!assetCheck.ok) {
        return assetCheck;
      }

      const songBytes = this.serializeSong(validated.song, options.projectId);
      if (!songBytes.ok) {
        return songBytes;
      }
      const now = new Date().toISOString();
      const metadata: ProjectMetadata = {
        projectId: options.projectId,
        revision: 1,
        title: validated.song.meta.title,
        createdAt: now,
        updatedAt: now,
      };
      const songWrite = await writeFileAtomic(
        join(directory, PROJECT_LAYOUT.songFile),
        songBytes.value,
      );
      if (!songWrite.ok) {
        return withProjectId(songWrite, options.projectId);
      }
      const metadataWrite = await this.writeMetadata(directory, metadata);
      if (!metadataWrite.ok) {
        return withProjectId(metadataWrite, options.projectId);
      }

      const snapshot = this.snapshot(metadata, validated.song, validated.warnings);
      created = false;
      return success(snapshot);
    } finally {
      if (created) {
        await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  private async listInternal(): Promise<ProjectResult<readonly ProjectSummary[]>> {
    const rootResult = await this.rootDirectory();
    if (!rootResult.ok) {
      return rootResult;
    }
    const rootReal = rootResult.value;
    let directory;
    try {
      directory = await opendir(rootReal);
    } catch (error) {
      return failure(
        'project.io.failed',
        'Could not enumerate the projects root.',
        'Check projects root permissions.',
        { ...describeDetail(isFileSystemError(error) ? error.code : undefined) },
      );
    }

    const projects: ProjectSummary[] = [];
    let entries = 0;
    try {
      for await (const entry of directory) {
        entries += 1;
        if (entries > this.limits.maxDirectoryEntries) {
          return failure(
            'project.limit.enumeration',
            `The projects root has more than ${this.limits.maxDirectoryEntries} entries.`,
            'Move unrelated files out of the projects root and retry.',
          );
        }
        if (!entry.isDirectory() || !isValidProjectId(entry.name)) {
          continue;
        }
        const located = await this.locateProject(entry.name);
        if (!located.ok) {
          return located;
        }
        const metadata = await this.readMetadata(located.value);
        if (!metadata.ok) {
          if (metadata.code === 'project.metadata.missing') {
            continue;
          }
          return metadata;
        }
        projects.push({
          projectId: metadata.value.projectId,
          revision: metadata.value.revision,
          title: metadata.value.title,
          createdAt: metadata.value.createdAt,
          updatedAt: metadata.value.updatedAt,
        });
        if (projects.length > this.limits.maxProjects) {
          return failure(
            'project.limit.projects',
            `The projects root contains more than ${this.limits.maxProjects} projects.`,
            'Raise maxProjects deliberately or remove unused projects.',
          );
        }
      }
    } catch (error) {
      return failure(
        'project.io.failed',
        'Could not finish enumerating the projects root.',
        'Check projects root permissions and retry.',
        { ...describeDetail(isFileSystemError(error) ? error.code : undefined) },
      );
    } finally {
      await directory.close().catch(() => undefined);
    }

    projects.sort(sortByProjectId);
    return success(projects);
  }

  private async countProjectDirectories(rootReal: string): Promise<ProjectResult<number>> {
    let directory;
    try {
      directory = await opendir(rootReal);
    } catch (error) {
      return failure(
        'project.io.failed',
        'Could not enumerate the projects root.',
        'Check projects root permissions.',
        { ...describeDetail(isFileSystemError(error) ? error.code : undefined) },
      );
    }
    let count = 0;
    let entries = 0;
    try {
      for await (const entry of directory) {
        entries += 1;
        if (entries > this.limits.maxDirectoryEntries) {
          return failure(
            'project.limit.enumeration',
            `The projects root has more than ${this.limits.maxDirectoryEntries} entries.`,
            'Move unrelated files out of the projects root and retry.',
          );
        }
        if (entry.isDirectory() && isValidProjectId(entry.name)) {
          count += 1;
        }
      }
    } catch (error) {
      return failure(
        'project.io.failed',
        'Could not finish enumerating the projects root.',
        'Check projects root permissions and retry.',
        { ...describeDetail(isFileSystemError(error) ? error.code : undefined) },
      );
    } finally {
      await directory.close().catch(() => undefined);
    }
    return success(count);
  }

  private async mutateSong(
    projectId: string,
    expectedRevision: number,
    mutation: SongMutation,
  ): Promise<ProjectResult<ProjectSnapshot>> {
    if (!isValidRevision(expectedRevision)) {
      return failure(
        'project.revision.invalid',
        `Expected revision ${JSON.stringify(expectedRevision)} is not a positive safe integer.`,
        'Read the project first and pass its current revision. Revisions start at 1.',
        { projectId },
      );
    }
    const located = await this.locateProject(projectId);
    if (!located.ok) {
      return located;
    }
    const lock = await acquireProjectLock(
      located.value.directory,
      this.limits.lockTimeoutMs,
      this.limits.staleLockMs,
    );
    if (!lock.ok) {
      return withProjectId(lock, projectId);
    }

    try {
      const metadata = await this.readMetadata(located.value);
      if (!metadata.ok) {
        return metadata;
      }
      if (metadata.value.revision !== expectedRevision) {
        return failure(
          'project.revision.conflict',
          `Expected revision ${expectedRevision} but project "${projectId}" is at revision ${metadata.value.revision}.`,
          'Read the project again, reapply the intended edit to the current song, and retry with the returned revision.',
          {
            projectId,
            expectedRevision,
            actualRevision: metadata.value.revision,
          },
        );
      }

      const loaded = await this.readSong(located.value);
      if (!loaded.ok) {
        return loaded;
      }
      const draft = await cloneJsonValue(loaded.value.validation.song, 'The loaded song');
      if (!draft.ok) {
        return draft;
      }
      const mutated = mutation(draft.value);
      if (!mutated.ok) {
        return withProjectId(mutated, projectId);
      }

      const validated = validateSong(mutated.value, this.validationOptions);
      if (!validated.ok) {
        return this.songValidationFailure(validated, projectId);
      }

      const assetCheck = await this.validateSongAssetReferences(located.value, validated.song);
      if (!assetCheck.ok) {
        return assetCheck;
      }

      const committed = await this.commitSong(
        located.value,
        metadata.value,
        validated.song,
        loaded.value.raw,
      );
      if (!committed.ok) {
        return withProjectId(committed, projectId);
      }
      return success(
        this.snapshot(
          {
            projectId,
            revision: committed.value.revision,
            title: validated.song.meta.title,
            createdAt: metadata.value.createdAt,
            updatedAt: committed.value.updatedAt,
          },
          validated.song,
          validated.warnings,
        ),
      );
    } finally {
      await lock.value.release();
    }
  }

  private async commitSong(
    located: LocatedProject,
    previousMetadata: ProjectMetadata,
    song: SongSchemaV1,
    previousSong: Buffer,
  ): Promise<ProjectResult<{ readonly revision: number; readonly updatedAt: string }>> {
    const revision = previousMetadata.revision + 1;
    if (!isValidRevision(revision)) {
      return failure(
        'project.revision.invalid',
        'The project revision cannot be incremented safely.',
        'Restore the project from a backup. Revisions must remain positive safe integers.',
        { projectId: located.projectId },
      );
    }
    const songBytes = this.serializeSong(song, located.projectId);
    if (!songBytes.ok) {
      return songBytes;
    }
    const updatedAt = new Date().toISOString();
    const metadata: ProjectMetadata = {
      projectId: located.projectId,
      revision,
      title: song.meta.title,
      createdAt: previousMetadata.createdAt,
      updatedAt,
    };
    const metadataBytes = this.serializeMetadata(metadata, located.projectId);
    if (!metadataBytes.ok) {
      return metadataBytes;
    }

    const songStage = await stageAtomicWrite(
      join(located.directory, PROJECT_LAYOUT.songFile),
      songBytes.value,
    );
    if (!songStage.ok) {
      return songStage;
    }
    const metadataStage = await stageAtomicWrite(
      join(located.directory, PROJECT_LAYOUT.metadataFile),
      metadataBytes.value,
    );
    if (!metadataStage.ok) {
      await songStage.value.discard();
      return metadataStage;
    }

    const songCommit = await songStage.value.commit();
    if (!songCommit.ok) {
      await metadataStage.value.discard();
      return songCommit;
    }
    const metadataCommit = await metadataStage.value.commit();
    if (!metadataCommit.ok) {
      const rollback = await writeFileAtomic(
        join(located.directory, PROJECT_LAYOUT.songFile),
        previousSong,
      );
      return failure(
        'project.io.commit_failed',
        'The song was written but the revision metadata could not be committed.',
        rollback.ok
          ? 'song.json was restored to its previous bytes and the revision did not advance. Retry the edit.'
          : 'song.json may have changed without a revision advance. Restore the project from a backup before editing again.',
        {
          projectId: located.projectId,
          path: PROJECT_LAYOUT.metadataFile,
          detail: rollback.ok
            ? 'Rollback succeeded.'
            : 'Rollback also failed; the project may be inconsistent.',
        },
      );
    }
    return success({ revision, updatedAt });
  }

  private serializeSong(song: SongSchemaV1, projectId?: string): ProjectResult<Buffer> {
    const bytes = Buffer.from(`${JSON.stringify(song, null, 2)}\n`, 'utf8');
    if (bytes.length > this.limits.maxSongBytes) {
      return failure(
        'project.song.too_large',
        `The serialized song is ${bytes.length} bytes, above the ${this.limits.maxSongBytes} byte limit.`,
        'Reduce the song or raise maxSongBytes deliberately. No file was written.',
        {
          ...(projectId === undefined ? {} : { projectId }),
          path: PROJECT_LAYOUT.songFile,
          detail: String(bytes.length),
        },
      );
    }
    return success(bytes);
  }

  private serializeMetadata(metadata: ProjectMetadata, projectId: string): ProjectResult<Buffer> {
    const document = {
      format: PROJECT_LAYOUT.metadataFormat,
      formatVersion: PROJECT_LAYOUT.metadataFormatVersion,
      projectId: metadata.projectId,
      revision: metadata.revision,
      title: metadata.title,
      createdAt: metadata.createdAt,
      updatedAt: metadata.updatedAt,
    };
    const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
    if (bytes.length > this.limits.maxMetadataBytes) {
      return failure(
        'project.metadata.too_large',
        `The serialized project metadata is ${bytes.length} bytes, above the ${this.limits.maxMetadataBytes} byte limit.`,
        'Shorten the song title or raise maxMetadataBytes deliberately.',
        { projectId, path: PROJECT_LAYOUT.metadataFile },
      );
    }
    return success(bytes);
  }

  private async writeMetadata(
    directory: string,
    metadata: ProjectMetadata,
  ): Promise<ProjectResult<void>> {
    const bytes = this.serializeMetadata(metadata, metadata.projectId);
    if (!bytes.ok) {
      return bytes;
    }
    return writeFileAtomic(join(directory, PROJECT_LAYOUT.metadataFile), bytes.value);
  }

  private snapshot(
    metadata: ProjectMetadata,
    song: SongSchemaV1,
    warnings: readonly ValidationIssue[],
  ): ProjectSnapshot {
    return {
      projectId: metadata.projectId,
      revision: metadata.revision,
      title: song.meta.title,
      createdAt: metadata.createdAt,
      updatedAt: metadata.updatedAt,
      song,
      warnings,
    };
  }

  private trackNotFound(trackId: string): ProjectError {
    return failure(
      'project.edit.track_not_found',
      `Track id "${trackId}" does not exist.`,
      'Read the current song and use an existing track id.',
      { path: '/tracks', detail: trackId },
    );
  }

  private noteNotFound(trackId: string, noteIndex: number): ProjectError {
    return failure(
      'project.edit.note_not_found',
      `No free note exists at index ${String(noteIndex)} on track "${trackId}".`,
      'Read the current revision. Free notes are identified by track id and zero-based position within that revision.',
      { path: `/tracks`, detail: `${trackId}:${String(noteIndex)}` },
    );
  }

  /**
   * Check that every song asset reference is lexically and physically confined
   * to this project's assets directory before it is saved. Missing assets are
   * allowed at authoring time; existing non-files and symlink escapes are not.
   */
  private async validateSongAssetReferences(
    located: LocatedProject,
    song: SongSchemaV1,
  ): Promise<ProjectResult<void>> {
    const paths = new Set<string>();
    for (const track of song.tracks) {
      const instrument = track.instrument;
      if (instrument.type === 'soundfont' || instrument.type === 'sfz') {
        paths.add(instrument.path);
      }
    }
    if (paths.size === 0) {
      return success(undefined);
    }

    const assets = await this.resolveEnclosedDirectory(
      located.directory,
      PROJECT_LAYOUT.assetsDirectory,
      located.projectId,
    );
    if (!assets.ok) {
      return assets;
    }
    for (const relativePath of paths) {
      const validated = validateProjectRelativePath(relativePath, {
        prefix: PROJECT_LAYOUT.assetsDirectory,
        allowBarePrefix: false,
      });
      if (!validated.ok) {
        return withProjectId(validated, located.projectId);
      }
      const candidate = resolve(assets.value, ...validated.value.segments.slice(1));
      if (!isInsidePath(assets.value, candidate)) {
        return failure(
          'project.path.confined',
          `Asset "${relativePath}" resolves outside the assets directory.`,
          'Use a relative path below assets/.',
          { projectId: located.projectId, path: relativePath },
        );
      }
      const canonical = await this.resolveConfinedCandidate(
        candidate,
        assets.value,
        assets.value,
        located.projectId,
        relativePath,
      );
      if (!canonical.ok) {
        return canonical;
      }
      if (!canonical.value.exists) {
        continue;
      }
      const info = await stat(canonical.value.absolutePath).catch(() => null);
      if (!info) {
        return failure(
          'project.asset.unreadable',
          `Asset "${relativePath}" could not be inspected.`,
          'Check permissions and whether the file was replaced during resolution.',
          { projectId: located.projectId, path: relativePath },
        );
      }
      if (!info.isFile()) {
        return failure(
          'project.asset.not_file',
          `Asset "${relativePath}" is not a regular file.`,
          'Point the song at a real file, not a directory, device, or socket.',
          { projectId: located.projectId, path: relativePath },
        );
      }
    }
    return success(undefined);
  }

  private async resolveAssetInternal(
    projectId: string,
    relativePath: string,
  ): Promise<ProjectResult<ResolvedProjectAsset>> {
    const located = await this.locateProject(projectId);
    if (!located.ok) {
      return located;
    }
    const validated = validateProjectRelativePath(relativePath, {
      prefix: PROJECT_LAYOUT.assetsDirectory,
      allowBarePrefix: false,
    });
    if (!validated.ok) {
      return withProjectId(validated, projectId);
    }
    const assets = await this.resolveEnclosedDirectory(
      located.value.directory,
      PROJECT_LAYOUT.assetsDirectory,
      projectId,
    );
    if (!assets.ok) {
      return assets;
    }
    const candidate = resolve(assets.value, ...validated.value.segments.slice(1));
    if (!isInsidePath(assets.value, candidate)) {
      return failure(
        'project.path.confined',
        `Asset "${relativePath}" resolves outside the assets directory.`,
        'Use a relative path below assets/.',
        { projectId, path: relativePath },
      );
    }
    const canonical = await this.resolveConfinedCandidate(
      candidate,
      assets.value,
      assets.value,
      projectId,
      relativePath,
    );
    if (!canonical.ok) {
      return canonical;
    }
    if (!canonical.value.exists) {
      return failure(
        'project.asset.missing',
        `Asset "${relativePath}" does not exist.`,
        'Provision the asset inside the project assets directory. Vamp never downloads assets during a render.',
        { projectId, path: relativePath },
      );
    }
    const info = await stat(canonical.value.absolutePath).catch(() => null);
    if (!info) {
      return failure(
        'project.asset.unreadable',
        `Asset "${relativePath}" could not be inspected.`,
        'Check permissions and whether the file was replaced during resolution.',
        { projectId, path: relativePath },
      );
    }
    if (!info.isFile()) {
      return failure(
        'project.asset.not_file',
        `Asset "${relativePath}" is not a regular file.`,
        'Point the song at a real file, not a directory, device, or socket.',
        { projectId, path: relativePath },
      );
    }
    if (info.size > this.limits.maxAssetBytes) {
      return failure(
        'project.asset.too_large',
        `Asset "${relativePath}" is ${info.size} bytes, above the ${this.limits.maxAssetBytes} byte limit.`,
        'Use a smaller asset or raise maxAssetBytes deliberately.',
        { projectId, path: relativePath, detail: String(info.size) },
      );
    }
    return success({
      absolutePath: canonical.value.absolutePath,
      relativePath,
      bytes: info.size,
    });
  }

  private async resolveEnclosedDirectory(
    projectDirectory: string,
    name: string,
    projectId: string,
  ): Promise<ProjectResult<string>> {
    const directory = join(projectDirectory, name);
    let info;
    try {
      info = await lstat(directory);
    } catch (error) {
      if (isFileSystemError(error) && error.code === 'ENOENT') {
        return failure(
          'project.path.invalid',
          `Project "${projectId}" has no ${name}/ directory.`,
          `Restore the ${name}/ directory inside the project.`,
          { projectId, path: name },
        );
      }
      return failure(
        'project.io.failed',
        `Could not inspect ${name}/ for project "${projectId}".`,
        'Check project directory permissions.',
        { projectId, path: name },
      );
    }
    if (info.isSymbolicLink()) {
      return failure(
        'project.path.confined',
        `Project ${name}/ is a symbolic link.`,
        `Keep ${name}/ as a real directory inside the project.`,
        { projectId, path: name },
      );
    }
    if (!info.isDirectory()) {
      return failure(
        'project.path.invalid',
        `Project ${name}/ is not a directory.`,
        `Restore ${name}/ as a directory.`,
        { projectId, path: name },
      );
    }
    let directoryReal: string;
    try {
      directoryReal = await realpath(directory);
    } catch (error) {
      return failure(
        'project.path.confined',
        `Project ${name}/ could not be resolved.`,
        'Replace broken links with a real directory.',
        {
          projectId,
          path: name,
          ...describeDetail(fileSystemErrorCode(error)),
        },
      );
    }
    if (!isInsidePath(projectDirectory, directoryReal)) {
      return failure(
        'project.path.confined',
        `Project ${name}/ resolves outside the project directory.`,
        `Keep ${name}/ inside the project.`,
        { projectId, path: name },
      );
    }
    return success(directoryReal);
  }

  /**
   * Resolve a candidate under a real base directory. The nearest existing
   * ancestor is realpath-checked before any not-yet-created final segments are
   * accepted. An existing final symlink must also resolve inside the base.
   */
  private async resolveConfinedCandidate(
    candidate: string,
    lexicalBase: string,
    baseReal: string,
    projectId: string,
    relativePath: string,
  ): Promise<ProjectResult<{ readonly absolutePath: string; readonly exists: boolean }>> {
    let ancestor = candidate;
    for (;;) {
      let info;
      try {
        info = await lstat(ancestor);
      } catch (error) {
        if (!isFileSystemError(error) || error.code !== 'ENOENT') {
          return failure(
            'project.io.failed',
            `Could not inspect "${relativePath}".`,
            'Check project permissions and retry.',
            {
              projectId,
              path: relativePath,
              ...describeDetail(fileSystemErrorCode(error)),
            },
          );
        }
        const parent = ancestor === lexicalBase ? null : dirname(ancestor);
        if (parent === null || !isInsidePath(lexicalBase, parent)) {
          return failure(
            'project.path.confined',
            `Path "${relativePath}" has no existing confined ancestor.`,
            'Use a path below the project directory.',
            { projectId, path: relativePath },
          );
        }
        ancestor = parent;
        continue;
      }
      let ancestorReal: string;
      try {
        ancestorReal = await realpath(ancestor);
      } catch (error) {
        return failure(
          'project.path.confined',
          `Path "${relativePath}" contains a broken or unresolvable link.`,
          'Replace broken links and retry.',
          {
            projectId,
            path: relativePath,
            ...describeDetail(fileSystemErrorCode(error)),
          },
        );
      }
      if (!isInsidePath(baseReal, ancestorReal)) {
        return failure(
          'project.path.confined',
          `Path "${relativePath}" escapes the project directory through a symbolic link.`,
          'Keep assets, renders, and their parent directories inside the project root.',
          { projectId, path: relativePath },
        );
      }
      const ancestorInfo = await stat(ancestorReal).catch(() => null);
      if (!ancestorInfo) {
        return failure(
          'project.path.invalid',
          `Path "${relativePath}" could not be inspected after resolving its nearest existing ancestor.`,
          'Replace broken links and retry.',
          { projectId, path: relativePath },
        );
      }
      if (ancestor !== candidate && !ancestorInfo.isDirectory()) {
        return failure(
          'project.path.invalid',
          `Path "${relativePath}" has an existing non-directory ancestor.`,
          'Use a path whose parents are directories.',
          { projectId, path: relativePath },
        );
      }
      if (
        ancestor === candidate &&
        !info.isSymbolicLink() &&
        !info.isFile() &&
        !info.isDirectory()
      ) {
        return failure(
          'project.path.invalid',
          `Path "${relativePath}" has an unsupported filesystem entry.`,
          'Use regular files and directories inside the project.',
          { projectId, path: relativePath },
        );
      }
      const canonical = join(ancestorReal, relative(ancestor, candidate));
      if (!isInsidePath(baseReal, canonical)) {
        return failure(
          'project.path.confined',
          `Path "${relativePath}" resolves outside the project directory.`,
          'Use a path inside the project.',
          { projectId, path: relativePath },
        );
      }
      return success({ absolutePath: canonical, exists: ancestor === candidate });
    }
  }
}
