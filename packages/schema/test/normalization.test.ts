import { describe, expect, it } from 'vitest';

import {
  NORMALIZATION_DEFAULTS,
  normalizeSong,
  validateSong,
  type NormalizedLowpassEffect,
} from '../src/index.js';
import {
  automationSong,
  instrumentsSong,
  loadValidFixture,
  minimalSong,
  patternsSong,
} from './test-helpers.js';

describe('normalization', () => {
  it('applies documented track and note defaults on a copy', () => {
    const song = minimalSong();
    const before = JSON.stringify(song);
    const normalized = normalizeSong(song);

    expect(JSON.stringify(song)).toBe(before);
    expect(normalized.tracks[0]).toMatchObject({
      volume: NORMALIZATION_DEFAULTS.trackVolume,
      pan: NORMALIZATION_DEFAULTS.trackPan,
      mute: NORMALIZATION_DEFAULTS.trackMute,
      solo: NORMALIZATION_DEFAULTS.trackSolo,
    });
    expect(normalized.tracks[0]?.notes[0]?.velocity).toBe(NORMALIZATION_DEFAULTS.noteVelocity);
    expect(normalized.patterns).toEqual([]);
    expect(normalized.tracks[0]?.placements).toEqual([]);
    expect(normalized.tracks[0]?.effects).toEqual([]);
    expect(normalized.meta).not.toBe(song.meta);
    expect(normalized.meta.timeSignature).not.toBe(song.meta.timeSignature);
    expect(normalized.tracks[0]).not.toBe(song.tracks[0]);
    expect(normalized.tracks[0]?.notes[0]).not.toBe(song.tracks[0]?.notes?.[0]);
  });

  it('applies placement repeat and keeps effective pattern length out of authored fields', () => {
    const song = minimalSong();
    song.patterns = [
      {
        id: 'lazy',
        notes: [{ pitch: 60, start: 1, duration: 2 }],
      },
    ];
    song.tracks[0]!.placements = [{ pattern: 'lazy', start: 0 }];

    const result = validateSong(song);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.normalized.tracks[0]?.placements[0]?.repeat).toBe(
      NORMALIZATION_DEFAULTS.placementRepeat,
    );
    expect(result.normalized.patterns[0]).toMatchObject({
      id: 'lazy',
      effectiveLengthBeats: 3,
    });
    expect(result.normalized.patterns[0]?.lengthBeats).toBeUndefined();
    expect(song.patterns[0]?.lengthBeats).toBeUndefined();
  });

  it('resolves instrument bank defaults without changing explicit banks', () => {
    const song = instrumentsSong();
    const gm = song.tracks[0]!.instrument;
    const soundfont = song.tracks[1]!.instrument;
    if (gm.type === 'gm') {
      delete gm.bank;
    }
    if (soundfont.type === 'soundfont') {
      delete soundfont.bank;
    }

    const result = validateSong(song);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.normalized.tracks[0]?.instrument).toMatchObject({
      type: 'gm',
      program: 0,
      bank: NORMALIZATION_DEFAULTS.instrumentBank,
    });
    expect(result.normalized.tracks[1]?.instrument).toMatchObject({
      type: 'soundfont',
      bank: NORMALIZATION_DEFAULTS.instrumentBank,
    });
    expect(result.normalized.tracks[2]?.instrument).toEqual({
      type: 'sfz',
      path: 'assets/flute/air.sfz',
    });
  });

  it('applies every effect default', () => {
    const song = minimalSong();
    song.tracks[0]!.effects = [
      { type: 'reverb' },
      { type: 'delay' },
      { type: 'eq' },
      { type: 'lowpass' },
    ];

    const result = validateSong(song);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.normalized.tracks[0]?.effects).toEqual([
      {
        type: 'reverb',
        mix: NORMALIZATION_DEFAULTS.reverbMix,
        decaySeconds: NORMALIZATION_DEFAULTS.reverbDecaySeconds,
      },
      {
        type: 'delay',
        timeMs: NORMALIZATION_DEFAULTS.delayTimeMs,
        feedback: NORMALIZATION_DEFAULTS.delayFeedback,
        mix: NORMALIZATION_DEFAULTS.delayMix,
      },
      {
        type: 'eq',
        lowGainDb: NORMALIZATION_DEFAULTS.eqGainDb,
        midGainDb: NORMALIZATION_DEFAULTS.eqGainDb,
        highGainDb: NORMALIZATION_DEFAULTS.eqGainDb,
      },
      {
        type: 'lowpass',
        cutoffHz: NORMALIZATION_DEFAULTS.lowpassCutoffHz,
        q: NORMALIZATION_DEFAULTS.lowpassQ,
      },
    ]);
  });

  it('omits normalized lowpass cutoff when cutoff automation is present', () => {
    const result = validateSong(automationSong());
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const lowpass = result.normalized.tracks[0]?.effects.find(
      (effect): effect is NormalizedLowpassEffect => effect.type === 'lowpass',
    );
    expect(lowpass).toBeDefined();
    expect(lowpass && 'cutoffHz' in lowpass).toBe(false);
    expect(lowpass?.q).toBe(0.9);
  });

  it('does not inject timestamps or seeds and preserves authored metadata', () => {
    const song = minimalSong();
    const normalized = normalizeSong(song);

    expect(Object.hasOwn(normalized.meta, 'createdAt')).toBe(false);
    expect(normalized.meta.seed).toBe(song.meta.seed);
    expect(normalized.meta.title).toBe(song.meta.title);
    expect(Object.hasOwn(normalized.meta, 'mood')).toBe(false);

    const withMetadata = loadValidFixture('free-notes.song.json');
    const normalizedMetadata = normalizeSong(withMetadata);
    expect(normalizedMetadata.meta.createdAt).toBe(withMetadata.meta.createdAt);
    expect(normalizedMetadata.meta.tags).toEqual(withMetadata.meta.tags);
    expect(normalizedMetadata.meta.tags).not.toBe(withMetadata.meta.tags);
  });

  it('produces deterministic output and never mutates the input', () => {
    const song = patternsSong();
    const before = JSON.stringify(song);
    const first = normalizeSong(song);
    const second = normalizeSong(song);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(JSON.stringify(song)).toBe(before);

    first.meta.title = 'Changed in the copy';
    first.tracks[0]!.volume = 0;
    expect(song.meta.title).not.toBe('Changed in the copy');
    expect(song.tracks[0]?.volume).toBeUndefined();
  });

  it('deep-copies automation points', () => {
    const song = automationSong();
    const normalized = normalizeSong(song);
    const point = normalized.tracks[0]?.automation?.volume?.points[0];
    expect(point).toEqual(song.tracks[0]?.automation?.volume?.points[0]);
    expect(point).not.toBe(song.tracks[0]?.automation?.volume?.points[0]);

    if (point) {
      point.value = 0;
    }
    expect(song.tracks[0]?.automation?.volume?.points[0]?.value).toBe(0.6);
  });
});
