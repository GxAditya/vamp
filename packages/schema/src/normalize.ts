import type {
  Automation,
  Effect,
  FilterAutomation,
  FilterPoint,
  Instrument,
  PanAutomation,
  PanPoint,
  SongKey,
  SongSchemaV1,
  TimeSignature,
  VolumeAutomation,
  VolumePoint,
} from './generated/song-v1.js';
import { NORMALIZATION_DEFAULTS } from './defaults.js';
import { getPatternEffectiveLengthBeats } from './patterns.js';

export interface NormalizedNote {
  pitch: number;
  start: number;
  duration: number;
  velocity: number;
}

export interface NormalizedPlacement {
  pattern: string;
  start: number;
  repeat: number;
}

export interface NormalizedBuiltinInstrument {
  type: 'builtin';
  id: string;
}

export interface NormalizedGmInstrument {
  type: 'gm';
  program: number;
  bank: number;
}

export interface NormalizedSoundfontInstrument {
  type: 'soundfont';
  path: string;
  program: number;
  bank: number;
}

export interface NormalizedSfzInstrument {
  type: 'sfz';
  path: string;
}

export type NormalizedInstrument =
  | NormalizedBuiltinInstrument
  | NormalizedGmInstrument
  | NormalizedSoundfontInstrument
  | NormalizedSfzInstrument;

export interface NormalizedReverbEffect {
  type: 'reverb';
  mix: number;
  decaySeconds: number;
}

export interface NormalizedDelayEffect {
  type: 'delay';
  timeMs: number;
  feedback: number;
  mix: number;
}

export interface NormalizedEqEffect {
  type: 'eq';
  lowGainDb: number;
  midGainDb: number;
  highGainDb: number;
}

export interface NormalizedLowpassEffect {
  type: 'lowpass';
  /** Present only when cutoff automation is absent. */
  cutoffHz?: number;
  q: number;
}

export type NormalizedEffect =
  NormalizedReverbEffect | NormalizedDelayEffect | NormalizedEqEffect | NormalizedLowpassEffect;

export interface NormalizedAutomation {
  volume?: VolumeAutomation;
  pan?: PanAutomation;
  filterCutoffHz?: FilterAutomation;
}

export interface NormalizedSongMeta {
  title: string;
  bpm: number;
  timeSignature: TimeSignature;
  key: SongKey;
  seed: number;
  durationHint: number;
  mood?: string;
  tags?: string[];
  createdAt?: string;
}

export interface NormalizedPattern {
  id: string;
  name?: string;
  /**
   * Authored explicit length, preserved only when present. The derived repeat
   * period is `effectiveLengthBeats`; it is never written into the song.
   */
  lengthBeats?: number;
  /** Explicit lengthBeats or the maximum note end. */
  effectiveLengthBeats: number;
  notes: NormalizedNote[];
}

export interface NormalizedTrack {
  id: string;
  name: string;
  kind: 'midi' | 'drums';
  channel: number;
  instrument: NormalizedInstrument;
  volume: number;
  pan: number;
  mute: boolean;
  solo: boolean;
  notes: NormalizedNote[];
  placements: NormalizedPlacement[];
  automation?: NormalizedAutomation;
  effects: NormalizedEffect[];
}

export interface NormalizedSongV1 {
  schemaVersion: '1.0.0';
  meta: NormalizedSongMeta;
  patterns: NormalizedPattern[];
  tracks: NormalizedTrack[];
}

function clonePoints<Point extends VolumePoint | PanPoint | FilterPoint>(
  points: readonly Point[],
): Point[] {
  return points.map((point) => ({ ...point }));
}

function cloneAutomation(automation: Automation | undefined): NormalizedAutomation | undefined {
  if (automation === undefined) {
    return undefined;
  }

  const result: NormalizedAutomation = {};
  if (automation.volume !== undefined) {
    result.volume = { points: clonePoints(automation.volume.points) };
  }
  if (automation.pan !== undefined) {
    result.pan = { points: clonePoints(automation.pan.points) };
  }
  if (automation.filterCutoffHz !== undefined) {
    result.filterCutoffHz = { points: clonePoints(automation.filterCutoffHz.points) };
  }
  return result;
}

function normalizeNote(note: {
  pitch: number;
  start: number;
  duration: number;
  velocity?: number;
}): NormalizedNote {
  return {
    pitch: note.pitch,
    start: note.start,
    duration: note.duration,
    velocity: note.velocity ?? NORMALIZATION_DEFAULTS.noteVelocity,
  };
}

function normalizeInstrument(instrument: Instrument): NormalizedInstrument {
  switch (instrument.type) {
    case 'builtin':
      return { type: 'builtin', id: instrument.id };
    case 'gm':
      return {
        type: 'gm',
        program: instrument.program,
        bank: instrument.bank ?? NORMALIZATION_DEFAULTS.instrumentBank,
      };
    case 'soundfont':
      return {
        type: 'soundfont',
        path: instrument.path,
        program: instrument.program,
        bank: instrument.bank ?? NORMALIZATION_DEFAULTS.instrumentBank,
      };
    case 'sfz':
      return { type: 'sfz', path: instrument.path };
  }
}

function normalizeEffect(effect: Effect, filterAutomated: boolean): NormalizedEffect {
  switch (effect.type) {
    case 'reverb':
      return {
        type: 'reverb',
        mix: effect.mix ?? NORMALIZATION_DEFAULTS.reverbMix,
        decaySeconds: effect.decaySeconds ?? NORMALIZATION_DEFAULTS.reverbDecaySeconds,
      };
    case 'delay':
      return {
        type: 'delay',
        timeMs: effect.timeMs ?? NORMALIZATION_DEFAULTS.delayTimeMs,
        feedback: effect.feedback ?? NORMALIZATION_DEFAULTS.delayFeedback,
        mix: effect.mix ?? NORMALIZATION_DEFAULTS.delayMix,
      };
    case 'eq':
      return {
        type: 'eq',
        lowGainDb: effect.lowGainDb ?? NORMALIZATION_DEFAULTS.eqGainDb,
        midGainDb: effect.midGainDb ?? NORMALIZATION_DEFAULTS.eqGainDb,
        highGainDb: effect.highGainDb ?? NORMALIZATION_DEFAULTS.eqGainDb,
      };
    case 'lowpass':
      return {
        type: 'lowpass',
        ...(filterAutomated
          ? {}
          : { cutoffHz: effect.cutoffHz ?? NORMALIZATION_DEFAULTS.lowpassCutoffHz }),
        q: effect.q ?? NORMALIZATION_DEFAULTS.lowpassQ,
      };
  }
}

/**
 * Build a normalized copy of a validated song with every documented default
 * applied. The input is never mutated, and no timestamps, seeds, or other
 * authored values are invented.
 *
 * Reading rules for downstream code:
 * - Every numeric mix/track value is present except lowpass cutoffHz when
 *   filterCutoffHz automation exists.
 * - If `automation.volume` or `automation.pan` exists it replaces the static
 *   normalized volume or pan for the whole song. The static fields remain as
 *   resolved defaults so normalized shapes are uniform.
 * - `patterns[].effectiveLengthBeats` is the repeat period. `lengthBeats` is
 *   only the authored explicit value and may stay absent.
 * - `notes` and `placements` are always arrays, even when empty.
 */
export function normalizeSong(song: SongSchemaV1): NormalizedSongV1 {
  const meta: NormalizedSongMeta = {
    title: song.meta.title,
    bpm: song.meta.bpm,
    timeSignature: { ...song.meta.timeSignature },
    key: { ...song.meta.key },
    seed: song.meta.seed,
    durationHint: song.meta.durationHint,
    ...(song.meta.mood === undefined ? {} : { mood: song.meta.mood }),
    ...(song.meta.tags === undefined ? {} : { tags: [...song.meta.tags] }),
    ...(song.meta.createdAt === undefined ? {} : { createdAt: song.meta.createdAt }),
  };

  const patterns: NormalizedPattern[] = (song.patterns ?? []).map((pattern) => ({
    id: pattern.id,
    ...(pattern.name === undefined ? {} : { name: pattern.name }),
    ...(pattern.lengthBeats === undefined ? {} : { lengthBeats: pattern.lengthBeats }),
    effectiveLengthBeats: getPatternEffectiveLengthBeats(pattern),
    notes: pattern.notes.map((note) => normalizeNote(note)),
  }));

  const tracks: NormalizedTrack[] = song.tracks.map((track) => {
    const automation = cloneAutomation(track.automation);
    const filterAutomated = track.automation?.filterCutoffHz !== undefined;

    return {
      id: track.id,
      name: track.name,
      kind: track.kind,
      channel: track.channel,
      instrument: normalizeInstrument(track.instrument),
      volume: track.volume ?? NORMALIZATION_DEFAULTS.trackVolume,
      pan: track.pan ?? NORMALIZATION_DEFAULTS.trackPan,
      mute: track.mute ?? NORMALIZATION_DEFAULTS.trackMute,
      solo: track.solo ?? NORMALIZATION_DEFAULTS.trackSolo,
      notes: (track.notes ?? []).map((note) => normalizeNote(note)),
      placements: (track.placements ?? []).map((placement) => ({
        pattern: placement.pattern,
        start: placement.start,
        repeat: placement.repeat ?? NORMALIZATION_DEFAULTS.placementRepeat,
      })),
      ...(automation === undefined ? {} : { automation }),
      effects: (track.effects ?? []).map((effect) => normalizeEffect(effect, filterAutomated)),
    };
  });

  return {
    schemaVersion: '1.0.0',
    meta,
    patterns,
    tracks,
  };
}
