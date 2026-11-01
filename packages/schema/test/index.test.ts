import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ISSUE_CODES,
  ISSUE_CODE_REFERENCE,
  PACKAGE_NAME,
  SONG_SCHEMA_ID,
  SONG_SCHEMA_VERSION,
  SUPPORTED_SCHEMA_VERSIONS,
  estimateRenderedDuration,
  getSongSchemaV1,
  normalizeSong,
  validateSong,
} from '../src/index.js';

import { minimalSong, packageRoot } from './test-helpers.js';

describe('@gxaditya/vamp-schema public surface', () => {
  it('exposes the schema library API', () => {
    expect(PACKAGE_NAME).toBe('@gxaditya/vamp-schema');
    expect(SONG_SCHEMA_VERSION).toBe('1.0.0');
    expect(SUPPORTED_SCHEMA_VERSIONS).toEqual(['1.0.0']);
    expect(typeof validateSong).toBe('function');
    expect(typeof normalizeSong).toBe('function');
    expect(typeof estimateRenderedDuration).toBe('function');
  });

  it('loads the canonical schema package-relative', () => {
    const schema = getSongSchemaV1();
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema.$id).toBe(SONG_SCHEMA_ID);
  });

  it('exports a unique machine-readable issue code reference', () => {
    expect(ISSUE_CODE_REFERENCE.length).toBeGreaterThan(30);
    expect(new Set(ISSUE_CODES).size).toBe(ISSUE_CODES.length);
    expect(ISSUE_CODES).toContain('song.track.duplicate_id');
    expect(ISSUE_CODES).toContain('song.warning.unused_pattern');

    for (const definition of ISSUE_CODE_REFERENCE) {
      expect(definition.description.length).toBeGreaterThan(0);
      expect(['error', 'warning']).toContain(definition.severity);
    }
  });

  it('documents every public issue code in docs/validation.md', () => {
    const documentation = readFileSync(
      join(packageRoot, '..', '..', 'docs', 'validation.md'),
      'utf8',
    );
    for (const code of ISSUE_CODES) {
      expect(documentation).toContain(`\`${code}\``);
    }
  });

  it('validates a fixture through the public API', () => {
    const result = validateSong(minimalSong());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.song.schemaVersion).toBe('1.0.0');
      expect(result.normalized.schemaVersion).toBe('1.0.0');
    }
  });
});
