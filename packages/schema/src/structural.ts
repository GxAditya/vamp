import {
  appendJsonPointer,
  createIssue,
  normalizeIssues,
  type IssueCode,
  type IssueParameter,
  type IssueParams,
  type ValidationIssue,
} from './issues.js';
import {
  discriminatedUnionPathPatterns,
  discriminatedUnions,
  validateSongStructureRoot,
  type DiscriminatedUnionDefinition,
  type SchemaErrorObject,
} from './schema.js';

export interface StructureValidationResult {
  readonly valid: boolean;
  readonly issues: readonly ValidationIssue[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodePointerSegment(segment: string): string {
  return segment.replaceAll('~1', '/').replaceAll('~0', '~');
}

export function readValueAtJsonPointer(root: unknown, path: string): unknown {
  if (path === '') {
    return root;
  }
  if (!path.startsWith('/')) {
    return undefined;
  }
  let current: unknown = root;
  for (const encodedSegment of path.slice(1).split('/')) {
    const segment = decodePointerSegment(encodedSegment);
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/.test(segment)) {
        return undefined;
      }
      current = current[Number(segment)];
    } else if (isRecord(current)) {
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

function describeJsonType(value: unknown): string {
  if (value === undefined) {
    return 'missing';
  }
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value;
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return String(value);
  }
  return JSON.stringify(value) ?? String(value);
}

function toIssueParameter(value: unknown): IssueParameter {
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null
  ) {
    return value;
  }
  return JSON.stringify(value) ?? String(value);
}

function paramsOf(error: SchemaErrorObject): Record<string, unknown> {
  return error.params as Record<string, unknown>;
}

function numberParam(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  return typeof value === 'number' ? value : undefined;
}

function stringParam(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === 'string' ? value : undefined;
}

function allowedValuesParam(params: Record<string, unknown>): readonly string[] {
  const values = params.allowedValues;
  if (!Array.isArray(values)) {
    return [];
  }
  return values.map((value) => formatValue(value));
}

function issuePathForError(error: SchemaErrorObject): string {
  const instancePath = error.instancePath ?? '';
  const params = paramsOf(error);
  if (error.keyword === 'required') {
    const property = stringParam(params, 'missingProperty');
    return property === undefined ? instancePath : appendJsonPointer(instancePath, property);
  }
  if (error.keyword === 'additionalProperties') {
    const property = stringParam(params, 'additionalProperty');
    return property === undefined ? instancePath : appendJsonPointer(instancePath, property);
  }
  return instancePath;
}

function codeForKeyword(keyword: string): IssueCode {
  switch (keyword) {
    case 'type':
      return 'schema.structure.type';
    case 'required':
      return 'schema.structure.required';
    case 'additionalProperties':
    case 'unevaluatedProperties':
      return 'schema.structure.unknown_property';
    case 'const':
    case 'enum':
      return 'schema.structure.value_not_allowed';
    case 'pattern':
      return 'schema.structure.pattern_mismatch';
    case 'format':
      return 'schema.structure.format_invalid';
    case 'minimum':
    case 'maximum':
    case 'exclusiveMinimum':
    case 'exclusiveMaximum':
      return 'schema.structure.out_of_range';
    case 'minLength':
    case 'maxLength':
      return 'schema.structure.length_out_of_range';
    case 'minItems':
    case 'maxItems':
      return 'schema.structure.item_count_out_of_range';
    case 'uniqueItems':
      return 'schema.structure.duplicate_items';
    case 'minProperties':
    case 'maxProperties':
      return 'schema.structure.property_count_out_of_range';
    case 'oneOf':
    case 'anyOf':
      return 'schema.structure.variant_invalid';
    case 'not':
    case 'contains':
    case 'minContains':
    case 'maxContains':
    case 'dependentRequired':
      return 'schema.structure.constraint_failed';
    default:
      return 'schema.structure.invalid';
  }
}

function patternHint(path: string): string {
  if (path.endsWith('/path')) {
    return 'Use a project-relative forward-slash asset path ending in .sf2 or .sfz. Absolute paths, backslashes, and dot segments are rejected.';
  }
  if (path.endsWith('/instrument/id')) {
    return 'Use a lowercase builtin id such as "keys.soft" or "pad.warm".';
  }
  if (path.endsWith('/id') || path.endsWith('/pattern')) {
    return 'Use a lowercase identifier such as "keys" or "bass-line".';
  }
  return 'Correct the value to match the format documented in docs/schema-guide.md.';
}

function constraintHint(path: string): string {
  if (path.endsWith('/instrument')) {
    return 'Drums tracks cannot use the gm instrument variant. Choose builtin, soundfont, or sfz.';
  }
  if (path.includes('/effects/')) {
    return 'When filterCutoffHz automation is present, its single lowpass effect must omit cutoffHz. A static cutoff cannot coexist with cutoff automation.';
  }
  if (/^\/tracks\/\d+$/.test(path)) {
    return 'Static volume, pan, or lowpass cutoff cannot coexist with the matching automation target. Remove one form.';
  }
  return 'Remove or replace the conflicting field combination. See docs/schema-guide.md for allowed instrument, effect, and automation combinations.';
}

function requiredHint(path: string, property: string | undefined): string {
  if (property === 'effects' && /^\/tracks\/\d+$/.test(path)) {
    return 'Filter cutoff automation requires exactly one lowpass effect. Add effects with one lowpass entry.';
  }
  if (property !== undefined) {
    return `Add "${property}" with the required shape.`;
  }
  return 'Add the missing required property.';
}

function messageForError(
  error: SchemaErrorObject,
  path: string,
  root: unknown,
): { message: string; hint: string; params?: IssueParams } {
  const ajvParams = paramsOf(error);

  switch (error.keyword) {
    case 'type': {
      const expectedValue = ajvParams.type;
      const expected = Array.isArray(expectedValue)
        ? expectedValue.map((entry) => String(entry)).join(' or ')
        : String(expectedValue ?? 'the declared type');
      const actual = describeJsonType(readValueAtJsonPointer(root, path));
      return {
        message: `Expected ${expected}, received ${actual}.`,
        hint: `Use a JSON ${expected} value.`,
        params: { expectedType: expected, actualType: actual },
      };
    }
    case 'required': {
      const property = stringParam(ajvParams, 'missingProperty');
      return {
        message:
          property === undefined
            ? 'A required property is missing.'
            : `Missing required property "${property}".`,
        hint: requiredHint(path, property),
        ...(property === undefined ? {} : { params: { property } }),
      };
    }
    case 'additionalProperties': {
      const property = stringParam(ajvParams, 'additionalProperty');
      return {
        message:
          property === undefined
            ? 'An unknown property is present.'
            : `Unknown property "${property}".`,
        hint: 'Remove it or move the data into a field supported by SongSchemaV1. Unknown properties are rejected.',
        ...(property === undefined ? {} : { params: { property } }),
      };
    }
    case 'const': {
      const allowedValue = ajvParams.allowedValue;
      return {
        message: `Value must be exactly ${formatValue(allowedValue)}.`,
        hint: 'Use the exact allowed value.',
        params: { allowedValue: toIssueParameter(allowedValue) },
      };
    }
    case 'enum': {
      const allowedValues = Array.isArray(ajvParams.allowedValues) ? ajvParams.allowedValues : [];
      return {
        message: `Value must be one of: ${allowedValues.map((value) => formatValue(value)).join(', ')}.`,
        hint: 'Use one of the allowed values listed in the message.',
        params: { allowedValues: allowedValuesParam(ajvParams) },
      };
    }
    case 'pattern':
      return {
        message: 'Value has an invalid format for this field.',
        hint: patternHint(path),
        params: {
          pattern: typeof ajvParams.pattern === 'string' ? ajvParams.pattern : '',
        },
      };
    case 'format':
      return {
        message: `Value is not a valid ${String(ajvParams.format ?? 'formatted')} string.`,
        hint: 'Use a valid RFC 3339 date-time such as 2026-01-01T00:00:00Z.',
        params: { format: String(ajvParams.format ?? '') },
      };
    case 'minimum':
    case 'maximum':
    case 'exclusiveMinimum':
    case 'exclusiveMaximum': {
      const limit = numberParam(ajvParams, 'limit');
      const comparison = stringParam(ajvParams, 'comparison');
      return {
        message:
          limit === undefined
            ? 'Value is outside its allowed range.'
            : `Value must be ${comparison ?? error.keyword} ${limit}.`,
        hint: 'Change the value so it lies within the documented range.',
        ...(limit === undefined
          ? {}
          : { params: { limit, comparison: comparison ?? error.keyword } }),
      };
    }
    case 'minLength':
    case 'maxLength': {
      const limit = numberParam(ajvParams, 'limit');
      return {
        message:
          error.keyword === 'minLength'
            ? `String must contain at least ${String(limit)} characters.`
            : `String must contain at most ${String(limit)} characters.`,
        hint: 'Adjust the string length.',
        ...(limit === undefined ? {} : { params: { limit } }),
      };
    }
    case 'minItems':
    case 'maxItems': {
      const limit = numberParam(ajvParams, 'limit');
      return {
        message:
          error.keyword === 'minItems'
            ? `Array must contain at least ${String(limit)} items.`
            : `Array must contain at most ${String(limit)} items.`,
        hint: 'Adjust the number of array items.',
        ...(limit === undefined ? {} : { params: { limit } }),
      };
    }
    case 'uniqueItems':
      return {
        message: 'Array items must be unique.',
        hint: 'Remove or merge duplicate array items.',
      };
    case 'minProperties':
    case 'maxProperties': {
      const limit = numberParam(ajvParams, 'limit');
      return {
        message:
          error.keyword === 'minProperties'
            ? `Object must contain at least ${String(limit)} properties.`
            : `Object must contain at most ${String(limit)} properties.`,
        hint: 'Adjust the number of object properties.',
        ...(limit === undefined ? {} : { params: { limit } }),
      };
    }
    case 'contains': {
      const maximum = numberParam(ajvParams, 'maxContains');
      const minimum = numberParam(ajvParams, 'minContains');
      const params: Record<string, IssueParameter> = {};
      if (maximum !== undefined) {
        params.maxContains = maximum;
      }
      if (minimum !== undefined) {
        params.minContains = minimum;
      }
      return {
        message:
          maximum !== undefined
            ? `Array contains more than ${maximum} matching item(s).`
            : minimum !== undefined
              ? `Array contains fewer than ${minimum} matching item(s).`
              : 'Array does not satisfy its contains constraint.',
        hint:
          path === '/tracks'
            ? 'Only one track in a song may have kind "drums".'
            : 'Adjust the matching array items.',
        ...(Object.keys(params).length === 0 ? {} : { params }),
      };
    }
    case 'not':
      return {
        message: 'This combination of fields is not allowed.',
        hint: constraintHint(path),
      };
    case 'oneOf':
      return {
        message: 'Value must match exactly one allowed variant.',
        hint: 'Set the discriminator "type" and include only fields for that variant.',
      };
    case 'anyOf':
      return {
        message: 'Value must match at least one allowed shape.',
        hint: 'Include the required fields for one allowed shape.',
      };
    default:
      return {
        message: 'Value does not satisfy a SongSchemaV1 structural constraint.',
        hint: 'Correct the value according to docs/schema-guide.md.',
      };
  }
}

function mapError(error: SchemaErrorObject, root: unknown, pathPrefix = ''): ValidationIssue {
  const basePath = issuePathForError(error);
  const path = `${pathPrefix}${basePath}`;
  const { message, hint, params } = messageForError(error, path, root);
  return createIssue(codeForKeyword(error.keyword), path, message, hint, params);
}

function unionForError(
  error: SchemaErrorObject,
  root: unknown,
): DiscriminatedUnionDefinition | undefined {
  if (error.keyword !== 'oneOf') {
    return undefined;
  }

  const path = error.instancePath ?? '';
  for (const [unionKey, union] of discriminatedUnions) {
    const patterns = discriminatedUnionPathPatterns.get(unionKey) ?? [];
    if (patterns.some((pattern) => pattern.test(path))) {
      return union;
    }
  }

  const value = readValueAtJsonPointer(root, path);
  if (isRecord(value) && typeof value.type === 'string') {
    for (const union of discriminatedUnions.values()) {
      if (union.variantsByType.has(value.type)) {
        return union;
      }
    }
  }

  return undefined;
}

function isAtOrBelow(path: string, ancestor: string): boolean {
  return path === ancestor || path.startsWith(`${ancestor}/`);
}

function reduceDiscriminatedUnion(
  union: DiscriminatedUnionDefinition,
  unionPath: string,
  root: unknown,
): ValidationIssue[] {
  const value = readValueAtJsonPointer(root, unionPath);
  if (!isRecord(value)) {
    const actual = describeJsonType(value);
    return [
      createIssue(
        'schema.structure.type',
        unionPath,
        `Expected object, received ${actual}.`,
        'Set this field to an object with a discriminator "type".',
        { expectedType: 'object', actualType: actual },
      ),
    ];
  }

  const typeValue = value.type;
  if (typeValue === undefined) {
    return [
      createIssue(
        'schema.structure.required',
        `${unionPath}/type`,
        'Missing required property "type".',
        `Add "type" with one of: ${union.allowedTypes.map((entry) => `"${entry}"`).join(', ')}.`,
        { property: 'type' },
      ),
    ];
  }

  if (typeof typeValue !== 'string') {
    return [
      createIssue(
        'schema.structure.type',
        `${unionPath}/type`,
        `Expected the discriminator "type" to be a string, received ${describeJsonType(typeValue)}.`,
        `Use one of: ${union.allowedTypes.map((entry) => `"${entry}"`).join(', ')}.`,
        { expectedType: 'string', actualType: describeJsonType(typeValue) },
      ),
    ];
  }

  const variant = union.variantsByType.get(typeValue);
  if (!variant) {
    return [
      createIssue(
        'schema.structure.value_not_allowed',
        `${unionPath}/type`,
        `Unknown ${union.unionKey} type "${typeValue}".`,
        `Use one of: ${union.allowedTypes.map((entry) => `"${entry}"`).join(', ')}.`,
        { allowedValues: union.allowedTypes },
      ),
    ];
  }

  const accepted = variant.validate(value);
  if (accepted) {
    return [];
  }

  return (variant.validate.errors ?? []).map((error) => mapError(error, root, unionPath));
}

/**
 * Validate only the JSON Schema structure. Errors are reduced to clean,
 * discriminator-aware issues; raw Ajv error objects never cross this boundary.
 * Ajv defaults are disabled and validation does not mutate the input.
 */
export function validateSongStructure(input: unknown): StructureValidationResult {
  const valid = validateSongStructureRoot(input);
  if (valid) {
    return { valid: true, issues: [] };
  }

  const errors = validateSongStructureRoot.errors ?? [];
  if (errors.length === 0) {
    return {
      valid: false,
      issues: [
        createIssue(
          'schema.structure.invalid',
          '',
          'Structural validation failed.',
          'Correct the song data.',
        ),
      ],
    };
  }

  const unionGroups = new Map<string, DiscriminatedUnionDefinition>();
  for (const error of errors) {
    const union = unionForError(error, input);
    if (union) {
      unionGroups.set(error.instancePath ?? '', union);
    }
  }

  const trackAnyOfPaths = new Set(
    errors
      .filter(
        (error) => error.keyword === 'anyOf' && /^\/tracks\/\d+$/.test(error.instancePath ?? ''),
      )
      .map((error) => error.instancePath ?? ''),
  );

  const issuePrefixes = [...unionGroups.keys()];
  const issues: ValidationIssue[] = [];

  for (const error of errors) {
    if (error.keyword === 'if') {
      continue;
    }
    const instancePath = error.instancePath ?? '';
    if (issuePrefixes.some((prefix) => isAtOrBelow(instancePath, prefix))) {
      continue;
    }
    if (
      trackAnyOfPaths.has(instancePath) &&
      (error.keyword === 'anyOf' ||
        (error.keyword === 'required' &&
          ['notes', 'placements'].includes(stringParam(paramsOf(error), 'missingProperty') ?? '')))
    ) {
      continue;
    }
    issues.push(mapError(error, input));
  }

  for (const [unionPath, union] of unionGroups) {
    issues.push(...reduceDiscriminatedUnion(union, unionPath, input));
  }

  for (const trackPath of trackAnyOfPaths) {
    issues.push(
      createIssue(
        'schema.structure.constraint_failed',
        trackPath,
        'Track must include notes, placements, or both.',
        'Add a non-empty notes array, a non-empty placements array, or both.',
      ),
    );
  }

  return { valid: false, issues: normalizeIssues(issues) };
}
