/**
 * @gxaditya/vamp-sdk public API.
 *
 * A thin typed local client for embedded use. The SDK is a library facade,
 * not a service client: it calls `@gxaditya/vamp-schema`, `@gxaditya/vamp-engine`, and
 * `@gxaditya/vamp-project` directly, so there is no HTTP transport, no required local
 * daemon, and no second validator, storage layer, renderer, or instrument
 * registry. It reuses the same result, error, and revision contracts as the
 * CLI and the MCP server and re-exports the generated public schema types and
 * the shared types the SDK returns so consumers can type against them.
 *
 * See `docs/api.md` for the reference.
 */

export const PACKAGE_NAME = '@gxaditya/vamp-sdk' as const;

/* ------------------------------------------------------------------ *
 * Schema discovery and validation (direct from @gxaditya/vamp-schema)
 * ------------------------------------------------------------------ */

export {
  SONG_SCHEMA_ID,
  SONG_SCHEMA_VERSION,
  SUPPORTED_SCHEMA_VERSIONS,
  getSongSchemaV1,
  validateSong,
  normalizeSong,
  NORMALIZATION_DEFAULTS,
  estimateRenderedDuration,
  MAX_RENDER_SECONDS,
  TRACK_TAIL_CAP_SECONDS,
  ISSUE_CODES,
  ISSUE_CODE_REFERENCE,
  BUILTIN_INSTRUMENT_IDS,
  isBuiltinInstrumentId,
} from '@gxaditya/vamp-schema';

export type {
  SongSchemaV1,
  SongMeta,
  TimeSignature,
  SongKey,
  Track,
  Instrument,
  BuiltinInstrument,
  GmInstrument,
  SoundfontInstrument,
  SfzInstrument,
  Note,
  Pattern,
  Placement,
  Automation,
  VolumeAutomation,
  PanAutomation,
  FilterAutomation,
  VolumePoint,
  PanPoint,
  FilterPoint,
  Effect,
  ReverbEffect,
  DelayEffect,
  EqEffect,
  LowpassEffect,
  EntityId,
  AssetPath,
} from '@gxaditya/vamp-schema';

export type {
  ValidationIssue,
  ValidationResult,
  ValidationSuccess,
  ValidationFailure,
  ValidateSongOptions,
  CapabilityCheckStatus,
  IssueCode,
  IssueSeverity,
  NormalizedSongV1,
  RenderedDurationEstimate,
  BackendCapabilities,
  SupportedSchemaVersion,
} from '@gxaditya/vamp-schema';

/* ------------------------------------------------------------------ *
 * Instrument registry and rendering (direct from @gxaditya/vamp-engine)
 * ------------------------------------------------------------------ */

export {
  describeInstrumentRegistry,
  getInstrumentRegistryEntry,
  isCuratedInstrumentId,
  CURATED_INSTRUMENT_IDS,
  GM_INSTRUMENT_CATALOG,
  GM_DRUM_NOTE_MAP,
  GM_STANDARD_DRUM_KIT,
  BGM_PRESETS,
  describeBgmPresets,
  getBgmPreset,
  createPresetSong,
  discoverSoundFont,
  selectAutomaticBackend,
  INSTRUMENT_REGISTRY_VERSION,
  INSTRUMENT_REGISTRY_VALIDATION,
  BUILTIN_SYNTH_BACKEND_ID,
  FLUIDSYNTH_BACKEND_ID,
  createBuiltinSynthBackend,
  createFluidSynthBackend,
  buildFluidSynthArguments,
  fluidSynthExecutableCandidates,
  isFluidSynthBinaryAvailable,
  renderSongArtifacts,
  renderSongAudio,
  renderSongToWav,
  compileSong,
  exportMidi,
  DEFAULT_RENDER_ARTIFACTS,
  SUPPORTED_SAMPLE_RATES,
} from '@gxaditya/vamp-engine';

export type {
  InstrumentRegistryDescription,
  InstrumentRegistryEntry,
  InstrumentCapabilities,
  GmPreset,
  GmPresetCategory,
  GmDrumAlias,
  BgmPresetDefinition,
  BgmPresetDescription,
  BgmPresetId,
  PresetSongOptions,
  AutomaticBackendSelection,
  AutomaticBackendOptions,
  DiscoveredSoundFont,
  AudioBackend,
  AudioBackendCapabilities,
  FluidSynthBackendConfig,
  SampleRate,
  SongTimeline,
  RenderSongArtifactsOptions,
  RenderSongArtifactsResult,
  RenderSongArtifactsSuccess,
  RenderSongArtifactsFailure,
  RenderSongArtifactsValidationFailure,
  RenderSongArtifactsCompileFailure,
  RenderSongArtifactsIssueFailure,
  RenderReport,
  RenderReportDuration,
  RenderArtifactReport,
  AudioIssue,
  CompileIssue,
  MidiExportResult,
} from '@gxaditya/vamp-engine';

/* ------------------------------------------------------------------ *
 * Project storage contracts (direct from @gxaditya/vamp-project)
 * ------------------------------------------------------------------ */

export {
  ProjectStore,
  PROJECT_ERROR_CODES,
  PROJECT_LAYOUT,
  isValidProjectId,
} from '@gxaditya/vamp-project';

export type {
  ProjectResult,
  ProjectError,
  ProjectErrorCode,
  ProjectSnapshot,
  ProjectSummary,
  ProjectLocation,
  ProjectStoreOptions,
  ProjectLimits,
  ProjectLimitsInput,
  CreateProjectOptions,
  UpdateSongOptions,
  AddTrackOptions,
  UpdateTrackOptions,
  RemoveTrackOptions,
  TrackChanges,
  AddNotesOptions,
  UpdateNoteOptions,
  RemoveNoteOptions,
  SetPatternOptions,
  RemovePatternOptions,
  SetInstrumentOptions,
  RevisionedProjectOptions,
  ResolvedRenderDirectory,
} from '@gxaditya/vamp-project';

/* ------------------------------------------------------------------ *
 * The thin typed client
 * ------------------------------------------------------------------ */

export {
  VampClient,
  type VampClientOptions,
  type ProjectRenderOptions,
  type ProjectRenderResult,
  type ProjectRenderSuccess,
} from './client.js';
