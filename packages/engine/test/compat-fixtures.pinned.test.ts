/**
 * Task 22 compatibility freeze suite (pinned layer).
 *
 * Recomputes the representative v1 compatibility fixtures frozen by
 * `pnpm compat:freeze` into `fixtures/compat/compat-baseline.json` and
 * asserts they are byte- and value-identical on this engine build:
 *
 * - schema/API: file bytes, validation outcome, and the normalized song
 *   document for the seven schema fixtures, the five example cues, and the
 *   exit-rehearsal tutorial BGM;
 * - MIDI: the canonical 48 kHz timeline and the exported Type 1 bytes;
 * - audio: the built-in WAV at 48 kHz (plus 44.1 kHz for the tutorial BGM)
 *   for the all-builtin songs.
 *
 * The baseline is the data set a future schema version must replay through
 * its migration and re-derive. Like the Task 18 goldens, this suite runs under
 * `pnpm test:native` and the default `pnpm test`, and is excluded from
 * `pnpm test:fast`; built-in byte identity is scoped to one engine build on
 * one platform, and the optional FluidSynth note entry is same-machine only.
 * Regenerate deliberately with `pnpm compat:freeze`, never to silence a
 * mismatch on an unmodified engine.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { estimateRenderedDuration, validateSong } from '@gxaditya/vamp-schema';

import {
  INSTRUMENT_REGISTRY_VALIDATION,
  compileSong,
  createFluidSynthBackend,
  describeInstrumentRegistry,
  encodeWav,
  exportMidi,
  renderSongAudio,
} from '../src/index.js';

const testDir = dirname(fileURLToPath(import.meta.url));

// Each song test performs up to three built-in renders plus one bounded
// FluidSynth child process, so the per-test floor is raised the same way as
// the MCP render suite (vi.setConfig). Concurrency settings are untouched.
vi.setConfig({ testTimeout: 120_000 });
const repoRoot = resolve(testDir, '..', '..', '..');
const baselinePath = join(testDir, 'fixtures', 'compat', 'compat-baseline.json');

const FLUID_BINARY = process.env.VAMP_FLUIDSYNTH_PATH ?? '/usr/bin/fluidsynth';
const FLUID_SOUNDFONT = process.env.VAMP_SOUNDFONT_PATH ?? '/usr/share/sounds/sf2/FluidR3_GM.sf2';
const NATIVE_AVAILABLE = existsSync(FLUID_BINARY) && existsSync(FLUID_SOUNDFONT);

// The FluidSynth note digest is byte-exact only on the machine that froze it
// (identical FluidSynth build and floating-point path). CI provisions a
// different build per OS, so there the note is compared without its digest;
// the frame-count byte length and scope still hold on every machine. Set
// VAMP_ENFORCE_SAME_MACHINE_PINS=1 to force the digest check anywhere.
const ENFORCE_SAME_MACHINE_PIN =
  process.env.VAMP_ENFORCE_SAME_MACHINE_PINS === '1' || process.env.CI === undefined;

interface Digest {
  readonly sha256: string;
  readonly bytes: number;
}

interface SongEntry {
  source: string;
  song: Digest;
  validation: {
    schemaVersion: string;
    warningCount: number;
    capabilityCheck: string;
  };
  normalized: Digest;
  duration: Record<string, unknown>;
  timeline48000: Digest;
  midi: Digest;
  audioBuiltin48000: Digest | 'not-frozen';
  audioBuiltin44100?: Digest;
  noteNativeFluidSynth48000?: Digest & { scope: string };
}

interface Baseline {
  readonly format: string;
  readonly formatVersion: number;
  readonly frozenSchemaVersion: string;
  readonly api: Record<string, Digest | Record<string, Digest>>;
  readonly songs: readonly SongEntry[];
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const jsonBytes = (value: unknown): Buffer => Buffer.from(JSON.stringify(value, null, 2), 'utf8');

function baseline(): Baseline {
  const parsed = JSON.parse(readFileSync(baselinePath, 'utf8')) as Baseline;
  expect(parsed.format).toBe('vamp.compat-baseline');
  expect(parsed.formatVersion).toBe(1);
  expect(parsed.frozenSchemaVersion).toBe('1.0.0');
  return parsed;
}

async function recompute(entry: SongEntry): Promise<SongEntry> {
  const bytes = readFileSync(join(repoRoot, entry.source));
  const song = JSON.parse(bytes.toString('utf8'));
  const validation = validateSong(song, INSTRUMENT_REGISTRY_VALIDATION);
  if (!validation.ok) {
    throw new Error(`${entry.source}: compatibility song no longer validates`);
  }
  const compiled = compileSong(song, { sampleRate: 48000 });
  if (!compiled.ok) {
    throw new Error(`${entry.source}: compatibility song no longer compiles`);
  }
  const midi = exportMidi(compiled.timeline);
  if (!midi.ok) {
    throw new Error(`${entry.source}: compatibility MIDI export failed`);
  }
  const normalizedBytes = jsonBytes(validation.normalized);
  const allBuiltin = song.tracks.every(
    (track: { instrument: { type: string } }) => track.instrument.type === 'builtin',
  );
  const rendered: SongEntry = {
    source: entry.source,
    song: { sha256: sha256(bytes), bytes: bytes.byteLength },
    validation: {
      schemaVersion: validation.schemaVersion,
      warningCount: validation.warnings.length,
      capabilityCheck: validation.capabilityCheck,
    },
    normalized: { sha256: sha256(normalizedBytes), bytes: normalizedBytes.byteLength },
    duration: estimateRenderedDuration(song) as unknown as Record<string, unknown>,
    timeline48000: (() => {
      const timelineBytes = jsonBytes(compiled.timeline);
      return { sha256: sha256(timelineBytes), bytes: timelineBytes.byteLength };
    })(),
    midi: { sha256: sha256(midi.bytes), bytes: midi.bytes.byteLength },
    audioBuiltin48000: allBuiltin ? await builtinWavDigest(song, 48000) : ('not-frozen' as const),
  };
  if (entry.audioBuiltin44100 !== undefined) {
    rendered.audioBuiltin44100 = await builtinWavDigest(song, 44100);
  }
  if (entry.noteNativeFluidSynth48000 !== undefined && NATIVE_AVAILABLE) {
    const backend = createFluidSynthBackend({
      binaryPath: FLUID_BINARY,
      gmSoundFont: FLUID_SOUNDFONT,
      verifyGmSoundFontChecksum: true,
    });
    const native = await renderSongAudio(song, { sampleRate: 48000, backend });
    if (!native.ok) {
      throw new Error(`${entry.source}: native re-render failed`);
    }
    const encoded = encodeWav(native.audio);
    if (!encoded.ok) {
      throw new Error(`${entry.source}: native encode failed`);
    }
    rendered.noteNativeFluidSynth48000 = {
      sha256: sha256(encoded.bytes),
      bytes: encoded.bytes.byteLength,
      scope: 'same-machine-only',
    };
  }
  return rendered;
}

async function builtinWavDigest(
  song: Parameters<typeof renderSongAudio>[0],
  sampleRate: 48000 | 44100,
): Promise<Digest> {
  const rendered = await renderSongAudio(song, { sampleRate });
  if (!rendered.ok) {
    throw new Error(`built-in render failed at ${sampleRate}`);
  }
  const encoded = encodeWav(rendered.audio);
  if (!encoded.ok) {
    throw new Error(`built-in encode failed at ${sampleRate}`);
  }
  return { sha256: sha256(encoded.bytes), bytes: encoded.bytes.byteLength };
}

describe('v1 compatibility freeze (schema/API/MIDI/audio)', () => {
  const frozen = baseline();

  it('freezes the canonical schema, generated types, and instrument registry', () => {
    const read = (path: string): Digest => {
      const bytes = readFileSync(join(repoRoot, path));
      return { sha256: sha256(bytes), bytes: bytes.byteLength };
    };
    expect(frozen.api['song.schema.json']).toEqual(read('packages/schema/schema/song.schema.json'));
    expect(frozen.api['generated.song-v1.ts']).toEqual(
      read('packages/schema/src/generated/song-v1.ts'),
    );
    const pythonDir = join(repoRoot, 'packages/schema/python/vamp_schema');
    const python: Record<string, Digest> = {};
    for (const name of readdirSync(pythonDir)
      .filter((entry) => entry.endsWith('.py'))
      .sort()) {
      const bytes = readFileSync(join(pythonDir, name));
      python[name] = { sha256: sha256(bytes), bytes: bytes.byteLength };
    }
    expect(frozen.api['python.vamp_schema']).toEqual(python);
    const registryBytes = jsonBytes(describeInstrumentRegistry());
    expect(frozen.api['instrument-registry.json']).toEqual({
      sha256: sha256(registryBytes),
      bytes: registryBytes.byteLength,
    });
  });

  for (const entry of frozen.songs) {
    it(`reproduces the frozen v1 pipeline output for ${entry.source}`, async () => {
      const recomputed = await recompute(entry);
      const frozenNote = entry.noteNativeFluidSynth48000;
      if (frozenNote === undefined || ENFORCE_SAME_MACHINE_PIN) {
        expect(recomputed).toEqual(entry);
        return;
      }
      // Off the pinning machine the FluidSynth note still renders but its WAV
      // digest differs by build; compare everything else exactly, then the
      // note's deterministic fields (scope and byte length).
      expect(recomputed.noteNativeFluidSynth48000).toMatchObject({
        scope: frozenNote.scope,
        bytes: frozenNote.bytes,
      });
      const recomputedRest: SongEntry = { ...recomputed };
      const expectedRest: SongEntry = { ...entry };
      delete recomputedRest.noteNativeFluidSynth48000;
      delete expectedRest.noteNativeFluidSynth48000;
      expect(recomputedRest).toEqual(expectedRest);
    });
  }

  it('covers the documented compatibility surface', () => {
    const sources = frozen.songs.map((entry) => entry.source);
    expect(sources.filter((s) => s.startsWith('packages/schema/fixtures/valid/'))).toHaveLength(7);
    expect(sources.filter((s) => s.startsWith('examples/songs/'))).toHaveLength(5);
    expect(sources).toContain('packages/engine/test/fixtures/compat/tutorial-45s-90bpm.song.json');
    expect(sources.filter((s) => s.startsWith('packages/schema/fixtures/invalid/'))).toHaveLength(
      0,
    );
    expect(frozen.songs.some((entry) => entry.audioBuiltin44100 !== undefined)).toBe(true);
  });

  it('keeps the tutorial BGM at exactly 45 s on both sample rates', () => {
    const tutorial = frozen.songs.find(
      (entry) =>
        entry.source === 'packages/engine/test/fixtures/compat/tutorial-45s-90bpm.song.json',
    );
    expect(tutorial).toBeDefined();
    expect((tutorial?.duration as { renderedSeconds: number }).renderedSeconds).toBe(45);
    expect(tutorial?.audioBuiltin44100).toBeDefined();
  });
});
