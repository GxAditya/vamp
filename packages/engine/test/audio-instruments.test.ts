import { describe, expect, it } from 'vitest';

import type { BuiltinInstrumentId, SongSchemaV1 } from '@gxaditya/vamp-schema';

import { BUILTIN_DRUM_MAP } from '../src/index.js';
import {
  assertFinite,
  measureAudio,
  renderSongOk,
  sameFloat32,
  type AudioMetrics,
} from './audio-helpers.js';
import { baseSong, clipNote, clipTrack } from './helpers.js';

const PITCHED_IDS = ['keys.soft', 'piano.soft', 'bass.sub', 'pad.warm', 'guitar.clean'] as const;

function songForInstrument(
  id: BuiltinInstrumentId,
  pitch: number,
  options: { durationBeats?: number; durationHintBeats?: number; velocity?: number } = {},
): SongSchemaV1 {
  const drums = id === 'drums.kit';
  return baseSong({
    durationHint: options.durationHintBeats ?? 1,
    tracks: [
      clipTrack(
        drums ? 'drums' : 'instrument',
        [clipNote(pitch, 0, options.durationBeats ?? (drums ? 0.25 : 1), options.velocity ?? 110)],
        {
          kind: drums ? 'drums' : 'midi',
          channel: drums ? 9 : 0,
          instrument: { type: 'builtin', id },
        },
      ),
    ],
  });
}

function isDistinct(left: AudioMetrics, right: AudioMetrics): boolean {
  const energyDelta = Math.abs(left.rms - right.rms) / Math.max(left.rms, right.rms, 1e-12);
  const shapeDelta =
    Math.abs(left.zeroCrossingRate - right.zeroCrossingRate) /
    Math.max(left.zeroCrossingRate, right.zeroCrossingRate, 1e-12);
  return energyDelta > 0.05 || shapeDelta > 0.05;
}

function windowRms(
  audio: { readonly left: Float32Array; readonly right: Float32Array; readonly frameCount: number },
  sampleRate: number,
  startSeconds: number,
  endSeconds: number,
): number {
  const start = Math.min(audio.frameCount, Math.max(0, Math.round(startSeconds * sampleRate)));
  const end = Math.min(audio.frameCount, Math.max(start, Math.round(endSeconds * sampleRate)));
  let energy = 0;
  for (let frame = start; frame < end; frame += 1) {
    const left = audio.left[frame] ?? 0;
    const right = audio.right[frame] ?? 0;
    energy += left * left + right * right;
  }
  return Math.sqrt(energy / Math.max(1, (end - start) * 2));
}

describe('built-in instrument voices', () => {
  it('gives all six builtin IDs distinct, non-silent, deterministic voices', async () => {
    const ids: BuiltinInstrumentId[] = [...PITCHED_IDS, 'drums.kit'];
    const metrics: AudioMetrics[] = [];

    for (const id of ids) {
      const rendered = await renderSongOk(songForInstrument(id, id === 'drums.kit' ? 36 : 60), {
        sampleRate: 48000,
      });
      assertFinite(rendered.audio);
      const measured = measureAudio(rendered.audio);
      expect(measured.rms, `${id} should be audible`).toBeGreaterThan(0.001);
      expect(measured.peak, `${id} should peak below full scale`).toBeLessThan(1);
      metrics.push(measured);

      const again = await renderSongOk(songForInstrument(id, id === 'drums.kit' ? 36 : 60), {
        sampleRate: 48000,
      });
      expect(sameFloat32(rendered.audio.left, again.audio.left), `${id} determinism`).toBe(true);
      expect(sameFloat32(rendered.audio.right, again.audio.right), `${id} determinism`).toBe(true);
    }

    for (let left = 0; left < metrics.length; left += 1) {
      for (let right = left + 1; right < metrics.length; right += 1) {
        expect(
          isDistinct(metrics[left] as AudioMetrics, metrics[right] as AudioMetrics),
          `${ids[left]} and ${ids[right]} should differ in energy or spectral shape`,
        ).toBe(true);
      }
    }
  });

  it('covers every GM percussion key and maps the documented families', () => {
    expect(BUILTIN_DRUM_MAP).toHaveLength(47);
    expect(BUILTIN_DRUM_MAP.map((entry) => entry.pitch)).toEqual(
      Array.from({ length: 47 }, (_, index) => 35 + index),
    );

    const byPitch = new Map(BUILTIN_DRUM_MAP.map((entry) => [entry.pitch, entry]));
    expect(byPitch.get(35)).toMatchObject({ name: 'Acoustic Bass Drum', family: 'kick' });
    expect(byPitch.get(36)).toMatchObject({ name: 'Bass Drum 1', family: 'kick' });
    expect(byPitch.get(38)).toMatchObject({ name: 'Acoustic Snare', family: 'snare' });
    expect(byPitch.get(42)).toMatchObject({ name: 'Closed Hi-Hat', family: 'closed-hat' });
    expect(byPitch.get(46)).toMatchObject({ name: 'Open Hi-Hat', family: 'open-hat' });
    expect(byPitch.get(49)).toMatchObject({ name: 'Crash Cymbal 1', family: 'crash' });
    expect(byPitch.get(51)).toMatchObject({ name: 'Ride Cymbal 1', family: 'ride' });
    expect(byPitch.get(54)).toMatchObject({ name: 'Tambourine', family: 'shaker' });
    expect(byPitch.get(81)).toMatchObject({ name: 'Open Triangle', family: 'metal' });
  });

  it('synthesizes distinct kick, snare, hat, and cymbal responses from GM keys', async () => {
    const kick = await renderSongOk(songForInstrument('drums.kit', 36), { sampleRate: 48000 });
    const snare = await renderSongOk(songForInstrument('drums.kit', 38), { sampleRate: 48000 });
    const closedHat = await renderSongOk(songForInstrument('drums.kit', 42), {
      sampleRate: 48000,
    });
    const openHat = await renderSongOk(songForInstrument('drums.kit', 46), {
      sampleRate: 48000,
    });
    const crash = await renderSongOk(songForInstrument('drums.kit', 49, { durationHintBeats: 4 }), {
      sampleRate: 48000,
    });

    const kickMetrics = measureAudio(kick.audio);
    const snareMetrics = measureAudio(snare.audio);
    const hatMetrics = measureAudio(closedHat.audio);
    expect(kickMetrics.rms).toBeGreaterThan(0.01);
    expect(kickMetrics.zeroCrossingRate).toBeLessThan(0.15);
    expect(snareMetrics.zeroCrossingRate).toBeGreaterThan(0.15);
    expect(hatMetrics.zeroCrossingRate).toBeGreaterThan(kickMetrics.zeroCrossingRate * 5);

    const closedTail = windowRms(closedHat.audio, 48000, 0.2, 0.4);
    const openTail = windowRms(openHat.audio, 48000, 0.2, 0.4);
    const crashTail = windowRms(crash.audio, 48000, 0.5, 1);
    expect(closedTail).toBeLessThan(1e-6);
    expect(openTail).toBeGreaterThan(0.0005);
    expect(crashTail).toBeGreaterThan(0.0005);
  });

  it('plays drums as one-shots beyond the notated note duration', async () => {
    const rendered = await renderSongOk(
      songForInstrument('drums.kit', 36, { durationBeats: 0.05, durationHintBeats: 2 }),
      { sampleRate: 48000 },
    );
    // The notated note is 25 ms long at 120 BPM; the kick still rings at 200 ms.
    expect(windowRms(rendered.audio, 48000, 0.18, 0.3)).toBeGreaterThan(0.0005);
  });
});

describe('bounded polyphony', () => {
  const chord = [60, 62, 64, 65, 67, 69, 71, 72];

  function chordSong(): SongSchemaV1 {
    return baseSong({
      durationHint: 2,
      tracks: [
        clipTrack(
          'chord',
          chord.map((pitch) => clipNote(pitch, 0, 2, 110)),
          { instrument: { type: 'builtin', id: 'keys.soft' } },
        ),
      ],
    });
  }

  it('drops the newest starts at the per-track cap and reports stats and a warning', async () => {
    const capped = await renderSongOk(chordSong(), { sampleRate: 48000, maxVoicesPerTrack: 3 });
    const uncapped = await renderSongOk(chordSong(), { sampleRate: 48000 });
    assertFinite(capped.audio);

    expect(capped.stats.maxVoicesPerTrack).toBe(3);
    expect(capped.stats.voiceCapPolicy).toBe('drop-newest');
    expect(capped.stats.tracks[0]).toMatchObject({
      startedVoices: 3,
      droppedVoices: 5,
      stolenVoices: 0,
      peakActiveVoices: 3,
      maxVoices: 3,
    });
    expect(capped.stats.droppedVoices).toBe(5);
    const warning = capped.warnings.find((issue) => issue.code === 'audio.voice.dropped');
    expect(warning).toBeDefined();
    expect(warning?.path).toBe('/tracks/0');
    expect(warning?.params).toMatchObject({ droppedVoices: 5, maxVoices: 3 });
    expect(measureAudio(capped.audio).rms).toBeGreaterThan(0.001);

    expect(uncapped.stats.tracks[0]).toMatchObject({
      startedVoices: 8,
      droppedVoices: 0,
      peakActiveVoices: 8,
    });
    expect(uncapped.warnings).toEqual([]);

    const repeated = await renderSongOk(chordSong(), { sampleRate: 48000, maxVoicesPerTrack: 3 });
    expect(sameFloat32(capped.audio.left, repeated.audio.left)).toBe(true);
    expect(sameFloat32(capped.audio.right, repeated.audio.right)).toBe(true);
  });
});
