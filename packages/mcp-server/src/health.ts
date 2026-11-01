/**
 * Health reporting for the MCP server.
 *
 * Health separates three questions that agents must not conflate:
 *
 * - Is the pure TypeScript built-in renderer usable? This is required and needs
 *   no native dependency.
 * - Are the optional FluidSynth executable and trusted GM SoundFont available?
 *   These are optional and can be provisioned later.
 * - Is the configured project root usable under @gxaditya/vamp-project rules? Discovery
 *   tools still work when it is absent or invalid.
 *
 * Reports contain stable backend identities, schema and registry versions,
 * configured dependency paths, bounded job settings, and capability notes.
 * They never enumerate environment variables, read secrets, or perform network
 * access.
 */

import { stat } from 'node:fs/promises';

import {
  BUILTIN_SYNTH_BACKEND_ID,
  BUILTIN_SYNTH_BACKEND_CAPABILITIES,
  DEFAULT_MAX_VOICES_PER_TRACK,
  FLUIDSYNTH_BACKEND_ID,
  INSTRUMENT_REGISTRY,
  INSTRUMENT_REGISTRY_VALIDATION,
  INSTRUMENT_REGISTRY_VERSION,
  SUPPORTED_SAMPLE_RATES,
  createBuiltinSynthBackend,
  probeFluidSynthVersion,
  renderSongAudio,
  selectAutomaticBackend,
  type AudioVoicePolicy,
} from '@gxaditya/vamp-engine';
import {
  SONG_SCHEMA_ID,
  SONG_SCHEMA_VERSION,
  SUPPORTED_SCHEMA_VERSIONS,
  type SongSchemaV1,
} from '@gxaditya/vamp-schema';

import type { McpJobSettings, McpServerConfig } from './config.js';
import { readSchemaGuide, SCHEMA_GUIDE_SOURCE } from './guide.js';
import { describeProjectRoot, type ProjectRootReport } from './project-root.js';

export type BuiltInRenderingStatus = 'usable' | 'degraded' | 'unavailable';

export interface BuiltInRenderingReport {
  readonly status: BuiltInRenderingStatus;
  readonly backendId: string;
  readonly backendName: string | null;
  /** Declared backend version, when one exists. The built-in backend has none. */
  readonly backendVersion: string | null;
  readonly required: true;
  readonly sampleRates: readonly number[];
  readonly voicePolicy: AudioVoicePolicy;
  readonly maxVoicesPerTrack: number;
  readonly curatedInstrumentCount: number;
  readonly note: string;
}

export interface ExecutableDependencyReport {
  readonly configuredPath: string;
  readonly source: 'argument' | 'environment' | 'default';
  readonly available: boolean;
  readonly status: 'available' | 'missing';
  /** Probed FluidSynth version, or null when unavailable or unparsable. */
  readonly version: string | null;
}

export type SoundFontStatus =
  'available' | 'not_configured' | 'missing' | 'not_file' | 'empty' | 'unreadable';

export interface SoundFontDependencyReport {
  readonly configured: boolean;
  readonly path: string | null;
  readonly source: 'argument' | 'environment' | 'discovered' | 'none';
  readonly available: boolean;
  readonly status: SoundFontStatus;
  readonly bytes: number | null;
}

export type SampleBackendStatus = 'available' | 'unavailable';

export interface SampleBackendSmokeReport {
  readonly attempted: boolean;
  readonly ok: boolean;
  readonly peak: number | null;
  readonly message: string;
}

export interface SampleBackendReport {
  readonly backendId: string;
  readonly status: SampleBackendStatus;
  readonly optional: true;
  /** Backend render_song uses when no explicit backend argument is passed. */
  readonly defaultBackend: 'builtin' | 'fluidsynth';
  readonly selectionNote: string;
  readonly executable: ExecutableDependencyReport;
  readonly soundFont: SoundFontDependencyReport;
  readonly missingDependencies: readonly ('executable' | 'soundfont')[];
  readonly smoke: SampleBackendSmokeReport;
  readonly note: string;
  readonly installHint: string;
}

export interface GuideHealthReport {
  readonly available: boolean;
  readonly source: typeof SCHEMA_GUIDE_SOURCE;
  readonly error: string | null;
}

export interface HealthReport {
  readonly status: 'ok' | 'degraded';
  readonly server: {
    readonly name: string;
    readonly version: string;
    readonly transport: 'stdio';
    readonly protocolTools: readonly string[];
  };
  readonly versions: {
    readonly schema: string;
    readonly schemaId: string;
    readonly supportedSchemaVersions: readonly string[];
    readonly instrumentRegistry: number;
  };
  readonly builtInRendering: BuiltInRenderingReport;
  readonly sampleBackend: SampleBackendReport;
  readonly guide: GuideHealthReport;
  readonly projectRoot: ProjectRootReport;
  readonly jobs: McpJobSettings;
  readonly configurationWarnings: readonly string[];
  readonly capabilities: {
    readonly renderFormats: readonly string[];
    readonly sampleRates: readonly number[];
    readonly notes: readonly string[];
  };
}

function describeBuiltInRendering(): BuiltInRenderingReport {
  try {
    const backend = createBuiltinSynthBackend();
    const declaredIds = new Set(backend.capabilities.builtinIds);
    const missingIds = INSTRUMENT_REGISTRY.filter(
      (instrument) => !declaredIds.has(instrument.id),
    ).map((instrument) => instrument.id);
    const identityMatches = backend.id === BUILTIN_SYNTH_BACKEND_ID;
    const usable =
      identityMatches &&
      missingIds.length === 0 &&
      backend.capabilities.instrumentTypes.includes('builtin');
    return {
      status: usable ? 'usable' : 'degraded',
      backendId: backend.id,
      backendName: backend.name,
      backendVersion: backend.version ?? null,
      required: true,
      sampleRates: SUPPORTED_SAMPLE_RATES,
      voicePolicy: backend.capabilities.voicePolicy,
      maxVoicesPerTrack: DEFAULT_MAX_VOICES_PER_TRACK,
      curatedInstrumentCount: INSTRUMENT_REGISTRY.length,
      note: usable
        ? 'Built-in rendering is usable without native executables, sound assets, an audio device, or network access.'
        : `Built-in rendering is degraded: expected ${BUILTIN_SYNTH_BACKEND_ID} with all curated instrument IDs but the backend declaration does not match. Troubleshoot the installed @gxaditya/vamp-engine build before rendering.`,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      status: 'unavailable',
      backendId: BUILTIN_SYNTH_BACKEND_ID,
      backendName: null,
      backendVersion: null,
      required: true,
      sampleRates: SUPPORTED_SAMPLE_RATES,
      voicePolicy: BUILTIN_SYNTH_BACKEND_CAPABILITIES.voicePolicy,
      maxVoicesPerTrack: DEFAULT_MAX_VOICES_PER_TRACK,
      curatedInstrumentCount: INSTRUMENT_REGISTRY.length,
      note: `Built-in rendering is unavailable: the @gxaditya/vamp-engine built-in backend could not be constructed (${detail}). Reinstall or rebuild the workspace before rendering.`,
    };
  }
}

async function describeSoundFont(
  path: string | null,
  source: SoundFontDependencyReport['source'],
): Promise<SoundFontDependencyReport> {
  if (path === null) {
    return {
      configured: false,
      path: null,
      source: 'none',
      available: false,
      status: 'not_configured',
      bytes: null,
    };
  }
  try {
    const info = await stat(path);
    if (!info.isFile()) {
      return {
        configured: true,
        path,
        source,
        available: false,
        status: 'not_file',
        bytes: null,
      };
    }
    if (info.size === 0) {
      return {
        configured: true,
        path,
        source,
        available: false,
        status: 'empty',
        bytes: 0,
      };
    }
    return {
      configured: true,
      path,
      source,
      available: true,
      status: 'available',
      bytes: info.size,
    };
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { readonly code?: unknown }).code)
        : '';
    return {
      configured: true,
      path,
      source,
      available: false,
      status: code === 'ENOENT' ? 'missing' : 'unreadable',
      bytes: null,
    };
  }
}

function smokeSong(): SongSchemaV1 {
  return {
    schemaVersion: '1.0.0',
    meta: {
      title: 'Vamp sample smoke',
      bpm: 100,
      timeSignature: { numerator: 4, denominator: 4 },
      key: { tonic: 'C', mode: 'major' },
      seed: 1,
      durationHint: 1,
    },
    tracks: [
      {
        id: 'piano',
        name: 'Smoke Piano',
        kind: 'midi',
        channel: 0,
        instrument: { type: 'gm', program: 0, bank: 0 },
        volume: 0.8,
        notes: [{ pitch: 60, start: 0, duration: 0.5, velocity: 96 }],
      },
    ],
  };
}

async function runSmoke(
  selection: Awaited<ReturnType<typeof selectAutomaticBackend>>,
): Promise<SampleBackendSmokeReport> {
  if (selection.id !== 'fluidsynth') {
    return {
      attempted: false,
      ok: false,
      peak: null,
      message: 'Sample backend unavailable; the built-in synth is the default.',
    };
  }
  const rendered = await renderSongAudio(smokeSong(), {
    sampleRate: 48_000,
    backend: selection.backend,
    validation: INSTRUMENT_REGISTRY_VALIDATION,
  });
  if (!rendered.ok) {
    return {
      attempted: true,
      ok: false,
      peak: null,
      message: rendered.errors[0]?.message ?? 'Sample render failed with no error message.',
    };
  }
  let peak = 0;
  for (let index = 0; index < rendered.audio.left.length; index += 1) {
    peak = Math.max(peak, Math.abs(rendered.audio.left[index] ?? 0));
    peak = Math.max(peak, Math.abs(rendered.audio.right[index] ?? 0));
  }
  return {
    attempted: true,
    ok: peak > 0,
    peak,
    message:
      peak > 0 ? 'Rendered one piano note through FluidSynth.' : 'Render succeeded but was silent.',
  };
}

/** Describe optional FluidSynth dependencies without throwing or downloading. */
export async function describeSampleBackend(
  config: McpServerConfig,
  options: { readonly probeVersion?: boolean; readonly smoke?: boolean } = {},
): Promise<SampleBackendReport> {
  const selection = await selectAutomaticBackend({
    binaryPath: config.fluidSynth.binaryPath,
    ...(config.fluidSynth.soundFontPath === null
      ? {}
      : { soundFontPath: config.fluidSynth.soundFontPath }),
  });
  const executableAvailable = selection.executable.available;
  const version =
    executableAvailable && options.probeVersion !== false
      ? await probeFluidSynthVersion(config.fluidSynth.binaryPath)
      : null;
  const soundFontSource: SoundFontDependencyReport['source'] =
    config.fluidSynth.soundFontPath !== null
      ? config.fluidSynth.soundFontSource
      : selection.soundFont.source === 'none'
        ? 'none'
        : 'discovered';
  const soundFontStat = await describeSoundFont(selection.soundFont.path, soundFontSource);
  const soundFont = {
    ...soundFontStat,
    available: soundFontStat.available && selection.soundFont.available,
    ...(soundFontStat.available && !selection.soundFont.available
      ? { status: 'unreadable' as const }
      : {}),
  };
  const executable: ExecutableDependencyReport = {
    configuredPath: config.fluidSynth.binaryPath,
    source: config.fluidSynth.binarySource,
    available: executableAvailable,
    status: executableAvailable ? 'available' : 'missing',
    version,
  };
  const missingDependencies: ('executable' | 'soundfont')[] = [];
  if (!executableAvailable) {
    missingDependencies.push('executable');
  }
  if (!soundFont.available) {
    missingDependencies.push('soundfont');
  }
  const available = missingDependencies.length === 0;
  const missingText = missingDependencies
    .map((dependency) => (dependency === 'executable' ? 'FluidSynth executable' : 'GM SoundFont'))
    .join(' and ');
  const smoke =
    options.smoke === true && available
      ? await runSmoke(selection)
      : {
          attempted: false,
          ok: false,
          peak: null,
          message: available
            ? 'Smoke test not requested.'
            : 'Sample backend unavailable; the built-in synth is the default.',
        };
  return {
    backendId: FLUIDSYNTH_BACKEND_ID,
    status: available ? 'available' : 'unavailable',
    optional: true,
    defaultBackend: selection.id,
    selectionNote: selection.note,
    executable,
    soundFont,
    missingDependencies,
    smoke,
    note: available
      ? `Default backend is ${selection.id}: ${selection.note}`
      : `Default backend is ${selection.id} because ${missingText} is missing or unusable. ${
          smoke.attempted
            ? smoke.message
            : 'Install FluidSynth and a GM SoundFont for real sampled instruments.'
        }`,
    installHint:
      'Install FluidSynth 2.x and provision a trusted General MIDI .sf2 SoundFont. The server auto-discovers VAMP_SOUNDFONT_PATH, VAMP_SOUNDFONT_DIR, ~/.local/share/vamp/soundfonts, and standard system SoundFont directories. See docs/instruments.md. Provisioning happens outside Vamp; nothing is downloaded at render time.',
  };
}

function describeGuide(): GuideHealthReport {
  const guide = readSchemaGuide();
  return guide.ok
    ? { available: true, source: SCHEMA_GUIDE_SOURCE, error: null }
    : { available: false, source: SCHEMA_GUIDE_SOURCE, error: guide.message };
}

const CAPABILITY_NOTES = Object.freeze([
  'This server uses stdio MCP transport only. No HTTP transport is exposed in v1.',
  'Built-in rendering is pure TypeScript and requires no native executable, sample asset, audio device, or network access.',
  'FluidSynth sample rendering is optional. Missing native dependencies do not prevent the server from starting.',
  'WAV is the only audio output format. MP3 export is not implemented.',
  'This server exposes discovery, health, project authoring and edit, and render_song tools over a configured project root. Every persisted edit requires the current revision and is confined to that root.',
  'render_song renders one saved revision into that project confined renders/ tree through the shared engine operation, and returns artifact paths, the revision rendered, the render report, and warnings.',
  'Renders run inside bounded job settings: concurrent renders are capped, extra calls queue up to the pending limit, and beyond that the tool returns render.busy. A render past the deadline returns render.timeout, and cancellation or shutdown returns render.cancelled. No path publishes partial artifacts.',
  'Shutdown aborts active render jobs so native children and job output are cleaned up; an in-flight native backend call finishes before that boundary cleanup.',
  'The server never downloads dependencies, instruments, or models at runtime.',
]);

/** Build the complete health report. Discovery tools remain usable on failure. */
export async function buildHealthReport(config: McpServerConfig): Promise<HealthReport> {
  const builtInRendering = describeBuiltInRendering();
  const sampleBackend = await describeSampleBackend(config, { smoke: true });
  const projectRoot = await describeProjectRoot(config);
  const guide = describeGuide();
  const sampleHealthy =
    sampleBackend.defaultBackend === 'builtin' ||
    !sampleBackend.smoke.attempted ||
    sampleBackend.smoke.ok;
  return {
    status:
      builtInRendering.status === 'usable' && guide.available && sampleHealthy ? 'ok' : 'degraded',
    server: {
      name: config.serverName,
      version: config.serverVersion,
      transport: config.transport,
      protocolTools: [
        'health_check',
        'get_schema_guide',
        'list_instruments',
        'list_presets',
        'validate_song',
        'create_song',
        'get_song',
        'list_projects',
        'update_song',
        'add_track',
        'add_notes',
        'set_pattern',
        'set_instrument',
        'render_song',
      ],
    },
    versions: {
      schema: SONG_SCHEMA_VERSION,
      schemaId: SONG_SCHEMA_ID,
      supportedSchemaVersions: SUPPORTED_SCHEMA_VERSIONS,
      instrumentRegistry: INSTRUMENT_REGISTRY_VERSION,
    },
    builtInRendering,
    sampleBackend,
    guide,
    projectRoot,
    jobs: config.jobs,
    configurationWarnings: config.warnings,
    capabilities: {
      renderFormats: ['wav'],
      sampleRates: SUPPORTED_SAMPLE_RATES,
      notes: CAPABILITY_NOTES,
    },
  };
}
