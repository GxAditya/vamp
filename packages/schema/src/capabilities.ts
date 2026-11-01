import type { Effect, Instrument, SongSchemaV1 } from './generated/song-v1.js';
import { createIssue, normalizeIssues, type ValidationIssue } from './issues.js';

export type InstrumentVariantType = Instrument['type'];
export type EffectVariantType = Effect['type'];

export interface BackendAssetReference {
  readonly type: 'soundfont' | 'sfz';
  readonly path: string;
}

/**
 * Capabilities declared by a renderer backend. No backend exists in Task 03;
 * callers pass this descriptor once one is selected. Asset existence, size, and
 * symlink confinement remain the project layer's responsibility.
 */
export interface BackendCapabilities {
  readonly id: string;
  readonly supportedInstrumentTypes: readonly InstrumentVariantType[];
  /** Optional narrower allowlist for builtin instrument ids. */
  readonly supportedBuiltinIds?: readonly string[];
  /** Optional backend-specific asset capability check. */
  readonly supportsAsset?: (asset: BackendAssetReference) => boolean;
  /**
   * Optional effect support. Omit when the backend supports every canonical
   * v1 effect, or list the supported effect types explicitly.
   */
  readonly supportedEffectTypes?: readonly EffectVariantType[];
}

/**
 * Check instrument variants and optional asset support against a selected
 * backend. This is a separate capability concern from schema validity. Callers
 * that do not pass capabilities to `validateSong` get
 * `capabilityCheck: "not_checked"` and must run this before rendering.
 */
export function validateBackendCapabilities(
  song: SongSchemaV1,
  capabilities: BackendCapabilities,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const supportedTypes = new Set<string>(capabilities.supportedInstrumentTypes);
  const supportedBuiltinIds =
    capabilities.supportedBuiltinIds === undefined
      ? undefined
      : new Set(capabilities.supportedBuiltinIds);

  song.tracks.forEach((track, trackIndex) => {
    const instrument = track.instrument;
    const instrumentPath = `/tracks/${trackIndex}/instrument`;

    if (!supportedTypes.has(instrument.type)) {
      issues.push(
        createIssue(
          'song.capability.instrument_unsupported',
          instrumentPath,
          `Backend "${capabilities.id}" does not support "${instrument.type}" instruments.`,
          `Use one of the backend-supported variants: ${
            capabilities.supportedInstrumentTypes.join(', ') || 'none'
          }. Do not substitute a different instrument silently.`,
          {
            backendId: capabilities.id,
            variant: instrument.type,
            supportedVariants: [...capabilities.supportedInstrumentTypes],
          },
        ),
      );
      return;
    }

    if (
      instrument.type === 'builtin' &&
      supportedBuiltinIds !== undefined &&
      !supportedBuiltinIds.has(instrument.id)
    ) {
      issues.push(
        createIssue(
          'song.capability.instrument_unsupported',
          `${instrumentPath}/id`,
          `Backend "${capabilities.id}" does not provide builtin instrument "${instrument.id}".`,
          'Choose a builtin instrument that the selected backend provides, or use a supported asset variant.',
          {
            backendId: capabilities.id,
            variant: 'builtin',
            instrumentId: instrument.id,
          },
        ),
      );
      return;
    }

    if (
      (instrument.type === 'soundfont' || instrument.type === 'sfz') &&
      capabilities.supportsAsset !== undefined &&
      !capabilities.supportsAsset({ type: instrument.type, path: instrument.path })
    ) {
      issues.push(
        createIssue(
          'song.capability.asset_unsupported',
          `${instrumentPath}/path`,
          `Backend "${capabilities.id}" cannot use asset "${instrument.path}".`,
          'Select an asset that the backend supports and provision it inside the project root.',
          {
            backendId: capabilities.id,
            variant: instrument.type,
            assetPath: instrument.path,
          },
        ),
      );
    }
  });

  if (capabilities.supportedEffectTypes !== undefined) {
    const supportedEffects = new Set<string>(capabilities.supportedEffectTypes);
    song.tracks.forEach((track, trackIndex) => {
      (track.effects ?? []).forEach((effect, effectIndex) => {
        if (!supportedEffects.has(effect.type)) {
          issues.push(
            createIssue(
              'song.capability.effect_unsupported',
              `/tracks/${trackIndex}/effects/${effectIndex}`,
              `Backend "${capabilities.id}" does not support "${effect.type}" effects.`,
              `Remove the effect or use one of: ${
                capabilities.supportedEffectTypes?.join(', ') || 'none'
              }.`,
              {
                backendId: capabilities.id,
                effectType: effect.type,
                supportedEffects: [...(capabilities.supportedEffectTypes ?? [])],
              },
            ),
          );
        }
      });
    });
  }

  return normalizeIssues(issues);
}
