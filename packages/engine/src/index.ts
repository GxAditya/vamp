/**
 * @gxaditya/vamp-engine public API.
 *
 * Task 04 provides the pure, deterministic song-to-timeline compiler, Task 05
 * exports that timeline as a Type 1 Standard MIDI File, Task 06 renders the
 * same timeline offline through the deterministic built-in synthesizer to
 * stereo Float32 PCM and 16-bit PCM WAV, Task 07 adds the authoritative
 * instrument registry and an explicitly selected FluidSynth SoundFont backend,
 * Task 08 adds shared volume, pan, and cutoff automation plus the complete
 * v1 track effect chain, and Task 09 adds master, stem, MIDI, and report
 * artifact rendering with local loudness analysis and atomic output. All
 * surfaces consume the one shared `SongTimeline`; the engine depends only on
 * `@gxaditya/vamp-schema`.
 */

export * from './audio/index.js';

export {
  CURATED_INSTRUMENT_IDS,
  FLUIDR3_GM_ASSET,
  FLUIDSYNTH_BACKEND_ID,
  GM_DRUM_NOTE_MAP,
  GM_INSTRUMENT_CATALOG,
  GM_STANDARD_DRUM_KIT,
  INSTRUMENT_REGISTRY,
  INSTRUMENT_REGISTRY_VALIDATION,
  INSTRUMENT_REGISTRY_VERSION,
  REGISTRY_ASSETS,
  SAMPLE_BACKEND_INSTRUMENT_TYPES,
  describeInstrumentRegistry,
  findGmPresetByProgram,
  getGmPreset,
  getInstrumentRegistryEntry,
  getRegistryAsset,
  isCuratedInstrumentId,
  type GmDrumAlias,
  type GmPreset,
  type GmPresetCategory,
  type GmStandardDrumKit,
  type InstrumentCapabilities,
  type InstrumentRegistryDescription,
  type InstrumentRegistryEntry,
  type RegistryAsset,
  type RegistryLicense,
  type RegistryProvenance,
  type SampleBackendMapping,
} from './instruments.js';

export {
  BGM_PRESETS,
  createPresetSong,
  describeBgmPresets,
  getBgmPreset,
  type BgmPresetDefinition,
  type BgmPresetDescription,
  type BgmPresetId,
  type PresetInstrumentRecipe,
  type PresetRole,
  type PresetSongOptions,
} from './presets.js';

export {
  COMPILE_LIMITS,
  compileSong,
  compileValidatedSong,
  type CompileLimits,
  type CompileSongCompileFailure,
  type CompileSongFailure,
  type CompileSongOptions,
  type CompileSongResult,
  type CompileSongSuccess,
  type CompileSongValidationFailure,
} from './compile.js';

export {
  MIDI_BANK_SELECT_LSB,
  MIDI_BANK_SELECT_MSB,
  MIDI_CONDUCTOR_TRACK_NAME,
  MIDI_DRUM_CHANNEL,
  MIDI_EXPORT_FORMAT,
  MIDI_EXPORT_FORMAT_VERSION,
  MIDI_FILE_FORMAT,
  MIDI_ISSUE_CODES,
  MIDI_LIMITATION_CODES,
  MIDI_MAX_AUTOMATION_POINTS,
  MIDI_MAX_EVENTS,
  MIDI_MAX_TRACKS,
  MIDI_PAN_CONTROLLER,
  MIDI_PPQ,
  MIDI_VOLUME_CONTROLLER,
  compareMidiIssues,
  createMidiIssue,
  exportMidi,
  normalizeMidiIssues,
  type MidiEndMarker,
  type MidiEventCounts,
  type MidiExportFailure,
  type MidiExportOptions,
  type MidiExportReport,
  type MidiExportResult,
  type MidiExportSuccess,
  type MidiIssue,
  type MidiIssueCode,
  type MidiKeySignatureReport,
  type MidiLimitation,
  type MidiLimitationCode,
  type MidiTrackReport,
} from './midi.js';

export {
  COMPILE_ISSUE_CODES,
  compareCompileIssues,
  createCompileIssue,
  normalizeCompileIssues,
  type CompileFailureIssue,
  type CompileIssue,
  type CompileIssueCode,
} from './errors.js';

export {
  TIMELINE_FORMAT,
  TIMELINE_FORMAT_VERSION,
  compareTimelineEvents,
  getTimelineBoundaries,
  type SongTimeline,
  type TimelineAutomation,
  type TimelineAutomationPoint,
  type TimelineBoundary,
  type TimelineEventSource,
  type TimelineMeta,
  type TimelineNoteEvent,
  type TimelineStats,
  type TimelineTrack,
} from './timeline.js';

export {
  SAMPLE_RATE_44_1,
  SAMPLE_RATE_48,
  SUPPORTED_SAMPLE_RATES,
  beatsToSamples,
  beatsToSeconds,
  getBeatsPerBar,
  getSecondsPerBeat,
  isSampleRate,
  secondsToFrames,
  secondsToSamples,
  type SampleRate,
} from './time.js';
