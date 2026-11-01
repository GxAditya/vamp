#!/usr/bin/env node
/**
 * Regenerate the Task 18 golden audio regression baselines.
 *
 * Usage (run `pnpm build` first, this script renders through the built engine):
 *
 *   pnpm golden:regenerate
 *
 * What it writes, all under `packages/engine/test/fixtures/golden/`:
 *
 * - `golden-song.timeline-48000.json`: the full canonical `SongTimeline` for
 *   `packages/engine/test/fixtures/golden-song.song.json` at 48 kHz. The pinned
 *   test deep-compares the compiler output against this document.
 * - `baseline.json`: SHA-256 pins for the 44.1 kHz timeline serialization, the
 *   MIDI bytes, the built-in WAV and PCM bytes at both sample rates, and, when
 *   FluidSynth plus the pinned FluidR3_GM SoundFont are provisioned, one
 *   native WAV render. The native pin is valid on this machine only; the test
 *   for it skips cleanly when the binary or the asset is absent.
 *
 * Why and when to regenerate:
 *
 * These baselines exist to catch unintended changes to the compiler, the MIDI
 * exporter, and the built-in DSP. Regenerate only after an intentional,
 * reviewed change to one of those (a new engine version, a deliberate DSP or
 * timeline format change, or a new golden fixture). Never regenerate to make a
 * failing golden test pass without first explaining why the bytes changed;
 * that would hide exactly the regressions this suite exists to catch.
 *
 * The script is deterministic: given the same engine build and platform it
 * rewrites byte-identical files. It performs no network access and writes no
 * timestamps into the baselines.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  compileSong,
  createFluidSynthBackend,
  encodeWav,
  exportMidi,
  renderSongAudio,
} from '../packages/engine/dist/index.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const goldenDir = join(repoRoot, 'packages/engine/test/fixtures/golden');
const songPath = join(repoRoot, 'packages/engine/test/fixtures/golden-song.song.json');

// Matches scripts/verify-soundfont.mjs and docs/instruments.md. Hard-coded so
// importing this script has no side effects from that file's main() run.
const PINNED_FLUIDR3_GM_SHA256 = '74594e8f4250680adf590507a306655a299935343583256f3b722c48a1bc1cb0';
const FLUID_BINARY = process.env.VAMP_FLUIDSYNTH_PATH ?? '/usr/bin/fluidsynth';
const FLUID_SOUNDFONT = process.env.VAMP_SOUNDFONT_PATH ?? '/usr/share/sounds/sf2/FluidR3_GM.sf2';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sameBytes(left, right) {
  return Buffer.from(left.buffer, left.byteOffset, left.byteLength).equals(
    Buffer.from(right.buffer, right.byteOffset, right.byteLength),
  );
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function compileAt(song, sampleRate) {
  const result = compileSong(song, { sampleRate });
  if (!result.ok) {
    fail(`golden-song failed to compile at ${sampleRate}: ${JSON.stringify(result.errors)}`);
  }
  return result.timeline;
}

async function renderBuiltinWav(song, sampleRate) {
  const rendered = await renderSongAudio(song, { sampleRate });
  if (!rendered.ok) {
    fail(`built-in render failed at ${sampleRate}: ${JSON.stringify(rendered.errors)}`);
  }
  const encoded = encodeWav(rendered.audio);
  if (!encoded.ok) {
    fail(`built-in encode failed at ${sampleRate}: ${JSON.stringify(encoded.errors)}`);
  }
  // Repeating the render must be byte-identical on this platform; the
  // regeneration refuses to pin nondeterministic output.
  const repeat = await renderSongAudio(song, { sampleRate });
  const repeatEncoded = repeat.ok ? encodeWav(repeat.audio) : { ok: false };
  if (!repeat.ok || !repeatEncoded.ok || !sameBytes(repeatEncoded.bytes, encoded.bytes)) {
    fail(`built-in render at ${sampleRate} is not repeat-identical on this machine`);
  }
  const pcm = new Uint8Array(rendered.audio.left.byteLength + rendered.audio.right.byteLength);
  pcm.set(new Uint8Array(rendered.audio.left.buffer), 0);
  pcm.set(new Uint8Array(rendered.audio.right.buffer), rendered.audio.left.byteLength);
  return { wav: encoded.bytes, pcm };
}

function nativeSong() {
  // A two-track, two-second cue: a curated piano line plus a small drum hit.
  // Used only for the same-machine FluidSynth reproducibility pin.
  return {
    schemaVersion: '1.0.0',
    meta: {
      title: 'Native Pinned Cue',
      bpm: 120,
      timeSignature: { numerator: 4, denominator: 4 },
      key: { tonic: 'C', mode: 'major' },
      seed: 990142,
      // Four beats at 120 BPM is a two-second render; every note ends inside
      // the window, so the pin covers a complete short native render.
      durationHint: 4,
    },
    tracks: [
      {
        id: 'piano',
        name: 'Piano',
        kind: 'midi',
        channel: 0,
        instrument: { type: 'builtin', id: 'piano.soft' },
        notes: [
          { pitch: 60, start: 0, duration: 0.9, velocity: 108 },
          { pitch: 64, start: 0.75, duration: 0.5, velocity: 96 },
          { pitch: 67, start: 1.5, duration: 0.5, velocity: 104 },
        ],
      },
      {
        id: 'drums',
        name: 'Drums',
        kind: 'drums',
        channel: 9,
        instrument: { type: 'builtin', id: 'drums.kit' },
        notes: [
          { pitch: 36, start: 0, duration: 0.25, velocity: 110 },
          { pitch: 38, start: 0.5, duration: 0.25, velocity: 100 },
          { pitch: 42, start: 0.75, duration: 0.25, velocity: 88 },
          { pitch: 49, start: 1, duration: 0.25, velocity: 96 },
        ],
      },
    ],
  };
}

async function renderNativeWav() {
  if (!existsSync(FLUID_BINARY) || !existsSync(FLUID_SOUNDFONT)) {
    return null;
  }
  const backend = createFluidSynthBackend({
    binaryPath: FLUID_BINARY,
    gmSoundFont: FLUID_SOUNDFONT,
    verifyGmSoundFontChecksum: true,
  });
  const song = nativeSong();
  const first = await renderSongAudio(song, { sampleRate: 48000, backend });
  if (!first.ok) {
    fail(`FluidSynth render failed: ${JSON.stringify(first.errors)}`);
  }
  const encoded = encodeWav(first.audio);
  if (!encoded.ok) {
    fail(`FluidSynth encode failed: ${JSON.stringify(encoded.errors)}`);
  }
  const second = await renderSongAudio(song, { sampleRate: 48000, backend });
  const repeat = second.ok ? encodeWav(second.audio) : { ok: false };
  if (!repeat.ok || !sameBytes(repeat.bytes, encoded.bytes)) {
    fail('FluidSynth render is not repeat-identical on this machine');
  }
  return { wav: encoded.bytes };
}

async function main() {
  const song = JSON.parse(readFileSync(songPath, 'utf8'));

  const timeline48 = await compileAt(song, 48000);
  const timeline44 = await compileAt(song, 44100);
  const timeline48Json = serialize(timeline48);
  const timeline44Json = serialize(timeline44);

  const midi = exportMidi(timeline48);
  if (!midi.ok) {
    fail(`golden MIDI export failed: ${JSON.stringify(midi.errors)}`);
  }

  const builtin48 = await renderBuiltinWav(song, 48000);
  const builtin44 = await renderBuiltinWav(song, 44100);
  const native = await renderNativeWav();

  mkdirSync(goldenDir, { recursive: true });
  const timelineFile = 'golden-song.timeline-48000.json';
  writeFileSync(join(goldenDir, timelineFile), timeline48Json);
  // The native pin song is data, not code: the pinned test loads this exact
  // file so the baseline and the test can never drift apart.
  writeFileSync(join(goldenDir, 'native-song.song.json'), serialize(nativeSong()));

  const entries = {
    'timeline.48000.json': {
      description:
        'Full canonical SongTimeline for golden-song.song.json at 48 kHz, byte-compared as JSON text and deep-compared as data.',
      file: timelineFile,
      sha256: sha256(Buffer.from(timeline48Json, 'utf8')),
      bytes: Buffer.byteLength(timeline48Json),
    },
    'timeline.44100.json': {
      description:
        'SHA-256 of the serialized canonical SongTimeline at 44.1 kHz (the document itself is not committed to keep the baseline small).',
      sha256: sha256(Buffer.from(timeline44Json, 'utf8')),
      bytes: Buffer.byteLength(timeline44Json),
    },
    'midi.48000': {
      description:
        'SHA-256 of the Type 1 MIDI bytes exported from the 48 kHz golden timeline with default exportMidi options.',
      sha256: sha256(midi.bytes),
      bytes: midi.bytes.byteLength,
    },
    'wav.builtin.48000': {
      description:
        'SHA-256 of the built-in backend WAV bytes at 48 kHz. Byte-deterministic for this engine build and platform.',
      sha256: sha256(builtin48.wav),
      bytes: builtin48.wav.byteLength,
    },
    'wav.builtin.44100': {
      description:
        'SHA-256 of the built-in backend WAV bytes at 44.1 kHz. Byte-deterministic for this engine build and platform.',
      sha256: sha256(builtin44.wav),
      bytes: builtin44.wav.byteLength,
    },
    'pcm.builtin.48000': {
      description:
        'SHA-256 of the concatenated Float32 little-endian left and right channels at 48 kHz.',
      sha256: sha256(builtin48.pcm),
      bytes: builtin48.pcm.byteLength,
    },
    'pcm.builtin.44100': {
      description:
        'SHA-256 of the concatenated Float32 little-endian left and right channels at 44.1 kHz.',
      sha256: sha256(builtin44.pcm),
      bytes: builtin44.pcm.byteLength,
    },
  };

  if (native !== null) {
    entries['wav.fluidsynth.48000'] = {
      description:
        'SHA-256 of a two-second, two-track render through the pinned FluidSynth backend at 48 kHz. Valid on this machine, this FluidSynth version, and this byte-identical SoundFont only. Same-machine scope; never a cross-platform claim.',
      sha256: sha256(native.wav),
      bytes: native.wav.byteLength,
      scope: 'same-machine-only',
      songFile: 'native-song.song.json',
      fluidSynth: FLUID_BINARY,
      soundFontSha256: PINNED_FLUIDR3_GM_SHA256,
    };
  } else {
    process.stderr.write(
      'note: FluidSynth or the pinned SoundFont is absent; the native baseline entry was not written.\n',
    );
  }

  const sortedEntries = {};
  for (const key of Object.keys(entries).sort()) {
    sortedEntries[key] = entries[key];
  }

  const baseline = {
    format: 'vamp.golden-baseline',
    formatVersion: 1,
    song: '../../golden-song.song.json',
    regenerate: 'pnpm golden:regenerate (after pnpm build)',
    policy:
      'Regenerate only for reviewed, intentional engine or fixture changes. A golden mismatch is a signal to investigate, not to re-baseline blindly.',
    determinismScope:
      'Built-in entries are byte-deterministic for this engine build and platform. The fluidsynth entry is same-machine only.',
    entries: sortedEntries,
  };

  writeFileSync(join(goldenDir, 'baseline.json'), `${JSON.stringify(baseline, null, 2)}\n`);

  for (const [name, entry] of Object.entries(sortedEntries)) {
    process.stdout.write(
      `${name.padEnd(24)} ${entry.bytes} bytes  ${entry.sha256.slice(0, 16)}...\n`,
    );
  }
  process.stdout.write(`\nWrote ${goldenDir}\n`);
}

await main();
