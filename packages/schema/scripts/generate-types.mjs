#!/usr/bin/env node
/**
 * Generate TypeScript and Python types from the canonical SongSchemaV1 JSON
 * Schema. Output is deterministic: the same schema and generator version always
 * produce byte-identical files.
 *
 * Usage:
 *   node scripts/generate-types.mjs          Write generated files.
 *   node scripts/generate-types.mjs --check  Fail when checked-in files drift.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));
const schemaPath = join(packageRoot, 'schema', 'song.schema.json');
const schemaRelativePath = 'packages/schema/schema/song.schema.json';

const ROOT_TYPE_NAME = 'SongSchemaV1';
const TYPE_NAME_OVERRIDES = new Map([
  ['id', 'EntityId'],
  ['meta', 'SongMeta'],
  ['key', 'SongKey'],
]);
const REF_PREFIX = '#/$defs/';

const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
const schemaVersion = schema.properties?.schemaVersion?.const;

if (typeof schemaVersion !== 'string') {
  throw new Error('song.schema.json does not declare properties.schemaVersion.const.');
}

function typeNameForDefinition(definitionKey) {
  const override = TYPE_NAME_OVERRIDES.get(definitionKey);
  if (override) {
    return override;
  }
  return definitionKey
    .split(/[-_]/)
    .filter((segment) => segment.length > 0)
    .map((segment) => `${segment.charAt(0).toUpperCase()}${segment.slice(1)}`)
    .join('');
}

function referenceTypeName(reference) {
  if (typeof reference !== 'string' || !reference.startsWith(REF_PREFIX)) {
    throw new Error(`Unsupported $ref: ${String(reference)}`);
  }
  return typeNameForDefinition(reference.slice(REF_PREFIX.length));
}

function stringLiteral(value) {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

function numericLiteral(value) {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`Cannot generate a type for non-finite enum value ${String(value)}.`);
    }
    return String(value);
  }
  if (typeof value === 'string') {
    return stringLiteral(value);
  }
  throw new Error(`Unsupported literal value: ${JSON.stringify(value)}`);
}

function tsTypeFor(node) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    return 'unknown';
  }
  if (typeof node.$ref === 'string') {
    return referenceTypeName(node.$ref);
  }
  if ('const' in node) {
    return numericLiteral(node.const);
  }
  if (Array.isArray(node.enum)) {
    return node.enum.map((value) => numericLiteral(value)).join(' | ');
  }
  if (Array.isArray(node.oneOf)) {
    return node.oneOf.map((member) => tsTypeFor(member)).join(' | ');
  }
  if (Array.isArray(node.anyOf)) {
    return node.anyOf.map((member) => tsTypeFor(member)).join(' | ');
  }
  if (Array.isArray(node.allOf)) {
    const reference = node.allOf.find((member) => typeof member.$ref === 'string');
    if (reference) {
      return tsTypeFor(reference);
    }
    return node.allOf.map((member) => `(${tsTypeFor(member)})`).join(' & ');
  }

  const type = node.type;
  if (Array.isArray(type)) {
    return type.map((entry) => tsTypeFor({ ...node, type: entry })).join(' | ');
  }

  switch (type) {
    case 'string':
      return 'string';
    case 'integer':
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    case 'array': {
      const itemType = node.items === undefined ? 'unknown' : tsTypeFor(node.items);
      return `${itemType}[]`;
    }
    case 'object': {
      if (node.properties && typeof node.properties === 'object') {
        const required = new Set(Array.isArray(node.required) ? node.required : []);
        const members = Object.entries(node.properties).map(([propertyName, propertySchema]) => {
          const optional = required.has(propertyName) ? '' : '?';
          return `${propertyName}${optional}: ${tsTypeFor(propertySchema)}`;
        });
        return `{ ${members.join('; ')} }`;
      }
      return 'Record<string, unknown>';
    }
    default:
      return 'unknown';
  }
}

function renderTsInterface(name, objectSchema) {
  const required = new Set(Array.isArray(objectSchema.required) ? objectSchema.required : []);
  const lines = [`export interface ${name} {`];
  for (const [propertyName, propertySchema] of Object.entries(objectSchema.properties ?? {})) {
    const optional = required.has(propertyName) ? '' : '?';
    lines.push(`  ${propertyName}${optional}: ${tsTypeFor(propertySchema)};`);
  }
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

function generateTypeScript() {
  const header = [
    `// DO NOT EDIT. Generated from ${schemaRelativePath}`,
    '// by packages/schema/scripts/generate-types.mjs.',
    '// Regenerate from the repository root with: pnpm generate:types',
  ].join('\n');

  const parts = [header, ''];
  parts.push(renderTsInterface(ROOT_TYPE_NAME, schema));

  for (const [definitionKey, definition] of Object.entries(schema.$defs ?? {})) {
    const name = typeNameForDefinition(definitionKey);
    if (definition.type === 'object' && definition.properties !== undefined) {
      parts.push(renderTsInterface(name, definition));
    } else {
      parts.push(`export type ${name} = ${tsTypeFor(definition)};\n`);
    }
  }

  return `${parts.join('\n')}\n`;
}

function pyTypeFor(node) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    return 'object';
  }
  if (typeof node.$ref === 'string') {
    return referenceTypeName(node.$ref);
  }
  if ('const' in node) {
    return `Literal[${pyLiteral(node.const)}]`;
  }
  if (Array.isArray(node.enum)) {
    return `Literal[${node.enum.map((value) => pyLiteral(value)).join(', ')}]`;
  }
  if (Array.isArray(node.oneOf)) {
    return `Union[${node.oneOf.map((member) => pyTypeFor(member)).join(', ')}]`;
  }
  if (Array.isArray(node.anyOf)) {
    return `Union[${node.anyOf.map((member) => pyTypeFor(member)).join(', ')}]`;
  }
  if (Array.isArray(node.allOf)) {
    const reference = node.allOf.find((member) => typeof member.$ref === 'string');
    if (reference) {
      return pyTypeFor(reference);
    }
    return 'object';
  }

  const type = node.type;
  if (Array.isArray(type)) {
    return `Union[${type.map((entry) => pyTypeFor({ ...node, type: entry })).join(', ')}]`;
  }

  switch (type) {
    case 'string':
      return 'str';
    case 'integer':
      return 'int';
    case 'number':
      return 'float';
    case 'boolean':
      return 'bool';
    case 'null':
      return 'None';
    case 'array': {
      const itemType = node.items === undefined ? 'object' : pyTypeFor(node.items);
      return `list[${itemType}]`;
    }
    case 'object':
      return 'dict[str, object]';
    default:
      return 'object';
  }
}

function pyLiteral(value) {
  if (value === null) {
    return 'None';
  }
  if (typeof value === 'boolean') {
    return value ? 'True' : 'False';
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`Cannot generate a type for non-finite enum value ${String(value)}.`);
    }
    return String(value);
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  throw new Error(`Unsupported literal value: ${JSON.stringify(value)}`);
}

function renderPythonClass(name, objectSchema) {
  const required = new Set(Array.isArray(objectSchema.required) ? objectSchema.required : []);
  const entries = Object.entries(objectSchema.properties ?? {});
  const requiredEntries = entries.filter(([propertyName]) => required.has(propertyName));
  const optionalEntries = entries.filter(([propertyName]) => !required.has(propertyName));

  if (optionalEntries.length === 0) {
    const lines = [`class ${name}(TypedDict):`];
    if (entries.length === 0) {
      lines.push('    pass');
    } else {
      for (const [propertyName, propertySchema] of entries) {
        lines.push(`    ${propertyName}: ${pyTypeFor(propertySchema)}`);
      }
    }
    return `${lines.join('\n')}\n`;
  }

  if (requiredEntries.length === 0) {
    const lines = [`class ${name}(TypedDict, total=False):`];
    for (const [propertyName, propertySchema] of entries) {
      lines.push(`    ${propertyName}: ${pyTypeFor(propertySchema)}`);
    }
    return `${lines.join('\n')}\n`;
  }

  // A required base plus a total=False subclass keeps optional keys accurate
  // even though annotations are postponed by "from __future__ import annotations".
  const baseName = `_${name}Required`;
  const lines = [`class ${baseName}(TypedDict):`];
  for (const [propertyName, propertySchema] of requiredEntries) {
    lines.push(`    ${propertyName}: ${pyTypeFor(propertySchema)}`);
  }
  lines.push('');
  lines.push(`class ${name}(${baseName}, total=False):`);
  for (const [propertyName, propertySchema] of optionalEntries) {
    lines.push(`    ${propertyName}: ${pyTypeFor(propertySchema)}`);
  }
  return `${lines.join('\n')}\n`;
}

function generatePythonModule() {
  const header = [
    `# DO NOT EDIT. Generated from ${schemaRelativePath}`,
    '# by packages/schema/scripts/generate-types.mjs.',
    '# Regenerate from the repository root with: pnpm generate:types',
  ].join('\n');

  const definitions = Object.entries(schema.$defs ?? {});
  const parts = [
    header,
    '',
    '"""Generated type declarations for Vamp SongSchemaV1.',
    '',
    'These TypedDicts mirror the canonical JSON Schema. They describe data and do',
    'not validate it; the TypeScript package validator remains authoritative.',
    '"""',
    '',
    'from __future__ import annotations',
    '',
    'from typing import Final, Literal, TypedDict, Union',
    '',
    `SONG_SCHEMA_VERSION: Final = ${JSON.stringify(schemaVersion)}`,
    '',
  ];

  const exportNames = ['SONG_SCHEMA_VERSION'];

  // Primitive aliases first so runtime helpers can resolve them.
  for (const [definitionKey, definition] of definitions) {
    const name = typeNameForDefinition(definitionKey);
    const isObject = definition.type === 'object' && definition.properties !== undefined;
    const isUnion =
      !isObject && (Array.isArray(definition.oneOf) || Array.isArray(definition.anyOf));
    if (!isObject && !isUnion) {
      parts.push(`${name} = ${pyTypeFor(definition)}\n`);
      exportNames.push(name);
    }
  }

  // Object definitions next. Forward references in annotations resolve once the
  // module has finished loading.
  for (const [definitionKey, definition] of definitions) {
    if (definition.type === 'object' && definition.properties !== undefined) {
      const name = typeNameForDefinition(definitionKey);
      parts.push(renderPythonClass(name, definition));
      exportNames.push(name);
    }
  }

  parts.push(renderPythonClass(ROOT_TYPE_NAME, schema));
  exportNames.push(ROOT_TYPE_NAME);

  // Union aliases last because these assignments are evaluated at runtime.
  for (const [definitionKey, definition] of definitions) {
    const isObject = definition.type === 'object' && definition.properties !== undefined;
    const isUnion =
      !isObject && (Array.isArray(definition.oneOf) || Array.isArray(definition.anyOf));
    if (isUnion) {
      const name = typeNameForDefinition(definitionKey);
      parts.push(`${name} = ${pyTypeFor(definition)}\n`);
      exportNames.push(name);
    }
  }

  parts.push(
    `__all__ = [\n${exportNames.map((name) => `    ${JSON.stringify(name)},`).join('\n')}\n]\n`,
  );

  return `${parts.join('\n')}\n`;
}

function generatePythonPackage() {
  return [
    `# DO NOT EDIT. Generated from ${schemaRelativePath}`,
    '# by packages/schema/scripts/generate-types.mjs.',
    '# Regenerate from the repository root with: pnpm generate:types',
    '',
    '"""Generated Python type declarations for the Vamp song schema."""',
    '',
    'from .song_v1 import *',
    'from .song_v1 import __all__ as __all__',
    '',
  ].join('\n');
}

const outputs = [
  {
    path: join(packageRoot, 'src', 'generated', 'song-v1.ts'),
    content: generateTypeScript(),
  },
  {
    path: join(packageRoot, 'python', 'vamp_schema', 'song_v1.py'),
    content: generatePythonModule(),
  },
  {
    path: join(packageRoot, 'python', 'vamp_schema', '__init__.py'),
    content: generatePythonPackage(),
  },
];

const checkOnly = process.argv.includes('--check');
const failures = [];

for (const output of outputs) {
  let current;
  try {
    current = readFileSync(output.path, 'utf8');
  } catch {
    current = undefined;
  }

  if (current === output.content) {
    continue;
  }

  const displayPath = relative(repositoryRoot, output.path);

  if (checkOnly) {
    failures.push(current === undefined ? `${displayPath} is missing` : `${displayPath} is stale`);
    continue;
  }

  mkdirSync(dirname(output.path), { recursive: true });
  writeFileSync(output.path, output.content, 'utf8');
  process.stdout.write(`Wrote ${displayPath}\n`);
}

if (checkOnly) {
  if (failures.length > 0) {
    process.stderr.write(
      `Generated schema types are out of date:\n${failures.map((entry) => `  ${entry}`).join('\n')}\nRun "pnpm generate:types" from the repository root.\n`,
    );
    process.exitCode = 1;
  } else {
    process.stdout.write('Generated schema types are up to date.\n');
  }
}
