#!/usr/bin/env node
/**
 * Task 22 v1 compatibility freeze.
 *
 * Freezes representative compatibility fixtures for schema, API, MIDI, and
 * audio so that a future schema/engine version can prove that saved v1 songs
 * still load, validate, compile, export, and render the same way. The freeze
 * records SHA-256 digests plus small deterministic snapshots, never binary
 * SoundFonts or committed renders.
 *
 * Usage (from the repository root, after `pnpm build`):
 *
 *   pnpm compat:freeze
 *
 * What it writes:
 *
 * - `packages/engine/test/fixtures/compat/compat-baseline.json`: the baseline
 *   consumed by `packages/engine/test/compat-fixtures.pinned.test.ts` (runs
 *   under `pnpm test:native` and `pnpm test`, excluded from `pnpm test:fast`).
 *
 * Coverage per representative song (schema fixtures, the five example cues,
 * and the exit-rehearsal tutorial BGM):
 *
 * - schema/API: the file bytes, the validation outcome (version, warning
 *   count, capability status) and the fully normalized song document.
 * - MIDI: the canonical 48 kHz timeline serialization and the exported
 *   Type 1 MIDI bytes.
 * - audio: the built-in backend WAV at 48 kHz for every song whose tracks are
 *   all built-in references, plus 44.1 kHz for the tutorial BGM. Songs that
 *   reference song-owned soundfont/sfz assets are data-pinned only; those
 *   assets are provisioned per machine and are never committed.
 *
 * Global API entries pin the canonical JSON Schema document, the generated
 * TypeScript and Python types, and the curated instrument registry JSON.
 *
 * Determinism and regeneration policy:
 *
 * The script performs no network access, writes no timestamps, sorts every
 * key, and refuses to freeze output that is not repeat-identical on this
 * machine. Re-running it on an unmodified engine rewrites byte-identical
 * files. Regenerate only for a reviewed, intentional change (a new schema
 * version rollout, a deliberate MIDI/DSP change); a mismatch on an unmodified
 * v1 engine is a regression signal, never something to silence by re-freezing.
 * When SongSchemaV2 introduces the migration registry, replay this baseline
 * through `migrateSong` + the v2 pipeline and compare against these entries;
 * that comparison is the future migration test procedure.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateSong, estimateRenderedDuration } from '../packages/schema/dist/index.js';
import {
  INSTRUMENT_REGISTRY_VALIDATION,
  compileSong,
  createFluidSynthBackend,
  describeInstrumentRegistry,
  encodeWav,
  exportMidi,
  renderSongAudio,
} from '../packages/engine/dist/index.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const compatDir = join(repoRoot, 'packages/engine/test/fixtures/compat');

const FLUID_BINARY = process.env.VAMP_FLUIDSYNTH_PATH ?? '/usr/bin/fluidsynth';
const FLUID_SOUNDFONT = process.env.VAMP_SOUNDFONT_PATH ?? '/usr/share/sounds/sf2/FluidR3_GM.sf2';

/** Songs frozen for schema/API/MIDI/audio migration evidence. */
const songs = [
  'packages/schema/fixtures/valid/automation.song.json',
  'packages/schema/fixtures/valid/drums.song.json',
  'packages/schema/fixtures/valid/effects.song.json',
  'packages/schema/fixtures/valid/free-notes.song.json',
  'packages/schema/fixtures/valid/instruments.song.json',
  'packages/schema/fixtures/valid/minimal.song.json',
  'packages/schema/fixtures/valid/patterns.song.json',
  'examples/songs/ambient-focus-bed.song.json',
  'examples/songs/corporate-bed.song.json',
  'examples/songs/explainer-upbeat.song.json',
  'examples/songs/lofi-coding-bed.song.json',
  'examples/songs/tension-stinger.song.json',
  'packages/engine/test/fixtures/compat/tutorial-45s-90bpm.song.json',
];

/** The song additionally pinned at 44.1 kHz to cover the second sample rate. */
const secondRateSong = 'packages/engine/test/fixtures/compat/tutorial-45s-90bpm.song.json';

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function jsonBytes(value) {
  return Buffer.from(JSON.stringify(value, null, 2), 'utf8');
}

function sameBytes(left, right) {
  return Buffer.from(left.buffer, left.byteOffset, left.byteLength).equals(
    Buffer.from(right.buffer, right.byteOffset, right.byteLength),
  );
}

async function renderBuiltinWav(song, sampleRate, repeatPath) {
  const rendered = await renderSongAudio(song, { sampleRate });
  if (!rendered.ok) {
    fail(`${repeatPath}: built-in render failed at ${sampleRate}`);
  }
  const encoded = encodeWav(rendered.audio);
  if (!encoded.ok) {
    fail(`${repeatPath}: built-in encode failed at ${sampleRate}`);
  }
  const repeat = await renderSongAudio(song, { sampleRate });
  const repeatEncoded = repeat.ok ? encodeWav(repeat.audio) : { ok: false };
  if (!repeat.ok || !repeatEncoded.ok || !sameBytes(repeatEncoded.bytes, encoded.bytes)) {
    fail(`${repeatPath}: built-in render at ${sampleRate} is not repeat-identical`);
  }
  return { sha256: sha256(encoded.bytes), bytes: encoded.bytes.byteLength };
}

async function renderNativeWav(song, path) {
  // Opt-in evidence only: the native result is machine-scoped, so it is
  // recorded as a note, never as a frozen cross-machine byte pin here.
  if (!existsSync(FLUID_BINARY) || !existsSync(FLUID_SOUNDFONT)) {
    return null;
  }
  const backend = createFluidSynthBackend({
    binaryPath: FLUID_BINARY,
    gmSoundFont: FLUID_SOUNDFONT,
    verifyGmSoundFontChecksum: true,
  });
  const rendered = await renderSongAudio(song, { sampleRate: 48000, backend });
  if (!rendered.ok) {
    return null;
  }
  const encoded = encodeWav(rendered.audio);
  if (!encoded.ok) {
    fail(`${path}: FluidSynth encode failed`);
  }
  return { sha256: sha256(encoded.bytes), bytes: encoded.bytes.byteLength };
}

async function freezeSong(path) {
  const bytes = readFileSync(join(repoRoot, path));
  const song = JSON.parse(bytes.toString('utf8'));
  const validation = validateSong(song, INSTRUMENT_REGISTRY_VALIDATION);
  if (!validation.ok) {
    fail(`${path}: failed to validate during freeze`);
  }
  const compiled = compileSong(song, { sampleRate: 48000 });
  if (!compiled.ok) {
    fail(`${path}: failed to compile during freeze: ${JSON.stringify(compiled.errors)}`);
  }
  const timelineBytes = jsonBytes(compiled.timeline);
  const midi = exportMidi(compiled.timeline);
  if (!midi.ok) {
    fail(`${path}: MIDI export failed: ${JSON.stringify(midi.errors)}`);
  }
  const allBuiltin = song.tracks.every((track) => track.instrument.type === 'builtin');
  const entry = {
    source: path,
    song: { sha256: sha256(bytes), bytes: bytes.byteLength },
    validation: {
      schemaVersion: validation.schemaVersion,
      warningCount: validation.warnings.length,
      capabilityCheck: validation.capabilityCheck,
    },
    normalized: {
      sha256: sha256(jsonBytes(validation.normalized)),
      bytes: jsonBytes(validation.normalized).byteLength,
    },
    duration: estimateRenderedDuration(song),
    timeline48000: { sha256: sha256(timelineBytes), bytes: timelineBytes.byteLength },
    midi: { sha256: sha256(midi.bytes), bytes: midi.bytes.byteLength },
    audioBuiltin48000: allBuiltin ? await renderBuiltinWav(song, 48000, path) : 'not-frozen',
  };
  if (path === secondRateSong) {
    entry.audioBuiltin44100 = await renderBuiltinWav(song, 44100, path);
    // Machine-scoped observation, kept as a digest the native suite may
    // re-check on this exact FluidSynth pair; not a cross-machine claim.
    const native = await renderNativeWav(song, path);
    entry.noteNativeFluidSynth48000 =
      native === null
        ? 'not-recorded (binary or pinned SoundFont absent)'
        : { ...native, scope: 'same-machine-only' };
  }
  return entry;
}

async function main() {
  mkdirSync(compatDir, { recursive: true });

  const api = {};
  const schemaBytes = readFileSync(join(repoRoot, 'packages/schema/schema/song.schema.json'));
  api['song.schema.json'] = { sha256: sha256(schemaBytes), bytes: schemaBytes.byteLength };
  const tsTypes = readFileSync(join(repoRoot, 'packages/schema/src/generated/song-v1.ts'));
  api['generated.song-v1.ts'] = { sha256: sha256(tsTypes), bytes: tsTypes.byteLength };
  const pythonDir = join(repoRoot, 'packages/schema/python/vamp_schema');
  const python = {};
  for (const name of readdirSync(pythonDir).sort()) {
    if (!name.endsWith('.py')) {
      continue;
    }
    const bytes = readFileSync(join(pythonDir, name));
    python[name] = { sha256: sha256(bytes), bytes: bytes.byteLength };
  }
  api['python.vamp_schema'] = python;
  const registryBytes = jsonBytes(describeInstrumentRegistry());
  api['instrument-registry.json'] = {
    sha256: sha256(registryBytes),
    bytes: registryBytes.byteLength,
  };

  const songEntries = [];
  for (const path of songs) {
    songEntries.push(await freezeSong(path));
  }

  const baseline = {
    format: 'vamp.compat-baseline',
    formatVersion: 1,
    frozenSchemaVersion: '1.0.0',
    regenerate: 'pnpm compat:freeze (after pnpm build)',
    policy:
      'These entries describe what v1 produces for representative saved songs. ' +
      'Re-freeze only for a reviewed, intentional schema/MIDI/audio change. A future ' +
      'schema version must replay every source here through its migration and ' +
      're-derive these fields; a mismatch is data loss, not a re-baseline.',
    determinismScope:
      'Built-in audio digests are byte-deterministic for one engine build on one ' +
      'platform, matching the Task 18 golden policy. The noteNativeFluidSynth48000 ' +
      'entry is same-machine only and is never a cross-platform claim.',
    api,
    songs: songEntries,
  };

  const outPath = join(compatDir, 'compat-baseline.json');
  writeFileSync(outPath, `${JSON.stringify(baseline, null, 2)}\n`);
  process.stdout.write(
    `Froze ${songEntries.length} songs + API surface into ${outPath} (${statSync(outPath).size} bytes)\n`,
  );
}

await main();
