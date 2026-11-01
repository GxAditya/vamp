/**
 * Discovery and health tools for the Vamp MCP server.
 *
 * Tool descriptions are part of the product surface and are written for coding
 * agents. Every handler returns MCP text content plus validated structured
 * content. Expected failures become `isError` CallToolResults with a stable
 * code, message, and hint instead of throwing across the protocol.
 */

import {
  FLUIDR3_GM_ASSET,
  GM_INSTRUMENT_CATALOG,
  GM_STANDARD_DRUM_KIT,
  describeBgmPresets,
  describeInstrumentRegistry,
  type InstrumentRegistryEntry,
  type RegistryAsset,
  type RegistryLicense,
  type RegistryProvenance,
} from '@gxaditya/vamp-engine';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { SONG_SCHEMA_VERSION } from '@gxaditya/vamp-schema';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { McpServerConfig } from './config.js';
import { readSchemaGuide, SCHEMA_GUIDE_SOURCE } from './guide.js';
import { buildHealthReport, describeSampleBackend, type HealthReport } from './health.js';
import {
  GET_SCHEMA_GUIDE_TOOL,
  HEALTH_CHECK_TOOL,
  LIST_INSTRUMENTS_TOOL,
  LIST_PRESETS_TOOL,
  emptyToolInputSchema,
  getSchemaGuideOutputSchema,
  healthCheckOutputSchema,
  listInstrumentsOutputSchema,
  listPresetsOutputSchema,
  type GetSchemaGuideOutput,
  type ListInstrumentsOutput,
  type ListPresetsOutput,
} from './schemas.js';

export type DiagnosticLogger = (message: string) => void;

const defaultLogger: DiagnosticLogger = (message) => {
  process.stderr.write(`${message}\n`);
};

const READ_ONLY_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

export interface ToolErrorPayload {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly hint: string;
  };
}

/**
 * Build an actionable MCP tool error that stays spec-compliant.
 *
 * When a tool declares an `outputSchema`, the official MCP client validates any
 * `structuredContent` against it, even on an error result. A tool error's
 * payload does not match the success schema, so the machine-readable error is
 * carried in the text content instead of `structuredContent`. The first text
 * item is human-readable; the second is a JSON object with the stable code and
 * repair fields an agent can parse to self-correct.
 */
export function errorResult(payload: Record<string, unknown>, humanText: string): CallToolResult {
  return {
    isError: true,
    content: [
      { type: 'text', text: humanText },
      { type: 'text', text: JSON.stringify({ error: payload }) },
    ],
  };
}

/** Build a structured, actionable tool error without protocol noise. */
export function toolError(code: string, message: string, hint: string): CallToolResult {
  return errorResult({ code, message, hint }, `${message}\nCode: ${code}. Hint: ${hint}`);
}

/** Build a structured, actionable successful tool result. */
export function toolSuccess(text: string, data: object): CallToolResult {
  return {
    content: [{ type: 'text', text }],
    structuredContent: data as Record<string, unknown>,
  };
}

function describeHealthText(report: HealthReport): string {
  const projectRoot = report.projectRoot;
  const sample = report.sampleBackend;
  const lines = [
    `Vamp MCP health: ${report.status}`,
    `Server: ${report.server.name} ${report.server.version} over ${report.server.transport}`,
    `Schema: ${report.versions.schema} (${report.versions.schemaId})`,
    `Built-in rendering: ${report.builtInRendering.status} (${report.builtInRendering.backendId})`,
  ];
  if (report.builtInRendering.status !== 'usable') {
    lines.push(`Built-in note: ${report.builtInRendering.note}`);
  }
  lines.push(
    `Default render backend: ${sample.defaultBackend} (${sample.status})`,
    `  Selection: ${sample.selectionNote}`,
    `  Executable: ${sample.executable.configuredPath} (${sample.executable.status}${
      sample.executable.version === null ? '' : `, version ${sample.executable.version}`
    })`,
    `  SoundFont: ${sample.soundFont.path ?? 'not found'} (${sample.soundFont.source}, ${sample.soundFont.status})`,
    `  Smoke render: ${sample.smoke.attempted ? (sample.smoke.ok ? 'ok' : 'failed') : 'not attempted'}${
      sample.smoke.peak === null ? '' : `, peak ${sample.smoke.peak.toFixed(4)}`
    }`,
  );
  if (sample.missingDependencies.length > 0) {
    lines.push(
      `  Missing: ${sample.missingDependencies.join(', ')}`,
      `  Setup: ${sample.installHint}`,
    );
  }
  lines.push(
    `Project root: ${projectRoot.status}${
      projectRoot.path === null ? '' : ` (${projectRoot.path})`
    }`,
  );
  if (projectRoot.code !== null) {
    lines.push(`  Project error: ${projectRoot.code}`);
  }
  if (projectRoot.hint !== null) {
    lines.push(`  Hint: ${projectRoot.hint}`);
  }
  lines.push(
    `Jobs: ${report.jobs.maxConcurrentRenders} concurrent, ${report.jobs.maxPendingJobs} pending, ${report.jobs.renderTimeoutMs} ms timeout`,
    `Schema guide: ${report.guide.available ? 'available' : 'unavailable'} (${report.guide.source})`,
    `Tools: ${report.server.protocolTools.join(', ')}`,
  );
  if (report.configurationWarnings.length > 0) {
    lines.push('Configuration warnings:');
    for (const warning of report.configurationWarnings) {
      lines.push(`- ${warning}`);
    }
  }
  lines.push('Notes:');
  for (const note of report.capabilities.notes) {
    lines.push(`- ${note}`);
  }
  return lines.join('\n');
}

function serializeLicense(license: RegistryLicense): RegistryLicense {
  return { ...license };
}

function serializeProvenance(provenance: RegistryProvenance): RegistryProvenance {
  return { ...provenance };
}

function serializeAsset(asset: RegistryAsset): RegistryAsset {
  return {
    ...asset,
    checksum: { ...asset.checksum },
    license: serializeLicense(asset.license),
    provenance: serializeProvenance(asset.provenance),
  };
}

function instrumentAvailability(
  entry: InstrumentRegistryEntry,
  sampleBackendAvailable: boolean,
  missingDependencies: readonly ('executable' | 'soundfont')[],
): ListInstrumentsOutput['instruments'][number]['availability'] {
  const fluidSynth = entry.capabilities.fluidSynth && sampleBackendAvailable;
  const notes: string[] = [];
  if (entry.capabilities.builtinSynth) {
    notes.push('Built-in rendering is available.');
  } else {
    notes.push('No built-in voice is declared for this instrument.');
  }
  if (!entry.capabilities.fluidSynth) {
    notes.push(`${entry.sampleBackend.backendId} does not declare this instrument.`);
  } else if (fluidSynth) {
    notes.push(`Sample rendering is available through ${entry.sampleBackend.backendId}.`);
  } else {
    notes.push(
      `Sample rendering requires a valid ${entry.sampleBackend.backendId} configuration (${
        missingDependencies.length > 0 ? missingDependencies.join(', ') : 'dependencies'
      }).`,
    );
  }
  if (entry.capabilities.percussion) {
    notes.push('Percussion uses MIDI channel 9 and bank 128.');
  }
  return {
    builtin: entry.capabilities.builtinSynth,
    sampleBackend: fluidSynth,
    missingDependencies: [...missingDependencies],
    note: notes.join(' '),
  };
}

async function buildListInstrumentsOutput(config: McpServerConfig): Promise<ListInstrumentsOutput> {
  const registry = describeInstrumentRegistry();
  const sample = await describeSampleBackend(config, { probeVersion: false });
  const sampleAvailable = sample.status === 'available';
  return {
    schemaVersion: SONG_SCHEMA_VERSION,
    registryVersion: registry.registryVersion,
    sampleBackendId: registry.sampleBackendId,
    sampleBackendInstrumentTypes: [...registry.sampleBackendInstrumentTypes],
    availability: {
      builtin: true,
      sampleBackend: sampleAvailable,
      missingDependencies: [...sample.missingDependencies],
      note: sample.note,
    },
    assets: registry.assets.map(serializeAsset),
    instruments: registry.instruments.map((entry) => ({
      ...entry,
      capabilities: {
        ...entry.capabilities,
        songVariants: [...entry.capabilities.songVariants],
      },
      sampleBackend: { ...entry.sampleBackend },
      asset: serializeAsset(entry.asset),
      license: serializeLicense(entry.license),
      provenance: serializeProvenance(entry.provenance),
      availability: instrumentAvailability(entry, sampleAvailable, sample.missingDependencies),
    })),
    gmCatalog: GM_INSTRUMENT_CATALOG.map((preset) => ({
      ...preset,
      roles: [...preset.roles],
      songInstrument: { ...preset.songInstrument },
    })),
    drumKit: {
      ...GM_STANDARD_DRUM_KIT,
      songInstrument: { ...GM_STANDARD_DRUM_KIT.songInstrument },
      noteMap: { ...GM_STANDARD_DRUM_KIT.noteMap },
      notes: GM_STANDARD_DRUM_KIT.notes.map((note) => ({ ...note })),
    },
  };
}

function describeInstrumentsText(output: ListInstrumentsOutput): string {
  const lines = [
    `Vamp curated instrument registry v${output.registryVersion} (song schema ${output.schemaVersion}).`,
    `Use these stable IDs in { "type": "builtin", "id": "<id>" } instrument references.`,
    `Built-in rendering: available. Sample backend ${output.sampleBackendId}: ${
      output.availability.sampleBackend ? 'available' : 'unavailable'
    }.`,
  ];
  if (output.availability.missingDependencies.length > 0) {
    lines.push(
      `Optional sample dependencies missing: ${output.availability.missingDependencies.join(', ')}.`,
    );
  }
  lines.push(
    '',
    '| ID | Name | Category | Kind | Built-in | FluidSynth | GM program/bank |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  );
  for (const instrument of output.instruments) {
    lines.push(
      `| ${instrument.id} | ${instrument.name} | ${instrument.category} | ${instrument.kind} | ${
        instrument.availability.builtin ? 'yes' : 'no'
      } | ${instrument.availability.sampleBackend ? 'yes' : 'no'} | ${instrument.sampleBackend.program}/${instrument.sampleBackend.bank} |`,
    );
  }
  const asset = output.assets.find((candidate) => candidate.id === FLUIDR3_GM_ASSET.id);
  if (asset !== undefined) {
    lines.push(
      '',
      `Sample asset ${asset.fileName}: ${asset.bytes} bytes, ${asset.checksum.algorithm} ${asset.checksum.value}, license ${asset.license.spdx} (${asset.license.name}), redistribution ${asset.license.redistribution}.`,
      `Asset availability: ${output.availability.note}`,
    );
  }
  lines.push(
    '',
    `Named General MIDI catalog (${String(output.gmCatalog.length)} presets). Use the songInstrument object verbatim:`,
    '',
    '| Catalog ID | Name | Category | Program | Roles |',
    '| --- | --- | --- | --- | --- |',
  );
  for (const preset of output.gmCatalog) {
    lines.push(
      `| ${preset.id} | ${preset.name} | ${preset.category} | ${String(preset.program)} | ${preset.roles.join(', ')} |`,
    );
  }
  lines.push(
    '',
    'GM program numbers are stable, so any program from 0 to 127 also works directly as { "type": "gm", "program": <n>, "bank": 0 }.',
    '',
    `Drum kit: ${output.drumKit.name} (GM bank ${String(output.drumKit.bank)}, channel ${String(output.drumKit.channel)}). Use ${JSON.stringify(output.drumKit.songInstrument)} on the song's single drums track.`,
    `Common drum keys: ${Object.entries(output.drumKit.noteMap)
      .map(([alias, pitch]) => `${alias}=${String(pitch)}`)
      .join(', ')}.`,
    'Every GM percussion key from 35 to 81 is valid on the drums track; the full map is in structuredContent.drumKit.notes.',
    '',
    'The six curated IDs above are the only builtin IDs the dependency-free oscillator backend can synthesize. GM catalog presets need the FluidSynth sample backend; the default auto backend uses it whenever FluidSynth and a SoundFont are available.',
  );
  return lines.join('\n');
}

function describePresetsText(output: ListPresetsOutput): string {
  const lines = [
    'Vamp BGM preset packs',
    '',
    '| ID | Name | Default | Key | Instruments |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const preset of output.presets) {
    lines.push(
      `| ${preset.id} | ${preset.name} | ${String(preset.defaultSeconds)}s @ ${String(
        preset.defaultBpm,
      )} BPM | ${preset.defaultKey.tonic} ${preset.defaultKey.mode} | ${preset.instruments
        .map((instrument) => instrument.label)
        .join(', ')} |`,
    );
  }
  for (const preset of output.presets) {
    lines.push(
      '',
      `### ${preset.name} (${preset.id})`,
      preset.summary,
      `Chord loop: ${preset.romanNumerals.join(' - ')}.`,
      `Groove: ${preset.groove}`,
      `Arrangement: ${preset.arrangement}`,
      `Mix: ${preset.mix}`,
      `Avoid: ${preset.avoid.join(' ')}`,
    );
  }
  lines.push(
    '',
    'Create a project from a preset with create_song and the preset field, or inspect the generated song first with get_schema_guide and the preset recipe. Presets generate complete arrangements with GM instruments, velocity variation, effects, and a tail that fits the requested duration. Use a custom song when you need a different structure.',
  );
  return lines.join('\n');
}

interface RegisterToolOptions {
  readonly logger?: DiagnosticLogger;
}

export async function guardTool(
  name: string,
  logger: DiagnosticLogger,
  handler: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  try {
    return await handler();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logger(`vamp-mcp: tool ${name} failed unexpectedly: ${detail}`);
    return toolError(
      'mcp.internal',
      `The ${name} tool failed unexpectedly.`,
      'Retry the call. If the failure persists, inspect the server stderr diagnostics and rebuild the workspace.',
    );
  }
}

/**
 * Register the Task 13 discovery tools on a high-level McpServer.
 *
 * The registration helper is intentionally reusable. Task 14 and Task 15 can
 * add their tools without changing configuration, logging, or error mapping.
 */
export function registerDiscoveryTools(
  server: McpServer,
  config: McpServerConfig,
  options: RegisterToolOptions = {},
): void {
  const logger = options.logger ?? defaultLogger;

  server.registerTool(
    HEALTH_CHECK_TOOL,
    {
      title: 'Vamp health check',
      description:
        'Diagnose the local Vamp MCP server before authoring or rendering music. Takes no input arguments. Reports the default render backend, whether built-in rendering is usable, whether FluidSynth and a locally discovered or configured GM SoundFont are available, a one-note sample render smoke test, safe backend identities and versions, the supported song schema, the configured project root status, and bounded job settings. Call this first after setup, when a native dependency is missing, or when a project root is misconfigured. Read-only, offline, and never exposes environment variables or secrets.',
      inputSchema: emptyToolInputSchema,
      outputSchema: healthCheckOutputSchema,
      annotations: { ...READ_ONLY_ANNOTATIONS, title: 'Vamp health check' },
    },
    () =>
      guardTool(HEALTH_CHECK_TOOL, logger, async () => {
        const report = await buildHealthReport(config);
        const output = healthCheckOutputSchema.parse(report);
        return toolSuccess(describeHealthText(output), output);
      }),
  );

  server.registerTool(
    GET_SCHEMA_GUIDE_TOOL,
    {
      title: 'Vamp schema guide',
      description:
        'Return the authoritative SongSchemaV1 authoring guide for coding agents. Takes no input arguments. Use it before creating or editing a song. It explains the JSON structure, beats versus seconds, choosing curated instruments, patterns, automation, effects, duration and tails, validation, and the complete render output workflow. The markdown is the same docs/schema-guide.md shipped with Vamp, not a divergent copy. Read-only and offline.',
      inputSchema: emptyToolInputSchema,
      outputSchema: getSchemaGuideOutputSchema,
      annotations: { ...READ_ONLY_ANNOTATIONS, title: 'Vamp schema guide' },
    },
    () =>
      guardTool(GET_SCHEMA_GUIDE_TOOL, logger, async () => {
        const guide = readSchemaGuide();
        if (!guide.ok) {
          logger(`vamp-mcp: ${guide.message}`);
          return toolError(
            'mcp.guide_unavailable',
            guide.message,
            'Rebuild the workspace with "pnpm build" or provision docs/schema-guide.md. The server never fetches documentation from the network.',
          );
        }
        const output: GetSchemaGuideOutput = {
          schemaVersion: SONG_SCHEMA_VERSION,
          format: 'markdown',
          source: SCHEMA_GUIDE_SOURCE,
          bytes: Buffer.byteLength(guide.markdown, 'utf8'),
          markdown: guide.markdown,
        };
        return toolSuccess(guide.markdown, output);
      }),
  );

  server.registerTool(
    LIST_INSTRUMENTS_TOOL,
    {
      title: 'Vamp instruments',
      description:
        'List every instrument surface an agent can use. Takes no input arguments. Returns (1) the six curated builtin IDs with backend mappings, licenses, provenance, checksums, and availability; (2) a named General MIDI catalog of piano, e-piano, organ, bass, guitar, strings, pads, choir, brass, woodwind, sax, mallets, leads, plucks, and FX presets, each carrying the exact { type:"gm", program, bank } object to copy; and (3) the GM drum kit plus a readable drum key map. Use builtin IDs only when the dependency-free synth must render; use GM catalog programs with the default auto/FluidSynth sample backend for real instruments. Never invent instrument IDs or copy this list into code; call this tool again when the registry or setup changes.',
      inputSchema: emptyToolInputSchema,
      outputSchema: listInstrumentsOutputSchema,
      annotations: { ...READ_ONLY_ANNOTATIONS, title: 'Vamp instruments' },
    },
    () =>
      guardTool(LIST_INSTRUMENTS_TOOL, logger, async () => {
        const output = await buildListInstrumentsOutput(config);
        return toolSuccess(describeInstrumentsText(output), output);
      }),
  );

  server.registerTool(
    LIST_PRESETS_TOOL,
    {
      title: 'Vamp BGM presets',
      description:
        'List the curated Vamp BGM preset packs and their complete composition recipes. Takes no input arguments. Each preset names its default tempo, key, duration, chord loop, instruments, groove, arrangement, mix, and pitfalls. Use these recipes when authoring a custom song, or create a complete project directly with create_song preset:"lofi" | "tutorial_upbeat" | "ambient_focus" | "corporate_clean" | "stinger". Presets use real GM sample instruments and the default auto backend, so they sound like sampled ensembles rather than oscillators. Read-only and offline.',
      inputSchema: emptyToolInputSchema,
      outputSchema: listPresetsOutputSchema,
      annotations: { ...READ_ONLY_ANNOTATIONS, title: 'Vamp BGM presets' },
    },
    () =>
      guardTool(LIST_PRESETS_TOOL, logger, async () => {
        const output: ListPresetsOutput = {
          schemaVersion: SONG_SCHEMA_VERSION,
          presets: describeBgmPresets().map((preset) => ({
            ...preset,
            tags: [...preset.tags],
            romanNumerals: [...preset.romanNumerals],
            instruments: preset.instruments.map((instrument) => ({ ...instrument })),
            avoid: [...preset.avoid],
          })),
        };
        return toolSuccess(describePresetsText(output), output);
      }),
  );
}
