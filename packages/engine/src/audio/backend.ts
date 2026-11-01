import type { InstrumentVariantType } from '@gxaditya/vamp-schema';

import type { TimelineNoteEvent, TimelineTrack } from '../timeline.js';
import type { SampleRate } from '../time.js';
import type { AudioIssue } from './errors.js';

/** Stable identifier of the built-in deterministic synthesizer backend. */
export const BUILTIN_SYNTH_BACKEND_ID = 'builtin-synth-v1';

/**
 * Built-in polyphony policy. When a track already holds `maxVoices` active
 * voices, including voices in release, a new note start is dropped. The oldest
 * voice is never stolen, so an audible note is never cut short by a later one.
 */
export const AUDIO_VOICE_POLICY = 'drop-newest' as const;

/** Voice policies a backend may declare for its per-track cap. */
export const AUDIO_VOICE_POLICIES = Object.freeze(['drop-newest', 'steal-oldest'] as const);

export type AudioVoicePolicy = (typeof AUDIO_VOICE_POLICIES)[number];

/** Default per-track active voice cap. */
export const DEFAULT_MAX_VOICES_PER_TRACK = 32;

/** Hard upper bound accepted by `maxVoicesPerTrack`. */
export const MAX_VOICES_PER_TRACK = 128;

/**
 * Instrument capability declaration for an audio backend.
 *
 * The shared renderer checks these before calling `renderTrack` and returns
 * structured capability errors for every unsupported track. A backend must never
 * be asked to render an instrument it did not declare, and the renderer never
 * substitutes one instrument for another.
 */
export interface AudioBackendCapabilities {
  /** Instrument variants this backend can render. */
  readonly instrumentTypes: readonly InstrumentVariantType[];
  /**
   * Builtin instrument IDs this backend can render. Required even when
   * `builtin` is absent from `instrumentTypes`; an empty list is explicit.
   */
  readonly builtinIds: readonly string[];
  /**
   * Policy used when `maxVoices` is reached. The backend must enforce the cap
   * and report drops or steals in its track stats; the renderer surfaces the
   * declared policy in `AudioRenderStats.voiceCapPolicy`.
   */
  readonly voicePolicy: AudioVoicePolicy;
}

/**
 * One track's dry mono voice request.
 *
 * Contract for implementers, including the future sample-library backend:
 *
 * - Render exactly `frameCount` mono samples, dry and at unity gain. Track
 *   volume, equal-power pan, audibility, effects, and the master sum belong to
 *   the shared renderer, not the backend.
 * - `events` contains only audible note events for this track, in canonical
 *   timeline order. Ignore events whose `startSample` is at or beyond
 *   `frameCount`. A zero-length sampled event may be silent.
 * - Apply the instrument release within the requested frame count. Audio still
 *   sounding at `frameCount` is truncated at that boundary; no output fade is
 *   added by Task 06.
 * - Respect `maxVoices` as a cap on active voices, including voices in release.
 *   Report every dropped or stolen start in `stats` and return warning issues
 *   when a policy limit was reached. The built-in backend uses `drop-newest`
 *   and reports zero stolen voices.
 * - Use `seed` only for genuinely noise-based voices. Derive any pseudo-random
 *   stream from `seed` plus stable event identity. Never use `Math.random`,
 *   `Date`, locale, network, filesystem, or process state.
 * - Return finite samples. The shared renderer rejects non-finite output with a
 *   structured `audio.samples.non_finite` error.
 * - Resolve unsupported instruments with a structured capability error instead
 *   of throwing or silently substituting another sound.
 * - The method is asynchronous so a native sample backend can be integrated
 *   without changing the renderer contract.
 */
export interface AudioTrackRenderRequest {
  readonly track: TimelineTrack;
  readonly events: readonly TimelineNoteEvent[];
  readonly sampleRate: SampleRate;
  readonly frameCount: number;
  readonly seed: number;
  readonly maxVoices: number;
  /**
   * Song tempo in quarter-note beats per minute. Added in Task 07 so a
   * sample-library backend can encode per-track MIDI with correct timing
   * without recompiling or re-reading the song. The built-in synthesizer does
   * not need tempo because it schedules from sample positions.
   */
  readonly bpm: number;
}

/** Voice accounting returned by a backend for one track. */
export interface AudioBackendTrackStats {
  /** Note starts that created a voice. */
  readonly startedVoices: number;
  /** Note starts refused because the active voice cap was reached. */
  readonly droppedVoices: number;
  /** Released active voices stolen by a stealing policy. Zero for drop-newest. */
  readonly stolenVoices: number;
  /** Largest number of simultaneously active voices, including releases. */
  readonly peakActiveVoices: number;
}

export interface AudioBackendTrackSuccess {
  readonly ok: true;
  /** Exactly `frameCount` mono samples at unity gain. */
  readonly samples: Float32Array;
  readonly stats: AudioBackendTrackStats;
  /** Backend-specific warnings, for example a voice-policy report. */
  readonly warnings: readonly AudioIssue[];
}

export interface AudioBackendTrackFailure {
  readonly ok: false;
  readonly errors: readonly AudioIssue[];
}

export type AudioBackendTrackResult = AudioBackendTrackSuccess | AudioBackendTrackFailure;

/**
 * Offline audio source for one track.
 *
 * The interface is intentionally free of native process, asset, and device
 * concerns. Task 07 will provide a sample-library implementation with the same
 * shape; Task 06 ships only the deterministic built-in synthesizer.
 */
export interface AudioBackend {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly capabilities: AudioBackendCapabilities;
  /**
   * Optional declared backend or executable version. A report records this
   * value only when no bounded probe is available.
   */
  readonly version?: string | null;
  /**
   * Optional bounded version probe for report metadata. Implementations must
   * not throw for expected missing executables and must keep any subprocess
   * bounded. The artifact renderer degrades a failed or null probe to unknown.
   */
  probeVersion?(): Promise<string | null>;
  renderTrack(request: AudioTrackRenderRequest): Promise<AudioBackendTrackResult>;
}

export function emptyBackendTrackStats(): AudioBackendTrackStats {
  return {
    startedVoices: 0,
    droppedVoices: 0,
    stolenVoices: 0,
    peakActiveVoices: 0,
  };
}
