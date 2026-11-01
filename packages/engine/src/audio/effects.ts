import type { NormalizedEffect } from '@gxaditya/vamp-schema';

import type { SampleRate } from '../time.js';
import type { AutomationCurve } from './automation.js';

/** Effect discriminators accepted by SongSchemaV1, in schema order. */
export const EFFECT_TYPES = Object.freeze(['reverb', 'delay', 'eq', 'lowpass'] as const);

export type EffectType = (typeof EFFECT_TYPES)[number];

/** Hard schema bound on effects per track. */
export const MAX_EFFECTS_PER_TRACK = 8;

/** Hard schema bound on low-pass effects per track. */
export const MAX_LOWPASS_PER_TRACK = 1;

/**
 * Control block used when an automated low-pass updates its coefficients.
 *
 * Coefficients are linearly interpolated from the previous block to the new
 * block across these samples, so the filter response never steps at a block
 * boundary. 32 samples is about 0.67 ms at 48 kHz.
 */
export const LOWPASS_CONTROL_BLOCK_SIZE = 32;

/** One-pole smoothing time for automated cutoff values. */
export const LOWPASS_CUTOFF_SMOOTHING_SECONDS = 0.005;

/** Cutoff is clamped below Nyquist so normalized biquad coefficients stay stable. */
export const LOWPASS_NYQUIST_RATIO = 0.45;

export interface EffectParameterRange {
  readonly minimum: number;
  readonly maximum: number;
}

function range(minimum: number, maximum: number): EffectParameterRange {
  return Object.freeze({ minimum, maximum });
}

/**
 * Documented parameter ranges from the schema guide. Rendering validates a
 * timeline against these before creating any effect processor.
 */
export const EFFECT_PARAMETER_RANGES = Object.freeze({
  reverb: Object.freeze({
    mix: range(0, 1),
    decaySeconds: range(0.2, 10),
  }),
  delay: Object.freeze({
    timeMs: range(10, 2000),
    feedback: range(0, 0.9),
    mix: range(0, 1),
  }),
  eq: Object.freeze({
    lowGainDb: range(-18, 18),
    midGainDb: range(-18, 18),
    highGainDb: range(-18, 18),
  }),
  lowpass: Object.freeze({
    cutoffHz: range(20, 20000),
    q: range(0.1, 10),
  }),
});

/**
 * Low-level effect chain options.
 *
 * `cutoffAutomation` is the track's `filterCutoffHz` curve. It applies to the
 * single authored low-pass effect, whose static `cutoffHz` is absent while the
 * curve exists. A flat curve is evaluated once and installed as a static
 * cutoff.
 */
export interface EffectChainOptions {
  readonly sampleRate: SampleRate;
  readonly frameCount: number;
  readonly cutoffAutomation?: AutomationCurve | null;
}

interface BiquadCoefficients {
  readonly b0: number;
  readonly b1: number;
  readonly b2: number;
  readonly a1: number;
  readonly a2: number;
}

interface MutableBiquadCoefficients {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (value < minimum) {
    return minimum;
  }
  if (value > maximum) {
    return maximum;
  }
  return value;
}

function flushDenormal(value: number): number {
  return Math.abs(value) < 1e-30 ? 0 : value;
}

function maximumCutoff(sampleRate: number): number {
  return Math.min(20000, sampleRate * LOWPASS_NYQUIST_RATIO);
}

function clampCutoff(cutoffHz: number, sampleRate: number): number {
  return clamp(cutoffHz, 20, maximumCutoff(sampleRate));
}

function normalizeCoefficients(
  b0: number,
  b1: number,
  b2: number,
  a0: number,
  a1: number,
  a2: number,
): BiquadCoefficients {
  const inverse = 1 / a0;
  return {
    b0: b0 * inverse,
    b1: b1 * inverse,
    b2: b2 * inverse,
    a1: a1 * inverse,
    a2: a2 * inverse,
  };
}

function writeLowpassCoefficients(
  target: MutableBiquadCoefficients,
  cutoffHz: number,
  q: number,
  sampleRate: number,
): void {
  const frequency = clampCutoff(cutoffHz, sampleRate);
  const quality = clamp(q, 0.1, 10);
  const w0 = (2 * Math.PI * frequency) / sampleRate;
  const cosw0 = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * quality);
  const a0 = 1 + alpha;
  const inverse = 1 / a0;
  target.b0 = ((1 - cosw0) / 2) * inverse;
  target.b1 = (1 - cosw0) * inverse;
  target.b2 = ((1 - cosw0) / 2) * inverse;
  target.a1 = -2 * cosw0 * inverse;
  target.a2 = (1 - alpha) * inverse;
}

function lowpassCoefficients(cutoffHz: number, q: number, sampleRate: number): BiquadCoefficients {
  const coefficients: MutableBiquadCoefficients = { b0: 0, b1: 0, b2: 0, a1: 0, a2: 0 };
  writeLowpassCoefficients(coefficients, cutoffHz, q, sampleRate);
  return coefficients;
}

function lowShelfCoefficients(
  gainDb: number,
  sampleRate: number,
  frequency = 250,
): BiquadCoefficients {
  const gain = clamp(gainDb, -18, 18);
  const a = 10 ** (gain / 40);
  const root = Math.sqrt(a);
  const w0 = (2 * Math.PI * frequency) / sampleRate;
  const cosw0 = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
  return normalizeCoefficients(
    a * (a + 1 - (a - 1) * cosw0 + 2 * root * alpha),
    2 * a * (a - 1 - (a + 1) * cosw0),
    a * (a + 1 - (a - 1) * cosw0 - 2 * root * alpha),
    a + 1 + (a - 1) * cosw0 + 2 * root * alpha,
    -2 * (a - 1 + (a + 1) * cosw0),
    a + 1 + (a - 1) * cosw0 - 2 * root * alpha,
  );
}

function highShelfCoefficients(
  gainDb: number,
  sampleRate: number,
  frequency = 4000,
): BiquadCoefficients {
  const gain = clamp(gainDb, -18, 18);
  const a = 10 ** (gain / 40);
  const root = Math.sqrt(a);
  const w0 = (2 * Math.PI * frequency) / sampleRate;
  const cosw0 = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
  return normalizeCoefficients(
    a * (a + 1 + (a - 1) * cosw0 + 2 * root * alpha),
    -2 * a * (a - 1 + (a + 1) * cosw0),
    a * (a + 1 + (a - 1) * cosw0 - 2 * root * alpha),
    a + 1 - (a - 1) * cosw0 + 2 * root * alpha,
    2 * (a - 1 - (a + 1) * cosw0),
    a + 1 - (a - 1) * cosw0 - 2 * root * alpha,
  );
}

function peakingCoefficients(
  gainDb: number,
  sampleRate: number,
  frequency = 1000,
  q = 1,
): BiquadCoefficients {
  const gain = clamp(gainDb, -18, 18);
  const a = 10 ** (gain / 40);
  const w0 = (2 * Math.PI * frequency) / sampleRate;
  const cosw0 = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  return normalizeCoefficients(
    1 + alpha * a,
    -2 * cosw0,
    1 - alpha * a,
    1 + alpha / a,
    -2 * cosw0,
    1 - alpha / a,
  );
}

/**
 * Direct-form I biquad state in double precision. Two independent instances
 * are used per effect, one for each stereo channel, so a panned track keeps its
 * stereo position through the chain.
 */
class BiquadState {
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  process(input: number, coefficients: BiquadCoefficients): number {
    return this.processValues(
      input,
      coefficients.b0,
      coefficients.b1,
      coefficients.b2,
      coefficients.a1,
      coefficients.a2,
    );
  }

  /** Process one sample with explicit coefficients, for interpolated filters. */
  processValues(input: number, b0: number, b1: number, b2: number, a1: number, a2: number): number {
    const output = b0 * input + b1 * this.x1 + b2 * this.x2 - a1 * this.y1 - a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = input;
    this.y2 = this.y1;
    this.y1 = output;
    return output;
  }

  flush(): void {
    if (Math.abs(this.x1) < 1e-30) {
      this.x1 = 0;
    }
    if (Math.abs(this.x2) < 1e-30) {
      this.x2 = 0;
    }
    if (Math.abs(this.y1) < 1e-30) {
      this.y1 = 0;
    }
    if (Math.abs(this.y2) < 1e-30) {
      this.y2 = 0;
    }
  }
}

class DelayProcessor {
  private readonly leftBuffer: Float32Array;
  private readonly rightBuffer: Float32Array;
  private readonly feedback: number;
  private readonly mix: number;
  private index = 0;

  constructor(timeMs: number, feedback: number, mix: number, sampleRate: number) {
    const frames = Math.max(1, Math.round((clamp(timeMs, 10, 2000) / 1000) * sampleRate));
    this.leftBuffer = new Float32Array(frames);
    this.rightBuffer = new Float32Array(frames);
    this.feedback = clamp(feedback, 0, 0.9);
    this.mix = clamp(mix, 0, 1);
  }

  process(left: Float32Array, right: Float32Array, frameCount: number): void {
    const dryGain = 1 - this.mix;
    const mix = this.mix;
    const feedback = this.feedback;
    const leftBuffer = this.leftBuffer;
    const rightBuffer = this.rightBuffer;
    const length = leftBuffer.length;
    let index = this.index;

    for (let frame = 0; frame < frameCount; frame += 1) {
      const dryLeft = left[frame] ?? 0;
      const dryRight = right[frame] ?? 0;
      const delayedLeft = leftBuffer[index] ?? 0;
      const delayedRight = rightBuffer[index] ?? 0;

      leftBuffer[index] = flushDenormal(dryLeft + delayedLeft * feedback);
      rightBuffer[index] = flushDenormal(dryRight + delayedRight * feedback);
      left[frame] = dryLeft * dryGain + delayedLeft * mix;
      right[frame] = dryRight * dryGain + delayedRight * mix;

      index += 1;
      if (index >= length) {
        index = 0;
      }
    }

    this.index = index;
  }
}

class CombFilter {
  private readonly buffer: Float32Array;
  private readonly feedback: number;
  private readonly inputGain: number;
  private index = 0;

  constructor(length: number, feedback: number) {
    this.buffer = new Float32Array(Math.max(1, length));
    this.feedback = feedback;
    this.inputGain = 1 - feedback;
  }

  process(input: number): number {
    const delayed = this.buffer[this.index] ?? 0;
    this.buffer[this.index] = flushDenormal(input * this.inputGain + delayed * this.feedback);
    this.index += 1;
    if (this.index >= this.buffer.length) {
      this.index = 0;
    }
    return delayed;
  }
}

class AllpassFilter {
  private readonly buffer: Float32Array;
  private readonly feedback = 0.5;
  private index = 0;

  constructor(length: number) {
    this.buffer = new Float32Array(Math.max(1, length));
  }

  process(input: number): number {
    const delayed = this.buffer[this.index] ?? 0;
    const output = delayed - this.feedback * input;
    this.buffer[this.index] = flushDenormal(input + this.feedback * output);
    this.index += 1;
    if (this.index >= this.buffer.length) {
      this.index = 0;
    }
    return output;
  }
}

const COMB_TUNING_44_1 = Object.freeze([1116, 1188, 1277, 1356]);
const ALLPASS_TUNING_44_1 = Object.freeze([556, 441]);

function scaleTuning(tuning: number, sampleRate: number): number {
  return Math.max(1, Math.round((tuning * sampleRate) / 44100));
}

function combDecayGain(delaySamples: number, decaySeconds: number, sampleRate: number): number {
  const decay = clamp(decaySeconds, 0.2, 10);
  const gain = 10 ** ((-3 * delaySamples) / (decay * sampleRate));
  return Math.min(0.995, Math.max(0, gain));
}

/**
 * One channel of a deterministic Schroeder reverb.
 *
 * Four parallel feedback combs create the decay. Each comb's input is scaled by
 * `1 - feedback`, so its DC gain is unity and a very long decay cannot build an
 * unbounded wet level. Two series allpasses diffuse the result. The comb
 * feedback is chosen so the response is 60 dB down after `decaySeconds`.
 */
class ReverbChannel {
  private readonly combs: CombFilter[];
  private readonly allpasses: AllpassFilter[];

  constructor(sampleRate: number, decaySeconds: number) {
    this.combs = COMB_TUNING_44_1.map((tuning) => {
      const length = scaleTuning(tuning, sampleRate);
      return new CombFilter(length, combDecayGain(length, decaySeconds, sampleRate));
    });
    this.allpasses = ALLPASS_TUNING_44_1.map(
      (tuning) => new AllpassFilter(scaleTuning(tuning, sampleRate)),
    );
  }

  process(input: number): number {
    let wet = 0;
    const combs = this.combs;
    for (let index = 0; index < combs.length; index += 1) {
      const comb = combs[index];
      if (comb !== undefined) {
        wet += comb.process(input);
      }
    }
    wet *= 1 / combs.length;
    const allpasses = this.allpasses;
    for (let index = 0; index < allpasses.length; index += 1) {
      const allpass = allpasses[index];
      if (allpass !== undefined) {
        wet = allpass.process(wet);
      }
    }
    return wet;
  }
}

class ReverbProcessor {
  private readonly left: ReverbChannel;
  private readonly right: ReverbChannel;
  private readonly mix: number;

  constructor(sampleRate: number, decaySeconds: number, mix: number) {
    this.left = new ReverbChannel(sampleRate, decaySeconds);
    this.right = new ReverbChannel(sampleRate, decaySeconds);
    this.mix = clamp(mix, 0, 1);
  }

  process(left: Float32Array, right: Float32Array, frameCount: number): void {
    const dryGain = 1 - this.mix;
    const mix = this.mix;
    for (let frame = 0; frame < frameCount; frame += 1) {
      const dryLeft = left[frame] ?? 0;
      const dryRight = right[frame] ?? 0;
      const wetLeft = this.left.process(dryLeft);
      const wetRight = this.right.process(dryRight);
      left[frame] = dryLeft * dryGain + wetLeft * mix;
      right[frame] = dryRight * dryGain + wetRight * mix;
    }
  }
}

interface EqBand {
  readonly coefficients: BiquadCoefficients;
  readonly leftState: BiquadState;
  readonly rightState: BiquadState;
}

class EqProcessor {
  private readonly bands: EqBand[];

  constructor(lowGainDb: number, midGainDb: number, highGainDb: number, sampleRate: number) {
    const bands: EqBand[] = [];
    if (lowGainDb !== 0) {
      bands.push({
        coefficients: lowShelfCoefficients(lowGainDb, sampleRate),
        leftState: new BiquadState(),
        rightState: new BiquadState(),
      });
    }
    if (midGainDb !== 0) {
      bands.push({
        coefficients: peakingCoefficients(midGainDb, sampleRate),
        leftState: new BiquadState(),
        rightState: new BiquadState(),
      });
    }
    if (highGainDb !== 0) {
      bands.push({
        coefficients: highShelfCoefficients(highGainDb, sampleRate),
        leftState: new BiquadState(),
        rightState: new BiquadState(),
      });
    }
    this.bands = bands;
  }

  process(left: Float32Array, right: Float32Array, frameCount: number): void {
    for (const band of this.bands) {
      const coefficients = band.coefficients;
      for (let frame = 0; frame < frameCount; frame += 1) {
        left[frame] = band.leftState.process(left[frame] ?? 0, coefficients);
        right[frame] = band.rightState.process(right[frame] ?? 0, coefficients);
      }
      band.leftState.flush();
      band.rightState.flush();
    }
  }
}

class StaticLowpassProcessor {
  private readonly coefficients: BiquadCoefficients;
  private readonly leftState = new BiquadState();
  private readonly rightState = new BiquadState();

  constructor(cutoffHz: number, q: number, sampleRate: number) {
    this.coefficients = lowpassCoefficients(cutoffHz, q, sampleRate);
  }

  process(left: Float32Array, right: Float32Array, frameCount: number): void {
    const coefficients = this.coefficients;
    for (let frame = 0; frame < frameCount; frame += 1) {
      left[frame] = this.leftState.process(left[frame] ?? 0, coefficients);
      right[frame] = this.rightState.process(right[frame] ?? 0, coefficients);
    }
    this.leftState.flush();
    this.rightState.flush();
  }
}

/**
 * Automated second-order low-pass.
 *
 * The cutoff target is sampled once per control block, smoothed with a one-pole
 * short of 5 ms, and converted to biquad coefficients. Coefficients are then
 * linearly interpolated across the block, which keeps the filter response
 * continuous and avoids block-rate zipper artifacts. Cutoff is clamped to
 * 20 Hz through `min(20000, 0.45 * sampleRate)` at every update.
 */
class AutomatedLowpassProcessor {
  private readonly leftState = new BiquadState();
  private readonly rightState = new BiquadState();
  private readonly q: number;
  private readonly sampleRate: number;
  private readonly smoothing: number;
  private readonly curve: AutomationCurve;
  private readonly previous: MutableBiquadCoefficients = { b0: 0, b1: 0, b2: 0, a1: 0, a2: 0 };
  private readonly target: MutableBiquadCoefficients = { b0: 0, b1: 0, b2: 0, a1: 0, a2: 0 };
  private smoothedCutoff: number;

  constructor(curve: AutomationCurve, q: number, sampleRate: number) {
    this.q = clamp(q, 0.1, 10);
    this.sampleRate = sampleRate;
    this.curve = curve;
    const initialCutoff = clampCutoff(curve.valueAtFrame(0), sampleRate);
    this.smoothedCutoff = initialCutoff;
    writeLowpassCoefficients(this.previous, initialCutoff, this.q, sampleRate);
    this.smoothing =
      1 - Math.exp(-LOWPASS_CONTROL_BLOCK_SIZE / (LOWPASS_CUTOFF_SMOOTHING_SECONDS * sampleRate));
  }

  process(left: Float32Array, right: Float32Array, frameCount: number): void {
    let frame = 0;
    while (frame < frameCount) {
      this.processBlock(
        left,
        right,
        frame,
        Math.min(frameCount, frame + LOWPASS_CONTROL_BLOCK_SIZE),
      );
      frame += LOWPASS_CONTROL_BLOCK_SIZE;
    }
    this.leftState.flush();
    this.rightState.flush();
  }

  private processBlock(left: Float32Array, right: Float32Array, start: number, end: number): void {
    const targetCutoff = clampCutoff(this.curve.valueAtFrame(start), this.sampleRate);
    this.smoothedCutoff += (targetCutoff - this.smoothedCutoff) * this.smoothing;
    const target = this.target;
    writeLowpassCoefficients(target, this.smoothedCutoff, this.q, this.sampleRate);
    const previous = this.previous;
    const count = end - start;

    for (let offset = 0; offset < count; offset += 1) {
      const ratio = Math.min(1, (offset + 1) / LOWPASS_CONTROL_BLOCK_SIZE);
      const b0 = previous.b0 + (target.b0 - previous.b0) * ratio;
      const b1 = previous.b1 + (target.b1 - previous.b1) * ratio;
      const b2 = previous.b2 + (target.b2 - previous.b2) * ratio;
      const a1 = previous.a1 + (target.a1 - previous.a1) * ratio;
      const a2 = previous.a2 + (target.a2 - previous.a2) * ratio;
      const frame = start + offset;
      left[frame] = this.leftState.processValues(left[frame] ?? 0, b0, b1, b2, a1, a2);
      right[frame] = this.rightState.processValues(right[frame] ?? 0, b0, b1, b2, a1, a2);
    }

    previous.b0 = target.b0;
    previous.b1 = target.b1;
    previous.b2 = target.b2;
    previous.a1 = target.a1;
    previous.a2 = target.a2;
  }
}

/**
 * True when an effect is a documented no-op and can be skipped bit-exactly.
 *
 * The dry baseline is an empty chain plus `mix: 0` reverb and delay plus an EQ
 * whose three gains are exactly zero. A low-pass is never transparent: even at
 * the schema maximum of 20 kHz it changes the signal, so it always processes.
 */
export function isTransparentEffect(effect: NormalizedEffect): boolean {
  switch (effect.type) {
    case 'reverb':
      return effect.mix === 0;
    case 'delay':
      return effect.mix === 0;
    case 'eq':
      return effect.lowGainDb === 0 && effect.midGainDb === 0 && effect.highGainDb === 0;
    case 'lowpass':
      return false;
    default:
      return false;
  }
}

/**
 * Apply a track effect chain in place, in authored order.
 *
 * The input buffers are the post-gain, post-pan stereo track signal and must be
 * finite. Parameters are expected to have been validated against
 * `EFFECT_PARAMETER_RANGES`; values are clamped here as a second line of
 * defense. The function allocates all effect state locally, so every call starts
 * from empty delay lines, empty reverb buffers, and zeroed filter state.
 */
export function processEffectChain(
  effects: readonly NormalizedEffect[],
  options: EffectChainOptions,
  left: Float32Array,
  right: Float32Array,
): void {
  const frameCount = Math.max(0, Math.min(options.frameCount, left.length, right.length));
  if (frameCount === 0) {
    return;
  }
  const sampleRate = options.sampleRate;
  const cutoffAutomation = options.cutoffAutomation ?? null;

  for (const effect of effects) {
    if (isTransparentEffect(effect)) {
      continue;
    }
    switch (effect.type) {
      case 'reverb': {
        new ReverbProcessor(sampleRate, effect.decaySeconds, effect.mix).process(
          left,
          right,
          frameCount,
        );
        break;
      }
      case 'delay': {
        new DelayProcessor(effect.timeMs, effect.feedback, effect.mix, sampleRate).process(
          left,
          right,
          frameCount,
        );
        break;
      }
      case 'eq': {
        new EqProcessor(effect.lowGainDb, effect.midGainDb, effect.highGainDb, sampleRate).process(
          left,
          right,
          frameCount,
        );
        break;
      }
      case 'lowpass': {
        const constantCutoff = cutoffAutomation?.constantValue ?? null;
        if (cutoffAutomation !== null && constantCutoff === null) {
          new AutomatedLowpassProcessor(cutoffAutomation, effect.q, sampleRate).process(
            left,
            right,
            frameCount,
          );
        } else {
          // A flat automation curve replaces cutoffHz. The fallback is the
          // normalized schema default and is unreachable for validated songs,
          // which always carry one of the two cutoff forms.
          const cutoff = constantCutoff ?? effect.cutoffHz ?? 20000;
          new StaticLowpassProcessor(cutoff, effect.q, sampleRate).process(left, right, frameCount);
        }
        break;
      }
    }
  }
}
