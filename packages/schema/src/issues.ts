/**
 * Public validation issue types and the authoritative issue code reference.
 *
 * Every issue returned by the validator is JSON serializable, has a stable
 * code, and uses a JSON Pointer path. Paths use the empty string for the
 * document root and escape "~" as "~0" and "/" as "~1".
 */

export type IssueSeverity = 'error' | 'warning';

export interface IssueCodeDefinition {
  readonly code: string;
  readonly severity: IssueSeverity;
  readonly description: string;
}

/**
 * Machine-readable reference for every public issue code. CLI, SDK, and MCP
 * adapters can use this to explain codes without maintaining a second list.
 */
export const ISSUE_CODE_REFERENCE = [
  {
    code: 'schema.document.invalid',
    severity: 'error',
    description: 'The input is not a JSON object and cannot be version-dispatched.',
  },
  {
    code: 'schema.version.missing',
    severity: 'error',
    description: 'The input object has no schemaVersion.',
  },
  {
    code: 'schema.version.unsupported',
    severity: 'error',
    description: 'The schemaVersion is not a supported version string.',
  },
  {
    code: 'schema.structure.type',
    severity: 'error',
    description: 'A value has the wrong JSON type.',
  },
  {
    code: 'schema.structure.required',
    severity: 'error',
    description: 'A required property is missing.',
  },
  {
    code: 'schema.structure.unknown_property',
    severity: 'error',
    description: 'An object contains a property not allowed by SongSchemaV1.',
  },
  {
    code: 'schema.structure.value_not_allowed',
    severity: 'error',
    description: 'A value is outside a const or enum allowlist.',
  },
  {
    code: 'schema.structure.pattern_mismatch',
    severity: 'error',
    description: 'A string does not match a required schema pattern.',
  },
  {
    code: 'schema.structure.format_invalid',
    severity: 'error',
    description: 'A string does not match a schema format such as date-time.',
  },
  {
    code: 'schema.structure.out_of_range',
    severity: 'error',
    description: 'A number is outside its minimum or maximum bound.',
  },
  {
    code: 'schema.structure.length_out_of_range',
    severity: 'error',
    description: 'A string length is outside its allowed bounds.',
  },
  {
    code: 'schema.structure.item_count_out_of_range',
    severity: 'error',
    description: 'An array item count is outside its allowed bounds.',
  },
  {
    code: 'schema.structure.duplicate_items',
    severity: 'error',
    description: 'An array requires unique items but contains duplicates.',
  },
  {
    code: 'schema.structure.property_count_out_of_range',
    severity: 'error',
    description: 'An object property count is outside its allowed bounds.',
  },
  {
    code: 'schema.structure.variant_invalid',
    severity: 'error',
    description: 'A value does not match any allowed discriminated variant.',
  },
  {
    code: 'schema.structure.constraint_failed',
    severity: 'error',
    description: 'A cross-field or conditional structural constraint failed.',
  },
  {
    code: 'schema.structure.invalid',
    severity: 'error',
    description: 'A structural schema constraint failed without a more specific code.',
  },
  {
    code: 'value.non_finite',
    severity: 'error',
    description: 'A programmatic value is NaN or Infinity and cannot be represented in JSON.',
  },
  {
    code: 'song.track.duplicate_id',
    severity: 'error',
    description: 'Two tracks use the same id.',
  },
  {
    code: 'song.track.multiple_drums',
    severity: 'error',
    description: 'More than one track uses kind "drums".',
  },
  {
    code: 'song.pattern.duplicate_id',
    severity: 'error',
    description: 'Two patterns use the same id.',
  },
  {
    code: 'song.pattern.unresolved',
    severity: 'error',
    description: 'A placement references a pattern that does not exist.',
  },
  {
    code: 'song.pattern.note_exceeds_length',
    severity: 'error',
    description: 'A pattern note ends after the explicit pattern lengthBeats.',
  },
  {
    code: 'song.channel.duplicate',
    severity: 'error',
    description: 'Two melodic tracks use the same MIDI channel.',
  },
  {
    code: 'song.channel.reserved',
    severity: 'error',
    description: 'A melodic track uses reserved MIDI channel 9.',
  },
  {
    code: 'song.channel.drums_invalid',
    severity: 'error',
    description: 'A drums track does not use MIDI channel 9.',
  },
  {
    code: 'song.note.end_exceeds_limit',
    severity: 'error',
    description: 'A note start plus duration exceeds 12000 beats.',
  },
  {
    code: 'song.placement.end_exceeds_limit',
    severity: 'error',
    description: 'An expanded placement ends after 12000 beats.',
  },
  {
    code: 'song.placement.expansion_exceeds_limit',
    severity: 'error',
    description: 'One placement expands to more than 20000 note events.',
  },
  {
    code: 'song.drums.pitch_out_of_range',
    severity: 'error',
    description: 'A drums note uses a pitch outside the General MIDI percussion range 35 to 81.',
  },
  {
    code: 'song.automation.time_order',
    severity: 'error',
    description: 'Automation points are not sorted by strictly increasing time.',
  },
  {
    code: 'song.automation.filter_target',
    severity: 'error',
    description: 'Filter automation does not resolve to exactly one lowpass effect.',
  },
  {
    code: 'song.limit.authored_notes',
    severity: 'error',
    description: 'The song defines more than 10000 authored notes.',
  },
  {
    code: 'song.limit.expanded_notes',
    severity: 'error',
    description: 'The song expands to more than 20000 note events.',
  },
  {
    code: 'song.limit.automation_points',
    severity: 'error',
    description: 'A track defines more than 1536 automation points across all targets.',
  },
  {
    code: 'song.duration.exceeds_limit',
    severity: 'error',
    description: 'The computed rendered duration exceeds 600 seconds.',
  },
  {
    code: 'song.instrument.unknown_builtin',
    severity: 'error',
    description: 'A builtin instrument id is not in the known builtin instrument registry.',
  },
  {
    code: 'song.capability.instrument_unsupported',
    severity: 'error',
    description: 'The selected renderer backend does not support an instrument variant or id.',
  },
  {
    code: 'song.capability.asset_unsupported',
    severity: 'error',
    description: 'The selected renderer backend does not support a referenced asset.',
  },
  {
    code: 'song.capability.effect_unsupported',
    severity: 'error',
    description: 'The selected renderer backend does not support an effect type used by the song.',
  },
  {
    code: 'song.warning.unused_pattern',
    severity: 'warning',
    description: 'A pattern is defined but no placement references it.',
  },
  {
    code: 'song.warning.automation_after_content',
    severity: 'warning',
    description: 'An automation point lies after the last note end on its track.',
  },
  {
    code: 'song.warning.hint_exceeds_content',
    severity: 'warning',
    description: 'durationHint leaves a long trailing silence after all audible content.',
  },
] as const satisfies readonly IssueCodeDefinition[];

export type IssueCode = (typeof ISSUE_CODE_REFERENCE)[number]['code'];

export const ISSUE_CODES = Object.freeze(
  ISSUE_CODE_REFERENCE.map((definition) => definition.code),
) as readonly IssueCode[];

const issueDefinitionsByCode = new Map<IssueCode, (typeof ISSUE_CODE_REFERENCE)[number]>(
  ISSUE_CODE_REFERENCE.map((definition) => [definition.code, definition]),
);

export type IssueParameter = string | number | boolean | null | readonly string[];
export type IssueParams = Readonly<Record<string, IssueParameter>>;

export interface ValidationIssue {
  readonly code: IssueCode;
  readonly severity: IssueSeverity;
  readonly path: string;
  readonly message: string;
  readonly hint: string;
  readonly params?: IssueParams;
}

export function createIssue(
  code: IssueCode,
  path: string,
  message: string,
  hint: string,
  params?: IssueParams,
): ValidationIssue {
  const definition = issueDefinitionsByCode.get(code);
  if (!definition) {
    throw new Error(`Unknown validation issue code: ${code}`);
  }
  const issue: ValidationIssue = {
    code,
    severity: definition.severity,
    path,
    message,
    hint,
    ...(params === undefined ? {} : { params }),
  };
  return issue;
}

const NUMERIC_POINTER_SEGMENT = /^(?:0|[1-9][0-9]*)$/;

function decodeJsonPointerSegment(segment: string): string {
  return segment.replaceAll('~1', '/').replaceAll('~0', '~');
}

export function escapeJsonPointerSegment(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1');
}

export function appendJsonPointer(path: string, segment: string): string {
  return `${path}/${escapeJsonPointerSegment(segment)}`;
}

export function compareJsonPointers(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  const leftSegments = left === '' ? [] : left.slice(1).split('/');
  const rightSegments = right === '' ? [] : right.slice(1).split('/');
  const length = Math.min(leftSegments.length, rightSegments.length);

  for (let index = 0; index < length; index += 1) {
    const leftSegment = decodeJsonPointerSegment(leftSegments[index] ?? '');
    const rightSegment = decodeJsonPointerSegment(rightSegments[index] ?? '');
    if (leftSegment === rightSegment) {
      continue;
    }
    const leftNumeric = NUMERIC_POINTER_SEGMENT.test(leftSegment);
    const rightNumeric = NUMERIC_POINTER_SEGMENT.test(rightSegment);
    if (leftNumeric && rightNumeric) {
      return Number(leftSegment) - Number(rightSegment);
    }
    if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    }
    return leftSegment < rightSegment ? -1 : 1;
  }

  return leftSegments.length - rightSegments.length;
}

export function compareIssues(left: ValidationIssue, right: ValidationIssue): number {
  return (
    compareJsonPointers(left.path, right.path) ||
    compareStrings(left.code, right.code) ||
    compareStrings(left.message, right.message)
  );
}

function compareStrings(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

export function dedupeIssues(issues: readonly ValidationIssue[]): ValidationIssue[] {
  const seen = new Set<string>();
  const result: ValidationIssue[] = [];
  for (const issue of issues) {
    const key = JSON.stringify([issue.code, issue.path, issue.message, issue.params ?? null]);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(issue);
    }
  }
  return result;
}

export function sortIssues(issues: readonly ValidationIssue[]): ValidationIssue[] {
  return [...issues].sort(compareIssues);
}

export function normalizeIssues(issues: readonly ValidationIssue[]): ValidationIssue[] {
  return sortIssues(dedupeIssues(issues));
}
