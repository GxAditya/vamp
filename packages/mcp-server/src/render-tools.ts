/**
 * The Task 15 `render_song` tool: render one saved project revision into a
 * confined directory under that project's `renders/` tree.
 *
 * The tool is a thin adapter over the shared engine operation
 * `renderSongArtifacts`. It owns no renderer, mixer, stem capture, report, or
 * artifact writer. It does three things the engine does not: it reads a validated
 * immutable snapshot of the stored song so a concurrent edit cannot change the
 * data mid-render, it resolves the output directory through `ProjectStore`
 * confinement so a render can never escape the configured root, and it runs the
 * render inside the bounded `RenderJobQueue` so concurrency, pending depth,
 * timeouts, cancellation, and shutdown are all actionable errors rather than
 * hangs or partial successes.
 *
 * Backend choice is deliberately narrow: the deterministic built-in synth is the
 * default and needs no native dependency, and an explicit FluidSynth selection
 * uses only the executable and SoundFont configured on the server. A tool
 * argument can never inject an executable or asset path.
 */

import {
  INSTRUMENT_REGISTRY_VALIDATION,
  createFluidSynthBackend,
  isFluidSynthBinaryAvailable,
  renderSongArtifacts,
  selectAutomaticBackend,
  type AudioIssue,
  type RenderSongArtifactsOptions,
  type RenderSongArtifactsResult,
} from '@gxaditya/vamp-engine';
import type { ProjectError, ProjectSnapshot, ProjectStore } from '@gxaditya/vamp-project';
import type { CompileIssue } from '@gxaditya/vamp-engine';
import type { ValidationIssue } from '@gxaditya/vamp-schema';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SONG_SCHEMA_VERSION } from '@gxaditya/vamp-schema';

import type { McpServerConfig } from './config.js';
import { createConfiguredProjectStore } from './project-root.js';
import { projectToolError } from './project-tools.js';
import {
  RENDER_SONG_TOOL,
  renderSongInputSchema,
  renderSongOutputSchema,
  type RenderSongInput,
} from './render-schemas.js';
import type { RenderJobQueue, RenderJobRejection } from './render-jobs.js';
import { errorResult, guardTool, toolError, toolSuccess, type DiagnosticLogger } from './tools.js';

/** Engine render operation signature, replaceable only by tests. */
export type ArtifactRenderer = (
  song: unknown,
  options: RenderSongArtifactsOptions,
) => Promise<RenderSongArtifactsResult>;

export interface RegisterRenderToolOptions {
  readonly logger?: DiagnosticLogger;
  /** Shared bounded render queue; one per server instance. */
  readonly jobs: RenderJobQueue;
  /**
   * Test seam. Production always uses `renderSongArtifacts` from `@gxaditya/vamp-engine`;
   * tests may pass a slow or failing renderer so the lifecycle bounds are
   * observable without slowing the production engine.
   */
  readonly renderer?: ArtifactRenderer;
}

const WRITE_ANNOTATIONS = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
});

const DEFAULT_SAMPLE_RATE = 48_000 as const;

function serializeValidationIssue(
  issue: ValidationIssue | CompileIssue | AudioIssue,
): Record<string, unknown> {
  return {
    code: issue.code,
    severity: issue.severity,
    path: issue.path,
    message: issue.message,
    hint: issue.hint,
    ...(issue.params === undefined ? {} : { params: issue.params }),
  };
}

function renderError(payload: Record<string, unknown>, humanText: string): CallToolResult {
  return errorResult(payload, humanText);
}

function lifecycleFailure(rejection: RenderJobRejection): CallToolResult {
  if (rejection.status === 'timeout') {
    return renderError(
      {
        code: 'render.timeout',
        message: `The render exceeded the configured ${String(rejection.timeoutMs)} ms render timeout and was aborted.`,
        hint: 'No partial artifacts were published. Shorten the song, lower the sample rate, or restart the server with a larger --render-timeout-ms (10000 to 600000). An in-flight native backend call finishes before the engine cleans up job output.',
        timeoutMs: rejection.timeoutMs,
        elapsedMs: rejection.elapsedMs,
      },
      `Render timed out after ${String(rejection.timeoutMs)} ms.\nCode: render.timeout. Hint: No partial artifacts were published. Shorten the song, lower the sample rate, or restart the server with a larger --render-timeout-ms (10000 to 600000). An in-flight native backend call finishes before the engine cleans up job output.`,
    );
  }
  if (rejection.status === 'cancelled') {
    return renderError(
      {
        code: 'render.cancelled',
        message: 'The render was cancelled before any artifacts were published.',
        hint: 'No partial artifacts were published. Call render_song again when ready. An in-flight native backend call finishes before the engine cleans up job output.',
        elapsedMs: rejection.elapsedMs,
      },
      'Render cancelled.\nCode: render.cancelled. Hint: No partial artifacts were published. Call render_song again when ready. An in-flight native backend call finishes before the engine cleans up job output.',
    );
  }
  const shuttingDown = rejection.status === 'closed';
  const counts = `${String(rejection.running)} running, ${String(rejection.queued)} queued of ${String(
    rejection.maxPendingJobs,
  )} allowed`;
  return renderError(
    {
      code: 'render.busy',
      message: shuttingDown
        ? 'The server is shutting down, so no new render was started.'
        : `The render queue is full (${counts}).`,
      hint: shuttingDown
        ? 'Restart the server, then call render_song again. Running renders were aborted and their job output was cleaned up.'
        : `Wait for a render to finish and retry, or restart the server with larger --max-concurrent-renders (1 to 4) and --max-pending-jobs (0 to 16) bounds. No partial artifacts were published.`,
      running: rejection.running,
      queued: rejection.queued,
      maxConcurrentRenders: rejection.maxConcurrentRenders,
      maxPendingJobs: rejection.maxPendingJobs,
    },
    shuttingDown
      ? `Server is shutting down; no render started.\nCode: render.busy. Hint: Restart the server, then call render_song again.`
      : `Render queue is full (${counts}).\nCode: render.busy. Hint: Wait for a render to finish and retry, or raise --max-concurrent-renders and --max-pending-jobs.`,
  );
}

/**
 * Map an engine failure into the Task 14 error format: a stable code, the human
 * line, and the complete repairable issue list, all in text content.
 */
function engineFailure(
  result: Extract<RenderSongArtifactsResult, { ok: false }>,
  context: {
    readonly projectId: string;
    readonly revision: number;
    readonly renderPath: string;
  },
): CallToolResult {
  const base = {
    projectId: context.projectId,
    revision: context.revision,
    renderPath: context.renderPath,
    stage: result.stage,
  };

  if (result.stage === 'validation') {
    const issues = result.errors.map(serializeValidationIssue);
    const first = result.errors[0];
    return renderError(
      {
        code: 'project.song.invalid',
        message: `The stored song for project "${context.projectId}" at revision ${String(
          context.revision,
        )} no longer validates, so nothing was rendered.`,
        hint:
          first?.hint ??
          'Fix every reported issue at its field path, save the corrected song with update_song against the current revision, and render again.',
        issues,
        ...base,
      },
      `Stored song is invalid; nothing was rendered.\nCode: project.song.invalid. Hint: ${
        first?.message ?? 'Fix the reported issues and render again.'
      }`,
    );
  }

  if (result.stage === 'compile') {
    const issues = result.errors.map(serializeValidationIssue);
    const first = result.errors[0];
    return renderError(
      {
        code: 'render.compile.failed',
        message: `The stored song for project "${context.projectId}" at revision ${String(
          context.revision,
        )} could not be compiled into a render timeline.`,
        hint:
          first?.hint ??
          'Inspect the issue paths, edit the song with the granular tools against the current revision, and render again.',
        issues,
        ...base,
      },
      `Song compilation failed; nothing was rendered.\nCode: render.compile.failed. Hint: ${
        first?.message ?? 'Inspect the reported issues and render again.'
      }`,
    );
  }

  if (result.stage === 'cancelled') {
    return renderError(
      {
        code: 'render.cancelled',
        message: 'The render was cancelled before any artifacts were published.',
        hint: 'No partial artifacts were published. Call render_song again when ready. An in-flight native backend call finishes before the engine cleans up job output.',
        ...base,
      },
      'Render cancelled.\nCode: render.cancelled. Hint: No partial artifacts were published. Call render_song again when ready.',
    );
  }

  const first = result.errors[0];
  const code = first?.code ?? 'render.failed';
  return renderError(
    {
      code,
      message: first?.message ?? 'The render failed before any artifacts were published.',
      hint:
        first?.hint ??
        'Inspect the reported issues, correct the song or the server backend configuration, and render again.',
      issues: result.errors.map(serializeValidationIssue),
      ...base,
    },
    `${first?.message ?? 'Render failed.'}\nCode: ${code}. Hint: ${
      first?.hint ?? 'Inspect the reported issues and render again.'
    }`,
  );
}

interface BackendSelection {
  readonly requested: 'auto' | 'builtin' | 'fluidsynth';
  readonly id: 'builtin' | 'fluidsynth';
  readonly backend: RenderSongArtifactsOptions['backend'];
  readonly note: string;
  readonly missingDependencies: readonly ('executable' | 'soundfont')[];
}

function usesSampleInstruments(song: unknown): boolean {
  if (typeof song !== 'object' || song === null) {
    return false;
  }
  const tracks = (song as { readonly tracks?: unknown }).tracks;
  if (!Array.isArray(tracks)) {
    return false;
  }
  return tracks.some((track) => {
    if (typeof track !== 'object' || track === null) {
      return false;
    }
    const instrument = (track as { readonly instrument?: unknown }).instrument;
    if (typeof instrument !== 'object' || instrument === null) {
      return false;
    }
    const type = (instrument as { readonly type?: unknown }).type;
    return type === 'gm' || type === 'soundfont' || type === 'sfz';
  });
}

/**
 * Resolve the backend from server configuration only. A tool argument selects
 * auto, builtin, or fluidsynth and can never point at another executable,
 * SoundFont, or asset root. Auto prefers the real sample path.
 */
async function selectBackend(
  config: McpServerConfig,
  requested: 'auto' | 'builtin' | 'fluidsynth',
  projectDirectory: string,
): Promise<{ ok: true; value: BackendSelection } | { ok: false; result: CallToolResult }> {
  if (requested === 'builtin') {
    return {
      ok: true,
      value: {
        requested,
        id: 'builtin',
        backend: undefined,
        note: 'Builtin backend selected explicitly. Timbres are synthesized and no SoundFont is used.',
        missingDependencies: [],
      },
    };
  }

  if (requested === 'auto') {
    const selection = await selectAutomaticBackend({
      binaryPath: config.fluidSynth.binaryPath,
      ...(config.fluidSynth.soundFontPath === null
        ? {}
        : { soundFontPath: config.fluidSynth.soundFontPath }),
      projectRoot: projectDirectory,
    });
    return {
      ok: true,
      value: {
        requested,
        id: selection.id,
        backend: selection.backend,
        note: selection.note,
        missingDependencies: selection.missingDependencies,
      },
    };
  }

  const missing: string[] = [];
  const executableAvailable = await isFluidSynthBinaryAvailable(config.fluidSynth.binaryPath);
  if (!executableAvailable) {
    missing.push(`executable ${config.fluidSynth.binaryPath}`);
  }
  const configuredSoundFont = config.fluidSynth.soundFontPath;
  if (configuredSoundFont === null) {
    missing.push('the configured GM SoundFont (set --soundfont or VAMP_SOUNDFONT_PATH)');
  }
  if (missing.length > 0) {
    const message = `FluidSynth rendering is unavailable: ${missing.join(' and ')} is missing.`;
    return {
      ok: false,
      result: renderError(
        {
          code: 'audio.backend.missing_dependency',
          message,
          hint: 'Provision the dependency and restart the server with --fluidsynth-path/--soundfont or VAMP_FLUIDSYNTH_PATH/VAMP_SOUNDFONT_PATH, or render with backend "builtin", which needs no native dependency. Run health_check for the current availability. Vamp never downloads a dependency at render time.',
          missingDependencies: missing,
          configuredExecutable: config.fluidSynth.binaryPath,
          configuredSoundFont,
        },
        `${message}\nCode: audio.backend.missing_dependency. Hint: Provision the dependency and restart the server, or render with backend "builtin".`,
      ),
    };
  }

  return {
    ok: true,
    value: {
      requested,
      id: 'fluidsynth',
      backend: createFluidSynthBackend({
        binaryPath: config.fluidSynth.binaryPath,
        ...(configuredSoundFont === null ? {} : { gmSoundFont: configuredSoundFont }),
        projectRoot: projectDirectory,
      }),
      note: `FluidSynth selected explicitly with the server-configured executable and SoundFont; project assets resolve inside ${projectDirectory}.`,
      missingDependencies: [],
    },
  };
}

function describeRender(output: {
  projectId: string;
  revision: number;
  renderPath: string;
  outputDirectory: string;
  backend: string;
  sampleRate: number;
  summary: Record<string, unknown>;
  artifacts: readonly { absolutePath: string }[];
  warnings: { validation: unknown[]; audio: unknown[] };
}): string {
  const summary = output.summary as {
    title: string;
    durationSeconds: number;
    peakDbfs: number | null;
    integratedLufs: number | null;
    clipped: boolean;
    stemCount: number;
  };
  const lines = [
    `Rendered project "${output.projectId}" at revision ${String(output.revision)} into ${
      output.renderPath
    }.`,
    `Backend: ${output.backend}, sample rate: ${String(output.sampleRate)} Hz. ${
      (output as { backendSelection?: { note?: string } }).backendSelection?.note ?? ''
    }`,
    `Title: ${summary.title}, duration: ${summary.durationSeconds.toFixed(3)} s, stems: ${String(
      summary.stemCount,
    )}.`,
    `Peak: ${summary.peakDbfs === null ? 'silence' : `${summary.peakDbfs.toFixed(2)} dBFS`}, integrated loudness: ${
      summary.integratedLufs === null ? 'below gate' : `${summary.integratedLufs.toFixed(2)} LUFS`
    }, clipped: ${String(summary.clipped)}.`,
    'Artifacts:',
    ...output.artifacts.map((artifact) => `- ${artifact.absolutePath}`),
  ];
  const warningCount = output.warnings.validation.length + output.warnings.audio.length;
  lines.push(
    warningCount === 0
      ? 'No warnings.'
      : `${String(warningCount)} warning(s): see structuredContent.warnings for codes and paths.`,
  );
  return lines.join('\n');
}

/**
 * Register the Task 15 render tool on a high-level McpServer.
 *
 * The queue instance is created by the caller so the executable can abort active
 * renders through the single guarded shutdown path.
 */
export function registerRenderTools(
  server: McpServer,
  config: McpServerConfig,
  options: RegisterRenderToolOptions,
): void {
  const logger: DiagnosticLogger =
    options.logger ?? ((message: string) => process.stderr.write(`${message}\n`));
  const renderer: ArtifactRenderer = options.renderer ?? renderSongArtifacts;
  const jobs = options.jobs;

  server.registerTool(
    RENDER_SONG_TOOL,
    {
      title: 'Render a project',
      description:
        'Render one saved project revision inside the configured project root and wait until every file is on disk before returning. It reads the stored song, takes a validated in-memory snapshot so a concurrent edit cannot change the render mid-flight, resolves a confined output directory under that project renders/ tree through @gxaditya/vamp-project, and runs the shared engine operation renderSongArtifacts to publish master WAV, per-track stems, Standard MIDI, and report.json atomically. Returns absolute artifact paths, the exact revision rendered, the full render report (duration, peak and loudness, clipping, backend, asset checksums, stem metadata, artifact hashes), and warnings. Pass expectedRevision from get_song to refuse a song that changed under you, and renderName to keep several renders; the default name is render-<revision>, so a re-render after an edit never overwrites the previous render. Backend defaults to "auto", which uses FluidSynth plus a locally discovered GM SoundFont when both exist and otherwise the dependency-free built-in synth; "builtin" forces the oscillator fallback and "fluidsynth" requires the server-configured executable and SoundFont. A tool argument never points at a path. Normalization is on by default: the same deterministic gain is applied to the master and every stem to reach a -1 dBFS peak target with at most +9 dB of boost; pass normalize:false for raw levels. Renders obey the bounded job settings: extra calls return render.busy, slow renders return render.timeout, and cancellation or shutdown returns render.cancelled. Invalid data, unavailable assets, and root escapes are actionable structured errors that never publish partial output.',
      inputSchema: renderSongInputSchema,
      outputSchema: renderSongOutputSchema,
      annotations: { ...WRITE_ANNOTATIONS, title: 'Render a project' },
    },
    async (args: RenderSongInput, extra) =>
      guardTool(RENDER_SONG_TOOL, logger, async () => {
        const store = configuredStore(config);
        if (!store.ok) {
          return store.result;
        }

        const read = await store.store.get(args.projectId);
        if (!read.ok) {
          return projectToolError(read);
        }
        const snapshot = read.value;

        if (args.expectedRevision !== undefined && args.expectedRevision !== snapshot.revision) {
          return projectToolError(conflictError(args.expectedRevision, snapshot));
        }

        const renderName = args.renderName ?? `render-${String(snapshot.revision)}`;
        const renderPath = `renders/${renderName}`;
        const located = await store.store.getLocation(args.projectId);
        if (!located.ok) {
          return projectToolError(located);
        }
        const destination = await store.store.resolveRenderDirectory(args.projectId, renderPath);
        if (!destination.ok) {
          return projectToolError(destination);
        }

        const backend = await selectBackend(
          config,
          args.backend ?? 'auto',
          located.value.directory,
        );
        if (!backend.ok) {
          return backend.result;
        }

        if (
          backend.value.requested === 'auto' &&
          backend.value.id === 'builtin' &&
          usesSampleInstruments(snapshot.song)
        ) {
          const missing =
            backend.value.missingDependencies.length === 0
              ? 'FluidSynth and a GM SoundFont'
              : backend.value.missingDependencies
                  .map((dependency) =>
                    dependency === 'executable' ? 'the FluidSynth executable' : 'a GM SoundFont',
                  )
                  .join(' and ');
          return renderError(
            {
              code: 'audio.backend.missing_dependency',
              message: `The song uses gm, soundfont, or sfz instruments, but auto selection could only use the builtin synth because ${missing} was not found.`,
              hint: 'Run health_check for the exact dependency state. Install FluidSynth 2.x and a GM SoundFont, set VAMP_SOUNDFONT_PATH or place a font in ~/.local/share/vamp/soundfonts, or replace GM instruments with the six curated builtin IDs. The builtin synth cannot play GM instruments.',
              missingDependencies: backend.value.missingDependencies,
              selectionNote: backend.value.note,
            },
            `Sample backend unavailable for this song.\nCode: audio.backend.missing_dependency. Hint: Provision FluidSynth and a GM SoundFont, or use curated builtin IDs.`,
          );
        }

        const sampleRate = args.sampleRate ?? DEFAULT_SAMPLE_RATE;
        const outputDir = destination.value.absolutePath;

        const submitted = await jobs.submit(
          async (signal) =>
            renderer(snapshot.song, {
              outputDir,
              sampleRate,
              ...(backend.value.backend === undefined ? {} : { backend: backend.value.backend }),
              ...(args.stems === undefined ? {} : { stems: args.stems }),
              ...(args.midi === undefined ? {} : { midi: args.midi }),
              ...(args.report === undefined ? {} : { report: args.report }),
              overwrite: args.overwrite === true,
              mastering: { normalize: args.normalize ?? true },
              validation: INSTRUMENT_REGISTRY_VALIDATION,
              signal,
            }),
          extra.signal,
        );

        if (!submitted.ok) {
          return lifecycleFailure(submitted.rejection);
        }
        const result = submitted.value;
        if (!result.ok) {
          return engineFailure(result, {
            projectId: snapshot.projectId,
            revision: snapshot.revision,
            renderPath,
          });
        }

        const trackIdByPath = new Map<string, string>();
        for (const stem of result.report.stems) {
          trackIdByPath.set(stem.audio.path, stem.trackId);
        }
        const artifacts = result.artifacts.map((artifact) => ({
          role: artifact.role,
          path: artifact.path,
          absolutePath: `${outputDir}/${artifact.path}`,
          format: artifact.format,
          bytes: artifact.bytes,
          sha256: artifact.sha256,
          trackId: trackIdByPath.get(artifact.path) ?? null,
        }));
        const reportName = result.report.outputs.report;
        const reportFile =
          reportName === null
            ? null
            : { path: reportName, absolutePath: `${outputDir}/${reportName}` };

        const output = renderSongOutputSchema.parse({
          schemaVersion: SONG_SCHEMA_VERSION,
          projectId: snapshot.projectId,
          revision: snapshot.revision,
          renderName,
          renderPath,
          outputDirectory: outputDir,
          backend: backend.value.id,
          backendSelection: {
            requested: backend.value.requested,
            selected: backend.value.id,
            note: backend.value.note,
          },
          sampleRate,
          artifacts,
          reportFile,
          outputs: result.report.outputs,
          summary: {
            title: result.report.title,
            durationSeconds: result.report.duration.actualSeconds,
            artifactCount: artifacts.length + (reportFile === null ? 0 : 1),
            stemCount: result.report.stems.length,
            midi: result.report.outputs.midi !== null,
            report: reportFile !== null,
            peakDbfs: result.report.audio.peakDbfs,
            integratedLufs: result.report.audio.loudness.integratedLufs,
            clipped: result.report.audio.clipping.clipped,
          },
          report: result.report,
          warnings: {
            validation: result.validationWarnings.map(serializeValidationIssue),
            audio: result.warnings.map(serializeValidationIssue),
          },
          message: `Rendered revision ${String(snapshot.revision)} of "${
            snapshot.projectId
          }" into ${renderPath} with the ${backend.value.id} backend at ${String(
            sampleRate,
          )} Hz. ${String(artifacts.length)} artifact(s) plus the report file are on disk.`,
        });

        logger(
          `vamp-mcp: rendered ${snapshot.projectId} revision ${String(snapshot.revision)} into ${renderPath} in ${String(
            submitted.elapsedMs,
          )} ms (${backend.value.id})`,
        );
        return toolSuccess(
          describeRender({
            projectId: snapshot.projectId,
            revision: snapshot.revision,
            renderPath,
            outputDirectory: outputDir,
            backend: backend.value.id,
            sampleRate,
            summary: output.summary as unknown as Record<string, unknown>,
            artifacts,
            warnings: {
              validation: output.warnings.validation,
              audio: output.warnings.audio,
            },
          }),
          output,
        );
      }),
  );
}

/** Build a revision conflict that matches the shared project error contract. */
function conflictError(expectedRevision: number, snapshot: ProjectSnapshot): ProjectError {
  return {
    ok: false,
    code: 'project.revision.conflict',
    message: `Project "${snapshot.projectId}" is at revision ${String(
      snapshot.revision,
    )}, not the revision ${String(expectedRevision)} you asked to render.`,
    hint: 'Rendering is exact-revision work: call get_song, decide whether the new revision is what you want, and render it with its own expectedRevision or without one.',
    projectId: snapshot.projectId,
    expectedRevision,
    actualRevision: snapshot.revision,
  };
}

/**
 * Same root handling as the authoring tools: an unconfigured root is an
 * actionable error, while a configured but invalid root still produces a store
 * whose operations return the shared `project.root.*` codes.
 */
function configuredStore(
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
        'No project root is configured, so render_song cannot read a saved project or write render output.',
        'Start the server with --project-root <absolute existing directory> or set VAMP_PROJECT_ROOT, then call health_check to confirm the root status.',
      ),
    };
  }
  return { ok: true, store };
}
