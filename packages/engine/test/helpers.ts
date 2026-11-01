import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Note, SongSchemaV1, Track } from '@gxaditya/vamp-schema';

import type { CompileSongOptions, CompileSongSuccess } from '../src/index.js';
import { compileSong } from '../src/index.js';

const fixturesRoot = fileURLToPath(new URL('../../schema/fixtures/valid/', import.meta.url));

export function loadValidFixture(name: string): SongSchemaV1 {
  return JSON.parse(readFileSync(join(fixturesRoot, name), 'utf8')) as SongSchemaV1;
}

export function clipNote(pitch: number, start: number, duration: number, velocity?: number): Note {
  return {
    pitch,
    start,
    duration,
    ...(velocity === undefined ? {} : { velocity }),
  };
}

export function clipTrack(id: string, notes: readonly Note[], extra: Partial<Track> = {}): Track {
  return {
    id,
    name: id,
    kind: 'midi',
    channel: 0,
    instrument: { type: 'builtin', id: 'keys.soft' },
    ...(notes.length === 0 ? {} : { notes: [...notes] }),
    ...extra,
  };
}

export function baseSong(
  overrides: {
    bpm?: number;
    timeSignature?: SongSchemaV1['meta']['timeSignature'];
    durationHint?: number;
    patterns?: NonNullable<SongSchemaV1['patterns']>;
    tracks?: Track[];
  } = {},
): SongSchemaV1 {
  return {
    schemaVersion: '1.0.0',
    meta: {
      title: 'Timeline Test',
      bpm: overrides.bpm ?? 120,
      timeSignature: overrides.timeSignature ?? { numerator: 4, denominator: 4 },
      key: { tonic: 'C', mode: 'major' },
      seed: 123,
      durationHint: overrides.durationHint ?? 4,
    },
    ...(overrides.patterns === undefined ? {} : { patterns: overrides.patterns }),
    tracks: overrides.tracks ?? [clipTrack('keys', [clipNote(60, 0, 1)])],
  };
}

export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

export function compileOk(
  song: unknown,
  options: CompileSongOptions = { sampleRate: 48000 },
): CompileSongSuccess {
  const result = compileSong(song, options);
  if (!result.ok) {
    throw new Error(`Expected compile success, received: ${JSON.stringify(result.errors)}`);
  }
  return result;
}
