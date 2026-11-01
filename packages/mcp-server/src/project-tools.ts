/**
 * Authoring and granular edit tools for the Vamp MCP server (Task 14).
 *
 * These tools reuse `ProjectStore` and `@gxaditya/vamp-schema` directly. They never build
 * a second editing model, validator, or storage layer: song structure and
 * semantics are validated by the shared validator, and every persisted mutation
 * runs through the store, which re-validates the complete resulting song and
 * enforces revision, limit, confinement, and atomic-save rules before it writes.
 *
 * Expected failures are `ProjectResult` values with stable `project.*` codes.
 * Each is mapped to an MCP `isError` CallToolResult carrying a stable code, an
 * optional field path, revision numbers, and repairable validation issues, so a
 * stale or invalid agent request can self-correct without crashing the server or
 * writing to disk. `validate_song` is the one tool that reads no project and
 * writes nothing: it checks unsaved song data in place.
 */

import {
  INSTRUMENT_REGISTRY_VALIDATION,
  createPresetSong,
  selectAutomaticBackend,
} from '@gxaditya/vamp-engine';
import type { ProjectError, ProjectSnapshot, ProjectStore, ProjectSummary } from '@gxaditya/vamp-project';
import { validateSong, SONG_SCHEMA_VERSION, type ValidationIssue } from '@gxaditya/vamp-schema';
import type { Instrument, Note, Pattern, Track } from '@gxaditya/vamp-schema';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { PROJECT_ROOT_ENV, type McpServerConfig } from './config.js';
import { createConfiguredProjectStore } from './project-root.js';
import { emptyToolInputSchema } from './schemas.js';
import {
  ADD_NOTES_TOOL,
  ADD_TRACK_TOOL,
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
import { errorResult, guardTool, toolError, toolSuccess, type DiagnosticLogger } from './tools.js';

const READ_ONLY_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

const WRITE_ANNOTATIONS = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
});

/** Convert a shared validation issue into a stable, serializable shape. */
function serializeIssue(issue: ValidationIssue): Record<string, unknown> {
  return {
    code: issue.code,
    severity: issue.severity,
    path: issue.path,
    message: issue.message,
    hint: issue.hint,
    ...(issue.params === undefined ? {} : { params: issue.params }),
  };
}

/** Convert a project snapshot into the structured content the tools return. */
function serializeSnapshot(snapshot: ProjectSnapshot): Record<string, unknown> {
  return {
    projectId: snapshot.projectId,
    revision: snapshot.revision,
    title: snapshot.title,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    song: snapshot.song,
    warnings: snapshot.warnings.map(serializeIssue),
  };
}

function serializeSummary(summary: ProjectSummary): Record<string, unknown> {
  return {
    projectId: summary.projectId,
    revision: summary.revision,
    title: summary.title,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
  };
}

function describeRevisionContext(error: ProjectError): string {
  if (error.code !== 'project.revision.conflict') {
    return '';
  }
  return ` Expected revision ${String(error.expectedRevision)}, current revision ${String(
    error.actualRevision,
  )}.`;
}

/**
 * Map any `ProjectResult` failure to a repairable MCP tool error. The error is
 * carried in the text content (never `structuredContent`, which must conform to
 * the tool's success `outputSchema`): a human line plus a JSON object with the
 * stable code, field path, both revisions, the complete schema issues for
 * invalid songs, and safe detail, so a stale or invalid agent request can
 * self-correct without crashing the server or writing to disk.
 */
export function projectToolError(error: ProjectError): CallToolResult {
  const payload: Record<string, unknown> = {
    code: error.code,
    message: error.message,
    hint: error.hint,
  };
  if (error.projectId !== undefined) {
    payload.projectId = error.projectId;
  }
  if (error.path !== undefined) {
    payload.path = error.path;
  }
  if (error.expectedRevision !== undefined) {
    payload.expectedRevision = error.expectedRevision;
  }
  if (error.actualRevision !== undefined) {
    payload.actualRevision = error.actualRevision;
  }
  if (error.issues !== undefined) {
    payload.issues = error.issues.map(serializeIssue);
  }
  if (error.detail !== undefined) {
    payload.detail = error.detail;
  }
  const text = `${error.message}${describeRevisionContext(error)}\nCode: ${error.code}. Hint: ${error.hint}`;
  return errorResult(payload, text);
}

/** Count authored data for a raw song payload without validating it. */
function countSongPayload(
  song: unknown,
): { readonly tracks: number; readonly patterns: number; readonly notes: number } | null {
  if (typeof song !== 'object' || song === null || Array.isArray(song)) {
    return null;
  }
  const record = song as Record<string, unknown>;
  const tracks = Array.isArray(record.tracks) ? record.tracks.length : 0;
  const patterns = Array.isArray(record.patterns) ? record.patterns.length : 0;
  let notes = 0;
  if (Array.isArray(record.tracks)) {
    for (const track of record.tracks) {
      if (typeof track === 'object' && track !== null && !Array.isArray(track)) {
        const trackNotes = (track as Record<string, unknown>).notes;
        if (Array.isArray(trackNotes)) {
          notes += trackNotes.length;
        }
      }
    }
  }
  if (Array.isArray(record.patterns)) {
    for (const pattern of record.patterns) {
      if (typeof pattern === 'object' && pattern !== null && !Array.isArray(pattern)) {
        const patternNotes = (pattern as Record<string, unknown>).notes;
        if (Array.isArray(patternNotes)) {
          notes += patternNotes.length;
        }
      }
    }
  }
  return { tracks, patterns, notes };
}

/**
 * Resolve the configured project store or return an actionable error result when
 * the server has no project root. An invalid or missing root that is configured
 * still produces a store; its operations return the shared `project.root.*`
 * codes, which the error mapper surfaces unchanged.
 */
function requireStore(
  config: McpServerConfig,
):
  | { readonly ok: true; readonly store: ProjectStore }
  | { readonly ok: false; readonly result: CallToolResult } {
  const store = createConfiguredProjectStore(config);
  if (store === null) {
    return {
      ok: false,
      result: toolError(
        'mcp.project_root.not_configured',
        'No project root is configured, so this project tool cannot read or write songs.',
        `Start the server with --project-root <absolute existing directory> or set ${PROJECT_ROOT_ENV}. Discovery tools still work without a root; create, read, list, and edit tools require a valid absolute projects root. Run health_check to see the current root status.`,
      ),
    };
  }
  return { ok: true, store };
}

function formatWarnings(snapshot: ProjectSnapshot): string {
  if (snapshot.warnings.length === 0) {
    return 'No validation warnings.';
  }
  const list = snapshot.warnings
    .map((warning) => `${warning.code} at ${warning.path || '(root)'}: ${warning.message}`)
    .join('; ');
  return `${String(snapshot.warnings.length)} validation warning(s): ${list}`;
}

interface RegisterToolOptions {
  readonly logger?: DiagnosticLogger;
}

/**
 * Register the Task 14 authoring and edit tools on a high-level McpServer.
 *
 * Registration is separate from `registerDiscoveryTools` so configuration,
 * logging, root handling, and error mapping stay reusable and identical for the
 * Task 15 render tool.
 */
export function registerProjectTools(
  server: McpServer,
  config: McpServerConfig,
  options: RegisterToolOptions = {},
): void {
  const logger = options.logger ?? ((message: string) => process.stderr.write(`${message}\n`));

  server.registerTool(
    VALIDATE_SONG_TOOL,
    {
      title: 'Validate a song',
      description:
        'Validate unsaved SongSchemaV1 data in place, without creating or touching any project. Use it before create_song or update_song to catch structure and cross-field errors early, and to inspect warnings. It calls the shared @gxaditya/vamp-schema validator with the authoritative curated instrument allowlist, so it reports stable issue codes, JSON Pointer field paths, repair hints, and separate warnings. It never writes files, never applies defaults to your input, never migrates versions, and never treats song data as code. Returns a normal result with valid true or false even when the song is invalid, so read the errors array rather than assuming transport failure. Times are quarter-note beats.',
      inputSchema: validateSongInputSchema,
      outputSchema: validateSongOutputSchema,
      annotations: { ...READ_ONLY_ANNOTATIONS, title: 'Validate a song' },
    },
    async (args: ValidateSongInput) =>
      guardTool(VALIDATE_SONG_TOOL, logger, async () => {
        const result = validateSong(args.song, INSTRUMENT_REGISTRY_VALIDATION);
        if (result.ok) {
          const output = {
            schemaVersion: result.schemaVersion,
            valid: true,
            capabilityCheck: result.capabilityCheck,
            errorCount: 0,
            warningCount: result.warnings.length,
            errors: [],
            warnings: result.warnings.map(serializeIssue),
            counts: countSongPayload(result.song),
            hint: 'The song is valid. Save it with create_song, or edit a stored project with update_song and the granular tools.',
          };
          return toolSuccess(
            `Valid SongSchemaV1: ${String(output.counts?.tracks ?? 0)} track(s), ${String(
              output.counts?.patterns ?? 0,
            )} pattern(s), ${String(output.counts?.notes ?? 0)} authored note(s). ${
              result.warnings.length === 0
                ? 'No warnings.'
                : `${String(result.warnings.length)} warning(s).`
            }`,
            validateSongOutputSchema.parse(output),
          );
        }
        const output = {
          schemaVersion: result.schemaVersion ?? 'unknown',
          valid: false,
          capabilityCheck: 'not_checked' as const,
          errorCount: result.errors.length,
          warningCount: result.warnings.length,
          errors: result.errors.map(serializeIssue),
          warnings: result.warnings.map(serializeIssue),
          counts: countSongPayload(args.song),
          hint: 'Fix every reported error at its field path and validate again. Nothing was written.',
        };
        return toolSuccess(
          `Invalid song: ${String(result.errors.length)} error(s), ${String(
            result.warnings.length,
          )} warning(s). See the errors array for codes and paths.`,
          validateSongOutputSchema.parse(output),
        );
      }),
  );

  server.registerTool(
    CREATE_SONG_TOOL,
    {
      title: 'Create a project',
      description:
        'Create a new confined Vamp project at revision 1 inside the configured project root. It writes nothing until the complete song validates through @gxaditya/vamp-schema with the curated instrument allowlist; invalid data, a duplicate project id, or a root escape returns a structured project.* error and leaves the filesystem unchanged. Provide EITHER a complete song object for custom work OR a preset id to generate a full BGM cue: "lofi", "tutorial_upbeat", "ambient_focus", "corporate_clean", or "stinger". Preset songs use real GM instruments, a groove, velocity variation, effects, and a duration-correct tail; override title, bpm, and durationSeconds with the preset. Choose a fresh lowercase project id of 1 to 64 characters from a-z, 0-9, dot, underscore, and hyphen. Call get_schema_guide, list_instruments, and list_presets first. Returns the project identity, revision, stored song, and warnings. Re-running create_song for an existing id returns project.exists; use the granular edit tools instead.',
      inputSchema: createSongInputSchema,
      outputSchema: projectWriteOutputSchema,
      annotations: { ...WRITE_ANNOTATIONS, title: 'Create a project' },
    },
    async (args: CreateSongInput) =>
      guardTool(CREATE_SONG_TOOL, logger, async () => {
        const store = requireStore(config);
        if (!store.ok) {
          return store.result;
        }
        let song = args.song;
        let presetNote = '';
        if (args.preset !== undefined) {
          song = createPresetSong(args.preset, {
            ...(args.title === undefined ? {} : { title: args.title }),
            ...(args.bpm === undefined ? {} : { bpm: args.bpm }),
            ...(args.durationSeconds === undefined
              ? {}
              : { durationSeconds: args.durationSeconds }),
          }) as unknown as Record<string, unknown>;
          const sample = await selectAutomaticBackend();
          if (sample.fellBackToBuiltin) {
            presetNote =
              ' Note: no FluidSynth SoundFont was found, so this GM preset needs the sample backend before it can render. Run health_check, install FluidSynth and a GM SoundFont, or use the six curated builtin IDs for a fallback-only song.';
          }
        }
        if (song === undefined) {
          return toolError(
            'project.song.missing',
            'create_song needs either a complete song object or a preset id.',
            'Pass song: { ... } for custom data, or preset: "lofi" | "tutorial_upbeat" | "ambient_focus" | "corporate_clean" | "stinger".',
          );
        }
        const result = await store.store.create({ projectId: args.projectId, song });
        if (!result.ok) {
          return projectToolError(result);
        }
        const output = projectWriteOutputSchema.parse({
          schemaVersion: SONG_SCHEMA_VERSION,
          project: serializeSnapshot(result.value),
          message: `Created project "${result.value.projectId}" at revision ${String(
            result.value.revision,
          )}. ${formatWarnings(result.value)}${presetNote}`,
        });
        return toolSuccess(output.message, output);
      }),
  );

  server.registerTool(
    GET_SONG_TOOL,
    {
      title: 'Read a project',
      description:
        'Read one project from the configured root and return its validated SongSchemaV1, private revision number, identity, and current warnings. Use it to learn the exact revision before any persisted edit, and to re-read after a conflict so your next edit targets the current state. It resolves the confined project directory, song file, and metadata through @gxaditya/vamp-project and rejects symlink or traversal escapes; a missing or malformed project returns a structured project.* error. Read-only, idempotent, offline, and it never rewrites saved data or injects timestamps.',
      inputSchema: getSongInputSchema,
      outputSchema: getSongOutputSchema,
      annotations: { ...READ_ONLY_ANNOTATIONS, title: 'Read a project' },
    },
    async (args: GetSongInput) =>
      guardTool(GET_SONG_TOOL, logger, async () => {
        const store = requireStore(config);
        if (!store.ok) {
          return store.result;
        }
        const result = await store.store.get(args.projectId);
        if (!result.ok) {
          return projectToolError(result);
        }
        const output = getSongOutputSchema.parse({
          schemaVersion: SONG_SCHEMA_VERSION,
          project: serializeSnapshot(result.value),
        });
        return toolSuccess(
          `Project "${result.value.projectId}" at revision ${String(
            result.value.revision,
          )}: ${result.value.title}. ${formatWarnings(result.value)}`,
          output,
        );
      }),
  );

  server.registerTool(
    LIST_PROJECTS_TOOL,
    {
      title: 'List projects',
      description:
        'List every complete Vamp project in the configured root, sorted by project id, with each project identity, current revision, title, and timestamps. It reads only private metadata, bounds directory enumeration, and skips directories that are not valid Vamp projects. Use it to discover valid ids and the current revision before get_song or an edit. Takes no input arguments. A missing or invalid root returns a structured project.root.* error rather than an empty list. Read-only, idempotent, and confined to the configured root.',
      inputSchema: emptyToolInputSchema,
      outputSchema: listProjectsOutputSchema,
      annotations: { ...READ_ONLY_ANNOTATIONS, title: 'List projects' },
    },
    async () =>
      guardTool(LIST_PROJECTS_TOOL, logger, async () => {
        const store = requireStore(config);
        if (!store.ok) {
          return store.result;
        }
        const result = await store.store.list();
        if (!result.ok) {
          return projectToolError(result);
        }
        const output = listProjectsOutputSchema.parse({
          schemaVersion: SONG_SCHEMA_VERSION,
          root: store.store.root,
          count: result.value.length,
          projects: result.value.map(serializeSummary),
          message:
            result.value.length === 0
              ? 'The configured project root contains no projects yet. Create one with create_song.'
              : `Found ${String(result.value.length)} project(s). Use get_song with a projectId and its revision before editing.`,
        });
        return toolSuccess(output.message, output);
      }),
  );

  server.registerTool(
    UPDATE_SONG_TOOL,
    {
      title: 'Replace a song',
      description:
        'Explicitly replace the entire song of an existing project. This is full replacement, not a merge or patch: pass a complete valid SongSchemaV1. expectedRevision must equal the revision returned by get_song; a stale value returns a repairable project.revision.conflict with both revisions and changes nothing. The complete resulting song is validated before an atomic save, so an invalid song returns project.song.invalid with field paths and writes nothing. Returns the new revision, identity, stored song, and warnings. For small changes prefer the granular tools (add_track, add_notes, set_pattern, set_instrument) so you do not overwrite concurrent edits or lose fields. Times are quarter-note beats.',
      inputSchema: updateSongInputSchema,
      outputSchema: mutationOutputSchema,
      annotations: { ...WRITE_ANNOTATIONS, title: 'Replace a song' },
    },
    async (args: UpdateSongInput) =>
      guardTool(UPDATE_SONG_TOOL, logger, async () => {
        const store = requireStore(config);
        if (!store.ok) {
          return store.result;
        }
        const result = await store.store.updateSong(args.projectId, {
          expectedRevision: args.expectedRevision,
          song: args.song,
        });
        if (!result.ok) {
          return projectToolError(result);
        }
        return mutationSuccess(args.expectedRevision, result.value, {
          message: `Replaced the song of project "${result.value.projectId}" at revision ${String(
            result.value.revision,
          )}. ${formatWarnings(result.value)}`,
        });
      }),
  );

  server.registerTool(
    ADD_TRACK_TOOL,
    {
      title: 'Add a track',
      description:
        'Append or insert one complete SongSchemaV1 track on a project by stable track id. The new track id must not already exist or the edit returns project.edit.duplicate_track and changes nothing; ids are schema-owned and never renamed here. The full resulting song, including the new track instrument, is validated before an atomic save. Pass expectedRevision from get_song; a stale revision returns project.revision.conflict, which is why a retried add does not create duplicates. Set index to a zero-based position to insert, or omit it to append. Call list_instruments first and use a real builtin instrument id rather than inventing one. Returns the new revision, identity, stored song, and warnings.',
      inputSchema: addTrackInputSchema,
      outputSchema: mutationOutputSchema,
      annotations: { ...WRITE_ANNOTATIONS, title: 'Add a track' },
    },
    async (args: AddTrackInput) =>
      guardTool(ADD_TRACK_TOOL, logger, async () => {
        const store = requireStore(config);
        if (!store.ok) {
          return store.result;
        }
        const result = await store.store.addTrack(args.projectId, {
          expectedRevision: args.expectedRevision,
          track: args.track as unknown as Track,
          ...(args.index === undefined ? {} : { index: args.index }),
        });
        if (!result.ok) {
          return projectToolError(result);
        }
        return mutationSuccess(args.expectedRevision, result.value, {
          message: `Added track "${String((args.track as Record<string, unknown>).id ?? '')}" to project "${
            result.value.projectId
          }" at revision ${String(result.value.revision)}. ${formatWarnings(result.value)}`,
        });
      }),
  );

  server.registerTool(
    ADD_NOTES_TOOL,
    {
      title: 'Add notes',
      description:
        'Append or insert free-form notes on one existing track, identified by trackId. Schema notes have no id, so free-note identity is positional within the current revision: (trackId, zero-based index, expectedRevision). Pass expectedRevision from get_song; a stale revision returns project.revision.conflict and applies nothing, so a retried call cannot duplicate notes. Set index to insert at a zero-based position, or omit it to append at the end; positions shift after later edits, so re-read before editing a specific note. Times and durations are quarter-note beats, pitch is MIDI 0 to 127, velocity is optional 1 to 127. The complete resulting song is validated before an atomic save; an unknown track returns project.edit.track_not_found. Returns the new revision, identity, stored song, and warnings.',
      inputSchema: addNotesInputSchema,
      outputSchema: mutationOutputSchema,
      annotations: { ...WRITE_ANNOTATIONS, title: 'Add notes' },
    },
    async (args: AddNotesInput) =>
      guardTool(ADD_NOTES_TOOL, logger, async () => {
        const store = requireStore(config);
        if (!store.ok) {
          return store.result;
        }
        const result = await store.store.addNotes(args.projectId, {
          expectedRevision: args.expectedRevision,
          trackId: args.trackId,
          notes: args.notes as unknown as Note[],
          ...(args.index === undefined ? {} : { index: args.index }),
        });
        if (!result.ok) {
          return projectToolError(result);
        }
        return mutationSuccess(args.expectedRevision, result.value, {
          message: `Added ${String(args.notes.length)} note(s) to track "${args.trackId}" in project "${
            result.value.projectId
          }" at revision ${String(result.value.revision)}. ${formatWarnings(result.value)}`,
        });
      }),
  );

  server.registerTool(
    SET_PATTERN_TOOL,
    {
      title: 'Create or replace a pattern',
      description:
        'Create or replace one reusable pattern by its stable id. A pattern with the same id is replaced in place; otherwise it is appended, so this is idempotent against the same revision rather than duplicating. The id never changes here. Pass expectedRevision from get_song; a stale revision returns project.revision.conflict and writes nothing. Pattern notes are edited by replacing the whole pattern (there is no per-note edit inside a pattern), and placements reference the pattern id. The complete resulting song is validated before an atomic save, so unresolved placements or duplicate pattern ids fail clearly with paths. Times are quarter-note beats. Returns the new revision, identity, stored song, and warnings.',
      inputSchema: setPatternInputSchema,
      outputSchema: mutationOutputSchema,
      annotations: { ...WRITE_ANNOTATIONS, title: 'Create or replace a pattern' },
    },
    async (args: SetPatternInput) =>
      guardTool(SET_PATTERN_TOOL, logger, async () => {
        const store = requireStore(config);
        if (!store.ok) {
          return store.result;
        }
        const result = await store.store.setPattern(args.projectId, {
          expectedRevision: args.expectedRevision,
          pattern: args.pattern as unknown as Pattern,
        });
        if (!result.ok) {
          return projectToolError(result);
        }
        return mutationSuccess(args.expectedRevision, result.value, {
          message: `Set pattern "${String((args.pattern as Record<string, unknown>).id ?? '')}" in project "${
            result.value.projectId
          }" at revision ${String(result.value.revision)}. ${formatWarnings(result.value)}`,
        });
      }),
  );

  server.registerTool(
    SET_INSTRUMENT_TOOL,
    {
      title: 'Set a track instrument',
      description:
        'Replace the instrument of one existing track by trackId. Pass a complete SongSchemaV1 instrument object. list_instruments is the source of truth: for a curated voice use { "type": "builtin", "id": "<id>" } with an id from that registry; gm, soundfont, and sfz variants must satisfy the shared schema, and soundfont/sfz asset paths are confined to the project assets/ directory. Unknown builtin ids and root escapes return structured errors, and the complete resulting song is validated before an atomic save. Pass expectedRevision from get_song; a stale revision returns project.revision.conflict and changes nothing, so a retried call does not double-apply. Returns the new revision, identity, stored song, and warnings.',
      inputSchema: setInstrumentInputSchema,
      outputSchema: mutationOutputSchema,
      annotations: { ...WRITE_ANNOTATIONS, title: 'Set a track instrument' },
    },
    async (args: SetInstrumentInput) =>
      guardTool(SET_INSTRUMENT_TOOL, logger, async () => {
        const store = requireStore(config);
        if (!store.ok) {
          return store.result;
        }
        const result = await store.store.setInstrument(args.projectId, {
          expectedRevision: args.expectedRevision,
          trackId: args.trackId,
          instrument: args.instrument as unknown as Instrument,
        });
        if (!result.ok) {
          return projectToolError(result);
        }
        return mutationSuccess(args.expectedRevision, result.value, {
          message: `Set the instrument of track "${args.trackId}" in project "${
            result.value.projectId
          }" at revision ${String(result.value.revision)}. ${formatWarnings(result.value)}`,
        });
      }),
  );
}

function mutationSuccess(
  previousRevision: number,
  snapshot: ProjectSnapshot,
  summary: { readonly message: string },
): CallToolResult {
  const output = mutationOutputSchema.parse({
    schemaVersion: SONG_SCHEMA_VERSION,
    previousRevision,
    revision: snapshot.revision,
    project: serializeSnapshot(snapshot),
    message: summary.message,
  });
  return toolSuccess(output.message, output);
}
