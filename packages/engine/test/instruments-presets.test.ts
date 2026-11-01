import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateSong } from '@gxaditya/vamp-schema';
import { afterAll, describe, expect, it } from 'vitest';

import {
  BGM_PRESETS,
  GM_DRUM_NOTE_MAP,
  GM_INSTRUMENT_CATALOG,
  GM_STANDARD_DRUM_KIT,
  INSTRUMENT_REGISTRY_VALIDATION,
  createPresetSong,
  describeBgmPresets,
  discoverSoundFont,
  findGmPresetByProgram,
  getGmPreset,
  selectAutomaticBackend,
} from '../src/index.js';

const temporaryDirectories: string[] = [];

function tempDirectory(): string {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'vamp-preset-test-')));
  temporaryDirectories.push(directory);
  return directory;
}

function fakeSoundFont(path: string, bytes = 1_048_576): void {
  const buffer = Buffer.alloc(bytes);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(bytes - 8, 4);
  buffer.write('sfbk', 8, 'ascii');
  buffer.write('LIST', 12, 'ascii');
  writeFileSync(path, buffer);
}

afterAll(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('named GM instrument catalog', () => {
  it('exposes a rich, unique, BGM-relevant catalog', () => {
    expect(GM_INSTRUMENT_CATALOG.length).toBeGreaterThanOrEqual(50);
    expect(GM_INSTRUMENT_CATALOG.length).toBeLessThanOrEqual(128);
    const ids = new Set(GM_INSTRUMENT_CATALOG.map((preset) => preset.id));
    expect(ids.size).toBe(GM_INSTRUMENT_CATALOG.length);
    for (const preset of GM_INSTRUMENT_CATALOG) {
      expect(preset.program).toBeGreaterThanOrEqual(0);
      expect(preset.program).toBeLessThanOrEqual(127);
      expect(preset.songInstrument).toEqual({
        type: 'gm',
        program: preset.program,
        bank: 0,
      });
      expect(preset.roles.length).toBeGreaterThan(0);
    }
    expect(getGmPreset('gm.keys.ep-tine')?.program).toBe(4);
    expect(findGmPresetByProgram(33)?.id).toBe('gm.bass.finger');
    expect(findGmPresetByProgram(81)?.id).toBe('gm.lead.saw');
  });

  it('exposes the GM standard kit and readable drum keys', () => {
    expect(GM_STANDARD_DRUM_KIT.songInstrument).toEqual({ type: 'builtin', id: 'drums.kit' });
    expect(GM_STANDARD_DRUM_KIT.bank).toBe(128);
    expect(GM_STANDARD_DRUM_KIT.channel).toBe(9);
    expect(GM_DRUM_NOTE_MAP.kick).toBe(36);
    expect(GM_DRUM_NOTE_MAP.snare).toBe(38);
    expect(GM_DRUM_NOTE_MAP.hatClosed).toBe(42);
    expect(GM_DRUM_NOTE_MAP.hatOpen).toBe(46);
    expect(GM_STANDARD_DRUM_KIT.notes.length).toBe(47);
  });
});

describe('BGM presets', () => {
  it('describes five complete recipes', () => {
    expect(BGM_PRESETS.map((preset) => preset.id)).toEqual([
      'lofi',
      'tutorial_upbeat',
      'ambient_focus',
      'corporate_clean',
      'stinger',
    ]);
    const described = describeBgmPresets();
    expect(described.length).toBe(5);
    for (const preset of described) {
      expect(preset.instruments.length).toBeGreaterThanOrEqual(3);
      expect(preset.groove.length).toBeGreaterThan(10);
      expect(preset.arrangement.length).toBeGreaterThan(10);
      expect(preset.mix.length).toBeGreaterThan(10);
    }
  });

  it('generates valid songs with a groove, bass, harmony, and velocity variation', () => {
    for (const preset of BGM_PRESETS) {
      const song = createPresetSong(preset.id);
      const valid = validateSong(song, INSTRUMENT_REGISTRY_VALIDATION);
      const detail = valid.ok ? '' : JSON.stringify(valid.errors.slice(0, 2));
      expect(valid.ok, `${preset.id}: ${detail}`).toBe(true);
      expect(song.tracks.length, preset.id).toBeGreaterThanOrEqual(3);
      const roles = song.tracks.map((track) => track.id);
      expect(roles, preset.id).toContain('chords');
      expect(roles, preset.id).toContain('bass');
      const allNotes = song.tracks.flatMap((track) => track.notes ?? []);
      expect(allNotes.length, preset.id).toBeGreaterThan(10);
      const velocities = new Set(allNotes.map((note) => note.velocity ?? 100));
      expect(velocities.size, preset.id).toBeGreaterThan(1);
      for (const track of song.tracks) {
        for (const note of track.notes ?? []) {
          expect(note.pitch).toBeGreaterThanOrEqual(28);
          expect(note.pitch).toBeLessThanOrEqual(96);
        }
      }
      if (
        preset.id === 'lofi' ||
        preset.id === 'tutorial_upbeat' ||
        preset.id === 'corporate_clean'
      ) {
        expect(roles, preset.id).toContain('drums');
      }
      if (preset.id === 'ambient_focus') {
        expect(roles, preset.id).not.toContain('drums');
      }
    }
  });

  it('generates an exact 45 second lo-fi cue with sparse melody and varied drums', () => {
    const song = createPresetSong('lofi', { title: 'Coding bed', durationSeconds: 45, bpm: 90 });
    expect(song.meta.title).toBe('Coding bed');
    expect(song.meta.bpm).toBe(90);
    expect(song.meta.durationHint).toBe(67.5);
    const melody = song.tracks.find((track) => track.id === 'melody');
    const drums = song.tracks.find((track) => track.id === 'drums');
    expect(melody?.notes?.length).toBeLessThan(20);
    expect(drums?.notes?.length).toBeGreaterThan(50);
    const drumVelocities = new Set((drums?.notes ?? []).map((note) => note.velocity));
    expect(drumVelocities.size).toBeGreaterThan(5);
    const chordTrack = song.tracks.find((track) => track.id === 'chords');
    expect(chordTrack?.instrument).toMatchObject({ type: 'gm', program: 4 });
    expect(chordTrack?.effects?.some((effect) => effect.type === 'lowpass')).toBe(true);
    expect(chordTrack?.effects?.some((effect) => effect.type === 'reverb')).toBe(true);
    expect(song.meta.tags).toContain('45s');
  });

  it('supports duration, tempo, and tag overrides and rejects unknown presets', () => {
    const song = createPresetSong('tutorial_upbeat', { durationSeconds: 12, bpm: 100 });
    expect(song.meta.bpm).toBe(100);
    expect(song.meta.durationHint).toBe(20);
    expect(song.meta.tags).toContain('12s');
    expect(song.meta.tags).not.toContain('30s');
    expect(validateSong(song, INSTRUMENT_REGISTRY_VALIDATION).ok).toBe(true);
    expect(() => createPresetSong('not-a-preset')).toThrow(/Unknown BGM preset/);
  });
});

describe('local SoundFont discovery', () => {
  it('uses VAMP_SOUNDFONT_PATH before directories', async () => {
    const directory = tempDirectory();
    const explicit = join(directory, 'explicit.sf2');
    fakeSoundFont(explicit);
    const result = await discoverSoundFont({
      env: { VAMP_SOUNDFONT_PATH: explicit },
      platform: 'linux',
      home: directory,
    });
    expect(result.soundFont).toMatchObject({ path: explicit, source: 'environment-file' });
  });

  it('scans VAMP_SOUNDFONT_DIR and prefers GM-suitable names', async () => {
    const directory = tempDirectory();
    fakeSoundFont(join(directory, 'random.sf2'));
    const preferred = join(directory, 'FluidR3_GM.sf2');
    fakeSoundFont(preferred);
    const result = await discoverSoundFont({
      env: { VAMP_SOUNDFONT_DIR: directory },
      platform: 'linux',
      home: directory,
    });
    expect(result.soundFont?.path).toBe(preferred);
    expect(result.soundFont?.source).toBe('environment-directory');
  });

  it('ignores tiny or non-SoundFont files and falls back to the builtin backend', async () => {
    const directory = tempDirectory();
    writeFileSync(join(directory, 'broken.sf2'), 'not a soundfont');
    const isolatedEnv = {
      VAMP_SOUNDFONT_DIR: directory,
      ProgramData: join(directory, 'missing-program-data'),
      ProgramFiles: join(directory, 'missing-program-files'),
      APPDATA: join(directory, 'missing-app-data'),
    };
    const result = await discoverSoundFont({
      env: isolatedEnv,
      platform: 'win32',
      home: directory,
      extraDirectories: [],
    });
    expect(result.soundFont).toBeNull();
    const selection = await selectAutomaticBackend({
      binaryPath: '/definitely/missing/fluidsynth',
      env: isolatedEnv,
      platform: 'win32',
      home: directory,
    });
    expect(selection.id).toBe('builtin');
    expect(selection.fellBackToBuiltin).toBe(true);
    expect(selection.missingDependencies).toContain('executable');
  });
});
