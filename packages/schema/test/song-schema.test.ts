import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { describe, expect, it } from 'vitest';

import type { AnySchema, ErrorObject, ValidateFunction } from 'ajv';

const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => Ajv2020;

type UnknownRecord = Record<string, unknown>;

interface FixtureCase {
  name: string;
  data: unknown;
}

interface TrackShape {
  kind: string;
  instrument: { type: string };
  effects?: Array<{ type: string }>;
  notes?: unknown[];
  placements?: unknown[];
  automation?: Record<string, unknown>;
}

interface SongShape {
  tracks: TrackShape[];
  patterns?: Array<{ notes: unknown[] }>;
}

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const schemaPath = join(packageRoot, 'schema', 'song.schema.json');
const fixturesRoot = join(packageRoot, 'fixtures');

const songSchema = JSON.parse(readFileSync(schemaPath, 'utf8')) as UnknownRecord;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function createAjv(): Ajv2020 {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv;
}

function formatErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) {
    return 'no validation errors recorded';
  }
  return errors
    .map((error) => `${error.instancePath || '/'} [${error.keyword}] ${error.message ?? ''}`)
    .join('\n');
}

function loadFixtures(kind: 'valid' | 'invalid'): FixtureCase[] {
  const directory = join(fixturesRoot, kind);
  return readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => ({
      name,
      data: JSON.parse(readFileSync(join(directory, name), 'utf8')) as unknown,
    }));
}

function collectObjectSchemas(
  node: unknown,
  path: string,
  found: Array<{ path: string; schema: UnknownRecord }>,
): void {
  if (!isRecord(node)) {
    return;
  }
  if (node.type === 'object') {
    found.push({ path, schema: node });
  }
  for (const key of ['$defs', 'properties', 'items', 'oneOf']) {
    const value = node[key];
    if (Array.isArray(value)) {
      value.forEach((entry, index) => {
        collectObjectSchemas(entry, `${path}/${key}/${String(index)}`, found);
      });
      continue;
    }
    if (isRecord(value)) {
      for (const [name, entry] of Object.entries(value)) {
        collectObjectSchemas(entry, `${path}/${key}/${name}`, found);
      }
    }
  }
}

const ajv = createAjv();
const validate: ValidateFunction = ajv.compile(songSchema as AnySchema);
const validFixtures = loadFixtures('valid');
const invalidFixtures = loadFixtures('invalid');

describe('SongSchemaV1 document', () => {
  it('uses JSON Schema draft 2020-12 with a stable identifier', () => {
    expect(songSchema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(songSchema.$id).toBe('urn:vamp:schema:song:1.0.0');
    expect(songSchema.title).toBe('Vamp Song Schema v1.0.0');
  });

  it('pins schemaVersion to 1.0.0', () => {
    const properties = songSchema.properties as UnknownRecord;
    const schemaVersion = properties.schemaVersion as UnknownRecord;
    expect(schemaVersion.const).toBe('1.0.0');
  });

  it('validates against its metaschema', () => {
    const metaschemaAjv = createAjv();
    expect(
      metaschemaAjv.validateSchema(songSchema as AnySchema),
      formatErrors(metaschemaAjv.errors),
    ).toBe(true);
  });

  it('describes every declared property and closes every object shape', () => {
    const objectSchemas: Array<{ path: string; schema: UnknownRecord }> = [];
    collectObjectSchemas(songSchema, '#', objectSchemas);
    expect(objectSchemas.length).toBeGreaterThan(0);

    for (const { path, schema } of objectSchemas) {
      expect(schema.additionalProperties, `${path} must set additionalProperties: false`).toBe(
        false,
      );
      const properties = schema.properties;
      expect(isRecord(properties), `${path} must declare properties`).toBe(true);
      for (const [name, property] of Object.entries(properties as UnknownRecord)) {
        expect(
          isRecord(property) && typeof property.description === 'string',
          `${path}/properties/${name} must have a description`,
        ).toBe(true);
      }
    }
  });

  it('gives every definition a title and description', () => {
    const definitions = songSchema.$defs as UnknownRecord;
    expect(Object.keys(definitions).length).toBeGreaterThan(0);
    for (const [name, definition] of Object.entries(definitions)) {
      expect(isRecord(definition), `$defs/${name} must be an object`).toBe(true);
      expect(
        isRecord(definition) && typeof definition.title === 'string',
        `$defs/${name} must have a title`,
      ).toBe(true);
      expect(
        isRecord(definition) && typeof definition.description === 'string',
        `$defs/${name} must have a description`,
      ).toBe(true);
    }
  });
});

describe('schema fixtures', () => {
  it('includes a usable set of valid and invalid fixtures', () => {
    expect(validFixtures.length).toBeGreaterThanOrEqual(7);
    expect(invalidFixtures.length).toBeGreaterThanOrEqual(15);
  });

  for (const fixture of validFixtures) {
    it(`accepts valid fixture ${fixture.name}`, () => {
      const accepted = validate(fixture.data);
      expect(accepted, formatErrors(validate.errors)).toBe(true);
    });
  }

  for (const fixture of invalidFixtures) {
    it(`rejects invalid fixture ${fixture.name}`, () => {
      const accepted = validate(fixture.data);
      expect(accepted).toBe(false);
      expect(validate.errors?.length ?? 0).toBeGreaterThan(0);
    });
  }

  it('covers every instrument variant, effect type, and automation target', () => {
    const songs = validFixtures.map((fixture) => fixture.data as SongShape);
    const tracks = songs.flatMap((song) => song.tracks);

    expect(new Set(tracks.map((track) => track.instrument.type))).toEqual(
      new Set(['builtin', 'gm', 'soundfont', 'sfz']),
    );
    expect(
      new Set(tracks.flatMap((track) => track.effects ?? []).map((effect) => effect.type)),
    ).toEqual(new Set(['reverb', 'delay', 'eq', 'lowpass']));
    expect(new Set(tracks.flatMap((track) => Object.keys(track.automation ?? {})))).toEqual(
      new Set(['volume', 'pan', 'filterCutoffHz']),
    );
    expect(tracks.some((track) => track.kind === 'drums')).toBe(true);
    expect(tracks.some((track) => track.notes !== undefined)).toBe(true);
    expect(tracks.some((track) => track.placements !== undefined)).toBe(true);
    expect(songs.some((song) => (song.patterns?.length ?? 0) > 0)).toBe(true);
    expect(validFixtures.some((fixture) => fixture.name === 'minimal.song.json')).toBe(true);
  });

  it('does not apply defaults while validating', () => {
    const minimal = validFixtures.find((fixture) => fixture.name === 'minimal.song.json');
    if (!minimal) {
      throw new Error('minimal.song.json fixture is missing');
    }

    const input = structuredClone(minimal.data) as SongShape;
    const before = JSON.stringify(input);

    expect(validate(input), formatErrors(validate.errors)).toBe(true);
    expect(JSON.stringify(input)).toBe(before);

    const notes = input.tracks[0]?.notes?.[0];
    expect(isRecord(notes) ? 'velocity' in notes : false).toBe(false);
  });
});
