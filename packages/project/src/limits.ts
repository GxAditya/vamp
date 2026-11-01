/**
 * Storage limits and the on-disk project layout.
 *
 * Limits are deliberately duplicated here rather than imported from the
 * engine: project storage depends only on `@gxaditya/vamp-schema` and Node's standard
 * library. Callers may override a limit when constructing a store, which tests
 * use to exercise bounds without creating gigabyte files.
 */

/** Maximum length of a project identifier in ASCII characters. */
export const MAX_PROJECT_ID_LENGTH = 64;

/** Maximum length of a project-relative asset or render path. */
export const MAX_PROJECT_PATH_LENGTH = 512;

/** Maximum length accepted for a configured projects root. */
export const MAX_PROJECT_ROOT_LENGTH = 4096;

export const PROJECT_LAYOUT = Object.freeze({
  /** Private identity and revision file inside each project directory. */
  metadataFile: '.vamp-project.json',
  /** Transient writer lock file inside each project directory. */
  lockFile: '.vamp-project.lock',
  /** Canonical song document inside each project directory. */
  songFile: 'song.json',
  /** Confined directory for project assets referenced by the song. */
  assetsDirectory: 'assets',
  /** Confined default directory for render artifacts. */
  rendersDirectory: 'renders',
  /** Metadata format marker. */
  metadataFormat: 'vamp-project',
  /** Supported metadata format revision. */
  metadataFormatVersion: 1,
});

export interface ProjectLimits {
  /** Maximum serialized bytes for song.json. Default 8 MiB. */
  readonly maxSongBytes: number;
  /** Maximum bytes for the private metadata file. Default 64 KiB. */
  readonly maxMetadataBytes: number;
  /** Maximum bytes for one asset file. Default 512 MiB. */
  readonly maxAssetBytes: number;
  /** Maximum number of project directories in a configured root. Default 500. */
  readonly maxProjects: number;
  /** Maximum directory entries examined by a root enumeration. Default 10,000. */
  readonly maxDirectoryEntries: number;
  /** Time to wait for an existing writer lock before returning busy. Default 2000 ms. */
  readonly lockTimeoutMs: number;
  /** Age after which an orphaned writer lock may be removed. Default 30,000 ms. */
  readonly staleLockMs: number;
}

export const DEFAULT_PROJECT_LIMITS: Readonly<ProjectLimits> = Object.freeze({
  maxSongBytes: 8 * 1024 * 1024,
  maxMetadataBytes: 64 * 1024,
  maxAssetBytes: 512 * 1024 * 1024,
  maxProjects: 500,
  maxDirectoryEntries: 10_000,
  lockTimeoutMs: 2000,
  staleLockMs: 30_000,
});

export type ProjectLimitsInput = Partial<ProjectLimits>;
