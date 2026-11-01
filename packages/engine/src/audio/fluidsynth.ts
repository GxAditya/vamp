/**
 * FluidSynth sample-library backend.
 *
 * The backend renders one track at a time. It builds a neutral one-track MIDI
 * file with the shared `exportMidi` exporter, renders that file offline through
 * FluidSynth 2.x, decodes the 16-bit WAV, downmixes stereo to mono, and returns
 * exactly `frameCount` dry samples. Track volume, pan, and the master sum remain
 * the shared mixer's responsibility, so the neutral MIDI omits CC7/CC10 and
 * automation.
 *
 * Determinism scope: identical song, seed, options, pinned FluidSynth version,
 * SoundFont bytes, and platform produce identical PCM on that platform. The
 * backend does not promise byte identity across platforms or FluidSynth builds.
 * The CLI, MCP server, and SDK default to automatic selection, which uses this
 * backend when FluidSynth and a GM SoundFont are locally available.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';

import type { NormalizedInstrument } from '@gxaditya/vamp-schema';

import type { SongTimeline, TimelineNoteEvent, TimelineTrack } from '../timeline.js';
import { exportMidi, type MidiExportReport } from '../midi.js';
import {
  FLUIDR3_GM_ASSET,
  FLUIDSYNTH_BACKEND_ID,
  INSTRUMENT_REGISTRY,
  SAMPLE_BACKEND_INSTRUMENT_TYPES,
  getInstrumentRegistryEntry,
  type InstrumentRegistryEntry,
} from '../instruments.js';
import {
  DEFAULT_MAX_SOUNDFONT_BYTES,
  resolveProjectSoundFont,
  validateTrustedSoundFont,
  type AssetValidationIssue,
  type ResolvedAsset,
} from './assets.js';
import {
  AUDIO_VOICE_POLICY,
  MAX_VOICES_PER_TRACK,
  type AudioBackend,
  type AudioBackendCapabilities,
  type AudioBackendTrackResult,
  type AudioBackendTrackStats,
  type AudioTrackRenderRequest,
} from './backend.js';
import { createAudioIssue, normalizeAudioIssues, type AudioIssue } from './errors.js';

/** Default subprocess timeout for one track render. */
export const FLUIDSYNTH_DEFAULT_TIMEOUT_MS = 30_000;

/** Bounded timeout for the advisory `--version` probe used by render reports. */
export const FLUIDSYNTH_VERSION_PROBE_TIMEOUT_MS = 3_000;

/** Default captured stdout and stderr ceilings per process. */
export const FLUIDSYNTH_DEFAULT_STREAM_BYTES = 65_536;

/** Default slack for FluidSynth release tails beyond the requested frame count. */
export const FLUIDSYNTH_OUTPUT_SLACK_BYTES = 67_108_864;

/** Hard ceiling for one temporary FluidSynth WAV. */
export const FLUIDSYNTH_MAX_OUTPUT_BYTES = 536_870_912;

const MIDI_END_QUARTER_BEATS = 4;
const MAX_BPM = 300;
const MIN_BPM = 20;

export interface FluidSynthBackendConfig {
  /** Executable name or absolute path. Defaults to `fluidsynth` on PATH. */
  readonly binaryPath?: string;
  /**
   * Trusted, globally configured GM SoundFont used for `gm` instruments and the
   * curated builtin mappings. This is backend configuration, not a song asset,
   * so it may live outside the project root. Required for those instruments.
   */
  readonly gmSoundFont?: string;
  /**
   * Project root for song-referenced `.sf2` assets. Required only when a song
   * uses `{ "type": "soundfont" }`.
   */
  readonly projectRoot?: string;
  /** Wall-clock timeout per FluidSynth process. Defaults to 30 seconds. */
  readonly timeoutMs?: number;
  /** Captured stdout ceiling in bytes. */
  readonly maxStdoutBytes?: number;
  /** Captured stderr ceiling in bytes. */
  readonly maxStderrBytes?: number;
  /** Ceiling for the temporary FluidSynth WAV file. */
  readonly maxOutputBytes?: number;
  /** Ceiling for a SoundFont file. Defaults to 512 MiB. */
  readonly maxAssetBytes?: number;
  /** Verify the configured GM SoundFont against the registry checksum. */
  readonly verifyGmSoundFontChecksum?: boolean;
  /**
   * Optional expected lowercase SHA-256 per project-relative SoundFont path.
   * Keys are the song's instrument path exactly as authored.
   */
  readonly assetChecksums?: Readonly<Record<string, string>>;
  /**
   * Extra environment variables merged over a minimal sanitized environment.
   * The backend never inherits the full parent environment.
   */
  readonly environment?: Readonly<Record<string, string>>;
}

/** Capabilities advertised by the FluidSynth backend. SFZ is absent by design. */
export const FLUIDSYNTH_BACKEND_CAPABILITIES: AudioBackendCapabilities = Object.freeze({
  instrumentTypes: SAMPLE_BACKEND_INSTRUMENT_TYPES,
  builtinIds: Object.freeze(INSTRUMENT_REGISTRY.map((definition) => definition.id)),
  voicePolicy: AUDIO_VOICE_POLICY,
});

/** Description of the program and bank selected for the neutral MIDI track. */
export interface FluidSynthMidiSelection {
  readonly instrumentType: 'gm' | 'soundfont';
  readonly program: number;
  readonly bank: number;
  readonly channel: number;
}

export interface PreparedFluidSynthTrack {
  readonly midi: Uint8Array;
  readonly report: MidiExportReport;
  readonly stats: AudioBackendTrackStats;
  readonly selection: FluidSynthMidiSelection;
}

export type PrepareFluidSynthTrackResult =
  | { readonly ok: true; readonly prepared: PreparedFluidSynthTrack }
  | { readonly ok: false; readonly errors: readonly AudioIssue[] };

export interface VoiceCapPlan {
  readonly events: readonly TimelineNoteEvent[];
  readonly stats: AudioBackendTrackStats;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeIntegerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

const CONFIG_KEYS = new Set([
  'binaryPath',
  'gmSoundFont',
  'projectRoot',
  'timeoutMs',
  'maxStdoutBytes',
  'maxStderrBytes',
  'maxOutputBytes',
  'maxAssetBytes',
  'verifyGmSoundFontChecksum',
  'assetChecksums',
  'environment',
]);

function validateConfig(config: FluidSynthBackendConfig): {
  readonly issues: readonly AudioIssue[];
  readonly resolved: Required<
    Pick<
      FluidSynthBackendConfig,
      'binaryPath' | 'timeoutMs' | 'maxStdoutBytes' | 'maxStderrBytes' | 'maxAssetBytes'
    >
  >;
} {
  const issues: AudioIssue[] = [];
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) {
      issues.push(
        createAudioIssue(
          'audio.config.invalid',
          `/${key}`,
          `Unknown FluidSynth backend configuration option "${key}".`,
          'Use only binaryPath, gmSoundFont, projectRoot, timeoutMs, maxStdoutBytes, maxStderrBytes, maxOutputBytes, maxAssetBytes, verifyGmSoundFontChecksum, assetChecksums, and environment.',
        ),
      );
    }
  }
  const binaryPath =
    config.binaryPath === undefined || config.binaryPath.trim() === ''
      ? 'fluidsynth'
      : config.binaryPath;
  const timeoutMs = config.timeoutMs ?? FLUIDSYNTH_DEFAULT_TIMEOUT_MS;
  const maxStdoutBytes = config.maxStdoutBytes ?? FLUIDSYNTH_DEFAULT_STREAM_BYTES;
  const maxStderrBytes = config.maxStderrBytes ?? FLUIDSYNTH_DEFAULT_STREAM_BYTES;
  const maxAssetBytes = config.maxAssetBytes ?? DEFAULT_MAX_SOUNDFONT_BYTES;

  if (!isSafeIntegerInRange(timeoutMs, 1, 600_000)) {
    issues.push(
      createAudioIssue(
        'audio.config.invalid',
        '/timeoutMs',
        'timeoutMs must be an integer from 1 to 600000.',
        'Use a bounded subprocess timeout in milliseconds.',
      ),
    );
  }
  for (const [key, value] of [
    ['maxStdoutBytes', maxStdoutBytes],
    ['maxStderrBytes', maxStderrBytes],
  ] as const) {
    if (!isSafeIntegerInRange(value, 0, 16_777_216)) {
      issues.push(
        createAudioIssue(
          'audio.config.invalid',
          `/${key}`,
          `${key} must be an integer from 0 to 16777216.`,
          'Bound captured process output to a small diagnostic ceiling.',
        ),
      );
    }
  }
  if (!isSafeIntegerInRange(maxAssetBytes, 1, 8_589_934_592)) {
    issues.push(
      createAudioIssue(
        'audio.config.invalid',
        '/maxAssetBytes',
        'maxAssetBytes must be a positive integer no larger than 8 GiB.',
        'Raise the asset ceiling deliberately or use a smaller SoundFont.',
      ),
    );
  }
  if (config.gmSoundFont !== undefined && typeof config.gmSoundFont !== 'string') {
    issues.push(
      createAudioIssue(
        'audio.config.invalid',
        '/gmSoundFont',
        'gmSoundFont must be an absolute path string when present.',
        'Configure a provisioned SoundFont, or omit it and use builtin instruments with the built-in synth backend.',
      ),
    );
  }
  if (config.projectRoot !== undefined && typeof config.projectRoot !== 'string') {
    issues.push(
      createAudioIssue(
        'audio.config.invalid',
        '/projectRoot',
        'projectRoot must be a directory path string when present.',
        'Configure the project directory that contains song assets.',
      ),
    );
  } else if (config.projectRoot !== undefined && !isAbsolute(config.projectRoot)) {
    issues.push(
      createAudioIssue(
        'audio.config.invalid',
        '/projectRoot',
        'projectRoot must be an absolute path.',
        'Configure the absolute project directory that contains song assets so renders do not depend on the process working directory.',
      ),
    );
  }
  if (config.assetChecksums !== undefined) {
    if (!isRecord(config.assetChecksums)) {
      issues.push(
        createAudioIssue(
          'audio.config.invalid',
          '/assetChecksums',
          'assetChecksums must be an object of relative path to SHA-256.',
          'Pass { "assets/piano.sf2": "<64 hex characters>" } or omit it.',
        ),
      );
    } else {
      for (const [path, digest] of Object.entries(config.assetChecksums)) {
        if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/i.test(digest)) {
          issues.push(
            createAudioIssue(
              'audio.config.invalid',
              `/assetChecksums/${path}`,
              'Each configured asset checksum must be a 64 character SHA-256 hex digest.',
              'Use the pinned digest documented for the asset, or omit the entry to skip the checksum.',
            ),
          );
        }
      }
    }
  }

  return {
    issues,
    resolved: { binaryPath, timeoutMs, maxStdoutBytes, maxStderrBytes, maxAssetBytes },
  };
}

/**
 * Deterministic pre-render voice cap.
 *
 * Policy `drop-newest`: events are visited in canonical timeline order. A note
 * start is dropped when the number of notated notes still sounding at that
 * sample is already at the cap. The oldest sounding note is never cut short.
 *
 * Approximation: SoundFont release tails are not known before rendering, so
 * active accounting uses notated note ends only. FluidSynth's own polyphony
 * limit is set to `maxVoices`; a release tail may therefore be reclaimed by the
 * sampler when many notes end close together. That internal release accounting
 * is not observable as stolen voices and is not reported as such.
 */
export function planVoiceCap(
  events: readonly TimelineNoteEvent[],
  maxVoices: number,
  frameCount: number,
): VoiceCapPlan {
  const kept: TimelineNoteEvent[] = [];
  let activeEnds: number[] = [];
  let startedVoices = 0;
  let droppedVoices = 0;
  let peakActiveVoices = 0;

  for (const event of events) {
    if (!event.audible || event.startSample >= frameCount || event.endSample <= event.startSample) {
      continue;
    }
    activeEnds = activeEnds.filter((end) => end > event.startSample);
    if (activeEnds.length >= maxVoices) {
      droppedVoices += 1;
      continue;
    }
    const end = Math.max(event.startSample + 1, event.endSample);
    activeEnds.push(end);
    kept.push(event);
    startedVoices += 1;
    peakActiveVoices = Math.max(peakActiveVoices, activeEnds.length);
  }

  return {
    events: kept,
    stats: { startedVoices, droppedVoices, stolenVoices: 0, peakActiveVoices },
  };
}

function neutralInstrument(selection: FluidSynthMidiSelection): NormalizedInstrument {
  if (selection.instrumentType === 'soundfont') {
    return {
      type: 'soundfont',
      path: 'vamp-neutral.sf2',
      program: selection.program,
      bank: selection.bank,
    };
  }
  return { type: 'gm', program: selection.program, bank: selection.bank };
}

function buildNeutralTimeline(
  request: AudioTrackRenderRequest,
  selection: FluidSynthMidiSelection,
  events: readonly TimelineNoteEvent[],
): SongTimeline {
  const sampleRate = request.sampleRate;
  const secondsPerBeat = 60 / request.bpm;
  const renderedSeconds = request.frameCount / sampleRate;
  let contentEndBeats = 0;

  const neutralEvents: TimelineNoteEvent[] = events.map((event) => {
    const startSeconds = event.startSample / sampleRate;
    const endSeconds = event.endSample / sampleRate;
    const startBeat = startSeconds / secondsPerBeat;
    const endBeat = Math.max(startBeat, endSeconds / secondsPerBeat);
    contentEndBeats = Math.max(contentEndBeats, endBeat);
    return {
      ...event,
      trackIndex: 0,
      trackId: 'sample-track',
      startBeat,
      durationBeats: endBeat - startBeat,
      endBeat,
      startSeconds,
      endSeconds,
      audible: true,
    };
  });

  const track: TimelineTrack = {
    index: 0,
    id: 'sample-track',
    name: request.track.name,
    kind: request.track.kind,
    channel: selection.channel,
    instrument: neutralInstrument(selection),
    audible: true,
    mute: false,
    solo: false,
    volume: 1,
    pan: 0,
    automation: {},
    effects: [],
    contentEndBeats,
    contentEndSeconds: contentEndBeats * secondsPerBeat,
    tailSeconds: 0,
    endSeconds: renderedSeconds,
    eventCount: neutralEvents.length,
  };

  return {
    format: 'vamp.timeline',
    formatVersion: 1,
    schemaVersion: '1.0.0',
    sampleRate,
    beatsPerBar: MIDI_END_QUARTER_BEATS,
    secondsPerBeat,
    hintSeconds: renderedSeconds,
    lastSoundSeconds: renderedSeconds,
    renderedSeconds,
    renderedSamples: request.frameCount,
    meta: {
      title: request.track.name,
      bpm: request.bpm,
      timeSignature: { numerator: 4, denominator: 4 },
      key: { tonic: 'C', mode: 'major' },
      seed: request.seed,
      durationHintBeats: renderedSeconds / secondsPerBeat,
    },
    tracks: [track],
    events: neutralEvents,
    stats: {
      trackCount: 1,
      authoredNoteCount: neutralEvents.length,
      expandedNoteCount: neutralEvents.length,
      audibleEventCount: neutralEvents.length,
    },
  };
}

/**
 * Build the neutral per-track MIDI used by the sample backend.
 *
 * This is the shared MIDI exporter, not a second encoder. The neutral timeline
 * has one track, unity volume, center pan, no automation, and no effects. Mix
 * controllers are omitted so the shared mixer is the only place track gain and
 * pan are applied. The function is exported for fast tests of program, bank,
 * channel, and voice-cap behavior without starting FluidSynth.
 */
export function prepareFluidSynthTrack(
  request: AudioTrackRenderRequest,
  selection: FluidSynthMidiSelection,
): PrepareFluidSynthTrackResult {
  const errors: AudioIssue[] = [];
  const path = `/tracks/${request.track.index}/instrument`;

  if (
    !Number.isSafeInteger(selection.program) ||
    selection.program < 0 ||
    selection.program > 127
  ) {
    errors.push(
      createAudioIssue(
        'audio.instrument.unsupported_variant',
        path,
        'The selected SoundFont program must be an integer from 0 to 127.',
        'Use a curated instrument or an explicit gm/soundfont program.',
        { program: selection.program },
      ),
    );
  }
  if (!Number.isSafeInteger(selection.bank) || selection.bank < 0 || selection.bank > 128) {
    errors.push(
      createAudioIssue(
        'audio.instrument.unsupported_variant',
        path,
        'The selected SoundFont bank must be an integer from 0 to 128.',
        'Use bank 0 for melodic presets or bank 128 for the percussion preset.',
        { bank: selection.bank },
      ),
    );
  }
  if (!isSafeIntegerInRange(selection.channel, 0, 15)) {
    errors.push(
      createAudioIssue(
        'audio.instrument.unsupported_variant',
        path,
        'The MIDI channel for the neutral sample track must be an integer from 0 to 15.',
        'Use channel 0 for melodic instruments and channel 9 for drums.',
        { channel: selection.channel },
      ),
    );
  }
  if ((request.track.kind === 'drums') !== (selection.channel === 9)) {
    errors.push(
      createAudioIssue(
        'audio.instrument.unsupported_variant',
        path,
        'Drum tracks must use MIDI channel 9 and melodic tracks must not.',
        'Use a curated drum mapping or set the song track kind correctly before rendering.',
        { trackKind: request.track.kind, channel: selection.channel },
      ),
    );
  }
  if (selection.instrumentType === 'gm' && request.track.kind === 'drums') {
    errors.push(
      createAudioIssue(
        'audio.instrument.unsupported_variant',
        path,
        'The FluidSynth backend does not render GM melodic programs on drum tracks.',
        'Use a SoundFont percussion preset with bank 128, or the drums.kit curated mapping.',
      ),
    );
  }
  if (errors.length > 0) {
    return { ok: false, errors: normalizeAudioIssues(errors) };
  }

  const plan = planVoiceCap(request.events, request.maxVoices, request.frameCount);
  const timeline = buildNeutralTimeline(request, selection, plan.events);
  const exported = exportMidi(timeline, {
    includeInaudibleTracks: false,
    endMarker: 'rendered',
    omitMixControllers: true,
  });
  if (!exported.ok) {
    return {
      ok: false,
      errors: normalizeAudioIssues(
        exported.errors.map((issue) =>
          createAudioIssue(
            'audio.backend.output_invalid',
            `/tracks/${request.track.index}`,
            `The neutral MIDI for track "${request.track.id}" could not be encoded: ${issue.message}`,
            'This is an internal backend failure. Recompile the song and report the input if it persists.',
            { midiCode: issue.code, midiPath: issue.path },
          ),
        ),
      ),
    };
  }

  return {
    ok: true,
    prepared: {
      midi: exported.bytes,
      report: exported.report,
      stats: plan.stats,
      selection,
    },
  };
}

function selectionForCurated(entry: InstrumentRegistryEntry): FluidSynthMidiSelection {
  return {
    instrumentType: entry.sampleBackend.instrumentType,
    program: entry.sampleBackend.program,
    bank: entry.sampleBackend.bank,
    channel: entry.kind === 'percussion' ? 9 : 0,
  };
}

function selectionForSong(track: TimelineTrack): FluidSynthMidiSelection | null {
  const instrument = track.instrument;
  if (instrument.type === 'gm') {
    return { instrumentType: 'gm', program: instrument.program, bank: instrument.bank, channel: 0 };
  }
  if (instrument.type === 'soundfont') {
    return {
      instrumentType: 'soundfont',
      program: instrument.program,
      bank: instrument.bank,
      channel: track.kind === 'drums' ? 9 : 0,
    };
  }
  return null;
}

/** Build the pinned FluidSynth 2.x offline command line as an argument array. */
export function buildFluidSynthArguments(options: {
  readonly wavPath: string;
  readonly sampleRate: number;
  readonly maxVoices: number;
  readonly soundFontPath: string;
  readonly midiPath: string;
}): string[] {
  return [
    '-ni',
    '-q',
    '-F',
    options.wavPath,
    '-T',
    'wav',
    '-O',
    's16',
    '-L',
    '1',
    '-r',
    String(options.sampleRate),
    '-g',
    '1.0',
    '-o',
    'synth.reverb.active=0',
    '-o',
    'synth.chorus.active=0',
    '-o',
    `synth.polyphony=${String(options.maxVoices)}`,
    options.soundFontPath,
    options.midiPath,
  ];
}

interface ProcessOutcome {
  readonly kind: 'exited' | 'missing' | 'timeout' | 'failed';
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stderrTruncated: boolean;
  readonly message?: string;
}

function baseEnvironment(tempDir: string): NodeJS.ProcessEnv {
  const parentPath = process.env.PATH ?? process.env.Path ?? '';
  const fallbackPath = ['/usr/local/bin', '/usr/bin', '/bin'].join(delimiter);
  return {
    PATH: parentPath.length > 0 ? parentPath : fallbackPath,
    HOME: tempDir,
    TMPDIR: tempDir,
    TEMP: tempDir,
    TMP: tempDir,
    XDG_CONFIG_HOME: tempDir,
    XDG_CACHE_HOME: tempDir,
    LC_ALL: 'C',
    LANG: 'C',
    ...(process.platform === 'win32'
      ? { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' }
      : {}),
  };
}

function runFluidSynth(
  binaryPath: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly timeoutMs: number;
    readonly maxStdoutBytes: number;
    readonly maxStderrBytes: number;
  },
): Promise<ProcessOutcome> {
  return new Promise((resolvePromise) => {
    let child: ChildProcess;
    try {
      child = spawn(binaryPath, [...args], {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolvePromise({
        kind: 'failed',
        code: null,
        signal: null,
        stdout: '',
        stderr: '',
        stderrTruncated: false,
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stderrTruncated = false;
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform !== 'win32' && child.pid !== undefined) {
          process.kill(-child.pid, 'SIGKILL');
        } else {
          child.kill('SIGKILL');
        }
      } catch {
        child.kill('SIGKILL');
      }
      // Destroy the captured pipes as well. A shell wrapper may leave a child
      // holding them open, and waiting for EOF would defeat the timeout.
      child.stdout?.destroy();
      child.stderr?.destroy();
    }, options.timeoutMs);

    const finish = (outcome: ProcessOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolvePromise(outcome);
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdoutBytes >= options.maxStdoutBytes) {
        return;
      }
      const remaining = options.maxStdoutBytes - stdoutBytes;
      const slice = chunk.subarray(0, Math.min(remaining, chunk.length));
      stdout += slice.toString('utf8');
      stdoutBytes += slice.length;
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrBytes >= options.maxStderrBytes) {
        stderrTruncated = true;
        return;
      }
      const remaining = options.maxStderrBytes - stderrBytes;
      if (chunk.length > remaining) {
        stderrTruncated = true;
      }
      const slice = chunk.subarray(0, Math.min(remaining, chunk.length));
      stderr += slice.toString('utf8');
      stderrBytes += slice.length;
    });

    child.once('error', (error: NodeJS.ErrnoException) => {
      const missing = error.code === 'ENOENT';
      finish({
        kind: missing ? 'missing' : 'failed',
        code: null,
        signal: null,
        stdout,
        stderr,
        stderrTruncated,
        message: error.message,
      });
    });
    child.once('close', (code, signal) => {
      finish({
        kind: timedOut ? 'timeout' : 'exited',
        code,
        signal,
        stdout,
        stderr,
        stderrTruncated,
      });
    });
  });
}

interface DecodedWav {
  readonly sampleRate: number;
  readonly channels: 1 | 2;
  readonly frames: Float32Array;
}

function decodePcm16Wav(
  bytes: Buffer,
): { ok: true; wav: DecodedWav } | { ok: false; message: string } {
  if (bytes.length < 44) {
    return { ok: false, message: `WAV is too short (${bytes.length} bytes).` };
  }
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
    return { ok: false, message: 'FluidSynth output is not a RIFF/WAVE file.' };
  }

  let format: { channels: number; sampleRate: number; bits: number; audioFormat: number } | null =
    null;
  let data: Buffer | null = null;
  let offset = 12;

  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;
    if (size > bytes.length - bodyStart) {
      return { ok: false, message: `WAV chunk "${id}" exceeds the file size.` };
    }
    if (id === 'fmt ') {
      if (size < 16) {
        return { ok: false, message: 'WAV fmt chunk is too short.' };
      }
      format = {
        audioFormat: bytes.readUInt16LE(bodyStart),
        channels: bytes.readUInt16LE(bodyStart + 2),
        sampleRate: bytes.readUInt32LE(bodyStart + 4),
        bits: bytes.readUInt16LE(bodyStart + 14),
      };
    } else if (id === 'data') {
      data = bytes.subarray(bodyStart, bodyStart + size);
    }
    offset = bodyStart + size + (size % 2);
  }

  if (format === null || data === null) {
    return { ok: false, message: 'WAV is missing its fmt or data chunk.' };
  }
  if (format.audioFormat !== 1 || format.bits !== 16) {
    return {
      ok: false,
      message: `WAV must be 16-bit integer PCM, received format ${format.audioFormat} at ${format.bits} bits.`,
    };
  }
  if (format.channels !== 1 && format.channels !== 2) {
    return { ok: false, message: `WAV must have 1 or 2 channels, received ${format.channels}.` };
  }
  if (!Number.isSafeInteger(format.sampleRate) || format.sampleRate <= 0) {
    return { ok: false, message: `WAV has an invalid sample rate ${String(format.sampleRate)}.` };
  }

  const bytesPerFrame = 2 * format.channels;
  if (data.length % bytesPerFrame !== 0) {
    return { ok: false, message: 'WAV data length is not frame aligned.' };
  }
  const frameCount = data.length / bytesPerFrame;
  const frames = new Float32Array(frameCount);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let frame = 0; frame < frameCount; frame += 1) {
    const base = frame * bytesPerFrame;
    const left = view.getInt16(base, true);
    if (format.channels === 1) {
      frames[frame] = left / 32768;
    } else {
      const right = view.getInt16(base + 2, true);
      frames[frame] = (left + right) / 65536;
    }
  }

  return {
    ok: true,
    wav: { sampleRate: format.sampleRate, channels: format.channels as 1 | 2, frames },
  };
}

function describeStderr(outcome: ProcessOutcome): string {
  const text = outcome.stderr.trim();
  if (text.length === 0) {
    return 'no stderr output';
  }
  return text.length > 2_000 ? `${text.slice(0, 2_000)}...` : text;
}

function assetIssueToAudio(
  issue: AssetValidationIssue,
  track: TimelineTrack,
  assetPath: string | null,
): AudioIssue {
  const path =
    assetPath === null
      ? `/tracks/${track.index}/instrument`
      : `/tracks/${track.index}/instrument/path`;
  return createAudioIssue(issue.code, path, issue.message, issue.hint, issue.params);
}

async function resolveFontForTrack(
  track: TimelineTrack,
  config: FluidSynthBackendConfig,
  resolved: ReturnType<typeof validateConfig>['resolved'],
): Promise<{ ok: true; asset: ResolvedAsset } | { ok: false; issues: readonly AudioIssue[] }> {
  const instrument = track.instrument;

  if (instrument.type === 'soundfont') {
    if (config.projectRoot === undefined || config.projectRoot.trim() === '') {
      return {
        ok: false,
        issues: [
          createAudioIssue(
            'audio.config.invalid',
            `/tracks/${track.index}/instrument/path`,
            'A SoundFont instrument requires a configured projectRoot so its relative asset path can be confined.',
            'Configure projectRoot when creating the FluidSynth backend, or move the file under the project and use a relative path.',
            { trackId: track.id },
          ),
        ],
      };
    }
    const result = await resolveProjectSoundFont({
      projectRoot: config.projectRoot,
      relativePath: instrument.path,
      maxBytes: resolved.maxAssetBytes,
      expectedSha256: config.assetChecksums?.[instrument.path] ?? null,
    });
    if (!result.ok) {
      return {
        ok: false,
        issues: [assetIssueToAudio(result.issue, track, instrument.path)],
      };
    }
    return { ok: true, asset: result.asset };
  }

  // Curated builtin mappings and explicit gm instruments both use the trusted
  // backend-configured GM SoundFont.
  if (config.gmSoundFont === undefined || config.gmSoundFont.trim() === '') {
    return {
      ok: false,
      issues: [
        createAudioIssue(
          'audio.asset.missing',
          `/tracks/${track.index}/instrument`,
          `The FluidSynth backend has no configured GM SoundFont for track "${track.id}".`,
          `Configure gmSoundFont with a provisioned ${FLUIDR3_GM_ASSET.fileName}, or render builtin instruments with the built-in synth backend. Vamp never downloads a SoundFont during a render.`,
          { trackId: track.id, assetId: FLUIDR3_GM_ASSET.id },
        ),
      ],
    };
  }
  const expected =
    config.verifyGmSoundFontChecksum === true ? FLUIDR3_GM_ASSET.checksum.value : null;
  const result = await validateTrustedSoundFont(config.gmSoundFont, {
    maxBytes: resolved.maxAssetBytes,
    expectedSha256: expected,
  });
  if (!result.ok) {
    return {
      ok: false,
      issues: [assetIssueToAudio(result.issue, track, null)],
    };
  }
  return { ok: true, asset: result.asset };
}

function requestErrors(request: AudioTrackRenderRequest): AudioIssue[] {
  const errors: AudioIssue[] = [];
  if (request.sampleRate !== 44100 && request.sampleRate !== 48000) {
    errors.push(
      createAudioIssue(
        'audio.options.invalid',
        '/sampleRate',
        `Unsupported sample rate ${String(request.sampleRate)}. Supported rates are 44100 and 48000.`,
        'Render at 44100 or 48000 Hz.',
      ),
    );
  }
  if (
    !Number.isSafeInteger(request.frameCount) ||
    request.frameCount < 0 ||
    request.frameCount > 600 * request.sampleRate
  ) {
    errors.push(
      createAudioIssue(
        'audio.options.invalid',
        '/frameCount',
        'frameCount must be a non-negative whole frame count within the 600 second audio bound.',
        'Render no more than 600 seconds at the chosen sample rate.',
      ),
    );
  }
  if (!isSafeIntegerInRange(request.maxVoices, 1, MAX_VOICES_PER_TRACK)) {
    errors.push(
      createAudioIssue(
        'audio.options.invalid',
        '/maxVoices',
        `maxVoices must be an integer from 1 to ${MAX_VOICES_PER_TRACK}.`,
        'Lower the per-track voice cap or omit it to use the default.',
      ),
    );
  }
  if (
    !Number.isSafeInteger(request.seed) ||
    request.seed < 0 ||
    request.seed > 4294967295 ||
    !Array.isArray(request.events)
  ) {
    errors.push(
      createAudioIssue(
        'audio.options.invalid',
        '/seed',
        'The render request has an invalid seed or event list.',
        'Pass the timeline seed and the track event list from the canonical timeline.',
      ),
    );
  }
  if (!isSafeIntegerInRange(request.bpm, MIN_BPM, MAX_BPM)) {
    errors.push(
      createAudioIssue(
        'audio.options.invalid',
        '/bpm',
        `bpm must be an integer from ${MIN_BPM} to ${MAX_BPM}.`,
        'Pass the validated song tempo with the track render request.',
      ),
    );
  }
  return errors;
}

class FluidSynthBackend implements AudioBackend {
  readonly id = FLUIDSYNTH_BACKEND_ID;
  readonly name = 'FluidSynth SoundFont backend';
  readonly description =
    'Offline FluidSynth 2.x rendering of GM and project SoundFont presets plus explicit curated mappings for the six builtin instrument IDs. SFZ is not supported.';
  readonly capabilities = FLUIDSYNTH_BACKEND_CAPABILITIES;

  private readonly config: FluidSynthBackendConfig;
  private readonly resolved: ReturnType<typeof validateConfig>['resolved'];
  private readonly configIssues: readonly AudioIssue[];

  constructor(config: FluidSynthBackendConfig) {
    this.config = config;
    const checked = validateConfig(config);
    this.resolved = checked.resolved;
    this.configIssues = checked.issues;
  }

  /**
   * Advisory version probe for render reports. It uses an argument array, a
   * sanitized environment, bounded output, and a short timeout. A missing or
   * unparsable executable returns null rather than failing a render.
   */
  async probeVersion(): Promise<string | null> {
    return probeFluidSynthVersion(
      this.resolved.binaryPath,
      this.config.environment === undefined ? {} : { environment: this.config.environment },
    );
  }

  async renderTrack(request: AudioTrackRenderRequest): Promise<AudioBackendTrackResult> {
    const track = request.track;
    const trackPath = `/tracks/${track.index}`;

    if (this.configIssues.length > 0) {
      return {
        ok: false,
        errors: normalizeAudioIssues(
          this.configIssues.map((issue) =>
            createAudioIssue(
              issue.code,
              issue.path || trackPath,
              issue.message,
              issue.hint,
              issue.params,
            ),
          ),
        ),
      };
    }

    const requestIssueList = requestErrors(request);
    if (requestIssueList.length > 0) {
      return { ok: false, errors: normalizeAudioIssues(requestIssueList) };
    }

    const instrument = track.instrument;
    let selection: FluidSynthMidiSelection;
    if (instrument.type === 'builtin') {
      const entry = getInstrumentRegistryEntry(instrument.id);
      if (entry === undefined) {
        return {
          ok: false,
          errors: normalizeAudioIssues([
            createAudioIssue(
              'audio.instrument.unknown_builtin',
              `${trackPath}/instrument/id`,
              `The ${this.id} backend does not provide builtin instrument "${instrument.id}" on track "${track.id}".`,
              `Use one of: ${this.capabilities.builtinIds.join(', ')}. The registry mapping is explicit and never substitutes another instrument.`,
              { backendId: this.id, trackId: track.id, instrumentId: instrument.id },
            ),
          ]),
        };
      }
      selection = selectionForCurated(entry);
    } else if (instrument.type === 'gm' || instrument.type === 'soundfont') {
      const mapped = selectionForSong(track);
      if (mapped === null) {
        return {
          ok: false,
          errors: normalizeAudioIssues([
            createAudioIssue(
              'audio.instrument.unsupported_variant',
              `${trackPath}/instrument`,
              `The ${this.id} backend could not map the "${instrument.type}" instrument on track "${track.id}".`,
              'Use a curated builtin ID, a gm instrument, or a project SoundFont reference.',
              { trackId: track.id, variant: instrument.type },
            ),
          ]),
        };
      }
      selection = mapped;
    } else {
      return {
        ok: false,
        errors: normalizeAudioIssues([
          createAudioIssue(
            'audio.instrument.unsupported_variant',
            `${trackPath}/instrument`,
            `The ${this.id} backend does not support "${instrument.type}" instruments on track "${track.id}".`,
            'SFZ playback requires a different sample backend, which v1 does not ship. Use .sf2, gm, or a builtin instrument. Silent substitution is not performed.',
            { backendId: this.id, variant: instrument.type, trackId: track.id },
          ),
        ]),
      };
    }

    const font = await resolveFontForTrack(track, this.config, this.resolved);
    if (!font.ok) {
      return { ok: false, errors: normalizeAudioIssues(font.issues) };
    }

    const prepared = prepareFluidSynthTrack(request, selection);
    if (!prepared.ok) {
      return { ok: false, errors: prepared.errors };
    }

    let tempDir: string;
    try {
      tempDir = await mkdtemp(join(tmpdir(), 'vamp-fluid-'));
    } catch {
      return {
        ok: false,
        errors: normalizeAudioIssues([
          createAudioIssue(
            'audio.backend.failed',
            trackPath,
            `Could not create a temporary directory for track "${track.id}".`,
            'Check the system temporary directory permissions and free space. No render was started.',
            { backendId: this.id, trackId: track.id },
          ),
        ]),
      };
    }
    const midiPath = join(tempDir, 'track.mid');
    const wavPath = join(tempDir, 'track.wav');
    try {
      await writeFile(midiPath, prepared.prepared.midi);
      const args = buildFluidSynthArguments({
        wavPath,
        sampleRate: request.sampleRate,
        maxVoices: request.maxVoices,
        soundFontPath: font.asset.absolutePath,
        midiPath,
      });
      const outcome = await runFluidSynth(this.resolved.binaryPath, args, {
        cwd: tempDir,
        env: { ...baseEnvironment(tempDir), ...this.config.environment },
        timeoutMs: this.resolved.timeoutMs,
        maxStdoutBytes: this.resolved.maxStdoutBytes,
        maxStderrBytes: this.resolved.maxStderrBytes,
      });

      if (outcome.kind === 'missing') {
        return {
          ok: false,
          errors: normalizeAudioIssues([
            createAudioIssue(
              'audio.backend.missing_dependency',
              trackPath,
              `The FluidSynth executable "${this.resolved.binaryPath}" was not found.`,
              'Install FluidSynth 2.x and pass its absolute path as binaryPath, or render with the built-in synth backend. See docs/instruments.md for platform setup.',
              { backendId: this.id, binaryPath: this.resolved.binaryPath },
            ),
          ]),
        };
      }
      if (outcome.kind === 'timeout') {
        return {
          ok: false,
          errors: normalizeAudioIssues([
            createAudioIssue(
              'audio.backend.timeout',
              trackPath,
              `FluidSynth exceeded the ${this.resolved.timeoutMs} ms timeout while rendering track "${track.id}".`,
              'Raise timeoutMs deliberately, reduce song length or voice count, or check for a hung executable. The child process was killed and temporary files were removed.',
              { backendId: this.id, trackId: track.id, timeoutMs: this.resolved.timeoutMs },
            ),
          ]),
        };
      }
      if (outcome.kind === 'failed' || outcome.code !== 0) {
        return {
          ok: false,
          errors: normalizeAudioIssues([
            createAudioIssue(
              'audio.backend.process_failed',
              trackPath,
              `FluidSynth failed with ${
                outcome.code === null ? 'no exit code' : `exit code ${String(outcome.code)}`
              }${outcome.signal === null ? '' : ` (signal ${outcome.signal})`}. ${describeStderr(outcome)}`,
              'Inspect the FluidSynth stderr excerpt and verify the SoundFont, MIDI, and installed version. Expected asset problems should have been rejected before the process started.',
              {
                backendId: this.id,
                trackId: track.id,
                exitCode: outcome.code,
                signal: outcome.signal,
                stderr: outcome.stderr.slice(0, 4_000),
                stderrTruncated: outcome.stderrTruncated,
              },
            ),
          ]),
        };
      }

      let wavInfo;
      try {
        wavInfo = await stat(wavPath);
      } catch {
        return {
          ok: false,
          errors: normalizeAudioIssues([
            createAudioIssue(
              'audio.backend.output_invalid',
              trackPath,
              `FluidSynth exited successfully but produced no WAV file for track "${track.id}".`,
              'Check the FluidSynth version and command line. The backend expects -F <file> -T wav -O s16 to work.',
              { backendId: this.id, trackId: track.id, stderr: outcome.stderr.slice(0, 4_000) },
            ),
          ]),
        };
      }

      const maxOutputBytes =
        this.config.maxOutputBytes ??
        Math.min(
          FLUIDSYNTH_MAX_OUTPUT_BYTES,
          request.frameCount * 4 + FLUIDSYNTH_OUTPUT_SLACK_BYTES,
        );
      if (wavInfo.size > maxOutputBytes) {
        return {
          ok: false,
          errors: normalizeAudioIssues([
            createAudioIssue(
              'audio.backend.output_invalid',
              trackPath,
              `FluidSynth wrote ${wavInfo.size} bytes, above the ${maxOutputBytes} byte output limit.`,
              'This usually means an unexpectedly long render. Check the MIDI end marker and raise maxOutputBytes only deliberately.',
              { backendId: this.id, trackId: track.id, bytes: wavInfo.size, maxOutputBytes },
            ),
          ]),
        };
      }

      const bytes = await readFile(wavPath);
      const decoded = decodePcm16Wav(bytes);
      if (!decoded.ok) {
        return {
          ok: false,
          errors: normalizeAudioIssues([
            createAudioIssue(
              'audio.backend.output_invalid',
              trackPath,
              `FluidSynth output for track "${track.id}" is not a usable 16-bit WAV: ${decoded.message}`,
              'Force -O s16 -T wav and verify the installed FluidSynth version. The backend does not resample or guess a format.',
              { backendId: this.id, trackId: track.id },
            ),
          ]),
        };
      }
      if (decoded.wav.sampleRate !== request.sampleRate) {
        return {
          ok: false,
          errors: normalizeAudioIssues([
            createAudioIssue(
              'audio.backend.output_invalid',
              trackPath,
              `FluidSynth rendered at ${decoded.wav.sampleRate} Hz, requested ${request.sampleRate} Hz.`,
              'Check the -r argument and the installed FluidSynth build. The backend never resamples silently.',
              {
                backendId: this.id,
                trackId: track.id,
                renderedSampleRate: decoded.wav.sampleRate,
              },
            ),
          ]),
        };
      }

      const samples = new Float32Array(request.frameCount);
      const available = Math.min(request.frameCount, decoded.wav.frames.length);
      for (let frame = 0; frame < available; frame += 1) {
        const value = decoded.wav.frames[frame] ?? 0;
        if (!Number.isFinite(value)) {
          return {
            ok: false,
            errors: normalizeAudioIssues([
              createAudioIssue(
                'audio.samples.non_finite',
                trackPath,
                `The ${this.id} backend produced a non-finite sample on track "${track.id}" at frame ${frame}.`,
                'Fix the SoundFont or backend. Non-finite audio is never written, clamped, or normalized.',
                { backendId: this.id, trackId: track.id, frame, channel: 'mono' },
              ),
            ]),
          };
        }
        samples[frame] = value;
      }

      return {
        ok: true,
        samples,
        stats: prepared.prepared.stats,
        warnings: [],
      };
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}

/** Create a FluidSynth SoundFont backend with explicit, bounded configuration. */
export function createFluidSynthBackend(config: FluidSynthBackendConfig = {}): AudioBackend {
  return new FluidSynthBackend(config);
}

/**
 * Windows executable suffixes consulted when a bare command name is resolved.
 * Mirrors the documented `PATHEXT` default so health checks match what
 * `CreateProcess` would launch. Other platforms have no extension search.
 */
const WINDOWS_DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC';

/**
 * Enumerate the concrete executable names that `binaryPath` could resolve to
 * on a given platform. On Windows, a name without an extension expands through
 * `PATHEXT` (Node's `spawn` ultimately calls `CreateProcess`, which does the
 * same matching), so a health check that only stats the bare name would report
 * a present binary as missing. POSIX platforms use the name verbatim.
 *
 * Exported for tests: callers can assert Windows semantics on any host by
 * passing `win32` and a `PATHEXT` value explicitly.
 */
export function fluidSynthExecutableCandidates(
  binaryPath: string,
  platform: NodeJS.Platform = process.platform,
  pathExt: string | undefined = process.env.PATHEXT,
): string[] {
  if (platform !== 'win32') {
    return [binaryPath];
  }
  const extensions = (pathExt ?? WINDOWS_DEFAULT_PATHEXT)
    .split(';')
    .map((extension) => extension.trim().toUpperCase())
    .filter((extension) => extension.length > 0);
  const hasKnownExtension = extensions.some((extension) =>
    binaryPath.toUpperCase().endsWith(extension),
  );
  if (hasKnownExtension) {
    return [binaryPath];
  }
  return [binaryPath, ...extensions.map((extension) => `${binaryPath}${extension}`)];
}

/** Report whether the configured executable exists, for CLI/MCP health checks. */
export async function isFluidSynthBinaryAvailable(binaryPath = 'fluidsynth'): Promise<boolean> {
  const check = async (candidate: string): Promise<boolean> => {
    try {
      const info = await stat(candidate);
      return info.isFile();
    } catch {
      return false;
    }
  };
  if (binaryPath.includes('/') || binaryPath.includes('\\')) {
    for (const candidate of fluidSynthExecutableCandidates(binaryPath)) {
      if (await check(candidate)) {
        return true;
      }
    }
    return false;
  }
  const pathValue = process.env.PATH ?? process.env.Path ?? '';
  for (const directory of pathValue.split(delimiter)) {
    if (directory.length === 0) {
      continue;
    }
    for (const candidate of fluidSynthExecutableCandidates(binaryPath)) {
      if (await check(join(directory, candidate))) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Probe the FluidSynth executable version for report metadata.
 *
 * Runs `fluidsynth --version` with an argument array (never a shell), a
 * minimal sanitized environment, a 3 second default timeout, and an 8 KiB
 * output ceiling. Any missing executable, timeout, nonzero exit, or
 * unparsable output returns null. This function never downloads, writes, or
 * throws for expected probe failures.
 */
export async function probeFluidSynthVersion(
  binaryPath = 'fluidsynth',
  options: {
    readonly timeoutMs?: number;
    /** Explicit overrides merged over the sanitized base environment. */
    readonly environment?: Readonly<Record<string, string>>;
  } = {},
): Promise<string | null> {
  const requestedTimeout = options.timeoutMs;
  const timeoutMs =
    typeof requestedTimeout === 'number' &&
    Number.isFinite(requestedTimeout) &&
    requestedTimeout >= 100 &&
    requestedTimeout <= 10_000
      ? Math.round(requestedTimeout)
      : FLUIDSYNTH_VERSION_PROBE_TIMEOUT_MS;
  const cwd = tmpdir();
  const outcome = await runFluidSynth(binaryPath, ['--version'], {
    cwd,
    env: { ...baseEnvironment(cwd), ...options.environment },
    timeoutMs,
    maxStdoutBytes: 8192,
    maxStderrBytes: 8192,
  });
  if (outcome.kind !== 'exited' || outcome.code !== 0) {
    return null;
  }
  const match = /FluidSynth\s+(?:runtime\s+)?version\s+([0-9][0-9A-Za-z.+-]*)/i.exec(
    `${outcome.stdout}\n${outcome.stderr}`,
  );
  return match?.[1] ?? null;
}
export function describeFluidSynthConfig(config: FluidSynthBackendConfig): {
  readonly binary: string;
  readonly binaryDirectory: string;
  readonly gmSoundFont: string | null;
  readonly projectRoot: string | null;
} {
  const binary = config.binaryPath ?? 'fluidsynth';
  return {
    binary,
    binaryDirectory: dirname(binary),
    gmSoundFont: config.gmSoundFont ?? null,
    projectRoot: config.projectRoot ?? null,
  };
}
