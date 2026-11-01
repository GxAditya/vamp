import type { NormalizedEffect, NormalizedInstrument, SongKey, TimeSignature } from '@gxaditya/vamp-schema';

import type { SampleRate } from './time.js';

/** Stable marker for serialized timeline payloads. */
export const TIMELINE_FORMAT = 'vamp.timeline' as const;

/** Current timeline payload version. Independent of the song schema version. */
export const TIMELINE_FORMAT_VERSION = 1 as const;

export interface TimelineMeta {
  readonly title: string;
  readonly bpm: number;
  readonly timeSignature: TimeSignature;
  readonly key: SongKey;
  readonly seed: number;
  /** Authored `meta.durationHint` in quarter-note beats. */
  readonly durationHintBeats: number;
  readonly mood?: string;
  readonly tags?: readonly string[];
}

export interface TimelineAutomationPoint {
  readonly timeBeats: number;
  readonly timeSeconds: number;
  readonly value: number;
}

/**
 * Track automation keyframes in ascending time order. Keyframes are retained
 * as data for later DSP; the compiler never evaluates them per sample.
 */
export interface TimelineAutomation {
  readonly volume?: readonly TimelineAutomationPoint[];
  readonly pan?: readonly TimelineAutomationPoint[];
  readonly filterCutoffHz?: readonly TimelineAutomationPoint[];
}

export interface TimelineTrack {
  /** Authoring order index in the source song. */
  readonly index: number;
  readonly id: string;
  readonly name: string;
  readonly kind: 'midi' | 'drums';
  readonly channel: number;
  readonly instrument: NormalizedInstrument;
  /**
   * Resolved mute/solo audibility. Mute wins over solo. Inaudible tracks stay
   * in the timeline with this flag set to false.
   */
  readonly audible: boolean;
  readonly mute: boolean;
  readonly solo: boolean;
  /**
   * Resolved static linear gain. When `automation.volume` exists it replaces
   * this value during rendering; the static value remains for shape uniformity.
   */
  readonly volume: number;
  /**
   * Resolved static equal-power pan from -1 to 1. When `automation.pan` exists
   * it replaces this value during rendering.
   */
  readonly pan: number;
  readonly automation: TimelineAutomation;
  /** Normalized effects in authored processing order. */
  readonly effects: readonly NormalizedEffect[];
  /** Last notated content end in beats, excluding effect tails. */
  readonly contentEndBeats: number;
  readonly contentEndSeconds: number;
  /** Capped effect tail estimate. Zero when the track is inaudible. */
  readonly tailSeconds: number;
  readonly endSeconds: number;
  /** Number of note events on this track, including inaudible events. */
  readonly eventCount: number;
}

export type TimelineEventSource =
  | {
      readonly type: 'note';
      /** Index in the track's free-form `notes` array. */
      readonly noteIndex: number;
    }
  | {
      readonly type: 'pattern';
      readonly patternId: string;
      /** Index in the track's `placements` array. */
      readonly placementIndex: number;
      /** Zero-based play index within the placement, from 0 to repeat - 1. */
      readonly playIndex: number;
      /** Index in the pattern's `notes` array. */
      readonly noteIndex: number;
    };

export interface TimelineNoteEvent {
  /**
   * Stable source-derived identity. It contains no timestamps or random data,
   * so repeated compiles of the same song produce identical ids. Format:
   * `<trackId>:free:<noteIndex>` or
   * `<trackId>:placement:<placementIndex>:<playIndex>:<noteIndex>`.
   */
  readonly id: string;
  readonly trackIndex: number;
  readonly trackId: string;
  readonly pitch: number;
  readonly velocity: number;
  readonly startBeat: number;
  readonly durationBeats: number;
  readonly endBeat: number;
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly startSample: number;
  readonly endSample: number;
  readonly audible: boolean;
  readonly source: TimelineEventSource;
}

export interface TimelineStats {
  readonly trackCount: number;
  /** Free notes plus every note definition inside every pattern. */
  readonly authoredNoteCount: number;
  /** Free notes plus every expanded pattern note event. */
  readonly expandedNoteCount: number;
  readonly audibleEventCount: number;
}

export interface SongTimeline {
  readonly format: typeof TIMELINE_FORMAT;
  readonly formatVersion: typeof TIMELINE_FORMAT_VERSION;
  readonly schemaVersion: '1.0.0';
  readonly sampleRate: SampleRate;
  /** Quarter-note beats per bar for metadata. Never used for snapping. */
  readonly beatsPerBar: number;
  readonly secondsPerBeat: number;
  readonly hintSeconds: number;
  readonly lastSoundSeconds: number;
  /** `max(hintSeconds, lastSoundSeconds)` from the shared duration helper. */
  readonly renderedSeconds: number;
  /** `ceil(renderedSeconds * sampleRate)` from the documented duration formula. */
  readonly renderedSamples: number;
  readonly meta: TimelineMeta;
  /** Tracks in authoring order, including inaudible tracks. */
  readonly tracks: readonly TimelineTrack[];
  /** All note events in canonical order, including inaudible events. */
  readonly events: readonly TimelineNoteEvent[];
  readonly stats: TimelineStats;
}

/** A note-on or note-off derived from a timeline event. */
export interface TimelineBoundary {
  readonly kind: 'note-on' | 'note-off';
  readonly eventId: string;
  readonly trackIndex: number;
  readonly trackId: string;
  readonly pitch: number;
  /** Note-on velocity of the paired event. MIDI note-off velocity defaults to 0. */
  readonly velocity: number;
  /** Audibility of the paired event, copied from the resolved track state. */
  readonly audible: boolean;
  readonly timeBeats: number;
  readonly timeSeconds: number;
  readonly timeSample: number;
}

function compareStrings(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function compareEventSources(left: TimelineEventSource, right: TimelineEventSource): number {
  const leftRank = left.type === 'note' ? 0 : 1;
  const rightRank = right.type === 'note' ? 0 : 1;
  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }

  if (left.type === 'note' && right.type === 'note') {
    return left.noteIndex - right.noteIndex;
  }

  if (left.type === 'pattern' && right.type === 'pattern') {
    return (
      left.placementIndex - right.placementIndex ||
      left.playIndex - right.playIndex ||
      left.noteIndex - right.noteIndex
    );
  }

  return 0;
}

/**
 * Canonical event order:
 *
 * 1. `startBeat` ascending.
 * 2. `trackIndex` ascending (authoring order).
 * 3. `pitch` ascending.
 * 4. Free note index, then placement index, play index, and pattern note index.
 * 5. Event id as a final guard.
 *
 * Note-offs are not timeline events. Consumers that build note boundaries use
 * `getTimelineBoundaries`, which applies the note-off-before-note-on rule.
 */
export function compareTimelineEvents(left: TimelineNoteEvent, right: TimelineNoteEvent): number {
  return (
    left.startBeat - right.startBeat ||
    left.trackIndex - right.trackIndex ||
    left.pitch - right.pitch ||
    compareEventSources(left.source, right.source) ||
    compareStrings(left.id, right.id)
  );
}

/**
 * Return every note-on and note-off boundary in canonical order.
 *
 * Boundaries are sorted by `timeSample` first so events that collapse onto the
 * same sample after rounding still end before new notes start at that sample.
 * At equal sample positions, note-offs sort before note-ons, then boundaries
 * sort by exact beat, track, pitch, and event id. MIDI export must reapply the
 * note-off-before-note-on rule at its own tick resolution, because MIDI
 * quantization can collapse a different set of times.
 */
export function getTimelineBoundaries(timeline: SongTimeline): readonly TimelineBoundary[] {
  const boundaries: TimelineBoundary[] = [];

  for (const event of timeline.events) {
    boundaries.push({
      kind: 'note-on',
      eventId: event.id,
      trackIndex: event.trackIndex,
      trackId: event.trackId,
      pitch: event.pitch,
      velocity: event.velocity,
      audible: event.audible,
      timeBeats: event.startBeat,
      timeSeconds: event.startSeconds,
      timeSample: event.startSample,
    });
    boundaries.push({
      kind: 'note-off',
      eventId: event.id,
      trackIndex: event.trackIndex,
      trackId: event.trackId,
      pitch: event.pitch,
      velocity: event.velocity,
      audible: event.audible,
      timeBeats: event.endBeat,
      timeSeconds: event.endSeconds,
      timeSample: event.endSample,
    });
  }

  return boundaries.sort(
    (left, right) =>
      left.timeSample - right.timeSample ||
      (left.kind === right.kind ? 0 : left.kind === 'note-off' ? -1 : 1) ||
      left.timeBeats - right.timeBeats ||
      left.trackIndex - right.trackIndex ||
      left.pitch - right.pitch ||
      compareStrings(left.eventId, right.eventId),
  );
}
