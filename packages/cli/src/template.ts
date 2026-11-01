/**
 * The `vamp init` template song.
 *
 * It is deliberately small: three builtin instrument tracks, free-form notes
 * only, no patterns, automation, or effects. It uses only capabilities of the
 * deterministic built-in synthesizer so Task 12 can render it without a
 * sample-library dependency.
 */

import type { Note, SongSchemaV1 } from '@gxaditya/vamp-schema';

export const DEFAULT_PROJECT_ID = 'demo';
export const DEFAULT_PROJECT_ROOT = 'vamp-projects';
export const DEFAULT_PROJECT_TITLE = 'Vamp Demo';
export const DEFAULT_TEMPLATE_TITLE = DEFAULT_PROJECT_TITLE;

function chord(
  start: number,
  pitches: readonly number[],
  duration: number,
  velocity: number,
): Note[] {
  return pitches.map((pitch) => ({ pitch, start, duration, velocity }));
}

function drums(): Note[] {
  const notes: Note[] = [];
  for (let beat = 0; beat < 16; beat += 2) {
    notes.push({ pitch: 36, start: beat, duration: 0.25, velocity: 108 });
  }
  for (let beat = 1; beat < 16; beat += 2) {
    notes.push({ pitch: 38, start: beat, duration: 0.25, velocity: 96 });
  }
  for (let index = 0; index < 32; index += 1) {
    notes.push({
      pitch: 42,
      start: index * 0.5,
      duration: 0.25,
      velocity: index % 2 === 0 ? 72 : 56,
    });
  }
  return notes;
}

/** Build a deterministic minimal song using builtin instruments only. */
export function createTemplateSong(title: string): SongSchemaV1 {
  return {
    schemaVersion: '1.0.0',
    meta: {
      title,
      bpm: 90,
      timeSignature: { numerator: 4, denominator: 4 },
      key: { tonic: 'C', mode: 'major' },
      seed: 11,
      durationHint: 16,
      mood: 'calm',
      tags: ['demo', 'template'],
    },
    tracks: [
      {
        id: 'keys',
        name: 'Keys',
        kind: 'midi',
        channel: 0,
        instrument: { type: 'builtin', id: 'keys.soft' },
        volume: 0.8,
        pan: -0.15,
        notes: [
          ...chord(0, [60, 64, 67, 71], 3.5, 82),
          ...chord(4, [57, 60, 64, 67], 3.5, 78),
          ...chord(8, [53, 57, 60, 64], 3.5, 80),
          ...chord(12, [55, 59, 62, 64], 3.5, 84),
        ],
      },
      {
        id: 'bass',
        name: 'Bass',
        kind: 'midi',
        channel: 1,
        instrument: { type: 'builtin', id: 'bass.sub' },
        volume: 0.9,
        notes: [
          { pitch: 36, start: 0, duration: 1.75, velocity: 96 },
          { pitch: 43, start: 2, duration: 1.75, velocity: 88 },
          { pitch: 45, start: 4, duration: 1.75, velocity: 92 },
          { pitch: 40, start: 6, duration: 1.75, velocity: 86 },
          { pitch: 41, start: 8, duration: 1.75, velocity: 92 },
          { pitch: 48, start: 10, duration: 1.75, velocity: 88 },
          { pitch: 43, start: 12, duration: 1.75, velocity: 94 },
          { pitch: 47, start: 14, duration: 1.75, velocity: 90 },
        ],
      },
      {
        id: 'drums',
        name: 'Drums',
        kind: 'drums',
        channel: 9,
        instrument: { type: 'builtin', id: 'drums.kit' },
        volume: 0.75,
        notes: drums(),
      },
    ],
  };
}
