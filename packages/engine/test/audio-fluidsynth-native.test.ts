import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import type { Note, SongSchemaV1 } from '@gxaditya/vamp-schema';

import {
  createFluidSynthBackend,
  isFluidSynthBinaryAvailable,
  probeFluidSynthVersion,
  renderSongArtifacts,
  renderSongAudio,
  renderTimelineAudio,
  type AudioBackendTrackStats,
  type FluidSynthBackendConfig,
  type SampleRate,
} from '../src/index.js';
import { baseSong, clipNote, clipTrack, compileOk } from './helpers.js';

// Native renders can take several seconds under parallel test load.
vi.setConfig({ testTimeout: 20_000 });

const FLUID_BINARY = process.env.VAMP_FLUIDSYNTH_PATH ?? '/usr/bin/fluidsynth';
const FLUID_SOUNDFONT = process.env.VAMP_SOUNDFONT_PATH ?? '/usr/share/sounds/sf2/FluidR3_GM.sf2';
const NATIVE_AVAILABLE = existsSync(FLUID_BINARY) && existsSync(FLUID_SOUNDFONT);

const temporaryRoots: string[] = [];

function tempRoot(prefix = 'vamp-native-'): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temporaryRoots.push(root);
  return root;
}

afterAll(() => {
  for (const root of temporaryRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeFakeSoundFont(path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  const buffer = Buffer.alloc(24);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(16, 4);
  buffer.write('sfbk', 8, 'ascii');
  buffer.write('LIST', 12, 'ascii');
  writeFileSync(path, buffer);
  return path;
}

function writeScript(path: string, body: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function oneTrackSong(
  notes: readonly Note[],
  instrument: SongSchemaV1['tracks'][number]['instrument'],
  options: { bpm?: number; durationHint?: number; drums?: boolean } = {},
): SongSchemaV1 {
  const drums = options.drums === true;
  return baseSong({
    bpm: options.bpm ?? 120,
    durationHint: options.durationHint ?? 1,
    tracks: [
      clipTrack('track', notes, {
        kind: drums ? 'drums' : 'midi',
        channel: drums ? 9 : 0,
        instrument,
      }),
    ],
  });
}

function requestFor(song: SongSchemaV1, sampleRate: SampleRate, maxVoices = 32) {
  const timeline = compileOk(song, { sampleRate }).timeline;
  const track = timeline.tracks[0];
  if (track === undefined) {
    throw new Error('expected one track');
  }
  return {
    timeline,
    request: {
      track,
      events: timeline.events.filter((event) => event.trackIndex === 0),
      sampleRate: timeline.sampleRate,
      frameCount: timeline.renderedSamples,
      seed: timeline.meta.seed,
      maxVoices,
      bpm: timeline.meta.bpm,
    },
  };
}

function peakOf(samples: Float32Array): number {
  let peak = 0;
  for (const value of samples) {
    expect(Number.isFinite(value)).toBe(true);
    peak = Math.max(peak, Math.abs(value));
  }
  return peak;
}

function sameSamples(left: Float32Array, right: Float32Array): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

describe('FluidSynth process safety', () => {
  it('returns a structured missing-dependency issue for a missing executable', async () => {
    const root = tempRoot();
    const font = writeFakeSoundFont(join(root, 'font.sf2'));
    const backend = createFluidSynthBackend({
      binaryPath: join(root, 'no-such-fluidsynth'),
      gmSoundFont: font,
    });
    const { request } = requestFor(
      oneTrackSong([clipNote(60, 0, 0.5, 100)], { type: 'gm', program: 0, bank: 0 }),
      48000,
    );
    const result = await backend.renderTrack(request);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toMatchObject({
        code: 'audio.backend.missing_dependency',
        path: '/tracks/0',
      });
      expect(result.errors[0]?.hint).toContain('Install FluidSynth');
    }
  });

  it.skipIf(process.platform === 'win32')(
    'returns stderr and the exit code for a nonzero process exit',
    async () => {
      const root = tempRoot();
      const font = writeFakeSoundFont(join(root, 'font.sf2'));
      const fake = writeScript(
        join(root, 'bin', 'fake fluidsynth'),
        'echo "simulated FluidSynth failure" >&2\nexit 7',
      );
      const backend = createFluidSynthBackend({ binaryPath: fake, gmSoundFont: font });
      const { request } = requestFor(
        oneTrackSong([clipNote(60, 0, 0.5, 100)], { type: 'gm', program: 0, bank: 0 }),
        48000,
      );
      const result = await backend.renderTrack(request);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors[0]).toMatchObject({
          code: 'audio.backend.process_failed',
          path: '/tracks/0',
          params: { exitCode: 7 },
        });
        expect(result.errors[0]?.message).toContain('simulated FluidSynth failure');
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'kills and reaps a hung process at the timeout boundary',
    async () => {
      const root = tempRoot();
      const font = writeFakeSoundFont(join(root, 'font.sf2'));
      const fake = writeScript(join(root, 'bin', 'slow fluidsynth'), 'sleep 5');
      const backend = createFluidSynthBackend({
        binaryPath: fake,
        gmSoundFont: font,
        timeoutMs: 150,
      });
      const { request } = requestFor(
        oneTrackSong([clipNote(60, 0, 0.5, 100)], { type: 'gm', program: 0, bank: 0 }),
        48000,
      );
      const started = Date.now();
      const result = await backend.renderTrack(request);
      const elapsed = Date.now() - started;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors[0]).toMatchObject({
          code: 'audio.backend.timeout',
          path: '/tracks/0',
          params: { timeoutMs: 150 },
        });
      }
      expect(elapsed).toBeLessThan(3_000);
    },
  );

  it('reports configuration problems as structured issues instead of throwing', async () => {
    const backend = createFluidSynthBackend({ timeoutMs: 0, maxStdoutBytes: -1 });
    const { request } = requestFor(
      oneTrackSong([clipNote(60, 0, 0.5, 100)], { type: 'builtin', id: 'keys.soft' }),
      48000,
    );
    const result = await backend.renderTrack(request);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((issue) => issue.code)).toEqual([
        'audio.config.invalid',
        'audio.config.invalid',
      ]);
    }
  });

  it('reports a missing GM SoundFont and a missing project root distinctly', async () => {
    const noFont = createFluidSynthBackend({ binaryPath: '/nonexistent/fluidsynth' });
    const gm = requestFor(
      oneTrackSong([clipNote(60, 0, 0.5, 100)], { type: 'gm', program: 0, bank: 0 }),
      48000,
    ).request;
    const noFontResult = await noFont.renderTrack(gm);
    expect(noFontResult.ok).toBe(false);
    if (!noFontResult.ok) {
      expect(noFontResult.errors[0]?.code).toBe('audio.asset.missing');
      expect(noFontResult.errors[0]?.hint).toContain('built-in synth');
    }

    const noRoot = createFluidSynthBackend({ gmSoundFont: '/tmp/does-not-matter.sf2' });
    const sf = requestFor(
      oneTrackSong([clipNote(60, 0, 0.5, 100)], {
        type: 'soundfont',
        path: 'assets/piano.sf2',
        program: 0,
        bank: 0,
      }),
      48000,
    ).request;
    const noRootResult = await noRoot.renderTrack(sf);
    expect(noRootResult.ok).toBe(false);
    if (!noRootResult.ok) {
      expect(noRootResult.errors[0]?.code).toBe('audio.config.invalid');
      expect(noRootResult.errors[0]?.message).toContain('projectRoot');
    }
  });
});

describe('FluidSynth configuration and checksum errors', () => {
  it('rejects an unknown configuration key', async () => {
    const backend = createFluidSynthBackend({
      unsupportedSetting: true,
    } as unknown as FluidSynthBackendConfig);
    const { request } = requestFor(
      oneTrackSong([clipNote(60, 0, 0.5, 100)], { type: 'builtin', id: 'keys.soft' }),
      48000,
    );
    const result = await backend.renderTrack(request);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toMatchObject({
        code: 'audio.config.invalid',
        path: '/unsupportedSetting',
      });
      expect(result.errors[0]?.message).toContain('unsupportedSetting');
    }
  });

  it('rejects a configured project asset checksum mismatch before spawning', async () => {
    const root = tempRoot();
    const relative = 'assets/font.sf2';
    writeFakeSoundFont(join(root, relative));
    const backend = createFluidSynthBackend({
      projectRoot: root,
      assetChecksums: { [relative]: '0'.repeat(64) },
    });
    const song = oneTrackSong([clipNote(60, 0, 0.5, 100)], {
      type: 'soundfont',
      path: relative,
      program: 0,
      bank: 0,
    });
    const result = await renderSongAudio(song, { sampleRate: 48000, backend });
    expect(result.ok).toBe(false);
    if (!result.ok && result.stage === 'audio') {
      expect(result.errors[0]).toMatchObject({
        code: 'audio.asset.checksum_mismatch',
        path: '/tracks/0/instrument/path',
      });
    }
  });
});

describe('FluidSynth project asset errors', () => {
  it('returns structured missing and corrupt asset errors before spawning', async () => {
    const root = tempRoot();
    const backend = createFluidSynthBackend({ projectRoot: root });

    const missingSong = oneTrackSong([clipNote(60, 0, 0.5, 100)], {
      type: 'soundfont',
      path: 'assets/missing.sf2',
      program: 0,
      bank: 0,
    });
    const missing = await renderSongAudio(missingSong, { sampleRate: 48000, backend });
    expect(missing.ok).toBe(false);
    if (!missing.ok && missing.stage === 'audio') {
      expect(missing.errors[0]?.code).toBe('audio.asset.missing');
      expect(missing.errors[0]?.path).toBe('/tracks/0/instrument/path');
    }

    const corruptPath = join(root, 'assets', 'corrupt.sf2');
    mkdirSync(dirname(corruptPath), { recursive: true });
    writeFileSync(corruptPath, 'corrupt');
    const corruptSong = oneTrackSong([clipNote(60, 0, 0.5, 100)], {
      type: 'soundfont',
      path: 'assets/corrupt.sf2',
      program: 0,
      bank: 0,
    });
    const corrupt = await renderSongAudio(corruptSong, { sampleRate: 48000, backend });
    expect(corrupt.ok).toBe(false);
    if (!corrupt.ok && corrupt.stage === 'audio') {
      expect(corrupt.errors[0]?.code).toBe('audio.asset.invalid');
    }
  });
});

describe.skipIf(!NATIVE_AVAILABLE)(
  NATIVE_AVAILABLE
    ? 'FluidSynth native rendering'
    : 'FluidSynth native rendering (skipped: install FluidSynth 2.x and FluidR3_GM.sf2; CI provisioning is Task 19)',
  () => {
    const backend = createFluidSynthBackend({
      binaryPath: FLUID_BINARY,
      gmSoundFont: FLUID_SOUNDFONT,
      verifyGmSoundFontChecksum: true,
    });

    it('reports availability for health checks', async () => {
      expect(await isFluidSynthBinaryAvailable(FLUID_BINARY)).toBe(true);
    });

    it('probes the installed version for report metadata and degrades to null', async () => {
      const version = await probeFluidSynthVersion(FLUID_BINARY);
      expect(version).not.toBeNull();
      expect(version).toMatch(/^2\./);
      expect(await probeFluidSynthVersion('/definitely/missing/vamp-fluidsynth')).toBeNull();
    });

    it('records the backend version and registry checksum in an artifact report', async () => {
      const root = tempRoot('vamp-native-artifacts-');
      const song = oneTrackSong(
        [clipNote(60, 0, 0.5, 100)],
        { type: 'builtin', id: 'piano.soft' },
        { durationHint: 2 },
      );
      const result = await renderSongArtifacts(song, {
        outputDir: join(root, 'out'),
        sampleRate: 48000,
        backend,
        stems: false,
        midi: false,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.report.backend.id).toBe('fluidsynth-sf2-v1');
      expect(result.report.backend.versionSource).toBe('probe');
      expect(result.report.backend.version).toMatch(/^2\./);
      expect(result.report.assets.registry).toHaveLength(1);
      expect(result.report.assets.registry[0]?.checksum.value).toMatch(/^[0-9a-f]{64}$/);
    });

    it.each([44100, 48000] as const)(
      'renders a curated piano at %i Hz with exact frames, finite non-silent samples, and repeat identity',
      async (sampleRate) => {
        const song = oneTrackSong(
          [clipNote(60, 0, 0.9, 108), clipNote(64, 0.75, 0.5, 96), clipNote(67, 1.5, 0.5, 104)],
          { type: 'builtin', id: 'piano.soft' },
          { durationHint: 4 },
        );
        const first = await renderSongAudio(song, { sampleRate, backend });
        expect(first.ok).toBe(true);
        if (!first.ok) {
          return;
        }
        expect(first.audio.frameCount).toBe(first.timeline.renderedSamples);
        expect(first.audio.frameCount).toBe(sampleRate * 2);
        expect(peakOf(first.audio.left)).toBeGreaterThan(0.001);
        expect(peakOf(first.audio.right)).toBeGreaterThan(0.001);
        expect(first.stats.backendId).toBe('fluidsynth-sf2-v1');
        expect(first.stats.voiceCapPolicy).toBe('drop-newest');
        expect(first.stats.tracks[0]).toMatchObject({
          startedVoices: 3,
          droppedVoices: 0,
          peakActiveVoices: 2,
        });

        const second = await renderSongAudio(song, { sampleRate, backend });
        expect(second.ok).toBe(true);
        if (second.ok) {
          expect(sameSamples(first.audio.left, second.audio.left)).toBe(true);
          expect(sameSamples(first.audio.right, second.audio.right)).toBe(true);
        }
      },
    );

    it('renders an explicit GM program offline', async () => {
      const song = oneTrackSong([clipNote(67, 0, 1, 100)], { type: 'gm', program: 40, bank: 0 });
      const rendered = await renderSongAudio(song, { sampleRate: 48000, backend });
      expect(rendered.ok).toBe(true);
      if (rendered.ok) {
        expect(rendered.stats.tracks[0]?.instrumentType).toBe('gm');
        expect(peakOf(rendered.audio.left)).toBeGreaterThan(0.0005);
      }
    });

    it.each([44100, 48000] as const)(
      'renders the curated drum kit on channel 9 as audible one-shots at %i Hz',
      async (sampleRate) => {
        const song = oneTrackSong(
          [
            clipNote(36, 0, 0.25, 120),
            clipNote(38, 0.5, 0.25, 110),
            clipNote(42, 0.75, 0.25, 90),
            clipNote(49, 1, 0.5, 100),
          ],
          { type: 'builtin', id: 'drums.kit' },
          { durationHint: 4, drums: true },
        );
        const rendered = await renderSongAudio(song, { sampleRate, backend });
        expect(rendered.ok).toBe(true);
        if (rendered.ok) {
          expect(rendered.timeline.tracks[0]?.channel).toBe(9);
          expect(rendered.stats.tracks[0]).toMatchObject({
            instrumentType: 'builtin',
            builtinId: 'drums.kit',
            startedVoices: 4,
          });
          expect(peakOf(rendered.audio.left)).toBeGreaterThan(0.001);
          expect(rendered.audio.frameCount).toBe(sampleRate * 2);
        }
      },
    );

    it('renders a project SoundFont asset with spaces and Unicode in its path', async () => {
      const root = tempRoot('vamp native assets ');
      const relative = 'My Sounds/ピアノ é.sf2';
      const destination = join(root, relative);
      mkdirSync(dirname(destination), { recursive: true });
      try {
        linkSync(FLUID_SOUNDFONT, destination);
      } catch {
        copyFileSync(FLUID_SOUNDFONT, destination);
      }

      const projectBackend = createFluidSynthBackend({
        binaryPath: FLUID_BINARY,
        projectRoot: root,
        gmSoundFont: FLUID_SOUNDFONT,
      });
      const song = oneTrackSong(
        [clipNote(60, 0, 1, 100)],
        { type: 'soundfont', path: relative, program: 0, bank: 0 },
        { durationHint: 2 },
      );
      const rendered = await renderSongAudio(song, { sampleRate: 48000, backend: projectBackend });
      expect(rendered.ok).toBe(true);
      if (rendered.ok) {
        expect(rendered.audio.frameCount).toBe(48_000);
        expect(peakOf(rendered.audio.left)).toBeGreaterThan(0.0005);
      }
    });

    it('preserves note onset timing within one MIDI tick', async () => {
      const song = oneTrackSong(
        [clipNote(60, 1, 0.5, 110)],
        { type: 'builtin', id: 'keys.soft' },
        { durationHint: 4 },
      );
      const rendered = await renderSongAudio(song, { sampleRate: 48000, backend });
      expect(rendered.ok).toBe(true);
      if (!rendered.ok) {
        return;
      }
      let firstAudible = -1;
      for (let frame = 0; frame < rendered.audio.left.length; frame += 1) {
        if (Math.abs(rendered.audio.left[frame] ?? 0) > 1e-4) {
          firstAudible = frame;
          break;
        }
      }
      expect(firstAudible).toBeGreaterThanOrEqual(0);
      // One beat at 120 BPM is 0.5 s. 960 PPQ puts one tick at about 0.52 ms.
      expect(Math.abs(firstAudible / 48_000 - 0.5)).toBeLessThan(0.003);
    });

    it('applies the voice cap before rendering and reports drops', async () => {
      const notes = [60, 62, 64, 65, 67, 69, 71, 72].map((pitch) => clipNote(pitch, 0, 2, 100));
      const song = oneTrackSong(notes, { type: 'builtin', id: 'keys.soft' }, { durationHint: 2 });
      const { timeline } = requestFor(song, 48000);
      const rendered = await renderTimelineAudio(timeline, {
        backend,
        maxVoicesPerTrack: 3,
      });
      expect(rendered.ok).toBe(true);
      if (rendered.ok) {
        expect(rendered.stats.tracks[0]).toMatchObject<Partial<AudioBackendTrackStats>>({
          startedVoices: 3,
          droppedVoices: 5,
          stolenVoices: 0,
          peakActiveVoices: 3,
        });
        expect(rendered.warnings.some((issue) => issue.code === 'audio.voice.dropped')).toBe(true);
      }
    });

    it('produces digital silence for a track whose notes start beyond the render', async () => {
      const song = oneTrackSong(
        [clipNote(60, 0, 1, 100)],
        { type: 'builtin', id: 'keys.soft' },
        { durationHint: 1 },
      );
      const timeline = compileOk(song, { sampleRate: 48000 }).timeline;
      const track = timeline.tracks[0];
      if (track === undefined) {
        throw new Error('expected a track');
      }
      const request = {
        track,
        events: [],
        sampleRate: 48000 as const,
        frameCount: 4_800,
        seed: 1,
        maxVoices: 32,
        bpm: 120,
      };
      const result = await createFluidSynthBackend({
        binaryPath: FLUID_BINARY,
        gmSoundFont: FLUID_SOUNDFONT,
      }).renderTrack(request);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.stats.startedVoices).toBe(0);
        expect(peakOf(result.samples)).toBe(0);
      }
    });

    it('applies the shared effects and automation to a native sample track deterministically', async () => {
      const notes = [clipNote(60, 0, 1, 108), clipNote(67, 0.5, 0.5, 96)];
      const wetSong = oneTrackSong(
        notes,
        { type: 'builtin', id: 'piano.soft' },
        {
          durationHint: 2,
        },
      );
      const wetTrack = wetSong.tracks[0];
      if (wetTrack === undefined) {
        throw new Error('expected a track');
      }
      wetTrack.effects = [
        { type: 'lowpass', q: 1 },
        { type: 'delay', timeMs: 50, feedback: 0.2, mix: 0.2 },
        { type: 'reverb', decaySeconds: 0.2, mix: 0.2 },
      ];
      wetTrack.automation = {
        volume: {
          points: [
            { time: 0, value: 0.6 },
            { time: 2, value: 1 },
          ],
        },
        pan: {
          points: [
            { time: 0, value: -0.4 },
            { time: 2, value: 0.4 },
          ],
        },
        filterCutoffHz: {
          points: [
            { time: 0, value: 20000 },
            { time: 2, value: 500 },
          ],
        },
      };

      const first = await renderSongAudio(wetSong, { sampleRate: 48000, backend });
      const second = await renderSongAudio(wetSong, { sampleRate: 48000, backend });
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (!first.ok || !second.ok) {
        return;
      }
      expect(first.audio.frameCount).toBe(first.timeline.renderedSamples);
      expect(peakOf(first.audio.left)).toBeGreaterThan(0.0005);
      expect(sameSamples(first.audio.left, second.audio.left)).toBe(true);
      expect(sameSamples(first.audio.right, second.audio.right)).toBe(true);

      const dry = await renderSongAudio(
        oneTrackSong(notes, { type: 'builtin', id: 'piano.soft' }, { durationHint: 2 }),
        { sampleRate: 48000, backend },
      );
      expect(dry.ok).toBe(true);
      if (dry.ok) {
        expect(dry.audio.frameCount).toBe(first.audio.frameCount);
        let difference = 0;
        for (let frame = 0; frame < first.audio.frameCount; frame += 1) {
          difference = Math.max(
            difference,
            Math.abs((first.audio.left[frame] ?? 0) - (dry.audio.left[frame] ?? 0)),
          );
        }
        expect(difference).toBeGreaterThan(1e-4);
      }
    });
  },
);
