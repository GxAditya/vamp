import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseMidi } from 'midi-file';
import { afterEach, describe, expect, it } from 'vitest';

import type { Note, SongSchemaV1, Track } from '@gxaditya/vamp-schema';

import {
  MASTER_AUDIO_FILENAME,
  MAX_ARTIFACT_COUNT,
  MAX_STEM_COUNT,
  MIDI_ARTIFACT_FILENAME,
  RENDER_REPORT_FORMAT,
  REPORT_ARTIFACT_FILENAME,
  isSafeArtifactFileName,
  renderSongArtifacts,
  renderSongAudio,
  sanitizeTrackSlug,
  stemFileName,
  stemReconstructionToleranceLsb,
  type AudioBackend,
  type RenderReport,
  type RenderSongArtifactsSuccess,
  type TrackAudioCapture,
} from '../src/index.js';
import {
  constantSignal,
  createSignalBackend,
  parseWav,
  readPcm16,
  sameBytes,
} from './audio-helpers.js';
import { baseSong, clipNote, clipTrack } from './helpers.js';

const temporaryRoots: string[] = [];

function tempRoot(prefix = 'vamp-artifacts-'): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop();
    if (root !== undefined) {
      chmodSync(root, 0o700);
      rmSync(root, { recursive: true, force: true });
    }
  }
});

function track(id: string, name: string, notes: Note[], extra: Partial<Track> = {}): Track {
  return clipTrack(id, notes, {
    name,
    instrument: { type: 'builtin', id: 'keys.soft' },
    ...extra,
  });
}

function multiTrackSong(): SongSchemaV1 {
  return baseSong({
    bpm: 120,
    durationHint: 1.5,
    tracks: [
      track('keys', 'Soft Keys', [clipNote(60, 0, 1, 100)], {
        channel: 0,
        instrument: { type: 'builtin', id: 'keys.soft' },
      }),
      track('pad', 'Warm Pad', [clipNote(67, 0, 1, 80)], {
        channel: 1,
        instrument: { type: 'builtin', id: 'pad.warm' },
        pan: 0.3,
        effects: [
          { type: 'delay', timeMs: 100, feedback: 0.2, mix: 0.2 },
          { type: 'reverb', mix: 0.2, decaySeconds: 0.4 },
        ],
      }),
      track('bass', 'Sub Bass', [clipNote(36, 0, 0.8, 110)], {
        channel: 2,
        instrument: { type: 'builtin', id: 'bass.sub' },
        pan: -0.4,
      }),
    ],
  });
}

function renderOk(
  song: unknown,
  options: Parameters<typeof renderSongArtifacts>[1],
): Promise<RenderSongArtifactsSuccess> {
  return renderSongArtifacts(song, options).then((result) => {
    if (!result.ok) {
      throw new Error(`Expected artifact success: ${JSON.stringify(result)}`);
    }
    return result;
  });
}

/** Sixteen audible tracks: one drums track plus fifteen melodic channels. */
function manyTracks(count: number): Track[] {
  const tracks: Track[] = [
    clipTrack('kit', [clipNote(36, 0, 0.05)], {
      name: 'Kit',
      kind: 'drums',
      channel: 9,
      instrument: { type: 'builtin', id: 'drums.kit' },
    }),
  ];
  for (let index = 1; index < count; index += 1) {
    const melodicIndex = index - 1;
    tracks.push(
      track(`part-${index}`, `Part ${index}`, [clipNote(48 + index, 0, 0.05)], {
        channel: melodicIndex < 9 ? melodicIndex : melodicIndex + 1,
      }),
    );
  }
  return tracks;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function readWav(path: string): {
  readonly bytes: Uint8Array;
  readonly parsed: ReturnType<typeof parseWav>;
} {
  const bytes = new Uint8Array(readFileSync(path));
  return { bytes, parsed: parseWav(bytes) };
}

function pcmSamples(path: string): { readonly frames: number; readonly values: Int16Array } {
  const { bytes, parsed } = readWav(path);
  const values = new Int16Array(parsed.frameCount * 2);
  for (let index = 0; index < values.length; index += 1) {
    values[index] = readPcm16(bytes, parsed, Math.floor(index / 2), (index % 2) as 0 | 1);
  }
  return { frames: parsed.frameCount, values };
}

function stripRun(report: RenderReport): unknown {
  const deterministic: Record<string, unknown> = { ...report };
  delete deterministic.run;
  return deterministic;
}

describe('complete artifact render', () => {
  it('writes aligned master, stems, MIDI, and a parseable report', async () => {
    const root = tempRoot();
    const outputDir = join(root, 'out');
    const result = await renderOk(multiTrackSong(), { outputDir, sampleRate: 48000 });
    const files = readdirSync(outputDir).sort();

    expect(result.outputDir).toBe(outputDir);
    expect(files).toEqual([
      MASTER_AUDIO_FILENAME,
      REPORT_ARTIFACT_FILENAME,
      MIDI_ARTIFACT_FILENAME,
      'stem-01-soft-keys.wav',
      'stem-02-warm-pad.wav',
      'stem-03-sub-bass.wav',
    ]);
    expect(result.artifacts.map((artifact) => artifact.path)).toEqual([
      MASTER_AUDIO_FILENAME,
      'stem-01-soft-keys.wav',
      'stem-02-warm-pad.wav',
      'stem-03-sub-bass.wav',
      MIDI_ARTIFACT_FILENAME,
    ]);

    const master = readWav(join(outputDir, MASTER_AUDIO_FILENAME));
    const stemFiles = files.filter((file) => file.startsWith('stem-'));
    expect(stemFiles).toHaveLength(3);
    for (const file of stemFiles) {
      const stem = readWav(join(outputDir, file));
      expect(stem.parsed.riff).toBe('RIFF');
      expect(stem.parsed.wave).toBe('WAVE');
      expect(stem.parsed.audioFormat).toBe(1);
      expect(stem.parsed.channels).toBe(2);
      expect(stem.parsed.bitDepth).toBe(16);
      expect(stem.parsed.sampleRate).toBe(master.parsed.sampleRate);
      expect(stem.parsed.frameCount).toBe(master.parsed.frameCount);
      expect(stem.parsed.dataSize).toBe(master.parsed.dataSize);
    }

    const midi = parseMidi(new Uint8Array(readFileSync(join(outputDir, MIDI_ARTIFACT_FILENAME))));
    expect(midi.header.format).toBe(1);
    expect(midi.header.numTracks).toBeGreaterThan(1);

    const report = JSON.parse(
      readFileSync(join(outputDir, REPORT_ARTIFACT_FILENAME), 'utf8'),
    ) as RenderReport;
    expect(report.format).toBe(RENDER_REPORT_FORMAT);
    expect(report.schemaVersion).toBe('1.0.0');
    expect(report.seed).toBe(123);
    expect(report.duration.requestedSeconds).toBe(0.75);
    // The delay and reverb tails extend the render beyond the authored hint.
    expect(report.duration.actualSeconds).toBeCloseTo(1.4, 6);
    expect(report.duration.deltaSeconds).toBeCloseTo(0.65, 6);
    expect(report.duration.actualFrames).toBe(67_200);
    expect(report.duration.sampleRate).toBe(48_000);
    expect(report.duration.channels).toBe(2);
    expect(report.audio.peak).toBeGreaterThan(0);
    expect(Number.isFinite(report.audio.peak)).toBe(true);
    expect(report.audio.peakDbfs).toBeLessThan(0);
    expect(report.audio.clipping.clipped).toBe(false);
    expect(report.audio.loudness.integratedLufs).toBeTypeOf('number');
    expect(Number.isFinite(report.audio.loudness.integratedLufs)).toBe(true);
    expect(report.audio.loudness.method).toBe('vamp-kweighted-gated-v1');
    expect(report.audio.loudness.limitations.length).toBeGreaterThan(0);
    expect(report.backend.id).toBe('builtin-synth-v1');
    expect(report.backend.voicePolicy).toBe('drop-newest');
    expect(report.assets.registryVersion).toBe(1);
    expect(report.assets.registry.some((asset) => asset.fileName === 'FluidR3_GM.sf2')).toBe(true);
    expect(report.midi?.report.ppq).toBe(960);
    expect(report.midi?.report.limitations.length).toBeGreaterThan(0);
    expect(report.stems).toHaveLength(3);
    expect(report.outputs.master).toBe(MASTER_AUDIO_FILENAME);
    expect(report.outputs.midi).toBe(MIDI_ARTIFACT_FILENAME);
    expect(report.outputs.report).toBe(REPORT_ARTIFACT_FILENAME);
    expect(report.run.outputDir).toBe(outputDir);
    expect(Number.isFinite(report.run.elapsedMs)).toBe(true);
    expect(report.run.elapsedMs).toBeGreaterThanOrEqual(0);

    for (const artifact of result.artifacts) {
      const bytes = new Uint8Array(readFileSync(join(outputDir, artifact.path)));
      expect(artifact.bytes).toBe(bytes.length);
      expect(artifact.sha256).toBe(sha256(bytes));
    }
    expect(JSON.stringify(report)).not.toContain('NaN');
    expect(JSON.stringify(report)).not.toContain('Infinity');
  }, 20_000);

  it('reconstructs the master from encoded stems within the documented tolerance', async () => {
    const root = tempRoot();
    const outputDir = join(root, 'out');
    const result = await renderOk(multiTrackSong(), { outputDir, sampleRate: 44100 });
    const master = pcmSamples(join(outputDir, MASTER_AUDIO_FILENAME));
    const stems = readdirSync(outputDir)
      .filter((file) => file.startsWith('stem-'))
      .sort()
      .map((file) => pcmSamples(join(outputDir, file)));

    const tolerance = result.report.stemInvariant.pcm16ToleranceLsb;
    expect(tolerance).toBe(stemReconstructionToleranceLsb(stems.length));
    expect(tolerance).toBeGreaterThanOrEqual(1);
    for (const stem of stems) {
      expect(stem.frames).toBe(master.frames);
    }

    let maximumDifference = 0;
    for (let frame = 0; frame < master.frames; frame += 1) {
      for (let channel = 0; channel < 2; channel += 1) {
        const index = frame * 2 + channel;
        let sum = 0;
        for (const stem of stems) {
          sum += stem.values[index] ?? 0;
        }
        maximumDifference = Math.max(
          maximumDifference,
          Math.abs(sum - (master.values[index] ?? 0)),
        );
      }
    }
    expect(maximumDifference).toBeLessThanOrEqual(tolerance);
    expect(maximumDifference).toBeLessThanOrEqual(4);
  }, 20_000);

  it('reconstructs the master from the captured float stems by construction', async () => {
    const captures: TrackAudioCapture[] = [];
    const song = baseSong({
      durationHint: 0.5,
      tracks: [
        track('keys', 'Soft Keys', [clipNote(60, 0, 0.3, 100)], { channel: 0 }),
        track('pad', 'Warm Pad', [clipNote(67, 0, 0.3, 80)], {
          channel: 1,
          effects: [{ type: 'delay', timeMs: 80, feedback: 0.2, mix: 0.25 }],
        }),
        track('muted', 'Muted', [clipNote(48, 0, 0.3)], { channel: 2, mute: true }),
      ],
    });
    const rendered = await renderSongAudio(song, {
      sampleRate: 48000,
      onTrackAudio: (capture) => {
        captures.push({
          ...capture,
          left: capture.left.slice(),
          right: capture.right.slice(),
        });
      },
    });
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) {
      return;
    }
    expect(captures).toHaveLength(2);
    expect(captures.map((capture) => capture.trackId)).toEqual(['keys', 'pad']);

    const reconstructedLeft = new Float32Array(rendered.audio.frameCount);
    const reconstructedRight = new Float32Array(rendered.audio.frameCount);
    for (const capture of captures) {
      for (let frame = 0; frame < reconstructedLeft.length; frame += 1) {
        reconstructedLeft[frame] = (reconstructedLeft[frame] ?? 0) + (capture.left[frame] ?? 0);
        reconstructedRight[frame] = (reconstructedRight[frame] ?? 0) + (capture.right[frame] ?? 0);
      }
    }
    for (let frame = 0; frame < reconstructedLeft.length; frame += 1) {
      expect(reconstructedLeft[frame]).toBe(rendered.audio.left[frame]);
      expect(reconstructedRight[frame]).toBe(rendered.audio.right[frame]);
    }
  });

  it('permits explicit artifact opt-outs', async () => {
    const root = tempRoot();
    const outputDir = join(root, 'master-only');
    const result = await renderOk(multiTrackSong(), {
      outputDir,
      sampleRate: 48000,
      stems: false,
      midi: false,
      report: false,
    });
    expect(readdirSync(outputDir)).toEqual([MASTER_AUDIO_FILENAME]);
    expect(result.report.stems).toEqual([]);
    expect(result.report.midi).toBeNull();
    expect(result.report.outputs.stems).toEqual([]);
    expect(result.report.outputs.midi).toBeNull();
    expect(result.report.outputs.report).toBeNull();
  });
});

describe('silent, short, and clipping inputs', () => {
  it('reports silence without NaN or Infinity', async () => {
    const root = tempRoot();
    const outputDir = join(root, 'silent');
    const song = baseSong({
      durationHint: 0.5,
      tracks: [track('muted', 'Muted', [clipNote(60, 0, 1)], { mute: true })],
    });
    const result = await renderOk(song, { outputDir, sampleRate: 48000 });
    const report = JSON.parse(
      readFileSync(join(outputDir, REPORT_ARTIFACT_FILENAME), 'utf8'),
    ) as RenderReport;

    expect(readdirSync(outputDir).filter((file) => file.startsWith('stem-'))).toEqual([]);
    expect(result.report.stems).toEqual([]);
    expect(report.audio.peak).toBe(0);
    expect(report.audio.peakDbfs).toBeNull();
    expect(report.audio.loudness.integratedLufs).toBeNull();
    expect(report.audio.loudness.silence).toBe(true);
    expect(report.audio.clipping.clipped).toBe(false);
    expect(JSON.stringify(report)).not.toContain('NaN');
    expect(JSON.stringify(report)).not.toContain('Infinity');

    const master = pcmSamples(join(outputDir, MASTER_AUDIO_FILENAME));
    expect(master.frames).toBe(12_000);
    expect(master.values.every((sample) => sample === 0)).toBe(true);
  });

  it('reports an audible but zero-gain silent stem with null loudness', async () => {
    const root = tempRoot();
    const outputDir = join(root, 'zero-gain');
    const song = baseSong({
      durationHint: 0.25,
      tracks: [track('quiet', 'Quiet', [clipNote(60, 0, 1)], { volume: 0 })],
    });
    const result = await renderOk(song, { outputDir, sampleRate: 48000 });
    expect(result.report.stems).toHaveLength(1);
    expect(result.report.audio.peak).toBe(0);
    expect(result.report.audio.peakDbfs).toBeNull();
    expect(result.report.audio.loudness.integratedLufs).toBeNull();
    expect(result.report.audio.loudness.silence).toBe(true);
  });

  it('renders a short clip with a finite partial-block loudness result', async () => {
    const root = tempRoot();
    const outputDir = join(root, 'short');
    const song = baseSong({
      durationHint: 0.05,
      tracks: [track('short', 'Short', [clipNote(72, 0, 0.02, 120)])],
    });
    const result = await renderOk(song, { outputDir, sampleRate: 48000 });
    expect(result.report.duration.actualFrames).toBe(1200);
    expect(result.report.audio.loudness.shortSignal).toBe(true);
    expect(Number.isFinite(result.report.audio.loudness.integratedLufs)).toBe(true);
    expect(JSON.stringify(result.report)).not.toContain('NaN');
  });

  it('counts clipping and reports it as a warning', async () => {
    const root = tempRoot();
    const outputDir = join(root, 'clip');
    const backend = createSignalBackend(constantSignal(0.8));
    const song = baseSong({
      durationHint: 0.5,
      tracks: [
        track('one', 'One', [clipNote(60, 0, 0.4)], { channel: 0 }),
        track('two', 'Two', [clipNote(64, 0, 0.4)], { channel: 1 }),
        track('three', 'Three', [clipNote(67, 0, 0.4)], { channel: 2 }),
      ],
    });
    const result = await renderOk(song, { outputDir, sampleRate: 48000, backend });
    expect(result.report.audio.peak).toBeGreaterThan(1);
    expect(result.report.audio.clipping.clipped).toBe(true);
    expect(result.report.audio.clipping.clippedSampleCount).toBeGreaterThan(0);
    expect(
      result.report.warnings.audio.some((warning) => warning.code === 'audio.pcm.clipped'),
    ).toBe(true);
    expect(result.report.backend.id).toBe('test-signal-v1');
  });
});

describe('artifact naming and output policy', () => {
  it('sanitizes unsafe track names without path escape or collisions', async () => {
    expect(sanitizeTrackSlug('../../Loud PAD: mix?')).toBe('loud-pad-mix');
    expect(sanitizeTrackSlug('Café Keys')).toBe('cafe-keys');
    expect(sanitizeTrackSlug('日本語')).toBe('track');
    expect(stemFileName(0, 'Keys')).toBe('stem-01-keys.wav');
    expect(stemFileName(1, 'keys!')).toBe('stem-02-keys.wav');
    expect(isSafeArtifactFileName('stem-01-keys.wav')).toBe(true);
    expect(isSafeArtifactFileName('../escape.wav')).toBe(false);
    expect(isSafeArtifactFileName('a/b.wav')).toBe(false);
    expect(isSafeArtifactFileName('con.wav')).toBe(false);

    const root = tempRoot();
    const outputDir = join(root, 'names');
    const song = baseSong({
      durationHint: 0.1,
      tracks: [
        track('one', '../../Loud PAD: mix?', [clipNote(60, 0, 0.05)], { channel: 0 }),
        track('two', 'keys!', [clipNote(64, 0, 0.05)], { channel: 1 }),
        track('three', 'Keys', [clipNote(67, 0, 0.05)], { channel: 2 }),
      ],
    });
    const result = await renderOk(song, { outputDir, sampleRate: 48000, midi: false });
    const stems = readdirSync(outputDir)
      .filter((file) => file.startsWith('stem-'))
      .sort();
    expect(stems).toEqual(['stem-01-loud-pad-mix.wav', 'stem-02-keys.wav', 'stem-03-keys.wav']);
    expect(readdirSync(outputDir).some((file) => file.includes('..'))).toBe(false);
    expect(result.report.outputs.stems).toEqual(stems);
  });

  it('handles the maximum audible track and artifact count', async () => {
    const root = tempRoot();
    const outputDir = join(root, 'many');
    const tracks = manyTracks(MAX_STEM_COUNT);
    const result = await renderOk(baseSong({ durationHint: 0.2, tracks }), {
      outputDir,
      sampleRate: 44100,
    });
    expect(result.report.stems).toHaveLength(MAX_STEM_COUNT);
    expect(result.artifacts).toHaveLength(MAX_ARTIFACT_COUNT - 1); // report is not listed
    expect(new Set(result.report.outputs.stems).size).toBe(MAX_STEM_COUNT);
    expect(readdirSync(outputDir)).toHaveLength(MAX_ARTIFACT_COUNT);
  });

  it('refuses existing artifacts unless overwrite is explicit', async () => {
    const root = tempRoot();
    const outputDir = join(root, 'collision');
    const result = await renderOk(multiTrackSong(), {
      outputDir,
      sampleRate: 48000,
      midi: false,
      stems: false,
      report: false,
    });
    expect(result.ok).toBe(true);
    const before = readFileSync(join(outputDir, MASTER_AUDIO_FILENAME));

    const refused = await renderSongArtifacts(multiTrackSong(), {
      outputDir,
      sampleRate: 44100,
      midi: false,
      stems: false,
      report: false,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.stage).toBe('artifacts');
      expect(refused.errors[0]?.code).toBe('audio.artifacts.exists');
    }
    expect(
      sameBytes(new Uint8Array(readFileSync(join(outputDir, MASTER_AUDIO_FILENAME))), before),
    ).toBe(true);

    const replaced = await renderOk(multiTrackSong(), {
      outputDir,
      sampleRate: 44100,
      midi: false,
      stems: false,
      report: false,
      overwrite: true,
    });
    expect(replaced.report.duration.sampleRate).toBe(44100);
    expect(
      sameBytes(new Uint8Array(readFileSync(join(outputDir, MASTER_AUDIO_FILENAME))), before),
    ).toBe(false);
  });

  it('creates artifacts inside an existing directory without deleting unrelated files', async () => {
    const root = tempRoot();
    const outputDir = join(root, 'existing');
    mkdirSync(outputDir);
    writeFileSync(join(outputDir, 'notes.txt'), 'keep me');

    await renderOk(multiTrackSong(), {
      outputDir,
      sampleRate: 48000,
      midi: false,
      stems: false,
      report: false,
    });
    expect(readFileSync(join(outputDir, 'notes.txt'), 'utf8')).toBe('keep me');
    expect(readdirSync(outputDir).sort()).toEqual([MASTER_AUDIO_FILENAME, 'notes.txt']);
  });

  it('restores replaced artifacts when an overwrite publish fails', async () => {
    const root = tempRoot();
    const outputDir = join(root, 'overwrite-rollback');
    mkdirSync(outputDir);
    const originalMaster = Buffer.from('previous master render');
    writeFileSync(join(outputDir, MASTER_AUDIO_FILENAME), originalMaster);
    writeFileSync(join(outputDir, 'notes.txt'), 'keep me');

    const base = createSignalBackend(constantSignal(0.1));
    let blocked = false;
    const backend: AudioBackend = {
      ...base,
      async renderTrack(request) {
        if (!blocked) {
          blocked = true;
          mkdirSync(join(outputDir, MIDI_ARTIFACT_FILENAME), { recursive: true });
        }
        return base.renderTrack(request);
      },
    };
    const result = await renderSongArtifacts(multiTrackSong(), {
      outputDir,
      sampleRate: 48000,
      backend,
      overwrite: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe('artifacts');
      expect(result.errors[0]?.code).toBe('audio.artifacts.output_invalid');
    }
    expect(readFileSync(join(outputDir, MASTER_AUDIO_FILENAME))).toEqual(originalMaster);
    expect(readFileSync(join(outputDir, 'notes.txt'), 'utf8')).toBe('keep me');
    expect(statSync(join(outputDir, MIDI_ARTIFACT_FILENAME)).isDirectory()).toBe(true);
    expect(readdirSync(outputDir).filter((name) => name.startsWith('stem-'))).toEqual([]);
    expect(readdirSync(outputDir).some((name) => name.startsWith('.vamp-render-'))).toBe(false);
  });
});

describe('unwritable paths and cancellation', () => {
  it('returns structured failures for invalid output paths', async () => {
    const root = tempRoot();
    const blocker = join(root, 'blocker');
    writeFileSync(blocker, 'not a directory');

    const underFile = await renderSongArtifacts(multiTrackSong(), {
      outputDir: join(blocker, 'out'),
      sampleRate: 48000,
    });
    expect(underFile.ok).toBe(false);
    if (!underFile.ok) {
      expect(underFile.stage).toBe('artifacts');
      // POSIX reports ENOTDIR for a path beneath a file (unwritable); Windows
      // reports ENOENT instead, so the parent-directory check classifies it as
      // an invalid output there.
      expect(underFile.errors[0]?.code).toBe(
        process.platform === 'win32'
          ? 'audio.artifacts.output_invalid'
          : 'audio.artifacts.unwritable',
      );
    }

    const asFile = await renderSongArtifacts(multiTrackSong(), {
      outputDir: blocker,
      sampleRate: 48000,
    });
    expect(asFile.ok).toBe(false);
    if (!asFile.ok) {
      expect(asFile.errors[0]?.code).toBe('audio.artifacts.output_invalid');
    }
    expect(readFileSync(blocker, 'utf8')).toBe('not a directory');
  });

  it('cleans the job directory when cancelled before rendering', async () => {
    const root = tempRoot();
    const outputDir = join(root, 'cancelled');
    const controller = new AbortController();
    controller.abort();
    const result = await renderSongArtifacts(multiTrackSong(), {
      outputDir,
      sampleRate: 48000,
      signal: controller.signal,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe('cancelled');
      expect(result.errors[0]?.code).toBe('audio.cancelled');
    }
    expect(readdirSync(root)).toEqual([]);
  });

  it('cleans stem files when cancelled between tracks', async () => {
    const root = tempRoot();
    const outputDir = join(root, 'cancelled-mid');
    const controller = new AbortController();
    const base = createSignalBackend(constantSignal(0.1));
    let calls = 0;
    const backend: AudioBackend = {
      ...base,
      async renderTrack(request) {
        calls += 1;
        const result = await base.renderTrack(request);
        if (calls === 1) {
          controller.abort();
        }
        return result;
      },
    };
    const result = await renderSongArtifacts(multiTrackSong(), {
      outputDir,
      sampleRate: 48000,
      backend,
      signal: controller.signal,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe('cancelled');
    }
    expect(readdirSync(root)).toEqual([]);
  });

  it('returns structured option failures instead of throwing', async () => {
    const root = tempRoot();
    const invalid = await renderSongArtifacts(multiTrackSong(), {
      outputDir: join(root, 'out'),
      sampleRate: 8000 as 44100,
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.stage).toBe('options');
      expect(invalid.errors[0]?.code).toBe('audio.options.invalid');
    }

    const unknown = await renderSongArtifacts(multiTrackSong(), {
      outputDir: join(root, 'out'),
      sampleRate: 48000,
      unexpected: true,
    } as never);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.stage).toBe('options');
    }

    const invalidBackend = await renderSongArtifacts(multiTrackSong(), {
      outputDir: join(root, 'out'),
      sampleRate: 48000,
      backend: null,
    } as never);
    expect(invalidBackend.ok).toBe(false);
    if (!invalidBackend.ok) {
      expect(invalidBackend.stage).toBe('audio');
      expect(invalidBackend.errors[0]?.code).toBe('audio.options.invalid');
    }
    expect(readdirSync(root)).toEqual([]);
  });
});

describe('determinism and bounded work', () => {
  it('produces identical audio and MIDI bytes on repeated renders', async () => {
    const root = tempRoot();
    const firstDir = join(root, 'first');
    const secondDir = join(root, 'second');
    const first = await renderOk(multiTrackSong(), { outputDir: firstDir, sampleRate: 48000 });
    const second = await renderOk(multiTrackSong(), { outputDir: secondDir, sampleRate: 48000 });

    const files = [MASTER_AUDIO_FILENAME, MIDI_ARTIFACT_FILENAME, ...first.report.outputs.stems];
    for (const file of files) {
      expect(
        sameBytes(
          new Uint8Array(readFileSync(join(firstDir, file))),
          new Uint8Array(readFileSync(join(secondDir, file))),
        ),
      ).toBe(true);
    }
    expect(stripRun(first.report)).toEqual(stripRun(second.report));
    expect(first.report.run.outputDir).toBe(firstDir);
    expect(second.report.run.outputDir).toBe(secondDir);
  }, 20_000);

  it('keeps the per-artifact size bound at the schema limit', () => {
    expect(stemReconstructionToleranceLsb(0)).toBe(0);
    expect(stemReconstructionToleranceLsb(1)).toBe(1);
    expect(stemReconstructionToleranceLsb(2)).toBe(2);
    expect(stemReconstructionToleranceLsb(16)).toBe(9);
  });

  it('renders the 600 second schema limit with bounded memory and output', async () => {
    const root = tempRoot();
    const outputDir = join(root, 'limit');
    const song = baseSong({
      bpm: 120,
      durationHint: 1200,
      tracks: [track('muted', 'Muted', [clipNote(60, 0, 1)], { mute: true })],
    });
    const result = await renderOk(song, {
      outputDir,
      sampleRate: 48000,
      stems: false,
      midi: false,
    });
    expect(result.report.duration.actualSeconds).toBe(600);
    expect(result.report.duration.actualFrames).toBe(28_800_000);
    expect(result.report.audio.peak).toBe(0);
    expect(result.report.audio.loudness.integratedLufs).toBeNull();
    expect(statSync(join(outputDir, MASTER_AUDIO_FILENAME)).size).toBe(115_200_044);
    expect(readdirSync(outputDir).sort()).toEqual([
      MASTER_AUDIO_FILENAME,
      REPORT_ARTIFACT_FILENAME,
    ]);
  }, 60_000);

  it('writes a bounded number of files for many short tracks', async () => {
    const root = tempRoot();
    const outputDir = join(root, 'bounded');
    const result = await renderOk(
      baseSong({ durationHint: 0.1, tracks: manyTracks(MAX_STEM_COUNT) }),
      { outputDir, sampleRate: 48000, midi: false },
    );
    expect(statSync(outputDir).isDirectory()).toBe(true);
    expect(result.report.stems.length).toBeLessThanOrEqual(MAX_STEM_COUNT);
    expect(readdirSync(outputDir).length).toBeLessThanOrEqual(MAX_ARTIFACT_COUNT);
  });
});
