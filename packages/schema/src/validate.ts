import type { SongSchemaV1 } from './generated/song-v1.js';
import type { BackendCapabilities } from './capabilities.js';
import { appendJsonPointer, createIssue, normalizeIssues, type ValidationIssue } from './issues.js';
import { normalizeSong, type NormalizedSongV1 } from './normalize.js';
import { validateSongSemantics } from './semantic.js';
import { validateSongStructure } from './structural.js';
import {
  SONG_SCHEMA_VERSION,
  SUPPORTED_SCHEMA_VERSIONS,
  type SupportedSchemaVersion,
} from './version.js';

export interface ValidateSongOptions {
  /**
   * Override the known builtin instrument ids, for example with the engine's
   * authoritative instrument registry. Defaults to the schema package allowlist.
   */
  readonly builtinInstrumentIds?: readonly string[];
  /**
   * Declare a selected renderer backend. When omitted, backend capability is
   * explicitly reported as not checked and must be checked before rendering.
   */
  readonly capabilities?: BackendCapabilities;
}

export type CapabilityCheckStatus = 'checked' | 'not_checked';

export interface ValidationSuccess {
  readonly ok: true;
  readonly schemaVersion: SupportedSchemaVersion;
  /** The validated authored song. It is not a normalized copy and was not mutated. */
  readonly song: SongSchemaV1;
  /** A deep copy with every documented normalization default applied. */
  readonly normalized: NormalizedSongV1;
  readonly warnings: readonly ValidationIssue[];
  readonly capabilityCheck: CapabilityCheckStatus;
}

export interface ValidationFailure {
  readonly ok: false;
  readonly schemaVersion: string | null;
  readonly errors: readonly ValidationIssue[];
  readonly warnings: readonly ValidationIssue[];
}

export type ValidationResult = ValidationSuccess | ValidationFailure;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeValueType(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value;
}

interface NonFiniteFinding {
  readonly path: string;
  readonly value: 'NaN' | 'Infinity' | '-Infinity';
}

function findNonFiniteValues(
  value: unknown,
  path: string,
  seen: WeakSet<object>,
  findings: NonFiniteFinding[],
): void {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    findings.push({
      path,
      value: Number.isNaN(value) ? 'NaN' : value > 0 ? 'Infinity' : '-Infinity',
    });
    return;
  }

  if (typeof value !== 'object' || value === null) {
    return;
  }
  if (seen.has(value)) {
    return;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      findNonFiniteValues(entry, `${path}/${index}`, seen, findings);
    });
    return;
  }

  for (const [key, entry] of Object.entries(value)) {
    findNonFiniteValues(entry, appendJsonPointer(path, key), seen, findings);
  }
}

function versionFailure(schemaVersion: string | null, issue: ValidationIssue): ValidationFailure {
  return {
    ok: false,
    schemaVersion,
    errors: [issue],
    warnings: [],
  };
}

/**
 * Validate a SongSchemaV1 document.
 *
 * Order: document/version dispatch, non-finite scan, JSON Schema structure,
 * cross-item semantic checks and warnings, then normalization.
 * Validation never applies defaults to the input, never migrates it, and never
 * injects timestamps or seeds.
 */
export function validateSong(input: unknown, options: ValidateSongOptions = {}): ValidationResult {
  if (!isRecord(input)) {
    return versionFailure(
      null,
      createIssue(
        'schema.document.invalid',
        '',
        `A song must be a JSON object, received ${describeValueType(input)}.`,
        'Pass a song object with schemaVersion, meta, and tracks.',
      ),
    );
  }

  if (!Object.hasOwn(input, 'schemaVersion') || input.schemaVersion === undefined) {
    return versionFailure(
      null,
      createIssue(
        'schema.version.missing',
        '/schemaVersion',
        `Missing required schemaVersion. Supported versions: ${SUPPORTED_SCHEMA_VERSIONS.join(', ')}.`,
        'Add schemaVersion "1.0.0". Loading never rewrites saved files automatically.',
        { supported: [...SUPPORTED_SCHEMA_VERSIONS] },
      ),
    );
  }

  const schemaVersionValue = input.schemaVersion;
  if (
    typeof schemaVersionValue !== 'string' ||
    !(SUPPORTED_SCHEMA_VERSIONS as readonly string[]).includes(schemaVersionValue)
  ) {
    const received =
      typeof schemaVersionValue === 'string'
        ? JSON.stringify(schemaVersionValue)
        : describeValueType(schemaVersionValue);
    return versionFailure(
      typeof schemaVersionValue === 'string' ? schemaVersionValue : null,
      createIssue(
        'schema.version.unsupported',
        '/schemaVersion',
        `Unsupported schemaVersion ${received}. Supported versions: ${SUPPORTED_SCHEMA_VERSIONS.join(', ')}.`,
        'Use a supported schemaVersion or migrate the file explicitly. Validation never rewrites saved data.',
        {
          schemaVersion: typeof schemaVersionValue === 'string' ? schemaVersionValue : received,
          supported: [...SUPPORTED_SCHEMA_VERSIONS],
        },
      ),
    );
  }

  if (schemaVersionValue !== SONG_SCHEMA_VERSION) {
    return versionFailure(
      schemaVersionValue,
      createIssue(
        'schema.version.unsupported',
        '/schemaVersion',
        `Unsupported schemaVersion ${JSON.stringify(schemaVersionValue)}. Supported versions: ${SUPPORTED_SCHEMA_VERSIONS.join(', ')}.`,
        'Use a supported schemaVersion or migrate the file explicitly. Validation never rewrites saved data.',
        {
          schemaVersion: schemaVersionValue,
          supported: [...SUPPORTED_SCHEMA_VERSIONS],
        },
      ),
    );
  }

  const nonFiniteFindings: NonFiniteFinding[] = [];
  findNonFiniteValues(input, '', new WeakSet<object>(), nonFiniteFindings);
  if (nonFiniteFindings.length > 0) {
    return {
      ok: false,
      schemaVersion: SONG_SCHEMA_VERSION,
      errors: normalizeIssues(
        nonFiniteFindings.map((finding) =>
          createIssue(
            'value.non_finite',
            finding.path,
            `${finding.value} is not a finite number and cannot be represented in JSON.`,
            'Replace the value with a finite number. NaN and Infinity are rejected.',
            { value: finding.value },
          ),
        ),
      ),
      warnings: [],
    };
  }

  const structure = validateSongStructure(input);
  if (!structure.valid) {
    return {
      ok: false,
      schemaVersion: SONG_SCHEMA_VERSION,
      errors: structure.issues,
      warnings: [],
    };
  }

  const song = input as unknown as SongSchemaV1;
  const semantics = validateSongSemantics(song, {
    ...(options.builtinInstrumentIds === undefined
      ? {}
      : { builtinInstrumentIds: options.builtinInstrumentIds }),
    ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
  });

  if (semantics.errors.length > 0) {
    return {
      ok: false,
      schemaVersion: SONG_SCHEMA_VERSION,
      errors: semantics.errors,
      warnings: semantics.warnings,
    };
  }

  return {
    ok: true,
    schemaVersion: SONG_SCHEMA_VERSION,
    song,
    normalized: normalizeSong(song),
    warnings: semantics.warnings,
    capabilityCheck: options.capabilities === undefined ? 'not_checked' : 'checked',
  };
}
