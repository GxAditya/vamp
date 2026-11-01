import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it, vi } from 'vitest';

// Built-in renders are short, but native FluidSynth and cancellation tests can
// take several seconds under parallel load.
vi.setConfig({ testTimeout: 30_000 });

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const cliBin = fileURLToPath(new URL('../bin/vamp.js', import.meta.url));
const nativeBinary = process.env.VAMP_FLUIDSYNTH_PATH ?? '/usr/bin/fluidsynth';
const nativeSoundFont = process.env.VAMP_SOUNDFONT_PATH ?? '/usr/share/sounds/sf2/FluidR3_GM.sf2';
const nativeAvailable = existsSync(nativeBinary) && existsSync(nativeSoundFont);

const temporaryDirectories: string[] = [];

function tempDirectory(prefix = 'vamp-cli-render-'): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temporaryDirectories.push(directory);
  return directory;
}

function runCli(
  args: readonly string[],
  options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv } = {},
) {
  return spawnSync(process.execPath, [cliBin, ...args], {
    cwd: options.cwd ?? repoRoot,
    encoding: 'utf8',
    timeout: 30_000,
    input: '',
    ...(options.env === undefined ? {} : { env: options.env }),
  });
}

function parseEnvelope(result: ReturnType<typeof runCli>): Record<string, unknown> {
  expect(result.stderr).toBe('');
  const envelope = JSON.parse(result.stdout) as Record<string, unknown>;
  expect(typeof envelope).toBe('object');
  expect(envelope).not.toBeNull();
  return envelope;
}

function writeJson(directory: string, name: string, value: unknown): string {
  const path = join(directory, name);
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
  return path;
}

function song(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: '1.0.0',
    meta: {
      title: 'Render Test Song',
      bpm: 120,
      timeSignature: { numerator: 4, denominator: 4 },
      key: { tonic: 'C', mode: 'major' },
      seed: 7,
      durationHint: 2,
    },
    tracks: [
      {
        id: 'keys',
        name: 'Soft Keys',
        kind: 'midi',
        channel: 0,
        instrument: { type: 'builtin', id: 'keys.soft' },
        notes: [
          { pitch: 60, start: 0, duration: 1, velocity: 100 },
          { pitch: 64, start: 1, duration: 1, velocity: 90 },
        ],
      },
      {
        id: 'bass',
        name: 'Sub Bass',
        kind: 'midi',
        channel: 1,
        instrument: { type: 'builtin', id: 'bass.sub' },
        notes: [{ pitch: 36, start: 0, duration: 1.5, velocity: 110 }],
      },
    ],
    ...overrides,
  };
}

function gmSong(): Record<string, unknown> {
  return song({
    tracks: [
      {
        id: 'piano',
        name: 'Piano',
        kind: 'midi',
        channel: 0,
        instrument: { type: 'gm', program: 0, bank: 0 },
        notes: [{ pitch: 60, start: 0, duration: 1, velocity: 100 }],
      },
    ],
  });
}

interface WavInfo {
  readonly sampleRate: number;
  readonly channels: number;
  readonly bitDepth: number;
  readonly frameCount: number;
  readonly peak: number;
}

/** Independent RIFF/WAVE parser used instead of the engine encoder helpers. */
function parseWavFile(path: string): WavInfo {
  const bytes = readFileSync(path);
  expect(bytes.toString('ascii', 0, 4)).toBe('RIFF');
  expect(bytes.toString('ascii', 8, 12)).toBe('WAVE');

  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitDepth = 0;
  let frameCount = 0;
  let dataOffset = -1;
  let dataBytes = 0;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      expect(bytes.readUInt16LE(body)).toBe(1);
      channels = bytes.readUInt16LE(body + 2);
      sampleRate = bytes.readUInt32LE(body + 4);
      bitDepth = bytes.readUInt16LE(body + 14);
    } else if (id === 'data') {
      dataOffset = body;
      dataBytes = size;
      frameCount = size / (channels * (bitDepth / 8));
    }
    offset = body + size + (size % 2);
  }

  expect(channels).toBe(2);
  expect(bitDepth).toBe(16);
  expect(sampleRate).toBeGreaterThanOrEqual(44_100);
  expect(dataOffset).toBeGreaterThanOrEqual(0);
  expect(dataBytes).toBeGreaterThan(0);

  let peak = 0;
  for (let index = 0; index < dataBytes; index += 2) {
    peak = Math.max(peak, Math.abs(bytes.readInt16LE(dataOffset + index)));
  }
  return { sampleRate, channels, bitDepth, frameCount, peak };
}

function parseMidiFile(path: string): { format: number; trackCount: number } {
  const bytes = readFileSync(path);
  expect(bytes.toString('ascii', 0, 4)).toBe('MThd');
  expect(bytes.readUInt32BE(4)).toBe(6);
  const format = bytes.readUInt16BE(8);
  const trackCount = bytes.readUInt16BE(10);
  let offset = 14;
  let seen = 0;
  while (offset + 8 <= bytes.length && seen < trackCount) {
    expect(bytes.toString('ascii', offset, offset + 4)).toBe('MTrk');
    const length = bytes.readUInt32BE(offset + 4);
    offset += 8 + length;
    seen += 1;
  }
  expect(seen).toBe(trackCount);
  return { format, trackCount };
}

function dataOf(envelope: Record<string, unknown>): Record<string, unknown> {
  return envelope.data as Record<string, unknown>;
}

function errorOf(envelope: Record<string, unknown>): Record<string, unknown> {
  return envelope.error as Record<string, unknown>;
}

function parseReport(path: string): Record<string, unknown> {
  const report = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  expect(report.format).toBe('vamp.render-report');
  expect(report.formatVersion).toBe(1);
  return report;
}

function fakeSoundFont(directory: string): string {
  const path = join(directory, 'fake.sf2');
  const buffer = Buffer.alloc(24);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(16, 4);
  buffer.write('sfbk', 8, 'ascii');
  buffer.write('LIST', 12, 'ascii');
  writeFileSync(path, buffer);
  return path;
}

afterAll(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('vamp render complete artifacts', () => {
  it('renders master, stems, MIDI, and report at 48 kHz with pure JSON stdout', () => {
    const workspace = tempDirectory();
    writeJson(workspace, 'song.json', song());

    const result = runCli(
      ['render', 'song.json', '--out', 'out', '--backend', 'builtin', '--json'],
      {
        cwd: workspace,
      },
    );
    const envelope = parseEnvelope(result);
    const data = dataOf(envelope);

    expect(result.status).toBe(0);
    expect(envelope).toMatchObject({
      command: 'render',
      ok: true,
      warnings: [],
    });
    expect(data).toMatchObject({
      file: 'song.json',
      resolvedPath: join(workspace, 'song.json'),
      outputDir: join(workspace, 'out'),
      format: 'wav',
      sampleRate: 48_000,
      backend: 'builtin',
    });
    expect(data.reportFile).toMatchObject({
      path: 'report.json',
      absolutePath: join(workspace, 'out', 'report.json'),
    });
    expect(data.outputs).toMatchObject({
      master: 'master.wav',
      stems: ['stem-01-soft-keys.wav', 'stem-02-sub-bass.wav'],
      midi: 'song.mid',
      report: 'report.json',
    });
    expect(data.summary).toMatchObject({
      title: 'Render Test Song',
      sampleRate: 48_000,
      stemCount: 2,
      midi: true,
      report: true,
    });

    const artifacts = data.artifacts as Array<Record<string, unknown>>;
    expect(artifacts.map((artifact) => artifact.role)).toEqual(['master', 'stem', 'stem', 'midi']);
    for (const artifact of artifacts) {
      expect(existsSync(String(artifact.absolutePath))).toBe(true);
      expect(statSync(String(artifact.absolutePath)).size).toBe(artifact.bytes);
    }

    const files = readdirSync(join(workspace, 'out')).sort();
    expect(files).toEqual([
      'master.wav',
      'report.json',
      'song.mid',
      'stem-01-soft-keys.wav',
      'stem-02-sub-bass.wav',
    ]);

    const master = parseWavFile(join(workspace, 'out', 'master.wav'));
    const keysStem = parseWavFile(join(workspace, 'out', 'stem-01-soft-keys.wav'));
    const bassStem = parseWavFile(join(workspace, 'out', 'stem-02-sub-bass.wav'));
    expect(master.sampleRate).toBe(48_000);
    expect(master.frameCount).toBe(48_000);
    expect(master.peak).toBeGreaterThan(0);
    expect(keysStem.frameCount).toBe(master.frameCount);
    expect(bassStem.frameCount).toBe(master.frameCount);
    expect(keysStem.peak).toBeGreaterThan(0);
    expect(bassStem.peak).toBeGreaterThan(0);

    const midi = parseMidiFile(join(workspace, 'out', 'song.mid'));
    expect(midi.format).toBe(1);
    expect(midi.trackCount).toBe(3);

    const report = parseReport(join(workspace, 'out', 'report.json'));
    expect(report).toMatchObject({
      title: 'Render Test Song',
      schemaVersion: '1.0.0',
      backend: { id: 'builtin-synth-v1' },
    });
    expect((report.duration as Record<string, unknown>).sampleRate).toBe(48_000);
    expect((report.stems as unknown[]).length).toBe(2);
    expect((report.outputs as Record<string, unknown>).master).toBe('master.wav');
    expect(data.report).toEqual(report);
  });

  it('renders complete artifacts at 44.1 kHz with independently parsed files', () => {
    const workspace = tempDirectory();
    writeJson(workspace, 'song.json', song());

    const result = runCli(
      ['render', 'song.json', '--out', 'out44', '--sample-rate', '44100', '--json'],
      { cwd: workspace },
    );
    const envelope = parseEnvelope(result);

    expect(result.status).toBe(0);
    expect(dataOf(envelope)).toMatchObject({ sampleRate: 44_100 });
    const master = parseWavFile(join(workspace, 'out44', 'master.wav'));
    const stem = parseWavFile(join(workspace, 'out44', 'stem-01-soft-keys.wav'));
    expect(master.sampleRate).toBe(44_100);
    expect(master.frameCount).toBe(44_100);
    expect(stem.sampleRate).toBe(44_100);
    expect(stem.frameCount).toBe(master.frameCount);
    parseMidiFile(join(workspace, 'out44', 'song.mid'));
    const report = parseReport(join(workspace, 'out44', 'report.json'));
    expect((report.duration as Record<string, unknown>).sampleRate).toBe(44_100);
  });

  it('accepts --json before the command and suppresses progress on stderr', () => {
    const workspace = tempDirectory();
    writeJson(workspace, 'song.json', song());

    const result = runCli(
      ['--json', 'render', 'song.json', '--out', 'out-global-json', '--no-stems', '--no-midi'],
      { cwd: workspace },
    );
    const envelope = parseEnvelope(result);

    expect(result.status).toBe(0);
    expect(envelope).toMatchObject({ command: 'render', ok: true });
  });

  it('honors explicit stem, MIDI, and report opt-outs while returning report data', () => {
    const workspace = tempDirectory();
    writeJson(workspace, 'song.json', song());

    const result = runCli(
      [
        'render',
        'song.json',
        '--out',
        'out-no-extras',
        '--no-stems',
        '--no-midi',
        '--no-report',
        '--json',
      ],
      { cwd: workspace },
    );
    const envelope = parseEnvelope(result);
    const data = dataOf(envelope);

    expect(result.status).toBe(0);
    expect(readdirSync(join(workspace, 'out-no-extras'))).toEqual(['master.wav']);
    expect(data.reportFile).toBeNull();
    expect(data).toMatchObject({
      outputs: { master: 'master.wav', stems: [], midi: null, report: null },
      summary: { stemCount: 0, midi: false, report: false, artifactCount: 1 },
    });
    expect((data.report as Record<string, unknown>).format).toBe('vamp.render-report');
  });

  it('prints artifact paths and report values to stdout in human mode', () => {
    const workspace = tempDirectory();
    writeJson(workspace, 'song.json', song());

    const result = runCli(
      [
        'render',
        'song.json',
        '--out',
        'out-human',
        '--backend',
        'builtin',
        '--no-stems',
        '--no-midi',
      ],
      { cwd: workspace },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Rendered "Render Test Song"');
    expect(result.stdout).toContain(`Output: ${join(workspace, 'out-human')}`);
    expect(result.stdout).toContain('Backend: builtin-synth-v1');
    expect(result.stdout).toContain('master.wav');
    expect(result.stdout).toContain('report.json');
    expect(result.stdout).toContain('Integrated loudness:');
    expect(result.stderr).toContain('Rendering "song.json"');
  });
});

describe('vamp render overwrite safety', () => {
  it('refuses existing artifacts without --overwrite and replaces them with it', () => {
    const workspace = tempDirectory();
    writeJson(workspace, 'song.json', song());

    const first = runCli(
      ['render', 'song.json', '--out', 'out', '--no-stems', '--no-midi', '--json'],
      { cwd: workspace },
    );
    expect(first.status).toBe(0);
    const masterPath = join(workspace, 'out', 'master.wav');
    const before = readFileSync(masterPath);

    const refused = runCli(
      ['render', 'song.json', '--out', 'out', '--no-stems', '--no-midi', '--json'],
      { cwd: workspace },
    );
    const refusedEnvelope = parseEnvelope(refused);
    expect(refused.status).toBe(1);
    expect(errorOf(refusedEnvelope)).toMatchObject({ code: 'audio.artifacts.exists' });
    expect(String(errorOf(refusedEnvelope).hint)).toContain('--overwrite');
    expect(readFileSync(masterPath)).toEqual(before);

    const replaced = runCli(
      ['render', 'song.json', '--out', 'out', '--no-stems', '--no-midi', '--overwrite', '--json'],
      { cwd: workspace },
    );
    expect(replaced.status).toBe(0);
    expect(parseEnvelope(replaced)).toMatchObject({ ok: true });
    expect(readFileSync(masterPath)).toEqual(before);
  });
});

describe('vamp render errors', () => {
  it('rejects MP3 with a helpful deferred message and no stderr in JSON mode', () => {
    const workspace = tempDirectory();
    writeJson(workspace, 'song.json', song());

    const result = runCli(['render', 'song.json', '--out', 'out', '--format', 'mp3', '--json'], {
      cwd: workspace,
    });
    const envelope = parseEnvelope(result);

    expect(result.status).toBe(2);
    expect(envelope).toMatchObject({
      command: 'render',
      ok: false,
      error: { code: 'cli.usage.unsupported_format' },
    });
    expect(String(errorOf(envelope).hint)).toContain('MP3 export is deferred');
    expect(existsSync(join(workspace, 'out'))).toBe(false);
  });

  it('rejects invalid sample rates, conflicting switches, and misplaced backend options', () => {
    const workspace = tempDirectory();
    writeJson(workspace, 'song.json', song());

    const rate = runCli(
      ['render', 'song.json', '--out', 'out', '--sample-rate', '96000', '--json'],
      { cwd: workspace },
    );
    expect(rate.status).toBe(2);
    expect(parseEnvelope(rate)).toMatchObject({
      error: { code: 'cli.usage.invalid_option_value' },
    });

    const conflict = runCli(
      ['render', 'song.json', '--out', 'out', '--stems', '--no-stems', '--json'],
      { cwd: workspace },
    );
    expect(conflict.status).toBe(2);
    expect(parseEnvelope(conflict)).toMatchObject({
      error: { code: 'cli.usage.conflicting_options' },
    });

    const misplaced = runCli(
      [
        'render',
        'song.json',
        '--out',
        'out',
        '--backend',
        'builtin',
        '--soundfont',
        '/tmp/font.sf2',
        '--json',
      ],
      { cwd: workspace },
    );
    expect(misplaced.status).toBe(2);
    expect(parseEnvelope(misplaced)).toMatchObject({
      error: { code: 'cli.usage.invalid_option_combination' },
    });

    const missingOut = runCli(['render', 'song.json', '--json'], { cwd: workspace });
    expect(missingOut.status).toBe(2);
    expect(parseEnvelope(missingOut)).toMatchObject({
      error: { code: 'cli.usage.missing_option' },
    });
  });

  it('rejects missing files, directories, symlinks, invalid UTF-8, malformed JSON, and oversized files', () => {
    const workspace = tempDirectory();

    const missing = runCli(['render', 'missing.json', '--out', 'out', '--json'], {
      cwd: workspace,
    });
    expect(missing.status).toBe(1);
    expect(parseEnvelope(missing)).toMatchObject({
      error: { code: 'cli.file.missing' },
    });

    mkdirSync(join(workspace, 'a-directory'));
    const directory = runCli(['render', 'a-directory', '--out', 'out', '--json'], {
      cwd: workspace,
    });
    expect(directory.status).toBe(1);
    expect(parseEnvelope(directory)).toMatchObject({
      error: { code: 'cli.file.not_file' },
    });

    writeJson(workspace, 'valid.json', song());
    if (process.platform !== 'win32') {
      symlinkSync(join(workspace, 'valid.json'), join(workspace, 'link.json'));
      const symlink = runCli(['render', 'link.json', '--out', 'out', '--json'], {
        cwd: workspace,
      });
      expect(symlink.status).toBe(1);
      expect(parseEnvelope(symlink)).toMatchObject({
        error: { code: 'cli.file.symlink' },
      });
    }

    writeFileSync(join(workspace, 'utf8.json'), Buffer.from([0xff, 0xfe, 0xfd]));
    const invalidUtf8 = runCli(['render', 'utf8.json', '--out', 'out', '--json'], {
      cwd: workspace,
    });
    expect(invalidUtf8.status).toBe(1);
    expect(parseEnvelope(invalidUtf8)).toMatchObject({
      error: { code: 'cli.file.invalid_utf8' },
    });

    writeFileSync(join(workspace, 'bad.json'), '{ "schemaVersion": "1.0.0",', 'utf8');
    const malformed = runCli(['render', 'bad.json', '--out', 'out', '--json'], {
      cwd: workspace,
    });
    expect(malformed.status).toBe(1);
    expect(parseEnvelope(malformed)).toMatchObject({
      error: { code: 'cli.file.malformed_json' },
    });

    writeFileSync(join(workspace, 'oversized.json'), Buffer.alloc(8 * 1024 * 1024 + 1, 0x20));
    const oversized = runCli(['render', 'oversized.json', '--out', 'out', '--json'], {
      cwd: workspace,
    });
    expect(oversized.status).toBe(1);
    expect(parseEnvelope(oversized)).toMatchObject({
      error: { code: 'cli.file.too_large' },
    });
  });

  it('reports invalid songs with shared issues and does not create the output directory', () => {
    const workspace = tempDirectory();
    writeJson(workspace, 'invalid.json', song({ tracks: [] }));

    const result = runCli(['render', 'invalid.json', '--out', 'out', '--json'], {
      cwd: workspace,
    });
    const envelope = parseEnvelope(result);
    const error = errorOf(envelope) as {
      code: string;
      issues: Array<{ code: string; path: string }>;
    };

    expect(result.status).toBe(1);
    expect(error.code).toBe('cli.validation.invalid');
    expect(error.issues[0]).toMatchObject({
      code: 'schema.structure.item_count_out_of_range',
      path: '/tracks',
    });
    expect(existsSync(join(workspace, 'out'))).toBe(false);
  });

  it('surfaces the built-in backend instrument error with a FluidSynth hint', () => {
    const workspace = tempDirectory();
    writeJson(workspace, 'gm.json', gmSong());

    const result = runCli(['render', 'gm.json', '--out', 'out', '--backend', 'builtin', '--json'], {
      cwd: workspace,
    });
    const envelope = parseEnvelope(result);
    const error = errorOf(envelope);

    expect(result.status).toBe(1);
    expect(error.code).toBe('audio.instrument.unsupported_variant');
    expect(String(error.hint)).toContain('--backend fluidsynth');
    expect(String(error.hint)).toContain('--soundfont');
    expect(existsSync(join(workspace, 'out'))).toBe(false);
  });

  it('reports a missing FluidSynth executable before rendering', () => {
    const workspace = tempDirectory();
    writeJson(workspace, 'gm.json', gmSong());

    const result = runCli(
      [
        'render',
        'gm.json',
        '--out',
        'out',
        '--backend',
        'fluidsynth',
        '--fluidsynth-path',
        join(workspace, 'no-such-fluidsynth'),
        '--soundfont',
        join(workspace, 'font.sf2'),
        '--json',
      ],
      { cwd: workspace },
    );
    const envelope = parseEnvelope(result);

    expect(result.status).toBe(1);
    expect(errorOf(envelope)).toMatchObject({
      code: 'audio.backend.missing_dependency',
    });
    expect(String(errorOf(envelope).hint)).toContain('--fluidsynth-path');
    expect(existsSync(join(workspace, 'out'))).toBe(false);
  });

  it('reports a corrupt SoundFont before rendering', () => {
    const workspace = tempDirectory();
    writeJson(workspace, 'gm.json', gmSong());
    writeFileSync(join(workspace, 'bad.sf2'), 'not a soundfont', 'utf8');

    const result = runCli(
      [
        'render',
        'gm.json',
        '--out',
        'out',
        '--backend',
        'fluidsynth',
        '--fluidsynth-path',
        process.execPath,
        '--soundfont',
        join(workspace, 'bad.sf2'),
        '--json',
      ],
      { cwd: workspace },
    );
    const envelope = parseEnvelope(result);

    expect(result.status).toBe(1);
    expect(errorOf(envelope)).toMatchObject({ code: 'audio.asset.invalid' });
    expect(existsSync(join(workspace, 'out'))).toBe(false);
  });

  it('reports a missing SoundFont before rendering', () => {
    const workspace = tempDirectory();
    writeJson(workspace, 'gm.json', gmSong());

    const result = runCli(
      [
        'render',
        'gm.json',
        '--out',
        'out',
        '--backend',
        'fluidsynth',
        '--fluidsynth-path',
        process.execPath,
        '--soundfont',
        join(workspace, 'missing.sf2'),
        '--json',
      ],
      { cwd: workspace },
    );
    const envelope = parseEnvelope(result);

    expect(result.status).toBe(1);
    expect(errorOf(envelope)).toMatchObject({ code: 'audio.asset.missing' });
    expect(existsSync(join(workspace, 'out'))).toBe(false);
  });

  it('reports an invalid output path without publishing artifacts', () => {
    const workspace = tempDirectory();
    writeJson(workspace, 'song.json', song());
    writeFileSync(join(workspace, 'out'), 'not a directory', 'utf8');

    const result = runCli(['render', 'song.json', '--out', 'out', '--json'], {
      cwd: workspace,
    });
    const envelope = parseEnvelope(result);

    expect(result.status).toBe(1);
    expect(errorOf(envelope)).toMatchObject({ code: 'audio.artifacts.output_invalid' });
    expect(readFileSync(join(workspace, 'out'), 'utf8')).toBe('not a directory');
  });

  it('reports a missing parent directory for a new output', () => {
    const workspace = tempDirectory();
    writeJson(workspace, 'song.json', song());

    const result = runCli(
      ['render', 'song.json', '--out', join('missing-parent', 'out'), '--json'],
      { cwd: workspace },
    );
    const envelope = parseEnvelope(result);

    expect(result.status).toBe(1);
    expect(errorOf(envelope)).toMatchObject({ code: 'audio.artifacts.output_invalid' });
    expect(existsSync(join(workspace, 'missing-parent'))).toBe(false);
  });
});

describe('vamp render cancellation', () => {
  it('aborts on SIGINT, cleans up job output, and returns one JSON error', async () => {
    const workspace = tempDirectory();
    writeJson(workspace, 'gm.json', gmSong());
    const soundFont = fakeSoundFont(workspace);
    const binary = join(workspace, 'slow-fluidsynth');
    writeFileSync(binary, '#!/bin/sh\nsleep 2\nexit 1\n', 'utf8');
    chmodSync(binary, 0o755);

    const child = spawn(
      process.execPath,
      [
        cliBin,
        'render',
        'gm.json',
        '--out',
        'cancel-out',
        '--backend',
        'fluidsynth',
        '--fluidsynth-path',
        binary,
        '--soundfont',
        soundFont,
        '--json',
      ],
      { cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));

    await new Promise((resolve) => setTimeout(resolve, 600));
    child.kill('SIGINT');
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => resolve(code));
    });

    expect(exitCode).toBe(1);
    expect(Buffer.concat(stderr).toString('utf8')).toBe('');
    const envelope = JSON.parse(Buffer.concat(stdout).toString('utf8')) as Record<string, unknown>;
    expect(envelope).toMatchObject({
      command: 'render',
      ok: false,
      error: { code: 'cli.render.cancelled' },
    });
    expect(String(errorOf(envelope).hint)).toContain('No partial artifacts');

    expect(existsSync(join(workspace, 'cancel-out'))).toBe(false);
    const leftovers = readdirSync(workspace).filter((name) => name.startsWith('.vamp-render-'));
    expect(leftovers).toEqual([]);
  });
});

describe('vamp render native FluidSynth smoke', () => {
  it.skipIf(!nativeAvailable)(
    'renders a short GM song through /usr/bin/fluidsynth and FluidR3_GM.sf2',
    () => {
      const workspace = tempDirectory();
      writeJson(workspace, 'gm.json', gmSong());

      const result = runCli(
        [
          'render',
          'gm.json',
          '--out',
          'fluid-out',
          '--backend',
          'fluidsynth',
          '--fluidsynth-path',
          nativeBinary,
          '--soundfont',
          nativeSoundFont,
          '--verify-soundfont',
          '--no-stems',
          '--json',
        ],
        { cwd: workspace },
      );
      const envelope = parseEnvelope(result);
      const data = dataOf(envelope);

      expect(result.status).toBe(0);
      expect(envelope.ok).toBe(true);
      const report = data.report as Record<string, unknown>;
      expect(report.backend).toMatchObject({
        id: 'fluidsynth-sf2-v1',
        versionSource: 'probe',
      });

      const master = parseWavFile(join(workspace, 'fluid-out', 'master.wav'));
      expect(master.sampleRate).toBe(48_000);
      expect(master.peak).toBeGreaterThan(0);
      parseMidiFile(join(workspace, 'fluid-out', 'song.mid'));
      parseReport(join(workspace, 'fluid-out', 'report.json'));
    },
  );
});
