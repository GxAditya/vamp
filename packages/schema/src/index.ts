/**
 * @gxaditya/vamp-schema public API.
 *
 * SongSchemaV1 is canonical in schema/song.schema.json. The generated types in
 * src/generated/song-v1.ts are checked for drift by `pnpm check:generated`.
 * Validation is deterministic and never mutates the caller's song.
 */

export const PACKAGE_NAME = '@gxaditya/vamp-schema' as const;

export * from './generated/song-v1.js';

export {
  SONG_SCHEMA_ID,
  SONG_SCHEMA_VERSION,
  SUPPORTED_SCHEMA_VERSIONS,
  createMigrationRegistry,
  emptyMigrationRegistry,
  migrateSong,
  type MigrationFailure,
  type MigrationFailureCode,
  type MigrationRegistry,
  type MigrationResult,
  type MigrationSuccess,
  type SchemaMigration,
  type SupportedSchemaVersion,
} from './version.js';

export { getSongSchemaV1 } from './schema.js';

export {
  ISSUE_CODE_REFERENCE,
  ISSUE_CODES,
  type IssueCode,
  type IssueCodeDefinition,
  type IssueParameter,
  type IssueParams,
  type IssueSeverity,
  type ValidationIssue,
} from './issues.js';

export {
  validateSong,
  type CapabilityCheckStatus,
  type ValidateSongOptions,
  type ValidationFailure,
  type ValidationResult,
  type ValidationSuccess,
} from './validate.js';

export {
  normalizeSong,
  type NormalizedAutomation,
  type NormalizedBuiltinInstrument,
  type NormalizedDelayEffect,
  type NormalizedEffect,
  type NormalizedEqEffect,
  type NormalizedGmInstrument,
  type NormalizedInstrument,
  type NormalizedLowpassEffect,
  type NormalizedNote,
  type NormalizedPattern,
  type NormalizedPlacement,
  type NormalizedReverbEffect,
  type NormalizedSfzInstrument,
  type NormalizedSongMeta,
  type NormalizedSongV1,
  type NormalizedSoundfontInstrument,
  type NormalizedTrack,
} from './normalize.js';

export { NORMALIZATION_DEFAULTS } from './defaults.js';

export { getPatternEffectiveLengthBeats } from './patterns.js';

export {
  MAX_RENDER_SECONDS,
  TRACK_TAIL_CAP_SECONDS,
  estimateRenderedDuration,
  getEffectTailSeconds,
  type RenderedDurationEstimate,
  type TrackDurationContribution,
} from './duration.js';

export {
  validateBackendCapabilities,
  type BackendAssetReference,
  type BackendCapabilities,
  type EffectVariantType,
  type InstrumentVariantType,
} from './capabilities.js';

export {
  BUILTIN_INSTRUMENT_IDS,
  isBuiltinInstrumentId,
  type BuiltinInstrumentId,
} from './builtin-instruments.js';
