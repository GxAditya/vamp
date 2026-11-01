/**
 * Task 15 `render_song` integration tests.
 *
 * The suite drives the built server through the official MCP SDK client over real
 * stdio with a temporary configured project root, fully offline. It proves the
 * complete agent loop end to end: discover schema and instruments, hand-author a
 * 45-second 90-BPM tutorial BGM fixture, validate it, save it, render it, inspect
 * the report, repair the data against the expected revision, and re-render. Every
 * artifact is parsed independently of the engine, and the failures (invalid data,
 * unavailable assets, stale revisions, root escapes, cancellation, and shutdown)
 * are asserted to be actionable and non-destructive.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { ProjectStore } from '@gxaditya/vamp-project';
import { INSTRUMENT_REGISTRY_VALIDATION } from '@gxaditya/vamp-engine';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 120_000 });

const serverEntry = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const nativeBinary = process.env.VAMP_FLUIDSYNTH_PATH ?? '/usr/bin/fluidsynth';
const nativeSoundFont = process.env.VAMP_SOUNDFONT_PATH ?? '/usr/share/sounds/sf2/FluidR3_GM.sf2';
const nativeAvailable = existsSync(nativeBinary) && existsSync(nativeSoundFont);

const MISSING_BINARY = '/definitely/missing/vamp-fluidsynth';
const MISSING_SOUNDFONT = '/definitely/missing/FluidR3_GM.sf2';
const SECRET_VALUE = 'vamp-render-test-secret-never-report';

/** 90 BPM for 45 seconds is 67.5 quarter-note beats. */
const TUTORIAL_LENGTH_BEATS = 67.5;

const temporaryDirectories: string[] = [];

function tempDirectory(prefix = 'vamp-render-test-'): string {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  temporaryDirectories.push(directory);
  return directory;
}

afterAll(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function chordNotes(root: number, start: number, duration: number): Record<string, unknown>[] {
  return [root, root + 4, root + 7, root + 12].map((pitch) => ({ pitch, start, duration }));
}

/**
 * Hand-authored 45-second 90-BPM tutorial BGM: a four-bar chord pad built from a
 * reusable pattern, a walking bass, an arpeggiated keys line, and a soft drum
 * bed. This is the fixture the agent under test would author, not generated or
 * model-produced content.
 */
function tutorialBgm(
  changes: { readonly keysVolume?: number; readonly keysPan?: number } = {},
): Record<string, unknown> {
  const pad: Record<string, unknown>[] = [];
  for (const [bar, root] of [48, 45, 41, 43].entries()) {
    for (let repeat = 0; repeat < 4; repeat += 1) {
      pad.push(...chordNotes(root + 12, bar * 4 + repeat * 16, 3.5));
    }
  }
  const bass: Record<string, unknown>[] = [];
  for (let beat = 0; beat < 64; beat += 2) {
    const root = [48, 45, 41, 43][Math.floor(beat / 4) % 4] ?? 48;
    bass.push({ pitch: root - 12, start: beat, duration: 1.5, velocity: 96 });
  }
  const keys: Record<string, unknown>[] = [];
  for (let beat = 0; beat < 66; beat += 1) {
    const root = [60, 57, 53, 55][Math.floor(beat / 4) % 4] ?? 60;
    keys.push({
      pitch: root + (beat % 4 === 3 ? 12 : 0),
      start: beat,
      duration: 0.5,
      velocity: 84,
    });
  }
  const drums: Record<string, unknown>[] = [];
  for (let beat = 0; beat < 64; beat += 1) {
    drums.push({ pitch: beat % 4 === 0 ? 36 : 42, start: beat, duration: 0.25, velocity: 78 });
    if (beat % 4 === 2) {
      drums.push({ pitch: 38, start: beat, duration: 0.25, velocity: 88 });
    }
  }
  const keysTrack: Record<string, unknown> = {
    id: 'keys',
    name: 'Keys',
    kind: 'midi',
    channel: 0,
    instrument: { type: 'builtin', id: 'keys.soft' },
    volume: changes.keysVolume ?? 0.9,
    pan: changes.keysPan ?? 0,
    notes: keys,
  };
  return {
    schemaVersion: '1.0.0',
    meta: {
      title: 'Tutorial BGM',
      bpm: 90,
      timeSignature: { numerator: 4, denominator: 4 },
      key: { tonic: 'C', mode: 'major' },
      seed: 7,
      durationHint: TUTORIAL_LENGTH_BEATS,
    },
    patterns: [
      {
        id: 'turnaround',
        lengthBeats: 2,
        notes: [
          { pitch: 62, start: 0, duration: 0.5, velocity: 80 },
          { pitch: 64, start: 1, duration: 0.5, velocity: 80 },
        ],
      },
    ],
    tracks: [
      keysTrack,
      {
        id: 'bass',
        name: 'Bass',
        kind: 'midi',
        channel: 1,
        instrument: { type: 'builtin', id: 'bass.sub' },
        volume: 0.5,
        notes: bass,
      },
      {
        id: 'pad',
        name: 'Pad',
        kind: 'midi',
        channel: 2,
        instrument: { type: 'builtin', id: 'pad.warm' },
        volume: 0.35,
        placements: [{ pattern: 'turnaround', start: 0, repeat: 8 }],
        notes: pad,
      },
      {
        id: 'drums',
        name: 'Drums',
        kind: 'drums',
        channel: 9,
        instrument: { type: 'builtin', id: 'drums.kit' },
        volume: 0.45,
        notes: drums,
      },
    ],
  };
}

const deterministicEnvironment = {
  VAMP_PROJECT_ROOT: '',
  VAMP_FLUIDSYNTH_PATH: MISSING_BINARY,
  VAMP_SOUNDFONT_PATH: MISSING_SOUNDFONT,
  VAMP_TEST_SECRET: SECRET_VALUE,
} as const;

interface Session {
  readonly client: Client;
  readonly transport: StdioClientTransport;
  readonly stderr: () => string;
  readonly close: () => Promise<void>;
}

async function connectSession(
  args: readonly string[],
  environment: Readonly<Record<string, string>> = deterministicEnvironment,
): Promise<Session> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry, ...args],
    cwd: tempDirectory('vamp-render-cwd-'),
    env: { ...environment },
    stderr: 'pipe',
  });
  const chunks: Buffer[] = [];
  transport.stderr?.on('data', (chunk: Buffer | string) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  const client = new Client({ name: 'vamp-render-test-client', version: '1.0.0' });
  await client.connect(transport);
  return {
    client,
    transport,
    stderr: () => Buffer.concat(chunks).toString('utf8'),
    close: async () => {
      await client.close();
    },
  };
}

async function callTool(
  session: Session,
  name: string,
  args: Record<string, unknown> = {},
): Promise<CallToolResult> {
  return (await session.client.callTool({ name, arguments: args })) as CallToolResult;
}

function structuredContent(result: CallToolResult): Record<string, unknown> {
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toBeDefined();
  return result.structuredContent as Record<string, unknown>;
}

function textContent(result: CallToolResult, index = 0): string {
  const item = result.content[index];
  if (item === undefined || item.type !== 'text') {
    throw new Error('expected text content');
  }
  return item.text;
}

function structuredError(result: CallToolResult): Record<string, unknown> {
  expect(result.isError).toBe(true);
  // Tool errors never occupy structuredContent, because a conforming client
  // validates structuredContent against outputSchema even on isError results.
  expect(result.structuredContent).toBeUndefined();
  const jsonItem = result.content.find(
    (item) => item.type === 'text' && item.text.trimStart().startsWith('{'),
  );
  if (jsonItem === undefined || jsonItem.type !== 'text') {
    throw new Error('expected JSON error text content');
  }
  const parsed = JSON.parse(jsonItem.text) as Record<string, unknown>;
  const error = parsed['error'];
  expect(typeof error).toBe('object');
  return error as Record<string, unknown>;
}

interface ParsedWav {
  readonly channels: number;
  readonly sampleRate: number;
  readonly bitDepth: number;
  readonly frames: number;
  readonly dataBytes: number;
  readonly leftRms: number;
  readonly rightRms: number;
}

/** Parse one 16-bit PCM WAV independently of the engine's own reader. */
function parseWav(file: string): ParsedWav {
  const bytes = readFileSync(file);
  expect(bytes.subarray(0, 4).toString('ascii')).toBe('RIFF');
  expect(bytes.subarray(8, 12).toString('ascii')).toBe('WAVE');
  let offset = 12;
  let channels = 0;
  let sampleRate = 0;
  let bitDepth = 0;
  let blockAlign = 0;
  let data: Buffer | null = null;
  while (offset + 8 <= bytes.length) {
    const id = bytes.subarray(offset, offset + 4).toString('ascii');
    const size = bytes.readUInt32LE(offset + 4);
    const body = bytes.subarray(offset + 8, offset + 8 + size);
    if (id === 'fmt ') {
      channels = body.readUInt16LE(2);
      sampleRate = body.readUInt32LE(4);
      blockAlign = body.readUInt16LE(12);
      bitDepth = body.readUInt16LE(14);
    } else if (id === 'data') {
      data = Buffer.from(body);
    }
    offset += 8 + size + (size % 2);
  }
  expect(channels).toBe(2);
  expect(bitDepth).toBe(16);
  expect(data).not.toBeNull();
  const samples = data as Buffer;
  expect(samples.length % blockAlign).toBe(0);
  let leftSum = 0;
  let rightSum = 0;
  const frames = samples.length / blockAlign;
  for (let frame = 0; frame < frames; frame += 1) {
    const left = samples.readInt16LE(frame * blockAlign) / 32768;
    const right = samples.readInt16LE(frame * blockAlign + 2) / 32768;
    leftSum += left * left;
    rightSum += right * right;
  }
  return {
    channels,
    sampleRate,
    bitDepth,
    frames,
    dataBytes: samples.length,
    leftRms: Math.sqrt(leftSum / Math.max(frames, 1)),
    rightRms: Math.sqrt(rightSum / Math.max(frames, 1)),
  };
}

/** Parse the Standard MIDI header and track chunk count independently. */
function parseMidi(file: string): {
  readonly format: number;
  readonly tracks: number;
  readonly division: number;
} {
  const bytes = readFileSync(file);
  // Standard MIDI files are big-endian, unlike the little-endian RIFF container.
  expect(bytes.subarray(0, 4).toString('ascii')).toBe('MThd');
  expect(bytes.readUInt32BE(4)).toBe(6);
  const format = bytes.readUInt16BE(8);
  const trackCount = bytes.readUInt16BE(10);
  const division = bytes.readUInt16BE(12);
  let offset = 14;
  let seenTracks = 0;
  while (offset + 8 <= bytes.length) {
    const id = bytes.subarray(offset, offset + 4).toString('ascii');
    const length = bytes.readUInt32BE(offset + 4);
    if (id === 'MTrk') {
      seenTracks += 1;
    }
    offset += 8 + length;
  }
  expect(seenTracks).toBe(trackCount);
  return { format, tracks: trackCount, division };
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

interface RenderFacts {
  readonly outputDirectory: string;
  readonly artifacts: Record<string, unknown>[];
  readonly files: string[];
  readonly report: Record<string, unknown>;
}

function renderFacts(result: CallToolResult): RenderFacts {
  const data = structuredContent(result);
  const artifacts = data['artifacts'] as Record<string, unknown>[];
  const outputDirectory = data['outputDirectory'] as string;
  const reportFile = data['reportFile'] as Record<string, unknown> | null;
  const files = artifacts.map((artifact) => artifact['absolutePath'] as string);
  if (reportFile !== null) {
    files.push(reportFile['absolutePath'] as string);
  }
  return {
    outputDirectory,
    artifacts,
    files,
    report: data['report'] as Record<string, unknown>,
  };
}

describe('render_song over real stdio: the agent repair and re-render loop', () => {
  it('discovers, authors, validates, saves, renders, inspects the report, edits, and re-renders', async () => {
    const root = tempDirectory('vamp-render-loop-');
    const session = await connectSession(['--project-root', root], {
      ...deterministicEnvironment,
      VAMP_PROJECT_ROOT: join(root, 'ignored-environment-root'),
    });
    try {
      // 1. Discovery.
      const health = await callTool(session, 'health_check');
      expect(structuredContent(health)['builtInRendering']).toMatchObject({
        status: 'usable',
        backendId: 'builtin-synth-v1',
      });
      const guide = await callTool(session, 'get_schema_guide');
      expect(textContent(guide)).toContain('Complete render output workflow');
      const instruments = await callTool(session, 'list_instruments');
      const ids = (structuredContent(instruments)['instruments'] as Record<string, unknown>[]).map(
        (entry) => entry['id'],
      );
      for (const id of ['keys.soft', 'bass.sub', 'pad.warm', 'drums.kit']) {
        expect(ids).toContain(id);
      }

      // 2. Hand-authored 45-second 90-BPM fixture, validated before saving.
      const song = tutorialBgm();
      const draft = await callTool(session, 'validate_song', { song });
      expect(structuredContent(draft)).toMatchObject({ valid: true, errorCount: 0 });

      // 3. Save it.
      const created = await callTool(session, 'create_song', {
        projectId: 'tutorial-bgm',
        song,
      });
      const project = structuredContent(created)['project'] as Record<string, unknown>;
      expect(project['revision']).toBe(1);

      // 4. Render the saved revision.
      const firstRender = await callTool(session, 'render_song', {
        projectId: 'tutorial-bgm',
        expectedRevision: 1,
      });
      const first = renderFacts(firstRender);
      expect(structuredContent(firstRender)).toMatchObject({
        schemaVersion: '1.0.0',
        projectId: 'tutorial-bgm',
        revision: 1,
        renderName: 'render-1',
        renderPath: 'renders/render-1',
        backend: 'builtin',
        sampleRate: 48_000,
      });
      expect(first.outputDirectory).toBe(join(root, 'tutorial-bgm', 'renders', 'render-1'));
      expect(first.artifacts.map((artifact) => artifact['role'])).toEqual([
        'master',
        'stem',
        'stem',
        'stem',
        'stem',
        'midi',
      ]);

      // 5. Every artifact exists and is independently parseable.
      for (const file of first.files) {
        expect(existsSync(file), file).toBe(true);
      }
      const listed = readdirSync(first.outputDirectory).sort();
      expect(listed).toEqual([
        'master.wav',
        'report.json',
        'song.mid',
        'stem-01-keys.wav',
        'stem-02-bass.wav',
        'stem-03-pad.wav',
        'stem-04-drums.wav',
      ]);
      const master = parseWav(join(first.outputDirectory, 'master.wav'));
      const duration = first.report['duration'] as Record<string, unknown>;
      expect(master.sampleRate).toBe(48_000);
      expect(duration['actualSeconds']).toBeCloseTo(45, 1);
      expect(master.frames).toBe(duration['actualFrames']);
      const midi = parseMidi(join(first.outputDirectory, 'song.mid'));
      expect(midi.format).toBe(1);
      expect(midi.division).toBe(960);
      expect(midi.tracks).toBe(5);
      const reportOnDisk = JSON.parse(
        readFileSync(join(first.outputDirectory, 'report.json'), 'utf8'),
      ) as Record<string, unknown>;
      expect(reportOnDisk['format']).toBe('vamp.render-report');
      expect(reportOnDisk['title']).toBe('Tutorial BGM');
      const backend = reportOnDisk['backend'] as Record<string, unknown>;
      expect(backend['id']).toBe('builtin-synth-v1');
      // The report file is not listed in its own artifact array, and hashes match.
      for (const artifact of first.artifacts) {
        expect(sha256(artifact['absolutePath'] as string)).toBe(artifact['sha256']);
      }
      const firstHashes = first.files.map((file) => sha256(file));
      const audio = first.report['audio'] as Record<string, unknown>;
      const clipping = audio['clipping'] as Record<string, unknown>;
      expect(clipping['clipped']).toBe(false);
      expect(audio['peakDbfs']).toBeLessThan(0);
      expect(textContent(firstRender)).toContain('Artifacts:');

      // 6. Determinism: the same revision rendered again hashes identically.
      const repeat = await callTool(session, 'render_song', {
        projectId: 'tutorial-bgm',
        renderName: 'render-1-copy',
      });
      const repeatFacts = renderFacts(repeat);
      expect(sha256(join(repeatFacts.outputDirectory, 'master.wav'))).toBe(
        sha256(join(first.outputDirectory, 'master.wav')),
      );

      // 7. Re-rendering into the same name refuses to overwrite silently.
      const collision = await callTool(session, 'render_song', {
        projectId: 'tutorial-bgm',
        renderName: 'render-1-copy',
      });
      expect(structuredError(collision)['code']).toBe('audio.artifacts.exists');
      const forced = await callTool(session, 'render_song', {
        projectId: 'tutorial-bgm',
        renderName: 'render-1-copy',
        overwrite: true,
      });
      expect(structuredContent(forced)['revision']).toBe(1);

      // 8. Repair the data against the expected revision: quiet the keys and pan left.
      const edited = await callTool(session, 'update_song', {
        projectId: 'tutorial-bgm',
        expectedRevision: 1,
        song: tutorialBgm({ keysVolume: 0.3, keysPan: -0.8 }),
      });
      const editedRevision = structuredContent(edited)['revision'] as number;
      expect(editedRevision).toBe(2);

      // 9. Re-render the new revision into its own default directory.
      const secondRender = await callTool(session, 'render_song', {
        projectId: 'tutorial-bgm',
        expectedRevision: 2,
      });
      const second = renderFacts(secondRender);
      expect(structuredContent(secondRender)).toMatchObject({
        revision: 2,
        renderName: 'render-2',
        renderPath: 'renders/render-2',
      });

      // 10. The prior render is byte-for-byte intact.
      const untouched = readdirSync(first.outputDirectory).sort();
      expect(untouched).toEqual(listed);
      for (const [index, file] of first.files.entries()) {
        expect(sha256(file)).toBe(firstHashes[index]);
      }

      // 11. The intended audio changed and only that track changed.
      const keysFirst = parseWav(join(first.outputDirectory, 'stem-01-keys.wav'));
      const keysSecond = parseWav(join(second.outputDirectory, 'stem-01-keys.wav'));
      const firstTotal = Math.hypot(keysFirst.leftRms, keysFirst.rightRms);
      const secondTotal = Math.hypot(keysSecond.leftRms, keysSecond.rightRms);
      // Equal-power pan preserves total power, so the total ratio is the gain
      // ratio 0.3 over 0.9, one third.
      const totalRatio = secondTotal / firstTotal;
      expect(totalRatio).toBeGreaterThan(0.3);
      expect(totalRatio).toBeLessThan(0.37);
      // The original stem was centered and the repaired one is hard left.
      expect(keysFirst.leftRms).toBeLessThan(keysFirst.rightRms * 1.1);
      expect(keysFirst.rightRms).toBeLessThan(keysFirst.leftRms * 1.1);
      expect(keysSecond.leftRms).toBeGreaterThan(keysSecond.rightRms * 3);
      for (const name of ['stem-02-bass.wav', 'stem-03-pad.wav', 'stem-04-drums.wav']) {
        expect(sha256(join(second.outputDirectory, name))).toBe(
          sha256(join(first.outputDirectory, name)),
        );
      }
      expect(sha256(join(second.outputDirectory, 'master.wav'))).not.toBe(
        sha256(join(first.outputDirectory, 'master.wav')),
      );
      const secondMaster = parseWav(join(second.outputDirectory, 'master.wav'));
      expect(secondMaster.frames).toBe(master.frames);
      const secondSummary = structuredContent(secondRender)['summary'] as Record<string, unknown>;
      expect(secondSummary['durationSeconds']).toBeCloseTo(45, 1);
    } finally {
      await session.close();
    }
    expect(session.stderr()).toContain('shutting down (stdin closed)');
    expect(session.stderr()).not.toContain(SECRET_VALUE);
  });

  it('surfaces render report data and warnings without failing a good render', async () => {
    const root = tempDirectory('vamp-render-warn-');
    const loud = tutorialBgm({ keysVolume: 2 });
    const session = await connectSession(['--project-root', root]);
    try {
      const created = await callTool(session, 'create_song', {
        projectId: 'loud-bgm',
        song: loud,
      });
      expect(created.isError).not.toBe(true);
      const render = await callTool(session, 'render_song', { projectId: 'loud-bgm' });
      const data = structuredContent(render);
      const warnings = data['warnings'] as Record<string, unknown>;
      const report = data['report'] as Record<string, unknown>;
      const clipping = (report['audio'] as Record<string, unknown>)['clipping'] as Record<
        string,
        unknown
      >;
      const audioWarnings = warnings['audio'] as unknown[];
      if (clipping['clipped'] === true) {
        expect(audioWarnings.length).toBeGreaterThan(0);
        expect(textContent(render)).toContain('warning(s)');
      }
      expect(data['backend']).toBe('builtin');
      expect(report['stemInvariant']).toMatchObject({ stemCount: 4 });
      const loudMaster = parseWav(join(data['outputDirectory'] as string, 'master.wav'));
      expect(loudMaster.frames).toBeGreaterThan(0);
    } finally {
      await session.close();
    }
  });

  it('refuses renders that cannot be honoured with actionable structured errors', async () => {
    const root = tempDirectory('vamp-render-errors-');
    const session = await connectSession(['--project-root', root]);
    try {
      await callTool(session, 'create_song', { projectId: 'keep', song: tutorialBgm() });

      const missing = await callTool(session, 'render_song', { projectId: 'absent' });
      expect(structuredError(missing)['code']).toBe('project.not_found');

      const stale = await callTool(session, 'render_song', {
        projectId: 'keep',
        expectedRevision: 99,
      });
      const staleError = structuredError(stale);
      expect(staleError['code']).toBe('project.revision.conflict');
      expect(staleError['expectedRevision']).toBe(99);
      expect(staleError['actualRevision']).toBe(1);
      expect(existsSync(join(root, 'keep', 'renders', 'render-1'))).toBe(false);

      // A render name that is not a single safe segment never reaches the store.
      const escaping = await callTool(session, 'render_song', {
        projectId: 'keep',
        renderName: '../outside',
      });
      expect(escaping.isError).toBe(true);
      expect(textContent(escaping)).toContain('Input validation error');

      // Symlinks inside renders/ must not escape the project either.
      const outside = tempDirectory('vamp-render-outside-');
      symlinkSync(outside, join(root, 'keep', 'renders', 'escape'));
      const symlinkEscape = await callTool(session, 'render_song', {
        projectId: 'keep',
        renderName: 'escape',
      });
      const escapeCode = structuredError(symlinkEscape)['code'] as string;
      expect(['project.path.confined', 'project.path.invalid']).toContain(escapeCode);

      // Selecting FluidSynth without its configured dependency is actionable.
      const noNative = await callTool(session, 'render_song', {
        projectId: 'keep',
        backend: 'fluidsynth',
        renderName: 'sample-render',
      });
      const nativeError = structuredError(noNative);
      expect(nativeError['code']).toBe('audio.backend.missing_dependency');
      expect(nativeError['hint']).toContain('builtin');
      expect(Array.isArray(nativeError['missingDependencies'])).toBe(true);

      // A song instrument whose asset cannot be resolved surfaces the engine or
      // storage failure instead of rendering silence.
      const assetSong = tutorialBgm();
      const assetTrack = (assetSong['tracks'] as Record<string, unknown>[])[2];
      if (assetTrack !== undefined) {
        assetTrack['instrument'] = {
          type: 'soundfont',
          path: 'assets/missing.sf2',
          program: 42,
        };
      }
      const assetProject = await callTool(session, 'create_song', {
        projectId: 'assetless',
        song: assetSong,
      });
      if (assetProject.isError === true) {
        // Saving the reference itself was refused, which is still actionable.
        expect(String(structuredError(assetProject)['code'])).toMatch(/^(project|audio)\./);
      } else {
        const renderedAssetless = await callTool(session, 'render_song', {
          projectId: 'assetless',
        });
        const assetError = structuredError(renderedAssetless);
        expect(String(assetError['code'])).toMatch(/^(audio|render)\./);
        if (Array.isArray(assetError['issues'])) {
          expect(assetError['stage']).toBeDefined();
        } else {
          expect(Array.isArray(assetError['missingDependencies'])).toBe(true);
        }
      }

      // An invalid saved song behind the store's back is refused, not rendered,
      // and the valid project keeps its revision and files.
      const store = new ProjectStore({ root, validation: INSTRUMENT_REGISTRY_VALIDATION });
      const made = await store.create({ projectId: 'broken', song: tutorialBgm() });
      expect(made.ok).toBe(true);
      writeFileSync(
        join(root, 'broken', 'song.json'),
        JSON.stringify({ schemaVersion: '1.0.0', meta: { title: 'Broken' }, tracks: [] }),
        'utf8',
      );
      const broken = await callTool(session, 'render_song', { projectId: 'broken' });
      const brokenError = structuredError(broken);
      expect(String(brokenError['code']).startsWith('project.song.')).toBe(true);
      expect(existsSync(join(root, 'broken', 'renders', 'render-1'))).toBe(false);

      const stillValid = await callTool(session, 'get_song', { projectId: 'keep' });
      expect(
        (structuredContent(stillValid)['project'] as Record<string, unknown>)['revision'],
      ).toBe(1);

      const badArgs = await callTool(session, 'render_song', {
        projectId: 'keep',
        sampleRate: 96_000,
      });
      expect(badArgs.isError).toBe(true);
      expect(textContent(badArgs)).toContain('Input validation error');
    } finally {
      await session.close();
    }
  });

  it('requires a configured project root and reports it as an actionable error', async () => {
    const session = await connectSession([]);
    try {
      const result = await callTool(session, 'render_song', { projectId: 'anything' });
      const error = structuredError(result);
      expect(error['code']).toBe('mcp.project_root.not_configured');
      expect(error['hint']).toContain('VAMP_PROJECT_ROOT');
      const health = await callTool(session, 'health_check');
      expect(structuredContent(health)['status']).toBe('ok');
    } finally {
      await session.close();
    }
  });

  it.runIf(nativeAvailable)(
    'renders a short fixture through the configured FluidSynth backend',
    async () => {
      const root = tempDirectory('vamp-render-native-');
      const session = await connectSession(
        ['--project-root', root, '--fluidsynth-path', nativeBinary, '--soundfont', nativeSoundFont],
        { ...deterministicEnvironment, VAMP_FLUIDSYNTH_PATH: '', VAMP_SOUNDFONT_PATH: '' },
      );
      try {
        const created = await callTool(session, 'create_song', {
          projectId: 'native-gm',
          song: {
            schemaVersion: '1.0.0',
            meta: {
              title: 'Native Sample Loop',
              bpm: 90,
              timeSignature: { numerator: 4, denominator: 4 },
              key: { tonic: 'C', mode: 'major' },
              seed: 3,
              durationHint: 8,
            },
            tracks: [
              {
                id: 'piano',
                name: 'Piano',
                kind: 'midi',
                channel: 0,
                instrument: { type: 'builtin', id: 'piano.soft' },
                notes: [
                  { pitch: 60, start: 0, duration: 2 },
                  { pitch: 64, start: 2, duration: 2 },
                  { pitch: 67, start: 4, duration: 2 },
                  { pitch: 72, start: 6, duration: 1.5 },
                ],
              },
              {
                id: 'bass',
                name: 'Bass',
                kind: 'midi',
                channel: 1,
                instrument: { type: 'builtin', id: 'bass.sub' },
                notes: [{ pitch: 48, start: 0, duration: 7 }],
              },
            ],
          },
        });
        expect(created.isError).not.toBe(true);
        const rendered = await callTool(session, 'render_song', {
          projectId: 'native-gm',
          backend: 'fluidsynth',
        });
        const data = structuredContent(rendered);
        expect(data['backend']).toBe('fluidsynth');
        const report = data['report'] as Record<string, unknown>;
        expect((report['backend'] as Record<string, unknown>)['id']).toBe('fluidsynth-sf2-v1');
        const facts = renderFacts(rendered);
        for (const file of facts.files) {
          expect(existsSync(file), file).toBe(true);
        }
        parseWav(join(facts.outputDirectory, 'master.wav'));
      } finally {
        await session.close();
      }
    },
  );
});

interface RawServer {
  readonly child: ChildProcessWithoutNullStreams;
  readonly lines: string[];
  readonly request: (
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ) => Promise<Record<string, unknown>>;
  readonly notify: (method: string) => void;
  readonly stderr: () => string;
  readonly waitForExit: () => Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  readonly stop: () => void;
}

function spawnRaw(
  args: readonly string[],
  environment: Readonly<Record<string, string>>,
): RawServer {
  const child = spawn(process.execPath, [serverEntry, ...args], {
    cwd: tempDirectory('vamp-render-raw-'),
    env: { ...environment },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines: string[] = [];
  const pending = new Map<number, (message: Record<string, unknown>) => void>();
  const stderrChunks: Buffer[] = [];
  child.stderr.on('data', (chunk: Buffer | string) => {
    stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
  reader.on('line', (line) => {
    lines.push(line);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (typeof parsed['id'] === 'number') {
      const resolve = pending.get(parsed['id']);
      if (resolve !== undefined) {
        pending.delete(parsed['id']);
        resolve(parsed);
      }
    }
  });

  let nextId = 1;
  const request = (
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = 30_000,
  ): Promise<Record<string, unknown>> => {
    const id = nextId;
    nextId += 1;
    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timed out waiting for ${method}`));
      }, timeoutMs);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return response;
  };

  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
    },
  );

  return {
    child,
    lines,
    request,
    notify: (method) => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
    },
    stderr: () => Buffer.concat(stderrChunks).toString('utf8'),
    waitForExit: () => exitPromise,
    stop: () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    },
  };
}

describe('render_song lifecycle over stdio: shutdown aborts an active render', () => {
  // Windows cannot deliver a graceful SIGTERM to a spawned child (kill()
  // terminates the process outright), so the abort-and-clean-exit path this
  // test exercises exists only on POSIX platforms.
  it.skipIf(process.platform === 'win32')(
    'aborts the in-flight render, keeps stdout protocol-only, and exits cleanly',
    async () => {
      const root = tempDirectory('vamp-render-shutdown-');
      // A ten-minute render at 48 kHz cannot finish before the signal arrives.
      const longSong = tutorialBgm();
      (longSong['meta'] as Record<string, unknown>)['durationHint'] = 900;
      const store = new ProjectStore({ root, validation: INSTRUMENT_REGISTRY_VALIDATION });
      const created = await store.create({ projectId: 'long-bgm', song: longSong });
      expect(created.ok).toBe(true);

      const server = spawnRaw(['--project-root', root], deterministicEnvironment);
      try {
        await server.request('initialize', {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'vamp-render-raw', version: '1.0.0' },
        });
        server.notify('notifications/initialized');

        const render = server.request('tools/call', {
          name: 'render_song',
          arguments: { projectId: 'long-bgm', renderName: 'interrupted' },
        });
        // Give the render time to start writing into its job directory.
        await new Promise((resolve) => setTimeout(resolve, 750));
        const renderDirectory = join(root, 'long-bgm', 'renders', 'interrupted');
        server.child.kill('SIGTERM');

        const exit = await server.waitForExit();
        expect(exit).toEqual({ code: 0, signal: null });

        // The aborted render either reported its cancellation before the server
        // closed or lost its response when the process exited; both are clean.
        let reported: Record<string, unknown> | null = null;
        try {
          const message = await render;
          reported = (message['result'] ?? null) as Record<string, unknown> | null;
        } catch {
          reported = null;
        }
        if (reported !== null) {
          expect(reported['isError']).toBe(true);
          expect(reported['structuredContent']).toBeUndefined();
          const content = reported['content'] as { type: string; text: string }[];
          const payload = content
            .filter((item) => item.type === 'text' && item.text.trimStart().startsWith('{'))
            .map((item) => JSON.parse(item.text) as Record<string, unknown>);
          expect(payload[0]).toMatchObject({ error: { code: 'render.cancelled' } });
        }

        const stderr = server.stderr();
        expect(stderr).toContain('shutting down (SIGTERM)');
        expect(stderr).toContain('aborting');
        expect(stderr).not.toContain(SECRET_VALUE);

        // No published artifacts: the atomic publisher never ran, and the render
        // directory holds at most the private job directory the engine cleans up.
        const published = existsSync(renderDirectory) ? readdirSync(renderDirectory) : [];
        expect(published.filter((name) => !name.startsWith('.vamp-render-'))).toEqual([]);

        // Stdout stayed protocol-only for the whole session.
        expect(server.lines.length).toBeGreaterThan(0);
        for (const line of server.lines) {
          const message = JSON.parse(line) as Record<string, unknown>;
          expect(message['jsonrpc']).toBe('2.0');
          expect(typeof message['id'] === 'number' || typeof message['method'] === 'string').toBe(
            true,
          );
        }
        expect(server.lines.join('\n')).not.toContain('vamp-mcp:');

        // The stored project survived the aborted render untouched.
        const reread = await store.get('long-bgm');
        expect(reread.ok).toBe(true);
        if (reread.ok) {
          expect(reread.value.revision).toBe(1);
        }
      } finally {
        server.stop();
      }
    },
  );
});

describe('MCP preset authoring and sampled render', () => {
  it.runIf(nativeAvailable)(
    'creates a preset cue and renders it through auto FluidSynth',
    async () => {
      const root = tempDirectory('vamp-render-preset-root-');
      const session = await connectSession(['--project-root', root], {
        VAMP_FLUIDSYNTH_PATH: nativeBinary,
        VAMP_SOUNDFONT_PATH: nativeSoundFont,
      });
      try {
        const created = await callTool(session, 'create_song', {
          projectId: 'lofi-preset',
          preset: 'lofi',
          durationSeconds: 8,
          bpm: 90,
          title: 'MCP Lo-fi',
        });
        expect(created.isError).not.toBe(true);
        const createdData = structuredContent(created);
        const project = createdData.project as {
          song: {
            meta: { title: string; bpm: number; durationHint: number };
            tracks: Array<{ id: string }>;
          };
        };
        expect(project.song.meta).toMatchObject({ title: 'MCP Lo-fi', bpm: 90, durationHint: 12 });
        expect(project.song.tracks.map((track) => track.id)).toEqual([
          'chords',
          'pad',
          'bass',
          'melody',
          'drums',
        ]);

        const rendered = await callTool(session, 'render_song', {
          projectId: 'lofi-preset',
          sampleRate: 48_000,
        });
        expect(rendered.isError).not.toBe(true);
        const output = structuredContent(rendered);
        expect(output.backendSelection).toMatchObject({
          requested: 'auto',
          selected: 'fluidsynth',
        });
        const report = output.report as {
          audio: { peakDbfs: number; mastering: { applied: boolean; targetDbfs: number } };
          duration: { actualSeconds: number };
          stems: unknown[];
        };
        expect(report.duration.actualSeconds).toBeCloseTo(8, 2);
        expect(report.audio.mastering).toMatchObject({ applied: true, targetDbfs: -1 });
        expect(report.audio.peakDbfs).toBeLessThanOrEqual(-1);
        expect(report.audio.peakDbfs).toBeGreaterThan(-12);
        expect(report.stems.length).toBe(5);
        const artifacts = output.artifacts as Array<{ absolutePath: string }>;
        for (const artifact of artifacts) {
          expect(existsSync(artifact.absolutePath)).toBe(true);
        }
      } finally {
        await session.close();
      }
    },
  );
});

describe('MCP clear sample dependency errors', () => {
  it('rejects a GM preset render when auto can only use the builtin fallback', async () => {
    const root = tempDirectory('vamp-render-missing-sample-root-');
    const session = await connectSession(['--project-root', root], {
      VAMP_FLUIDSYNTH_PATH: MISSING_BINARY,
      VAMP_SOUNDFONT_PATH: MISSING_SOUNDFONT,
    });
    try {
      const created = await callTool(session, 'create_song', {
        projectId: 'gm-no-sample',
        preset: 'lofi',
        durationSeconds: 4,
      });
      expect(created.isError).not.toBe(true);
      const rendered = await callTool(session, 'render_song', {
        projectId: 'gm-no-sample',
      });
      expect(rendered.isError).toBe(true);
      const human = textContent(rendered, 0);
      expect(human).toContain('audio.backend.missing_dependency');
      expect(human).toContain('GM SoundFont');
      const payload = JSON.parse(textContent(rendered, 1)) as {
        error: { code: string; hint: string; missingDependencies: string[] };
      };
      expect(payload.error.code).toBe('audio.backend.missing_dependency');
      expect(payload.error.missingDependencies).toEqual(['executable', 'soundfont']);
      expect(payload.error.hint).toContain('FluidSynth');
    } finally {
      await session.close();
    }
  });
});
