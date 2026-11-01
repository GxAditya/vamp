import type { Effect, Pattern, SongSchemaV1, Track } from './generated/song-v1.js';
import { NORMALIZATION_DEFAULTS } from './defaults.js';
import { getPatternEffectiveLengthBeats } from './patterns.js';

/** Hard upper bound on rendered audio, in seconds. */
export const MAX_RENDER_SECONDS = 600;

/** Per-track cap on summed effect tails, in seconds. */
export const TRACK_TAIL_CAP_SECONDS = 30;

const TAIL_DECAY_FLOOR = 0.001;

export interface TrackDurationContribution {
  readonly trackIndex: number;
  readonly trackId: string;
  readonly audible: boolean;
  /** Last notated content end in beats, excluding effect tails. */
  readonly contentEndBeats: number;
  readonly contentEndSeconds: number;
  /** Capped effect tail, or 0 when the track is not audible. */
  readonly tailSeconds: number;
  readonly endSeconds: number;
}

export interface RenderedDurationEstimate {
  readonly secondsPerBeat: number;
  readonly hintSeconds: number;
  readonly lastSoundSeconds: number;
  readonly renderedSeconds: number;
  readonly tracks: readonly TrackDurationContribution[];
}

function isAudible(track: Track, anySolo: boolean): boolean {
  const mute = track.mute ?? NORMALIZATION_DEFAULTS.trackMute;
  const solo = track.solo ?? NORMALIZATION_DEFAULTS.trackSolo;
  return !mute && (!anySolo || solo);
}

function maximumPatternNoteEndBeats(pattern: Pattern): number {
  let maximumEnd = 0;
  for (const note of pattern.notes) {
    maximumEnd = Math.max(maximumEnd, note.start + note.duration);
  }
  return maximumEnd;
}

/**
 * Tail estimate for one effect, using normalization defaults for omitted
 * parameters. This is the formula documented in docs/schema-guide.md.
 */
export function getEffectTailSeconds(effect: Effect): number {
  switch (effect.type) {
    case 'reverb': {
      const mix = effect.mix ?? NORMALIZATION_DEFAULTS.reverbMix;
      if (mix === 0) {
        return 0;
      }
      return effect.decaySeconds ?? NORMALIZATION_DEFAULTS.reverbDecaySeconds;
    }
    case 'delay': {
      const mix = effect.mix ?? NORMALIZATION_DEFAULTS.delayMix;
      if (mix === 0) {
        return 0;
      }
      const delaySeconds = (effect.timeMs ?? NORMALIZATION_DEFAULTS.delayTimeMs) / 1000;
      const feedback = effect.feedback ?? NORMALIZATION_DEFAULTS.delayFeedback;
      if (feedback <= 0) {
        return delaySeconds;
      }
      if (feedback >= 1) {
        return TRACK_TAIL_CAP_SECONDS;
      }
      return delaySeconds * Math.ceil(Math.log(TAIL_DECAY_FLOOR) / Math.log(feedback));
    }
    case 'eq':
    case 'lowpass':
      return 0;
    default:
      return 0;
  }
}

function trackTailSeconds(track: Track): number {
  let total = 0;
  for (const effect of track.effects ?? []) {
    total += getEffectTailSeconds(effect);
  }
  return Math.min(TRACK_TAIL_CAP_SECONDS, total);
}

function trackContentEndBeats(track: Track, patternsById: ReadonlyMap<string, Pattern>): number {
  let maximumEnd = 0;

  for (const note of track.notes ?? []) {
    maximumEnd = Math.max(maximumEnd, note.start + note.duration);
  }

  for (const placement of track.placements ?? []) {
    const pattern = patternsById.get(placement.pattern);
    if (!pattern || pattern.notes.length === 0) {
      continue;
    }
    const repeat = placement.repeat ?? NORMALIZATION_DEFAULTS.placementRepeat;
    if (repeat < 1) {
      continue;
    }
    const effectiveLength = getPatternEffectiveLengthBeats(pattern);
    // Repeats tile forward, so the final play contains the latest note end.
    const finalPlayStart = placement.start + (repeat - 1) * effectiveLength;
    maximumEnd = Math.max(maximumEnd, finalPlayStart + maximumPatternNoteEndBeats(pattern));
  }

  return maximumEnd;
}

function buildPatternIndex(song: SongSchemaV1): Map<string, Pattern> {
  const index = new Map<string, Pattern>();
  for (const pattern of song.patterns ?? []) {
    if (!index.has(pattern.id)) {
      index.set(pattern.id, pattern);
    }
  }
  return index;
}

/**
 * Compute the documented rendered duration estimate.
 *
 * Validation uses this function for the 600 second bound and for hint warnings.
 * Downstream engine and report code should reuse it instead of maintaining a
 * different tail or duration formula. The input is expected to be validated;
 * the function does not mutate it.
 */
export function estimateRenderedDuration(song: SongSchemaV1): RenderedDurationEstimate {
  const secondsPerBeat = 60 / song.meta.bpm;
  const hintSeconds = song.meta.durationHint * secondsPerBeat;
  const patternsById = buildPatternIndex(song);
  const anySolo = song.tracks.some(
    (track) => (track.solo ?? NORMALIZATION_DEFAULTS.trackSolo) === true,
  );

  const tracks: TrackDurationContribution[] = [];
  let lastSoundSeconds = 0;

  song.tracks.forEach((track, trackIndex) => {
    const audible = isAudible(track, anySolo);
    const contentEndBeats = trackContentEndBeats(track, patternsById);
    const contentEndSeconds = contentEndBeats * secondsPerBeat;
    const tailSeconds = audible ? trackTailSeconds(track) : 0;
    const endSeconds = contentEndSeconds + tailSeconds;
    if (audible) {
      lastSoundSeconds = Math.max(lastSoundSeconds, endSeconds);
    }
    tracks.push({
      trackIndex,
      trackId: track.id,
      audible,
      contentEndBeats,
      contentEndSeconds,
      tailSeconds,
      endSeconds,
    });
  });

  return {
    secondsPerBeat,
    hintSeconds,
    lastSoundSeconds,
    renderedSeconds: Math.max(hintSeconds, lastSoundSeconds),
    tracks,
  };
}
