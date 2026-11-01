/**
 * Validated MCP tool input and output shapes.
 *
 * The schemas describe the serialized reports returned by the discovery tools.
 * They are not a second song schema and never validate or rewrite song data.
 * Song validation remains in `@gxaditya/vamp-schema` and project storage remains in
 * `@gxaditya/vamp-project`.
 */

import { z } from 'zod';

export const HEALTH_CHECK_TOOL = 'health_check' as const;
export const GET_SCHEMA_GUIDE_TOOL = 'get_schema_guide' as const;
export const LIST_INSTRUMENTS_TOOL = 'list_instruments' as const;
export const LIST_PRESETS_TOOL = 'list_presets' as const;

export const DISCOVERY_TOOL_NAMES = Object.freeze([
  HEALTH_CHECK_TOOL,
  GET_SCHEMA_GUIDE_TOOL,
  LIST_INSTRUMENTS_TOOL,
  LIST_PRESETS_TOOL,
] as const);

export const emptyToolInputSchema = z.object({}).strict();

const projectRootSourceSchema = z.enum(['argument', 'environment', 'none']);
const configurationSourceSchema = z.enum(['argument', 'environment', 'default']);

const projectRootReportSchema = z.object({
  configured: z.boolean(),
  source: projectRootSourceSchema,
  path: z.string().nullable(),
  status: z.enum(['valid', 'not_configured', 'missing', 'invalid', 'error']),
  projectCount: z.number().int().nonnegative().nullable(),
  code: z.string().nullable(),
  message: z.string(),
  hint: z.string().nullable(),
});

const executableDependencySchema = z.object({
  configuredPath: z.string(),
  source: configurationSourceSchema,
  available: z.boolean(),
  status: z.enum(['available', 'missing']),
  version: z.string().nullable(),
});

const soundFontDependencySchema = z.object({
  configured: z.boolean(),
  path: z.string().nullable(),
  source: z.enum(['argument', 'environment', 'discovered', 'none']),
  available: z.boolean(),
  status: z.enum(['available', 'not_configured', 'missing', 'not_file', 'empty', 'unreadable']),
  bytes: z.number().int().nonnegative().nullable(),
});

const jobSettingsSchema = z.object({
  maxConcurrentRenders: z.number().int().positive(),
  maxPendingJobs: z.number().int().nonnegative(),
  renderTimeoutMs: z.number().int().positive(),
  maxToolInputElements: z.number().int().positive(),
});

export const healthCheckOutputSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  server: z.object({
    name: z.string(),
    version: z.string(),
    transport: z.literal('stdio'),
    protocolTools: z.array(z.string()),
  }),
  versions: z.object({
    schema: z.string(),
    schemaId: z.string(),
    supportedSchemaVersions: z.array(z.string()),
    instrumentRegistry: z.number().int().nonnegative(),
  }),
  builtInRendering: z.object({
    status: z.enum(['usable', 'degraded', 'unavailable']),
    backendId: z.string(),
    backendName: z.string().nullable(),
    backendVersion: z.string().nullable(),
    required: z.literal(true),
    sampleRates: z.array(z.number().int().positive()),
    voicePolicy: z.enum(['drop-newest', 'steal-oldest']),
    maxVoicesPerTrack: z.number().int().positive(),
    curatedInstrumentCount: z.number().int().nonnegative(),
    note: z.string(),
  }),
  sampleBackend: z.object({
    backendId: z.string(),
    status: z.enum(['available', 'unavailable']),
    optional: z.literal(true),
    defaultBackend: z.enum(['builtin', 'fluidsynth']),
    selectionNote: z.string(),
    executable: executableDependencySchema,
    soundFont: soundFontDependencySchema,
    missingDependencies: z.array(z.enum(['executable', 'soundfont'])),
    smoke: z.object({
      attempted: z.boolean(),
      ok: z.boolean(),
      peak: z.number().nonnegative().nullable(),
      message: z.string(),
    }),
    note: z.string(),
    installHint: z.string(),
  }),
  guide: z.object({
    available: z.boolean(),
    source: z.literal('docs/schema-guide.md'),
    error: z.string().nullable(),
  }),
  projectRoot: projectRootReportSchema,
  jobs: jobSettingsSchema,
  configurationWarnings: z.array(z.string()),
  capabilities: z.object({
    renderFormats: z.array(z.string()),
    sampleRates: z.array(z.number().int().positive()),
    notes: z.array(z.string()),
  }),
});

export const getSchemaGuideOutputSchema = z.object({
  schemaVersion: z.string(),
  format: z.literal('markdown'),
  source: z.string(),
  bytes: z.number().int().positive(),
  markdown: z.string().min(1),
});

const registryLicenseSchema = z.object({
  spdx: z.enum(['MIT', 'NOASSERTION']),
  name: z.string(),
  copyright: z.string(),
  evidence: z.string(),
  redistribution: z.enum(['not_bundled', 'bundled']),
});

const registryProvenanceSchema = z.object({
  author: z.string(),
  upstream: z.string(),
  source: z.string(),
  sourceUrl: z.string().optional(),
  mapping: z.string(),
});

const registryChecksumSchema = z.object({
  algorithm: z.literal('sha256'),
  value: z.string(),
});

const registryAssetSchema = z.object({
  id: z.string(),
  fileName: z.string(),
  format: z.literal('sf2'),
  bytes: z.number().int().nonnegative(),
  checksum: registryChecksumSchema,
  license: registryLicenseSchema,
  provenance: registryProvenanceSchema,
  maxProjectAssetBytes: z.number().int().positive(),
});

const sampleBackendMappingSchema = z.object({
  backendId: z.string(),
  instrumentType: z.enum(['gm', 'soundfont']),
  assetId: z.string(),
  program: z.number().int().min(0).max(127),
  bank: z.number().int().min(0).max(128),
  channel: z.number().int().min(0).max(15),
  presetName: z.string(),
});

const instrumentCapabilitiesSchema = z.object({
  builtinSynth: z.boolean(),
  fluidSynth: z.boolean(),
  percussion: z.boolean(),
  songVariants: z.array(z.enum(['builtin', 'gm', 'soundfont'])),
});

const instrumentAvailabilitySchema = z.object({
  builtin: z.boolean(),
  sampleBackend: z.boolean(),
  missingDependencies: z.array(z.enum(['executable', 'soundfont'])),
  note: z.string(),
});

const instrumentEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  category: z.enum(['piano', 'keys', 'bass', 'pad', 'guitar', 'drums']),
  kind: z.enum(['melodic', 'percussion']),
  description: z.string(),
  midiProgram: z.number().int().min(0).max(127),
  midiBank: z.number().int().min(0).max(128),
  midiChannel: z.number().int().min(0).max(15),
  capabilities: instrumentCapabilitiesSchema,
  sampleBackend: sampleBackendMappingSchema,
  asset: registryAssetSchema,
  license: registryLicenseSchema,
  provenance: registryProvenanceSchema,
  availability: instrumentAvailabilitySchema,
});

const gmPresetSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: z.string(),
  program: z.number().int().min(0).max(127),
  bank: z.literal(0),
  description: z.string(),
  roles: z.array(z.enum(['chords', 'bass', 'melody', 'pad', 'texture'])),
  songInstrument: z.object({
    type: z.literal('gm'),
    program: z.number().int().min(0).max(127),
    bank: z.literal(0),
  }),
});

const drumNoteSchema = z.object({
  pitch: z.number().int().min(35).max(81),
  name: z.string(),
  family: z.string(),
});

const drumKitSchema = z.object({
  id: z.string(),
  name: z.string(),
  program: z.number().int().min(0).max(127),
  bank: z.literal(128),
  channel: z.literal(9),
  songInstrument: z.object({ type: z.literal('builtin'), id: z.string() }),
  noteMap: z.record(z.string(), z.number().int().min(35).max(81)),
  notes: z.array(drumNoteSchema),
});

export const listInstrumentsOutputSchema = z.object({
  schemaVersion: z.string(),
  registryVersion: z.number().int().nonnegative(),
  sampleBackendId: z.string(),
  sampleBackendInstrumentTypes: z.array(z.enum(['builtin', 'gm', 'soundfont', 'sfz'])),
  availability: z.object({
    builtin: z.boolean(),
    sampleBackend: z.boolean(),
    missingDependencies: z.array(z.enum(['executable', 'soundfont'])),
    note: z.string(),
  }),
  assets: z.array(registryAssetSchema),
  instruments: z.array(instrumentEntrySchema),
  gmCatalog: z.array(gmPresetSchema),
  drumKit: drumKitSchema,
});

const presetInstrumentSchema = z.object({
  role: z.enum(['chords', 'pad', 'bass', 'melody', 'drums']),
  label: z.string(),
  program: z.number().int().min(0).max(127).nullable(),
  description: z.string(),
});

const bgmPresetSchema = z.object({
  id: z.string(),
  name: z.string(),
  summary: z.string(),
  defaultSeconds: z.number().positive(),
  defaultBpm: z.number().int().positive(),
  defaultKey: z.object({
    tonic: z.enum(['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']),
    mode: z.enum(['major', 'minor']),
  }),
  mood: z.string(),
  tags: z.array(z.string()),
  romanNumerals: z.array(z.string()),
  instruments: z.array(presetInstrumentSchema),
  groove: z.string(),
  arrangement: z.string(),
  mix: z.string(),
  avoid: z.array(z.string()),
});

export const listPresetsOutputSchema = z.object({
  schemaVersion: z.string(),
  presets: z.array(bgmPresetSchema),
});

export type HealthCheckOutput = z.infer<typeof healthCheckOutputSchema>;
export type GetSchemaGuideOutput = z.infer<typeof getSchemaGuideOutputSchema>;
export type ListInstrumentsOutput = z.infer<typeof listInstrumentsOutputSchema>;
export type ListPresetsOutput = z.infer<typeof listPresetsOutputSchema>;
