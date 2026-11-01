import { describe, expect, it } from 'vitest';

import {
  SAMPLE_RATE_44_1,
  SAMPLE_RATE_48,
  beatsToSamples,
  beatsToSeconds,
  getBeatsPerBar,
  getSecondsPerBeat,
  isSampleRate,
  secondsToFrames,
  secondsToSamples,
} from '../src/index.js';

describe('timeline timing helpers', () => {
  it('uses quarter-note beats at the authored constant tempo', () => {
    expect(getSecondsPerBeat(120)).toBe(0.5);
    expect(getSecondsPerBeat(90)).toBeCloseTo(2 / 3, 12);
    expect(beatsToSeconds(3, 120)).toBe(1.5);
    expect(beatsToSeconds(1.5, 90)).toBeCloseTo(1, 12);
  });

  it('converts beats to sample positions at 44.1 and 48 kHz', () => {
    expect(beatsToSamples(1, 120, SAMPLE_RATE_44_1)).toBe(22050);
    expect(beatsToSamples(1, 120, SAMPLE_RATE_48)).toBe(24000);
    expect(beatsToSamples(4, 90, SAMPLE_RATE_48)).toBe(128000);
    expect(beatsToSamples(7.5, 90, SAMPLE_RATE_48)).toBe(240000);
  });

  it('rounds sample positions to nearest, with halves rounding upward', () => {
    expect(beatsToSamples(0.5 / 44100, 60, SAMPLE_RATE_44_1)).toBe(1);
    expect(beatsToSamples(0.49 / 44100, 60, SAMPLE_RATE_44_1)).toBe(0);
    expect(beatsToSamples(1.5 / 44100, 60, SAMPLE_RATE_44_1)).toBe(2);
    expect(secondsToSamples(1 / 48000, SAMPLE_RATE_48)).toBe(1);
  });

  it('rounds rendered frame counts up so partial samples are kept', () => {
    expect(secondsToFrames(2, SAMPLE_RATE_48)).toBe(96000);
    expect(secondsToFrames(2.000001, SAMPLE_RATE_48)).toBe(96001);
    expect(secondsToSamples(2.000001, SAMPLE_RATE_48)).toBe(96000);
  });

  it('derives quarter-note beats per bar without assuming 4/4', () => {
    expect(getBeatsPerBar({ numerator: 4, denominator: 4 })).toBe(4);
    expect(getBeatsPerBar({ numerator: 3, denominator: 4 })).toBe(3);
    expect(getBeatsPerBar({ numerator: 6, denominator: 8 })).toBe(3);
    expect(getBeatsPerBar({ numerator: 7, denominator: 8 })).toBe(3.5);
    expect(getBeatsPerBar({ numerator: 5, denominator: 16 })).toBe(1.25);
  });

  it('recognizes only the supported v1 sample rates', () => {
    expect(isSampleRate(44100)).toBe(true);
    expect(isSampleRate(48000)).toBe(true);
    expect(isSampleRate(22050)).toBe(false);
    expect(isSampleRate(96000)).toBe(false);
    expect(isSampleRate('48000')).toBe(false);
  });
});
