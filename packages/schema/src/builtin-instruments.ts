/**
 * Schema-level built-in instrument allowlist.
 *
 * The full authoritative instrument registry, with backend mappings, assets,
 * licenses, and checksums, belongs to the engine work in Task 07. This
 * allowlist is the seed used for schema validation today. Consumers that have a
 * newer registry should pass its IDs through ValidateSongOptions.builtinInstrumentIds.
 */
export const BUILTIN_INSTRUMENT_IDS = Object.freeze([
  'bass.sub',
  'drums.kit',
  'guitar.clean',
  'keys.soft',
  'pad.warm',
  'piano.soft',
] as const);

export type BuiltinInstrumentId = (typeof BUILTIN_INSTRUMENT_IDS)[number];

const builtinInstrumentIdSet: ReadonlySet<string> = new Set(BUILTIN_INSTRUMENT_IDS);

export function isBuiltinInstrumentId(value: string): value is BuiltinInstrumentId {
  return builtinInstrumentIdSet.has(value);
}
