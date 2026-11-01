import type { ValidationIssue, ValidateSongOptions } from '@gxaditya/vamp-schema';

import { compileSong, type CompileLimits, type CompileSongOptions } from '../compile.js';
import { createCompileIssue, type CompileIssue } from '../errors.js';
import type { SongTimeline } from '../timeline.js';
import type { SampleRate } from '../time.js';
import type { AudioBackend } from './backend.js';
import { createAudioIssue, normalizeAudioIssues, type AudioIssue } from './errors.js';
import {
  renderTimelineAudio,
  type AudioRenderStats,
  type StereoAudioBuffer,
  type TrackAudioSink,
} from './render.js';
import { encodeWav, type WavReport } from './wav.js';

export interface SongAudioRenderOptions {
  /** Required compile sample rate. Also the expected render sample rate. */
  readonly sampleRate: SampleRate;
  readonly limits?: Partial<CompileLimits>;
  readonly validation?: ValidateSongOptions;
  readonly backend?: AudioBackend;
  readonly maxVoicesPerTrack?: number;
  /** Optional post-effect per-track capture hook, forwarded to the renderer. */
  readonly onTrackAudio?: TrackAudioSink;
  /** Optional cancellation signal, forwarded to the renderer. */
  readonly signal?: AbortSignal;
}

export interface SongAudioRenderSuccess {
  readonly ok: true;
  readonly timeline: SongTimeline;
  readonly audio: StereoAudioBuffer;
  readonly stats: AudioRenderStats;
  readonly warnings: readonly AudioIssue[];
  /** Schema warnings from the validation stage, kept separate from audio warnings. */
  readonly validationWarnings: readonly ValidationIssue[];
}

export interface SongAudioRenderValidationFailure {
  readonly ok: false;
  readonly stage: 'validation';
  readonly errors: readonly ValidationIssue[];
  readonly warnings: readonly ValidationIssue[];
}

export interface SongAudioRenderCompileFailure {
  readonly ok: false;
  readonly stage: 'compile';
  readonly errors: readonly CompileIssue[];
  readonly warnings: readonly ValidationIssue[];
}

export interface SongAudioRenderAudioFailure {
  readonly ok: false;
  readonly stage: 'audio';
  readonly errors: readonly AudioIssue[];
  readonly warnings: readonly AudioIssue[];
}

export type SongAudioRenderFailure =
  SongAudioRenderValidationFailure | SongAudioRenderCompileFailure | SongAudioRenderAudioFailure;

export type SongAudioRenderResult = SongAudioRenderSuccess | SongAudioRenderFailure;

export interface SongWavRenderSuccess {
  readonly ok: true;
  readonly timeline: SongTimeline;
  readonly bytes: Uint8Array;
  readonly report: WavReport;
  readonly stats: AudioRenderStats;
  readonly warnings: readonly AudioIssue[];
  readonly validationWarnings: readonly ValidationIssue[];
}

export interface SongWavEncodeFailure {
  readonly ok: false;
  readonly stage: 'encode';
  readonly errors: readonly AudioIssue[];
  readonly warnings: readonly AudioIssue[];
}

export type SongWavRenderFailure = SongAudioRenderFailure | SongWavEncodeFailure;

export type SongWavRenderResult = SongWavRenderSuccess | SongWavRenderFailure;

const SONG_RENDER_OPTION_KEYS = new Set([
  'sampleRate',
  'limits',
  'validation',
  'backend',
  'maxVoicesPerTrack',
  'onTrackAudio',
  'signal',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unknownOptionFailure(key: string): SongAudioRenderAudioFailure {
  return {
    ok: false,
    stage: 'audio',
    errors: normalizeAudioIssues([
      createAudioIssue(
        'audio.options.invalid',
        `/${key}`,
        `Unknown song render option "${key}".`,
        'Use only sampleRate, limits, validation, backend, maxVoicesPerTrack, onTrackAudio, and signal. Unknown options are rejected rather than ignored.',
      ),
    ]),
    warnings: [],
  };
}

function compileOptionsFrom(values: Record<string, unknown>): CompileSongOptions {
  return {
    sampleRate: values.sampleRate as SampleRate,
    ...(values.limits === undefined ? {} : { limits: values.limits as Partial<CompileLimits> }),
    ...(values.validation === undefined
      ? {}
      : { validation: values.validation as ValidateSongOptions }),
  };
}

/**
 * Validate, compile, and render a song to stereo Float32 PCM.
 *
 * This is the convenience path over the shared pipeline. It does not add a
 * second validator, pattern expander, or duration formula: `compileSong` owns
 * those steps and `renderTimelineAudio` consumes the resulting timeline.
 */
export async function renderSongAudio(
  input: unknown,
  options: SongAudioRenderOptions,
): Promise<SongAudioRenderResult> {
  if (!isRecord(options)) {
    // Let the shared compiler produce its normal structured option failure.
    const compiled = compileSong(input, options as unknown as CompileSongOptions);
    if (compiled.ok) {
      return {
        ok: false,
        stage: 'compile',
        errors: [
          createCompileIssue(
            'compile.options.invalid',
            '',
            'Song render options must be an object with a sampleRate.',
            'Pass { sampleRate: 44100 | 48000, limits?, validation?, backend?, maxVoicesPerTrack? }.',
          ),
        ],
        warnings: compiled.warnings,
      };
    }
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

  for (const key of Object.keys(options)) {
    if (!SONG_RENDER_OPTION_KEYS.has(key)) {
      return unknownOptionFailure(key);
    }
  }

  if (options.validation !== undefined && !isRecord(options.validation)) {
    return {
      ok: false,
      stage: 'compile',
      errors: [
        createCompileIssue(
          'compile.options.invalid',
          '/validation',
          'Validation options must be an object.',
          'Omit validation or pass a ValidateSongOptions object.',
        ),
      ],
      warnings: [],
    };
  }

  const compileOptions = compileOptionsFrom(options);
  const compiled = compileSong(input, compileOptions);
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

  const rendered = await renderTimelineAudio(compiled.timeline, {
    sampleRate: compileOptions.sampleRate,
    ...(options.backend === undefined ? {} : { backend: options.backend as AudioBackend }),
    ...(options.maxVoicesPerTrack === undefined
      ? {}
      : { maxVoicesPerTrack: options.maxVoicesPerTrack as number }),
    ...(options.onTrackAudio === undefined
      ? {}
      : { onTrackAudio: options.onTrackAudio as TrackAudioSink }),
    ...(options.signal === undefined ? {} : { signal: options.signal as AbortSignal }),
  });
  if (!rendered.ok) {
    return {
      ok: false,
      stage: 'audio',
      errors: rendered.errors,
      warnings: rendered.warnings,
    };
  }

  return {
    ok: true,
    timeline: compiled.timeline,
    audio: rendered.audio,
    stats: rendered.stats,
    warnings: rendered.warnings,
    validationWarnings: compiled.warnings,
  };
}

/**
 * Validate, compile, render, and encode a song as a 16-bit stereo WAV.
 *
 * The returned success intentionally omits the intermediate Float32 buffer so a
 * complete render holds one representation at a time. Use `renderSongAudio`
 * followed by `encodeWav` when the PCM buffer is also needed.
 */
export async function renderSongToWav(
  input: unknown,
  options: SongAudioRenderOptions,
): Promise<SongWavRenderResult> {
  const rendered = await renderSongAudio(input, options);
  if (!rendered.ok) {
    return rendered;
  }

  const encoded = encodeWav(rendered.audio);
  if (!encoded.ok) {
    return {
      ok: false,
      stage: 'encode',
      errors: encoded.errors,
      warnings: normalizeAudioIssues([...rendered.warnings, ...encoded.warnings]),
    };
  }

  return {
    ok: true,
    timeline: rendered.timeline,
    bytes: encoded.bytes,
    report: encoded.report,
    stats: rendered.stats,
    warnings: normalizeAudioIssues([...rendered.warnings, ...encoded.warnings]),
    validationWarnings: rendered.validationWarnings,
  };
}
