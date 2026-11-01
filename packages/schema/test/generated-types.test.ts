import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  normalizeSong,
  validateSong,
  type BuiltinInstrument,
  type DelayEffect,
  type Effect,
  type EqEffect,
  type GmInstrument,
  type Instrument,
  type LowpassEffect,
  type NormalizedSongV1,
  type ReverbEffect,
  type SfzInstrument,
  type SongSchemaV1,
  type SoundfontInstrument,
} from '@gxaditya/vamp-schema';

import { loadValidFixture, minimalSong, packageRoot } from './test-helpers.js';

const generatedTypeScriptPath = join(packageRoot, 'src', 'generated', 'song-v1.ts');
const generatedPythonPath = join(packageRoot, 'python', 'vamp_schema', 'song_v1.py');

describe('generated schema types', () => {
  it('are up to date with the canonical schema', () => {
    const script = fileURLToPath(new URL('../scripts/generate-types.mjs', import.meta.url));
    const output = execFileSync(process.execPath, [script, '--check'], {
      cwd: packageRoot,
      encoding: 'utf8',
    });
    expect(output).toContain('Generated schema types are up to date.');
  });

  it('carry a DO NOT EDIT header with source and regeneration command', () => {
    for (const path of [generatedTypeScriptPath, generatedPythonPath]) {
      const content = readFileSync(path, 'utf8');
      expect(content).toContain('DO NOT EDIT');
      expect(content).toContain('packages/schema/schema/song.schema.json');
      expect(content).toContain('pnpm generate:types');
    }
  });

  it('are exported from the built package with the expected root and union types', () => {
    expectTypeOf<SongSchemaV1['schemaVersion']>().toEqualTypeOf<'1.0.0'>();
    expectTypeOf<SongSchemaV1['tracks'][number]['instrument']>().toEqualTypeOf<Instrument>();
    expectTypeOf<Instrument>().toEqualTypeOf<
      BuiltinInstrument | GmInstrument | SoundfontInstrument | SfzInstrument
    >();
    expectTypeOf<Effect>().toEqualTypeOf<ReverbEffect | DelayEffect | EqEffect | LowpassEffect>();

    const song: SongSchemaV1 = loadValidFixture('minimal.song.json');
    const normalized: NormalizedSongV1 = normalizeSong(song);
    expect(normalized.schemaVersion).toBe('1.0.0');

    const result = validateSong(minimalSong());
    expect(result.ok).toBe(true);
    if (result.ok) {
      const typedSong: SongSchemaV1 = result.song;
      const typedNormalized: NormalizedSongV1 = result.normalized;
      expect(typedSong.meta.title).toBe('Minimal Vamp Song');
      expect(typedNormalized.tracks[0]?.volume).toBe(1);
    }
  });

  it('exposes package files, exports, and runtime dependencies for consumers', () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      private?: boolean;
      files?: string[];
      exports?: Record<string, unknown>;
      dependencies?: Record<string, string>;
    };

    expect(manifest.private).not.toBe(true);
    expect(manifest.files).toEqual(expect.arrayContaining(['dist', 'schema', 'python']));
    expect(manifest.exports).toHaveProperty('./schema/song.schema.json');
    expect(manifest.dependencies).toHaveProperty('ajv');
    expect(manifest.dependencies).toHaveProperty('ajv-formats');
  });
});
