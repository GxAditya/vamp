/**
 * Schema version constants and the explicit migration extension point.
 *
 * Validation never migrates or rewrites a song. `migrateSong` is a separate,
 * pure operation that a caller must invoke deliberately. SongSchemaV1 has no
 * migrations, so the default registry is empty.
 */

export const SONG_SCHEMA_VERSION = '1.0.0' as const;
export const SONG_SCHEMA_ID = 'urn:vamp:schema:song:1.0.0' as const;

export type SupportedSchemaVersion = typeof SONG_SCHEMA_VERSION;

export const SUPPORTED_SCHEMA_VERSIONS: readonly SupportedSchemaVersion[] = Object.freeze([
  SONG_SCHEMA_VERSION,
]);

export interface SchemaMigration {
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly description: string;
  /**
   * Return a new song object with schemaVersion set to `toVersion`. The input
   * is a private clone and must not be mutated. Migrations run only when a
   * caller explicitly invokes `migrateSong`.
   */
  readonly migrate: (song: Readonly<Record<string, unknown>>) => Record<string, unknown>;
}

export interface MigrationRegistry {
  readonly migrations: readonly SchemaMigration[];
  find(fromVersion: string, toVersion: string): SchemaMigration | undefined;
}

export function createMigrationRegistry(migrations: readonly SchemaMigration[]): MigrationRegistry {
  const copy = [...migrations];
  const edges = new Set<string>();
  for (const migration of copy) {
    if (
      migration.fromVersion.length === 0 ||
      migration.toVersion.length === 0 ||
      migration.fromVersion === migration.toVersion
    ) {
      throw new Error(
        `Invalid migration edge "${migration.fromVersion}" -> "${migration.toVersion}".`,
      );
    }
    const edge = `${migration.fromVersion}\u0000${migration.toVersion}`;
    if (edges.has(edge)) {
      throw new Error(
        `Duplicate migration edge "${migration.fromVersion}" -> "${migration.toVersion}".`,
      );
    }
    edges.add(edge);
  }

  const frozen = Object.freeze(copy);
  return Object.freeze({
    migrations: frozen,
    find(fromVersion: string, toVersion: string): SchemaMigration | undefined {
      return frozen.find(
        (migration) => migration.fromVersion === fromVersion && migration.toVersion === toVersion,
      );
    },
  });
}

/** The v1 migration registry is intentionally empty. */
export const emptyMigrationRegistry: MigrationRegistry = createMigrationRegistry([]);

export type MigrationFailureCode =
  | 'migration.invalid_input'
  | 'migration.invalid_target'
  | 'migration.no_path'
  | 'migration.invalid_result';

export interface MigrationFailure {
  readonly ok: false;
  readonly code: MigrationFailureCode;
  readonly fromVersion: string | null;
  readonly toVersion: string;
  readonly message: string;
  readonly hint: string;
}

export interface MigrationSuccess {
  readonly ok: true;
  readonly song: Record<string, unknown>;
  readonly fromVersion: string;
  readonly toVersion: string;
  /** Every version visited, starting with the source and ending with the target. */
  readonly path: readonly string[];
  /** False when the source already equals the target. No rewrite was needed. */
  readonly migrated: boolean;
}

export type MigrationResult = MigrationSuccess | MigrationFailure;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface MigrationQueueEntry {
  readonly version: string;
  readonly song: Record<string, unknown>;
  readonly path: readonly string[];
}

/**
 * Apply an explicit migration path. This function does not validate the result
 * against the target schema; callers should run `validateSong` afterwards.
 */
export function migrateSong(
  input: unknown,
  targetVersion: string = SONG_SCHEMA_VERSION,
  registry: MigrationRegistry = emptyMigrationRegistry,
): MigrationResult {
  if (!isRecord(input) || typeof input.schemaVersion !== 'string') {
    return {
      ok: false,
      code: 'migration.invalid_input',
      fromVersion:
        isRecord(input) && typeof input.schemaVersion === 'string' ? input.schemaVersion : null,
      toVersion: targetVersion,
      message: 'Cannot migrate input without a string schemaVersion.',
      hint: 'Pass a song object with a supported schemaVersion.',
    };
  }

  if (targetVersion.length === 0) {
    return {
      ok: false,
      code: 'migration.invalid_target',
      fromVersion: input.schemaVersion,
      toVersion: targetVersion,
      message: 'The target schema version is empty.',
      hint: 'Choose an explicit target schema version.',
    };
  }

  const fromVersion = input.schemaVersion;
  const initialSong = structuredClone(input);

  if (fromVersion === targetVersion) {
    return {
      ok: true,
      song: initialSong,
      fromVersion,
      toVersion: targetVersion,
      path: [fromVersion],
      migrated: false,
    };
  }

  const queue: MigrationQueueEntry[] = [
    { version: fromVersion, song: initialSong, path: [fromVersion] },
  ];
  const visited = new Set<string>([fromVersion]);

  while (queue.length > 0) {
    const entry = queue.shift();
    if (!entry) {
      break;
    }

    for (const migration of registry.migrations) {
      if (migration.fromVersion !== entry.version || visited.has(migration.toVersion)) {
        continue;
      }

      let migrated: Record<string, unknown>;
      try {
        migrated = migration.migrate(structuredClone(entry.song));
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          code: 'migration.invalid_result',
          fromVersion,
          toVersion: targetVersion,
          message: `Migration "${migration.fromVersion}" -> "${migration.toVersion}" failed: ${detail}`,
          hint: 'Fix the migration function. Saved song files were not modified.',
        };
      }

      if (!isRecord(migrated) || migrated.schemaVersion !== migration.toVersion) {
        return {
          ok: false,
          code: 'migration.invalid_result',
          fromVersion,
          toVersion: targetVersion,
          message:
            `Migration "${migration.fromVersion}" -> "${migration.toVersion}" must return an object ` +
            `with schemaVersion "${migration.toVersion}".`,
          hint: 'Return a new song object that declares the target schemaVersion.',
        };
      }

      const path = [...entry.path, migration.toVersion];
      if (migration.toVersion === targetVersion) {
        return {
          ok: true,
          song: migrated,
          fromVersion,
          toVersion: targetVersion,
          path,
          migrated: true,
        };
      }

      visited.add(migration.toVersion);
      queue.push({ version: migration.toVersion, song: migrated, path });
    }
  }

  return {
    ok: false,
    code: 'migration.no_path',
    fromVersion,
    toVersion: targetVersion,
    message:
      `No migration path from schemaVersion "${fromVersion}" to "${targetVersion}". ` +
      `Supported versions: ${SUPPORTED_SCHEMA_VERSIONS.join(', ')}.`,
    hint: 'Load the file with a version that supports it, or add an explicit migration in the call site registry.',
  };
}
