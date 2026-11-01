/**
 * Complete render artifacts: master WAV, optional stems and MIDI, and a JSON
 * report.
 *
 * The operation validates and compiles through the shared schema compiler,
 * renders once through `renderTimelineAudio`, and consumes each post-effect
 * track buffer through the renderer capture hook. Stems are written while the
 * render runs, so at most one stem buffer plus the master exists in memory. The
 * master in this path is accumulated from the captured float stem values, so
 * the float stems are the exact track contributions that formed it.
 *
 * Files are written into a private job directory and published with renames.
 * Existing artifacts are refused unless `overwrite` is true. A failure or abort
 * removes the job directory and any files this job published; unrelated files
 * in the output directory are never removed.
 */

import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import type { ValidationIssue, ValidateSongOptions } from '@gxaditya/vamp-schema';
import { MAX_RENDER_SECONDS } from '@gxaditya/vamp-schema';

import { compileSong, type CompileLimits } from '../compile.js';
import type { CompileIssue } from '../errors.js';
import { getInstrumentRegistryEntry, INSTRUMENT_REGISTRY_VERSION } from '../instruments.js';
import { exportMidi, type MidiExportReport } from '../midi.js';
import type { SongTimeline } from '../timeline.js';
import type { SampleRate } from '../time.js';
import type { AudioBackend } from './backend.js';
import { createAudioIssue, normalizeAudioIssues, type AudioIssue } from './errors.js';
import { measureIntegratedLoudness, type LoudnessMeasurement } from './loudness.js';
import {
  PCM_BUFFER_FORMAT,
  PCM_BUFFER_FORMAT_VERSION,
  renderTimelineAudio,
  type TrackAudioCapture,
} from './render.js';
import { createBuiltinSynthBackend } from './synth.js';
import { WAV_HEADER_BYTES, encodeWav, type WavReport } from './wav.js';

export const MASTER_AUDIO_FILENAME = 'master.wav' as const;
export const MIDI_ARTIFACT_FILENAME = 'song.mid' as const;
export const REPORT_ARTIFACT_FILENAME = 'report.json' as const;
export const STEM_FILENAME_PREFIX = 'stem-' as const;

/** Maximum audible tracks, matching the schema and timeline container limit. */
export const MAX_STEM_COUNT = 16 as const;

/** Master WAV plus at most 16 stems, one MIDI file, and one report. */
export const MAX_ARTIFACT_COUNT = 1 + MAX_STEM_COUNT + 1 + 1;

/** Estimated largest report and MIDI payload used by the total size bound. */
export const MAX_MIDI_ARTIFACT_BYTES = 16 * 1024 * 1024;
export const MAX_REPORT_ARTIFACT_BYTES = 16 * 1024 * 1024;

/** One 600 second, 48 kHz, stereo 16-bit WAV including its canonical header. */
export const MAX_WAV_ARTIFACT_BYTES = WAV_HEADER_BYTES + MAX_RENDER_SECONDS * 48000 * 4;

/** Conservative total output bound for one job, including metadata files. */
export const MAX_TOTAL_ARTIFACT_BYTES = 2_147_483_648;

/** Absolute ceiling implied by the per-file WAV, MIDI, and report limits. */
export const MAX_RENDER_OUTPUT_BYTES =
  (1 + MAX_STEM_COUNT) * MAX_WAV_ARTIFACT_BYTES +
  MAX_MIDI_ARTIFACT_BYTES +
  MAX_REPORT_ARTIFACT_BYTES;

/** Artifact selection used by a bare complete render. */
export const DEFAULT_RENDER_ARTIFACTS = Object.freeze({
  stems: true,
  midi: true,
  report: true,
});

export const RENDER_REPORT_FORMAT = 'vamp.render-report' as const;
export const RENDER_REPORT_FORMAT_VERSION = 1 as const;

const MAX_TRACK_SLUG_LENGTH = 40;
const MAX_ARTIFACT_NAME_LENGTH = 120;
const SAFE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/;
const ARTIFACT_OPTION_KEYS = new Set([
  'outputDir',
  'sampleRate',
  'backend',
  'maxVoicesPerTrack',
  'limits',
  'validation',
  'mastering',
  'stems',
  'midi',
  'report',
  'overwrite',
  'signal',
]);

export interface MasteringOptions {
  /**
   * Normalize the float master and every stem to `targetDbfs` before encoding.
   * Boosts are capped by `maxBoostDb`; attenuation is always allowed. Defaults
   * to true when a mastering object is supplied.
   */
  readonly normalize?: boolean;
  /** Peak target in dBFS. Defaults to -1. Range -6 to 0. */
  readonly targetDbfs?: number;
  /** Maximum upward gain in dB. Defaults to 9. Range 0 to 18. */
  readonly maxBoostDb?: number;
}

export interface RenderSongArtifactsOptions {
  /** Destination directory. Resolved against the process working directory. */
  readonly outputDir: string;
  readonly sampleRate: SampleRate;
  readonly backend?: AudioBackend;
  readonly maxVoicesPerTrack?: number;
  readonly limits?: Partial<CompileLimits>;
  readonly validation?: ValidateSongOptions;
  /** Optional deterministic peak normalization for master and stems. */
  readonly mastering?: MasteringOptions;
  /** Write one post-effect WAV per audible track. Defaults to true. */
  readonly stems?: boolean;
  /** Write a Type 1 Standard MIDI file. Defaults to true. */
  readonly midi?: boolean;
  /** Write the JSON report file. Defaults to true. The result always has report data. */
  readonly report?: boolean;
  /** Permit replacing existing artifact files. Defaults to false. */
  readonly overwrite?: boolean;
  /** Optional cancellation signal checked between tracks, artifacts, and publishes. */
  readonly signal?: AbortSignal;
}

export interface StemArtifactPlan {
  readonly trackIndex: number;
  readonly trackId: string;
  readonly trackName: string;
  readonly fileName: string;
}

interface ResolvedMasteringOptions {
  readonly normalize: boolean;
  readonly targetDbfs: number;
  readonly maxBoostDb: number;
}

interface ResolvedArtifactOptions {
  readonly outputDir: string;
  readonly sampleRate: SampleRate;
  readonly backend?: AudioBackend;
  readonly maxVoicesPerTrack?: number;
  readonly limits?: Partial<CompileLimits>;
  readonly validation?: ValidateSongOptions;
  readonly mastering: ResolvedMasteringOptions;
  readonly stems: boolean;
  readonly midi: boolean;
  readonly report: boolean;
  readonly overwrite: boolean;
  readonly signal?: AbortSignal;
}

export interface RenderArtifactReport {
  readonly role: 'master' | 'stem' | 'midi';
  /** File name relative to the output directory. */
  readonly path: string;
  readonly format: 'wav' | 'midi';
  readonly formatVersion: number;
  readonly bytes: number;
  readonly sha256: string;
  readonly wav: WavReport | null;
}

export interface RenderStemReport {
  readonly trackIndex: number;
  readonly trackId: string;
  readonly trackName: string;
  readonly audio: RenderArtifactReport;
}

export interface RenderReportOutputs {
  readonly master: string;
  readonly stems: readonly string[];
  readonly midi: string | null;
  readonly report: string | null;
}

export interface RenderReportDuration {
  /** Authored duration hint in seconds, before tails and truncation. */
  readonly requestedSeconds: number;
  /** Authored duration hint in quarter-note beats. */
  readonly requestedBeats: number;
  /** Actual rendered duration from the shared duration formula, including tails. */
  readonly actualSeconds: number;
  readonly actualFrames: number;
  readonly deltaSeconds: number;
  readonly sampleRate: SampleRate;
  readonly channels: 2;
}

export interface RenderReportClipping {
  readonly clipped: boolean;
  readonly clippedSampleCount: number;
  readonly clippedFrameCount: number;
}

export interface RenderReportMastering {
  /** True when a normalization gain other than unity was applied. */
  readonly applied: boolean;
  /** Linear gain applied to the float master and every stem before encoding. */
  readonly gainDb: number;
  /** Peak target in dBFS, or null when normalization was not requested. */
  readonly targetDbfs: number | null;
  readonly peakBeforeDbfs: number | null;
  readonly peakAfterDbfs: number | null;
  /** True when gain was below unity to pull an over-target or clipped peak down. */
  readonly limited: boolean;
}

export interface RenderReportAudio {
  /** Float sample peak after mastering. It can exceed 1 before 16-bit encoding. */
  readonly peak: number;
  /** Peak in dBFS, or null for digital silence. */
  readonly peakDbfs: number | null;
  readonly clipping: RenderReportClipping;
  readonly mastering: RenderReportMastering;
  readonly loudness: LoudnessMeasurement;
}

export interface RenderReportBackend {
  readonly id: string;
  readonly name: string;
  readonly version: string | null;
  readonly versionSource: 'declared' | 'probe' | 'unknown';
  readonly voicePolicy: string;
  readonly maxVoicesPerTrack: number;
}

export interface RenderReportRegistryAsset {
  readonly assetId: string;
  readonly fileName: string;
  readonly format: 'sf2';
  readonly bytes: number;
  readonly checksum: {
    readonly algorithm: 'sha256';
    readonly value: string;
  };
  readonly license: {
    readonly spdx: string;
    readonly name: string;
    readonly redistribution: string;
  };
  readonly instrumentIds: readonly string[];
  readonly trackIds: readonly string[];
}

export interface RenderReportProjectAsset {
  readonly trackId: string;
  readonly path: string;
  readonly program: number;
  readonly bank: number;
  /** Project asset bytes are resolved and optionally checked by the backend. */
  readonly checksum: null;
  readonly verification: 'not-reported';
}

export interface RenderReportAssets {
  readonly registryVersion: number;
  readonly registry: readonly RenderReportRegistryAsset[];
  readonly project: readonly RenderReportProjectAsset[];
}

export interface RenderReportMidi {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  /** The complete shared MIDI export report, including its limitations. */
  readonly report: MidiExportReport;
}

export interface RenderReportWarnings {
  readonly validation: readonly ValidationIssue[];
  readonly audio: readonly AudioIssue[];
}

export interface RenderReportRun {
  /** ISO timestamp of this run. Run-dependent, never part of audio or MIDI bytes. */
  readonly startedAt: string;
  readonly elapsedMs: number;
  /** Absolute destination directory. Run-dependent. */
  readonly outputDir: string;
}

export interface RenderReportStemInvariant {
  readonly stemCount: number;
  /**
   * Stems captured at the master sum. Reconstructing 16-bit master PCM from
   * independently rounded stem PCM can differ by this many signed 16-bit steps.
   */
  readonly pcm16ToleranceLsb: number;
  readonly description: string;
}

export interface RenderReport {
  readonly format: typeof RENDER_REPORT_FORMAT;
  readonly formatVersion: typeof RENDER_REPORT_FORMAT_VERSION;
  readonly schemaVersion: '1.0.0';
  readonly title: string;
  readonly seed: number;
  readonly duration: RenderReportDuration;
  readonly audio: RenderReportAudio;
  readonly backend: RenderReportBackend;
  readonly assets: RenderReportAssets;
  readonly midi: RenderReportMidi | null;
  readonly stems: readonly RenderStemReport[];
  /** Published audio and MIDI artifacts. The report file itself is not listed. */
  readonly artifacts: readonly RenderArtifactReport[];
  readonly outputs: RenderReportOutputs;
  readonly warnings: RenderReportWarnings;
  readonly stemInvariant: RenderReportStemInvariant;
  readonly run: RenderReportRun;
}

export interface RenderSongArtifactsSuccess {
  readonly ok: true;
  readonly outputDir: string;
  readonly timeline: SongTimeline;
  readonly report: RenderReport;
  readonly artifacts: readonly RenderArtifactReport[];
  readonly warnings: readonly AudioIssue[];
  readonly validationWarnings: readonly ValidationIssue[];
}

export interface RenderSongArtifactsValidationFailure {
  readonly ok: false;
  readonly stage: 'validation';
  readonly errors: readonly ValidationIssue[];
  readonly warnings: readonly ValidationIssue[];
}

export interface RenderSongArtifactsCompileFailure {
  readonly ok: false;
  readonly stage: 'compile';
  readonly errors: readonly CompileIssue[];
  readonly warnings: readonly ValidationIssue[];
}

export interface RenderSongArtifactsIssueFailure {
  readonly ok: false;
  readonly stage: 'options' | 'audio' | 'artifacts' | 'cancelled';
  readonly errors: readonly AudioIssue[];
  readonly warnings: readonly AudioIssue[];
}

export type RenderSongArtifactsFailure =
  | RenderSongArtifactsValidationFailure
  | RenderSongArtifactsCompileFailure
  | RenderSongArtifactsIssueFailure;

export type RenderSongArtifactsResult = RenderSongArtifactsSuccess | RenderSongArtifactsFailure;

interface ParsedArtifactPlan {
  readonly master: string;
  readonly midi: string | null;
  readonly report: string | null;
  readonly stems: readonly StemArtifactPlan[];
}

interface PreflightResult {
  readonly outputDir: string;
  readonly existed: boolean;
}

type PathStats = Awaited<ReturnType<typeof lstat>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function issueFailure(
  stage: 'options' | 'audio' | 'artifacts' | 'cancelled',
  errors: readonly AudioIssue[],
  warnings: readonly AudioIssue[] = [],
): RenderSongArtifactsIssueFailure {
  return {
    ok: false,
    stage,
    errors: normalizeAudioIssues(errors),
    warnings: normalizeAudioIssues(warnings),
  };
}

function cancelledFailure(): RenderSongArtifactsIssueFailure {
  return issueFailure('cancelled', [
    createAudioIssue(
      'audio.cancelled',
      '/outputDir',
      'Artifact rendering was cancelled by the caller.',
      'No job artifacts were published. Start a new render when ready.',
      { abortedAt: 'artifact-boundary' },
    ),
  ]);
}

function optionIssue(path: string, message: string, hint: string): AudioIssue {
  return createAudioIssue('audio.options.invalid', path, message, hint);
}

function errorCode(error: unknown): string | null {
  if (isRecord(error) && typeof error.code === 'string') {
    return error.code;
  }
  return null;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * Sanitize a track name into a stable ASCII filename segment.
 *
 * The result is lowercase, contains only `a-z`, `0-9`, and single hyphens, is
 * at most 40 characters, and never ends with a separator. Non-Latin names fall
 * back to `track`. The track index prefix in `stemFileName` keeps the final
 * name unique even when two names sanitize to the same segment.
 */
export function sanitizeTrackSlug(value: string): string {
  let slug = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length > MAX_TRACK_SLUG_LENGTH) {
    slug = slug.slice(0, MAX_TRACK_SLUG_LENGTH).replace(/-+$/, '');
  }
  if (slug.length === 0 || WINDOWS_RESERVED_NAME.test(slug)) {
    return 'track';
  }
  return slug;
}

/** Stable, collision-free stem filename: `stem-<two-digit index>-<slug>.wav`. */
export function stemFileName(trackIndex: number, trackName: string): string {
  const prefix = String(trackIndex + 1).padStart(2, '0');
  return `${STEM_FILENAME_PREFIX}${prefix}-${sanitizeTrackSlug(trackName)}.wav`;
}

/** True when a name is a single safe cross-platform file name, not a path. */
export function isSafeArtifactFileName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_ARTIFACT_NAME_LENGTH &&
    SAFE_NAME_PATTERN.test(value) &&
    !value.includes('..') &&
    !value.endsWith('.') &&
    !value.endsWith(' ') &&
    !WINDOWS_RESERVED_NAME.test(value)
  );
}

/**
 * Worst-case reconstruction error after independently rounding each stem and
 * the master to signed 16-bit PCM. Each stem contributes up to half an LSB and
 * the master adds up to half an LSB, so the bound is `ceil((stems + 1) / 2)`.
 */
export function stemReconstructionToleranceLsb(stemCount: number): number {
  if (!Number.isFinite(stemCount) || stemCount <= 0) {
    return 0;
  }
  return Math.ceil((Math.floor(stemCount) + 1) / 2);
}

function planArtifacts(
  timeline: SongTimeline,
  stems: boolean,
  midi: boolean,
  report: boolean,
):
  | { readonly ok: true; readonly plan: ParsedArtifactPlan }
  | { readonly ok: false; readonly errors: readonly AudioIssue[] } {
  const errors: AudioIssue[] = [];
  const stemPlans: StemArtifactPlan[] = [];
  if (stems) {
    for (const track of timeline.tracks) {
      if (!track.audible) {
        continue;
      }
      stemPlans.push({
        trackIndex: track.index,
        trackId: track.id,
        trackName: track.name,
        fileName: stemFileName(track.index, track.name.length > 0 ? track.name : track.id),
      });
    }
  }

  if (stemPlans.length > MAX_STEM_COUNT) {
    errors.push(
      createAudioIssue(
        'audio.artifacts.limit',
        '/tracks',
        `The render requested ${stemPlans.length} stems, above the supported maximum of ${MAX_STEM_COUNT}.`,
        'Reduce the number of audible tracks. The v1 schema allows at most 16 tracks.',
        { stemCount: stemPlans.length, maximum: MAX_STEM_COUNT },
      ),
    );
  }

  const names = [
    MASTER_AUDIO_FILENAME,
    ...stemPlans.map((stem) => stem.fileName),
    ...(midi ? [MIDI_ARTIFACT_FILENAME] : []),
    ...(report ? [REPORT_ARTIFACT_FILENAME] : []),
  ];
  if (names.length > MAX_ARTIFACT_COUNT) {
    errors.push(
      createAudioIssue(
        'audio.artifacts.limit',
        '/outputDir',
        `The render would publish ${names.length} files, above the supported maximum of ${MAX_ARTIFACT_COUNT}.`,
        'Disable stems, MIDI, or the report, or split the song.',
        { artifactCount: names.length, maximum: MAX_ARTIFACT_COUNT },
      ),
    );
  }

  const seen = new Map<string, string>();
  for (const name of names) {
    if (!isSafeArtifactFileName(name)) {
      errors.push(
        createAudioIssue(
          'audio.artifacts.name_invalid',
          '/outputDir',
          `Artifact name "${name}" is not a safe cross-platform file name.`,
          'Use letters, digits, dots, and hyphens in a single file name with no path separators.',
          { fileName: name },
        ),
      );
      continue;
    }
    const key = name.toLowerCase();
    const previous = seen.get(key);
    if (previous !== undefined) {
      errors.push(
        createAudioIssue(
          'audio.artifacts.name_collision',
          '/outputDir',
          `Artifact names "${previous}" and "${name}" collide case-insensitively.`,
          'Rename the tracks so sanitized stem names remain distinct across platforms.',
          { first: previous, second: name },
        ),
      );
    } else {
      seen.set(key, name);
    }
  }

  const audioBytes = WAV_HEADER_BYTES + timeline.renderedSamples * 4;
  if (audioBytes > MAX_WAV_ARTIFACT_BYTES) {
    errors.push(
      createAudioIssue(
        'audio.artifacts.limit',
        '/renderedSamples',
        `One WAV artifact would be ${audioBytes} bytes, above the ${MAX_WAV_ARTIFACT_BYTES} byte bound.`,
        'Shorten the song. The audio bound is 600 seconds at 48 kHz stereo 16-bit PCM.',
        { bytes: audioBytes, maximum: MAX_WAV_ARTIFACT_BYTES },
      ),
    );
  } else {
    const estimated =
      audioBytes * (1 + stemPlans.length) +
      (midi ? MAX_MIDI_ARTIFACT_BYTES : 0) +
      (report ? MAX_REPORT_ARTIFACT_BYTES : 0);
    if (estimated > MAX_TOTAL_ARTIFACT_BYTES || estimated > MAX_RENDER_OUTPUT_BYTES) {
      errors.push(
        createAudioIssue(
          'audio.artifacts.limit',
          '/outputDir',
          `The estimated job output is ${estimated} bytes, above the ${MAX_TOTAL_ARTIFACT_BYTES} byte bound.`,
          'Disable stems or split the song so the job fits the documented output ceiling.',
          { estimatedBytes: estimated, maximum: MAX_TOTAL_ARTIFACT_BYTES },
        ),
      );
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    plan: {
      master: MASTER_AUDIO_FILENAME,
      midi: midi ? MIDI_ARTIFACT_FILENAME : null,
      report: report ? REPORT_ARTIFACT_FILENAME : null,
      stems: stemPlans,
    },
  };
}

function resolveArtifactOptions(
  options: unknown,
):
  | { readonly ok: true; readonly value: ResolvedArtifactOptions }
  | { readonly ok: false; readonly errors: readonly AudioIssue[] } {
  const errors: AudioIssue[] = [];
  if (!isRecord(options)) {
    return {
      ok: false,
      errors: [
        optionIssue(
          '',
          'Artifact render options must be an object with an outputDir.',
          'Pass { outputDir, sampleRate, stems?, midi?, report?, overwrite?, signal? }.',
        ),
      ],
    };
  }

  for (const key of Object.keys(options)) {
    if (!ARTIFACT_OPTION_KEYS.has(key)) {
      errors.push(
        optionIssue(
          `/${key}`,
          `Unknown artifact render option "${key}".`,
          'Use only outputDir, sampleRate, backend, maxVoicesPerTrack, limits, validation, mastering, stems, midi, report, overwrite, and signal.',
        ),
      );
    }
  }

  let outputDir = '';
  if (typeof options.outputDir !== 'string' || options.outputDir.trim().length === 0) {
    errors.push(
      optionIssue(
        '/outputDir',
        'outputDir must be a non-empty string.',
        'Pass the destination directory as a local filesystem path.',
      ),
    );
  } else if (options.outputDir.includes('\u0000')) {
    errors.push(
      optionIssue(
        '/outputDir',
        'outputDir must not contain a NUL byte.',
        'Pass a normal local filesystem path.',
      ),
    );
  } else {
    outputDir = resolve(options.outputDir);
  }

  const sampleRate = options.sampleRate;
  if (sampleRate !== 44100 && sampleRate !== 48000) {
    errors.push(
      optionIssue(
        '/sampleRate',
        'sampleRate must be 44100 or 48000.',
        'Choose one of the two supported render rates. Audio is never resampled.',
      ),
    );
  }

  for (const key of ['stems', 'midi', 'report', 'overwrite'] as const) {
    const value = options[key];
    if (value !== undefined && typeof value !== 'boolean') {
      errors.push(
        optionIssue(
          `/${key}`,
          `${key} must be a boolean.`,
          'Use true or false, or omit the option to use the documented default.',
        ),
      );
    }
  }

  let mastering: ResolvedMasteringOptions = {
    normalize: false,
    targetDbfs: -1,
    maxBoostDb: 9,
  };
  if (options.mastering !== undefined) {
    if (!isRecord(options.mastering)) {
      errors.push(
        optionIssue(
          '/mastering',
          'mastering must be an object.',
          'Pass { normalize?, targetDbfs?, maxBoostDb? } or omit it.',
        ),
      );
    } else {
      const raw = options.mastering;
      for (const key of Object.keys(raw)) {
        if (!['normalize', 'targetDbfs', 'maxBoostDb'].includes(key)) {
          errors.push(
            optionIssue(
              `/mastering/${key}`,
              `Unknown mastering option "${key}".`,
              'Use only normalize, targetDbfs, and maxBoostDb.',
            ),
          );
        }
      }
      if (raw.normalize !== undefined && typeof raw.normalize !== 'boolean') {
        errors.push(
          optionIssue(
            '/mastering/normalize',
            'mastering.normalize must be a boolean.',
            'Pass true or false, or omit it.',
          ),
        );
      }
      if (
        raw.targetDbfs !== undefined &&
        (typeof raw.targetDbfs !== 'number' ||
          !Number.isFinite(raw.targetDbfs) ||
          raw.targetDbfs < -6 ||
          raw.targetDbfs > 0)
      ) {
        errors.push(
          optionIssue(
            '/mastering/targetDbfs',
            'mastering.targetDbfs must be a number from -6 to 0.',
            'Use -1 for a conventional streaming-style peak target.',
          ),
        );
      }
      if (
        raw.maxBoostDb !== undefined &&
        (typeof raw.maxBoostDb !== 'number' ||
          !Number.isFinite(raw.maxBoostDb) ||
          raw.maxBoostDb < 0 ||
          raw.maxBoostDb > 18)
      ) {
        errors.push(
          optionIssue(
            '/mastering/maxBoostDb',
            'mastering.maxBoostDb must be a number from 0 to 18.',
            'Use 9 dB to lift quiet beds without turning silence into noise.',
          ),
        );
      }
      mastering = {
        normalize: (raw.normalize as boolean | undefined) ?? true,
        targetDbfs: (raw.targetDbfs as number | undefined) ?? -1,
        maxBoostDb: (raw.maxBoostDb as number | undefined) ?? 9,
      };
    }
  }

  let signal: AbortSignal | undefined;
  if (options.signal !== undefined) {
    if (
      typeof options.signal === 'object' &&
      options.signal !== null &&
      typeof (options.signal as { aborted?: unknown }).aborted === 'boolean'
    ) {
      signal = options.signal as AbortSignal;
    } else {
      errors.push(
        optionIssue(
          '/signal',
          'signal must be an AbortSignal.',
          'Pass the AbortSignal from an AbortController, or omit the option.',
        ),
      );
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      outputDir,
      sampleRate: sampleRate as SampleRate,
      ...(options.backend === undefined ? {} : { backend: options.backend as AudioBackend }),
      ...(options.maxVoicesPerTrack === undefined
        ? {}
        : { maxVoicesPerTrack: options.maxVoicesPerTrack as number }),
      ...(options.limits === undefined ? {} : { limits: options.limits as Partial<CompileLimits> }),
      ...(options.validation === undefined
        ? {}
        : { validation: options.validation as ValidateSongOptions }),
      mastering,
      stems: (options.stems as boolean | undefined) ?? DEFAULT_RENDER_ARTIFACTS.stems,
      midi: (options.midi as boolean | undefined) ?? DEFAULT_RENDER_ARTIFACTS.midi,
      report: (options.report as boolean | undefined) ?? DEFAULT_RENDER_ARTIFACTS.report,
      overwrite: (options.overwrite as boolean | undefined) ?? false,
      ...(signal === undefined ? {} : { signal }),
    },
  };
}

async function preflightOutput(
  outputDir: string,
  plan: ParsedArtifactPlan,
  overwrite: boolean,
): Promise<
  | { readonly ok: true; readonly value: PreflightResult }
  | { readonly ok: false; readonly errors: readonly AudioIssue[] }
> {
  const issued: AudioIssue[] = [];
  let existed = false;
  let info: PathStats | undefined;
  try {
    info = await lstat(outputDir);
    existed = true;
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      return {
        ok: false,
        errors: [
          createAudioIssue(
            'audio.artifacts.unwritable',
            '/outputDir',
            `The output directory "${outputDir}" could not be inspected.`,
            'Check that the path is readable and that its parent directory is accessible.',
            { path: outputDir, code: errorCode(error) },
          ),
        ],
      };
    }
    const parent = dirname(outputDir);
    let parentInfo: PathStats | null;
    try {
      parentInfo = await lstat(parent);
    } catch {
      parentInfo = null;
    }
    if (parentInfo === null || !parentInfo.isDirectory()) {
      return {
        ok: false,
        errors: [
          createAudioIssue(
            'audio.artifacts.output_invalid',
            '/outputDir',
            `The parent directory "${parent}" does not exist or is not a directory.`,
            'Create the parent directory first, then choose a new or existing output directory inside it.',
            { path: outputDir, parent },
          ),
        ],
      };
    }
  }

  if (info !== undefined && !info.isDirectory()) {
    return {
      ok: false,
      errors: [
        createAudioIssue(
          'audio.artifacts.output_invalid',
          '/outputDir',
          `The output path "${outputDir}" exists and is not a directory.`,
          'Pass a directory path. Existing files are never replaced by a directory.',
          { path: outputDir },
        ),
      ],
    };
  }

  const names = [
    plan.master,
    ...plan.stems.map((stem) => stem.fileName),
    ...(plan.midi === null ? [] : [plan.midi]),
    ...(plan.report === null ? [] : [plan.report]),
  ];
  if (existed) {
    for (const name of names) {
      const target = join(outputDir, name);
      let targetInfo;
      try {
        targetInfo = await lstat(target);
      } catch (error) {
        if (errorCode(error) === 'ENOENT') {
          continue;
        }
        issued.push(
          createAudioIssue(
            'audio.artifacts.unwritable',
            '/outputDir',
            `The artifact path "${target}" could not be inspected.`,
            'Check directory permissions and retry.',
            { path: target, code: errorCode(error) },
          ),
        );
        continue;
      }
      if (targetInfo.isDirectory()) {
        issued.push(
          createAudioIssue(
            'audio.artifacts.output_invalid',
            '/outputDir',
            `The artifact path "${target}" is a directory.`,
            'Remove or rename the directory so the render can publish a file with that name.',
            { path: target },
          ),
        );
      } else if (!overwrite) {
        issued.push(
          createAudioIssue(
            'audio.artifacts.exists',
            '/outputDir',
            `The artifact file "${target}" already exists.`,
            'Pass overwrite: true to replace existing artifacts, or choose a different output directory.',
            { path: target, fileName: name },
          ),
        );
      }
    }
  }

  if (issued.length > 0) {
    return { ok: false, errors: issued };
  }
  return { ok: true, value: { outputDir, existed } };
}

function normalizeVersion(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 200 ? trimmed : null;
}

async function resolveBackendVersion(backend: AudioBackend): Promise<{
  readonly version: string | null;
  readonly versionSource: 'declared' | 'probe' | 'unknown';
}> {
  if (typeof backend.probeVersion === 'function') {
    try {
      const probed = normalizeVersion(await backend.probeVersion());
      if (probed !== null) {
        return { version: probed, versionSource: 'probe' };
      }
    } catch {
      // A version probe is advisory. Degrade to unknown instead of failing.
    }
  }
  const declared = normalizeVersion(backend.version);
  if (declared !== null) {
    return { version: declared, versionSource: 'declared' };
  }
  return { version: null, versionSource: 'unknown' };
}

function collectAssets(timeline: SongTimeline): RenderReportAssets {
  const registry = new Map<
    string,
    {
      assetId: string;
      fileName: string;
      format: 'sf2';
      bytes: number;
      checksum: { algorithm: 'sha256'; value: string };
      license: { spdx: string; name: string; redistribution: string };
      instrumentIds: Set<string>;
      trackIds: Set<string>;
    }
  >();
  const project: RenderReportProjectAsset[] = [];

  for (const track of timeline.tracks) {
    if (track.instrument.type === 'builtin') {
      const entry = getInstrumentRegistryEntry(track.instrument.id);
      if (entry === undefined) {
        continue;
      }
      const asset = entry.asset;
      const current = registry.get(asset.id);
      if (current === undefined) {
        registry.set(asset.id, {
          assetId: asset.id,
          fileName: asset.fileName,
          format: asset.format,
          bytes: asset.bytes,
          checksum: { algorithm: asset.checksum.algorithm, value: asset.checksum.value },
          license: {
            spdx: asset.license.spdx,
            name: asset.license.name,
            redistribution: asset.license.redistribution,
          },
          instrumentIds: new Set([entry.id]),
          trackIds: new Set([track.id]),
        });
      } else {
        current.instrumentIds.add(entry.id);
        current.trackIds.add(track.id);
      }
    } else if (track.instrument.type === 'soundfont') {
      project.push({
        trackId: track.id,
        path: track.instrument.path,
        program: track.instrument.program,
        bank: track.instrument.bank,
        checksum: null,
        verification: 'not-reported',
      });
    }
  }

  return {
    registryVersion: INSTRUMENT_REGISTRY_VERSION,
    registry: [...registry.values()]
      .map((asset) => ({
        assetId: asset.assetId,
        fileName: asset.fileName,
        format: asset.format,
        bytes: asset.bytes,
        checksum: asset.checksum,
        license: asset.license,
        instrumentIds: [...asset.instrumentIds].sort(),
        trackIds: [...asset.trackIds].sort(),
      }))
      .sort((left, right) =>
        left.assetId < right.assetId ? -1 : left.assetId > right.assetId ? 1 : 0,
      ),
    project: project.sort((left, right) => (left.trackId < right.trackId ? -1 : 1)),
  };
}

function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function writeArtifact(
  directory: string,
  fileName: string,
  bytes: Uint8Array,
): Promise<
  | { readonly ok: true; readonly bytes: number; readonly sha256: string }
  | { readonly ok: false; readonly issue: AudioIssue }
> {
  const target = join(directory, fileName);
  try {
    await writeFile(target, bytes, { flag: 'wx' });
  } catch (error) {
    return {
      ok: false,
      issue: createAudioIssue(
        'audio.artifacts.write_failed',
        '/outputDir',
        `The artifact "${fileName}" could not be written to the job directory.`,
        'Check available disk space and directory permissions, then retry. No partial artifact is published.',
        { path: target, code: errorCode(error) },
      ),
    };
  }
  return { ok: true, bytes: bytes.length, sha256: hashBytes(bytes) };
}

function dbfsToLinear(db: number): number {
  return 10 ** (db / 20);
}

function linearToDbfs(value: number): number | null {
  return value > 0 && Number.isFinite(value) ? 20 * Math.log10(value) : null;
}

interface MasteringPlan {
  readonly gain: number;
  readonly gainDb: number;
  readonly applied: boolean;
  readonly limited: boolean;
  readonly targetDbfs: number | null;
  readonly peakBeforeDbfs: number | null;
}

function computeMasteringPlan(peak: number, settings: ResolvedMasteringOptions): MasteringPlan {
  if (!settings.normalize || !(peak > 0) || !Number.isFinite(peak)) {
    return {
      gain: 1,
      gainDb: 0,
      applied: false,
      limited: false,
      targetDbfs: settings.normalize ? settings.targetDbfs : null,
      peakBeforeDbfs: linearToDbfs(peak),
    };
  }
  const target = dbfsToLinear(settings.targetDbfs);
  let gain = target / peak;
  if (gain > 1) {
    gain = Math.min(gain, dbfsToLinear(settings.maxBoostDb));
  }
  return {
    gain,
    gainDb: 20 * Math.log10(gain),
    applied: Math.abs(gain - 1) > 1e-9,
    limited: gain < 1,
    targetDbfs: settings.targetDbfs,
    peakBeforeDbfs: linearToDbfs(peak),
  };
}

function scaleStereo(
  audio: {
    readonly format: typeof PCM_BUFFER_FORMAT;
    readonly formatVersion: typeof PCM_BUFFER_FORMAT_VERSION;
    readonly sampleRate: SampleRate;
    readonly frameCount: number;
    readonly left: Float32Array;
    readonly right: Float32Array;
  },
  gain: number,
) {
  if (gain === 1) {
    return audio;
  }
  const left = new Float32Array(audio.frameCount);
  const right = new Float32Array(audio.frameCount);
  for (let frame = 0; frame < audio.frameCount; frame += 1) {
    left[frame] = (audio.left[frame] ?? 0) * gain;
    right[frame] = (audio.right[frame] ?? 0) * gain;
  }
  return { ...audio, left, right };
}

interface DecodedStereoWav {
  readonly sampleRate: number;
  readonly frameCount: number;
  readonly left: Float32Array;
  readonly right: Float32Array;
}

function decodePcm16StereoWav(bytes: Uint8Array): DecodedStereoWav | null {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF') {
    return null;
  }
  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bits = 0;
  let format = 0;
  let data: Buffer | null = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (size > buffer.length - start) {
      return null;
    }
    if (id === 'fmt ' && size >= 16) {
      format = buffer.readUInt16LE(start);
      channels = buffer.readUInt16LE(start + 2);
      sampleRate = buffer.readUInt32LE(start + 4);
      bits = buffer.readUInt16LE(start + 14);
    } else if (id === 'data') {
      data = buffer.subarray(start, start + size);
    }
    offset = start + size + (size % 2);
  }
  if (format !== 1 || channels !== 2 || bits !== 16 || data === null || sampleRate <= 0) {
    return null;
  }
  if (data.length % 4 !== 0) {
    return null;
  }
  const frameCount = data.length / 4;
  const left = new Float32Array(frameCount);
  const right = new Float32Array(frameCount);
  for (let frame = 0; frame < frameCount; frame += 1) {
    left[frame] = data.readInt16LE(frame * 4) / 32768;
    right[frame] = data.readInt16LE(frame * 4 + 2) / 32768;
  }
  return { sampleRate, frameCount, left, right };
}

function audioArtifact(
  role: 'master' | 'stem',
  fileName: string,
  encoded: { readonly bytes: Uint8Array; readonly report: WavReport; readonly sha256: string },
): RenderArtifactReport {
  return {
    role,
    path: fileName,
    format: 'wav',
    formatVersion: encoded.report.formatVersion,
    bytes: encoded.bytes.length,
    sha256: encoded.sha256,
    wav: encoded.report,
  };
}

interface PublishBackup {
  readonly target: string;
  readonly backup: string;
}

async function backupExistingArtifact(
  outputDir: string,
  backupDir: string,
  name: string,
  overwrite: boolean,
): Promise<
  | { readonly ok: true; readonly backup: PublishBackup | null }
  | { readonly ok: false; readonly issue: AudioIssue }
> {
  const target = join(outputDir, name);
  let info: PathStats;
  try {
    info = await lstat(target);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return { ok: true, backup: null };
    }
    return {
      ok: false,
      issue: createAudioIssue(
        'audio.artifacts.unwritable',
        '/outputDir',
        `The artifact path "${target}" could not be inspected before publishing.`,
        'Check directory permissions and retry. No artifact was replaced.',
        { path: target, code: errorCode(error) },
      ),
    };
  }

  if (!overwrite) {
    return {
      ok: false,
      issue: createAudioIssue(
        'audio.artifacts.exists',
        '/outputDir',
        `The artifact file "${target}" appeared after the overwrite check.`,
        'Pass overwrite: true to replace existing artifacts, or choose a different output directory.',
        { path: target, fileName: name },
      ),
    };
  }
  if (info.isDirectory()) {
    return {
      ok: false,
      issue: createAudioIssue(
        'audio.artifacts.output_invalid',
        '/outputDir',
        `The artifact path "${target}" is a directory.`,
        'Remove or rename the directory so the render can publish a file with that name.',
        { path: target },
      ),
    };
  }

  const backup = join(backupDir, name);
  try {
    await rename(target, backup);
  } catch (error) {
    return {
      ok: false,
      issue: createAudioIssue(
        'audio.artifacts.publish_failed',
        '/outputDir',
        `The existing artifact "${target}" could not be moved aside for replacement.`,
        'Check that the destination is writable. No artifact was replaced.',
        { path: target, code: errorCode(error) },
      ),
    };
  }
  return { ok: true, backup: { target, backup } };
}

/**
 * Roll back a partial publish into an existing directory.
 *
 * Files this job already moved into place are removed, then every replaced
 * user artifact is restored from the job directory. This keeps a failed
 * overwrite from destroying the previous render or any unrelated file. Returns
 * false when any restore step failed, so the caller can retain the job
 * directory instead of deleting the only remaining copy.
 */
async function restorePublishedArtifacts(
  backups: readonly PublishBackup[],
  published: readonly string[],
  warnings: AudioIssue[],
): Promise<boolean> {
  let restored = true;
  for (const target of [...published].reverse()) {
    try {
      await rm(target, { force: true });
    } catch {
      restored = false;
      warnings.push(
        createAudioIssue(
          'audio.artifacts.cleanup_failed',
          '/outputDir',
          `The partial artifact "${target}" could not be removed during rollback.`,
          'Remove the file manually. Previously published files were restored where possible.',
          { path: target },
        ),
      );
    }
  }
  for (const entry of [...backups].reverse()) {
    try {
      await rename(entry.backup, entry.target);
    } catch {
      restored = false;
      warnings.push(
        createAudioIssue(
          'audio.artifacts.cleanup_failed',
          '/outputDir',
          `The previous artifact "${entry.target}" could not be restored after a failed publish.`,
          'Recover the file from the retained job directory, or rerender without overwrite.',
          { path: entry.target, backup: entry.backup },
        ),
      );
    }
  }
  return restored;
}

function retainedJobWarning(tempDir: string): AudioIssue {
  return createAudioIssue(
    'audio.artifacts.cleanup_failed',
    '/outputDir',
    'Previous artifacts could not all be restored, so the render job directory was retained.',
    'Recover the backup files from the retained job directory, then remove it manually. No unrelated files were touched.',
    { path: tempDir },
  );
}

async function rollbackPublication(
  jobDirectory: string,
  backups: readonly PublishBackup[],
  published: string[],
  warnings: AudioIssue[],
  cleanup: () => Promise<void>,
): Promise<void> {
  const restored = await restorePublishedArtifacts(backups, published, warnings);
  published.length = 0;
  if (!restored) {
    warnings.push(retainedJobWarning(jobDirectory));
    return;
  }
  await cleanup();
}

function reportContainsNonFinite(value: unknown, seen: Set<object>): boolean {
  if (typeof value === 'number') {
    return !Number.isFinite(value);
  }
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  if (seen.has(value)) {
    return false;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((entry) => reportContainsNonFinite(entry, seen));
  }
  return Object.values(value).some((entry) => reportContainsNonFinite(entry, seen));
}

async function removeJobDirectory(
  tempDir: string | null,
  published: readonly string[],
  warnings: AudioIssue[],
): Promise<void> {
  for (const path of [...published].reverse()) {
    try {
      await rm(path, { force: true });
    } catch {
      warnings.push(
        createAudioIssue(
          'audio.artifacts.cleanup_failed',
          '/outputDir',
          `The incomplete artifact "${path}" could not be removed.`,
          'Remove the file manually. No unrelated files were touched.',
          { path },
        ),
      );
    }
  }
  if (tempDir !== null) {
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      warnings.push(
        createAudioIssue(
          'audio.artifacts.cleanup_failed',
          '/outputDir',
          `The render job directory "${tempDir}" could not be removed.`,
          'Remove the temporary directory manually. No published artifacts or unrelated files were touched.',
          { path: tempDir },
        ),
      );
    }
  }
}

function artifactFailure(
  stage: 'artifacts' | 'audio' | 'cancelled',
  errors: readonly AudioIssue[],
  warnings: readonly AudioIssue[] = [],
): RenderSongArtifactsIssueFailure {
  return issueFailure(stage, errors, warnings);
}

function compileOptions(options: ResolvedArtifactOptions): {
  readonly sampleRate: SampleRate;
  readonly limits?: Partial<CompileLimits>;
  readonly validation?: ValidateSongOptions;
} {
  return {
    sampleRate: options.sampleRate,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.validation === undefined ? {} : { validation: options.validation }),
  };
}

function isAbortError(error: unknown): boolean {
  return isRecord(error) && error.name === 'AbortError';
}

/**
 * Render a validated song into a complete, atomically published artifact set.
 *
 * The flow is: validate and compile through the shared compiler, plan and
 * preflight the artifact names, create a private job directory, export MIDI,
 * render once while writing each post-effect stem, encode the master, build the
 * JSON report, then publish files with renames. Nothing is written to the
 * destination until every requested artifact has been produced.
 *
 * Expected failures are structured values. Invalid songs never touch the
 * filesystem. A failure or abort removes the job directory and any files this
 * invocation published.
 */
export async function renderSongArtifacts(
  input: unknown,
  options: RenderSongArtifactsOptions,
): Promise<RenderSongArtifactsResult> {
  const resolved = resolveArtifactOptions(options);
  if (!resolved.ok) {
    return issueFailure('options', resolved.errors);
  }
  const settings = resolved.value;
  if (isAborted(settings.signal)) {
    return cancelledFailure();
  }

  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const startedHr = performance.now();

  const compiled = compileSong(input, compileOptions(settings));
  if (!compiled.ok) {
    if (compiled.stage === 'validation') {
      return {
        ok: false,
        stage: 'validation',
        errors: compiled.errors,
        warnings: compiled.warnings,
      };
    }
    return {
      ok: false,
      stage: 'compile',
      errors: compiled.errors,
      warnings: compiled.warnings,
    };
  }
  const timeline = compiled.timeline;

  if (isAborted(settings.signal)) {
    return cancelledFailure();
  }

  const planned = planArtifacts(timeline, settings.stems, settings.midi, settings.report);
  if (!planned.ok) {
    return artifactFailure('artifacts', planned.errors);
  }
  const plan = planned.plan;

  const preflight = await preflightOutput(settings.outputDir, plan, settings.overwrite);
  if (!preflight.ok) {
    return artifactFailure('artifacts', preflight.errors);
  }
  const outputExisted = preflight.value.existed;

  let tempDir: string | null = null;
  const published: string[] = [];
  const audioWarnings: AudioIssue[] = [];
  try {
    const tempParent = outputExisted ? settings.outputDir : dirname(settings.outputDir);
    tempDir = await mkdtemp(join(tempParent, '.vamp-render-'));
  } catch (error) {
    return artifactFailure('artifacts', [
      createAudioIssue(
        'audio.artifacts.unwritable',
        '/outputDir',
        `A private job directory could not be created next to "${settings.outputDir}".`,
        'Check that the parent directory is writable and that the path is on a local filesystem with space available.',
        { path: settings.outputDir, code: errorCode(error) },
      ),
    ]);
  }

  const cleanup = async (): Promise<void> => {
    await removeJobDirectory(tempDir, published, audioWarnings);
    tempDir = null;
    published.length = 0;
  };

  try {
    let midiArtifact: RenderArtifactReport | null = null;
    let midiReport: MidiExportReport | null = null;
    if (plan.midi !== null) {
      const exported = exportMidi(timeline);
      if (!exported.ok) {
        await cleanup();
        return artifactFailure(
          'artifacts',
          exported.errors.map((issue) =>
            createAudioIssue(
              'audio.artifacts.write_failed',
              issue.path,
              `The MIDI artifact could not be exported: ${issue.message}`,
              issue.hint,
              { midiCode: issue.code },
            ),
          ),
          audioWarnings,
        );
      }
      const written = await writeArtifact(tempDir, plan.midi, exported.bytes);
      if (!written.ok) {
        await cleanup();
        return artifactFailure('artifacts', [written.issue], audioWarnings);
      }
      midiArtifact = {
        role: 'midi',
        path: plan.midi,
        format: 'midi',
        formatVersion: exported.report.formatVersion,
        bytes: written.bytes,
        sha256: written.sha256,
        wav: null,
      };
      midiReport = exported.report;
    }

    const stemByIndex = new Map(plan.stems.map((stem) => [stem.trackIndex, stem]));
    const stemArtifacts: RenderArtifactReport[] = [];
    const stemByFileName = new Map<string, RenderArtifactReport>();
    let sinkFailure: AudioIssue | null = null;

    const onTrackAudio = async (capture: TrackAudioCapture): Promise<void> => {
      if (isAborted(settings.signal)) {
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      }
      const stem = stemByIndex.get(capture.trackIndex);
      if (stem === undefined) {
        sinkFailure = createAudioIssue(
          'audio.artifacts.name_invalid',
          `/tracks/${capture.trackIndex}`,
          `No stem plan exists for track "${capture.trackId}".`,
          'This indicates an internal artifact planning bug. Report the song and options.',
          { trackId: capture.trackId },
        );
        throw new Error('missing stem plan');
      }
      const encoded = encodeWav({
        format: PCM_BUFFER_FORMAT,
        formatVersion: PCM_BUFFER_FORMAT_VERSION,
        sampleRate: capture.sampleRate,
        frameCount: capture.frameCount,
        left: capture.left,
        right: capture.right,
      });
      if (!encoded.ok) {
        sinkFailure = encoded.errors[0] ?? null;
        throw new Error('stem encode failed');
      }
      if (encoded.report.clippedSampleCount > 0) {
        audioWarnings.push(
          createAudioIssue(
            'audio.pcm.clipped',
            `/tracks/${capture.trackIndex}`,
            `The stem for track "${capture.trackId}" contains ${encoded.report.clippedSampleCount} clipped channel sample${
              encoded.report.clippedSampleCount === 1 ? '' : 's'
            } across ${encoded.report.clippedFrameCount} frame${
              encoded.report.clippedFrameCount === 1 ? '' : 's'
            }.`,
            'Lower this track volume or its effect output to preserve headroom. The encoder clamps at the 16-bit boundary and never normalizes.',
            {
              trackId: capture.trackId,
              clippedSampleCount: encoded.report.clippedSampleCount,
              clippedFrameCount: encoded.report.clippedFrameCount,
              peak: encoded.report.peak,
            },
          ),
        );
      }
      const written = await writeArtifact(tempDir as string, stem.fileName, encoded.bytes);
      if (!written.ok) {
        sinkFailure = written.issue;
        throw new Error('stem write failed');
      }
      stemArtifacts.push(
        audioArtifact('stem', stem.fileName, {
          bytes: encoded.bytes,
          report: encoded.report,
          sha256: written.sha256,
        }),
      );
      stemByFileName.set(
        stem.fileName,
        stemArtifacts[stemArtifacts.length - 1] as RenderArtifactReport,
      );
    };

    const backend = settings.backend === undefined ? createBuiltinSynthBackend() : settings.backend;
    const rendered = await renderTimelineAudio(timeline, {
      sampleRate: settings.sampleRate,
      backend,
      ...(settings.maxVoicesPerTrack === undefined
        ? {}
        : { maxVoicesPerTrack: settings.maxVoicesPerTrack }),
      ...(plan.stems.length > 0 ? { onTrackAudio } : {}),
      ...(settings.signal === undefined ? {} : { signal: settings.signal }),
    });

    if (!rendered.ok) {
      await cleanup();
      if (isAborted(settings.signal)) {
        return cancelledFailure();
      }
      if (sinkFailure !== null) {
        return artifactFailure('artifacts', [sinkFailure], audioWarnings);
      }
      return artifactFailure('audio', rendered.errors, rendered.warnings);
    }

    audioWarnings.push(...rendered.warnings);

    if (isAborted(settings.signal)) {
      await cleanup();
      return cancelledFailure();
    }

    const masteringPlan = computeMasteringPlan(rendered.stats.peak, settings.mastering);
    const masterAudio = scaleStereo(rendered.audio, masteringPlan.gain);
    const encodedMaster = encodeWav(masterAudio);
    if (!encodedMaster.ok) {
      await cleanup();
      return artifactFailure('artifacts', encodedMaster.errors, [
        ...audioWarnings,
        ...encodedMaster.warnings,
      ]);
    }
    audioWarnings.push(...encodedMaster.warnings);
    const masterWritten = await writeArtifact(tempDir, plan.master, encodedMaster.bytes);
    if (!masterWritten.ok) {
      await cleanup();
      return artifactFailure('artifacts', [masterWritten.issue], [...audioWarnings]);
    }
    const masterArtifact = audioArtifact('master', plan.master, {
      bytes: encodedMaster.bytes,
      report: encodedMaster.report,
      sha256: masterWritten.sha256,
    });

    if (masteringPlan.gain !== 1 && stemArtifacts.length > 0) {
      // Stems were encoded during the render, before the master peak was known.
      // Re-encode them with the same gain so stems still sum to the master.
      const retained = audioWarnings.filter(
        (issue) => issue.code !== 'audio.pcm.clipped' || !issue.path.startsWith('/tracks/'),
      );
      audioWarnings.length = 0;
      audioWarnings.push(...retained);
      for (let index = 0; index < stemArtifacts.length; index += 1) {
        const artifact = stemArtifacts[index];
        if (artifact === undefined) {
          continue;
        }
        let bytes: Buffer;
        try {
          bytes = await readFile(join(tempDir, artifact.path));
        } catch {
          await cleanup();
          return artifactFailure(
            'artifacts',
            [
              createAudioIssue(
                'audio.artifacts.write_failed',
                '/outputDir',
                `The stem "${artifact.path}" could not be re-read for master normalization.`,
                'Check temporary directory permissions and free space. No artifact was published.',
              ),
            ],
            audioWarnings,
          );
        }
        const decoded = decodePcm16StereoWav(bytes);
        if (
          decoded === null ||
          decoded.sampleRate !== settings.sampleRate ||
          decoded.frameCount !== rendered.audio.frameCount
        ) {
          await cleanup();
          return artifactFailure(
            'artifacts',
            [
              createAudioIssue(
                'audio.backend.output_invalid',
                '/outputDir',
                `The stem "${artifact.path}" is not the expected stereo 16-bit WAV for master normalization.`,
                'This indicates an internal artifact bug. No artifact was published.',
              ),
            ],
            audioWarnings,
          );
        }
        const encoded = encodeWav(
          scaleStereo(
            {
              format: PCM_BUFFER_FORMAT,
              formatVersion: PCM_BUFFER_FORMAT_VERSION,
              sampleRate: decoded.sampleRate as SampleRate,
              frameCount: decoded.frameCount,
              left: decoded.left,
              right: decoded.right,
            },
            masteringPlan.gain,
          ),
        );
        if (!encoded.ok) {
          await cleanup();
          return artifactFailure('artifacts', encoded.errors, audioWarnings);
        }
        try {
          await writeFile(join(tempDir, artifact.path), encoded.bytes);
        } catch {
          await cleanup();
          return artifactFailure(
            'artifacts',
            [
              createAudioIssue(
                'audio.artifacts.write_failed',
                '/outputDir',
                `The normalized stem "${artifact.path}" could not be written.`,
                'Check temporary directory permissions and free space. No artifact was published.',
              ),
            ],
            audioWarnings,
          );
        }
        const updated = audioArtifact('stem', artifact.path, {
          bytes: encoded.bytes,
          report: encoded.report,
          sha256: hashBytes(encoded.bytes),
        });
        stemArtifacts[index] = updated;
        stemByFileName.set(updated.path, updated);
        if (encoded.report.clippedSampleCount > 0) {
          audioWarnings.push(
            createAudioIssue(
              'audio.pcm.clipped',
              `/tracks/${String(updated.path)}`,
              `The normalized stem "${updated.path}" still clips ${String(
                encoded.report.clippedSampleCount,
              )} channel sample(s).`,
              'Lower the track volume or effect output; normalization cannot fix a stem that exceeds full scale after gain.',
              {
                clippedSampleCount: encoded.report.clippedSampleCount,
                peak: encoded.report.peak,
              },
            ),
          );
        }
      }
    }

    const loudness = measureIntegratedLoudness(masterAudio);
    const backendVersion = await resolveBackendVersion(backend);
    const warningsForReport = normalizeAudioIssues(audioWarnings);
    const stemReports: RenderStemReport[] = plan.stems.map((stem) => {
      const artifact = stemByFileName.get(stem.fileName);
      if (artifact === undefined) {
        throw new Error(`missing stem artifact for ${stem.fileName}`);
      }
      return {
        trackIndex: stem.trackIndex,
        trackId: stem.trackId,
        trackName: stem.trackName,
        audio: artifact,
      };
    });
    const artifacts: RenderArtifactReport[] = [
      masterArtifact,
      ...stemArtifacts,
      ...(midiArtifact === null ? [] : [midiArtifact]),
    ];
    const actualSeconds = timeline.renderedSeconds;
    const report: RenderReport = {
      format: RENDER_REPORT_FORMAT,
      formatVersion: RENDER_REPORT_FORMAT_VERSION,
      schemaVersion: '1.0.0',
      title: timeline.meta.title,
      seed: timeline.meta.seed,
      duration: {
        requestedSeconds: timeline.hintSeconds,
        requestedBeats: timeline.meta.durationHintBeats,
        actualSeconds,
        actualFrames: timeline.renderedSamples,
        deltaSeconds: actualSeconds - timeline.hintSeconds,
        sampleRate: timeline.sampleRate,
        channels: 2,
      },
      audio: {
        peak: encodedMaster.report.peak,
        peakDbfs: encodedMaster.report.peakDbfs,
        clipping: {
          clipped: encodedMaster.report.clippedSampleCount > 0,
          clippedSampleCount: encodedMaster.report.clippedSampleCount,
          clippedFrameCount: encodedMaster.report.clippedFrameCount,
        },
        mastering: {
          applied: masteringPlan.applied,
          gainDb: masteringPlan.gainDb,
          targetDbfs: masteringPlan.targetDbfs,
          peakBeforeDbfs: masteringPlan.peakBeforeDbfs,
          peakAfterDbfs: encodedMaster.report.peakDbfs,
          limited: masteringPlan.limited,
        },
        loudness,
      },
      backend: {
        id: rendered.stats.backendId,
        name: backend.name,
        version: backendVersion.version,
        versionSource: backendVersion.versionSource,
        voicePolicy: rendered.stats.voiceCapPolicy,
        maxVoicesPerTrack: rendered.stats.maxVoicesPerTrack,
      },
      assets: collectAssets(timeline),
      midi:
        midiReport === null || midiArtifact === null
          ? null
          : {
              path: midiArtifact.path,
              bytes: midiArtifact.bytes,
              sha256: midiArtifact.sha256,
              report: midiReport,
            },
      stems: stemReports,
      artifacts,
      outputs: {
        master: plan.master,
        stems: plan.stems.map((stem) => stem.fileName),
        midi: plan.midi,
        report: plan.report,
      },
      warnings: {
        validation: compiled.warnings,
        audio: warningsForReport,
      },
      stemInvariant: {
        stemCount: stemReports.length,
        pcm16ToleranceLsb: stemReconstructionToleranceLsb(stemReports.length),
        description:
          'Float stems are captured at the master sum and are the exact track contributions of its float32 accumulation. Independently rounded 16-bit WAV stems can differ from the rounded 16-bit master by the documented per-sample tolerance when neither signal is clamped.',
      },
      run: {
        startedAt,
        elapsedMs: Math.max(0, Math.round(performance.now() - startedHr)),
        outputDir: settings.outputDir,
      },
    };

    if (reportContainsNonFinite(report, new Set())) {
      await cleanup();
      return artifactFailure(
        'artifacts',
        [
          createAudioIssue(
            'audio.report.invalid',
            '/report',
            'The report contains a non-finite number and was not written.',
            'This indicates an internal report bug. No artifact was published.',
          ),
        ],
        audioWarnings,
      );
    }

    if (plan.report !== null) {
      const reportBytes = new TextEncoder().encode(`${JSON.stringify(report, null, 2)}\n`);
      const written = await writeArtifact(tempDir, plan.report, reportBytes);
      if (!written.ok) {
        await cleanup();
        return artifactFailure('artifacts', [written.issue], audioWarnings);
      }
    }

    if (isAborted(settings.signal)) {
      await cleanup();
      return cancelledFailure();
    }

    // Publish. A new output directory is created by one atomic directory rename.
    // An existing directory gets one atomic file rename per artifact, with the
    // report last so it never describes missing audio.
    if (!outputExisted) {
      try {
        await rename(tempDir, settings.outputDir);
        tempDir = null;
      } catch (error) {
        await cleanup();
        return artifactFailure(
          'artifacts',
          [
            createAudioIssue(
              'audio.artifacts.publish_failed',
              '/outputDir',
              `The completed render could not be published to "${settings.outputDir}".`,
              'Check that the destination parent is writable and that the output path does not already exist.',
              { path: settings.outputDir, code: errorCode(error) },
            ),
          ],
          audioWarnings,
        );
      }
    } else {
      const publishOrder = [
        plan.master,
        ...plan.stems.map((stem) => stem.fileName),
        ...(plan.midi === null ? [] : [plan.midi]),
        ...(plan.report === null ? [] : [plan.report]),
      ];
      const backupDir = join(tempDir, '.previous-artifacts');
      const backups: PublishBackup[] = [];
      try {
        await mkdir(backupDir);
      } catch (error) {
        await cleanup();
        return artifactFailure(
          'artifacts',
          [
            createAudioIssue(
              'audio.artifacts.unwritable',
              '/outputDir',
              'A rollback directory could not be created inside the render job directory.',
              'Check available disk space and directory permissions, then retry. No artifact was replaced.',
              { path: backupDir, code: errorCode(error) },
            ),
          ],
          audioWarnings,
        );
      }
      // Move every artifact this job will replace aside before publishing
      // anything. A failure or cancellation later can then restore the previous
      // render instead of deleting a user file.
      for (const name of publishOrder) {
        if (isAborted(settings.signal)) {
          await rollbackPublication(backupDir, backups, published, audioWarnings, cleanup);
          return cancelledFailure();
        }
        const prepared = await backupExistingArtifact(
          settings.outputDir,
          backupDir,
          name,
          settings.overwrite,
        );
        if (!prepared.ok) {
          await rollbackPublication(backupDir, backups, published, audioWarnings, cleanup);
          return artifactFailure('artifacts', [prepared.issue], audioWarnings);
        }
        if (prepared.backup !== null) {
          backups.push(prepared.backup);
        }
      }
      for (const name of publishOrder) {
        if (isAborted(settings.signal)) {
          await rollbackPublication(backupDir, backups, published, audioWarnings, cleanup);
          return cancelledFailure();
        }
        const target = join(settings.outputDir, name);
        try {
          await rename(join(tempDir, name), target);
          published.push(target);
        } catch (error) {
          await rollbackPublication(backupDir, backups, published, audioWarnings, cleanup);
          return artifactFailure(
            'artifacts',
            [
              createAudioIssue(
                'audio.artifacts.publish_failed',
                '/outputDir',
                `The artifact "${name}" could not be published to "${settings.outputDir}".`,
                'Check that the destination is writable and that no directory occupies the target name. Files published by this job were removed and replaced artifacts were restored.',
                { path: target, code: errorCode(error) },
              ),
            ],
            audioWarnings,
          );
        }
      }
      // Every artifact is published. Clear the rollback list before removing
      // the now-unneeded job directory, including the backed-up old artifacts,
      // so successful outputs are kept.
      published.length = 0;
      await cleanup();
    }

    return {
      ok: true,
      outputDir: settings.outputDir,
      timeline,
      report,
      artifacts,
      warnings: normalizeAudioIssues(audioWarnings),
      validationWarnings: compiled.warnings,
    };
  } catch (error) {
    await cleanup();
    if (isAborted(settings.signal) || isAbortError(error)) {
      return cancelledFailure();
    }
    return artifactFailure(
      'artifacts',
      [
        createAudioIssue(
          'audio.artifacts.write_failed',
          '/outputDir',
          'Artifact rendering failed before the output was published.',
          'No partial outputs were published. Check the output path and available disk space, then retry.',
          { code: errorCode(error) },
        ),
      ],
      audioWarnings,
    );
  }
}
