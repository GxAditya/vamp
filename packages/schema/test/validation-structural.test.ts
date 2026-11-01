import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  SUPPORTED_SCHEMA_VERSIONS,
  validateSong,
  type ValidationFailure,
  type ValidationResult,
} from '../src/index.js';
import {
  cloneSong,
  loadInvalidFixture,
  loadValidFixture,
  minimalSong,
  packageRoot,
} from './test-helpers.js';

function requireFailure(result: ValidationResult): ValidationFailure {
  if (result.ok) {
    throw new Error('Expected validation to fail.');
  }
  return result;
}

function hasIssue(result: ValidationResult, code: string, path: string): boolean {
  return result.ok
    ? false
    : result.errors.some((issue) => issue.code === code && issue.path === path);
}

const validFixtureNames = readdirSync(join(packageRoot, 'fixtures', 'valid'))
  .filter((name) => name.endsWith('.json'))
  .sort();
const invalidFixtureNames = readdirSync(join(packageRoot, 'fixtures', 'invalid'))
  .filter((name) => name.endsWith('.json'))
  .sort();

describe('structural validation and version dispatch', () => {
  it('accepts every valid v1 fixture and returns a normalized copy', () => {
    for (const name of validFixtureNames) {
      const song = loadValidFixture(name);
      const before = JSON.stringify(song);
      const result = validateSong(song);

      expect(result.ok, name).toBe(true);
      if (result.ok) {
        expect(result.schemaVersion).toBe('1.0.0');
        expect(result.normalized.schemaVersion).toBe('1.0.0');
        expect(result.capabilityCheck).toBe('not_checked');
      }
      expect(JSON.stringify(song), `${name} must not be mutated`).toBe(before);
    }
  });

  it('rejects every invalid structural fixture', () => {
    for (const name of invalidFixtureNames) {
      const result = validateSong(loadInvalidFixture(name));
      expect(result.ok, name).toBe(false);
      if (!result.ok) {
        expect(result.errors.length, name).toBeGreaterThan(0);
      }
    }
  });

  it('reports a missing required property at the missing property path', () => {
    const result = requireFailure(validateSong(loadInvalidFixture('missing-meta-bpm.json')));
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      code: 'schema.structure.required',
      path: '/meta/bpm',
      severity: 'error',
    });
    expect(result.warnings).toEqual([]);
  });

  it('reports wrong types and out-of-range values at the value path', () => {
    const wrongType = requireFailure(validateSong(loadInvalidFixture('wrong-field-type.json')));
    expect(wrongType.errors[0]).toMatchObject({
      code: 'schema.structure.type',
      path: '/meta/bpm',
    });

    const velocity = requireFailure(validateSong(loadInvalidFixture('velocity-out-of-range.json')));
    expect(velocity.errors[0]).toMatchObject({
      code: 'schema.structure.out_of_range',
      path: '/tracks/0/notes/0/velocity',
    });
  });

  it('reduces discriminated instrument and effect failures to one clean issue', () => {
    const instrument = requireFailure(
      validateSong(loadInvalidFixture('unknown-instrument-variant.json')),
    );
    expect(instrument.errors).toHaveLength(1);
    expect(instrument.errors[0]).toMatchObject({
      code: 'schema.structure.value_not_allowed',
      path: '/tracks/0/instrument/type',
    });

    const effect = requireFailure(validateSong(loadInvalidFixture('unknown-effect-type.json')));
    expect(effect.errors).toHaveLength(1);
    expect(effect.errors[0]).toMatchObject({
      code: 'schema.structure.value_not_allowed',
      path: '/tracks/0/effects/0/type',
    });

    const asset = requireFailure(validateSong(loadInvalidFixture('absolute-asset-path.json')));
    expect(asset.errors).toHaveLength(1);
    expect(asset.errors[0]).toMatchObject({
      code: 'schema.structure.pattern_mismatch',
      path: '/tracks/0/instrument/path',
    });
  });

  it('reports conditional schema conflicts as constraint failures', () => {
    const gmDrums = requireFailure(validateSong(loadInvalidFixture('gm-drum-track.json')));
    expect(gmDrums.errors[0]).toMatchObject({
      code: 'schema.structure.constraint_failed',
      path: '/tracks/0/instrument',
    });

    const staticCutoff = requireFailure(
      validateSong(loadInvalidFixture('filter-automation-with-static-cutoff.json')),
    );
    expect(staticCutoff.errors[0]).toMatchObject({
      code: 'schema.structure.constraint_failed',
      path: '/tracks/0/effects/0',
    });

    const staticVolume = requireFailure(
      validateSong(loadInvalidFixture('volume-automation-with-static-volume.json')),
    );
    expect(staticVolume.errors[0]).toMatchObject({
      code: 'schema.structure.constraint_failed',
      path: '/tracks/0',
    });
  });

  it('reports missing track content without branch noise', () => {
    const result = requireFailure(validateSong(loadInvalidFixture('missing-track-content.json')));
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      code: 'schema.structure.constraint_failed',
      path: '/tracks/0',
    });
  });

  it('escapes JSON Pointer path segments in unknown property names', () => {
    const slashSong = cloneSong(minimalSong()) as unknown as Record<string, unknown>;
    slashSong['bad/key'] = true;
    const slash = requireFailure(validateSong(slashSong));
    expect(hasIssue(slash, 'schema.structure.unknown_property', '/bad~1key')).toBe(true);

    const tildeSong = cloneSong(minimalSong()) as unknown as Record<string, unknown>;
    tildeSong['bad~key'] = true;
    const tilde = requireFailure(validateSong(tildeSong));
    expect(hasIssue(tilde, 'schema.structure.unknown_property', '/bad~0key')).toBe(true);
  });

  it('rejects non-object documents with one stable issue', () => {
    for (const input of [null, [], 'song', 42]) {
      const result = requireFailure(validateSong(input));
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({
        code: 'schema.document.invalid',
        path: '',
      });
      expect(result.schemaVersion).toBeNull();
    }
  });

  it('dispatches versions before structural checks', () => {
    const result = requireFailure(validateSong({ schemaVersion: '2.0.0' }));
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      code: 'schema.version.unsupported',
      path: '/schemaVersion',
    });
    expect(result.errors[0]?.params).toEqual({
      schemaVersion: '2.0.0',
      supported: [...SUPPORTED_SCHEMA_VERSIONS],
    });

    const fixture = requireFailure(validateSong(loadInvalidFixture('unknown-schema-version.json')));
    expect(fixture.errors).toHaveLength(1);
    expect(fixture.errors[0]?.code).toBe('schema.version.unsupported');
  });

  it('reports missing and non-string versions distinctly', () => {
    const missing = cloneSong(minimalSong()) as unknown as Record<string, unknown>;
    delete missing.schemaVersion;
    const missingResult = requireFailure(validateSong(missing));
    expect(missingResult.errors[0]).toMatchObject({
      code: 'schema.version.missing',
      path: '/schemaVersion',
    });
    expect(missingResult.errors[0]?.params).toEqual({ supported: ['1.0.0'] });
    expect(missingResult.schemaVersion).toBeNull();

    const badType = { ...minimalSong(), schemaVersion: 1 };
    const badTypeResult = requireFailure(validateSong(badType));
    expect(badTypeResult.errors[0]).toMatchObject({
      code: 'schema.version.unsupported',
      path: '/schemaVersion',
    });
  });

  it('rejects NaN and Infinity with stable non-finite codes for programmatic callers', () => {
    const nanSong = cloneSong(minimalSong());
    nanSong.tracks[0]!.notes![0]!.duration = Number.NaN;
    const nan = requireFailure(validateSong(nanSong));
    expect(nan.errors).toHaveLength(1);
    expect(nan.errors[0]).toMatchObject({
      code: 'value.non_finite',
      path: '/tracks/0/notes/0/duration',
    });

    const infiniteSong = cloneSong(minimalSong());
    infiniteSong.tracks[0]!.notes![0]!.start = Number.POSITIVE_INFINITY;
    const infinite = requireFailure(validateSong(infiniteSong));
    expect(infinite.errors).toHaveLength(1);
    expect(infinite.errors[0]).toMatchObject({
      code: 'value.non_finite',
      path: '/tracks/0/notes/0/start',
    });
  });

  it('returns JSON-serializable, deterministic, raw-validator-free issues', () => {
    const first = requireFailure(validateSong(loadInvalidFixture('two-drum-tracks.json')));
    const second = requireFailure(validateSong(loadInvalidFixture('two-drum-tracks.json')));
    expect(second).toEqual(first);

    for (const issue of first.errors) {
      expect(Object.keys(issue).sort()).toEqual(
        expect.arrayContaining(['code', 'severity', 'path', 'message', 'hint']),
      );
      expect(issue).not.toHaveProperty('keyword');
      expect(issue).not.toHaveProperty('instancePath');
      expect(issue).not.toHaveProperty('schemaPath');
      expect(JSON.parse(JSON.stringify(issue))).toEqual(issue);
    }
  });

  it('does not apply Ajv defaults or rewrite the input', () => {
    const song = minimalSong();
    const before = JSON.stringify(song);
    const result = validateSong(song);
    expect(result.ok).toBe(true);
    expect(JSON.stringify(song)).toBe(before);

    const note = song.tracks[0]?.notes?.[0];
    expect(note && 'velocity' in note).toBe(false);
    expect(note && 'volume' in (song.tracks[0] ?? {})).toBe(false);
    if (result.ok) {
      expect(result.normalized.tracks[0]?.notes[0]?.velocity).toBe(100);
    }
  });

  it('keeps a saved v1 fixture unchanged through version dispatch and normalization', () => {
    const source = JSON.parse(
      readFileSync(join(packageRoot, 'fixtures', 'valid', 'patterns.song.json'), 'utf8'),
    ) as unknown;
    const before = JSON.stringify(source);
    const result = validateSong(source);
    expect(result.ok).toBe(true);
    expect(JSON.stringify(source)).toBe(before);
  });
});
