import { describe, expect, it } from 'vitest';

import type { NormalizedEffect } from '@gxaditya/vamp-schema';

import {
  LOWPASS_NYQUIST_RATIO,
  createAutomationCurve,
  processEffectChain,
  renderSongAudio,
  renderTimelineAudio,
  type SampleRate,
} from '../src/index.js';
import { createSignalBackend, measureRms, sameFloat32 } from './audio-helpers.js';
import { baseSong, clipNote, clipTrack, compileOk } from './helpers.js';

const ZERO_GAIN_EQ: NormalizedEffect = {
  type: 'eq',
  lowGainDb: 0,
  midGainDb: 0,
  highGainDb: 0,
};

function impulseBuffers(frames: number, leftAmplitude = 1, rightAmplitude = 1) {
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  left[0] = leftAmplitude;
  right[0] = rightAmplitude;
  return { left, right };
}

function sineBuffer(
  frames: number,
  frequency: number,
  sampleRate: number,
  amplitude = 0.5,
): Float32Array {
  const samples = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    samples[frame] = amplitude * Math.sin((2 * Math.PI * frequency * frame) / sampleRate);
  }
  return samples;
}

function rmsAt(
  samples: Float32Array,
  sampleRate: number,
  startSeconds: number,
  endSeconds: number,
): number {
  return measureRms(samples, startSeconds * sampleRate, endSeconds * sampleRate);
}

function expectFinite(samples: Float32Array): void {
  let finite = true;
  for (let index = 0; index < samples.length; index += 1) {
    if (!Number.isFinite(samples[index])) {
      finite = false;
      break;
    }
  }
  expect(finite).toBe(true);
}

function apply(
  effects: readonly NormalizedEffect[],
  left: Float32Array,
  right: Float32Array,
  options: {
    readonly sampleRate?: SampleRate;
    readonly cutoffAutomation?: ReturnType<typeof createAutomationCurve> | null;
  } = {},
): void {
  processEffectChain(
    effects,
    {
      sampleRate: options.sampleRate ?? 48000,
      frameCount: left.length,
      cutoffAutomation: options.cutoffAutomation ?? null,
    },
    left,
    right,
  );
}

describe('delay timing and feedback decay', () => {
  it('places echoes at the exact delay period with geometric feedback decay', () => {
    const sampleRate = 48000 as const;
    const frames = 20_000;
    const { left, right } = impulseBuffers(frames);
    apply([{ type: 'delay', timeMs: 100, feedback: 0.5, mix: 1 }], left, right, { sampleRate });

    const delayFrames = Math.round(0.1 * sampleRate);
    expect(left[0]).toBe(0);
    expect(left[delayFrames - 1]).toBe(0);
    expect(left[delayFrames]).toBeCloseTo(1, 6);
    expect(left[delayFrames * 2]).toBeCloseTo(0.5, 6);
    expect(left[delayFrames * 3]).toBeCloseTo(0.25, 6);
    expect(left[delayFrames * 4]).toBeCloseTo(0.125, 6);
    expect(right[delayFrames]).toBeCloseTo(1, 6);
    expectFinite(left);
  });

  it('scales the delay period with the sample rate', () => {
    const sampleRate = 44100 as const;
    const frames = 20_000;
    const { left, right } = impulseBuffers(frames);
    apply([{ type: 'delay', timeMs: 250, feedback: 0, mix: 1 }], left, right, { sampleRate });
    const delayFrames = Math.round(0.25 * sampleRate);
    expect(left[delayFrames]).toBeCloseTo(1, 6);
    expect(left[delayFrames - 1]).toBe(0);
    expect(left[delayFrames + 1]).toBe(0);
  });

  it('keeps a one-period tail with zero feedback and a dry mix at zero', () => {
    const frames = 20_000;
    const { left, right } = impulseBuffers(frames);
    apply([{ type: 'delay', timeMs: 100, feedback: 0, mix: 0.5 }], left, right);
    const delayFrames = 4800;
    expect(left[0]).toBeCloseTo(0.5, 6);
    expect(left[delayFrames]).toBeCloseTo(0.5, 6);
    expect(left[delayFrames * 2]).toBe(0);
  });

  it('bypasses a mix-0 delay bit-exactly', () => {
    const frames = 4096;
    const left = sineBuffer(frames, 220, 48000);
    const right = sineBuffer(frames, 331, 48000);
    const originalLeft = left.slice();
    const originalRight = right.slice();
    apply([{ type: 'delay', timeMs: 500, feedback: 0.9, mix: 0 }], left, right);
    expect(left).toEqual(originalLeft);
    expect(right).toEqual(originalRight);
  });
});

describe('low-pass response and stability', () => {
  it.each([44100, 48000] as const)(
    'passes low frequencies and attenuates high frequencies at %i Hz',
    (sampleRate) => {
      const frames = sampleRate * 2;
      const passLeft = sineBuffer(frames, 100, sampleRate);
      const passRight = passLeft.slice();
      apply([{ type: 'lowpass', cutoffHz: 1000, q: Math.SQRT1_2 }], passLeft, passRight, {
        sampleRate,
      });
      const stopLeft = sineBuffer(frames, 8000, sampleRate);
      const stopRight = stopLeft.slice();
      apply([{ type: 'lowpass', cutoffHz: 1000, q: Math.SQRT1_2 }], stopLeft, stopRight, {
        sampleRate,
      });

      const reference = (0.5 / Math.SQRT2) * 0.999;
      const passGain = rmsAt(passLeft, sampleRate, 1, 2) / reference;
      const stopGain = rmsAt(stopLeft, sampleRate, 1, 2) / reference;
      expect(passGain).toBeGreaterThan(0.95);
      expect(passGain).toBeLessThan(1.05);
      expect(stopGain).toBeLessThan(0.1);
      expectFinite(passLeft);
      expectFinite(stopLeft);
    },
  );

  it.each([44100, 48000] as const)(
    'stays finite at cutoff and Q extremes at %i Hz',
    (sampleRate) => {
      for (const cutoffHz of [20, 20000]) {
        for (const q of [0.1, 10]) {
          const frames = sampleRate;
          const left = sineBuffer(frames, 1000, sampleRate);
          const right = left.slice();
          apply([{ type: 'lowpass', cutoffHz, q }], left, right, { sampleRate });
          expectFinite(left);
          expectFinite(right);
        }
      }
    },
  );

  it('clamps cutoff below Nyquist to keep coefficients stable', () => {
    expect(20000).toBeGreaterThan(44100 * LOWPASS_NYQUIST_RATIO);
    const frames = 44100;
    const left = sineBuffer(frames, 1000, 44100);
    const right = left.slice();
    apply([{ type: 'lowpass', cutoffHz: 20000, q: 10 }], left, right, { sampleRate: 44100 });
    expectFinite(left);
  });
});

describe('three-band equalizer response', () => {
  function gainFor(
    effect: NormalizedEffect,
    frequency: number,
    sampleRate: SampleRate = 48000,
  ): number {
    const reference = 0.5 / Math.SQRT2;
    const frames = sampleRate * 2;
    const left = sineBuffer(frames, frequency, sampleRate);
    const right = left.slice();
    apply([effect], left, right, { sampleRate });
    return rmsAt(left, sampleRate, 1, 2) / reference;
  }

  it('boosts the low shelf, mid peak, and high shelf at their fixed frequencies', () => {
    expect(
      gainFor({ type: 'eq', lowGainDb: 12, midGainDb: 0, highGainDb: 0 }, 100),
    ).toBeGreaterThan(2);
    expect(
      gainFor({ type: 'eq', lowGainDb: 0, midGainDb: 12, highGainDb: 0 }, 1000),
    ).toBeGreaterThan(2.5);
    expect(
      gainFor({ type: 'eq', lowGainDb: 0, midGainDb: 0, highGainDb: 12 }, 8000),
    ).toBeGreaterThan(2);
  });

  it('cuts the mid band and leaves distant frequencies close to unity', () => {
    expect(gainFor({ type: 'eq', lowGainDb: 0, midGainDb: -12, highGainDb: 0 }, 1000)).toBeLessThan(
      0.5,
    );
    const distant = gainFor({ type: 'eq', lowGainDb: 0, midGainDb: 12, highGainDb: 0 }, 100);
    expect(distant).toBeGreaterThan(0.85);
    expect(distant).toBeLessThan(1.2);
  });

  it('bypasses an all-zero EQ bit-exactly', () => {
    const frames = 4096;
    const left = sineBuffer(frames, 440, 48000);
    const right = sineBuffer(frames, 660, 48000);
    const originalLeft = left.slice();
    const originalRight = right.slice();
    apply([ZERO_GAIN_EQ], left, right);
    expect(left).toEqual(originalLeft);
    expect(right).toEqual(originalRight);
  });

  it('stays finite at the maximum gain extremes', () => {
    const frames = 48000;
    const left = sineBuffer(frames, 1000, 48000);
    const right = left.slice();
    apply([{ type: 'eq', lowGainDb: 18, midGainDb: 18, highGainDb: 18 }], left, right);
    expectFinite(left);
    apply([{ type: 'eq', lowGainDb: -18, midGainDb: -18, highGainDb: -18 }], left, right);
    expectFinite(left);
  });
});

describe('deterministic reverb', () => {
  it('produces a finite decaying tail that is gone by the decay estimate', () => {
    const sampleRate = 48000 as const;
    const frames = sampleRate * 4;
    const { left, right } = impulseBuffers(frames);
    apply([{ type: 'reverb', decaySeconds: 1.8, mix: 1 }], left, right, { sampleRate });

    const early = rmsAt(left, sampleRate, 0, 0.1);
    const middle = rmsAt(left, sampleRate, 0.8, 1.0);
    const late = rmsAt(left, sampleRate, 2.5, 3.0);
    expect(early).toBeGreaterThan(0.001);
    expect(middle).toBeGreaterThan(0);
    expect(middle).toBeGreaterThan(late);
    expect(late).toBeLessThan(1e-4);
    expectFinite(left);
    expectFinite(right);
  });

  it('scales the tail with decaySeconds', () => {
    const sampleRate = 48000 as const;
    const frames = sampleRate * 2;

    const short = impulseBuffers(frames);
    apply([{ type: 'reverb', decaySeconds: 0.2, mix: 1 }], short.left, short.right, {
      sampleRate,
    });
    const long = impulseBuffers(frames);
    apply([{ type: 'reverb', decaySeconds: 10, mix: 1 }], long.left, long.right, { sampleRate });

    const shortTail = rmsAt(short.left, sampleRate, 0.8, 1.0);
    const longTail = rmsAt(long.left, sampleRate, 0.8, 1.0);
    expect(shortTail).toBeLessThan(longTail * 0.01);
  });

  it('bypasses a mix-0 reverb bit-exactly', () => {
    const frames = 4096;
    const left = sineBuffer(frames, 220, 48000);
    const right = sineBuffer(frames, 331, 48000);
    const originalLeft = left.slice();
    const originalRight = right.slice();
    apply([{ type: 'reverb', decaySeconds: 5, mix: 0 }], left, right);
    expect(left).toEqual(originalLeft);
    expect(right).toEqual(originalRight);
  });

  it('preserves the input stereo balance through the dual-mono reverb', () => {
    const frames = 48000;
    const { left, right } = impulseBuffers(frames, 0.8, 0.2);
    apply([{ type: 'reverb', decaySeconds: 1.8, mix: 1 }], left, right);

    let compared = 0;
    for (let frame = 0; frame < frames; frame += 1) {
      const leftValue = left[frame] ?? 0;
      const rightValue = right[frame] ?? 0;
      if (Math.abs(leftValue) > 1e-6) {
        expect(rightValue / leftValue).toBeCloseTo(0.25, 6);
        compared += 1;
      }
    }
    expect(compared).toBeGreaterThan(100);
  });

  it('repeats byte-identically from empty state', () => {
    const frames = 48000;
    const first = impulseBuffers(frames);
    apply([{ type: 'reverb', decaySeconds: 3.2, mix: 0.4 }], first.left, first.right);
    const second = impulseBuffers(frames);
    apply([{ type: 'reverb', decaySeconds: 3.2, mix: 0.4 }], second.left, second.right);
    expect(first.left).toEqual(second.left);
    expect(first.right).toEqual(second.right);
  });
});

describe('authored effect order and schema limits', () => {
  it('applies a time-varying low-pass before or after a delay as authored', () => {
    const frames = 48000;
    const automation = createAutomationCurve(
      [
        { timeBeats: 0, timeSeconds: 0, value: 20000 },
        { timeBeats: 4, timeSeconds: 1, value: 200 },
      ],
      { target: 'filterCutoffHz', sampleRate: 48000 },
    );
    const lowpass: NormalizedEffect = { type: 'lowpass', q: 1 };
    const delay: NormalizedEffect = { type: 'delay', timeMs: 100, feedback: 0, mix: 1 };

    const filterThenDelay = impulseBuffers(frames);
    apply([lowpass, delay], filterThenDelay.left, filterThenDelay.right, {
      cutoffAutomation: automation,
    });
    const delayThenFilter = impulseBuffers(frames);
    apply([delay, lowpass], delayThenFilter.left, delayThenFilter.right, {
      cutoffAutomation: automation,
    });

    let difference = 0;
    for (let frame = 0; frame < frames; frame += 1) {
      difference = Math.max(
        difference,
        Math.abs((filterThenDelay.left[frame] ?? 0) - (delayThenFilter.left[frame] ?? 0)),
      );
    }
    expect(difference).toBeGreaterThan(1e-4);
    expectFinite(filterThenDelay.left);
    expectFinite(delayThenFilter.left);
  });

  it('handles eight effects, the schema maximum, with bounded finite state', () => {
    const effects: NormalizedEffect[] = [
      { type: 'eq', lowGainDb: 6, midGainDb: -3, highGainDb: 4 },
      { type: 'lowpass', cutoffHz: 12000, q: 2 },
      { type: 'delay', timeMs: 2000, feedback: 0.9, mix: 0.5 },
      { type: 'reverb', decaySeconds: 10, mix: 0.5 },
      { type: 'eq', lowGainDb: -6, midGainDb: 2, highGainDb: -4 },
      { type: 'delay', timeMs: 10, feedback: 0.9, mix: 0.5 },
      { type: 'reverb', decaySeconds: 0.2, mix: 0.5 },
      { type: 'eq', lowGainDb: 12, midGainDb: 12, highGainDb: 12 },
    ];
    const frames = 48000;
    const first = impulseBuffers(frames);
    apply(effects, first.left, first.right);
    const second = impulseBuffers(frames);
    apply(effects, second.left, second.right);

    expectFinite(first.left);
    expectFinite(first.right);
    expect(first.left).toEqual(second.left);
    expect(first.right).toEqual(second.right);
  });

  it('renders the 16-track, eight-effect-per-track schema limit within bounded time', async () => {
    const effects: NormalizedEffect[] = [
      { type: 'eq', lowGainDb: 6, midGainDb: 0, highGainDb: 0 },
      { type: 'lowpass', cutoffHz: 5000, q: 1 },
      { type: 'delay', timeMs: 10, feedback: 0, mix: 0.25 },
      { type: 'reverb', decaySeconds: 0.2, mix: 0.25 },
      { type: 'eq', lowGainDb: -6, midGainDb: 0, highGainDb: 0 },
      { type: 'delay', timeMs: 20, feedback: 0, mix: 0.25 },
      { type: 'reverb', decaySeconds: 0.2, mix: 0.25 },
      { type: 'eq', lowGainDb: 0, midGainDb: 2, highGainDb: 0 },
    ];
    const channels = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15];
    const tracks = channels.map((channel, index) =>
      clipTrack(`track-${index}`, [clipNote(48 + index, 0, 0.25, 100)], {
        channel,
        effects,
      }),
    );
    tracks.push(
      clipTrack('drums', [clipNote(36, 0, 0.25, 100)], {
        name: 'drums',
        kind: 'drums',
        channel: 9,
        instrument: { type: 'builtin', id: 'drums.kit' },
        effects,
      }),
    );
    const timeline = compileOk(baseSong({ durationHint: 0.5, tracks }), {
      sampleRate: 48000,
    }).timeline;
    expect(timeline.tracks).toHaveLength(16);
    const started = performance.now();
    const first = await renderTimelineAudio(timeline);
    const wallMs = performance.now() - started;
    const second = await renderTimelineAudio(timeline);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.audio.frameCount).toBe(timeline.renderedSamples);
      expectFinite(first.audio.left);
      expectFinite(first.audio.right);
      expect(first.audio.left).toEqual(second.audio.left);
      expect(first.audio.right).toEqual(second.audio.right);
      expect(first.stats.renderedTrackCount).toBe(16);
    }
    // Observation only. There is no universal speed gate; this catches a
    // pathological regression at the documented schema limit.
    expect(wallMs).toBeLessThan(30_000);
  }, 60_000);

  it('leaves a dry track untouched when the authored chain is transparent', () => {
    const frames = 2048;
    const left = sineBuffer(frames, 220, 48000);
    const right = sineBuffer(frames, 331, 48000);
    const originalLeft = left.slice();
    const originalRight = right.slice();
    apply(
      [
        { type: 'reverb', mix: 0, decaySeconds: 1.8 },
        { type: 'delay', mix: 0, timeMs: 375, feedback: 0.35 },
        ZERO_GAIN_EQ,
      ],
      left,
      right,
    );
    expect(left).toEqual(originalLeft);
    expect(right).toEqual(originalRight);
  });

  it('reproduces the dry path bit-exactly through the renderer when effects are disabled', async () => {
    const notes = [clipNote(60, 0, 2, 100), clipNote(64, 1, 1, 90)];
    const drySong = baseSong({ durationHint: 4, tracks: [clipTrack('keys', notes)] });
    const transparentSong = baseSong({
      durationHint: 4,
      tracks: [
        clipTrack('keys', notes, {
          effects: [
            { type: 'eq', lowGainDb: 0, midGainDb: 0, highGainDb: 0 },
            { type: 'delay', timeMs: 375, feedback: 0.35, mix: 0 },
            { type: 'reverb', decaySeconds: 1.8, mix: 0 },
          ],
        }),
      ],
    });
    const dry = await renderSongAudio(drySong, { sampleRate: 48000 });
    const transparent = await renderSongAudio(transparentSong, { sampleRate: 48000 });
    expect(dry.ok).toBe(true);
    expect(transparent.ok).toBe(true);
    if (dry.ok && transparent.ok) {
      expect(sameFloat32(dry.audio.left, transparent.audio.left)).toBe(true);
      expect(sameFloat32(dry.audio.right, transparent.audio.right)).toBe(true);
    }
  });

  it('does not treat a 20 kHz low-pass as part of the dry baseline', async () => {
    const notes = [clipNote(72, 0, 2, 110)];
    const drySong = baseSong({ durationHint: 4, tracks: [clipTrack('keys', notes)] });
    const filteredSong = baseSong({
      durationHint: 4,
      tracks: [
        clipTrack('keys', notes, {
          effects: [{ type: 'lowpass', cutoffHz: 20000, q: 1 }],
        }),
      ],
    });
    const backend = createSignalBackend(
      (frame) => 0.5 * Math.sin((2 * Math.PI * 12000 * frame) / 48000),
    );
    const dry = await renderSongAudio(drySong, { sampleRate: 48000, backend });
    const filtered = await renderSongAudio(filteredSong, { sampleRate: 48000, backend });
    expect(dry.ok).toBe(true);
    expect(filtered.ok).toBe(true);
    if (dry.ok && filtered.ok) {
      expect(sameFloat32(dry.audio.left, filtered.audio.left)).toBe(false);
    }
  });
});

describe('effect rendering through the shared timeline', () => {
  it('renders the canonical effects fixture deterministically with a finite tail', async () => {
    const song = baseSong({
      durationHint: 24,
      tracks: [
        clipTrack('guitar', [clipNote(60, 0, 1), clipNote(64, 1, 1)], {
          instrument: { type: 'builtin', id: 'guitar.clean' },
          effects: [
            { type: 'eq', lowGainDb: -2, midGainDb: 1.5, highGainDb: 2 },
            { type: 'lowpass', cutoffHz: 4200, q: 0.7 },
            { type: 'delay', timeMs: 375, feedback: 0.3, mix: 0.18 },
            { type: 'reverb', mix: 0.22, decaySeconds: 2.2 },
          ],
        }),
      ],
    });
    const timeline = compileOk(song, { sampleRate: 48000 }).timeline;
    const first = await renderTimelineAudio(timeline);
    const second = await renderTimelineAudio(timeline);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) {
      return;
    }
    expect(first.audio.frameCount).toBe(timeline.renderedSamples);
    expect(first.audio.left).toEqual(second.audio.left);
    expect(first.audio.right).toEqual(second.audio.right);
    expect(timeline.tracks[0]?.tailSeconds).toBeGreaterThan(0);
    const contentFrame = Math.ceil((timeline.tracks[0]?.contentEndSeconds ?? 0) * 48000);
    let energyAfterContent = 0;
    for (let frame = contentFrame; frame < first.audio.frameCount; frame += 1) {
      energyAfterContent = Math.max(
        energyAfterContent,
        Math.abs(first.audio.left[frame] ?? 0),
        Math.abs(first.audio.right[frame] ?? 0),
      );
    }
    expect(energyAfterContent).toBeGreaterThan(1e-5);
  }, 20_000);

  it('truncates a capped 30 second delay tail deterministically', async () => {
    const song = baseSong({
      durationHint: 2,
      tracks: [
        clipTrack('keys', [clipNote(60, 0, 1, 100)], {
          effects: [{ type: 'delay', timeMs: 2000, feedback: 0.9, mix: 0.5 }],
        }),
      ],
    });
    const timeline = compileOk(song, { sampleRate: 48000 }).timeline;
    expect(timeline.tracks[0]?.tailSeconds).toBe(30);
    // At 120 BPM the one-beat note ends at 0.5 s, so the window is 30.5 s.
    expect(timeline.renderedSeconds).toBeCloseTo(30.5, 9);
    const rendered = await renderTimelineAudio(timeline);
    expect(rendered.ok).toBe(true);
    if (rendered.ok) {
      expect(rendered.audio.frameCount).toBe(timeline.renderedSamples);
      expectFinite(rendered.audio.left);
      const finalFrame = rendered.audio.frameCount - 1;
      const finalPeak = Math.max(
        Math.abs(rendered.audio.left[finalFrame] ?? 0),
        Math.abs(rendered.audio.right[finalFrame] ?? 0),
      );
      expect(finalPeak).toBeGreaterThan(0);
    }
  }, 20_000);
});
