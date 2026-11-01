import type { TimeSignature } from '@gxaditya/vamp-schema';

/** Sample rate used by CD-quality audio output. */
export const SAMPLE_RATE_44_1 = 44100 as const;

/** Sample rate used by most video production pipelines. */
export const SAMPLE_RATE_48 = 48000 as const;

/** Sample rates supported by the v1 timeline and renderers. */
export const SUPPORTED_SAMPLE_RATES = Object.freeze([SAMPLE_RATE_44_1, SAMPLE_RATE_48] as const);

export type SampleRate = (typeof SUPPORTED_SAMPLE_RATES)[number];

export function isSampleRate(value: unknown): value is SampleRate {
  return value === SAMPLE_RATE_44_1 || value === SAMPLE_RATE_48;
}

/**
 * Seconds per quarter-note beat for a constant tempo.
 *
 * SongSchemaV1 tempo is always quarter-note BPM, including in meters such as
 * 6/8. This function is the single tempo conversion used by the timeline
 * compiler and its events.
 */
export function getSecondsPerBeat(bpm: number): number {
  return 60 / bpm;
}

/**
 * Convert quarter-note beats to unrounded seconds.
 *
 * Inputs are expected to be finite and non-negative. The function itself does
 * not quantize; callers that need exact sample boundaries use
 * `beatsToSamples`.
 */
export function beatsToSeconds(beats: number, bpm: number): number {
  return beats * getSecondsPerBeat(bpm);
}

/**
 * Convert quarter-note beats to a sample position.
 *
 * Rounding rule: the exact unrounded sample position is rounded to the nearest
 * integer with `Math.round`. Halfway values round toward positive infinity,
 * which is JavaScript's documented `Math.round` behavior. `Math.floor` is not
 * used because it would systematically pull events earlier.
 */
export function beatsToSamples(beats: number, bpm: number, sampleRate: SampleRate): number {
  return Math.round(beatsToSeconds(beats, bpm) * sampleRate);
}

/**
 * Convert seconds to a sample position using the same nearest-integer rule as
 * `beatsToSamples`.
 */
export function secondsToSamples(seconds: number, sampleRate: SampleRate): number {
  return Math.round(seconds * sampleRate);
}

/**
 * Convert a rendered duration to a whole-sample frame count.
 *
 * This is the duration formula from the schema guide:
 * `audioFrames = ceil(renderedSeconds * sampleRate)`. It is intentionally
 * different from event boundary rounding so the output never truncates the
 * final partial sample of the documented rendered duration.
 */
export function secondsToFrames(seconds: number, sampleRate: SampleRate): number {
  return Math.ceil(seconds * sampleRate);
}

/**
 * Quarter-note beats per bar for a meter.
 *
 * Bars are grouping metadata only. The compiler never snaps note positions to
 * bars, so non-4/4 music keeps its exact authored beats.
 */
export function getBeatsPerBar(timeSignature: TimeSignature): number {
  return (timeSignature.numerator * 4) / timeSignature.denominator;
}
