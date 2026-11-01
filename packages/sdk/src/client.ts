/**
 * `VampClient`: the thin typed local client of `@gxaditya/vamp-sdk`.
 *
 * Design choice (Task 16): the SDK is a typed facade over the shared
 * libraries, not a service client. There is no HTTP transport, no local
 * daemon, and no second implementation of validation, storage, rendering, or
 * the instrument registry. Project operations delegate directly to
 * `ProjectStore` from `@gxaditya/vamp-project` (seeded with the same registry-aligned
 * validation options the CLI and MCP server use), discovery reads the
 * `@gxaditya/vamp-schema` exports and the `@gxaditya/vamp-engine` instrument registry, and
 * rendering delegates to `renderSongArtifacts` in `@gxaditya/vamp-engine`. Because the
 * SDK returns the same `ProjectResult`, `ValidationResult`, and
 * `RenderSongArtifactsResult` contracts the CLI and MCP server use, one
 * result, error, and revision model serves every consumer. A library call
 * needs no process to start and works fully offline.
 */

import {
  INSTRUMENT_REGISTRY_VALIDATION,
  describeInstrumentRegistry,
  renderSongArtifacts,
  selectAutomaticBackend,
  type AudioBackend,
  type InstrumentRegistryDescription,
  type RenderSongArtifactsFailure,
  type RenderSongArtifactsSuccess,
  type SampleRate,
} from '@gxaditya/vamp-engine';
import {
  ProjectStore,
  PROJECT_LAYOUT,
  type CreateProjectOptions,
  type AddNotesOptions,
  type AddTrackOptions,
  type ProjectLocation,
  type ProjectLimitsInput,
  type ProjectResult,
  type ProjectSnapshot,
  type ProjectSummary,
  type ProjectError,
  type RemoveNoteOptions,
  type RemovePatternOptions,
  type RemoveTrackOptions,
  type ResolvedRenderDirectory,
  type SetInstrumentOptions,
  type SetPatternOptions,
  type UpdateNoteOptions,
  type UpdateSongOptions,
  type UpdateTrackOptions,
} from '@gxaditya/vamp-project';
import {
  getSongSchemaV1,
  validateSong,
  SONG_SCHEMA_VERSION,
  type ValidateSongOptions,
  type ValidationResult,
} from '@gxaditya/vamp-schema';

/** Default render sample rate. Matches `vamp render` and `render_song`. */
const DEFAULT_SAMPLE_RATE: SampleRate = 48_000;

export interface VampClientOptions {
  /** Absolute existing projects root. Shared with the CLI and MCP server. */
  readonly root: string;
  /**
   * Schema validation options for every project operation and render.
   * Defaults to `INSTRUMENT_REGISTRY_VALIDATION` so the curated builtin
   * allowlist matches the engine registry, exactly like the CLI and MCP.
   */
  readonly validation?: ValidateSongOptions;
  /** Optional storage and lock bound overrides. */
  readonly limits?: ProjectLimitsInput;
}

export interface ProjectRenderOptions {
  /**
   * When set, the render refuses with `project.revision.conflict` unless the
   * stored project is at exactly this revision. Renders are point-in-time:
   * the SDK renders the snapshot it read, never a file being edited.
   */
  readonly expectedRevision?: number;
  /**
   * Project-relative destination below `renders/`, for example
   * `renders/master-v2`. Defaults to the project's `renders/` directory.
   * Resolved through `ProjectStore` confinement, so it cannot escape root.
   */
  readonly renderPath?: string;
  /** 44100 or 48000. Defaults to 48000. */
  readonly sampleRate?: SampleRate;
  /**
   * Audio backend. Defaults to `"auto"`: FluidSynth plus a locally discovered
   * GM SoundFont when both are available, otherwise the deterministic built-in
   * synthesizer. Pass `"builtin"` to force the oscillator fallback, or an
   * AudioBackend from `createFluidSynthBackend` for explicit configuration.
   */
  readonly backend?: AudioBackend | 'auto' | 'builtin';
  /** Write one post-effect WAV per audible track. Defaults to true. */
  readonly stems?: boolean;
  /** Write a Type 1 Standard MIDI file. Defaults to true. */
  readonly midi?: boolean;
  /** Write `report.json`. Defaults to true. The result always has report data. */
  readonly report?: boolean;
  /** Permit replacing existing artifact files. Defaults to false. */
  readonly overwrite?: boolean;
  /**
   * Normalize the master and every stem to -1 dBFS with at most +9 dB of boost.
   * Defaults to true. Pass false for raw authored mix levels.
   */
  readonly normalize?: boolean;
  /** Optional cancellation signal, forwarded to the engine. */
  readonly signal?: AbortSignal;
}

/** A successful confined render plus the identity of what was rendered. */
export interface ProjectRenderSuccess extends RenderSongArtifactsSuccess {
  readonly projectId: string;
  /** The stored revision that was rendered. */
  readonly revision: number;
  /** The confined project-relative destination actually written. */
  readonly renderPath: string;
}

/**
 * Render outcome. The `ok: true` branch uses the same `ProjectResult` shape
 * as storage operations. Failures are either shared `ProjectError` values
 * (read, revision, or confinement failures) or the shared engine
 * `RenderSongArtifactsFailure` union (validation, compile, audio, artifact,
 * and cancellation failures). Nothing partial is published on failure.
 */
export type ProjectRenderResult = ProjectResult<ProjectRenderSuccess> | RenderSongArtifactsFailure;

function revisionConflict(
  projectId: string,
  expectedRevision: number,
  actualRevision: number,
): ProjectError {
  return {
    ok: false,
    code: 'project.revision.conflict',
    message: `Project "${projectId}" is at revision ${String(actualRevision)}, not the expected revision ${String(expectedRevision)}.`,
    hint: 'Read the current revision with getProject(), reapply the edit or render against it, and retry.',
    projectId,
    expectedRevision,
    actualRevision,
  };
}

/**
 * Typed entry point for one projects root. All methods return shared
 * result values instead of throwing for expected failures, matching the
 * `@gxaditya/vamp-project` and `@gxaditya/vamp-engine` contracts exactly.
 */
export class VampClient {
  /** The underlying shared store, for advanced operations (assets, locks). */
  readonly store: ProjectStore;
  readonly validation: ValidateSongOptions;

  constructor(options: VampClientOptions) {
    this.validation = options.validation ?? INSTRUMENT_REGISTRY_VALIDATION;
    this.store = new ProjectStore({
      root: options.root,
      ...(options.limits === undefined ? {} : { limits: options.limits }),
      validation: this.validation,
    });
  }

  /** The configured absolute projects root. */
  get root(): string {
    return this.store.root;
  }

  /** The canonical `SongSchemaV1` JSON Schema document for discovery. */
  describeSchema() {
    return { schemaVersion: SONG_SCHEMA_VERSION, jsonSchema: getSongSchemaV1() };
  }

  /** The authoritative curated instrument registry. */
  listInstruments(): InstrumentRegistryDescription {
    return describeInstrumentRegistry();
  }

  /** Validate and normalize a draft song before saving it. Never mutates the input. */
  validate(song: unknown): ValidationResult {
    return validateSong(song, this.validation);
  }

  /** Create a project directory with an initial validated song. */
  createProject(options: CreateProjectOptions): Promise<ProjectResult<ProjectSnapshot>> {
    return this.store.create(options);
  }

  /** Read one project's validated song, revision, and schema warnings. */
  getProject(projectId: string): Promise<ProjectResult<ProjectSnapshot>> {
    return this.store.get(projectId);
  }

  /** List complete projects, sorted by project id. */
  listProjects(): Promise<ProjectResult<readonly ProjectSummary[]>> {
    return this.store.list();
  }

  /** Resolve the confined absolute locations for one project. */
  getLocation(projectId: string): Promise<ProjectResult<ProjectLocation>> {
    return this.store.getLocation(projectId);
  }

  /** Resolve a confined destination below the project's `renders/` tree. */
  resolveRenderDirectory(
    projectId: string,
    renderPath?: string,
  ): Promise<ProjectResult<ResolvedRenderDirectory>> {
    return this.store.resolveRenderDirectory(
      projectId,
      renderPath ?? PROJECT_LAYOUT.rendersDirectory,
    );
  }

  /** Replace the complete song. Validated before any write. */
  updateSong(
    projectId: string,
    options: UpdateSongOptions,
  ): Promise<ProjectResult<ProjectSnapshot>> {
    return this.store.updateSong(projectId, options);
  }

  /** Append or insert a complete track with a unique id. */
  addTrack(projectId: string, options: AddTrackOptions): Promise<ProjectResult<ProjectSnapshot>> {
    return this.store.addTrack(projectId, options);
  }

  /** Patch the scalar mix and naming fields of one track. */
  updateTrack(
    projectId: string,
    options: UpdateTrackOptions,
  ): Promise<ProjectResult<ProjectSnapshot>> {
    return this.store.updateTrack(projectId, options);
  }

  /** Remove one track. Placements referencing it are validated afterwards. */
  removeTrack(
    projectId: string,
    options: RemoveTrackOptions,
  ): Promise<ProjectResult<ProjectSnapshot>> {
    return this.store.removeTrack(projectId, options);
  }

  /** Append or insert free-form notes on one track. */
  addNotes(projectId: string, options: AddNotesOptions): Promise<ProjectResult<ProjectSnapshot>> {
    return this.store.addNotes(projectId, options);
  }

  /** Replace one free note by its positional index in the current revision. */
  updateNote(
    projectId: string,
    options: UpdateNoteOptions,
  ): Promise<ProjectResult<ProjectSnapshot>> {
    return this.store.updateNote(projectId, options);
  }

  /** Remove one free note by its positional index in the current revision. */
  removeNote(
    projectId: string,
    options: RemoveNoteOptions,
  ): Promise<ProjectResult<ProjectSnapshot>> {
    return this.store.removeNote(projectId, options);
  }

  /** Replace a pattern by id, or append a new pattern. */
  setPattern(
    projectId: string,
    options: SetPatternOptions,
  ): Promise<ProjectResult<ProjectSnapshot>> {
    return this.store.setPattern(projectId, options);
  }

  /** Remove one pattern. Placements referencing it are validated afterwards. */
  removePattern(
    projectId: string,
    options: RemovePatternOptions,
  ): Promise<ProjectResult<ProjectSnapshot>> {
    return this.store.removePattern(projectId, options);
  }

  /** Replace one track instrument. */
  setInstrument(
    projectId: string,
    options: SetInstrumentOptions,
  ): Promise<ProjectResult<ProjectSnapshot>> {
    return this.store.setInstrument(projectId, options);
  }

  /**
   * Render one stored revision into the confined `renders/` tree through the
   * shared engine artifact operation: master WAV, per-track stems, Type 1
   * MIDI, and the JSON report, atomically published or not at all.
   */
  async renderProject(
    projectId: string,
    options: ProjectRenderOptions = {},
  ): Promise<ProjectRenderResult> {
    const snapshot = await this.store.get(projectId);
    if (!snapshot.ok) {
      return snapshot;
    }
    if (
      options.expectedRevision !== undefined &&
      options.expectedRevision !== snapshot.value.revision
    ) {
      return revisionConflict(projectId, options.expectedRevision, snapshot.value.revision);
    }
    const directory = await this.resolveRenderDirectory(projectId, options.renderPath);
    if (!directory.ok) {
      return directory;
    }
    let backend = options.backend;
    if (backend === undefined || backend === 'auto' || backend === 'builtin') {
      if (backend === 'builtin') {
        backend = undefined;
      } else {
        const location = await this.store.getLocation(projectId);
        if (!location.ok) {
          return location;
        }
        const selection = await selectAutomaticBackend({
          projectRoot: location.value.directory,
        });
        backend = selection.id === 'fluidsynth' ? selection.backend : undefined;
      }
    }
    const rendered = await renderSongArtifacts(snapshot.value.song, {
      outputDir: directory.value.absolutePath,
      sampleRate: options.sampleRate ?? DEFAULT_SAMPLE_RATE,
      ...(backend === undefined ? {} : { backend }),
      ...(options.stems === undefined ? {} : { stems: options.stems }),
      ...(options.midi === undefined ? {} : { midi: options.midi }),
      ...(options.report === undefined ? {} : { report: options.report }),
      overwrite: options.overwrite ?? false,
      mastering: { normalize: options.normalize ?? true },
      validation: this.validation,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!rendered.ok) {
      return rendered;
    }
    return {
      ok: true,
      value: {
        ...rendered,
        projectId,
        revision: snapshot.value.revision,
        renderPath: directory.value.relativePath,
      },
    };
  }
}
