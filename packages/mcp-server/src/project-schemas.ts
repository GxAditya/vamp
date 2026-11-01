/**
 * Validated MCP input and output shapes for the Task 14 authoring and granular
 * edit tools.
 *
 * These Zod schemas describe the tool envelope: identity strings, expected
 * revisions, insertion indices, and container shapes for song data. They are
 * deliberately not a second song schema. Song structure and semantics are
 * validated by `@gxaditya/vamp-schema` inside the store, and the complete resulting song
 * is re-validated before any atomic save. Song, track, pattern, note, and
 * instrument payloads are typed as JSON objects so Zod does not duplicate the
 * canonical schema or reject valid future fields before `@gxaditya/vamp-schema` sees them.
 */

import { z } from 'zod';

export const VALIDATE_SONG_TOOL = 'validate_song' as const;
export const CREATE_SONG_TOOL = 'create_song' as const;
export const GET_SONG_TOOL = 'get_song' as const;
export const LIST_PROJECTS_TOOL = 'list_projects' as const;
export const UPDATE_SONG_TOOL = 'update_song' as const;
export const ADD_TRACK_TOOL = 'add_track' as const;
export const ADD_NOTES_TOOL = 'add_notes' as const;
export const SET_PATTERN_TOOL = 'set_pattern' as const;
export const SET_INSTRUMENT_TOOL = 'set_instrument' as const;

export const AUTHORING_TOOL_NAMES = Object.freeze([
  VALIDATE_SONG_TOOL,
  CREATE_SONG_TOOL,
  GET_SONG_TOOL,
  LIST_PROJECTS_TOOL,
  UPDATE_SONG_TOOL,
  ADD_TRACK_TOOL,
  ADD_NOTES_TOOL,
  SET_PATTERN_TOOL,
  SET_INSTRUMENT_TOOL,
] as const);

/**
 * A JSON object payload. Zod checks the top-level shape only; `@gxaditya/vamp-schema`
 * owns the deep structure so this tool surface never becomes a second validator.
 */
const songObjectSchema = z
  .record(z.string(), z.unknown())
  .describe(
    'A complete SongSchemaV1 object with schemaVersion "1.0.0", meta, and tracks. Free-form JSON; the shared schema validator reports precise field-path issues when the song is checked.',
  );

const noteObjectSchema = z
  .record(z.string(), z.unknown())
  .describe(
    'One free-form note object with pitch (0..127), start (beats), duration (beats), and optional velocity (1..127). Times are quarter-note beats, not seconds or MIDI ticks.',
  );

const projectIdentitySchema = z
  .string()
  .min(1)
  .max(64)
  .describe(
    'Existing Vamp project id: one to 64 lowercase ASCII letters, digits, dot, underscore, or hyphen that stays inside the configured project root.',
  );

const expectedRevisionSchema = z
  .number()
  .int()
  .min(1)
  .describe(
    'The revision you read from get_song or the previous tool result. A persisted mutation only applies when this equals the stored revision; a stale value returns a repairable project.revision.conflict and changes nothing.',
  );

const insertionIndexSchema = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe(
    'Optional zero-based insertion index. Omit it to append at the end of the current array.',
  );

/**
 * A shared serializable validation issue shape. It mirrors the fields of
 * `@gxaditya/vamp-schema` ValidationIssue so structured errors stay stable for agents.
 */
export const toolIssueSchema = z.object({
  code: z.string(),
  severity: z.enum(['error', 'warning']),
  path: z.string(),
  message: z.string(),
  hint: z.string(),
  params: z
    .record(
      z.string(),
      z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.string())]),
    )
    .optional(),
});

const projectSnapshotSchema = z.object({
  projectId: z.string(),
  revision: z.number().int().positive(),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  song: z.record(z.string(), z.unknown()),
  warnings: z.array(toolIssueSchema),
});

const projectSummarySchema = z.object({
  projectId: z.string(),
  revision: z.number().int().positive(),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const validateSongInputSchema = z
  .object({
    song: songObjectSchema,
  })
  .strict();

export const validateSongOutputSchema = z.object({
  schemaVersion: z.string(),
  valid: z.boolean(),
  capabilityCheck: z.enum(['checked', 'not_checked']),
  errorCount: z.number().int().nonnegative(),
  warningCount: z.number().int().nonnegative(),
  errors: z.array(toolIssueSchema),
  warnings: z.array(toolIssueSchema),
  counts: z
    .object({
      tracks: z.number().int().nonnegative(),
      patterns: z.number().int().nonnegative(),
      notes: z.number().int().nonnegative(),
    })
    .nullable(),
  hint: z.string(),
});

export const createSongInputSchema = z
  .object({
    projectId: projectIdentitySchema,
    song: songObjectSchema.optional(),
    preset: z
      .enum(['lofi', 'tutorial_upbeat', 'ambient_focus', 'corporate_clean', 'stinger'])
      .optional()
      .describe(
        'Optional curated BGM preset. Generates a complete arrangement with real GM instruments, groove, velocity variation, effects, and a duration-correct tail. Provide either song or preset, not both.',
      ),
    title: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe('Optional title override for a generated preset song.'),
    bpm: z
      .number()
      .int()
      .min(20)
      .max(300)
      .optional()
      .describe('Optional tempo override for a generated preset song.'),
    durationSeconds: z
      .number()
      .min(2)
      .max(600)
      .optional()
      .describe('Optional rendered duration in seconds for a generated preset song.'),
  })
  .strict()
  .refine((value) => (value.song === undefined) !== (value.preset === undefined), {
    message: 'Provide exactly one of song or preset.',
    path: ['song'],
  })
  .refine(
    (value) =>
      value.preset !== undefined ||
      (value.title === undefined && value.bpm === undefined && value.durationSeconds === undefined),
    {
      message: 'title, bpm, and durationSeconds overrides require preset.',
      path: ['preset'],
    },
  );

export const projectWriteOutputSchema = z.object({
  schemaVersion: z.string(),
  project: projectSnapshotSchema,
  message: z.string(),
});

export const mutationOutputSchema = z.object({
  schemaVersion: z.string(),
  previousRevision: z.number().int().positive(),
  revision: z.number().int().positive(),
  project: projectSnapshotSchema,
  message: z.string(),
});

export const getSongInputSchema = z
  .object({
    projectId: projectIdentitySchema,
  })
  .strict();

export const getSongOutputSchema = z.object({
  schemaVersion: z.string(),
  project: projectSnapshotSchema,
});

export const listProjectsOutputSchema = z.object({
  schemaVersion: z.string(),
  root: z.string(),
  count: z.number().int().nonnegative(),
  projects: z.array(projectSummarySchema),
  message: z.string(),
});

export const updateSongInputSchema = z
  .object({
    projectId: projectIdentitySchema,
    expectedRevision: expectedRevisionSchema,
    song: songObjectSchema,
  })
  .strict();

export const addTrackInputSchema = z
  .object({
    projectId: projectIdentitySchema,
    expectedRevision: expectedRevisionSchema,
    track: z
      .record(z.string(), z.unknown())
      .describe(
        'A complete SongSchemaV1 track object with a unique string id, name, kind, channel, instrument, and optional notes/placements/automation/effects. Call list_instruments and use a real builtin instrument id.',
      ),
    index: insertionIndexSchema,
  })
  .strict();

export const addNotesInputSchema = z
  .object({
    projectId: projectIdentitySchema,
    expectedRevision: expectedRevisionSchema,
    trackId: z
      .string()
      .min(1)
      .max(128)
      .describe('The id of an existing track. Free notes are appended to that track.'),
    notes: z
      .array(noteObjectSchema)
      .min(1)
      .describe('One or more free-form note objects to append to the track.'),
    index: insertionIndexSchema,
  })
  .strict();

export const setPatternInputSchema = z
  .object({
    projectId: projectIdentitySchema,
    expectedRevision: expectedRevisionSchema,
    pattern: z
      .record(z.string(), z.unknown())
      .describe(
        'A complete SongSchemaV1 pattern object with a string id and a notes array. A pattern with the same id is replaced in place; otherwise it is appended. The id never changes.',
      ),
  })
  .strict();

export const setInstrumentInputSchema = z
  .object({
    projectId: projectIdentitySchema,
    expectedRevision: expectedRevisionSchema,
    trackId: z
      .string()
      .min(1)
      .max(128)
      .describe('The id of an existing track whose instrument is replaced.'),
    instrument: z
      .record(z.string(), z.unknown())
      .describe(
        'A complete SongSchemaV1 instrument object. For a builtin voice pass { "type": "builtin", "id": "<id>" } using an id from list_instruments. gm, soundfont, and sfz variants must satisfy the shared schema; soundfont and sfz paths are confined to the project assets/ directory.',
      ),
  })
  .strict();

export type ValidateSongInput = z.infer<typeof validateSongInputSchema>;
export type CreateSongInput = z.infer<typeof createSongInputSchema>;
export type GetSongInput = z.infer<typeof getSongInputSchema>;
export type UpdateSongInput = z.infer<typeof updateSongInputSchema>;
export type AddTrackInput = z.infer<typeof addTrackInputSchema>;
export type AddNotesInput = z.infer<typeof addNotesInputSchema>;
export type SetPatternInput = z.infer<typeof setPatternInputSchema>;
export type SetInstrumentInput = z.infer<typeof setInstrumentInputSchema>;
