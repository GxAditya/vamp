/**
 * Automatic backend selection for the CLI, MCP server, and SDK.
 *
 * The product default is the real sample path when it is available locally:
 * FluidSynth plus a provisioned GM SoundFont. The deterministic oscillator
 * synthesizer remains the explicit dependency-free fallback and is still used
 * when either native dependency is missing.
 *
 * Selection is filesystem-only and never downloads. Callers that need classic
 * behavior can pass an explicit builtin backend; this helper only powers the
 * `auto` mode.
 */

import type { AudioBackend } from './backend.js';
import { createBuiltinSynthBackend } from './synth.js';
import {
  createFluidSynthBackend,
  isFluidSynthBinaryAvailable,
  type FluidSynthBackendConfig,
} from './fluidsynth.js';
import {
  discoverSoundFont,
  type DiscoveredSoundFont,
  type SoundFontDiscoveryOptions,
} from './soundfont-discovery.js';
import { validateTrustedSoundFont } from './assets.js';

export type AutomaticBackendId = 'builtin' | 'fluidsynth';
export type MissingSampleDependency = 'executable' | 'soundfont';

export interface AutomaticBackendOptions {
  /** FluidSynth executable name or path. Defaults to `fluidsynth` on PATH. */
  readonly binaryPath?: string;
  /** Explicit GM SoundFont. When omitted, local discovery runs. */
  readonly soundFontPath?: string | null;
  /** Project root for song-referenced `.sf2` assets. */
  readonly projectRoot?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  readonly home?: string;
  readonly extraSoundFontDirectories?: readonly string[];
  /** Backend tuning forwarded to FluidSynth when it is selected. */
  readonly fluidSynth?: Omit<FluidSynthBackendConfig, 'gmSoundFont' | 'projectRoot'>;
}

export interface AutomaticBackendSelection {
  readonly backend: AudioBackend;
  readonly id: AutomaticBackendId;
  /** Human-readable reason for diagnostics, health checks, and warnings. */
  readonly note: string;
  readonly executable: {
    readonly path: string;
    readonly available: boolean;
  };
  readonly soundFont: {
    readonly path: string | null;
    readonly source: DiscoveredSoundFont['source'] | 'configured' | 'none';
    readonly available: boolean;
  };
  readonly missingDependencies: readonly MissingSampleDependency[];
  /** True when the caller should surface a fallback warning. */
  readonly fellBackToBuiltin: boolean;
}

const BUILTIN_NOTE =
  'Deterministic built-in synthesizer. Real sample instruments are unavailable, so timbres are synthesized approximations with six curated voices.';

function resolvedEnv(
  options: AutomaticBackendOptions,
): Readonly<Record<string, string | undefined>> {
  return options.env ?? process.env;
}

async function resolveSoundFont(options: AutomaticBackendOptions): Promise<{
  readonly path: string | null;
  readonly source: AutomaticBackendSelection['soundFont']['source'];
  readonly available: boolean;
}> {
  const env = resolvedEnv(options);
  const explicit =
    options.soundFontPath?.trim() ??
    (env.VAMP_SOUNDFONT_PATH === undefined ? null : env.VAMP_SOUNDFONT_PATH.trim());

  if (explicit !== null && explicit.length > 0) {
    const checked = await validateTrustedSoundFont(explicit);
    return { path: explicit, source: 'configured', available: checked.ok };
  }

  const discoveryOptions: SoundFontDiscoveryOptions = {
    env,
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.home === undefined ? {} : { home: options.home }),
    ...(options.extraSoundFontDirectories === undefined
      ? {}
      : { extraDirectories: options.extraSoundFontDirectories }),
  };
  const found = await discoverSoundFont(discoveryOptions);
  if (found.soundFont === null) {
    return { path: null, source: 'none', available: false };
  }
  return { path: found.soundFont.path, source: found.soundFont.source, available: true };
}

/**
 * Choose FluidSynth plus a real GM SoundFont when both are locally available,
 * otherwise return the built-in synthesizer with an explicit explanation.
 */
export async function selectAutomaticBackend(
  options: AutomaticBackendOptions = {},
): Promise<AutomaticBackendSelection> {
  const env = resolvedEnv(options);
  const binaryPath = options.binaryPath?.trim() || env.VAMP_FLUIDSYNTH_PATH?.trim() || 'fluidsynth';
  const executableAvailable = await isFluidSynthBinaryAvailable(binaryPath);
  const soundFont = await resolveSoundFont(options);

  const missing: MissingSampleDependency[] = [];
  if (!executableAvailable) {
    missing.push('executable');
  }
  if (!soundFont.available) {
    missing.push('soundfont');
  }

  if (missing.length === 0 && soundFont.path !== null) {
    const backend = createFluidSynthBackend({
      ...(options.fluidSynth ?? {}),
      binaryPath,
      gmSoundFont: soundFont.path,
      ...(options.projectRoot === undefined ? {} : { projectRoot: options.projectRoot }),
    });
    return {
      backend,
      id: 'fluidsynth',
      note: `FluidSynth sample backend with ${soundFont.path} (${soundFont.source}). Real sampled GM instruments are active.`,
      executable: { path: binaryPath, available: true },
      soundFont,
      missingDependencies: [],
      fellBackToBuiltin: false,
    };
  }

  const missingLabels = missing.map((dependency) =>
    dependency === 'executable' ? 'the FluidSynth executable' : 'a GM SoundFont',
  );
  const missingText =
    missing.length === 0
      ? 'no usable SoundFont was found'
      : missingLabels.length === 1
        ? `${missingLabels[0]} was not found`
        : `${missingLabels.slice(0, -1).join(', ')} and ${missingLabels.at(-1)} were not found`;
  return {
    backend: createBuiltinSynthBackend(),
    id: 'builtin',
    note: `${BUILTIN_NOTE} Sample backend unavailable because ${missingText} was not found. Install FluidSynth and provision a GM SoundFont for real instruments.`,
    executable: { path: binaryPath, available: executableAvailable },
    soundFont,
    missingDependencies: missing,
    fellBackToBuiltin: true,
  };
}
