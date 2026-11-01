import { describe, expect, it } from 'vitest';

import {
  MAX_RENDER_SECONDS,
  TRACK_TAIL_CAP_SECONDS,
  estimateRenderedDuration,
  getEffectTailSeconds,
} from '../src/index.js';
import { automationSong, loadValidFixture, minimalSong, patternsSong } from './test-helpers.js';

describe('rendered duration estimate', () => {
  it('matches the documented hint and content formula for the minimal fixture', () => {
    const estimate = estimateRenderedDuration(minimalSong());

    expect(estimate.secondsPerBeat).toBeCloseTo(60 / 90, 12);
    expect(estimate.hintSeconds).toBeCloseTo(8 * (60 / 90), 12);
    expect(estimate.tracks[0]).toMatchObject({
      trackIndex: 0,
      trackId: 'keys',
      audible: true,
      contentEndBeats: 7.5,
      tailSeconds: 0,
    });
    expect(estimate.lastSoundSeconds).toBeCloseTo(5, 12);
    expect(estimate.renderedSeconds).toBeCloseTo(estimate.hintSeconds, 12);
  });

  it('adds the reverb tail from the automation fixture', () => {
    const estimate = estimateRenderedDuration(automationSong());
    const track = estimate.tracks[0];

    expect(track?.contentEndBeats).toBe(16);
    expect(track?.tailSeconds).toBeCloseTo(2.4, 12);
    expect(track?.endSeconds).toBeCloseTo(16 * (60 / 84) + 2.4, 12);
    expect(estimate.hintSeconds).toBeCloseTo(24 * (60 / 84), 12);
    expect(estimate.renderedSeconds).toBeCloseTo(estimate.hintSeconds, 12);
  });

  it('uses resolved effect defaults for tail estimates', () => {
    const song = minimalSong();
    song.tracks[0]!.effects = [{ type: 'reverb' }, { type: 'delay' }];

    const estimate = estimateRenderedDuration(song);
    const track = estimate.tracks[0];
    expect(track?.tailSeconds).toBeCloseTo(4.425, 12);
    expect(track?.endSeconds).toBeCloseTo(9.425, 12);
    expect(estimate.renderedSeconds).toBeCloseTo(9.425, 12);
  });

  it('computes individual effect tails with the documented formulas', () => {
    expect(getEffectTailSeconds({ type: 'reverb' })).toBeCloseTo(1.8, 12);
    expect(getEffectTailSeconds({ type: 'reverb', mix: 0 })).toBe(0);
    expect(getEffectTailSeconds({ type: 'delay' })).toBeCloseTo(2.625, 12);
    expect(getEffectTailSeconds({ type: 'delay', feedback: 0 })).toBeCloseTo(0.375, 12);
    expect(getEffectTailSeconds({ type: 'delay', mix: 0 })).toBe(0);
    expect(getEffectTailSeconds({ type: 'eq' })).toBe(0);
    expect(getEffectTailSeconds({ type: 'lowpass' })).toBe(0);
  });

  it('caps the summed per-track tail at 30 seconds', () => {
    const song = minimalSong();
    song.tracks[0]!.effects = [
      { type: 'delay', timeMs: 2000, feedback: 0.9, mix: 0.5 },
      { type: 'reverb', decaySeconds: 10, mix: 0.5 },
    ];

    const estimate = estimateRenderedDuration(song);
    expect(estimate.tracks[0]?.tailSeconds).toBe(TRACK_TAIL_CAP_SECONDS);
    expect(estimate.tracks[0]?.endSeconds).toBeCloseTo(35, 12);
    expect(estimate.renderedSeconds).toBeCloseTo(35, 12);
  });

  it('honors mute and solo when finding the last audible sound', () => {
    const estimate = estimateRenderedDuration(loadValidFixture('free-notes.song.json'));

    expect(estimate.tracks[0]).toMatchObject({
      trackId: 'lead',
      audible: true,
      contentEndBeats: 7.5,
    });
    expect(estimate.tracks[1]).toMatchObject({
      trackId: 'pad',
      audible: false,
      contentEndBeats: 8,
      tailSeconds: 0,
    });
    expect(estimate.lastSoundSeconds).toBeCloseTo(4.5, 12);
    expect(estimate.renderedSeconds).toBeCloseTo(9.6, 12);
  });

  it('uses expanded note ends for pattern placements', () => {
    const estimate = estimateRenderedDuration(patternsSong());
    expect(estimate.tracks[0]?.contentEndBeats).toBe(32);
    expect(estimate.tracks[1]?.contentEndBeats).toBe(30);
    expect(estimate.lastSoundSeconds).toBeCloseTo(32 * (60 / 112), 12);
    expect(estimate.renderedSeconds).toBeCloseTo(32 * (60 / 112), 12);
  });

  it('exposes the 600 second semantic limit', () => {
    expect(MAX_RENDER_SECONDS).toBe(600);
  });
});
