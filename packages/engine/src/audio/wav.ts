import { isSampleRate } from '../time.js';
import { createAudioIssue, normalizeAudioIssues, type AudioIssue } from './errors.js';

/** Stable WAV container marker. */
export const WAV_FORMAT = 'wav' as const;

/** Current WAV encoder output version. */
export const WAV_FORMAT_VERSION = 1 as const;

/** v1 output is fixed stereo. */
export const WAV_CHANNELS = 2 as const;

/** v1 output is fixed 16-bit signed little-endian PCM. */
export const WAV_BIT_DEPTH = 16 as const;

export const WAV_SAMPLE_ENCODING = 'pcm-s16le' as const;

/** Canonical RIFF/WAVE header size in bytes. No optional chunks are emitted. */
export const WAV_HEADER_BYTES = 44 as const;

export interface WavReport {
  readonly format: typeof WAV_FORMAT;
  readonly formatVersion: typeof WAV_FORMAT_VERSION;
  readonly encoding: typeof WAV_SAMPLE_ENCODING;
  /** WAVE format tag 1 means integer PCM. */
  readonly audioFormat: 1;
  readonly channels: typeof WAV_CHANNELS;
  readonly sampleRate: 44100 | 48000;
  readonly bitDepth: typeof WAV_BIT_DEPTH;
  readonly frameCount: number;
  readonly blockAlign: 4;
  readonly byteRate: number;
  readonly dataBytes: number;
  readonly fileBytes: number;
  readonly peak: number;
  readonly peakDbfs: number | null;
  /** Individual channel samples clamped at the signed 16-bit boundary. */
  readonly clippedSampleCount: number;
  /** Frames where at least one channel was clamped. */
  readonly clippedFrameCount: number;
}

export interface WavEncodeSuccess {
  readonly ok: true;
  readonly bytes: Uint8Array;
  readonly report: WavReport;
  readonly warnings: readonly AudioIssue[];
}

export interface WavEncodeFailure {
  readonly ok: false;
  readonly errors: readonly AudioIssue[];
  readonly warnings: readonly AudioIssue[];
}

export type WavEncodeResult = WavEncodeSuccess | WavEncodeFailure;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toDbfs(peak: number): number | null {
  if (!(peak > 0)) {
    return null;
  }
  return 20 * Math.log10(peak);
}

function invalidBuffer(path: string, message: string, hint: string): WavEncodeFailure {
  return {
    ok: false,
    errors: normalizeAudioIssues([createAudioIssue('audio.buffer.invalid', path, message, hint)]),
    warnings: [],
  };
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
}

function clampPcm16(sample: number): { readonly value: number; readonly clipped: boolean } {
  const clipped = sample > 1 || sample < -1;
  const scaled = Math.round(sample * 32767);
  if (scaled > 32767) {
    return { value: 32767, clipped };
  }
  if (scaled < -32768) {
    return { value: -32768, clipped };
  }
  return { value: scaled, clipped };
}

/**
 * Encode stereo Float32 PCM as a standards-compliant RIFF/WAVE file.
 *
 * Format: integer PCM (format tag 1), 2 channels, 16 bits per sample,
 * little-endian, at 44100 or 48000 Hz. The file has a canonical 44 byte header
 * and one `data` chunk with interleaved left/right samples. No LIST, fact, cue,
 * or broadcast-extension chunks are written. No dithering is applied, so output
 * bytes are deterministic.
 *
 * Conversion uses `round(sample * 32767)` and clamps to [-32768, 32767]. A sample
 * outside [-1, 1] is counted and reported in the WAV report and as an
 * `audio.pcm.clipped` warning. Samples are never normalized or scaled down.
 */
export function encodeWav(audio: unknown): WavEncodeResult {
  if (!isRecord(audio)) {
    return invalidBuffer(
      '/audio',
      'The WAV encoder requires a stereo PCM buffer object.',
      'Pass the audio value returned by renderTimelineAudio.',
    );
  }
  if (audio.format !== 'vamp.pcm' || audio.formatVersion !== 1) {
    return invalidBuffer(
      '/audio',
      'The PCM buffer marker is not "vamp.pcm" version 1.',
      'Use the audio value returned by renderTimelineAudio, or construct an equivalent version 1 buffer.',
    );
  }
  if (!isSampleRate(audio.sampleRate)) {
    return invalidBuffer(
      '/audio/sampleRate',
      'The PCM buffer sample rate is not 44100 or 48000.',
      'Render the timeline at a supported sample rate.',
    );
  }
  if (
    typeof audio.frameCount !== 'number' ||
    !Number.isSafeInteger(audio.frameCount) ||
    audio.frameCount < 0
  ) {
    return invalidBuffer(
      '/audio/frameCount',
      'The PCM buffer frameCount must be a non-negative safe integer.',
      'Pass the exact frame count returned by the renderer.',
    );
  }
  if (!(audio.left instanceof Float32Array)) {
    return invalidBuffer(
      '/audio/left',
      'The left channel must be a Float32Array.',
      'Use the renderer output or a Float32Array of the same length as frameCount.',
    );
  }
  if (!(audio.right instanceof Float32Array)) {
    return invalidBuffer(
      '/audio/right',
      'The right channel must be a Float32Array.',
      'Use the renderer output or a Float32Array of the same length as frameCount.',
    );
  }
  if (audio.left.length !== audio.frameCount || audio.right.length !== audio.frameCount) {
    return invalidBuffer(
      '/audio',
      'The channel lengths do not equal frameCount.',
      'Both channels must contain exactly frameCount Float32 samples.',
    );
  }

  const frameCount = audio.frameCount;
  const dataBytes = frameCount * WAV_CHANNELS * (WAV_BIT_DEPTH / 8);
  const fileBytes = WAV_HEADER_BYTES + dataBytes;
  if (!Number.isSafeInteger(dataBytes) || fileBytes > 0xffffffff) {
    return invalidBuffer(
      '/audio/frameCount',
      'The PCM data is too large for a RIFF/WAVE file with 32-bit chunk sizes.',
      'Render a shorter timeline.',
    );
  }

  const bytes = new Uint8Array(fileBytes);
  const view = new DataView(bytes.buffer);
  const byteRate = audio.sampleRate * WAV_CHANNELS * (WAV_BIT_DEPTH / 8);
  const blockAlign = WAV_CHANNELS * (WAV_BIT_DEPTH / 8);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, WAV_CHANNELS, true);
  view.setUint32(24, audio.sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, WAV_BIT_DEPTH, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);

  const left = audio.left;
  const right = audio.right;
  let peak = 0;
  let clippedSampleCount = 0;
  let clippedFrameCount = 0;
  let offset = WAV_HEADER_BYTES;

  for (let frame = 0; frame < frameCount; frame += 1) {
    const leftSample = left[frame];
    const rightSample = right[frame];
    if (leftSample === undefined || rightSample === undefined) {
      return invalidBuffer(
        '/audio',
        `The PCM buffer is missing channel data at frame ${frame}.`,
        'Both channels must contain exactly frameCount samples.',
      );
    }
    if (!Number.isFinite(leftSample)) {
      return {
        ok: false,
        errors: normalizeAudioIssues([
          createAudioIssue(
            'audio.samples.non_finite',
            '/audio/left',
            `The left channel contains a non-finite sample at frame ${frame}.`,
            'Fix the renderer or buffer. Non-finite audio is never encoded or clamped.',
            { frame, channel: 'left' },
          ),
        ]),
        warnings: [],
      };
    }
    if (!Number.isFinite(rightSample)) {
      return {
        ok: false,
        errors: normalizeAudioIssues([
          createAudioIssue(
            'audio.samples.non_finite',
            '/audio/right',
            `The right channel contains a non-finite sample at frame ${frame}.`,
            'Fix the renderer or buffer. Non-finite audio is never encoded or clamped.',
            { frame, channel: 'right' },
          ),
        ]),
        warnings: [],
      };
    }

    const leftMagnitude = Math.abs(leftSample);
    const rightMagnitude = Math.abs(rightSample);
    peak = Math.max(peak, leftMagnitude, rightMagnitude);

    const leftPcm = clampPcm16(leftSample);
    const rightPcm = clampPcm16(rightSample);
    if (leftPcm.clipped) {
      clippedSampleCount += 1;
    }
    if (rightPcm.clipped) {
      clippedSampleCount += 1;
    }
    if (leftPcm.clipped || rightPcm.clipped) {
      clippedFrameCount += 1;
    }

    view.setInt16(offset, leftPcm.value, true);
    view.setInt16(offset + 2, rightPcm.value, true);
    offset += 4;
  }

  const warnings: AudioIssue[] = [];
  if (clippedSampleCount > 0) {
    warnings.push(
      createAudioIssue(
        'audio.pcm.clipped',
        '/audio',
        `The master contains ${clippedSampleCount} clipped channel sample${
          clippedSampleCount === 1 ? '' : 's'
        } across ${clippedFrameCount} frame${clippedFrameCount === 1 ? '' : 's'}.`,
        'Lower track volumes to preserve headroom. The encoder clamps at the 16-bit boundary and never normalizes or limits the mix.',
        { clippedSampleCount, clippedFrameCount, peak },
      ),
    );
  }

  return {
    ok: true,
    bytes,
    report: {
      format: WAV_FORMAT,
      formatVersion: WAV_FORMAT_VERSION,
      encoding: WAV_SAMPLE_ENCODING,
      audioFormat: 1,
      channels: WAV_CHANNELS,
      sampleRate: audio.sampleRate,
      bitDepth: WAV_BIT_DEPTH,
      frameCount,
      blockAlign: 4,
      byteRate,
      dataBytes,
      fileBytes,
      peak,
      peakDbfs: toDbfs(peak),
      clippedSampleCount,
      clippedFrameCount,
    },
    warnings: normalizeAudioIssues(warnings),
  };
}
