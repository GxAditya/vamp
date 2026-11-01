import {
  MAX_RENDER_SECONDS,
  estimateRenderedDuration,
  validateSong,
  type NormalizedAutomation,
  type NormalizedEffect,
  type NormalizedInstrument,
  type NormalizedPattern,
  type NormalizedSongV1,
  type ValidationIssue,
  type ValidationSuccess,
  type ValidateSongOptions,
} from '@gxaditya/vamp-schema';

import { createCompileIssue, normalizeCompileIssues, type CompileIssue } from './errors.js';
import {
  TIMELINE_FORMAT,
  TIMELINE_FORMAT_VERSION,
  compareTimelineEvents,
  type SongTimeline,
  type TimelineAutomation,
  type TimelineAutomationPoint,
  type TimelineEventSource,
  type TimelineMeta,
  type TimelineNoteEvent,
  type TimelineTrack,
} from './timeline.js';
import {
  SUPPORTED_SAMPLE_RATES,
  beatsToSeconds,
  beatsToSamples,
  getBeatsPerBar,
  isSampleRate,
  secondsToFrames,
  type SampleRate,
} from './time.js';

/** Compile-time resource guards. Validation remains the authoritative check. */
export interface CompileLimits {
  readonly maxAuthoredNotes: number;
  readonly maxExpandedNotes: number;
  readonly maxRenderedSeconds: number;
}

/**
 * Hard compile-time limits. They mirror the SongSchemaV1 semantic bounds and
 * exist as defense in depth for callers that already hold a validation
 * success. Options may tighten these limits but never raise them.
 */
export const COMPILE_LIMITS: CompileLimits = Object.freeze({
  maxAuthoredNotes: 10_000,
  maxExpandedNotes: 20_000,
  maxRenderedSeconds: MAX_RENDER_SECONDS,
});

export interface CompileSongOptions {
  /**
   * Required so event sample positions are always an explicit choice. The v1
   * supported rates are 44100 and 48000.
   */
  readonly sampleRate: SampleRate;
  /**
   * Optional tighter resource guards. Values above the hard limits are clamped
   * down to the hard limit. Values must be positive; note counts must be
   * integers.
   */
  readonly limits?: Partial<CompileLimits>;
  /**
   * Options forwarded to `validateSong` by `compileSong`. They are unused by
   * `compileValidatedSong`, which trusts an existing successful validation.
   */
  readonly validation?: ValidateSongOptions;
}

export interface CompileSongSuccess {
  readonly ok: true;
  readonly timeline: SongTimeline;
  /** Validation warnings from the schema library, passed through unchanged. */
  readonly warnings: readonly ValidationIssue[];
}

export interface CompileSongValidationFailure {
  readonly ok: false;
  readonly stage: 'validation';
  /** The original schema validation issues, in validator order. */
  readonly errors: readonly ValidationIssue[];
  readonly warnings: readonly ValidationIssue[];
}

export interface CompileSongCompileFailure {
  readonly ok: false;
  readonly stage: 'compile';
  /** Compile issues, sorted by path, code, and message. */
  readonly errors: readonly CompileIssue[];
  readonly warnings: readonly ValidationIssue[];
}

export type CompileSongFailure = CompileSongValidationFailure | CompileSongCompileFailure;

export type CompileSongResult = CompileSongSuccess | CompileSongFailure;

interface ResolvedCompileOptions {
  readonly sampleRate: SampleRate;
  readonly limits: CompileLimits;
}

const DURATION_EPSILON_SECONDS = 1e-9;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeValue(value: unknown): string {
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' && Number.isNaN(value)) {
    return 'NaN';
  }
  return String(value);
}

function readLimit(
  name: keyof CompileLimits,
  hardLimit: number,
  requireInteger: boolean,
  values: Readonly<Record<string, unknown>>,
  errors: CompileIssue[],
): number | undefined {
  const raw = values[name];
  if (raw === undefined) {
    return hardLimit;
  }

  const valid =
    typeof raw === 'number' &&
    Number.isFinite(raw) &&
    raw > 0 &&
    (!requireInteger || Number.isInteger(raw));
  if (!valid) {
    errors.push(
      createCompileIssue(
        'compile.options.invalid',
        `/limits/${name}`,
        `Compile limit ${name} must be a ${requireInteger ? 'positive integer' : 'positive finite number'}, received ${describeValue(raw)}.`,
        `Use a positive value at or below the documented hard limit (${hardLimit}), or omit this limit.`,
        { limit: name, hardLimit },
      ),
    );
    return undefined;
  }

  return Math.min(raw, hardLimit);
}

function resolveCompileOptions(
  options: CompileSongOptions | undefined,
):
  | { readonly ok: true; readonly value: ResolvedCompileOptions }
  | { readonly ok: false; readonly errors: readonly CompileIssue[] } {
  if (!isRecord(options)) {
    return {
      ok: false,
      errors: [
        createCompileIssue(
          'compile.options.invalid',
          '',
          'Compile options must be an object with a sampleRate.',
          'Pass { sampleRate: 44100 | 48000 } and optionally { limits, validation }.',
        ),
      ],
    };
  }

  const errors: CompileIssue[] = [];
  const values = options as unknown as Record<string, unknown>;

  const sampleRate = values.sampleRate;
  let resolvedSampleRate: SampleRate | undefined;
  if (isSampleRate(sampleRate)) {
    resolvedSampleRate = sampleRate;
  } else {
    errors.push(
      createCompileIssue(
        'compile.options.invalid',
        '/sampleRate',
        `Unsupported sampleRate ${describeValue(sampleRate)}. Supported rates: ${SUPPORTED_SAMPLE_RATES.join(', ')}.`,
        'Pass sampleRate 44100 or 48000 so beat-to-sample positions are explicit.',
        { supported: SUPPORTED_SAMPLE_RATES.map(String) },
      ),
    );
  }

  const limitsValue = values.limits;
  let limitValues: Readonly<Record<string, unknown>> = {};
  if (limitsValue !== undefined) {
    if (isRecord(limitsValue)) {
      limitValues = limitsValue;
    } else {
      errors.push(
        createCompileIssue(
          'compile.options.invalid',
          '/limits',
          'Compile limits must be an object.',
          'Omit limits or pass positive numeric overrides for maxAuthoredNotes, maxExpandedNotes, or maxRenderedSeconds.',
        ),
      );
    }
  }

  const maxAuthoredNotes = readLimit(
    'maxAuthoredNotes',
    COMPILE_LIMITS.maxAuthoredNotes,
    true,
    limitValues,
    errors,
  );
  const maxExpandedNotes = readLimit(
    'maxExpandedNotes',
    COMPILE_LIMITS.maxExpandedNotes,
    true,
    limitValues,
    errors,
  );
  const maxRenderedSeconds = readLimit(
    'maxRenderedSeconds',
    COMPILE_LIMITS.maxRenderedSeconds,
    false,
    limitValues,
    errors,
  );

  if (
    errors.length > 0 ||
    resolvedSampleRate === undefined ||
    maxAuthoredNotes === undefined ||
    maxExpandedNotes === undefined ||
    maxRenderedSeconds === undefined
  ) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      sampleRate: resolvedSampleRate,
      limits: { maxAuthoredNotes, maxExpandedNotes, maxRenderedSeconds },
    },
  };
}

function isValidationSuccess(value: unknown): value is ValidationSuccess {
  if (!isRecord(value) || value.ok !== true || !Array.isArray(value.warnings)) {
    return false;
  }

  const normalized = value.normalized;
  if (
    !isRecord(normalized) ||
    !Array.isArray(normalized.tracks) ||
    !Array.isArray(normalized.patterns) ||
    !isRecord(normalized.meta) ||
    !isRecord(normalized.meta.timeSignature) ||
    !isRecord(normalized.meta.key)
  ) {
    return false;
  }

  for (const track of normalized.tracks) {
    if (
      !isRecord(track) ||
      !Array.isArray(track.notes) ||
      !track.notes.every(isRecord) ||
      !Array.isArray(track.placements) ||
      !track.placements.every(isRecord) ||
      !Array.isArray(track.effects) ||
      !track.effects.every(isRecord) ||
      !isRecord(track.instrument)
    ) {
      return false;
    }
  }

  for (const pattern of normalized.patterns) {
    if (!isRecord(pattern) || !Array.isArray(pattern.notes) || !pattern.notes.every(isRecord)) {
      return false;
    }
  }

  return true;
}

function validationFailure(
  errors: readonly ValidationIssue[],
  warnings: readonly ValidationIssue[],
): CompileSongValidationFailure {
  return {
    ok: false,
    stage: 'validation',
    errors,
    warnings: [...warnings],
  };
}

function compileFailure(
  errors: readonly CompileIssue[],
  warnings: readonly ValidationIssue[],
): CompileSongCompileFailure {
  return {
    ok: false,
    stage: 'compile',
    errors: normalizeCompileIssues(errors),
    warnings: [...warnings],
  };
}

function cloneInstrument(instrument: NormalizedInstrument): NormalizedInstrument {
  switch (instrument.type) {
    case 'builtin':
      return { type: 'builtin', id: instrument.id };
    case 'gm':
      return { type: 'gm', program: instrument.program, bank: instrument.bank };
    case 'soundfont':
      return {
        type: 'soundfont',
        path: instrument.path,
        program: instrument.program,
        bank: instrument.bank,
      };
    case 'sfz':
      return { type: 'sfz', path: instrument.path };
  }
}

function cloneEffect(effect: NormalizedEffect): NormalizedEffect {
  switch (effect.type) {
    case 'reverb':
      return { type: 'reverb', mix: effect.mix, decaySeconds: effect.decaySeconds };
    case 'delay':
      return {
        type: 'delay',
        timeMs: effect.timeMs,
        feedback: effect.feedback,
        mix: effect.mix,
      };
    case 'eq':
      return {
        type: 'eq',
        lowGainDb: effect.lowGainDb,
        midGainDb: effect.midGainDb,
        highGainDb: effect.highGainDb,
      };
    case 'lowpass':
      return {
        type: 'lowpass',
        ...(effect.cutoffHz === undefined ? {} : { cutoffHz: effect.cutoffHz }),
        q: effect.q,
      };
  }
}

function mapAutomationPoints(
  points: readonly { readonly time: number; readonly value: number }[],
  bpm: number,
): TimelineAutomationPoint[] {
  return points
    .map((point) => ({
      timeBeats: point.time,
      timeSeconds: beatsToSeconds(point.time, bpm),
      value: point.value,
    }))
    .sort((left, right) => left.timeBeats - right.timeBeats || left.value - right.value);
}

function cloneAutomation(
  automation: NormalizedAutomation | undefined,
  bpm: number,
): TimelineAutomation {
  if (automation === undefined) {
    return {};
  }

  const result: {
    volume?: TimelineAutomationPoint[];
    pan?: TimelineAutomationPoint[];
    filterCutoffHz?: TimelineAutomationPoint[];
  } = {};

  if (automation.volume !== undefined) {
    result.volume = mapAutomationPoints(automation.volume.points, bpm);
  }
  if (automation.pan !== undefined) {
    result.pan = mapAutomationPoints(automation.pan.points, bpm);
  }
  if (automation.filterCutoffHz !== undefined) {
    result.filterCutoffHz = mapAutomationPoints(automation.filterCutoffHz.points, bpm);
  }

  return result;
}

function cloneMeta(normalized: NormalizedSongV1): TimelineMeta {
  const meta = normalized.meta;
  return {
    title: meta.title,
    bpm: meta.bpm,
    timeSignature: { ...meta.timeSignature },
    key: { ...meta.key },
    seed: meta.seed,
    durationHintBeats: meta.durationHint,
    ...(meta.mood === undefined ? {} : { mood: meta.mood }),
    ...(meta.tags === undefined ? {} : { tags: [...meta.tags] }),
  };
}

interface CreateEventInput {
  readonly trackIndex: number;
  readonly trackId: string;
  readonly pitch: number;
  readonly velocity: number;
  readonly startBeat: number;
  readonly durationBeats: number;
  readonly audible: boolean;
  readonly id: string;
  readonly source: TimelineEventSource;
  readonly bpm: number;
  readonly sampleRate: SampleRate;
}

function createEvent(input: CreateEventInput): TimelineNoteEvent | null {
  const endBeat = input.startBeat + input.durationBeats;
  const startSeconds = beatsToSeconds(input.startBeat, input.bpm);
  const endSeconds = beatsToSeconds(endBeat, input.bpm);
  const startSample = beatsToSamples(input.startBeat, input.bpm, input.sampleRate);
  const endSample = Math.max(startSample, beatsToSamples(endBeat, input.bpm, input.sampleRate));

  const valid =
    Number.isFinite(input.startBeat) &&
    input.startBeat >= 0 &&
    Number.isFinite(input.durationBeats) &&
    input.durationBeats > 0 &&
    Number.isFinite(endBeat) &&
    Number.isFinite(startSeconds) &&
    Number.isFinite(endSeconds) &&
    endSeconds >= startSeconds &&
    Number.isSafeInteger(startSample) &&
    Number.isSafeInteger(endSample) &&
    startSample >= 0 &&
    endSample >= startSample;

  if (!valid) {
    return null;
  }

  return {
    id: input.id,
    trackIndex: input.trackIndex,
    trackId: input.trackId,
    pitch: input.pitch,
    velocity: input.velocity,
    startBeat: input.startBeat,
    durationBeats: input.durationBeats,
    endBeat,
    startSeconds,
    endSeconds,
    startSample,
    endSample,
    audible: input.audible,
    source: input.source,
  };
}

function buildPatternIndex(patterns: readonly NormalizedPattern[]): Map<string, NormalizedPattern> {
  const index = new Map<string, NormalizedPattern>();
  for (const pattern of patterns) {
    if (!index.has(pattern.id)) {
      index.set(pattern.id, pattern);
    }
  }
  return index;
}

function compileValidatedResult(
  validation: ValidationSuccess,
  options: ResolvedCompileOptions,
): CompileSongResult {
  const normalized = validation.normalized;
  const warnings = [...validation.warnings];
  const issues: CompileIssue[] = [];
  const bpm = normalized.meta.bpm;

  if (!Number.isFinite(bpm) || bpm <= 0) {
    issues.push(
      createCompileIssue(
        'compile.input.invalid',
        '/meta/bpm',
        'The validated song has a non-positive or non-finite bpm.',
        'Validate the song again and correct meta.bpm.',
        { bpm: Number.isFinite(bpm) ? bpm : null },
      ),
    );
  }
  if (!Number.isFinite(normalized.meta.durationHint) || normalized.meta.durationHint <= 0) {
    issues.push(
      createCompileIssue(
        'compile.input.invalid',
        '/meta/durationHint',
        'The validated song has a non-positive or non-finite durationHint.',
        'Validate the song again and correct meta.durationHint.',
        {
          durationHint: Number.isFinite(normalized.meta.durationHint)
            ? normalized.meta.durationHint
            : null,
        },
      ),
    );
  }

  const patternById = buildPatternIndex(normalized.patterns);

  let authoredNoteCount = 0;
  for (const pattern of normalized.patterns) {
    authoredNoteCount += pattern.notes.length;
  }
  for (const track of normalized.tracks) {
    authoredNoteCount += track.notes.length;
  }

  let freeNoteCount = 0;
  let expandedNoteCount = 0;
  for (const [trackIndex, track] of normalized.tracks.entries()) {
    freeNoteCount += track.notes.length;
    for (const [placementIndex, placement] of track.placements.entries()) {
      if (!Number.isSafeInteger(placement.repeat) || placement.repeat < 1) {
        issues.push(
          createCompileIssue(
            'compile.input.invalid',
            `/tracks/${trackIndex}/placements/${placementIndex}/repeat`,
            `Placement repeat must be a positive integer, received ${describeValue(placement.repeat)}.`,
            'Validate the song again. repeat is the total number of pattern plays and must be at least 1.',
          ),
        );
        continue;
      }

      const pattern = patternById.get(placement.pattern);
      if (pattern === undefined) {
        issues.push(
          createCompileIssue(
            'compile.pattern.unresolved',
            `/tracks/${trackIndex}/placements/${placementIndex}/pattern`,
            `Placement references unknown pattern "${placement.pattern}".`,
            'Validate the song again or add the missing pattern to the root patterns array.',
            { patternId: placement.pattern },
          ),
        );
        continue;
      }

      const placementEvents = placement.repeat * pattern.notes.length;
      if (!Number.isSafeInteger(placementEvents) || placementEvents < 0) {
        issues.push(
          createCompileIssue(
            'compile.input.invalid',
            `/tracks/${trackIndex}/placements/${placementIndex}`,
            'Expanded placement note count is not a safe integer.',
            'Reduce the repeat count or pattern size, then validate the song again.',
          ),
        );
        continue;
      }
      expandedNoteCount += placementEvents;
    }
  }
  expandedNoteCount += freeNoteCount;

  if (authoredNoteCount > options.limits.maxAuthoredNotes) {
    issues.push(
      createCompileIssue(
        'compile.limit.authored_notes',
        '',
        `Song defines ${authoredNoteCount} authored notes, above the compile limit of ${options.limits.maxAuthoredNotes}.`,
        'Remove unused patterns or notes, or split the project into smaller songs.',
        { authoredNotes: authoredNoteCount, limit: options.limits.maxAuthoredNotes },
      ),
    );
  }

  if (expandedNoteCount > options.limits.maxExpandedNotes) {
    issues.push(
      createCompileIssue(
        'compile.limit.expanded_notes',
        '',
        `Song expands to ${expandedNoteCount} note events, above the compile limit of ${options.limits.maxExpandedNotes}.`,
        'Reduce repeat counts or pattern density, or split the project into smaller songs.',
        { expandedNotes: expandedNoteCount, limit: options.limits.maxExpandedNotes },
      ),
    );
  }

  const duration = estimateRenderedDuration(normalized);
  let renderedSamples: number | undefined;

  if (
    !Number.isFinite(duration.renderedSeconds) ||
    duration.renderedSeconds < 0 ||
    !Number.isFinite(duration.hintSeconds) ||
    !Number.isFinite(duration.lastSoundSeconds) ||
    !Number.isFinite(duration.secondsPerBeat)
  ) {
    issues.push(
      createCompileIssue(
        'compile.output.non_finite',
        '',
        'The rendered duration estimate contains a non-finite value.',
        'Check tempo, notes, placements, and effect parameters. Derived timing must be finite.',
      ),
    );
  } else {
    if (duration.renderedSeconds > options.limits.maxRenderedSeconds + DURATION_EPSILON_SECONDS) {
      issues.push(
        createCompileIssue(
          'compile.limit.duration',
          '',
          `Rendered duration ${Number(duration.renderedSeconds.toFixed(3))}s exceeds the compile limit of ${options.limits.maxRenderedSeconds}s.`,
          'Shorten durationHint, end content earlier, reduce effect tails, or raise the tempo.',
          {
            renderedSeconds: duration.renderedSeconds,
            hintSeconds: duration.hintSeconds,
            lastSoundSeconds: duration.lastSoundSeconds,
            limitSeconds: options.limits.maxRenderedSeconds,
          },
        ),
      );
    }

    renderedSamples = secondsToFrames(duration.renderedSeconds, options.sampleRate);
    if (!Number.isSafeInteger(renderedSamples) || renderedSamples < 0) {
      issues.push(
        createCompileIssue(
          'compile.output.non_finite',
          '',
          'The rendered sample frame count is not a non-negative safe integer.',
          'Check tempo, durationHint, and sampleRate. Rendered frames must fit in a safe integer.',
        ),
      );
    }
  }

  if (issues.length > 0) {
    return compileFailure(issues, warnings);
  }

  if (renderedSamples === undefined) {
    return compileFailure(
      [
        createCompileIssue(
          'compile.output.non_finite',
          '',
          'The rendered sample frame count could not be derived.',
          'Check tempo, durationHint, and sampleRate, then compile again.',
        ),
      ],
      warnings,
    );
  }
  const renderedFrameCount = renderedSamples;

  const events: TimelineNoteEvent[] = [];
  const timelineTracks: TimelineTrack[] = [];
  const buildIssues: CompileIssue[] = [];

  for (const [trackIndex, track] of normalized.tracks.entries()) {
    const contribution = duration.tracks[trackIndex];
    if (contribution === undefined) {
      buildIssues.push(
        createCompileIssue(
          'compile.input.invalid',
          `/tracks/${trackIndex}`,
          'The duration helper did not return a contribution for this track.',
          'Validate the song again before compiling.',
        ),
      );
      continue;
    }

    if (
      !Number.isFinite(contribution.contentEndBeats) ||
      !Number.isFinite(contribution.contentEndSeconds) ||
      !Number.isFinite(contribution.tailSeconds) ||
      !Number.isFinite(contribution.endSeconds)
    ) {
      buildIssues.push(
        createCompileIssue(
          'compile.output.non_finite',
          `/tracks/${trackIndex}`,
          'The duration helper returned non-finite timing for this track.',
          'Check the track notes, placements, effect parameters, and tempo.',
          { trackId: track.id },
        ),
      );
      continue;
    }

    let eventCount = 0;

    for (const [noteIndex, note] of track.notes.entries()) {
      const event = createEvent({
        trackIndex,
        trackId: track.id,
        pitch: note.pitch,
        velocity: note.velocity,
        startBeat: note.start,
        durationBeats: note.duration,
        audible: contribution.audible,
        id: `${track.id}:free:${noteIndex}`,
        source: { type: 'note', noteIndex },
        bpm,
        sampleRate: options.sampleRate,
      });

      if (event === null) {
        buildIssues.push(
          createCompileIssue(
            'compile.output.non_finite',
            `/tracks/${trackIndex}/notes/${noteIndex}`,
            'Derived timing for this free note is not finite or not representable in samples.',
            'Check the note start, duration, tempo, and sampleRate.',
            { trackId: track.id, noteIndex },
          ),
        );
        continue;
      }

      events.push(event);
      eventCount += 1;
    }

    for (const [placementIndex, placement] of track.placements.entries()) {
      const pattern = patternById.get(placement.pattern);
      if (pattern === undefined) {
        // Unreachable for a validated success: the count pass reports unresolved patterns before allocation.
        continue;
      }

      for (let playIndex = 0; playIndex < placement.repeat; playIndex += 1) {
        for (const [noteIndex, note] of pattern.notes.entries()) {
          const startBeat = placement.start + playIndex * pattern.effectiveLengthBeats + note.start;
          const event = createEvent({
            trackIndex,
            trackId: track.id,
            pitch: note.pitch,
            velocity: note.velocity,
            startBeat,
            durationBeats: note.duration,
            audible: contribution.audible,
            id: `${track.id}:placement:${placementIndex}:${playIndex}:${noteIndex}`,
            source: {
              type: 'pattern',
              patternId: pattern.id,
              placementIndex,
              playIndex,
              noteIndex,
            },
            bpm,
            sampleRate: options.sampleRate,
          });

          if (event === null) {
            buildIssues.push(
              createCompileIssue(
                'compile.output.non_finite',
                `/tracks/${trackIndex}/placements/${placementIndex}`,
                'Derived timing for an expanded pattern note is not finite or not representable in samples.',
                'Check the placement start, repeat, pattern notes, tempo, and sampleRate.',
                { trackId: track.id, patternId: pattern.id, placementIndex, playIndex, noteIndex },
              ),
            );
            continue;
          }

          events.push(event);
          eventCount += 1;
        }
      }
    }

    timelineTracks.push({
      index: trackIndex,
      id: track.id,
      name: track.name,
      kind: track.kind,
      channel: track.channel,
      instrument: cloneInstrument(track.instrument),
      audible: contribution.audible,
      mute: track.mute,
      solo: track.solo,
      volume: track.volume,
      pan: track.pan,
      automation: cloneAutomation(track.automation, bpm),
      effects: track.effects.map(cloneEffect),
      contentEndBeats: contribution.contentEndBeats,
      contentEndSeconds: contribution.contentEndSeconds,
      tailSeconds: contribution.tailSeconds,
      endSeconds: contribution.endSeconds,
      eventCount,
    });
  }

  if (buildIssues.length > 0) {
    return compileFailure(buildIssues, warnings);
  }

  events.sort(compareTimelineEvents);

  let audibleEventCount = 0;
  for (const event of events) {
    if (event.audible) {
      audibleEventCount += 1;
    }
  }

  const timeline: SongTimeline = {
    format: TIMELINE_FORMAT,
    formatVersion: TIMELINE_FORMAT_VERSION,
    schemaVersion: '1.0.0',
    sampleRate: options.sampleRate,
    beatsPerBar: getBeatsPerBar(normalized.meta.timeSignature),
    secondsPerBeat: duration.secondsPerBeat,
    hintSeconds: duration.hintSeconds,
    lastSoundSeconds: duration.lastSoundSeconds,
    renderedSeconds: duration.renderedSeconds,
    renderedSamples: renderedFrameCount,
    meta: cloneMeta(normalized),
    tracks: timelineTracks,
    events,
    stats: {
      trackCount: normalized.tracks.length,
      authoredNoteCount,
      expandedNoteCount: events.length,
      audibleEventCount,
    },
  };

  return { ok: true, timeline, warnings };
}

/**
 * Validate and compile an unknown song value.
 *
 * The input is validated with `@gxaditya/vamp-schema` before anything is expanded. A
 * validation failure returns the original schema issues with `stage:
 * "validation"`. Compile options are checked first, so an unsupported sample
 * rate never starts validation.
 */
export function compileSong(input: unknown, options: CompileSongOptions): CompileSongResult {
  const resolved = resolveCompileOptions(options);
  if (!resolved.ok) {
    return compileFailure(resolved.errors, []);
  }

  const validation = validateSong(input, options.validation ?? {});
  if (!validation.ok) {
    return validationFailure(validation.errors, validation.warnings);
  }

  return compileValidatedResult(validation, resolved.value);
}

/**
 * Compile a song that already passed `validateSong` without validating again.
 *
 * The validation success is trusted. A malformed token is still rejected with a
 * structured `compile.input.invalid` error instead of throwing, and unresolved
 * pattern references are re-checked as defense in depth. The normalized copy in
 * the success value is read, never mutated.
 */
export function compileValidatedSong(
  validation: ValidationSuccess,
  options: CompileSongOptions,
): CompileSongResult {
  const valid = isValidationSuccess(validation);
  const resolved = resolveCompileOptions(options);
  if (!resolved.ok) {
    return compileFailure(resolved.errors, valid ? validation.warnings : []);
  }

  if (!valid) {
    return compileFailure(
      [
        createCompileIssue(
          'compile.input.invalid',
          '',
          'compileValidatedSong requires a successful validateSong result.',
          'Call validateSong first and handle validation failures before compiling.',
        ),
      ],
      [],
    );
  }

  return compileValidatedResult(validation, resolved.value);
}
