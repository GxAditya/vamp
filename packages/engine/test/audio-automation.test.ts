import { describe, expect, it } from 'vitest';

import type { Automation, Note, SongSchemaV1 } from '@gxaditya/vamp-schema';

import { createAutomationCurve, renderTimelineAudio, type SongTimeline } from '../src/index.js';
import {
  constantSignal,
  createSignalBackend,
  impulseSignal,
  measureRms,
  sameFloat32,
} from './audio-helpers.js';
import { baseSong, clipNote, clipTrack, compileOk } from './helpers.js';

const SAMPLE_RATE = 48000 as const;

function compileAt120(song: SongSchemaV1): SongTimeline {
  return compileOk(song, { sampleRate: SAMPLE_RATE }).timeline;
}

function automationSong(automation: Automation, notes: Note[] = [clipNote(60, 0, 4, 100)]) {
  return baseSong({
    bpm: 120,
    durationHint: 4,
    tracks: [clipTrack('keys', notes, { automation })],
  });
}

async function renderWithSignal(timeline: SongTimeline, value = 1) {
  const rendered = await renderTimelineAudio(timeline, {
    backend: createSignalBackend(constantSignal(value)),
  });
  if (!rendered.ok) {
    throw new Error(`Expected automation render success: ${JSON.stringify(rendered.errors)}`);
  }
  return rendered;
}

describe('automation curve semantics', () => {
  it('holds endpoints and interpolates linearly in the target units', () => {
    const curve = createAutomationCurve(
      [
        { timeBeats: 0, timeSeconds: 0, value: 0.25 },
        { timeBeats: 2, timeSeconds: 1, value: 0.75 },
        { timeBeats: 4, timeSeconds: 2, value: 0.25 },
      ],
      { target: 'volume', sampleRate: SAMPLE_RATE },
    );

    expect(curve.constantValue).toBeNull();
    expect(curve.valueAtFrame(-100)).toBe(0.25);
    expect(curve.valueAtFrame(0)).toBe(0.25);
    expect(curve.valueAtFrame(24000)).toBeCloseTo(0.5, 12);
    expect(curve.valueAtFrame(48000)).toBeCloseTo(0.75, 12);
    expect(curve.valueAtFrame(72000)).toBeCloseTo(0.5, 12);
    expect(curve.valueAtFrame(96000)).toBe(0.25);
    expect(curve.valueAtFrame(10 ** 9)).toBe(0.25);
  });

  it('holds the first value when the first keyframe starts later', () => {
    const curve = createAutomationCurve(
      [
        { timeBeats: 2, timeSeconds: 1, value: 0.2 },
        { timeBeats: 4, timeSeconds: 2, value: 0.8 },
      ],
      { target: 'volume', sampleRate: SAMPLE_RATE },
    );
    expect(curve.valueAtFrame(0)).toBe(0.2);
    expect(curve.valueAtFrame(24000)).toBe(0.2);
    expect(curve.valueAtFrame(72000)).toBeCloseTo(0.5, 12);
    expect(curve.valueAtFrame(96000)).toBe(0.8);
    expect(curve.valueAtFrame(10 ** 9)).toBe(0.8);
  });

  it('interpolates cutoff linearly in hertz, not logarithmically', () => {
    const curve = createAutomationCurve(
      [
        { timeBeats: 0, timeSeconds: 0, value: 20 },
        { timeBeats: 8, timeSeconds: 4, value: 20000 },
      ],
      { target: 'filterCutoffHz', sampleRate: SAMPLE_RATE },
    );
    // The geometric midpoint of 20 and 20000 is 632.5, the linear one is 10010.
    expect(curve.valueAtFrame(96000)).toBeCloseTo(10010, 9);
  });

  it('exposes a constant value for a flat curve', () => {
    const curve = createAutomationCurve(
      [
        { timeBeats: 0, timeSeconds: 0, value: 0.75 },
        { timeBeats: 4, timeSeconds: 2, value: 0.75 },
      ],
      { target: 'volume', sampleRate: SAMPLE_RATE },
    );
    expect(curve.constantValue).toBe(0.75);
    expect(curve.valueAtFrame(0)).toBe(0.75);
    expect(curve.valueAtFrame(10 ** 9)).toBe(0.75);
  });
});

describe('volume and pan automation in the shared mixer', () => {
  it('applies automated volume per sample with exact start and interpolated midpoint', async () => {
    const timeline = compileAt120(
      automationSong({
        volume: {
          points: [
            { time: 0, value: 0.5 },
            { time: 4, value: 1.5 },
          ],
        },
      }),
    );
    const rendered = await renderWithSignal(timeline);
    const center = Math.SQRT1_2;
    expect(rendered.audio.frameCount).toBe(96000);

    // Frame 0 uses the first keyframe exactly. The static normalized volume is
    // 1, so this also proves automation wins over the static field.
    expect(rendered.audio.left[0]).toBeCloseTo(0.5 * center, 6);
    expect(rendered.audio.right[0]).toBeCloseTo(0.5 * center, 6);

    // One second is the curve midpoint. A 2 ms de-zipper lags a linear ramp by
    // roughly 0.001 of the target range.
    expect(rendered.audio.left[48000]).toBeCloseTo(1.0 * center, 2);
    const lastFrame = rendered.audio.frameCount - 1;
    expect(rendered.audio.left[lastFrame]).toBeCloseTo(1.5 * center, 2);
    expect(rendered.audio.left[lastFrame]).toBeGreaterThan(rendered.audio.left[48000] ?? 0);
  });

  it('applies automated equal-power pan from hard left to hard right', async () => {
    const timeline = compileAt120(
      automationSong({
        pan: {
          points: [
            { time: 0, value: -1 },
            { time: 4, value: 1 },
          ],
        },
      }),
    );
    const rendered = await renderWithSignal(timeline);

    expect(rendered.audio.left[0]).toBeCloseTo(1, 6);
    expect(rendered.audio.right[0]).toBeCloseTo(0, 6);
    expect(rendered.audio.left[48000]).toBeCloseTo(Math.SQRT1_2, 2);
    expect(rendered.audio.right[48000]).toBeCloseTo(Math.SQRT1_2, 2);

    const lastFrame = rendered.audio.frameCount - 1;
    expect(rendered.audio.left[lastFrame]).toBeLessThan(0.002);
    expect(rendered.audio.right[lastFrame]).toBeGreaterThan(0.998);
  });

  it('holds the first pan value before the first keyframe', async () => {
    const timeline = compileAt120(
      automationSong({
        pan: {
          points: [
            { time: 2, value: -0.5 },
            { time: 4, value: 0.5 },
          ],
        },
      }),
    );
    const rendered = await renderWithSignal(timeline);
    const pan = -0.5;
    expect(rendered.audio.left[0]).toBeCloseTo(Math.cos(((pan + 1) * Math.PI) / 4), 6);
    expect(rendered.audio.right[0]).toBeCloseTo(Math.sin(((pan + 1) * Math.PI) / 4), 6);
  });

  it('matches the static path bit-exactly for constant automation', async () => {
    const staticSong = baseSong({
      bpm: 120,
      durationHint: 4,
      tracks: [clipTrack('keys', [clipNote(60, 0, 4, 100)], { volume: 0.75, pan: 0.25 })],
    });
    const automatedSong = automationSong({
      volume: {
        points: [
          { time: 0, value: 0.75 },
          { time: 4, value: 0.75 },
        ],
      },
      pan: {
        points: [
          { time: 0, value: 0.25 },
          { time: 4, value: 0.25 },
        ],
      },
    });
    const backend = createSignalBackend(constantSignal(1));
    const staticRendered = await renderTimelineAudio(compileAt120(staticSong), { backend });
    const automatedRendered = await renderTimelineAudio(compileAt120(automatedSong), { backend });
    expect(staticRendered.ok).toBe(true);
    expect(automatedRendered.ok).toBe(true);
    if (staticRendered.ok && automatedRendered.ok) {
      expect(sameFloat32(staticRendered.audio.left, automatedRendered.audio.left)).toBe(true);
      expect(sameFloat32(staticRendered.audio.right, automatedRendered.audio.right)).toBe(true);
    }
  });

  it('keeps automation on an inaudible track silent and harmless', async () => {
    const mutedSong = baseSong({
      bpm: 120,
      durationHint: 4,
      tracks: [
        clipTrack('muted', [clipNote(60, 0, 4, 100)], {
          mute: true,
          automation: {
            volume: {
              points: [
                { time: 0, value: 0.2 },
                { time: 4, value: 1 },
              ],
            },
          },
        }),
        clipTrack('audible', [clipNote(48, 0, 4, 100)], { channel: 1 }),
      ],
    });
    const audibleOnlySong = baseSong({
      bpm: 120,
      durationHint: 4,
      tracks: [clipTrack('audible', [clipNote(48, 0, 4, 100)], { channel: 1 })],
    });
    const backend = createSignalBackend(constantSignal(1));
    const muted = await renderTimelineAudio(compileAt120(mutedSong), { backend });
    const audibleOnly = await renderTimelineAudio(compileAt120(audibleOnlySong), { backend });
    expect(muted.ok).toBe(true);
    expect(audibleOnly.ok).toBe(true);
    if (muted.ok && audibleOnly.ok) {
      expect(muted.stats.audibleTrackCount).toBe(1);
      expect(sameFloat32(muted.audio.left, audibleOnly.audio.left)).toBe(true);
      expect(sameFloat32(muted.audio.right, audibleOnly.audio.right)).toBe(true);
    }
  });
});

describe('cutoff automation', () => {
  it('sweeps the authored low-pass in hertz without extending duration', async () => {
    const song = baseSong({
      bpm: 120,
      durationHint: 4,
      tracks: [
        clipTrack('pad', [clipNote(60, 0, 4, 100)], {
          instrument: { type: 'builtin', id: 'pad.warm' },
          effects: [{ type: 'lowpass', q: 1 }],
          automation: {
            filterCutoffHz: {
              points: [
                { time: 0, value: 20000 },
                { time: 4, value: 200 },
              ],
            },
          },
        }),
      ],
    });
    const timeline = compileAt120(song);
    expect(timeline.renderedSeconds).toBeCloseTo(2, 9);
    const backend = createSignalBackend(
      (frame) => 0.5 * Math.sin((2 * Math.PI * 5000 * frame) / SAMPLE_RATE),
    );
    const rendered = await renderTimelineAudio(timeline, { backend });
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) {
      return;
    }

    const early = measureRms(rendered.audio.left, 0, 0.2 * SAMPLE_RATE);
    const late = measureRms(rendered.audio.left, 1.8 * SAMPLE_RATE, 2 * SAMPLE_RATE);
    expect(early).toBeGreaterThan(0.2);
    expect(late).toBeLessThan(early * 0.2);
  });

  it('does not extend duration for automation points after the content', () => {
    const song = baseSong({
      bpm: 120,
      durationHint: 2,
      tracks: [
        clipTrack('keys', [clipNote(60, 0, 2, 100)], {
          automation: {
            volume: {
              points: [
                { time: 0, value: 1 },
                { time: 100, value: 0 },
              ],
            },
          },
        }),
      ],
    });
    const timeline = compileAt120(song);
    expect(timeline.renderedSeconds).toBeCloseTo(1, 9);
    expect(timeline.renderedSamples).toBe(48000);
  });

  it('leaves effect tails inside the shared rendered window', async () => {
    const song = baseSong({
      bpm: 120,
      durationHint: 1,
      tracks: [
        clipTrack('keys', [clipNote(60, 0, 1, 100)], {
          effects: [{ type: 'delay', timeMs: 375, feedback: 0.5, mix: 0.5 }],
        }),
      ],
    });
    const timeline = compileAt120(song);
    // 0.5 s content plus a 3.75 s decay-to-minus-60-dB delay tail.
    expect(timeline.renderedSeconds).toBeCloseTo(4.25, 9);
    expect(timeline.renderedSamples).toBe(Math.ceil(4.25 * SAMPLE_RATE));
    const rendered = await renderTimelineAudio(timeline, {
      backend: createSignalBackend((frame) => impulseSignal(frame)),
    });
    expect(rendered.ok).toBe(true);
    if (rendered.ok) {
      expect(rendered.audio.frameCount).toBe(timeline.renderedSamples);
      let tailPeak = 0;
      const contentFrame = Math.ceil((timeline.tracks[0]?.contentEndSeconds ?? 0) * SAMPLE_RATE);
      for (let frame = contentFrame; frame < rendered.audio.frameCount; frame += 1) {
        tailPeak = Math.max(
          tailPeak,
          Math.abs(rendered.audio.left[frame] ?? 0),
          Math.abs(rendered.audio.right[frame] ?? 0),
        );
      }
      expect(tailPeak).toBeGreaterThan(1e-4);
    }
  });
});

describe('automation bounds', () => {
  it('handles the 512 point target maximum and stays deterministic', async () => {
    const points = Array.from({ length: 512 }, (_, index) => ({
      time: (index * 4) / 511,
      value: index % 2 === 0 ? 0 : 1,
    }));
    const song = baseSong({
      bpm: 120,
      durationHint: 4,
      tracks: [
        clipTrack('keys', [clipNote(60, 0, 4, 100)], { automation: { volume: { points } } }),
      ],
    });
    const timeline = compileAt120(song);
    const backend = createSignalBackend(constantSignal(1));
    const first = await renderTimelineAudio(timeline, { backend });
    const second = await renderTimelineAudio(timeline, { backend });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.audio.frameCount).toBe(96000);
      expect(sameFloat32(first.audio.left, second.audio.left)).toBe(true);
      expect(sameFloat32(first.audio.right, second.audio.right)).toBe(true);
    }
  });
});
