/**
 * @gxaditya/vamp-project public API.
 *
 * One filesystem-backed project store shared by the CLI, MCP server, and SDK.
 * The package depends only on `@gxaditya/vamp-schema` and Node's standard library.
 */

export {
  PROJECT_ERROR_CODES,
  type ProjectError,
  type ProjectErrorCode,
  type ProjectResult,
} from './errors.js';

export {
  DEFAULT_PROJECT_LIMITS,
  MAX_PROJECT_ID_LENGTH,
  MAX_PROJECT_PATH_LENGTH,
  MAX_PROJECT_ROOT_LENGTH,
  PROJECT_LAYOUT,
  type ProjectLimits,
  type ProjectLimitsInput,
} from './limits.js';

export {
  isSafePathSegment,
  isValidProjectId,
  isWindowsReservedName,
  type ValidatedRelativePath,
} from './paths.js';

export {
  ProjectStore,
  type AddNotesOptions,
  type AddTrackOptions,
  type CreateProjectOptions,
  type ProjectLocation,
  type ProjectSnapshot,
  type ProjectStoreOptions,
  type ProjectSummary,
  type ReadAssetOptions,
  type ReadProjectAsset,
  type RemoveNoteOptions,
  type RemovePatternOptions,
  type RemoveTrackOptions,
  type ResolvedProjectAsset,
  type ResolvedRenderDirectory,
  type RevisionedProjectOptions,
  type SetInstrumentOptions,
  type SetPatternOptions,
  type TrackChanges,
  type UpdateNoteOptions,
  type UpdateSongOptions,
  type UpdateTrackOptions,
} from './store.js';
