/**
 * Validated MCP input and output shapes for the Task 15 `render_song` tool.
 *
 * The input schema is the render envelope only: project identity, the revision
 * to render, the confined render directory name, the artifact selection, and the
 * backend choice. It deliberately accepts no filesystem paths for executables,
 * SoundFonts, or output directories, because those are server configuration and
 * `ProjectStore` confinement, not tool arguments.
 *
 * The output schema mirrors the shared engine contract (`RenderReport` from
 * `@gxaditya/vamp-engine`) so the tool returns the real report rather than a second,
 * drifting shape. It never redefines render semantics: the engine owns them.
 */

import { z } from 'zod';

import { toolIssueSchema } from './project-schemas.js';

export const RENDER_SONG_TOOL = 'render_song' as const;

/** Safe single path segment for a render directory under `renders/`. */
export const RENDER_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Sample rates accepted by the engine, mirrored as literals for tool input. */
export const RENDER_SAMPLE_RATES = Object.freeze([44_100, 48_000] as const);

/** Default render directory name prefix when the caller does not choose one. */
export const RENDER_NAME_PREFIX = 'render-' as const;

export const renderSongInputSchema = z
  .object({
    projectId: z
      .string()
      .min(1)
      .max(64)
      .describe(
        'Existing Vamp project id inside the configured root. The tool renders the saved song of this project; it never accepts song data inline.',
      ),
    expectedRevision: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Optional revision you expect to render, read from get_song. When set and it does not match the stored revision, the tool returns a repairable project.revision.conflict and renders nothing, so you never render a song that changed under you.',
      ),
    renderName: z
      .string()
      .regex(RENDER_NAME_PATTERN)
      .optional()
      .describe(
        'Optional directory name for this render, placed under the project renders/ tree. Lowercase ASCII letters, digits, dot, underscore, or hyphen, 1 to 64 characters, with no path separators. Defaults to render-<revision>, so a re-render after an edit does not overwrite the previous render.',
      ),
    backend: z
      .enum(['auto', 'builtin', 'fluidsynth'])
      .optional()
      .describe(
        'Audio backend. "auto" (default) uses FluidSynth plus a locally discovered GM SoundFont when both are available, otherwise the deterministic built-in synth. "builtin" forces the pure-TypeScript oscillator fallback. "fluidsynth" requires the server-configured executable and SoundFont and fails with an actionable error when either is missing. A tool argument can never point at another binary or asset.',
      ),
    sampleRate: z
      .union([z.literal(44_100), z.literal(48_000)])
      .optional()
      .describe('Output sample rate in Hz. Defaults to 48000. Audio is never resampled.'),
    stems: z
      .boolean()
      .optional()
      .describe('Write one post-effect WAV stem per audible track. Defaults to true.'),
    midi: z.boolean().optional().describe('Write the Type 1 Standard MIDI file. Defaults to true.'),
    report: z
      .boolean()
      .optional()
      .describe(
        'Write report.json next to the audio. Defaults to true; report data is always returned.',
      ),
    overwrite: z
      .boolean()
      .optional()
      .describe(
        'Allow replacing artifact files that already exist in the chosen render directory. Defaults to false, so a repeated render into the same name fails clearly instead of silently replacing a prior render.',
      ),
    normalize: z
      .boolean()
      .optional()
      .describe(
        'Normalize the master and every stem to -1 dBFS with at most +9 dB of upward gain before WAV encoding. Defaults to true. Pass false to keep the raw authored mix levels.',
      ),
  })
  .strict();

const wavReportSchema = z.object({
  format: z.string(),
  formatVersion: z.number(),
  encoding: z.string(),
  audioFormat: z.literal(1),
  channels: z.literal(2),
  sampleRate: z.number().int(),
  bitDepth: z.number().int(),
  frameCount: z.number().int().nonnegative(),
  blockAlign: z.literal(4),
  byteRate: z.number().int().nonnegative(),
  dataBytes: z.number().int().nonnegative(),
  fileBytes: z.number().int().nonnegative(),
  peak: z.number(),
  peakDbfs: z.number().nullable(),
  clippedSampleCount: z.number().int().nonnegative(),
  clippedFrameCount: z.number().int().nonnegative(),
});

const midiEventCountsSchema = z.object({
  noteOn: z.number().int().nonnegative(),
  noteOff: z.number().int().nonnegative(),
  controlChange: z.number().int().nonnegative(),
  programChange: z.number().int().nonnegative(),
  meta: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});

const midiLimitationSchema = z.object({
  code: z.string(),
  message: z.string(),
  trackIndex: z.number().int().nonnegative().optional(),
  trackId: z.string().optional(),
  params: z
    .record(
      z.string(),
      z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.string())]),
    )
    .optional(),
});

const midiTrackReportSchema = z.object({
  timelineIndex: z.number().int().nonnegative(),
  midiTrack: z.number().int().nonnegative().nullable(),
  id: z.string(),
  name: z.string(),
  kind: z.enum(['midi', 'drums']),
  channel: z.number().int().min(0).max(15),
  audible: z.boolean(),
  included: z.boolean(),
  omitReason: z.string().nullable(),
  instrumentType: z.string(),
  program: z.number().int().nullable(),
  bank: z.object({ msb: z.number().int(), lsb: z.number().int() }).nullable(),
  eventCounts: midiEventCountsSchema,
});

const midiExportReportSchema = z.object({
  format: z.string(),
  formatVersion: z.number(),
  fileFormat: z.number().int(),
  ppq: z.number().int(),
  title: z.string(),
  tempo: z.object({
    bpm: z.number(),
    microsecondsPerQuarter: z.number().int(),
    rounding: z.literal('nearest'),
  }),
  timeSignature: z.object({
    numerator: z.number().int(),
    denominator: z.number().int(),
    denominatorExponent: z.number().int(),
    clocksPerClick: z.number().int(),
    thirtySecondsPerQuarter: z.literal(8),
  }),
  keySignature: z
    .object({
      tonic: z.string(),
      mode: z.enum(['major', 'minor']),
      fifths: z.number().int(),
      minor: z.boolean(),
      enharmonic: z.boolean(),
    })
    .nullable(),
  endMarker: z.enum(['rendered', 'content']),
  endTickSource: z.enum(['rendered', 'content']),
  endTick: z.number().int().nonnegative(),
  renderedTick: z.number().int().nonnegative(),
  contentEndTick: z.number().int().nonnegative(),
  renderedSeconds: z.number().nonnegative(),
  includeInaudibleTracks: z.boolean(),
  includeMixControllers: z.boolean(),
  trackCount: z.number().int().nonnegative(),
  midiTrackCount: z.number().int().nonnegative(),
  conductor: z.object({
    midiTrack: z.literal(0),
    name: z.string(),
    eventCounts: midiEventCountsSchema,
  }),
  tracks: z.array(midiTrackReportSchema),
  eventCounts: midiEventCountsSchema,
  limitations: z.array(midiLimitationSchema),
});

const artifactReportSchema = z.object({
  role: z.enum(['master', 'stem', 'midi']),
  /** Artifact file name relative to the render directory. */
  path: z.string(),
  format: z.enum(['wav', 'midi']),
  formatVersion: z.number(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string(),
  wav: wavReportSchema.nullable(),
});

export const renderReportSchema = z.object({
  format: z.string(),
  formatVersion: z.number(),
  schemaVersion: z.string(),
  title: z.string(),
  seed: z.number(),
  duration: z.object({
    requestedSeconds: z.number().nonnegative(),
    requestedBeats: z.number().nonnegative(),
    actualSeconds: z.number().nonnegative(),
    actualFrames: z.number().int().nonnegative(),
    deltaSeconds: z.number(),
    sampleRate: z.number().int(),
    channels: z.literal(2),
  }),
  audio: z.object({
    peak: z.number(),
    peakDbfs: z.number().nullable(),
    clipping: z.object({
      clipped: z.boolean(),
      clippedSampleCount: z.number().int().nonnegative(),
      clippedFrameCount: z.number().int().nonnegative(),
    }),
    mastering: z.object({
      applied: z.boolean(),
      gainDb: z.number(),
      targetDbfs: z.number().nullable(),
      peakBeforeDbfs: z.number().nullable(),
      peakAfterDbfs: z.number().nullable(),
      limited: z.boolean(),
    }),
    loudness: z.object({
      integratedLufs: z.number().nullable(),
      method: z.string(),
      description: z.string(),
      blockSeconds: z.number(),
      hopSeconds: z.number(),
      absoluteGateLufs: z.number(),
      relativeGateLu: z.number(),
      blockCount: z.number().int().nonnegative(),
      gatedBlockCount: z.number().int().nonnegative(),
      silence: z.boolean(),
      shortSignal: z.boolean(),
      limitations: z.array(z.string()),
    }),
  }),
  backend: z.object({
    id: z.string(),
    name: z.string(),
    version: z.string().nullable(),
    versionSource: z.enum(['declared', 'probe', 'unknown']),
    voicePolicy: z.string(),
    maxVoicesPerTrack: z.number().int().positive(),
  }),
  assets: z.object({
    registryVersion: z.number().int().nonnegative(),
    registry: z.array(
      z.object({
        assetId: z.string(),
        fileName: z.string(),
        format: z.literal('sf2'),
        bytes: z.number().int().nonnegative(),
        checksum: z.object({ algorithm: z.literal('sha256'), value: z.string() }),
        license: z.object({
          spdx: z.string(),
          name: z.string(),
          redistribution: z.string(),
        }),
        instrumentIds: z.array(z.string()),
        trackIds: z.array(z.string()),
      }),
    ),
    project: z.array(
      z.object({
        trackId: z.string(),
        path: z.string(),
        program: z.number().int(),
        bank: z.number().int(),
        checksum: z.null(),
        verification: z.literal('not-reported'),
      }),
    ),
  }),
  midi: z
    .object({
      path: z.string(),
      bytes: z.number().int().nonnegative(),
      sha256: z.string(),
      report: midiExportReportSchema,
    })
    .nullable(),
  stems: z.array(
    z.object({
      trackIndex: z.number().int().nonnegative(),
      trackId: z.string(),
      trackName: z.string(),
      audio: artifactReportSchema,
    }),
  ),
  artifacts: z.array(artifactReportSchema),
  outputs: z.object({
    master: z.string(),
    stems: z.array(z.string()),
    midi: z.string().nullable(),
    report: z.string().nullable(),
  }),
  warnings: z.object({
    validation: z.array(toolIssueSchema),
    audio: z.array(toolIssueSchema),
  }),
  stemInvariant: z.object({
    stemCount: z.number().int().nonnegative(),
    pcm16ToleranceLsb: z.number().int().nonnegative(),
    description: z.string(),
  }),
  /** Run-dependent fields: start time, elapsed milliseconds, absolute output directory. */
  run: z.object({
    startedAt: z.string(),
    elapsedMs: z.number().int().nonnegative(),
    outputDir: z.string(),
  }),
});

export const renderArtifactOutputSchema = z.object({
  role: z.enum(['master', 'stem', 'midi']),
  /** File name relative to the render directory, as reported by the engine. */
  path: z.string(),
  /** Absolute path inside the confined project renders/ tree. */
  absolutePath: z.string(),
  format: z.enum(['wav', 'midi']),
  bytes: z.number().int().nonnegative(),
  sha256: z.string(),
  trackId: z.string().nullable(),
});

export const renderSongOutputSchema = z.object({
  schemaVersion: z.string(),
  projectId: z.string(),
  /** The saved revision that was snapshotted and rendered. */
  revision: z.number().int().positive(),
  renderName: z.string(),
  /** Project-relative render directory, always under `renders/`. */
  renderPath: z.string(),
  /** Absolute confined render directory published by the engine. */
  outputDirectory: z.string(),
  backend: z.enum(['builtin', 'fluidsynth']),
  backendSelection: z.object({
    requested: z.enum(['auto', 'builtin', 'fluidsynth']),
    selected: z.enum(['builtin', 'fluidsynth']),
    note: z.string(),
  }),
  sampleRate: z.number().int(),
  artifacts: z.array(renderArtifactOutputSchema),
  reportFile: z
    .object({
      path: z.string(),
      absolutePath: z.string(),
    })
    .nullable(),
  outputs: z.object({
    master: z.string(),
    stems: z.array(z.string()),
    midi: z.string().nullable(),
    report: z.string().nullable(),
  }),
  summary: z.object({
    title: z.string(),
    durationSeconds: z.number().nonnegative(),
    artifactCount: z.number().int().nonnegative(),
    stemCount: z.number().int().nonnegative(),
    midi: z.boolean(),
    report: z.boolean(),
    peakDbfs: z.number().nullable(),
    integratedLufs: z.number().nullable(),
    clipped: z.boolean(),
  }),
  report: renderReportSchema,
  warnings: z.object({
    validation: z.array(toolIssueSchema),
    audio: z.array(toolIssueSchema),
  }),
  message: z.string(),
});

export type RenderSongInput = z.infer<typeof renderSongInputSchema>;
export type RenderSongOutput = z.infer<typeof renderSongOutputSchema>;
