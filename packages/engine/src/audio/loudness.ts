/**
 * Local integrated loudness approximation for render reports.
 *
 * This is a simplified ITU-R BS.1770-style measurement. It applies K-weighting
 * with the published libebur128 filter design for the two supported sample
 * rates, measures 400 ms blocks with a 100 ms hop (75 percent overlap), applies
 * the -70 LUFS absolute gate and the -10 LU relative gate, and returns a gated
 * integrated value. It is not a certified EBU R128 or BS.1770 meter: it does not
 * compute true peak, loudness range, or channel-weighted surround layouts, and
 * it does not use the reference decoder or compliance tolerances.
 *
 * Silence and signals whose blocks all fall below the absolute gate return
 * `integratedLufs: null`. The function never returns -Infinity, NaN, or
 * Infinity.
 */

import type { SampleRate } from '../time.js';
import type { StereoAudioBuffer } from './render.js';

export const LOUDNESS_METHOD = 'vamp-kweighted-gated-v1' as const;

export const LOUDNESS_METHOD_DESCRIPTION =
  'Simplified ITU-R BS.1770 K-weighting with 400 ms blocks, 100 ms hop, a -70 LUFS absolute gate, and a -10 LU relative gate. Local approximation, not certified.';

export const LOUDNESS_ABSOLUTE_GATE_LUFS = -70 as const;
export const LOUDNESS_RELATIVE_GATE_LU = -10 as const;
export const LOUDNESS_BLOCK_SECONDS = 0.4 as const;
export const LOUDNESS_HOP_SECONDS = 0.1 as const;

export const LOUDNESS_LIMITATIONS = Object.freeze([
  'K-weighting uses the public libebur128 filter design, not a certified BS.1770 meter.',
  'The result is an integrated approximation only. True peak, loudness range, and momentary or short-term maxima are not reported.',
  'Stereo channels are weighted 1.0 each. Surround channel weights and dialogue normalization are not implemented.',
  'Signals shorter than one 400 ms block use one partial block, so very short clips are measured differently from program material.',
  'Values are suitable for comparing Vamp renders, not for broadcast or streaming loudness compliance.',
] as const);

/** Machine-readable description of the approximation and its limits. */
export interface LoudnessMeasurement {
  readonly integratedLufs: number | null;
  readonly method: typeof LOUDNESS_METHOD;
  readonly description: typeof LOUDNESS_METHOD_DESCRIPTION;
  readonly blockSeconds: typeof LOUDNESS_BLOCK_SECONDS;
  readonly hopSeconds: typeof LOUDNESS_HOP_SECONDS;
  readonly absoluteGateLufs: typeof LOUDNESS_ABSOLUTE_GATE_LUFS;
  readonly relativeGateLu: typeof LOUDNESS_RELATIVE_GATE_LU;
  readonly blockCount: number;
  readonly gatedBlockCount: number;
  /** True when no block passed the absolute gate, so no loudness was reported. */
  readonly silence: boolean;
  /** True when a signal shorter than one block used the partial-block fallback. */
  readonly shortSignal: boolean;
  readonly limitations: readonly string[];
}

interface BiquadCoefficients {
  readonly b0: number;
  readonly b1: number;
  readonly b2: number;
  readonly a1: number;
  readonly a2: number;
}

interface BiquadState {
  z1: number;
  z2: number;
}

function createState(): BiquadState {
  return { z1: 0, z2: 0 };
}

function processSample(
  state: BiquadState,
  coefficients: BiquadCoefficients,
  input: number,
): number {
  const output = coefficients.b0 * input + state.z1;
  state.z1 = coefficients.b1 * input - coefficients.a1 * output + state.z2;
  state.z2 = coefficients.b2 * input - coefficients.a2 * output;
  return output;
}

/**
 * BS.1770 pre-filter high shelf, derived from the public libebur128 constants.
 * The analog prototype parameters are sample-rate independent; the bilinear
 * transform is recomputed for 44100 and 48000 Hz.
 */
function preFilterCoefficients(sampleRate: SampleRate): BiquadCoefficients {
  const f0 = 1681.974450955533;
  const gainDb = 3.999843853973347;
  const q = 0.7071752369554196;
  const k = Math.tan((Math.PI * f0) / sampleRate);
  const vh = Math.pow(10, gainDb / 20);
  const vb = Math.pow(vh, 0.4996667741545416);
  const a0 = 1 + k / q + k * k;
  return {
    b0: (vh + (vb * k) / q + k * k) / a0,
    b1: (2 * (k * k - vh)) / a0,
    b2: (vh - (vb * k) / q + k * k) / a0,
    a1: (2 * (k * k - 1)) / a0,
    a2: (1 - k / q + k * k) / a0,
  };
}

/** BS.1770 RLB high-pass stage, derived from the public libebur128 constants. */
function rlbFilterCoefficients(sampleRate: SampleRate): BiquadCoefficients {
  const f0 = 38.13547087602444;
  const q = 0.5003270373238773;
  const k = Math.tan((Math.PI * f0) / sampleRate);
  const denominator = 1 + k / q + k * k;
  return {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (k * k - 1)) / denominator,
    a2: (1 - k / q + k * k) / denominator,
  };
}

function blockLoudness(meanSquare: number): number {
  return -0.691 + 10 * Math.log10(meanSquare);
}

function emptyMeasurement(blockCount: number, shortSignal: boolean): LoudnessMeasurement {
  return {
    integratedLufs: null,
    method: LOUDNESS_METHOD,
    description: LOUDNESS_METHOD_DESCRIPTION,
    blockSeconds: LOUDNESS_BLOCK_SECONDS,
    hopSeconds: LOUDNESS_HOP_SECONDS,
    absoluteGateLufs: LOUDNESS_ABSOLUTE_GATE_LUFS,
    relativeGateLu: LOUDNESS_RELATIVE_GATE_LU,
    blockCount,
    gatedBlockCount: 0,
    silence: true,
    shortSignal,
    limitations: LOUDNESS_LIMITATIONS,
  };
}

/**
 * Measure integrated loudness on a stereo float buffer.
 *
 * The master buffer is already finite when this is called by the artifact
 * renderer. Non-finite samples are treated as zero energy rather than allowing
 * NaN or Infinity into the report.
 */
export function measureIntegratedLoudness(audio: StereoAudioBuffer): LoudnessMeasurement {
  const frameCount = Math.max(0, Math.floor(audio.frameCount));
  const hopFrames = Math.max(1, Math.round(LOUDNESS_HOP_SECONDS * audio.sampleRate));
  const blockFrames = hopFrames * Math.round(LOUDNESS_BLOCK_SECONDS / LOUDNESS_HOP_SECONDS);

  if (frameCount === 0) {
    return emptyMeasurement(0, false);
  }

  const preFilter = preFilterCoefficients(audio.sampleRate);
  const rlbFilter = rlbFilterCoefficients(audio.sampleRate);
  const leftPre = createState();
  const rightPre = createState();
  const leftRlb = createState();
  const rightRlb = createState();

  if (frameCount < blockFrames) {
    let energy = 0;
    for (let frame = 0; frame < frameCount; frame += 1) {
      const left = audio.left[frame] ?? 0;
      const right = audio.right[frame] ?? 0;
      const weightedLeft = processSample(
        leftRlb,
        rlbFilter,
        processSample(leftPre, preFilter, left),
      );
      const weightedRight = processSample(
        rightRlb,
        rlbFilter,
        processSample(rightPre, preFilter, right),
      );
      if (Number.isFinite(weightedLeft)) {
        energy += weightedLeft * weightedLeft;
      }
      if (Number.isFinite(weightedRight)) {
        energy += weightedRight * weightedRight;
      }
    }
    const meanSquare = energy / frameCount;
    if (!(meanSquare > 0)) {
      return emptyMeasurement(1, true);
    }
    if (blockLoudness(meanSquare) <= LOUDNESS_ABSOLUTE_GATE_LUFS) {
      return emptyMeasurement(1, true);
    }
    return {
      integratedLufs: blockLoudness(meanSquare),
      method: LOUDNESS_METHOD,
      description: LOUDNESS_METHOD_DESCRIPTION,
      blockSeconds: LOUDNESS_BLOCK_SECONDS,
      hopSeconds: LOUDNESS_HOP_SECONDS,
      absoluteGateLufs: LOUDNESS_ABSOLUTE_GATE_LUFS,
      relativeGateLu: LOUDNESS_RELATIVE_GATE_LU,
      blockCount: 1,
      gatedBlockCount: 1,
      silence: false,
      shortSignal: true,
      limitations: LOUDNESS_LIMITATIONS,
    };
  }

  const hopCount = Math.floor(frameCount / hopFrames);
  const hopEnergies = new Float64Array(hopCount);
  let energyAccumulator = 0;
  for (let frame = 0; frame < hopCount * hopFrames; frame += 1) {
    const left = audio.left[frame] ?? 0;
    const right = audio.right[frame] ?? 0;
    const weightedLeft = processSample(leftRlb, rlbFilter, processSample(leftPre, preFilter, left));
    const weightedRight = processSample(
      rightRlb,
      rlbFilter,
      processSample(rightPre, preFilter, right),
    );
    if (Number.isFinite(weightedLeft)) {
      energyAccumulator += weightedLeft * weightedLeft;
    }
    if (Number.isFinite(weightedRight)) {
      energyAccumulator += weightedRight * weightedRight;
    }
    if ((frame + 1) % hopFrames === 0) {
      hopEnergies[(frame + 1) / hopFrames - 1] = energyAccumulator;
      energyAccumulator = 0;
    }
  }

  const hopsPerBlock = blockFrames / hopFrames;
  const blockCount = hopCount - hopsPerBlock + 1;
  if (blockCount < 1) {
    return emptyMeasurement(0, false);
  }

  const blockEnergies = new Float64Array(blockCount);
  let running = 0;
  for (let hop = 0; hop < hopCount; hop += 1) {
    running += hopEnergies[hop] ?? 0;
    if (hop >= hopsPerBlock) {
      running -= hopEnergies[hop - hopsPerBlock] ?? 0;
    }
    if (hop >= hopsPerBlock - 1) {
      blockEnergies[hop - hopsPerBlock + 1] = running / blockFrames;
    }
  }

  const aboveAbsolute: number[] = [];
  let absoluteEnergy = 0;
  for (let block = 0; block < blockCount; block += 1) {
    const energy = blockEnergies[block] ?? 0;
    if (
      Number.isFinite(energy) &&
      energy > 0 &&
      blockLoudness(energy) > LOUDNESS_ABSOLUTE_GATE_LUFS
    ) {
      aboveAbsolute.push(energy);
      absoluteEnergy += energy;
    }
  }
  if (aboveAbsolute.length === 0) {
    return emptyMeasurement(blockCount, false);
  }

  const absoluteMean = absoluteEnergy / aboveAbsolute.length;
  const relativeThreshold = blockLoudness(absoluteMean) + LOUDNESS_RELATIVE_GATE_LU;
  let gatedEnergy = 0;
  let gatedBlockCount = 0;
  for (const energy of aboveAbsolute) {
    if (blockLoudness(energy) > relativeThreshold) {
      gatedEnergy += energy;
      gatedBlockCount += 1;
    }
  }
  if (gatedBlockCount === 0) {
    return emptyMeasurement(blockCount, false);
  }

  const integrated = blockLoudness(gatedEnergy / gatedBlockCount);
  if (!Number.isFinite(integrated)) {
    return emptyMeasurement(blockCount, false);
  }

  return {
    integratedLufs: integrated,
    method: LOUDNESS_METHOD,
    description: LOUDNESS_METHOD_DESCRIPTION,
    blockSeconds: LOUDNESS_BLOCK_SECONDS,
    hopSeconds: LOUDNESS_HOP_SECONDS,
    absoluteGateLufs: LOUDNESS_ABSOLUTE_GATE_LUFS,
    relativeGateLu: LOUDNESS_RELATIVE_GATE_LU,
    blockCount,
    gatedBlockCount,
    silence: false,
    shortSignal: false,
    limitations: LOUDNESS_LIMITATIONS,
  };
}
