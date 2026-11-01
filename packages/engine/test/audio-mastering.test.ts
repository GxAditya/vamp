import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { renderSongArtifacts, type AudioBackend } from '../src/index.js';
import { baseSong, clipNote, clipTrack } from './helpers.js';
import { parseWav } from './audio-helpers.js';

const temporaryDirectories: string[] = [];

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'vamp-mastering-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterAll(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const song = baseSong({
  durationHint: 4,
  tracks: [
    clipTrack('keys', [clipNote(60, 0, 4, 100), clipNote(64, 0, 4, 90), clipNote(67, 0, 4, 80)]),
    clipTrack('bass', [clipNote(36, 0, 4, 96)], {
      id: 'bass',
      name: 'bass',
      channel: 1,
      instrument: { type: 'builtin', id: 'bass.sub' },
    }),
  ],
});

describe('deterministic mastering', () => {
  it('normalizes master and stems to the peak target with one shared gain', async () => {
    const normalizedDir = tempDirectory();
    const rawDir = tempDirectory();
    const normalized = await renderSongArtifacts(song, {
      outputDir: normalizedDir,
      sampleRate: 48_000,
      mastering: { normalize: true, maxBoostDb: 18 },
      overwrite: true,
    });
    const raw = await renderSongArtifacts(song, {
      outputDir: rawDir,
      sampleRate: 48_000,
      mastering: { normalize: false },
      overwrite: true,
    });
    expect(normalized.ok).toBe(true);
    expect(raw.ok).toBe(true);
    if (!normalized.ok || !raw.ok) {
      return;
    }

    expect(normalized.report.audio.mastering.applied).toBe(true);
    expect(normalized.report.audio.mastering.limited).toBe(false);
    expect(normalized.report.audio.mastering.targetDbfs).toBe(-1);
    expect(normalized.report.audio.peakDbfs).toBeCloseTo(-1, 1);
    expect(normalized.report.audio.clipping.clipped).toBe(false);
    expect(normalized.report.audio.loudness.integratedLufs).not.toBeNull();
    expect(normalized.report.audio.mastering.gainDb).toBeGreaterThan(0);

    expect(raw.report.audio.mastering.applied).toBe(false);
    expect(raw.report.audio.mastering.targetDbfs).toBeNull();
    expect(raw.report.audio.peakDbfs).not.toBeNull();
    expect(raw.report.audio.peakDbfs!).toBeLessThan(-1);

    const master = parseWav(readFileSync(join(normalizedDir, 'master.wav')));
    expect(master.frameCount).toBeGreaterThan(0);
    expect(normalized.report.audio.clipping.clipped).toBe(false);
    const gain = 10 ** (normalized.report.audio.mastering.gainDb / 20);
    for (const stem of normalized.report.stems) {
      const rawStem = raw.report.stems.find((candidate) => candidate.trackId === stem.trackId);
      expect(rawStem).toBeDefined();
      if (rawStem === undefined || stem.audio.wav === null || rawStem.audio.wav === null) {
        continue;
      }
      const ratio = stem.audio.wav.peak / rawStem.audio.wav.peak;
      expect(ratio).toBeCloseTo(gain, 1);
    }
  });

  it('attenuates an over-target peak instead of clipping', async () => {
    const directory = tempDirectory();
    const hot: AudioBackend = {
      id: 'test-hot-v1',
      name: 'Hot test backend',
      description: 'Constant over-target signal for mastering tests.',
      capabilities: {
        instrumentTypes: ['builtin'],
        builtinIds: ['keys.soft'],
        voicePolicy: 'drop-newest',
      },
      async renderTrack(request) {
        return {
          ok: true,
          samples: new Float32Array(request.frameCount).fill(1.5),
          stats: {
            startedVoices: 1,
            droppedVoices: 0,
            stolenVoices: 0,
            peakActiveVoices: 1,
          },
          warnings: [],
        };
      },
    };
    const loud = baseSong({
      durationHint: 4,
      tracks: [clipTrack('keys', [clipNote(60, 0, 4, 127)])],
    });
    const result = await renderSongArtifacts(loud, {
      outputDir: directory,
      sampleRate: 48_000,
      backend: hot,
      mastering: { normalize: true },
      overwrite: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.report.audio.mastering.limited).toBe(true);
    expect(result.report.audio.mastering.gainDb).toBeLessThan(0);
    expect(result.report.audio.peakDbfs).toBeCloseTo(-1, 1);
    expect(result.report.audio.clipping.clipped).toBe(false);
  });

  it('rejects out-of-range mastering targets with a structured option issue', async () => {
    const result = await renderSongArtifacts(song, {
      outputDir: tempDirectory(),
      sampleRate: 48_000,
      mastering: { normalize: true, targetDbfs: 6 },
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors[0]).toMatchObject({
      code: 'audio.options.invalid',
      path: '/mastering/targetDbfs',
    });
  });
});
