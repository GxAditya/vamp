import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { SongSchemaV1 } from '@gxaditya/vamp-schema';

import {
  BUILTIN_SYNTH_INSTRUMENT_IDS,
  renderSongAudio,
  renderSongToWav,
  renderTimelineAudio,
  type AudioBackend,
  type AudioRenderOptions,
  type AudioRenderSuccess,
  type SongAudioRenderOptions,
  type SongAudioRenderSuccess,
  type SongWavRenderSuccess,
  type StereoAudioBuffer,
  type WavReport,
} from '../src/index.js';

export interface ParsedWav {
  readonly riff: string;
  readonly wave: string;
  readonly riffChunkSize: number;
  readonly formatChunkId: string;
  readonly formatChunkSize: number;
  readonly audioFormat: number;
  readonly channels: number;
  readonly sampleRate: number;
  readonly byteRate: number;
  readonly blockAlign: number;
  readonly bitDepth: number;
  readonly dataChunkId: string;
  readonly dataSize: number;
  readonly dataOffset: number;
  readonly frameCount: number;
  readonly fileBytes: number;
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let text = '';
  for (let index = 0; index < length; index += 1) {
    text += String.fromCharCode(bytes[offset + index] ?? 0);
  }
  return text;
}

/**
 * Independent RIFF/WAVE header parser. Tests use this instead of the encoder's
 * own offset arithmetic so a shared bug cannot hide.
 */
export function parseWav(bytes: Uint8Array): ParsedWav {
  if (bytes.length < 44) {
    throw new Error(`WAV is too short: ${bytes.length} bytes`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const blockAlign = view.getUint16(32, true);
  const dataSize = view.getUint32(40, true);
  return {
    riff: readAscii(bytes, 0, 4),
    wave: readAscii(bytes, 8, 4),
    riffChunkSize: view.getUint32(4, true),
    formatChunkId: readAscii(bytes, 12, 4),
    formatChunkSize: view.getUint32(16, true),
    audioFormat: view.getUint16(20, true),
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    byteRate: view.getUint32(28, true),
    blockAlign,
    bitDepth: view.getUint16(34, true),
    dataChunkId: readAscii(bytes, 36, 4),
    dataSize,
    dataOffset: 44,
    frameCount: blockAlign === 0 ? 0 : dataSize / blockAlign,
    fileBytes: bytes.length,
  };
}

export function readPcm16(
  bytes: Uint8Array,
  parsed: ParsedWav,
  frame: number,
  channel: 0 | 1,
): number {
  const offset = parsed.dataOffset + frame * parsed.blockAlign + channel * 2;
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt16(offset, true);
}

export function countNonZeroPcmFrames(bytes: Uint8Array, parsed: ParsedWav): number {
  let count = 0;
  for (let frame = 0; frame < parsed.frameCount; frame += 1) {
    if (readPcm16(bytes, parsed, frame, 0) !== 0 || readPcm16(bytes, parsed, frame, 1) !== 0) {
      count += 1;
    }
  }
  return count;
}

export interface AudioMetrics {
  readonly peak: number;
  readonly rms: number;
  readonly zeroCrossingRate: number;
}

export function measureAudio(audio: StereoAudioBuffer): AudioMetrics {
  let peak = 0;
  let energy = 0;
  let crossings = 0;
  let previousMono = 0;
  for (let frame = 0; frame < audio.frameCount; frame += 1) {
    const left = audio.left[frame] ?? 0;
    const right = audio.right[frame] ?? 0;
    peak = Math.max(peak, Math.abs(left), Math.abs(right));
    energy += left * left + right * right;
    const mono = (left + right) * 0.5;
    if (frame > 0 && ((mono >= 0 && previousMono < 0) || (mono < 0 && previousMono >= 0))) {
      crossings += 1;
    }
    previousMono = mono;
  }
  return {
    peak,
    rms: Math.sqrt(energy / Math.max(1, audio.frameCount * 2)),
    zeroCrossingRate: crossings / Math.max(1, audio.frameCount),
  };
}

export function assertFinite(audio: StereoAudioBuffer): void {
  for (let frame = 0; frame < audio.frameCount; frame += 1) {
    if (!Number.isFinite(audio.left[frame]) || !Number.isFinite(audio.right[frame])) {
      throw new Error(`Non-finite sample at frame ${frame}`);
    }
  }
}

export function lastNonZeroFrame(audio: StereoAudioBuffer): number {
  for (let frame = audio.frameCount - 1; frame >= 0; frame -= 1) {
    if ((audio.left[frame] ?? 0) !== 0 || (audio.right[frame] ?? 0) !== 0) {
      return frame;
    }
  }
  return -1;
}

export async function renderTimelineOk(
  timeline: unknown,
  options?: AudioRenderOptions,
): Promise<AudioRenderSuccess> {
  const result = await renderTimelineAudio(timeline, options);
  if (!result.ok) {
    throw new Error(`Expected audio render success: ${JSON.stringify(result.errors)}`);
  }
  return result;
}

export async function renderSongOk(
  song: unknown,
  options: SongAudioRenderOptions,
): Promise<SongAudioRenderSuccess> {
  const result = await renderSongAudio(song, options);
  if (!result.ok) {
    throw new Error(`Expected song audio render success: ${JSON.stringify(result)}`);
  }
  return result;
}

export async function renderWavOk(
  song: unknown,
  options: SongAudioRenderOptions,
): Promise<SongWavRenderSuccess> {
  const result = await renderSongToWav(song, options);
  if (!result.ok) {
    throw new Error(`Expected WAV render success: ${JSON.stringify(result)}`);
  }
  return result;
}

const fixturesRoot = fileURLToPath(new URL('./fixtures/', import.meta.url));

export function loadBuiltinCue(): SongSchemaV1 {
  return JSON.parse(
    readFileSync(join(fixturesRoot, 'builtin-cue.song.json'), 'utf8'),
  ) as SongSchemaV1;
}

export function wavReportMatchesParsed(report: WavReport, parsed: ParsedWav): boolean {
  return (
    report.frameCount === parsed.frameCount &&
    report.sampleRate === parsed.sampleRate &&
    report.channels === parsed.channels &&
    report.bitDepth === parsed.bitDepth &&
    report.blockAlign === parsed.blockAlign &&
    report.byteRate === parsed.byteRate &&
    report.dataBytes === parsed.dataSize &&
    report.fileBytes === parsed.fileBytes
  );
}

export function sameFloat32(left: Float32Array, right: Float32Array): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

export function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

/**
 * A deterministic synthetic mono source for DSP and automation tests.
 *
 * The backend ignores the note events and returns `signal(frame)` exactly, so a
 * test can inspect the shared gain, pan, automation, and effect stages without
 * depending on a synthesizer envelope.
 */
export function createSignalBackend(signal: (frame: number) => number): AudioBackend {
  return {
    id: 'test-signal-v1',
    name: 'Synthetic signal backend',
    description: 'Deterministic synthetic mono source used by fast DSP tests.',
    capabilities: {
      instrumentTypes: ['builtin'],
      builtinIds: [...BUILTIN_SYNTH_INSTRUMENT_IDS],
      voicePolicy: 'drop-newest',
    },
    async renderTrack(request) {
      const samples = new Float32Array(request.frameCount);
      for (let frame = 0; frame < request.frameCount; frame += 1) {
        samples[frame] = signal(frame);
      }
      return {
        ok: true,
        samples,
        stats: {
          startedVoices: 0,
          droppedVoices: 0,
          stolenVoices: 0,
          peakActiveVoices: 0,
        },
        warnings: [],
      };
    },
  };
}

export function constantSignal(value: number): (frame: number) => number {
  return () => value;
}

export function impulseSignal(frame: number, at = 0, amplitude = 1): number {
  return frame === at ? amplitude : 0;
}

export function measureRms(samples: Float32Array, start: number, end: number): number {
  const from = Math.max(0, Math.min(samples.length, Math.floor(start)));
  const to = Math.max(from, Math.min(samples.length, Math.floor(end)));
  let energy = 0;
  for (let index = from; index < to; index += 1) {
    const value = samples[index] ?? 0;
    energy += value * value;
  }
  return Math.sqrt(energy / Math.max(1, to - from));
}
