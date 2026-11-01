import type { BuiltinInstrumentId, InstrumentVariantType } from '@gxaditya/vamp-schema';

import type { TimelineNoteEvent, TimelineTrack } from '../timeline.js';
import { isSampleRate } from '../time.js';
import {
  AUDIO_VOICE_POLICY,
  BUILTIN_SYNTH_BACKEND_ID,
  DEFAULT_MAX_VOICES_PER_TRACK,
  MAX_VOICES_PER_TRACK,
  type AudioBackend,
  type AudioBackendTrackResult,
  type AudioBackendTrackStats,
  type AudioTrackRenderRequest,
} from './backend.js';
import { createAudioIssue, normalizeAudioIssues, type AudioIssue } from './errors.js';
import {
  getBuiltinDrumSpec,
  MAX_BUILTIN_DRUM_PITCH,
  MIN_BUILTIN_DRUM_PITCH,
  type BuiltinDrumVoiceSpec,
} from './drums.js';

const TAU = 2 * Math.PI;
const SINE_TABLE_SIZE = 4096;
const SINE_TABLE = new Float64Array(SINE_TABLE_SIZE + 1);

for (let index = 0; index <= SINE_TABLE_SIZE; index += 1) {
  SINE_TABLE[index] = Math.sin((TAU * index) / SINE_TABLE_SIZE);
}

/** Table-driven sine. Phase is in cycles; fractional phases are interpolated. */
function sineAt(phase: number): number {
  const wrapped = phase - Math.floor(phase);
  const position = wrapped * SINE_TABLE_SIZE;
  const index = Math.floor(position);
  const fraction = position - index;
  const current = SINE_TABLE[index] ?? 0;
  const next = SINE_TABLE[index + 1] ?? current;
  return current + (next - current) * fraction;
}

function clamp01(value: number): number {
  if (value <= 0) {
    return 0;
  }
  if (value >= 1) {
    return 1;
  }
  return value;
}

function smoothstep(value: number): number {
  const x = clamp01(value);
  return x * x * (3 - 2 * x);
}

function fraction(value: number): number {
  return value - Math.floor(value);
}

function midiFrequency(pitch: number): number {
  return 440 * 2 ** ((pitch - 69) / 12);
}

function velocityGain(velocity: number): number {
  return (velocity / 127) ** 1.3;
}

/** FNV-1a style stable string hash used only to seed noise-based voices. */
function hashIdentity(input: string): number {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Deterministic mulberry32 stream. Used only by noise-based voices. */
function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function noiseSeed(
  songSeed: number,
  trackId: string,
  event: TimelineNoteEvent,
  instrument: string,
): number {
  return hashIdentity(
    `${songSeed}:${trackId}:${event.id}:${event.pitch}:${event.startSample}:${instrument}`,
  );
}

/** Shared amplitude envelope with a click-resistant attack and release. */
class AmplitudeEnvelope {
  private age = 0;
  private level = 0;
  private decayStarted = false;
  private releasing = false;
  private releaseLevel = 0;
  private releaseAge = 0;

  private readonly attackSamples: number;
  private readonly sustain: number;
  private readonly decayCoefficient: number;
  private readonly releaseSamples: number;
  private readonly noteOffAge: number;

  constructor(
    sampleRate: number,
    template: {
      readonly attackSeconds: number;
      readonly decaySeconds: number;
      readonly sustain: number;
      readonly releaseSeconds: number;
    },
    noteOffAge: number,
  ) {
    this.attackSamples = Math.max(1, Math.round(template.attackSeconds * sampleRate));
    const decaySamples = Math.max(1, Math.round(template.decaySeconds * sampleRate));
    this.sustain = template.sustain;
    this.decayCoefficient = Math.exp(-5 / decaySamples);
    this.releaseSamples = Math.max(1, Math.round(template.releaseSeconds * sampleRate));
    this.noteOffAge = noteOffAge;
  }

  next(): number | null {
    const age = this.age;
    this.age += 1;

    let level: number;
    if (age < this.attackSamples) {
      level = smoothstep((age + 1) / this.attackSamples);
    } else {
      if (!this.decayStarted) {
        this.decayStarted = true;
        this.level = 1;
      }
      this.level = this.sustain + (this.level - this.sustain) * this.decayCoefficient;
      level = this.level;
    }

    if (age >= this.noteOffAge) {
      if (!this.releasing) {
        this.releasing = true;
        this.releaseLevel = level;
        this.releaseAge = 0;
      } else {
        this.releaseAge += 1;
      }

      if (this.releaseAge >= this.releaseSamples) {
        return null;
      }

      const releasePosition = (this.releaseAge + 1) / this.releaseSamples;
      return this.releaseLevel * (1 - smoothstep(releasePosition));
    }

    return level;
  }
}

interface PartialTemplate {
  readonly ratio: number;
  readonly gain: number;
}

interface PitchedTemplate {
  readonly partials: readonly PartialTemplate[];
  readonly detunes: readonly number[];
  readonly attackSeconds: number;
  readonly decaySeconds: number;
  readonly sustain: number;
  readonly releaseSeconds: number;
  readonly gain: number;
  readonly lfoHz?: number;
  readonly lfoDepth?: number;
}

/**
 * Builtin instrument IDs with a voice template in this backend.
 *
 * This list is intentionally local to the synthesizer instead of derived from
 * the schema seed allowlist. If Task 07 expands the schema registry, this
 * backend must not advertise or accept IDs it has no voice for; sample-backed
 * rendering belongs to the FluidSynth backend and the registry in
 * `instruments.ts`.
 */
export const BUILTIN_SYNTH_INSTRUMENT_IDS = Object.freeze([
  'bass.sub',
  'drums.kit',
  'guitar.clean',
  'keys.soft',
  'pad.warm',
  'piano.soft',
] as const satisfies readonly BuiltinInstrumentId[]);

export type BuiltinSynthInstrumentId = (typeof BUILTIN_SYNTH_INSTRUMENT_IDS)[number];

const builtinSynthInstrumentIdSet: ReadonlySet<string> = new Set(BUILTIN_SYNTH_INSTRUMENT_IDS);

function isBuiltinSynthInstrumentId(value: string): value is BuiltinSynthInstrumentId {
  return builtinSynthInstrumentIdSet.has(value);
}

const PITCHED_TEMPLATES: Readonly<
  Record<Exclude<BuiltinSynthInstrumentId, 'drums.kit' | 'guitar.clean'>, PitchedTemplate>
> = {
  'keys.soft': {
    partials: [
      { ratio: 1, gain: 1 },
      { ratio: 2, gain: 0.25 },
      { ratio: 3, gain: 0.08 },
    ],
    detunes: [-0.0015, 0.0015],
    attackSeconds: 0.006,
    decaySeconds: 0.6,
    sustain: 0.5,
    releaseSeconds: 0.25,
    gain: 0.22,
  },
  'piano.soft': {
    partials: [
      { ratio: 1, gain: 1 },
      { ratio: 1.0008, gain: 0.3 },
      { ratio: 2.001, gain: 0.4 },
      { ratio: 3.002, gain: 0.18 },
      { ratio: 4.004, gain: 0.09 },
      { ratio: 5.007, gain: 0.045 },
    ],
    detunes: [0],
    attackSeconds: 0.004,
    decaySeconds: 1.2,
    sustain: 0.3,
    releaseSeconds: 0.45,
    gain: 0.24,
  },
  'bass.sub': {
    partials: [
      { ratio: 0.5, gain: 0.5 },
      { ratio: 1, gain: 1 },
      { ratio: 2, gain: 0.22 },
      { ratio: 3, gain: 0.06 },
    ],
    detunes: [0],
    attackSeconds: 0.008,
    decaySeconds: 0.2,
    sustain: 0.8,
    releaseSeconds: 0.14,
    gain: 0.32,
  },
  'pad.warm': {
    partials: [
      { ratio: 1, gain: 1 },
      { ratio: 2, gain: 0.15 },
      { ratio: 3, gain: 0.08 },
      { ratio: 4, gain: 0.04 },
      { ratio: 5, gain: 0.025 },
    ],
    detunes: [-0.006, 0, 0.006],
    attackSeconds: 0.35,
    decaySeconds: 1,
    sustain: 0.8,
    releaseSeconds: 1.4,
    gain: 0.15,
    lfoHz: 0.17,
    lfoDepth: 0.1,
  },
};

interface PartialState {
  readonly increment: number;
  readonly gain: number;
  phase: number;
}

class PitchedVoice {
  private readonly partials: PartialState[];
  private readonly envelope: AmplitudeEnvelope;
  private readonly gain: number;
  private readonly lfoIncrement: number;
  private readonly lfoDepth: number;
  private lfoPhase: number;

  constructor(
    sampleRate: number,
    frequency: number,
    velocity: number,
    noteOffAge: number,
    pitch: number,
    template: PitchedTemplate,
  ) {
    const nyquistGuard = sampleRate * 0.45;
    const partials: PartialState[] = [];
    let totalGain = 0;

    for (const detune of template.detunes) {
      for (const [partialIndex, partial] of template.partials.entries()) {
        const partialFrequency = frequency * partial.ratio * (1 + detune);
        if (partialFrequency >= nyquistGuard) {
          continue;
        }
        totalGain += partial.gain;
        partials.push({
          increment: partialFrequency / sampleRate,
          gain: partial.gain,
          phase: fraction(pitch * 0.6180339887498949 + partialIndex * 0.137 + detune * 51.3),
        });
      }
    }

    // Normalize the oscillator sum inside the voice, not the mix. This is voice
    // design (it keeps a chord from multiplying the instrument's nominal gain by
    // its partial count) and is independent of track gain and master headroom.
    const normalization = totalGain > 0 ? 1 / totalGain : 0;
    this.partials = partials.map((partial) => ({
      increment: partial.increment,
      gain: partial.gain * normalization,
      phase: partial.phase,
    }));
    this.envelope = new AmplitudeEnvelope(sampleRate, template, noteOffAge);
    this.gain = template.gain * velocityGain(velocity);
    this.lfoDepth = template.lfoDepth ?? 0;
    this.lfoIncrement = (template.lfoHz ?? 0) / sampleRate;
    this.lfoPhase = fraction(pitch * 0.3819660112501051);
  }

  next(): number | null {
    const envelope = this.envelope.next();
    if (envelope === null) {
      return null;
    }

    let waveform = 0;
    for (const partial of this.partials) {
      partial.phase += partial.increment;
      if (partial.phase >= 1) {
        partial.phase -= 1;
      }
      waveform += partial.gain * sineAt(partial.phase);
    }

    if (this.lfoDepth > 0) {
      this.lfoPhase += this.lfoIncrement;
      if (this.lfoPhase >= 1) {
        this.lfoPhase -= 1;
      }
      const modulation = 1 - this.lfoDepth + this.lfoDepth * (0.5 + 0.5 * sineAt(this.lfoPhase));
      waveform *= modulation;
    }

    return waveform * envelope * this.gain;
  }
}

interface GuitarTemplate {
  readonly attackSeconds: number;
  readonly decaySeconds: number;
  readonly sustain: number;
  readonly releaseSeconds: number;
  readonly gain: number;
  readonly feedback: number;
}

const GUITAR_TEMPLATE: GuitarTemplate = {
  attackSeconds: 0.003,
  decaySeconds: 0.05,
  sustain: 1,
  releaseSeconds: 0.3,
  gain: 0.55,
  feedback: 0.997,
};

/**
 * Karplus-Strong plucked string. The excitation noise is seeded from the song
 * seed plus stable event identity, so the voice is reproducible but not a
 * periodic placeholder.
 */
class GuitarVoice {
  private readonly buffer: Float32Array;
  private readonly envelope: AmplitudeEnvelope;
  private readonly gain: number;
  private readonly feedback: number;
  private index = 0;
  private previous = 0;

  constructor(
    sampleRate: number,
    frequency: number,
    velocity: number,
    noteOffAge: number,
    seed: number,
  ) {
    const delaySamples = Math.max(2, Math.round(sampleRate / Math.max(frequency, 1)));
    const random = createSeededRandom(seed);
    const buffer = new Float32Array(delaySamples);
    let softened = 0;
    for (let index = 0; index < delaySamples; index += 1) {
      const noise = random() * 2 - 1;
      softened = softened + 0.5 * (noise - softened);
      buffer[index] = softened;
    }

    this.buffer = buffer;
    this.envelope = new AmplitudeEnvelope(sampleRate, GUITAR_TEMPLATE, noteOffAge);
    this.gain = GUITAR_TEMPLATE.gain * velocityGain(velocity);
    this.feedback = GUITAR_TEMPLATE.feedback;
  }

  next(): number | null {
    const envelope = this.envelope.next();
    if (envelope === null) {
      return null;
    }

    const current = this.buffer[this.index] ?? 0;
    this.buffer[this.index] = this.feedback * 0.5 * (current + this.previous);
    this.previous = current;
    this.index += 1;
    if (this.index >= this.buffer.length) {
      this.index = 0;
    }

    return current * envelope * this.gain;
  }
}

const METALLIC_RATIOS = Object.freeze([1, 1.447, 2.103, 2.771]);
const METALLIC_GAINS = Object.freeze([1, 0.65, 0.45, 0.3]);

function clapBurstEnvelope(seconds: number): number {
  if (seconds < 0.003) {
    return 1;
  }
  if (seconds < 0.009) {
    return 0.25;
  }
  if (seconds < 0.014) {
    return 0.85;
  }
  if (seconds < 0.02) {
    return 0.3;
  }
  if (seconds < 0.025) {
    return 0.7;
  }
  return 0.35;
}

/**
 * One-shot percussion voice. GM drum notes are triggers: the notated duration
 * and note-off do not gate the sound. A short internal end fade prevents a
 * click when a one-shot reaches its bounded duration.
 */
class DrumVoice {
  private readonly sampleRate: number;
  private readonly durationSamples: number;
  private readonly endFadeSamples: number;
  private readonly attackSamples: number;
  private readonly decayCoefficient: number;
  private readonly amplitude: number;
  private readonly random: () => number;

  private readonly baseHz: number;
  private readonly endHz: number;
  private readonly pitchDropCoefficient: number;
  private readonly toneIncrementScale: number;
  private readonly toneLevel: number;
  private readonly noiseLevel: number;
  private readonly noiseMode: 'lowpass' | 'highpass';
  private readonly noiseCoefficient: number;
  private readonly metallicLevel: number;
  private readonly metallicBaseIncrement: number;
  private readonly metallicGainScale: number;
  private readonly clickLevel: number;
  private readonly clickIncrement: number;
  private readonly clickDecay: number;
  private readonly clapBursts: boolean;

  private age = 0;
  private tonePhase = 0;
  private toneEnvelope = 1;
  private pitchEnvelope = 1;
  private noiseLowpass = 0;
  private metallicPhases: number[] = [];
  private clickPhase = 0;
  private clickEnvelope = 1;

  constructor(spec: BuiltinDrumVoiceSpec, sampleRate: number, velocity: number, seed: number) {
    this.sampleRate = sampleRate;
    this.durationSamples = Math.max(1, Math.round(spec.durationSeconds * sampleRate));
    this.endFadeSamples = Math.min(
      Math.round(0.005 * sampleRate),
      Math.max(1, Math.floor(this.durationSamples / 4)),
    );
    this.attackSamples = Math.max(1, Math.round(spec.attackSeconds * sampleRate));
    this.decayCoefficient = Math.exp(-1 / Math.max(1, spec.decayTauSeconds * sampleRate));
    this.amplitude = spec.gain * velocityGain(velocity);
    this.random = createSeededRandom(seed);

    this.baseHz = spec.baseHz;
    this.endHz = spec.endHz;
    this.pitchDropCoefficient = Math.exp(-1 / Math.max(1, spec.pitchDropTauSeconds * sampleRate));
    this.toneIncrementScale = 1 / sampleRate;
    this.toneLevel = spec.toneLevel;
    this.noiseLevel = spec.noiseLevel;
    this.noiseMode = spec.noiseMode;
    this.noiseCoefficient = Math.min(1, 1 - Math.exp((-TAU * spec.noiseCutoffHz) / sampleRate));
    this.metallicLevel = spec.metallicLevel;
    this.metallicBaseIncrement = spec.metallicBaseHz / sampleRate;
    this.metallicGainScale = 1 / METALLIC_GAINS.reduce((sum, gain) => sum + gain, 0);
    this.clickLevel = spec.clickLevel;
    this.clickIncrement = 2800 / sampleRate;
    this.clickDecay = Math.exp(-1 / Math.max(1, 0.002 * sampleRate));
    this.clapBursts = spec.clapBursts;

    this.metallicPhases = [];
    for (let index = 0; index < METALLIC_RATIOS.length; index += 1) {
      if ((METALLIC_RATIOS[index] ?? 0) * spec.metallicBaseHz < sampleRate * 0.45) {
        this.metallicPhases.push(fraction(index * 0.193));
      } else {
        this.metallicPhases.push(Number.NaN);
      }
    }
  }

  next(): number | null {
    if (this.age >= this.durationSamples) {
      return null;
    }

    let envelope: number;
    if (this.age < this.attackSamples) {
      envelope = smoothstep((this.age + 1) / this.attackSamples);
      this.toneEnvelope = 1;
    } else {
      this.toneEnvelope *= this.decayCoefficient;
      envelope = this.toneEnvelope;
    }

    if (this.toneEnvelope < 1e-4 && this.age > this.attackSamples) {
      return null;
    }

    const seconds = this.age / this.sampleRate;
    let voice = 0;

    if (this.toneLevel > 0) {
      const frequency = this.endHz + (this.baseHz - this.endHz) * this.pitchEnvelope;
      this.pitchEnvelope *= this.pitchDropCoefficient;
      this.tonePhase += frequency * this.toneIncrementScale;
      if (this.tonePhase >= 1) {
        this.tonePhase -= Math.floor(this.tonePhase);
      }
      voice += this.toneLevel * sineAt(this.tonePhase);
    }

    if (this.noiseLevel > 0) {
      const noise = this.random() * 2 - 1;
      this.noiseLowpass += this.noiseCoefficient * (noise - this.noiseLowpass);
      const shaped = this.noiseMode === 'highpass' ? noise - this.noiseLowpass : this.noiseLowpass;
      let noiseEnvelope = 1;
      if (this.clapBursts) {
        noiseEnvelope = clapBurstEnvelope(seconds);
      }
      voice += this.noiseLevel * shaped * noiseEnvelope;
    }

    if (this.metallicLevel > 0) {
      let metallic = 0;
      for (let index = 0; index < METALLIC_RATIOS.length; index += 1) {
        const phase = this.metallicPhases[index];
        if (phase === undefined || Number.isNaN(phase)) {
          continue;
        }
        const nextPhase = phase + this.metallicBaseIncrement * (METALLIC_RATIOS[index] ?? 1);
        this.metallicPhases[index] = nextPhase >= 1 ? nextPhase - 1 : nextPhase;
        metallic += (METALLIC_GAINS[index] ?? 0) * sineAt(nextPhase);
      }
      voice += this.metallicLevel * metallic * this.metallicGainScale;
    }

    if (this.clickLevel > 0) {
      this.clickPhase += this.clickIncrement;
      if (this.clickPhase >= 1) {
        this.clickPhase -= 1;
      }
      this.clickEnvelope *= this.clickDecay;
      if (this.clickEnvelope > 1e-4) {
        voice += this.clickLevel * sineAt(this.clickPhase) * this.clickEnvelope;
      }
    }

    const fadeStart = this.durationSamples - this.endFadeSamples;
    if (this.age >= fadeStart && this.endFadeSamples > 0) {
      envelope *= 1 - smoothstep((this.age - fadeStart) / this.endFadeSamples);
    }

    this.age += 1;
    return voice * envelope * this.amplitude;
  }
}

type BuiltinVoice = { next(): number | null };

function createVoiceForEvent(
  instrument: BuiltinSynthInstrumentId,
  request: AudioTrackRenderRequest,
  event: TimelineNoteEvent,
): BuiltinVoice {
  if (instrument === 'drums.kit') {
    const spec = getBuiltinDrumSpec(event.pitch);
    if (spec === undefined) {
      throw new Error(`Unmapped drum pitch ${event.pitch}`);
    }
    return new DrumVoice(
      spec,
      request.sampleRate,
      event.velocity,
      noiseSeed(request.seed, request.track.id, event, instrument),
    );
  }

  if (instrument === 'guitar.clean') {
    return new GuitarVoice(
      request.sampleRate,
      midiFrequency(event.pitch),
      event.velocity,
      Math.max(0, event.endSample - event.startSample),
      noiseSeed(request.seed, request.track.id, event, instrument),
    );
  }

  const template = PITCHED_TEMPLATES[instrument];
  return new PitchedVoice(
    request.sampleRate,
    midiFrequency(event.pitch),
    event.velocity,
    Math.max(0, event.endSample - event.startSample),
    event.pitch,
    template,
  );
}

function invalidRequest(message: string, hint: string, path: string): AudioBackendTrackResult {
  return {
    ok: false,
    errors: normalizeAudioIssues([createAudioIssue('audio.options.invalid', path, message, hint)]),
  };
}

function aggregateDrumPitchError(
  track: TimelineTrack,
  events: readonly TimelineNoteEvent[],
): AudioIssue | null {
  let invalidCount = 0;
  let firstPitch: number | null = null;
  let firstEventId: string | null = null;

  for (const event of events) {
    if (getBuiltinDrumSpec(event.pitch) === undefined) {
      invalidCount += 1;
      if (firstPitch === null) {
        firstPitch = event.pitch;
        firstEventId = event.id;
      }
    }
  }

  if (firstPitch === null) {
    return null;
  }

  return createAudioIssue(
    'audio.drums.pitch_unsupported',
    `/tracks/${track.index}`,
    `The drums.kit voice received pitch ${firstPitch}, outside the GM percussion range ${MIN_BUILTIN_DRUM_PITCH} to ${MAX_BUILTIN_DRUM_PITCH}${
      invalidCount > 1 ? ` (${invalidCount} events affected)` : ''
    }.`,
    `Use a GM percussion pitch between ${MIN_BUILTIN_DRUM_PITCH} and ${MAX_BUILTIN_DRUM_PITCH}, or choose a pitched builtin instrument for melodic content. The kit does not transpose or substitute an unmapped key.`,
    { trackId: track.id, pitch: firstPitch, eventId: firstEventId, count: invalidCount },
  );
}

/** Built-in backend capabilities for schema capability checks and diagnostics. */
export const BUILTIN_SYNTH_BACKEND_CAPABILITIES = Object.freeze({
  instrumentTypes: ['builtin'] as readonly InstrumentVariantType[],
  builtinIds: [...BUILTIN_SYNTH_INSTRUMENT_IDS],
  voicePolicy: AUDIO_VOICE_POLICY,
});

class BuiltinSynthBackend implements AudioBackend {
  readonly id = BUILTIN_SYNTH_BACKEND_ID;
  readonly name = 'Vamp built-in synthesizer';
  readonly description =
    'Deterministic offline additive, subtractive, plucked-string, and percussion synthesis for the six v1 builtin instrument IDs.';
  readonly capabilities = BUILTIN_SYNTH_BACKEND_CAPABILITIES;

  async renderTrack(request: AudioTrackRenderRequest): Promise<AudioBackendTrackResult> {
    const track = request.track;

    if (!isSampleRate(request.sampleRate)) {
      return invalidRequest(
        `Unsupported sample rate ${String(request.sampleRate)}. Supported rates are 44100 and 48000.`,
        'Render at 44100 or 48000 Hz.',
        '/sampleRate',
      );
    }
    if (
      !Number.isSafeInteger(request.frameCount) ||
      request.frameCount < 0 ||
      request.frameCount > 600 * request.sampleRate
    ) {
      return invalidRequest(
        'frameCount must be a non-negative whole frame count within the 600 second audio bound.',
        'Render no more than 600 seconds at the chosen sample rate.',
        '/frameCount',
      );
    }
    if (
      !Number.isInteger(request.maxVoices) ||
      request.maxVoices < 1 ||
      request.maxVoices > MAX_VOICES_PER_TRACK
    ) {
      return invalidRequest(
        `maxVoices must be an integer from 1 to ${MAX_VOICES_PER_TRACK}.`,
        'Lower the per-track voice cap or omit it to use the default.',
        '/maxVoices',
      );
    }
    if (
      !Number.isInteger(request.seed) ||
      request.seed < 0 ||
      request.seed > 4294967295 ||
      !Array.isArray(request.events)
    ) {
      return invalidRequest(
        'The render request has an invalid seed or event list.',
        'Pass the timeline seed and the track event list from the canonical timeline.',
        '/seed',
      );
    }

    const instrument = track.instrument;
    if (instrument.type !== 'builtin') {
      return {
        ok: false,
        errors: normalizeAudioIssues([
          createAudioIssue(
            'audio.instrument.unsupported_variant',
            `/tracks/${track.index}/instrument`,
            `The ${this.id} backend has no sample playback engine and cannot render the "${instrument.type}" instrument on track "${track.id}".`,
            'Use a builtin instrument, or pass the FluidSynth sample backend through AudioRenderOptions.backend for gm and soundfont instruments. SFZ is not supported by the v1 sample backend. Silent substitution is not performed.',
            { backendId: this.id, variant: instrument.type, trackId: track.id },
          ),
        ]),
      };
    }

    const builtinId = instrument.id;
    if (!isBuiltinSynthInstrumentId(builtinId)) {
      return {
        ok: false,
        errors: normalizeAudioIssues([
          createAudioIssue(
            'audio.instrument.unknown_builtin',
            `/tracks/${track.index}/instrument/id`,
            `The ${this.id} backend does not provide builtin instrument "${builtinId}" on track "${track.id}".`,
            `Use one of: ${BUILTIN_SYNTH_INSTRUMENT_IDS.join(', ')}. Additional builtin mappings belong to the Task 07 sample-library registry, and this backend never substitutes another instrument.`,
            { backendId: this.id, trackId: track.id, instrumentId: builtinId },
          ),
        ]),
      };
    }

    const drumError =
      builtinId === 'drums.kit' ? aggregateDrumPitchError(track, request.events) : null;
    if (drumError !== null) {
      return { ok: false, errors: normalizeAudioIssues([drumError]) };
    }

    let previousStartSample = -1;
    for (const event of request.events) {
      if (
        !Number.isSafeInteger(event.startSample) ||
        !Number.isSafeInteger(event.endSample) ||
        event.startSample < 0 ||
        event.endSample < event.startSample ||
        event.startSample < previousStartSample
      ) {
        return {
          ok: false,
          errors: normalizeAudioIssues([
            createAudioIssue(
              'audio.timeline.invalid',
              `/tracks/${track.index}`,
              `Track "${track.id}" contains an event with invalid or unsorted sample positions.`,
              'Render a canonical timeline from compileSong or compileValidatedSong.',
              { trackId: track.id, eventId: typeof event.id === 'string' ? event.id : null },
            ),
          ]),
        };
      }
      previousStartSample = event.startSample;
    }

    const frameCount = request.frameCount;
    const samples = new Float32Array(frameCount);
    const active: BuiltinVoice[] = [];
    const stats = {
      startedVoices: 0,
      droppedVoices: 0,
      stolenVoices: 0,
      peakActiveVoices: 0,
    } satisfies AudioBackendTrackStats;

    let eventIndex = 0;
    for (let frame = 0; frame < frameCount; frame += 1) {
      while (eventIndex < request.events.length) {
        const event = request.events[eventIndex];
        if (event === undefined || event.startSample > frame) {
          break;
        }
        eventIndex += 1;

        if (
          !event.audible ||
          event.startSample >= frameCount ||
          event.endSample <= event.startSample
        ) {
          continue;
        }

        if (active.length >= request.maxVoices) {
          stats.droppedVoices += 1;
          continue;
        }

        active.push(createVoiceForEvent(builtinId, request, event));
        stats.startedVoices += 1;
      }

      if (active.length > stats.peakActiveVoices) {
        stats.peakActiveVoices = active.length;
      }

      let mixed = 0;
      for (let index = active.length - 1; index >= 0; index -= 1) {
        const voice = active[index];
        if (voice === undefined) {
          continue;
        }
        const value = voice.next();
        if (value === null) {
          active.splice(index, 1);
        } else {
          mixed += value;
        }
      }

      if (!Number.isFinite(mixed)) {
        return {
          ok: false,
          errors: normalizeAudioIssues([
            createAudioIssue(
              'audio.samples.non_finite',
              `/tracks/${track.index}`,
              `The ${this.id} backend produced a non-finite sample on track "${track.id}" at frame ${frame}.`,
              'Fix the voice parameters or backend. Non-finite audio is never written or clamped.',
              { backendId: this.id, trackId: track.id, frame, channel: 'mono' },
            ),
          ]),
        };
      }

      samples[frame] = mixed;
    }

    return {
      ok: true,
      samples,
      stats,
      warnings: [],
    };
  }
}

/**
 * Create the deterministic built-in synthesizer backend.
 *
 * The backend is stateless across calls, but a factory keeps the door open for
 * per-backend options in later tasks without changing the public type.
 */
export function createBuiltinSynthBackend(): AudioBackend {
  return new BuiltinSynthBackend();
}

/** Voice policy and cap surfaced in render stats. */
export const BUILTIN_SYNTH_VOICE_POLICY = Object.freeze({
  policy: AUDIO_VOICE_POLICY,
  maxVoices: DEFAULT_MAX_VOICES_PER_TRACK,
});
