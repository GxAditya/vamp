import type { TimelineAutomationPoint } from '../timeline.js';

/** The three automation targets accepted by SongSchemaV1. */
export const AUTOMATION_TARGETS = Object.freeze(['volume', 'pan', 'filterCutoffHz'] as const);

export type AutomationTarget = (typeof AUTOMATION_TARGETS)[number];

export interface AutomationValueRange {
  readonly minimum: number;
  readonly maximum: number;
}

/** Documented absolute value ranges for every automation target. */
export const AUTOMATION_RANGES: Readonly<Record<AutomationTarget, AutomationValueRange>> =
  Object.freeze({
    volume: Object.freeze({ minimum: 0, maximum: 2 }),
    pan: Object.freeze({ minimum: -1, maximum: 1 }),
    filterCutoffHz: Object.freeze({ minimum: 20, maximum: 20000 }),
  });

/**
 * Time constant for the one-pole gain and pan de-zipper.
 *
 * Static values and constant automation bypass smoothing entirely. Only a
 * moving automation curve passes through this filter, and it starts at the
 * curve value for frame 0 so the first rendered sample is exact.
 */
export const AUTOMATION_SMOOTHING_SECONDS = 0.002;

/** One-pole parameter smoother with a click-resistant, deterministic response. */
export class ParameterSmoother {
  private current: number;
  private readonly coefficient: number;

  constructor(initial: number, sampleRate: number, seconds = AUTOMATION_SMOOTHING_SECONDS) {
    this.current = initial;
    this.coefficient = 1 - Math.exp(-1 / Math.max(1, seconds * sampleRate));
  }

  next(target: number): number {
    this.current += (target - this.current) * this.coefficient;
    return this.current;
  }

  get value(): number {
    return this.current;
  }
}

/** One automation keyframe converted to an exact, fractional frame position. */
export interface AutomationCurvePoint {
  readonly frame: number;
  readonly value: number;
}

export interface AutomationCurveOptions {
  readonly target: AutomationTarget;
  readonly sampleRate: number;
}

/**
 * A piecewise-linear automation curve evaluated at fractional frame positions.
 *
 * The curve follows the schema semantics exactly: the first value holds before
 * the first point, the last value holds after the last point, and interpolation
 * is linear between points. Cutoff therefore interpolates linearly in hertz.
 * Evaluation is monotonic in normal rendering, so a cursor keeps it O(1) per
 * sample. A backward query restarts the cursor, which keeps the helper safe for
 * diagnostic and test use.
 */
export class AutomationCurve {
  readonly target: AutomationTarget;
  readonly points: readonly AutomationCurvePoint[];
  /**
   * The single value of a flat curve, or null when the curve has more than one
   * value. Flat curves can use the static render path without smoothing.
   */
  readonly constantValue: number | null;

  private index = 0;

  constructor(points: readonly AutomationCurvePoint[], target: AutomationTarget) {
    if (points.length === 0) {
      throw new Error('An automation curve requires at least one point.');
    }
    this.target = target;
    this.points = points;

    const firstValue = points[0]?.value ?? 0;
    let constant = true;
    for (const point of points) {
      if (point.value !== firstValue) {
        constant = false;
        break;
      }
    }
    this.constantValue = constant ? firstValue : null;
  }

  valueAtFrame(frame: number): number {
    const points = this.points;
    const lastIndex = points.length - 1;
    const first = points[0];
    const last = points[lastIndex];
    if (first === undefined || last === undefined) {
      return 0;
    }
    if (this.constantValue !== null) {
      return this.constantValue;
    }
    if (frame <= first.frame) {
      this.index = 0;
      return first.value;
    }
    if (frame >= last.frame) {
      this.index = lastIndex;
      return last.value;
    }

    let index = this.index;
    if (index >= lastIndex || (points[index]?.frame ?? 0) > frame) {
      index = 0;
    }
    while (index < lastIndex) {
      const nextPoint = points[index + 1];
      if (nextPoint === undefined || nextPoint.frame > frame) {
        break;
      }
      index += 1;
    }
    this.index = index;

    const lower = points[index];
    const upper = points[index + 1];
    if (lower === undefined || upper === undefined) {
      return last.value;
    }
    const span = upper.frame - lower.frame;
    if (!(span > 0)) {
      return upper.value;
    }
    return lower.value + (upper.value - lower.value) * ((frame - lower.frame) / span);
  }
}

/**
 * Build a frame-domain automation curve from canonical timeline keyframes.
 *
 * Callers must validate point count, ordering, finiteness, and value ranges
 * first. Rendering does that before constructing any curve, so an invalid
 * timeline produces a structured issue instead of reaching this function.
 */
export function createAutomationCurve(
  points: readonly TimelineAutomationPoint[],
  options: AutomationCurveOptions,
): AutomationCurve {
  const sampleRate = options.sampleRate;
  return new AutomationCurve(
    points.map((point) => ({
      frame: point.timeSeconds * sampleRate,
      value: point.value,
    })),
    options.target,
  );
}
