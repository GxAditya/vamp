import { describe, expect, it } from 'vitest';

import type { Note, SongSchemaV1 } from '@gxaditya/vamp-schema';

import {
  measureAudio,
  parseWav,
  renderSongOk,
  renderWavOk,
  loadBuiltinCue,
  countNonZeroPcmFrames,
  lastNonZeroFrame,
  assertFinite,
} from './audio-helpers.js';
import { baseSong, clipNote, clipTrack } from './helpers.js';
import { renderTimelineAudio } from '../src/index.js';

function oneTrackSong(
  notes: Note[],
  options: { durationHint: number; bpm?: number; volume?: number } = { durationHint: 1 },
): SongSchemaV1 {
  return baseSong({
    bpm: options.bpm ?? 120,
    durationHint: options.durationHint,
    tracks: [
      clipTrack('keys', notes, {
        volume: options.volume ?? 1,
        instrument: { type: 'builtin', id: 'keys.soft' },
      }),
    ],
  });
}

describe('output edges and bounds', () => {
  it('renders a real 45 second multi-track builtin cue end to end', async () => {
    const song = loadBuiltinCue();
    const startedAt = performance.now();
    const rendered = await renderWavOk(song, { sampleRate: 48000 });
    const wallMs = performance.now() - startedAt;
    const parsed = parseWav(rendered.bytes);

    expect(rendered.timeline.renderedSeconds).toBe(45);
    expect(rendered.timeline.renderedSamples).toBe(2_160_000);
    expect(rendered.timeline.stats.trackCount).toBe(5);
    expect(parsed.frameCount).toBe(2_160_000);
    expect(parsed.dataSize).toBe(8_640_000);
    expect(parsed.fileBytes).toBe(8_640_044);
    expect(rendered.bytes.length).toBe(8_640_044);
    expect(rendered.report.sampleRate).toBe(48000);
    expect(rendered.report.clippedSampleCount).toBe(0);
    expect(rendered.report.peak).toBeGreaterThan(0.15);
    expect(rendered.report.peak).toBeLessThan(1);
    expect(rendered.stats.tracks).toHaveLength(5);
    expect(rendered.stats.tracks.every((track) => track.peak > 0)).toBe(true);
    expect(rendered.stats.droppedVoices).toBe(0);
    expect(rendered.warnings).toEqual([]);
    expect(countNonZeroPcmFrames(rendered.bytes, parsed)).toBeGreaterThan(2_000_000);

    // Observation only. This is not a universal performance claim; the
    // benchmark report records this machine's wall time and memory.
    expect(wallMs).toBeGreaterThan(0);
  }, 20_000);

  it('renders short notes without dropping them to silence', async () => {
    const rendered = await renderSongOk(
      oneTrackSong([clipNote(60, 0, 0.01, 120)], { durationHint: 0.01 }),
      { sampleRate: 48000 },
    );
    expect(rendered.audio.frameCount).toBe(240);
    assertFinite(rendered.audio);
    expect(measureAudio(rendered.audio).peak).toBeGreaterThan(0.0001);
    expect(rendered.stats.startedVoices).toBe(1);
  });

  it('truncates release at the documented output boundary', async () => {
    const rendered = await renderSongOk(
      oneTrackSong([clipNote(60, 0, 2, 110)], { durationHint: 2 }),
      { sampleRate: 48000 },
    );
    expect(rendered.audio.frameCount).toBe(48000);
    assertFinite(rendered.audio);
    // The notated note ends at the final frame, so release begins outside the
    // output. Sustained signal reaches the boundary without a synthetic fade.
    const lastFrame = rendered.audio.frameCount - 1;
    const tailPeak = Math.max(
      Math.abs(rendered.audio.left[lastFrame] ?? 0),
      Math.abs(rendered.audio.right[lastFrame] ?? 0),
    );
    expect(tailPeak).toBeGreaterThan(0.001);
    expect(rendered.audio.frameCount).toBe(rendered.timeline.renderedSamples);
  });

  it('leaves trailing hint silence exactly zero after release ends', async () => {
    const rendered = await renderSongOk(
      oneTrackSong([clipNote(60, 0, 1, 110)], { durationHint: 4 }),
      { sampleRate: 48000 },
    );
    expect(rendered.audio.frameCount).toBe(96000);
    const last = lastNonZeroFrame(rendered.audio);
    expect(last).toBeGreaterThan(0);
    expect(last).toBeLessThan(48000);
    for (let frame = 48000; frame < rendered.audio.frameCount; frame += 1) {
      if ((rendered.audio.left[frame] ?? 0) !== 0 || (rendered.audio.right[frame] ?? 0) !== 0) {
        throw new Error(`Expected silence at frame ${frame}`);
      }
    }
  });

  it('handles a dense 40-note chord through the voice cap without clipping or NaN', async () => {
    const notes = Array.from({ length: 40 }, (_, index) => clipNote(40 + index, 0, 1, 100));
    const rendered = await renderSongOk(oneTrackSong(notes, { durationHint: 1 }), {
      sampleRate: 48000,
    });
    assertFinite(rendered.audio);
    expect(rendered.stats.startedVoices).toBe(32);
    expect(rendered.stats.droppedVoices).toBe(8);
    expect(rendered.stats.tracks[0]?.peakActiveVoices).toBe(32);
    expect(rendered.warnings.some((issue) => issue.code === 'audio.voice.dropped')).toBe(true);
    const measured = measureAudio(rendered.audio);
    expect(measured.peak).toBeCloseTo(rendered.stats.peak, 6);
    expect(measured.peak).toBeLessThan(8);
  });

  it('renders both supported sample rates with the same musical content', async () => {
    const song = oneTrackSong([clipNote(60, 0, 1, 100)], { durationHint: 2 });
    const rate44 = await renderSongOk(song, { sampleRate: 44100 });
    const rate48 = await renderSongOk(song, { sampleRate: 48000 });
    expect(rate44.audio.frameCount).toBe(44100);
    expect(rate48.audio.frameCount).toBe(48000);
    expect(rate44.stats.peak).toBeCloseTo(rate48.stats.peak, 1);
    expect(rate44.audio.sampleRate).toBe(44100);
    expect(rate48.audio.sampleRate).toBe(48000);
  });

  it('returns a structured failure, not a throw, for a forged frame count', async () => {
    const song = oneTrackSong([clipNote(60, 0, 1, 100)], { durationHint: 1 });
    const compiled = await renderSongOk(song, { sampleRate: 48000 });
    const forged = { ...compiled.timeline, renderedSamples: 10 ** 12 };
    const result = await renderTimelineAudio(forged);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.code).toBe('audio.timeline.invalid');
    }
  });
});
