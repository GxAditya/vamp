/**
 * Offline audio surface for @gxaditya/vamp-engine.
 *
 * Task 06 provides the deterministic built-in synthesizer backend, a shared
 * mixer that applies track gain and equal-power pan, stereo Float32 PCM output,
 * and a 16-bit PCM WAV encoder. Task 07 adds the FluidSynth SoundFont backend,
 * its bounded asset resolver, and the neutral per-track MIDI path. Task 08 adds
 * per-sample volume and pan automation, cutoff automation, the complete v1
 * track effect chain (reverb, delay, EQ, low-pass), and its deterministic tail
 * behavior. Task 09 adds post-effect stem capture, complete master, stem, MIDI,
 * and report artifact output, local approximate loudness, and atomic
 * publication.
 */

export {
  AUTOMATION_RANGES,
  AUTOMATION_SMOOTHING_SECONDS,
  AUTOMATION_TARGETS,
  AutomationCurve,
  ParameterSmoother,
  createAutomationCurve,
  type AutomationCurveOptions,
  type AutomationCurvePoint,
  type AutomationTarget,
  type AutomationValueRange,
} from './automation.js';

export {
  EFFECT_PARAMETER_RANGES,
  EFFECT_TYPES,
  LOWPASS_CONTROL_BLOCK_SIZE,
  LOWPASS_CUTOFF_SMOOTHING_SECONDS,
  LOWPASS_NYQUIST_RATIO,
  MAX_EFFECTS_PER_TRACK,
  MAX_LOWPASS_PER_TRACK,
  isTransparentEffect,
  processEffectChain,
  type EffectChainOptions,
  type EffectParameterRange,
  type EffectType,
} from './effects.js';

export {
  AUDIO_VOICE_POLICIES,
  AUDIO_VOICE_POLICY,
  BUILTIN_SYNTH_BACKEND_ID,
  DEFAULT_MAX_VOICES_PER_TRACK,
  MAX_VOICES_PER_TRACK,
  emptyBackendTrackStats,
  type AudioBackend,
  type AudioBackendCapabilities,
  type AudioBackendTrackFailure,
  type AudioBackendTrackResult,
  type AudioBackendTrackStats,
  type AudioBackendTrackSuccess,
  type AudioTrackRenderRequest,
  type AudioVoicePolicy,
} from './backend.js';

export {
  BUILTIN_DRUM_MAP,
  MAX_BUILTIN_DRUM_PITCH,
  MIN_BUILTIN_DRUM_PITCH,
  type BuiltinDrumDefinition,
  type BuiltinDrumFamily,
} from './drums.js';

export {
  AUDIO_ERROR_CODES,
  AUDIO_ISSUE_CODES,
  AUDIO_WARNING_CODES,
  compareAudioIssues,
  createAudioIssue,
  normalizeAudioIssues,
  type AudioErrorCode,
  type AudioIssue,
  type AudioIssueCode,
  type AudioWarningCode,
} from './errors.js';

export {
  PCM_BUFFER_FORMAT,
  PCM_BUFFER_FORMAT_VERSION,
  renderTimelineAudio,
  type AudioRenderFailure,
  type AudioRenderOptions,
  type AudioRenderResult,
  type AudioRenderStats,
  type AudioRenderSuccess,
  type AudioTrackRenderStats,
  type StereoAudioBuffer,
  type TrackAudioCapture,
  type TrackAudioSink,
} from './render.js';

export {
  BUILTIN_SYNTH_BACKEND_CAPABILITIES,
  BUILTIN_SYNTH_INSTRUMENT_IDS,
  BUILTIN_SYNTH_VOICE_POLICY,
  createBuiltinSynthBackend,
  type BuiltinSynthInstrumentId,
} from './synth.js';

export {
  renderSongAudio,
  renderSongToWav,
  type SongAudioRenderAudioFailure,
  type SongAudioRenderCompileFailure,
  type SongAudioRenderFailure,
  type SongAudioRenderOptions,
  type SongAudioRenderResult,
  type SongAudioRenderSuccess,
  type SongAudioRenderValidationFailure,
  type SongWavEncodeFailure,
  type SongWavRenderFailure,
  type SongWavRenderResult,
  type SongWavRenderSuccess,
} from './song.js';

export {
  DEFAULT_MAX_SOUNDFONT_BYTES,
  MAX_ASSET_PATH_LENGTH,
  resolveProjectSoundFont,
  sha256File,
  validateTrustedSoundFont,
  type AssetResolution,
  type AssetValidationIssue,
  type ResolveProjectAssetOptions,
  type ResolvedAsset,
  type SoundFontOptions,
} from './assets.js';

export {
  selectAutomaticBackend,
  type AutomaticBackendId,
  type AutomaticBackendOptions,
  type AutomaticBackendSelection,
  type MissingSampleDependency,
} from './auto-backend.js';

export {
  SOUNDFONT_SETUP_HINT,
  discoverSoundFont,
  soundFontSearchDirectories,
  type DiscoveredSoundFont,
  type SoundFontDiscoveryOptions,
  type SoundFontDiscoveryResult,
  type SoundFontDiscoverySource,
} from './soundfont-discovery.js';

export {
  FLUIDSYNTH_BACKEND_CAPABILITIES,
  FLUIDSYNTH_DEFAULT_STREAM_BYTES,
  FLUIDSYNTH_DEFAULT_TIMEOUT_MS,
  FLUIDSYNTH_MAX_OUTPUT_BYTES,
  FLUIDSYNTH_OUTPUT_SLACK_BYTES,
  FLUIDSYNTH_VERSION_PROBE_TIMEOUT_MS,
  buildFluidSynthArguments,
  createFluidSynthBackend,
  describeFluidSynthConfig,
  fluidSynthExecutableCandidates,
  isFluidSynthBinaryAvailable,
  planVoiceCap,
  prepareFluidSynthTrack,
  probeFluidSynthVersion,
  type FluidSynthBackendConfig,
  type FluidSynthMidiSelection,
  type PrepareFluidSynthTrackResult,
  type PreparedFluidSynthTrack,
  type VoiceCapPlan,
} from './fluidsynth.js';

export {
  WAV_BIT_DEPTH,
  WAV_CHANNELS,
  WAV_FORMAT,
  WAV_FORMAT_VERSION,
  WAV_HEADER_BYTES,
  WAV_SAMPLE_ENCODING,
  encodeWav,
  type WavEncodeFailure,
  type WavEncodeResult,
  type WavEncodeSuccess,
  type WavReport,
} from './wav.js';

export {
  DEFAULT_RENDER_ARTIFACTS,
  MASTER_AUDIO_FILENAME,
  MAX_ARTIFACT_COUNT,
  MAX_MIDI_ARTIFACT_BYTES,
  MAX_REPORT_ARTIFACT_BYTES,
  MAX_RENDER_OUTPUT_BYTES,
  MAX_STEM_COUNT,
  MAX_TOTAL_ARTIFACT_BYTES,
  MAX_WAV_ARTIFACT_BYTES,
  MIDI_ARTIFACT_FILENAME,
  RENDER_REPORT_FORMAT,
  RENDER_REPORT_FORMAT_VERSION,
  REPORT_ARTIFACT_FILENAME,
  STEM_FILENAME_PREFIX,
  isSafeArtifactFileName,
  renderSongArtifacts,
  sanitizeTrackSlug,
  stemFileName,
  stemReconstructionToleranceLsb,
  type MasteringOptions,
  type RenderArtifactReport,
  type RenderReport,
  type RenderReportAssets,
  type RenderReportAudio,
  type RenderReportMastering,
  type RenderReportBackend,
  type RenderReportClipping,
  type RenderReportDuration,
  type RenderReportMidi,
  type RenderReportOutputs,
  type RenderReportProjectAsset,
  type RenderReportRegistryAsset,
  type RenderReportRun,
  type RenderReportStemInvariant,
  type RenderReportWarnings,
  type RenderSongArtifactsCompileFailure,
  type RenderSongArtifactsFailure,
  type RenderSongArtifactsIssueFailure,
  type RenderSongArtifactsOptions,
  type RenderSongArtifactsResult,
  type RenderSongArtifactsSuccess,
  type RenderSongArtifactsValidationFailure,
  type RenderStemReport,
  type StemArtifactPlan,
} from './artifacts.js';

export {
  LOUDNESS_ABSOLUTE_GATE_LUFS,
  LOUDNESS_BLOCK_SECONDS,
  LOUDNESS_HOP_SECONDS,
  LOUDNESS_LIMITATIONS,
  LOUDNESS_METHOD,
  LOUDNESS_METHOD_DESCRIPTION,
  LOUDNESS_RELATIVE_GATE_LU,
  measureIntegratedLoudness,
  type LoudnessMeasurement,
} from './loudness.js';
