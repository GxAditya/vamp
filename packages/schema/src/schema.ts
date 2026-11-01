import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';

import type { AnySchema, ErrorObject, ValidateFunction } from 'ajv';

import { SONG_SCHEMA_ID, SONG_SCHEMA_VERSION } from './version.js';

const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => Ajv2020;

const schemaUrl = new URL('../schema/song.schema.json', import.meta.url);

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

function createAjv(): Ajv2020 {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    useDefaults: false,
    coerceTypes: false,
    validateFormats: true,
    ownProperties: true,
  });
  addFormats(ajv);
  return ajv;
}

function loadSchemaDocument(): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(fileURLToPath(schemaUrl), 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('The canonical song schema must be a JSON object.');
  }
  const document = parsed as Record<string, unknown>;
  if (document.$id !== SONG_SCHEMA_ID) {
    throw new Error(
      `The canonical song schema has unexpected $id ${JSON.stringify(document.$id)}.`,
    );
  }
  const properties = document.properties;
  if (
    typeof properties !== 'object' ||
    properties === null ||
    Array.isArray(properties) ||
    (properties as Record<string, unknown>).schemaVersion === undefined
  ) {
    throw new Error('The canonical song schema does not declare properties.schemaVersion.');
  }
  return document;
}

/** Frozen canonical schema document, loaded package-relative, never from cwd. */
export const SONG_SCHEMA_DOCUMENT = deepFreeze(loadSchemaDocument());

export function getSongSchemaV1(): Readonly<Record<string, unknown>> {
  return SONG_SCHEMA_DOCUMENT;
}

const schemaVersionProperty = (SONG_SCHEMA_DOCUMENT.properties as Record<string, unknown>)
  .schemaVersion as Record<string, unknown>;
if (schemaVersionProperty.const !== SONG_SCHEMA_VERSION) {
  throw new Error('The canonical song schema schemaVersion const does not match this package.');
}

const ajv = createAjv();
export const validateSongStructureRoot: ValidateFunction = ajv.compile(
  SONG_SCHEMA_DOCUMENT as AnySchema,
);

export interface VariantDefinition {
  readonly definitionKey: string;
  readonly typeValue: string;
  readonly validate: ValidateFunction;
}

export interface DiscriminatedUnionDefinition {
  readonly unionKey: string;
  readonly variantsByType: ReadonlyMap<string, VariantDefinition>;
  readonly allowedTypes: readonly string[];
}

function buildDiscriminatedUnions(): Map<string, DiscriminatedUnionDefinition> {
  const definitions = (SONG_SCHEMA_DOCUMENT.$defs ?? {}) as Record<string, unknown>;
  const unions = new Map<string, DiscriminatedUnionDefinition>();

  for (const [unionKey, definition] of Object.entries(definitions)) {
    if (
      typeof definition !== 'object' ||
      definition === null ||
      Array.isArray(definition) ||
      !Array.isArray((definition as Record<string, unknown>).oneOf)
    ) {
      continue;
    }

    const variants = new Map<string, VariantDefinition>();
    let supported = true;

    for (const member of (definition as Record<string, unknown>).oneOf as unknown[]) {
      if (
        typeof member !== 'object' ||
        member === null ||
        Array.isArray(member) ||
        typeof (member as Record<string, unknown>).$ref !== 'string'
      ) {
        supported = false;
        break;
      }
      const reference = (member as Record<string, unknown>).$ref as string;
      const prefix = '#/$defs/';
      if (!reference.startsWith(prefix)) {
        supported = false;
        break;
      }
      const definitionKey = reference.slice(prefix.length);
      const variantDefinition = definitions[definitionKey];
      if (
        typeof variantDefinition !== 'object' ||
        variantDefinition === null ||
        Array.isArray(variantDefinition)
      ) {
        supported = false;
        break;
      }
      const properties = (variantDefinition as Record<string, unknown>).properties;
      if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
        supported = false;
        break;
      }
      const typeProperty = (properties as Record<string, unknown>).type;
      if (
        typeof typeProperty !== 'object' ||
        typeProperty === null ||
        Array.isArray(typeProperty) ||
        typeof (typeProperty as Record<string, unknown>).const !== 'string'
      ) {
        supported = false;
        break;
      }
      const typeValue = (typeProperty as Record<string, unknown>).const as string;
      const compiled = ajv.getSchema(`${SONG_SCHEMA_ID}#/$defs/${definitionKey}`);
      if (!compiled) {
        throw new Error(`Ajv did not expose variant schema $defs/${definitionKey}.`);
      }
      variants.set(typeValue, {
        definitionKey,
        typeValue,
        validate: compiled,
      });
    }

    if (supported && variants.size > 0) {
      unions.set(unionKey, {
        unionKey,
        variantsByType: variants,
        allowedTypes: [...variants.keys()],
      });
    }
  }

  return unions;
}

export const discriminatedUnions: ReadonlyMap<string, DiscriminatedUnionDefinition> =
  buildDiscriminatedUnions();

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildUnionPathPatterns(): Map<string, RegExp[]> {
  const patterns = new Map<string, RegExp[]>();
  for (const unionKey of discriminatedUnions.keys()) {
    patterns.set(unionKey, []);
  }

  const rootContainers: unknown[] = [SONG_SCHEMA_DOCUMENT];
  const definitions = (SONG_SCHEMA_DOCUMENT.$defs ?? {}) as Record<string, unknown>;
  rootContainers.push(...Object.values(definitions));

  for (const container of rootContainers) {
    if (typeof container !== 'object' || container === null || Array.isArray(container)) {
      continue;
    }
    const properties = (container as Record<string, unknown>).properties;
    if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
      continue;
    }
    for (const [propertyName, propertySchema] of Object.entries(
      properties as Record<string, unknown>,
    )) {
      if (
        typeof propertySchema !== 'object' ||
        propertySchema === null ||
        Array.isArray(propertySchema)
      ) {
        continue;
      }
      const property = propertySchema as Record<string, unknown>;
      const escapedName = escapeRegExp(propertyName);

      const reference = typeof property.$ref === 'string' ? property.$ref : undefined;
      if (reference?.startsWith('#/$defs/')) {
        const unionKey = reference.slice('#/$defs/'.length);
        const list = patterns.get(unionKey);
        if (list) {
          list.push(new RegExp(`/${escapedName}$`));
        }
      }

      const items = property.items;
      if (typeof items === 'object' && items !== null && !Array.isArray(items)) {
        const itemReference = (items as Record<string, unknown>).$ref;
        if (typeof itemReference === 'string' && itemReference.startsWith('#/$defs/')) {
          const unionKey = itemReference.slice('#/$defs/'.length);
          const list = patterns.get(unionKey);
          if (list) {
            list.push(new RegExp(`/${escapedName}/\\d+$`));
          }
        }
      }
    }
  }

  return patterns;
}

export const discriminatedUnionPathPatterns: ReadonlyMap<string, readonly RegExp[]> =
  buildUnionPathPatterns();

export type SchemaErrorObject = ErrorObject;
