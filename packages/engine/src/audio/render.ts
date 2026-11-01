import { MAX_RENDER_SECONDS } from '@gxaditya/vamp-schema';

import type { SongTimeline, TimelineNoteEvent, TimelineTrack } from '../timeline.js';
import { isSampleRate, type SampleRate } from '../time.js';
import {
  AUTOMATION_RANGES,
  AUTOMATION_TARGETS,
  ParameterSmoother,
  createAutomationCurve,
  type AutomationCurve,
} from './automation.js';
import {
  AUDIO_VOICE_POLICIES,
  BUILTIN_SYNTH_BACKEND_ID,
  DEFAULT_MAX_VOICES_PER_TRACK,
  MAX_VOICES_PER_TRACK,
  type AudioBackend,
  type AudioBackendTrackStats,
  type AudioTrackRenderRequest,
  type AudioVoicePolicy,
} from './backend.js';
import {
  EFFECT_PARAMETER_RANGES,
  EFFECT_TYPES,
  MAX_EFFECTS_PER_TRACK,
  MAX_LOWPASS_PER_TRACK,
  isTransparentEffect,
  processEffectChain,
} from './effects.js';
import { createAudioIssue, normalizeAudioIssues, type AudioIssue } from './errors.js';
import { createBuiltinSynthBackend } from './synth.js';

/** Stable marker for a stereo Float32 PCM buffer. */
export const PCM_BUFFER_FORMAT = 'vamp.pcm' as const;

/** Current PCM buffer payload version, independent of schema and package versions. */
export const PCM_BUFFER_FORMAT_VERSION = 1 as const;

/** Mono renderer output widened to stereo by the shared mixer. */
export interface StereoAudioBuffer {
  readonly format: typeof PCM_BUFFER_FORMAT;
  readonly formatVersion: typeof PCM_BUFFER_FORMAT_VERSION;
  readonly sampleRate: SampleRate;
  readonly frameCount: number;
  readonly left: Float32Array;
  readonly right: Float32Array;
}

/**
 * One audible track's post-effect stereo output, captured immediately before it
 * is summed into the master.
 *
 * The channel arrays are the renderer's reusable scratch buffers. A sink must
 * consume them before it returns and must not retain them after the promise
 * settles, because the next track reuses the same allocation. The master value
 * at every frame is the float sum of the captured stereo pairs in track order.
 */
export interface TrackAudioCapture {
  readonly trackIndex: number;
  readonly trackId: string;
  readonly trackName: string;
  readonly sampleRate: SampleRate;
  readonly frameCount: number;
  readonly left: Float32Array;
  readonly right: Float32Array;
  /** Peak absolute post-effect stereo sample for this track. */
  readonly peak: number;
}

/** Receives one track's post-effect stereo audio while the render is running. */
export type TrackAudioSink = (capture: TrackAudioCapture) => void | Promise<void>;

export interface AudioTrackRenderStats {
  readonly trackIndex: number;
  readonly trackId: string;
  readonly instrumentType: string;
  readonly builtinId: string | null;
  readonly audible: boolean;
  readonly rendered: boolean;
  /** Audible timeline events considered for this track. */
  readonly eventCount: number;
  readonly startedVoices: number;
  readonly droppedVoices: number;
  readonly stolenVoices: number;
  readonly peakActiveVoices: number;
  readonly maxVoices: number;
  /** Peak absolute dry mono sample for this track, before gain and pan. */
  readonly peak: number;
}

export interface AudioRenderStats {
  readonly sampleRate: SampleRate;
  readonly frameCount: number;
  readonly channels: 2;
  readonly backendId: string;
  readonly voiceCapPolicy: AudioVoicePolicy;
  readonly maxVoicesPerTrack: number;
  readonly audibleTrackCount: number;
  readonly renderedTrackCount: number;
  readonly eventCount: number;
  readonly startedVoices: number;
  readonly droppedVoices: number;
  readonly stolenVoices: number;
  /** Peak absolute master sample in the linear -1 to 1-plus Float32 domain. */
  readonly peak: number;
  /** Peak in dBFS, or null for digital silence. Values above 1 report above 0 dBFS. */
  readonly peakDbfs: number | null;
  readonly tracks: readonly AudioTrackRenderStats[];
}

export interface AudioRenderSuccess {
  readonly ok: true;
  readonly audio: StereoAudioBuffer;
  readonly stats: AudioRenderStats;
  readonly warnings: readonly AudioIssue[];
}

export interface AudioRenderFailure {
  readonly ok: false;
  readonly errors: readonly AudioIssue[];
  readonly warnings: readonly AudioIssue[];
}

export type AudioRenderResult = AudioRenderSuccess | AudioRenderFailure;

export interface AudioRenderOptions {
  /**
   * Optional guard. When supplied it must be 44100 or 48000 and must equal the
   * timeline sample rate; the renderer never resamples.
   */
  readonly sampleRate?: SampleRate;
  /** Audio source. Defaults to the deterministic built-in synthesizer. */
  readonly backend?: AudioBackend;
  /**
   * Per-track active voice cap. Defaults to 32 and may not exceed 128.
   * The built-in backend drops the newest note start when the cap is full.
   */
  readonly maxVoicesPerTrack?: number;
  /**
   * Optional post-effect capture hook, called once per rendered audible track
   * before the next track starts. The capture arrays are reused, so consume
   * them synchronously or before the returned promise settles.
   */
  readonly onTrackAudio?: TrackAudioSink;
  /**
   * Optional cancellation signal. The renderer checks it before each track and
   * before returning success. A backend call already in progress is not
   * interrupted by this option.
   */
  readonly signal?: AbortSignal;
}

const RENDER_OPTION_KEYS = new Set([
  'sampleRate',
  'backend',
  'maxVoicesPerTrack',
  'onTrackAudio',
  'signal',
]);
const INSTRUMENT_TYPES = new Set(['builtin', 'gm', 'soundfont', 'sfz']);

interface ResolvedAudioOptions {
  readonly backend: AudioBackend;
  readonly maxVoicesPerTrack: number;
  readonly sampleRate?: SampleRate;
  readonly onTrackAudio?: TrackAudioSink;
  readonly signal?: AbortSignal;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeValue(value: unknown): string {
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' && Number.isNaN(value)) {
    return 'NaN';
  }
  return String(value);
}

function audioFailure(
  errors: readonly AudioIssue[],
  warnings: readonly AudioIssue[] = [],
): AudioRenderFailure {
  return {
    ok: false,
    errors: normalizeAudioIssues(errors),
    warnings: normalizeAudioIssues(warnings),
  };
}

function isAudioBackend(value: unknown): value is AudioBackend {
  if (!isRecord(value)) {
    return false;
  }
  if (
    typeof value.id !== 'string' ||
    value.id.length === 0 ||
    typeof value.name !== 'string' ||
    typeof value.description !== 'string' ||
    typeof value.renderTrack !== 'function'
  ) {
    return false;
  }
  const capabilities = value.capabilities;
  if (!isRecord(capabilities)) {
    return false;
  }
  const instrumentTypes = capabilities.instrumentTypes;
  const builtinIds = capabilities.builtinIds;
  return (
    Array.isArray(instrumentTypes) &&
    instrumentTypes.every((entry) => typeof entry === 'string' && INSTRUMENT_TYPES.has(entry)) &&
    Array.isArray(builtinIds) &&
    builtinIds.every((entry) => typeof entry === 'string') &&
    (AUDIO_VOICE_POLICIES as readonly unknown[]).includes(capabilities.voicePolicy)
  );
}

function resolveAudioOptions(
  options: unknown,
):
  | { readonly ok: true; readonly value: ResolvedAudioOptions }
  | { readonly ok: false; readonly errors: readonly AudioIssue[] } {
  const errors: AudioIssue[] = [];
  let values: Record<string, unknown> = {};

  if (options !== undefined) {
    if (isRecord(options)) {
      values = options;
    } else {
      errors.push(
        createAudioIssue(
          'audio.options.invalid',
          '',
          'Audio render options must be an object.',
          'Pass { sampleRate?, backend?, maxVoicesPerTrack?, onTrackAudio?, signal? } or omit the options.',
        ),
      );
    }
  }

  for (const key of Object.keys(values)) {
    if (!RENDER_OPTION_KEYS.has(key)) {
      errors.push(
        createAudioIssue(
          'audio.options.invalid',
          `/${key}`,
          `Unknown audio render option "${key}".`,
          'Use only sampleRate, backend, maxVoicesPerTrack, onTrackAudio, and signal. Unknown options are rejected rather than ignored.',
        ),
      );
    }
  }

  let sampleRate: SampleRate | undefined;
  if (values.sampleRate !== undefined) {
    if (isSampleRate(values.sampleRate)) {
      sampleRate = values.sampleRate;
    } else {
      errors.push(
        createAudioIssue(
          'audio.options.invalid',
          '/sampleRate',
          `Unsupported sampleRate ${describeValue(values.sampleRate)}. Supported rates: 44100, 48000.`,
          'Omit sampleRate to use the timeline rate, or pass 44100 or 48000. The renderer does not resample.',
          { supported: ['44100', '48000'] },
        ),
      );
    }
  }

  let backend: AudioBackend;
  if (values.backend === undefined) {
    backend = createBuiltinSynthBackend();
  } else if (isAudioBackend(values.backend)) {
    backend = values.backend;
  } else {
    errors.push(
      createAudioIssue(
        'audio.options.invalid',
        '/backend',
        'The audio backend option is not a valid AudioBackend.',
        'Pass an object with id, name, description, capabilities, and an async renderTrack method.',
      ),
    );
    backend = createBuiltinSynthBackend();
  }

  let maxVoicesPerTrack = DEFAULT_MAX_VOICES_PER_TRACK;
  if (values.maxVoicesPerTrack !== undefined) {
    const raw = values.maxVoicesPerTrack;
    if (
      typeof raw === 'number' &&
      Number.isInteger(raw) &&
      raw >= 1 &&
      raw <= MAX_VOICES_PER_TRACK
    ) {
      maxVoicesPerTrack = raw;
    } else {
      errors.push(
        createAudioIssue(
          'audio.options.invalid',
          '/maxVoicesPerTrack',
          `maxVoicesPerTrack must be an integer from 1 to ${MAX_VOICES_PER_TRACK}, received ${describeValue(raw)}.`,
          'Use a per-track voice cap within the documented hard limit, or omit the option to use 32.',
          { defaultMaxVoices: DEFAULT_MAX_VOICES_PER_TRACK, hardLimit: MAX_VOICES_PER_TRACK },
        ),
      );
    }
  }

  let onTrackAudio: TrackAudioSink | undefined;
  if (values.onTrackAudio !== undefined) {
    if (typeof values.onTrackAudio === 'function') {
      onTrackAudio = values.onTrackAudio as TrackAudioSink;
    } else {
      errors.push(
        createAudioIssue(
          'audio.options.invalid',
          '/onTrackAudio',
          'onTrackAudio must be a function.',
          'Pass a synchronous or asynchronous sink that consumes one post-effect stereo track buffer.',
        ),
      );
    }
  }

  let signal: AbortSignal | undefined;
  if (values.signal !== undefined) {
    if (
      typeof values.signal === 'object' &&
      values.signal !== null &&
      typeof (values.signal as { aborted?: unknown }).aborted === 'boolean'
    ) {
      signal = values.signal as AbortSignal;
    } else {
      errors.push(
        createAudioIssue(
          'audio.options.invalid',
          '/signal',
          'signal must be an AbortSignal.',
          'Pass the AbortSignal from an AbortController, or omit the option.',
        ),
      );
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      backend,
      maxVoicesPerTrack,
      ...(sampleRate === undefined ? {} : { sampleRate }),
      ...(onTrackAudio === undefined ? {} : { onTrackAudio }),
      ...(signal === undefined ? {} : { signal }),
    },
  };
}

function timelineIssue(path: string, message: string, hint: string): AudioIssue {
  return createAudioIssue('audio.timeline.invalid', path, message, hint);
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

const AUTOMATION_TARGET_SET: ReadonlySet<string> = new Set(AUTOMATION_TARGETS);
const EFFECT_TYPE_SET: ReadonlySet<string> = new Set(EFFECT_TYPES);

interface NumericRange {
  readonly minimum: number;
  readonly maximum: number;
}

function isFiniteInRange(value: unknown, range: NumericRange): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= range.minimum &&
    value <= range.maximum
  );
}

function effectParameterIssue(
  path: string,
  message: string,
  hint: string,
  params: Record<string, string | number | null>,
): AudioIssue {
  return createAudioIssue('audio.effects.invalid', path, message, hint, params);
}

function automationParameterIssue(
  path: string,
  message: string,
  hint: string,
  params: Record<string, string | number | null>,
): AudioIssue {
  return createAudioIssue('audio.automation.invalid', path, message, hint, params);
}

function checkEffectParameter(
  issues: AudioIssue[],
  path: string,
  effectType: string,
  parameter: string,
  value: unknown,
  range: NumericRange,
): void {
  if (isFiniteInRange(value, range)) {
    return;
  }
  issues.push(
    effectParameterIssue(
      path,
      `The ${effectType} effect parameter ${parameter} is ${describeValue(value)}, outside the supported ${range.minimum} to ${range.maximum}.`,
      `Use a finite ${parameter} from ${range.minimum} to ${range.maximum}. The schema guide documents the v1 effect ranges and defaults.`,
      {
        effectType,
        parameter,
        value: typeof value === 'number' ? value : null,
        minimum: range.minimum,
        maximum: range.maximum,
      },
    ),
  );
}

/**
 * Validate normalized effects and automation on one track before DSP.
 *
 * The song validator already enforces these rules. This pass protects
 * `renderTimelineAudio` from a forged timeline and returns stable, repairable
 * issues instead of letting a bad parameter reach an effect processor.
 */
function auditTrackChain(
  track: TimelineTrack,
  trackPath: string,
  secondsPerBeat: number,
): AudioIssue[] {
  const issues: AudioIssue[] = [];

  if (track.effects.length > MAX_EFFECTS_PER_TRACK) {
    issues.push(
      effectParameterIssue(
        `${trackPath}/effects`,
        `Track "${track.id}" has ${track.effects.length} effects, above the supported maximum of ${MAX_EFFECTS_PER_TRACK}.`,
        `Reduce the track to at most ${MAX_EFFECTS_PER_TRACK} effects in processing order.`,
        {
          trackId: track.id,
          effectCount: track.effects.length,
          maximum: MAX_EFFECTS_PER_TRACK,
        },
      ),
    );
  }

  const lowpassIndices: number[] = [];
  const effectsToInspect =
    track.effects.length > MAX_EFFECTS_PER_TRACK
      ? track.effects.slice(0, MAX_EFFECTS_PER_TRACK)
      : track.effects;

  effectsToInspect.forEach((effect, index) => {
    const path = `${trackPath}/effects/${index}`;
    const type: unknown = effect.type;
    if (typeof type !== 'string' || !EFFECT_TYPE_SET.has(type)) {
      issues.push(
        effectParameterIssue(
          path,
          `The effect at index ${index} has unknown type ${describeValue(type)}.`,
          'Use one of reverb, delay, eq, or lowpass. Recompile the song with the shared schema validator.',
          { trackId: track.id, effectType: typeof type === 'string' ? type : null },
        ),
      );
      return;
    }

    switch (effect.type) {
      case 'reverb': {
        checkEffectParameter(
          issues,
          `${path}/mix`,
          effect.type,
          'mix',
          effect.mix,
          EFFECT_PARAMETER_RANGES.reverb.mix,
        );
        checkEffectParameter(
          issues,
          `${path}/decaySeconds`,
          effect.type,
          'decaySeconds',
          effect.decaySeconds,
          EFFECT_PARAMETER_RANGES.reverb.decaySeconds,
        );
        break;
      }
      case 'delay': {
        checkEffectParameter(
          issues,
          `${path}/timeMs`,
          effect.type,
          'timeMs',
          effect.timeMs,
          EFFECT_PARAMETER_RANGES.delay.timeMs,
        );
        checkEffectParameter(
          issues,
          `${path}/feedback`,
          effect.type,
          'feedback',
          effect.feedback,
          EFFECT_PARAMETER_RANGES.delay.feedback,
        );
        checkEffectParameter(
          issues,
          `${path}/mix`,
          effect.type,
          'mix',
          effect.mix,
          EFFECT_PARAMETER_RANGES.delay.mix,
        );
        break;
      }
      case 'eq': {
        checkEffectParameter(
          issues,
          `${path}/lowGainDb`,
          effect.type,
          'lowGainDb',
          effect.lowGainDb,
          EFFECT_PARAMETER_RANGES.eq.lowGainDb,
        );
        checkEffectParameter(
          issues,
          `${path}/midGainDb`,
          effect.type,
          'midGainDb',
          effect.midGainDb,
          EFFECT_PARAMETER_RANGES.eq.midGainDb,
        );
        checkEffectParameter(
          issues,
          `${path}/highGainDb`,
          effect.type,
          'highGainDb',
          effect.highGainDb,
          EFFECT_PARAMETER_RANGES.eq.highGainDb,
        );
        break;
      }
      case 'lowpass': {
        lowpassIndices.push(index);
        if (effect.cutoffHz !== undefined) {
          checkEffectParameter(
            issues,
            `${path}/cutoffHz`,
            effect.type,
            'cutoffHz',
            effect.cutoffHz,
            EFFECT_PARAMETER_RANGES.lowpass.cutoffHz,
          );
        }
        checkEffectParameter(
          issues,
          `${path}/q`,
          effect.type,
          'q',
          effect.q,
          EFFECT_PARAMETER_RANGES.lowpass.q,
        );
        break;
      }
    }
  });

  if (lowpassIndices.length > MAX_LOWPASS_PER_TRACK) {
    issues.push(
      effectParameterIssue(
        `${trackPath}/effects`,
        `Track "${track.id}" has ${lowpassIndices.length} low-pass effects, above the supported maximum of ${MAX_LOWPASS_PER_TRACK}.`,
        'Keep at most one low-pass effect per track so filterCutoffHz automation has one unambiguous target.',
        {
          trackId: track.id,
          lowpassCount: lowpassIndices.length,
          maximum: MAX_LOWPASS_PER_TRACK,
        },
      ),
    );
  }

  const automation = track.automation;
  for (const key of Object.keys(automation)) {
    if (!AUTOMATION_TARGET_SET.has(key)) {
      issues.push(
        automationParameterIssue(
          `${trackPath}/automation/${key}`,
          `Unknown automation target "${key}" on track "${track.id}".`,
          'Use only volume, pan, and filterCutoffHz. Recompile the song with the shared schema validator.',
          { trackId: track.id, target: key },
        ),
      );
    }
  }

  for (const target of AUTOMATION_TARGETS) {
    const rawPoints: unknown = automation[target];
    if (rawPoints === undefined) {
      continue;
    }
    const path = `${trackPath}/automation/${target}`;
    if (!Array.isArray(rawPoints)) {
      issues.push(
        automationParameterIssue(
          path,
          `The ${target} automation must be an array of keyframes.`,
          'Author automation as a list of { time, value } points and recompile the song.',
          { trackId: track.id, target },
        ),
      );
      continue;
    }

    const points: readonly unknown[] = rawPoints;
    if (points.length < 1 || points.length > 512) {
      issues.push(
        automationParameterIssue(
          path,
          `The ${target} automation has ${points.length} points; the supported range is 1 to 512.`,
          'Keep between 1 and 512 keyframes per target.',
          { trackId: track.id, target, pointCount: points.length },
        ),
      );
      continue;
    }

    const valueRange = AUTOMATION_RANGES[target];
    let previousBeats = Number.NEGATIVE_INFINITY;
    let previousSeconds = Number.NEGATIVE_INFINITY;

    points.forEach((point, index) => {
      const pointPath = `${path}/${index}`;
      if (!isRecord(point)) {
        issues.push(
          automationParameterIssue(
            pointPath,
            `The ${target} automation point at index ${index} is not an object.`,
            'Each point must carry a finite time and value.',
            { trackId: track.id, target, pointIndex: index },
          ),
        );
        return;
      }

      const timeBeats = point.timeBeats;
      const timeSeconds = point.timeSeconds;
      const value = point.value;

      if (!isFiniteInRange(timeBeats, { minimum: 0, maximum: 12000 })) {
        issues.push(
          automationParameterIssue(
            `${pointPath}/timeBeats`,
            `The ${target} automation point at index ${index} has timeBeats ${describeValue(timeBeats)}, outside 0 to 12000 beats.`,
            'Use a finite keyframe time within the song length and recompile the song.',
            {
              trackId: track.id,
              target,
              pointIndex: index,
              value: typeof timeBeats === 'number' ? timeBeats : null,
            },
          ),
        );
      }
      if (typeof timeSeconds !== 'number' || !Number.isFinite(timeSeconds) || timeSeconds < 0) {
        issues.push(
          automationParameterIssue(
            `${pointPath}/timeSeconds`,
            `The ${target} automation point at index ${index} has invalid timeSeconds ${describeValue(timeSeconds)}.`,
            'Recompile the song so the shared compiler derives timeSeconds from the beat position.',
            {
              trackId: track.id,
              target,
              pointIndex: index,
              value: typeof timeSeconds === 'number' ? timeSeconds : null,
            },
          ),
        );
      } else if (typeof timeBeats === 'number' && Number.isFinite(timeBeats)) {
        const expected = timeBeats * secondsPerBeat;
        if (Math.abs(timeSeconds - expected) > 1e-9 * Math.max(1, Math.abs(expected))) {
          issues.push(
            automationParameterIssue(
              `${pointPath}/timeSeconds`,
              `The ${target} automation point at index ${index} has timeSeconds ${timeSeconds}, inconsistent with ${expected} at the song tempo.`,
              'Recompile the song. Automation times must come from the shared timeline compiler.',
              { trackId: track.id, target, pointIndex: index },
            ),
          );
        }
      }

      if (!isFiniteInRange(value, valueRange)) {
        issues.push(
          automationParameterIssue(
            `${pointPath}/value`,
            `The ${target} automation point at index ${index} has value ${describeValue(value)}, outside ${valueRange.minimum} to ${valueRange.maximum}.`,
            `Use an absolute ${target} value from ${valueRange.minimum} to ${valueRange.maximum}.`,
            {
              trackId: track.id,
              target,
              pointIndex: index,
              value: typeof value === 'number' ? value : null,
              minimum: valueRange.minimum,
              maximum: valueRange.maximum,
            },
          ),
        );
      }

      if (typeof timeBeats === 'number' && Number.isFinite(timeBeats)) {
        if (timeBeats <= previousBeats) {
          issues.push(
            automationParameterIssue(
              `${pointPath}/timeBeats`,
              `The ${target} automation times must be strictly increasing; index ${index} repeats or precedes its predecessor.`,
              'Sort keyframes by time and remove duplicate times.',
              { trackId: track.id, target, pointIndex: index },
            ),
          );
        }
        previousBeats = timeBeats;
      }
      if (typeof timeSeconds === 'number' && Number.isFinite(timeSeconds)) {
        if (timeSeconds <= previousSeconds) {
          issues.push(
            automationParameterIssue(
              `${pointPath}/timeSeconds`,
              `The ${target} automation timeSeconds values must be strictly increasing; index ${index} repeats or precedes its predecessor.`,
              'Sort keyframes by time and remove duplicate times.',
              { trackId: track.id, target, pointIndex: index },
            ),
          );
        }
        previousSeconds = timeSeconds;
      }
    });
  }

  const hasFilterAutomation = automation.filterCutoffHz !== undefined;
  if (hasFilterAutomation) {
    if (lowpassIndices.length !== MAX_LOWPASS_PER_TRACK) {
      issues.push(
        automationParameterIssue(
          `${trackPath}/automation/filterCutoffHz`,
          `Track "${track.id}" has filterCutoffHz automation but ${lowpassIndices.length} low-pass effects.`,
          'Add exactly one lowpass effect and omit its cutoffHz. Filter automation needs one unambiguous target.',
          { trackId: track.id, lowpassCount: lowpassIndices.length },
        ),
      );
    } else {
      const lowpassIndex = lowpassIndices[0];
      const lowpass = lowpassIndex === undefined ? undefined : track.effects[lowpassIndex];
      if (lowpass !== undefined && lowpass.type === 'lowpass' && lowpass.cutoffHz !== undefined) {
        issues.push(
          automationParameterIssue(
            `${trackPath}/effects/${lowpassIndex}/cutoffHz`,
            `Track "${track.id}" has both a static low-pass cutoff and filterCutoffHz automation.`,
            'Omit cutoffHz on the low-pass effect when cutoff automation is present.',
            { trackId: track.id, lowpassIndex: lowpassIndex ?? null },
          ),
        );
      }
    }
  } else {
    for (const lowpassIndex of lowpassIndices) {
      const lowpass = track.effects[lowpassIndex];
      if (lowpass !== undefined && lowpass.type === 'lowpass' && lowpass.cutoffHz === undefined) {
        issues.push(
          automationParameterIssue(
            `${trackPath}/effects/${lowpassIndex}/cutoffHz`,
            `The low-pass effect at index ${lowpassIndex} on track "${track.id}" has no static cutoff and no cutoff automation.`,
            'Set cutoffHz from 20 to 20000, or add filterCutoffHz automation and omit cutoffHz.',
            { trackId: track.id, lowpassIndex },
          ),
        );
      }
    }
  }

  return issues;
}

interface TrackAutomationCurves {
  readonly volume: AutomationCurve | null;
  readonly pan: AutomationCurve | null;
  readonly filterCutoffHz: AutomationCurve | null;
}

function buildTrackAutomation(track: TimelineTrack, sampleRate: SampleRate): TrackAutomationCurves {
  const automation = track.automation;
  return {
    volume:
      automation.volume === undefined
        ? null
        : createAutomationCurve(automation.volume, { target: 'volume', sampleRate }),
    pan:
      automation.pan === undefined
        ? null
        : createAutomationCurve(automation.pan, { target: 'pan', sampleRate }),
    filterCutoffHz:
      automation.filterCutoffHz === undefined
        ? null
        : createAutomationCurve(automation.filterCutoffHz, {
            target: 'filterCutoffHz',
            sampleRate,
          }),
  };
}

/**
 * True when a track needs no effect processing and no moving automation.
 *
 * Such a track takes the exact Task 06 mix path. No-effects tracks, tracks
 * whose entire chain is documented as transparent (`mix: 0` time effects and
 * an all-zero EQ), and constant automation that equals the resolved static
 * value are rendered with the same arithmetic as the original dry mixer.
 */
function isEffectivelyDry(track: TimelineTrack, automation: TrackAutomationCurves): boolean {
  for (const effect of track.effects) {
    if (!isTransparentEffect(effect)) {
      return false;
    }
  }
  if (automation.filterCutoffHz !== null) {
    return false;
  }
  if (
    automation.volume !== null &&
    (automation.volume.constantValue === null || automation.volume.constantValue !== track.volume)
  ) {
    return false;
  }
  if (
    automation.pan !== null &&
    (automation.pan.constantValue === null || automation.pan.constantValue !== track.pan)
  ) {
    return false;
  }
  return true;
}

const PAN_TABLE_SIZE = 4096;
const PAN_LEFT_TABLE = new Float64Array(PAN_TABLE_SIZE + 1);
const PAN_RIGHT_TABLE = new Float64Array(PAN_TABLE_SIZE + 1);

for (let index = 0; index <= PAN_TABLE_SIZE; index += 1) {
  const angle = (index / PAN_TABLE_SIZE) * (Math.PI / 2);
  PAN_LEFT_TABLE[index] = Math.cos(angle);
  PAN_RIGHT_TABLE[index] = Math.sin(angle);
}

function panTablePosition(pan: number): number {
  const clamped = pan < -1 ? -1 : pan > 1 ? 1 : pan;
  return (clamped + 1) * 0.5 * PAN_TABLE_SIZE;
}

/**
 * Equal-power pan gains for automated pan. A 4097-entry cosine table is
 * linearly interpolated, which is exact at the three cardinal positions and
 * within about 1e-8 elsewhere. Static pan uses the direct formula so existing
 * renders keep their exact arithmetic.
 */
function automatedPanLeftGain(pan: number): number {
  if (!Number.isFinite(pan)) {
    return Math.cos(((pan + 1) * Math.PI) / 4);
  }
  const position = panTablePosition(pan);
  const index = Math.min(PAN_TABLE_SIZE - 1, Math.max(0, Math.floor(position)));
  const fraction = position - index;
  const current = PAN_LEFT_TABLE[index] ?? 0;
  const next = PAN_LEFT_TABLE[index + 1] ?? current;
  return current + (next - current) * fraction;
}

function automatedPanRightGain(pan: number): number {
  if (!Number.isFinite(pan)) {
    return Math.sin(((pan + 1) * Math.PI) / 4);
  }
  const position = panTablePosition(pan);
  const index = Math.min(PAN_TABLE_SIZE - 1, Math.max(0, Math.floor(position)));
  const fraction = position - index;
  const current = PAN_RIGHT_TABLE[index] ?? 0;
  const next = PAN_RIGHT_TABLE[index + 1] ?? current;
  return current + (next - current) * fraction;
}

/**
 * Return the pan gains for an automation value. A flat pan curve is evaluated
 * once with the same direct formula as a static pan.
 */
function constantPanGains(pan: number): { readonly left: number; readonly right: number } {
  return {
    left: Math.cos(((pan + 1) * Math.PI) / 4),
    right: Math.sin(((pan + 1) * Math.PI) / 4),
  };
}

function validateTimeline(
  timeline: unknown,
):
  | { readonly ok: true; readonly timeline: SongTimeline }
  | { readonly ok: false; readonly errors: readonly AudioIssue[] } {
  if (!isRecord(timeline)) {
    return {
      ok: false,
      errors: [
        timelineIssue(
          '',
          'Audio rendering requires a SongTimeline object.',
          'Call compileSong or compileValidatedSong and pass its timeline.',
        ),
      ],
    };
  }

  const errors: AudioIssue[] = [];
  const push = (path: string, message: string, hint: string): void => {
    errors.push(timelineIssue(path, message, hint));
  };

  if (timeline.format !== 'vamp.timeline' || timeline.formatVersion !== 1) {
    push(
      '',
      'The value is not a version 1 Vamp timeline.',
      'Pass the timeline returned by the shared compiler.',
    );
  }
  if (timeline.schemaVersion !== '1.0.0') {
    push(
      '/schemaVersion',
      'The timeline schemaVersion is not "1.0.0".',
      'Compile a SongSchemaV1 song.',
    );
  }
  if (!isSampleRate(timeline.sampleRate)) {
    push(
      '/sampleRate',
      'The timeline sampleRate is not 44100 or 48000.',
      'Compile the song at a supported sample rate.',
    );
  }
  if (!isSafeNonNegativeInteger(timeline.renderedSamples)) {
    push(
      '/renderedSamples',
      'The timeline renderedSamples must be a non-negative safe integer.',
      'Recompile the song. The rendered frame count comes from the shared duration formula.',
    );
  }

  if (!isRecord(timeline.meta)) {
    push(
      '/meta',
      'The timeline meta must be an object carrying the song seed.',
      'Recompile the song.',
    );
  } else if (
    typeof timeline.meta.seed !== 'number' ||
    !Number.isInteger(timeline.meta.seed) ||
    timeline.meta.seed < 0 ||
    timeline.meta.seed > 4294967295
  ) {
    push(
      '/meta/seed',
      'The timeline seed must be an unsigned 32-bit integer.',
      'Recompile the song with an explicit seed.',
    );
  }

  const tracks = timeline.tracks;
  const events = timeline.events;
  if (!Array.isArray(tracks) || tracks.length < 1 || tracks.length > 16) {
    push(
      '/tracks',
      'The timeline must contain 1 to 16 tracks.',
      'Compile a validated SongSchemaV1 song.',
    );
  }
  if (!Array.isArray(events)) {
    push('/events', 'The timeline events must be an array.', 'Compile a canonical timeline.');
  } else if (events.length > 20_000) {
    push(
      '/events',
      'The timeline contains more than 20,000 events.',
      'Reduce note count or split the song.',
    );
  }

  const trackList =
    Array.isArray(tracks) && tracks.length >= 1 && tracks.length <= 16 ? tracks : [];
  const eventList =
    Array.isArray(events) && events.length <= 20_000 && trackList.length > 0 ? events : [];

  if (
    isSampleRate(timeline.sampleRate) &&
    isSafeNonNegativeInteger(timeline.renderedSamples) &&
    timeline.renderedSamples > MAX_RENDER_SECONDS * timeline.sampleRate
  ) {
    push(
      '/renderedSamples',
      `The render length exceeds the ${MAX_RENDER_SECONDS} second audio bound.`,
      'Shorten durationHint or content, or split the song.',
    );
  }

  const secondsPerBeat =
    typeof timeline.secondsPerBeat === 'number' &&
    Number.isFinite(timeline.secondsPerBeat) &&
    timeline.secondsPerBeat > 0
      ? timeline.secondsPerBeat
      : null;
  if (secondsPerBeat === null) {
    push(
      '/secondsPerBeat',
      'The timeline secondsPerBeat must be a positive finite number for automation timing.',
      'Recompile the song so the shared compiler derives tempo from meta.bpm.',
    );
  }

  for (let index = 0; index < trackList.length; index += 1) {
    const track = trackList[index];
    const path = `/tracks/${index}`;
    if (!isRecord(track)) {
      push(path, 'The track is not an object.', 'Recompile the song.');
      continue;
    }
    let chainStructureOk = true;
    if (track.index !== index) {
      push(
        `${path}/index`,
        'track.index does not match its array position.',
        'Keep timeline tracks in authoring order.',
      );
    }
    if (typeof track.id !== 'string' || track.id.length === 0) {
      push(`${path}/id`, 'The track id must be a non-empty string.', 'Recompile the song.');
      chainStructureOk = false;
    }
    if (typeof track.audible !== 'boolean') {
      push(
        `${path}/audible`,
        'The resolved track audibility flag must be a boolean.',
        'Recompile the song.',
      );
    }
    if (track.kind !== 'midi' && track.kind !== 'drums') {
      push(`${path}/kind`, 'The track kind must be "midi" or "drums".', 'Recompile the song.');
    }
    if (!isSafeNonNegativeInteger(track.channel) || track.channel > 15) {
      push(
        `${path}/channel`,
        'The track channel must be an integer from 0 to 15.',
        'Recompile the song.',
      );
    }
    if (
      typeof track.volume !== 'number' ||
      !Number.isFinite(track.volume) ||
      track.volume < 0 ||
      track.volume > 2
    ) {
      push(
        `${path}/volume`,
        'The resolved track volume must be finite and between 0 and 2.',
        'Recompile the song.',
      );
    }
    if (
      typeof track.pan !== 'number' ||
      !Number.isFinite(track.pan) ||
      track.pan < -1 ||
      track.pan > 1
    ) {
      push(
        `${path}/pan`,
        'The resolved track pan must be finite and between -1 and 1.',
        'Recompile the song.',
      );
    }
    if (!Array.isArray(track.effects)) {
      push(`${path}/effects`, 'The track effects must be an array.', 'Recompile the song.');
      chainStructureOk = false;
    } else {
      const effectStructureLimit = Math.min(track.effects.length, MAX_EFFECTS_PER_TRACK);
      for (let effectIndex = 0; effectIndex < effectStructureLimit; effectIndex += 1) {
        const effect = track.effects[effectIndex];
        if (!isRecord(effect) || typeof effect.type !== 'string' || effect.type.length === 0) {
          push(
            `${path}/effects/${effectIndex}`,
            `The effect at index ${effectIndex} must be an object with a non-empty string type.`,
            'Recompile the song. Each effect must declare a string "type" such as "reverb", "delay", "eq", or "lowpass".',
          );
          chainStructureOk = false;
        }
      }
    }
    if (!isRecord(track.automation)) {
      push(`${path}/automation`, 'The track automation must be an object.', 'Recompile the song.');
      chainStructureOk = false;
    }
    if (chainStructureOk && secondsPerBeat !== null) {
      errors.push(...auditTrackChain(track as unknown as TimelineTrack, path, secondsPerBeat));
    }
    if (!isRecord(track.instrument) || !INSTRUMENT_TYPES.has(String(track.instrument.type))) {
      push(
        `${path}/instrument`,
        'The track instrument must be a builtin, gm, soundfont, or sfz reference.',
        'Recompile the song.',
      );
    } else if (track.instrument.type === 'builtin' && typeof track.instrument.id !== 'string') {
      push(
        `${path}/instrument/id`,
        'A builtin instrument must have a string id.',
        'Recompile the song.',
      );
    }
  }

  for (let index = 0; index < eventList.length; index += 1) {
    const event = eventList[index];
    const path = `/events/${index}`;
    if (!isRecord(event)) {
      push(path, 'The event is not an object.', 'Recompile the song.');
      continue;
    }
    if (typeof event.id !== 'string' || event.id.length === 0) {
      push(`${path}/id`, 'The event id must be a non-empty string.', 'Recompile the song.');
    }
    if (!isSafeNonNegativeInteger(event.trackIndex) || event.trackIndex >= trackList.length) {
      push(
        `${path}/trackIndex`,
        'The event trackIndex does not resolve to a timeline track.',
        'Recompile the song.',
      );
      continue;
    }
    const track = trackList[event.trackIndex];
    if (isRecord(track) && event.trackId !== track.id) {
      push(
        `${path}/trackId`,
        'The event trackId does not match its timeline track.',
        'Recompile the song.',
      );
    }
    if (!isSafeNonNegativeInteger(event.pitch) || event.pitch > 127) {
      push(
        `${path}/pitch`,
        'The event pitch must be an integer from 0 to 127.',
        'Recompile the song.',
      );
    }
    if (!isSafeNonNegativeInteger(event.velocity) || event.velocity < 1 || event.velocity > 127) {
      push(
        `${path}/velocity`,
        'The event velocity must be an integer from 1 to 127.',
        'Recompile the song.',
      );
    }
    if (!isSafeNonNegativeInteger(event.startSample)) {
      push(
        `${path}/startSample`,
        'The event startSample must be a non-negative safe integer.',
        'Recompile the song.',
      );
    }
    if (!isSafeNonNegativeInteger(event.endSample) || !isSafeInteger(event.startSample)) {
      push(
        `${path}/endSample`,
        'The event endSample must be a non-negative safe integer.',
        'Recompile the song.',
      );
    } else if (event.endSample < event.startSample) {
      push(
        `${path}/endSample`,
        'The event endSample must not precede startSample.',
        'Recompile the song.',
      );
    }
    if (typeof event.audible !== 'boolean') {
      push(
        `${path}/audible`,
        'The event audibility flag must be a boolean.',
        'Recompile the song.',
      );
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, timeline: timeline as unknown as SongTimeline };
}

function instrumentDescription(track: TimelineTrack): { type: string; builtinId: string | null } {
  return {
    type: track.instrument.type,
    builtinId: track.instrument.type === 'builtin' ? track.instrument.id : null,
  };
}

function capabilityErrors(timeline: SongTimeline, backend: AudioBackend): AudioIssue[] {
  const errors: AudioIssue[] = [];
  const supportedTypes = new Set(backend.capabilities.instrumentTypes);
  const supportedBuiltins = new Set(backend.capabilities.builtinIds);

  for (const track of timeline.tracks) {
    const path = `/tracks/${track.index}`;

    // Effects and automation are implemented by the shared DSP layer, so no
    // instrument backend is asked to participate and no backend capability flag
    // can reject them. Backends remain dry mono voice sources.
    const instrument = track.instrument;
    const isBuiltinSynth = backend.id === BUILTIN_SYNTH_BACKEND_ID;
    if (!supportedTypes.has(instrument.type)) {
      errors.push(
        createAudioIssue(
          'audio.instrument.unsupported_variant',
          `${path}/instrument`,
          isBuiltinSynth
            ? `The ${backend.id} backend has no sample playback engine and cannot render the "${instrument.type}" instrument on track "${track.id}".`
            : `The ${backend.id} backend does not support "${instrument.type}" instruments on track "${track.id}".`,
          isBuiltinSynth
            ? 'Use a builtin instrument, or pass the FluidSynth sample backend through AudioRenderOptions.backend for gm and soundfont instruments. SFZ is not supported by the v1 sample backend. Silent substitution is not performed.'
            : `Use one of the backend-supported variants: ${backend.capabilities.instrumentTypes.join(', ') || 'none'}. Silent substitution is not performed.`,
          { backendId: backend.id, variant: instrument.type, trackId: track.id },
        ),
      );
    } else if (instrument.type === 'builtin' && !supportedBuiltins.has(instrument.id)) {
      errors.push(
        createAudioIssue(
          'audio.instrument.unknown_builtin',
          `${path}/instrument/id`,
          `The ${backend.id} backend does not provide builtin instrument "${instrument.id}" on track "${track.id}".`,
          `Use one of: ${backend.capabilities.builtinIds.join(', ') || 'no builtin IDs'}. A backend-specific mapping may add IDs, and this backend never substitutes another instrument.`,
          { backendId: backend.id, trackId: track.id, instrumentId: instrument.id },
        ),
      );
    }
  }

  return errors;
}

function isAudioIssue(value: unknown, severity: 'error' | 'warning'): value is AudioIssue {
  return (
    isRecord(value) &&
    typeof value.code === 'string' &&
    value.severity === severity &&
    typeof value.path === 'string' &&
    typeof value.message === 'string' &&
    typeof value.hint === 'string'
  );
}

function isValidBackendStats(value: unknown, maxVoices: number): value is AudioBackendTrackStats {
  if (!isRecord(value)) {
    return false;
  }
  const fields = ['startedVoices', 'droppedVoices', 'stolenVoices', 'peakActiveVoices'];
  for (const field of fields) {
    const entry = value[field];
    if (typeof entry !== 'number' || !Number.isSafeInteger(entry) || entry < 0) {
      return false;
    }
  }
  return (value.peakActiveVoices as number) <= maxVoices;
}

function toDbfs(peak: number): number | null {
  if (!(peak > 0)) {
    return null;
  }
  return 20 * Math.log10(peak);
}

function backendInvalidOutput(
  backend: AudioBackend,
  track: TimelineTrack,
  detail: string,
): AudioIssue {
  return createAudioIssue(
    'audio.backend.invalid_output',
    `/tracks/${track.index}`,
    `The ${backend.id} backend returned invalid output for track "${track.id}": ${detail}`,
    'Fix the backend to return exactly frameCount finite mono samples plus valid voice stats and warnings.',
    { backendId: backend.id, trackId: track.id },
  );
}

/**
 * Render a compiled timeline to stereo Float32 PCM.
 *
 * The timeline is consumed directly. This function does not validate the song,
 * expand patterns, resolve mute/solo, or recompute duration or tails. It checks
 * only the container shape needed to prevent crashes and to reject forged input,
 * including effect parameters and automation keyframes that could destabilize
 * the DSP.
 *
 * Processing order per audible track is: backend dry mono voices -> per-sample
 * volume (static or automated) -> equal-power pan (static or automated) ->
 * track effects in authored order -> master sum. There is no master effect
 * chain, send, normalization, limiter, compressor, or hidden clipping.
 */
export async function renderTimelineAudio(
  timeline: unknown,
  options?: AudioRenderOptions,
): Promise<AudioRenderResult> {
  const resolvedOptions = resolveAudioOptions(options);
  if (!resolvedOptions.ok) {
    return audioFailure(resolvedOptions.errors);
  }
  const resolved = resolvedOptions.value;

  const validatedTimeline = validateTimeline(timeline);
  if (!validatedTimeline.ok) {
    return audioFailure(validatedTimeline.errors);
  }
  const song = validatedTimeline.timeline;

  if (resolved.sampleRate !== undefined && resolved.sampleRate !== song.sampleRate) {
    return audioFailure([
      createAudioIssue(
        'audio.sample_rate.mismatch',
        '/sampleRate',
        `The timeline sample rate ${song.sampleRate} does not match the requested rate ${resolved.sampleRate}.`,
        'Compile the song at the requested sample rate or omit sampleRate. Audio is never resampled implicitly.',
        { timelineSampleRate: song.sampleRate, requestedSampleRate: resolved.sampleRate },
      ),
    ]);
  }

  const backend = resolved.backend;
  const capabilityIssues = capabilityErrors(song, backend);
  if (capabilityIssues.length > 0) {
    return audioFailure(capabilityIssues);
  }

  const frameCount = song.renderedSamples;
  const left = new Float32Array(frameCount);
  const right = new Float32Array(frameCount);
  // One post-effect stereo scratch pair, allocated only when a track needs
  // automation, real effects, or a capture sink, and reused across tracks.
  let trackLeft: Float32Array | null = null;
  let trackRight: Float32Array | null = null;
  const captureSink = resolved.onTrackAudio;
  const signal = resolved.signal;
  const warnings: AudioIssue[] = [];
  const trackStats: AudioTrackRenderStats[] = [];

  let audibleTrackCount = 0;
  let renderedTrackCount = 0;
  let eventCount = 0;
  let startedVoices = 0;
  let droppedVoices = 0;
  let stolenVoices = 0;

  for (const track of song.tracks) {
    if (signal?.aborted) {
      return audioFailure(
        [
          createAudioIssue(
            'audio.cancelled',
            '/audio',
            'Audio rendering was cancelled by the caller.',
            'The partial mix was discarded. Start a new render with a fresh AbortController when ready.',
            { abortedAt: 'track-boundary', trackIndex: track.index },
          ),
        ],
        warnings,
      );
    }
    const description = instrumentDescription(track);
    const maxVoices = resolved.maxVoicesPerTrack;

    if (!track.audible) {
      trackStats.push({
        trackIndex: track.index,
        trackId: track.id,
        instrumentType: description.type,
        builtinId: description.builtinId,
        audible: false,
        rendered: false,
        eventCount: 0,
        startedVoices: 0,
        droppedVoices: 0,
        stolenVoices: 0,
        peakActiveVoices: 0,
        maxVoices,
        peak: 0,
      });
      continue;
    }

    audibleTrackCount += 1;

    const trackEvents: TimelineNoteEvent[] = [];
    for (const event of song.events) {
      if (event.trackIndex === track.index && event.audible) {
        trackEvents.push(event);
      }
    }

    const request: AudioTrackRenderRequest = {
      track,
      events: trackEvents,
      sampleRate: song.sampleRate,
      frameCount,
      seed: song.meta.seed,
      maxVoices,
      bpm: song.meta.bpm,
    };

    let result;
    try {
      result = await backend.renderTrack(request);
    } catch {
      return audioFailure([
        createAudioIssue(
          'audio.backend.failed',
          `/tracks/${track.index}`,
          `The ${backend.id} backend failed while rendering track "${track.id}".`,
          'Inspect the backend implementation. Expected capability failures must be returned as structured issues, not thrown.',
          { backendId: backend.id, trackId: track.id },
        ),
      ]);
    }

    if (!isRecord(result) || typeof result.ok !== 'boolean') {
      return audioFailure([
        backendInvalidOutput(backend, track, 'the result is not an object with ok'),
      ]);
    }

    if (!result.ok) {
      if (
        !Array.isArray(result.errors) ||
        !result.errors.every((issue) => isAudioIssue(issue, 'error'))
      ) {
        return audioFailure([
          backendInvalidOutput(backend, track, 'a failure did not contain structured error issues'),
        ]);
      }
      return audioFailure(result.errors);
    }

    const samples = result.samples;
    if (!(samples instanceof Float32Array) || samples.length !== frameCount) {
      return audioFailure([
        backendInvalidOutput(
          backend,
          track,
          `samples must be a Float32Array of exactly ${frameCount} frames`,
        ),
      ]);
    }
    if (!isValidBackendStats(result.stats, maxVoices)) {
      return audioFailure([
        backendInvalidOutput(backend, track, 'voice stats are missing or invalid'),
      ]);
    }
    if (
      !Array.isArray(result.warnings) ||
      !result.warnings.every((issue) => isAudioIssue(issue, 'warning'))
    ) {
      return audioFailure([
        backendInvalidOutput(backend, track, 'warnings must be an array of warning issues'),
      ]);
    }

    const automation = buildTrackAutomation(track, song.sampleRate);
    const effectivelyDry = isEffectivelyDry(track, automation);
    let trackPeak = 0;
    let captureLeft: Float32Array | null = null;
    let captureRight: Float32Array | null = null;
    let capturedPeak = 0;

    if (effectivelyDry && captureSink === undefined) {
      // Exact dry path. This preserves the Task 06 arithmetic for tracks
      // without effects or moving automation, including transparent chains.
      const gain = track.volume;
      const leftGain = Math.cos(((track.pan + 1) * Math.PI) / 4);
      const rightGain = Math.sin(((track.pan + 1) * Math.PI) / 4);

      for (let frame = 0; frame < frameCount; frame += 1) {
        const sample = samples[frame];
        if (sample === undefined) {
          return audioFailure([backendInvalidOutput(backend, track, `sample ${frame} is missing`)]);
        }
        if (!Number.isFinite(sample)) {
          return audioFailure([
            createAudioIssue(
              'audio.samples.non_finite',
              `/tracks/${track.index}`,
              `The ${backend.id} backend produced a non-finite sample on track "${track.id}" at frame ${frame}.`,
              'Fix the backend or instrument voice. Non-finite audio is never written, clamped, or normalized.',
              { backendId: backend.id, trackId: track.id, frame, channel: 'mono' },
            ),
          ]);
        }

        const magnitude = Math.abs(sample);
        if (magnitude > trackPeak) {
          trackPeak = magnitude;
        }

        const scaled = sample * gain;
        const leftValue = (left[frame] ?? 0) + scaled * leftGain;
        const rightValue = (right[frame] ?? 0) + scaled * rightGain;
        if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue)) {
          return audioFailure([
            createAudioIssue(
              'audio.samples.non_finite',
              `/tracks/${track.index}`,
              `Mixing track "${track.id}" produced a non-finite master sample at frame ${frame}.`,
              'Check track gain, pan, and backend output. Non-finite audio is never written or clamped.',
              { backendId: backend.id, trackId: track.id, frame, channel: 'master' },
            ),
          ]);
        }

        left[frame] = leftValue;
        right[frame] = rightValue;
      }
    } else {
      const scratchLeft = (trackLeft ??= new Float32Array(frameCount));
      const scratchRight = (trackRight ??= new Float32Array(frameCount));
      captureLeft = captureSink === undefined ? null : scratchLeft;
      captureRight = captureSink === undefined ? null : scratchRight;
      const volumeCurve = automation.volume;
      const panCurve = automation.pan;
      const volumeSmoother =
        volumeCurve !== null && volumeCurve.constantValue === null
          ? new ParameterSmoother(volumeCurve.valueAtFrame(0), song.sampleRate)
          : null;
      const panSmoother =
        panCurve !== null && panCurve.constantValue === null
          ? new ParameterSmoother(panCurve.valueAtFrame(0), song.sampleRate)
          : null;
      const constantVolume = volumeCurve?.constantValue ?? null;
      const constantPan = panCurve?.constantValue ?? null;
      const constantPanGain = constantPan === null ? null : constantPanGains(constantPan);
      const staticGain = track.volume;
      const staticPan = track.pan;
      const staticLeftGain = Math.cos(((staticPan + 1) * Math.PI) / 4);
      const staticRightGain = Math.sin(((staticPan + 1) * Math.PI) / 4);

      for (let frame = 0; frame < frameCount; frame += 1) {
        const sample = samples[frame];
        if (sample === undefined) {
          return audioFailure([backendInvalidOutput(backend, track, `sample ${frame} is missing`)]);
        }
        if (!Number.isFinite(sample)) {
          return audioFailure([
            createAudioIssue(
              'audio.samples.non_finite',
              `/tracks/${track.index}`,
              `The ${backend.id} backend produced a non-finite sample on track "${track.id}" at frame ${frame}.`,
              'Fix the backend or instrument voice. Non-finite audio is never written, clamped, or normalized.',
              { backendId: backend.id, trackId: track.id, frame, channel: 'mono' },
            ),
          ]);
        }

        const magnitude = Math.abs(sample);
        if (magnitude > trackPeak) {
          trackPeak = magnitude;
        }

        const gain =
          volumeCurve === null
            ? staticGain
            : volumeSmoother !== null
              ? volumeSmoother.next(volumeCurve.valueAtFrame(frame))
              : (constantVolume ?? staticGain);

        let leftGain: number;
        let rightGain: number;
        if (panCurve === null) {
          leftGain = staticLeftGain;
          rightGain = staticRightGain;
        } else if (panSmoother !== null) {
          const pan = panSmoother.next(panCurve.valueAtFrame(frame));
          leftGain = automatedPanLeftGain(pan);
          rightGain = automatedPanRightGain(pan);
        } else {
          leftGain = constantPanGain?.left ?? staticLeftGain;
          rightGain = constantPanGain?.right ?? staticRightGain;
        }

        const scaled = sample * gain;
        scratchLeft[frame] = scaled * leftGain;
        scratchRight[frame] = scaled * rightGain;
      }

      if (track.effects.length > 0 && !effectivelyDry) {
        processEffectChain(
          track.effects,
          {
            sampleRate: song.sampleRate,
            frameCount,
            cutoffAutomation: automation.filterCutoffHz,
          },
          scratchLeft,
          scratchRight,
        );
      }

      for (let frame = 0; frame < frameCount; frame += 1) {
        const postLeft = scratchLeft[frame];
        const postRight = scratchRight[frame];
        if (postLeft === undefined || postRight === undefined) {
          return audioFailure([
            createAudioIssue(
              'audio.samples.non_finite',
              `/tracks/${track.index}`,
              `The post-effect track buffer for "${track.id}" is missing frame ${frame}.`,
              'This indicates an internal renderer bug. Recompile and render again.',
              { trackId: track.id, frame },
            ),
          ]);
        }
        if (!Number.isFinite(postLeft) || !Number.isFinite(postRight)) {
          return audioFailure([
            createAudioIssue(
              'audio.samples.non_finite',
              `/tracks/${track.index}`,
              `An effect on track "${track.id}" produced a non-finite sample at frame ${frame}.`,
              'Check the effect parameters and filter state. Non-finite audio is never written, clamped, or normalized.',
              {
                backendId: backend.id,
                trackId: track.id,
                frame,
                channel: !Number.isFinite(postLeft) ? 'left' : 'right',
              },
            ),
          ]);
        }

        capturedPeak = Math.max(capturedPeak, Math.abs(postLeft), Math.abs(postRight));
        const leftValue = (left[frame] ?? 0) + postLeft;
        const rightValue = (right[frame] ?? 0) + postRight;
        if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue)) {
          return audioFailure([
            createAudioIssue(
              'audio.samples.non_finite',
              `/tracks/${track.index}`,
              `Mixing track "${track.id}" produced a non-finite master sample at frame ${frame}.`,
              'Check track gain, pan, effects, and backend output. Non-finite audio is never written or clamped.',
              { backendId: backend.id, trackId: track.id, frame, channel: 'master' },
            ),
          ]);
        }

        left[frame] = leftValue;
        right[frame] = rightValue;
      }
    }

    if (captureSink !== undefined && captureLeft !== null && captureRight !== null) {
      try {
        await captureSink({
          trackIndex: track.index,
          trackId: track.id,
          trackName: track.name,
          sampleRate: song.sampleRate,
          frameCount,
          left: captureLeft,
          right: captureRight,
          peak: capturedPeak,
        });
      } catch {
        return audioFailure(
          [
            createAudioIssue(
              'audio.artifacts.write_failed',
              `/tracks/${track.index}`,
              `The track audio sink failed while consuming the post-effect stem for "${track.id}".`,
              'The partial job was discarded. Check the output path permissions and available space, then retry.',
              { backendId: backend.id, trackId: track.id },
            ),
          ],
          warnings,
        );
      }
      if (signal?.aborted) {
        return audioFailure(
          [
            createAudioIssue(
              'audio.cancelled',
              '/audio',
              'Audio rendering was cancelled while publishing a track capture.',
              'The partial mix and job artifacts were discarded. Start a new render when ready.',
              { abortedAt: 'track-capture', trackIndex: track.index },
            ),
          ],
          warnings,
        );
      }
    }

    startedVoices += result.stats.startedVoices;
    droppedVoices += result.stats.droppedVoices;
    stolenVoices += result.stats.stolenVoices;
    eventCount += trackEvents.length;
    renderedTrackCount += 1;

    if (result.stats.droppedVoices > 0) {
      warnings.push(
        createAudioIssue(
          'audio.voice.dropped',
          `/tracks/${track.index}`,
          `Track "${track.id}" dropped ${result.stats.droppedVoices} note start${
            result.stats.droppedVoices === 1 ? '' : 's'
          } because the ${maxVoices}-voice cap was reached.`,
          'Reduce overlapping notes or raise maxVoicesPerTrack (hard limit 128). The built-in policy drops the newest note start and never steals an active voice.',
          {
            backendId: backend.id,
            trackId: track.id,
            droppedVoices: result.stats.droppedVoices,
            maxVoices,
          },
        ),
      );
    }
    if (result.stats.stolenVoices > 0) {
      warnings.push(
        createAudioIssue(
          'audio.voice.stolen',
          `/tracks/${track.index}`,
          `Track "${track.id}" reported ${result.stats.stolenVoices} stolen active voice${
            result.stats.stolenVoices === 1 ? '' : 's'
          } under the backend voice policy.`,
          'Review the backend voice policy or raise maxVoicesPerTrack. The built-in backend uses drop-newest and never steals.',
          {
            backendId: backend.id,
            trackId: track.id,
            stolenVoices: result.stats.stolenVoices,
            maxVoices,
          },
        ),
      );
    }
    for (const warning of result.warnings) {
      warnings.push(warning);
    }

    trackStats.push({
      trackIndex: track.index,
      trackId: track.id,
      instrumentType: description.type,
      builtinId: description.builtinId,
      audible: true,
      rendered: true,
      eventCount: trackEvents.length,
      startedVoices: result.stats.startedVoices,
      droppedVoices: result.stats.droppedVoices,
      stolenVoices: result.stats.stolenVoices,
      peakActiveVoices: result.stats.peakActiveVoices,
      maxVoices,
      peak: trackPeak,
    });
  }

  if (signal?.aborted) {
    return audioFailure(
      [
        createAudioIssue(
          'audio.cancelled',
          '/audio',
          'Audio rendering was cancelled before the master was finalized.',
          'The partial mix was discarded. Start a new render with a fresh AbortController when ready.',
          { abortedAt: 'finalize' },
        ),
      ],
      warnings,
    );
  }

  let peak = 0;
  for (let frame = 0; frame < frameCount; frame += 1) {
    const leftSample = left[frame];
    const rightSample = right[frame];
    if (leftSample === undefined || rightSample === undefined) {
      return audioFailure([
        createAudioIssue(
          'audio.samples.non_finite',
          '/audio',
          `The master buffer is missing frame ${frame}.`,
          'This indicates an internal renderer bug. Recompile and render again.',
          { frame },
        ),
      ]);
    }
    if (!Number.isFinite(leftSample) || !Number.isFinite(rightSample)) {
      return audioFailure([
        createAudioIssue(
          'audio.samples.non_finite',
          '/audio',
          `The master buffer contains a non-finite sample at frame ${frame}.`,
          'Check the backend and mixer. Non-finite audio is never written or clamped.',
          { frame, channel: !Number.isFinite(leftSample) ? 'left' : 'right' },
        ),
      ]);
    }
    const magnitude = Math.max(Math.abs(leftSample), Math.abs(rightSample));
    if (magnitude > peak) {
      peak = magnitude;
    }
  }

  return {
    ok: true,
    audio: {
      format: PCM_BUFFER_FORMAT,
      formatVersion: PCM_BUFFER_FORMAT_VERSION,
      sampleRate: song.sampleRate,
      frameCount,
      left,
      right,
    },
    stats: {
      sampleRate: song.sampleRate,
      frameCount,
      channels: 2,
      backendId: backend.id,
      voiceCapPolicy: backend.capabilities.voicePolicy,
      maxVoicesPerTrack: resolved.maxVoicesPerTrack,
      audibleTrackCount,
      renderedTrackCount,
      eventCount,
      startedVoices,
      droppedVoices,
      stolenVoices,
      peak,
      peakDbfs: toDbfs(peak),
      tracks: trackStats,
    },
    warnings: normalizeAudioIssues(warnings),
  };
}
