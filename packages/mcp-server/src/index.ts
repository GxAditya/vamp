/**
 * @gxaditya/vamp-mcp-server public API.
 *
 * The package exposes the stdio MCP server factory, configuration parsing,
 * health reporting, guide access, and the authoritative discovery tools. The
 * executable entrypoint is `dist/main.js`; the package `main` export is a
 * library surface for tests and future embedders.
 *
 * The server depends on `@gxaditya/vamp-schema`, `@gxaditya/vamp-engine`, and `@gxaditya/vamp-project`.
 * It does not own a second validator, renderer, instrument registry, or schema
 * guide. No HTTP transport, model call, or network access is implemented.
 */

export const PACKAGE_NAME = '@gxaditya/vamp-mcp-server' as const;

export {
  DEFAULT_FLUIDSYNTH_PATH,
  FLUIDSYNTH_PATH_ENV,
  MAX_CONCURRENT_RENDERS_ENV,
  MAX_PENDING_JOBS_ENV,
  MCP_HELP,
  MCP_JOB_SETTINGS,
  PROJECT_ROOT_ENV,
  RENDER_TIMEOUT_MS_ENV,
  SERVER_NAME,
  SOUNDFONT_PATH_ENV,
  parseMcpServerConfig,
  readPackageVersion,
  type ConfigParseResult,
  type ConfigurationSource,
  type FluidSynthConfiguration,
  type McpJobSettings,
  type McpServerConfig,
  type ProjectRootConfiguration,
} from './config.js';

export { SCHEMA_GUIDE_SOURCE, readSchemaGuide, type SchemaGuideReadResult } from './guide.js';

export {
  buildHealthReport,
  describeSampleBackend,
  type BuiltInRenderingReport,
  type BuiltInRenderingStatus,
  type ExecutableDependencyReport,
  type GuideHealthReport,
  type HealthReport,
  type SampleBackendReport,
  type SampleBackendStatus,
  type SoundFontDependencyReport,
  type SoundFontStatus,
} from './health.js';

export {
  createConfiguredProjectStore,
  describeProjectRoot,
  type ProjectRootReport,
  type ProjectRootStatus,
} from './project-root.js';

export {
  DISCOVERY_TOOL_NAMES,
  GET_SCHEMA_GUIDE_TOOL,
  HEALTH_CHECK_TOOL,
  LIST_INSTRUMENTS_TOOL,
  emptyToolInputSchema,
  getSchemaGuideOutputSchema,
  healthCheckOutputSchema,
  listInstrumentsOutputSchema,
  type GetSchemaGuideOutput,
  type HealthCheckOutput,
  type ListInstrumentsOutput,
} from './schemas.js';

export {
  ADD_NOTES_TOOL,
  ADD_TRACK_TOOL,
  AUTHORING_TOOL_NAMES,
  CREATE_SONG_TOOL,
  GET_SONG_TOOL,
  LIST_PROJECTS_TOOL,
  SET_INSTRUMENT_TOOL,
  SET_PATTERN_TOOL,
  UPDATE_SONG_TOOL,
  VALIDATE_SONG_TOOL,
  addNotesInputSchema,
  addTrackInputSchema,
  createSongInputSchema,
  getSongInputSchema,
  getSongOutputSchema,
  listProjectsOutputSchema,
  mutationOutputSchema,
  projectWriteOutputSchema,
  setInstrumentInputSchema,
  setPatternInputSchema,
  toolIssueSchema,
  updateSongInputSchema,
  validateSongInputSchema,
  validateSongOutputSchema,
  type AddNotesInput,
  type AddTrackInput,
  type CreateSongInput,
  type GetSongInput,
  type SetInstrumentInput,
  type SetPatternInput,
  type UpdateSongInput,
  type ValidateSongInput,
} from './project-schemas.js';

export {
  registerDiscoveryTools,
  guardTool,
  toolError,
  toolSuccess,
  type DiagnosticLogger,
  type ToolErrorPayload,
} from './tools.js';

export { projectToolError, registerProjectTools } from './project-tools.js';

export {
  RENDER_NAME_PATTERN,
  RENDER_SONG_TOOL,
  renderArtifactOutputSchema,
  renderReportSchema,
  renderSongInputSchema,
  renderSongOutputSchema,
  type RenderSongInput,
  type RenderSongOutput,
} from './render-schemas.js';

export { RenderJobQueue, type RenderJobRejection, type RenderJobResult } from './render-jobs.js';

export {
  registerRenderTools,
  type ArtifactRenderer,
  type RegisterRenderToolOptions,
} from './render-tools.js';

export {
  SERVER_INSTRUCTIONS,
  createVampMcpServer,
  type CreateVampServerOptions,
} from './server.js';
