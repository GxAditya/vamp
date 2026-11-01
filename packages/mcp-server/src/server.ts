/**
 * High-level McpServer construction for Vamp.
 *
 * The factory is separate from the executable entrypoint so tests and future
 * embedders can construct the server without starting stdio. Tool registration
 * and configuration remain reusable for Tasks 14 and 15.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { McpServerConfig } from './config.js';
import { registerProjectTools } from './project-tools.js';
import { RenderJobQueue } from './render-jobs.js';
import { registerRenderTools, type ArtifactRenderer } from './render-tools.js';
import { registerDiscoveryTools, type DiagnosticLogger } from './tools.js';

export interface CreateVampServerOptions {
  /** Diagnostics sink. Must never be stdout. Defaults to stderr. */
  readonly logger?: DiagnosticLogger;
  /**
   * Bounded render queue shared with the process lifecycle. The executable owns
   * it so its single guarded shutdown path can abort active renders; the factory
   * creates one when it is not supplied.
   */
  readonly renderJobs?: RenderJobQueue;
  /**
   * Test seam for the shared engine render operation. Production never sets it,
   * so `render_song` always runs `renderSongArtifacts` from `@gxaditya/vamp-engine`.
   */
  readonly renderer?: ArtifactRenderer;
}

export const SERVER_INSTRUCTIONS = `Vamp is a local-first, headless music engine for coding agents. It stores songs as versioned JSON projects, validates them, and renders offline WAV, MIDI, stems, and reports without network or model services.

Discovery first: call health_check to confirm the server, schema, project root, the default backend, FluidSynth, the discovered SoundFont, and a one-note smoke render; call get_schema_guide before authoring, because it is the authoritative SongSchemaV1 guide for timing, instruments, effects, duration, and BGM recipes; call list_instruments for the curated builtin IDs, the named General MIDI catalog, and the GM drum map; call list_presets for complete BGM recipes. Never invent instrument IDs or schema fields. The default render backend is auto: it uses real FluidSynth samples whenever the executable and a GM SoundFont are locally available, and otherwise falls back to the built-in synth with an explicit warning.

Authoring and edit loop: validate_song checks unsaved song data without writing anything, so use it before saving. create_song makes a new project at revision 1 inside the configured root from either a complete song or a preset id (lofi, tutorial_upbeat, ambient_focus, corporate_clean, stinger); presets generate full arrangements with sampled GM instruments, groove, velocity variation, effects, and a duration-correct tail, so prefer them when the brief fits; get_song reads one project and its current revision; list_projects discovers ids and revisions. update_song replaces the whole song on purpose, while add_track, add_notes, set_pattern, and set_instrument make focused edits by stable identity. Every persisted edit requires expectedRevision from the latest get_song: a stale value returns a repairable project.revision.conflict with both revisions and changes nothing, so re-read, reapply, and retry against the new revision. Because edits require the exact revision, a retried call cannot silently duplicate tracks or notes. Free notes are positional within a revision, so re-read before targeting one. All project tools are confined to the configured root, bound by file, event, and project limits, and reject traversal and symlink escapes; song content is data, never code.

Render and repair loop: render_song renders one saved revision into that project's confined renders/ tree and waits until every artifact is on disk, returning artifact paths, the revision rendered, the full report (duration, peak, loudness, clipping, backend, asset checksums, artifact hashes), and warnings. Call get_song first and pass expectedRevision when you must render an exact revision. The default backend is auto, which prefers real sample instruments; "builtin" forces the oscillator fallback and "fluidsynth" requires the configured executable and SoundFont. A tool argument never points at a path. Renders obey the bounded job settings: too many at once returns render.busy, a render past the deadline returns render.timeout, and cancellation or shutdown returns render.cancelled; none of them publishes partial files. Iterate like this: author or edit against the current revision, render that revision, read the report and warnings, repair the data with the edit tools, and re-render into a new renderName (the default render-<revision> keeps earlier renders intact unless overwrite is true). A missing or invalid project root does not stop the server; discovery and validate_song still work, and project and render tools return an actionable structured error.`;

/**
 * Create the Vamp MCP server with validated discovery, authoring, edit, and
 * render tools.
 *
 * Connection, transport creation, and process lifecycle belong to the caller.
 */
export function createVampMcpServer(
  config: McpServerConfig,
  options: CreateVampServerOptions = {},
): McpServer {
  const server = new McpServer(
    { name: config.serverName, version: config.serverVersion },
    {
      instructions: SERVER_INSTRUCTIONS,
      maxToolInputElements: config.jobs.maxToolInputElements,
    },
  );
  const registrationOptions = options.logger === undefined ? {} : { logger: options.logger };
  const renderJobs = options.renderJobs ?? new RenderJobQueue(config.jobs);
  registerDiscoveryTools(server, config, registrationOptions);
  registerProjectTools(server, config, registrationOptions);
  registerRenderTools(server, config, {
    ...registrationOptions,
    jobs: renderJobs,
    ...(options.renderer === undefined ? {} : { renderer: options.renderer }),
  });
  return server;
}
