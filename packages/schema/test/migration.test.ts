import { describe, expect, it } from 'vitest';

import {
  SONG_SCHEMA_VERSION,
  createMigrationRegistry,
  emptyMigrationRegistry,
  migrateSong,
} from '../src/index.js';

import { minimalSong } from './test-helpers.js';

describe('migration extension point', () => {
  it('does not rewrite v1 songs and has no v1 migrations', () => {
    const song = minimalSong();
    const before = JSON.stringify(song);

    expect(emptyMigrationRegistry.migrations).toEqual([]);
    const result = migrateSong(song);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.migrated).toBe(false);
      expect(result.path).toEqual([SONG_SCHEMA_VERSION]);
      expect(result.song).toEqual(song);
      expect(result.song).not.toBe(song);
    }
    expect(JSON.stringify(song)).toBe(before);
  });

  it('fails unknown source versions with a stable no-path result', () => {
    const result = migrateSong({ schemaVersion: '2.0.0', meta: {}, tracks: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('migration.no_path');
      expect(result.fromVersion).toBe('2.0.0');
      expect(result.toVersion).toBe(SONG_SCHEMA_VERSION);
      expect(result.message).toContain('Supported versions: 1.0.0');
    }
  });

  it('applies explicit registered migration paths deterministically', () => {
    const registry = createMigrationRegistry([
      {
        fromVersion: '2.0.0',
        toVersion: '3.0.0',
        description: 'Test hop 2 to 3',
        migrate: (song) => ({ ...song, schemaVersion: '3.0.0' }),
      },
      {
        fromVersion: '3.0.0',
        toVersion: SONG_SCHEMA_VERSION,
        description: 'Test hop 3 to 1',
        migrate: (song) => ({ ...song, schemaVersion: SONG_SCHEMA_VERSION }),
      },
    ]);

    const result = migrateSong({ schemaVersion: '2.0.0', meta: {}, tracks: [] }, '1.0.0', registry);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toEqual(['2.0.0', '3.0.0', '1.0.0']);
      expect(result.migrated).toBe(true);
    }
  });

  it('rejects duplicate migration edges and invalid results', () => {
    expect(() =>
      createMigrationRegistry([
        {
          fromVersion: '2.0.0',
          toVersion: '3.0.0',
          description: 'One',
          migrate: (song) => ({ ...song, schemaVersion: '3.0.0' }),
        },
        {
          fromVersion: '2.0.0',
          toVersion: '3.0.0',
          description: 'Two',
          migrate: (song) => ({ ...song, schemaVersion: '3.0.0' }),
        },
      ]),
    ).toThrow(/Duplicate migration edge/);

    const registry = createMigrationRegistry([
      {
        fromVersion: '2.0.0',
        toVersion: '3.0.0',
        description: 'Wrong result',
        migrate: () => ({ schemaVersion: '2.0.0' }),
      },
    ]);
    const result = migrateSong({ schemaVersion: '2.0.0' }, '3.0.0', registry);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('migration.invalid_result');
    }
  });
});
