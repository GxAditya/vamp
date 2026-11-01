// DO NOT EDIT. Generated from packages/schema/schema/song.schema.json
// by packages/schema/scripts/generate-types.mjs.
// Regenerate from the repository root with: pnpm generate:types

export interface SongSchemaV1 {
  schemaVersion: '1.0.0';
  meta: SongMeta;
  patterns?: Pattern[];
  tracks: Track[];
}

export type EntityId = string;

export interface SongMeta {
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

export interface TimeSignature {
  numerator: number;
  denominator: 1 | 2 | 4 | 8 | 16 | 32;
}

export interface SongKey {
  tonic: 'C' | 'C#' | 'D' | 'D#' | 'E' | 'F' | 'F#' | 'G' | 'G#' | 'A' | 'A#' | 'B';
  mode: 'major' | 'minor';
}

export interface Track {
  id: EntityId;
  name: string;
  kind: 'midi' | 'drums';
  channel: number;
  instrument: Instrument;
  volume?: number;
  pan?: number;
  mute?: boolean;
  solo?: boolean;
  notes?: Note[];
  placements?: Placement[];
  automation?: Automation;
  effects?: Effect[];
}

export type Instrument = BuiltinInstrument | GmInstrument | SoundfontInstrument | SfzInstrument;

export interface BuiltinInstrument {
  type: 'builtin';
  id: string;
}

export interface GmInstrument {
  type: 'gm';
  program: number;
  bank?: number;
}

export interface SoundfontInstrument {
  type: 'soundfont';
  path: AssetPath;
  program: number;
  bank?: number;
}

export interface SfzInstrument {
  type: 'sfz';
  path: AssetPath;
}

export type AssetPath = string;

export interface Note {
  pitch: number;
  start: number;
  duration: number;
  velocity?: number;
}

export interface Pattern {
  id: EntityId;
  name?: string;
  lengthBeats?: number;
  notes: Note[];
}

export interface Placement {
  pattern: EntityId;
  start: number;
  repeat?: number;
}

export interface Automation {
  volume?: VolumeAutomation;
  pan?: PanAutomation;
  filterCutoffHz?: FilterAutomation;
}

export interface VolumeAutomation {
  points: VolumePoint[];
}

export interface PanAutomation {
  points: PanPoint[];
}

export interface FilterAutomation {
  points: FilterPoint[];
}

export interface VolumePoint {
  time: number;
  value: number;
}

export interface PanPoint {
  time: number;
  value: number;
}

export interface FilterPoint {
  time: number;
  value: number;
}

export type Effect = ReverbEffect | DelayEffect | EqEffect | LowpassEffect;

export interface ReverbEffect {
  type: 'reverb';
  mix?: number;
  decaySeconds?: number;
}

export interface DelayEffect {
  type: 'delay';
  timeMs?: number;
  feedback?: number;
  mix?: number;
}

export interface EqEffect {
  type: 'eq';
  lowGainDb?: number;
  midGainDb?: number;
  highGainDb?: number;
}

export interface LowpassEffect {
  type: 'lowpass';
  cutoffHz?: number;
  q?: number;
}

