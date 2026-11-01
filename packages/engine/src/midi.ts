import type { IssueParams, NormalizedInstrument } from '@gxaditya/vamp-schema';

import type {
  SongTimeline,
  TimelineAutomationPoint,
  TimelineNoteEvent,
  TimelineTrack,
} from './timeline.js';

/** Stable marker for MIDI export report payloads. */
export const MIDI_EXPORT_FORMAT = 'vamp.midi' as const;

/** Current MIDI export report version. Independent of the timeline and schema. */
export const MIDI_EXPORT_FORMAT_VERSION = 1 as const;

/** Standard MIDI File format emitted by this exporter. */
export const MIDI_FILE_FORMAT = 1 as const;

/**
 * Pulses per quarter note. Chosen so common subdivisions (triplets, 32nds,
 * 96 PPQ and 480 PPQ material) land on whole ticks. All beat positions are
 * quantized to this resolution with nearest-integer rounding.
 */
export const MIDI_PPQ = 960 as const;

/** Name of the first, metadata-only conductor track. */
export const MIDI_CONDUCTOR_TRACK_NAME = 'Conductor' as const;

/** General MIDI percussion channel. It is the only valid drums channel. */
export const MIDI_DRUM_CHANNEL = 9 as const;

/** Standard controller numbers used for exported mix automation. */
export const MIDI_VOLUME_CONTROLLER = 7 as const;
export const MIDI_PAN_CONTROLLER = 10 as const;
export const MIDI_BANK_SELECT_MSB = 0 as const;
export const MIDI_BANK_SELECT_LSB = 32 as const;

/** SongSchemaV1 bounds repeated here as defense in depth. */
export const MIDI_MAX_TRACKS = 16 as const;
export const MIDI_MAX_EVENTS = 20_000 as const;
export const MIDI_MAX_AUTOMATION_POINTS = 512 as const;

/** Choose how the final end-of-track marker is derived. */
export type MidiEndMarker = 'rendered' | 'content';

export interface MidiExportOptions {
  /**
   * Include tracks whose resolved `audible` flag is false. The default is
   * false, so muted and non-soloed tracks are omitted without re-resolving
   * mute or solo. Every timeline track is still listed in the report.
   */
  readonly includeInaudibleTracks?: boolean;
  /**
   * `rendered` (default) places the final marker at `timeline.renderedSeconds`.
   * `content` places it at the last included note end. In both cases the marker
   * is never earlier than included note content.
   */
  readonly endMarker?: MidiEndMarker;
  /**
   * Emit volume (CC7) and pan (CC10) controllers for the track mix. Defaults to
   * true. Set false when the MIDI is an internal neutral rendering input whose
   * gain and pan are applied by the shared audio mixer; for example the
   * FluidSynth sample backend uses this so a track's volume and pan are not
   * applied twice. Mix automation is omitted along with the static controllers.
   */
  readonly omitMixControllers?: boolean;
}

export const MIDI_ISSUE_CODES = Object.freeze([
  'midi.options.invalid',
  'midi.timeline.invalid',
  'midi.channel.invalid',
  'midi.channel.collision',
  'midi.limit.tracks',
  'midi.limit.events',
  'midi.limit.automation',
  'midi.event.invalid',
  'midi.encode.failed',
] as const);

export type MidiIssueCode = (typeof MIDI_ISSUE_CODES)[number];

/** A MIDI export issue uses the same JSON-serializable shape as schema issues. */
export interface MidiIssue {
  readonly code: MidiIssueCode;
  readonly severity: 'error';
  readonly path: string;
  readonly message: string;
  readonly hint: string;
  readonly params?: IssueParams;
}

export const MIDI_LIMITATION_CODES = Object.freeze([
  'program.not_encoded',
  'automation.keyframes_only',
  'automation.after_end',
  'automation.filter_not_encoded',
  'effects.not_encoded',
  'audio.tail_not_encoded',
  'key.not_encoded',
  'key.enharmonic',
] as const);

export type MidiLimitationCode = (typeof MIDI_LIMITATION_CODES)[number];

/** A documented MIDI limitation. Limitations are not export failures. */
export interface MidiLimitation {
  readonly code: MidiLimitationCode;
  readonly message: string;
  readonly trackIndex?: number;
  readonly trackId?: string;
  readonly params?: IssueParams;
}

export interface MidiEventCounts {
  readonly noteOn: number;
  readonly noteOff: number;
  readonly controlChange: number;
  readonly programChange: number;
  readonly meta: number;
  readonly total: number;
}

export interface MidiTrackReport {
  readonly timelineIndex: number;
  /** MIDI track index in the file, or null when the track was omitted. */
  readonly midiTrack: number | null;
  readonly id: string;
  readonly name: string;
  readonly kind: 'midi' | 'drums';
  readonly channel: number;
  readonly audible: boolean;
  readonly included: boolean;
  /** Present only when the track is omitted by the default audibility policy. */
  readonly omitReason: 'inaudible' | null;
  readonly instrumentType: NormalizedInstrument['type'];
  readonly program: number | null;
  readonly bank: { readonly msb: number; readonly lsb: number } | null;
  readonly eventCounts: MidiEventCounts;
}

export interface MidiKeySignatureReport {
  readonly tonic: string;
  readonly mode: 'major' | 'minor';
  /** Signed circle-of-fifths count as stored in the MIDI key-signature meta event. */
  readonly fifths: number;
  readonly minor: boolean;
  /** True when the tonic spelling needed an enharmonic circle-of-fifths value. */
  readonly enharmonic: boolean;
}

export interface MidiExportReport {
  readonly format: typeof MIDI_EXPORT_FORMAT;
  readonly formatVersion: typeof MIDI_EXPORT_FORMAT_VERSION;
  readonly fileFormat: typeof MIDI_FILE_FORMAT;
  readonly ppq: typeof MIDI_PPQ;
  readonly title: string;
  readonly tempo: {
    readonly bpm: number;
    readonly microsecondsPerQuarter: number;
    readonly rounding: 'nearest';
  };
  readonly timeSignature: {
    readonly numerator: number;
    readonly denominator: number;
    readonly denominatorExponent: number;
    readonly clocksPerClick: number;
    readonly thirtySecondsPerQuarter: 8;
  };
  readonly keySignature: MidiKeySignatureReport | null;
  readonly endMarker: MidiEndMarker;
  readonly endTickSource: 'rendered' | 'content';
  readonly endTick: number;
  readonly renderedTick: number;
  readonly contentEndTick: number;
  readonly renderedSeconds: number;
  readonly includeInaudibleTracks: boolean;
  /** Whether CC7 volume and CC10 pan controllers were emitted. */
  readonly includeMixControllers: boolean;
  /** Number of musical tracks included after the audibility policy. */
  readonly trackCount: number;
  /** SMF header track count, including the conductor track. */
  readonly midiTrackCount: number;
  readonly conductor: {
    readonly midiTrack: 0;
    readonly name: typeof MIDI_CONDUCTOR_TRACK_NAME;
    readonly eventCounts: MidiEventCounts;
  };
  readonly tracks: readonly MidiTrackReport[];
  readonly eventCounts: MidiEventCounts;
  readonly limitations: readonly MidiLimitation[];
}

export interface MidiExportSuccess {
  readonly ok: true;
  readonly bytes: Uint8Array;
  readonly report: MidiExportReport;
}

export interface MidiExportFailure {
  readonly ok: false;
  readonly errors: readonly MidiIssue[];
}

export type MidiExportResult = MidiExportSuccess | MidiExportFailure;

interface ResolvedMidiOptions {
  readonly includeInaudibleTracks: boolean;
  readonly endMarker: MidiEndMarker;
  readonly includeMixControllers: boolean;
}

interface MutableCounts {
  noteOn: number;
  noteOff: number;
  controlChange: number;
  programChange: number;
  meta: number;
}

interface PendingEvent {
  readonly tick: number;
  readonly priority: number;
  readonly sortNumber: number;
  readonly sortKey: string;
  readonly bytes: readonly number[];
}

interface TrackWork {
  readonly track: TimelineTrack;
  readonly pending: PendingEvent[];
  readonly counts: MutableCounts;
  readonly program: { readonly program: number; readonly msb: number; readonly lsb: number } | null;
}

const MAX_BEATS = 12_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum
  );
}

function describeValue(value: unknown): string {
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' && Number.isNaN(value)) {
    return 'NaN';
  }
  return String(value);
}

function compareStrings(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

export function createMidiIssue(
  code: MidiIssueCode,
  path: string,
  message: string,
  hint: string,
  params?: IssueParams,
): MidiIssue {
  return {
    code,
    severity: 'error',
    path,
    message,
    hint,
    ...(params === undefined ? {} : { params }),
  };
}

export function compareMidiIssues(left: MidiIssue, right: MidiIssue): number {
  return (
    compareStrings(left.path, right.path) ||
    compareStrings(left.code, right.code) ||
    compareStrings(left.message, right.message)
  );
}

export function normalizeMidiIssues(issues: readonly MidiIssue[]): MidiIssue[] {
  return [...issues].sort(compareMidiIssues);
}

function emptyCounts(): MutableCounts {
  return { noteOn: 0, noteOff: 0, controlChange: 0, programChange: 0, meta: 0 };
}

function addCounts(target: MutableCounts, source: MutableCounts): void {
  target.noteOn += source.noteOn;
  target.noteOff += source.noteOff;
  target.controlChange += source.controlChange;
  target.programChange += source.programChange;
  target.meta += source.meta;
}

function finishCounts(counts: MutableCounts): MidiEventCounts {
  return {
    noteOn: counts.noteOn,
    noteOff: counts.noteOff,
    controlChange: counts.controlChange,
    programChange: counts.programChange,
    meta: counts.meta,
    total:
      counts.noteOn + counts.noteOff + counts.controlChange + counts.programChange + counts.meta,
  };
}

function resolveMidiOptions(
  options: unknown,
):
  | { readonly ok: true; readonly value: ResolvedMidiOptions }
  | { readonly ok: false; readonly errors: readonly MidiIssue[] } {
  if (!isRecord(options)) {
    return {
      ok: false,
      errors: [
        createMidiIssue(
          'midi.options.invalid',
          '',
          'MIDI export options must be an object.',
          'Pass an object with optional includeInaudibleTracks and endMarker fields, or omit options.',
        ),
      ],
    };
  }

  const errors: MidiIssue[] = [];

  const include = options.includeInaudibleTracks;
  let includeInaudibleTracks = false;
  if (include !== undefined) {
    if (typeof include === 'boolean') {
      includeInaudibleTracks = include;
    } else {
      errors.push(
        createMidiIssue(
          'midi.options.invalid',
          '/includeInaudibleTracks',
          `includeInaudibleTracks must be a boolean, received ${describeValue(include)}.`,
          'Omit the option to omit inaudible tracks, or pass true to include them.',
        ),
      );
    }
  }

  const marker = options.endMarker;
  let endMarker: MidiEndMarker = 'rendered';
  if (marker !== undefined) {
    if (marker === 'rendered' || marker === 'content') {
      endMarker = marker;
    } else {
      errors.push(
        createMidiIssue(
          'midi.options.invalid',
          '/endMarker',
          `endMarker must be "rendered" or "content", received ${describeValue(marker)}.`,
          'Use "rendered" to align with the shared rendered duration, or "content" for the last included note end.',
        ),
      );
    }
  }

  const omitMix = options.omitMixControllers;
  let includeMixControllers = true;
  if (omitMix !== undefined) {
    if (typeof omitMix === 'boolean') {
      includeMixControllers = !omitMix;
    } else {
      errors.push(
        createMidiIssue(
          'midi.options.invalid',
          '/omitMixControllers',
          `omitMixControllers must be a boolean, received ${describeValue(omitMix)}.`,
          'Omit the option to emit CC7 volume and CC10 pan controllers, or pass true for neutral MIDI whose mix is applied by another stage.',
        ),
      );
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors: normalizeMidiIssues(errors) };
  }
  return { ok: true, value: { includeInaudibleTracks, endMarker, includeMixControllers } };
}

function isPowerOfTwo(value: number): boolean {
  return value >= 1 && value <= 32 && Number.isInteger(value) && (value & (value - 1)) === 0;
}

function validateInstrument(
  value: unknown,
  path: string,
  kind: 'midi' | 'drums',
  issues: MidiIssue[],
): void {
  if (!isRecord(value)) {
    issues.push(
      createMidiIssue(
        'midi.timeline.invalid',
        path,
        'Track instrument must be an object.',
        'Compile the song with @gxaditya/vamp-engine and export the resulting timeline.',
      ),
    );
    return;
  }

  const type = value.type;
  switch (type) {
    case 'builtin':
      if (typeof value.id !== 'string' || value.id.length === 0) {
        issues.push(
          createMidiIssue(
            'midi.timeline.invalid',
            `${path}/id`,
            'Built-in instrument id must be a non-empty string.',
            'Compile the song again before exporting MIDI.',
          ),
        );
      }
      return;
    case 'gm':
      if (kind === 'drums') {
        issues.push(
          createMidiIssue(
            'midi.timeline.invalid',
            `${path}/type`,
            'A drums track cannot use a General MIDI melodic program.',
            'Use a SoundFont percussion preset or a built-in drum kit for drums.',
          ),
        );
      }
      if (!isIntegerInRange(value.program, 0, 127)) {
        issues.push(
          createMidiIssue(
            'midi.timeline.invalid',
            `${path}/program`,
            'GM program must be an integer from 0 to 127.',
            'Compile the song again before exporting MIDI.',
          ),
        );
      }
      if (!isIntegerInRange(value.bank, 0, 127)) {
        issues.push(
          createMidiIssue(
            'midi.timeline.invalid',
            `${path}/bank`,
            'GM bank must be an integer from 0 to 127.',
            'Compile the song again before exporting MIDI.',
          ),
        );
      }
      return;
    case 'soundfont':
      if (typeof value.path !== 'string' || value.path.length === 0) {
        issues.push(
          createMidiIssue(
            'midi.timeline.invalid',
            `${path}/path`,
            'SoundFont path must be a non-empty string.',
            'Compile the song again before exporting MIDI.',
          ),
        );
      }
      if (!isIntegerInRange(value.program, 0, 127)) {
        issues.push(
          createMidiIssue(
            'midi.timeline.invalid',
            `${path}/program`,
            'SoundFont program must be an integer from 0 to 127.',
            'Compile the song again before exporting MIDI.',
          ),
        );
      }
      if (!isIntegerInRange(value.bank, 0, 128)) {
        issues.push(
          createMidiIssue(
            'midi.timeline.invalid',
            `${path}/bank`,
            'SoundFont bank must be an integer from 0 to 128.',
            'Compile the song again before exporting MIDI.',
          ),
        );
      }
      return;
    case 'sfz':
      if (typeof value.path !== 'string' || value.path.length === 0) {
        issues.push(
          createMidiIssue(
            'midi.timeline.invalid',
            `${path}/path`,
            'SFZ path must be a non-empty string.',
            'Compile the song again before exporting MIDI.',
          ),
        );
      }
      return;
    default:
      issues.push(
        createMidiIssue(
          'midi.timeline.invalid',
          `${path}/type`,
          `Unsupported instrument variant ${describeValue(type)}.`,
          'Compile the song again with a supported builtin, gm, soundfont, or sfz instrument.',
        ),
      );
  }
}

function validateAutomationPoints(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
  issues: MidiIssue[],
): void {
  if (!Array.isArray(value)) {
    issues.push(
      createMidiIssue(
        'midi.timeline.invalid',
        path,
        'Automation target must be an array of points.',
        'Compile the song again before exporting MIDI.',
      ),
    );
    return;
  }

  if (value.length < 1 || value.length > MIDI_MAX_AUTOMATION_POINTS) {
    issues.push(
      createMidiIssue(
        'midi.limit.automation',
        path,
        `Automation target has ${value.length} points; supported range is 1 to ${MIDI_MAX_AUTOMATION_POINTS}.`,
        'Reduce automation points or compile the song again through schema validation.',
        { points: value.length, limit: MIDI_MAX_AUTOMATION_POINTS },
      ),
    );
  }

  for (const [index, point] of value.entries()) {
    const pointPath = `${path}/${index}`;
    if (!isRecord(point)) {
      issues.push(
        createMidiIssue(
          'midi.timeline.invalid',
          pointPath,
          'Automation point must be an object.',
          'Compile the song again before exporting MIDI.',
        ),
      );
      continue;
    }
    if (!isFiniteNumber(point.timeBeats) || point.timeBeats < 0 || point.timeBeats > MAX_BEATS) {
      issues.push(
        createMidiIssue(
          'midi.timeline.invalid',
          `${pointPath}/timeBeats`,
          'Automation point timeBeats must be a finite number from 0 to 12000.',
          'Compile the song again before exporting MIDI.',
        ),
      );
    }
    if (!isFiniteNumber(point.value) || point.value < minimum || point.value > maximum) {
      issues.push(
        createMidiIssue(
          'midi.timeline.invalid',
          `${pointPath}/value`,
          `Automation point value must be a finite number from ${minimum} to ${maximum}.`,
          'Compile the song again before exporting MIDI.',
        ),
      );
    }
  }
}

function validateTrack(
  value: unknown,
  index: number,
  issues: MidiIssue[],
  channelOwners: Map<number, string>,
): void {
  const path = `/tracks/${index}`;
  if (!isRecord(value)) {
    issues.push(
      createMidiIssue(
        'midi.timeline.invalid',
        path,
        'Track must be an object.',
        'Compile the song with @gxaditya/vamp-engine and export the resulting timeline.',
      ),
    );
    return;
  }

  if (value.index !== index) {
    issues.push(
      createMidiIssue(
        'midi.timeline.invalid',
        `${path}/index`,
        `Track index must equal its array position ${index}.`,
        'Compile the song again before exporting MIDI.',
      ),
    );
  }

  const id = typeof value.id === 'string' && value.id.length > 0 ? value.id : null;
  if (id === null) {
    issues.push(
      createMidiIssue(
        'midi.timeline.invalid',
        `${path}/id`,
        'Track id must be a non-empty string.',
        'Compile the song again before exporting MIDI.',
      ),
    );
  }
  if (typeof value.name !== 'string' || value.name.length === 0) {
    issues.push(
      createMidiIssue(
        'midi.timeline.invalid',
        `${path}/name`,
        'Track name must be a non-empty string.',
        'Compile the song again before exporting MIDI.',
      ),
    );
  }
  if (typeof value.audible !== 'boolean') {
    issues.push(
      createMidiIssue(
        'midi.timeline.invalid',
        `${path}/audible`,
        'Track audible flag must be a boolean.',
        'Compile the song again before exporting MIDI.',
      ),
    );
  }

  const kind = value.kind;
  const isDrums = kind === 'drums';
  if (kind !== 'midi' && !isDrums) {
    issues.push(
      createMidiIssue(
        'midi.timeline.invalid',
        `${path}/kind`,
        `Track kind must be "midi" or "drums", received ${describeValue(kind)}.`,
        'Compile the song again before exporting MIDI.',
      ),
    );
  }

  if (!isIntegerInRange(value.channel, 0, 15)) {
    issues.push(
      createMidiIssue(
        'midi.channel.invalid',
        `${path}/channel`,
        'Track channel must be an integer from 0 to 15.',
        'Compile the song again so channels are resolved by schema validation.',
      ),
    );
  } else {
    const channel = value.channel;
    if (isDrums && channel !== MIDI_DRUM_CHANNEL) {
      issues.push(
        createMidiIssue(
          'midi.channel.invalid',
          `${path}/channel`,
          `Drums tracks must use channel ${MIDI_DRUM_CHANNEL}, received ${channel}.`,
          'Compile the song again so drum channel rules are enforced.',
          { channel, expectedChannel: MIDI_DRUM_CHANNEL },
        ),
      );
    } else if (!isDrums && channel === MIDI_DRUM_CHANNEL) {
      issues.push(
        createMidiIssue(
          'midi.channel.invalid',
          `${path}/channel`,
          `Melodic tracks cannot use reserved drum channel ${MIDI_DRUM_CHANNEL}.`,
          'Compile the song again so melodic channels are unique and do not use channel 9.',
          { channel },
        ),
      );
    } else {
      const owner = channelOwners.get(channel);
      if (owner !== undefined) {
        issues.push(
          createMidiIssue(
            'midi.channel.collision',
            `${path}/channel`,
            `Channel ${channel} is already used by track "${owner}".`,
            'Give each melodic track a unique channel. MIDI export will not silently move a track to another channel.',
            { channel, trackId: id, otherTrackId: owner },
          ),
        );
      } else if (id !== null) {
        channelOwners.set(channel, id);
      }
    }
  }

  validateInstrument(value.instrument, `${path}/instrument`, isDrums ? 'drums' : 'midi', issues);

  if (!isFiniteNumber(value.volume) || value.volume < 0 || value.volume > 2) {
    issues.push(
      createMidiIssue(
        'midi.timeline.invalid',
        `${path}/volume`,
        'Track volume must be a finite number from 0 to 2.',
        'Compile the song again before exporting MIDI.',
      ),
    );
  }
  if (!isFiniteNumber(value.pan) || value.pan < -1 || value.pan > 1) {
    issues.push(
      createMidiIssue(
        'midi.timeline.invalid',
        `${path}/pan`,
        'Track pan must be a finite number from -1 to 1.',
        'Compile the song again before exporting MIDI.',
      ),
    );
  }
  if (
    value.tailSeconds !== undefined &&
    (!isFiniteNumber(value.tailSeconds) || value.tailSeconds < 0)
  ) {
    issues.push(
      createMidiIssue(
        'midi.timeline.invalid',
        `${path}/tailSeconds`,
        'Track tailSeconds must be a finite non-negative number when present.',
        'Compile the song again before exporting MIDI.',
      ),
    );
  }

  if (
    !Array.isArray(value.effects) ||
    !value.effects.every((effect) => isRecord(effect) && typeof effect.type === 'string')
  ) {
    issues.push(
      createMidiIssue(
        'midi.timeline.invalid',
        `${path}/effects`,
        'Track effects must be an array of effect objects with a type.',
        'Compile the song again before exporting MIDI.',
      ),
    );
  }

  const automation = value.automation;
  if (!isRecord(automation)) {
    issues.push(
      createMidiIssue(
        'midi.timeline.invalid',
        `${path}/automation`,
        'Track automation must be an object.',
        'Compile the song again before exporting MIDI.',
      ),
    );
  } else {
    if (automation.volume !== undefined) {
      validateAutomationPoints(automation.volume, `${path}/automation/volume`, 0, 2, issues);
    }
    if (automation.pan !== undefined) {
      validateAutomationPoints(automation.pan, `${path}/automation/pan`, -1, 1, issues);
    }
    if (automation.filterCutoffHz !== undefined) {
      validateAutomationPoints(
        automation.filterCutoffHz,
        `${path}/automation/filterCutoffHz`,
        20,
        20_000,
        issues,
      );
    }
  }
}

function validateEvent(
  value: unknown,
  index: number,
  trackIds: readonly (string | null)[],
  issues: MidiIssue[],
): void {
  const path = `/events/${index}`;
  if (!isRecord(value)) {
    issues.push(
      createMidiIssue(
        'midi.event.invalid',
        path,
        'Timeline event must be an object.',
        'Compile the song with @gxaditya/vamp-engine and export the resulting timeline.',
      ),
    );
    return;
  }

  if (typeof value.id !== 'string' || value.id.length === 0) {
    issues.push(
      createMidiIssue(
        'midi.event.invalid',
        `${path}/id`,
        'Timeline event id must be a non-empty string.',
        'Compile the song again before exporting MIDI.',
      ),
    );
  }

  const trackIndex = value.trackIndex;
  if (!isIntegerInRange(trackIndex, 0, trackIds.length - 1)) {
    issues.push(
      createMidiIssue(
        'midi.event.invalid',
        `${path}/trackIndex`,
        `Event trackIndex must reference an existing track, received ${describeValue(trackIndex)}.`,
        'Compile the song again before exporting MIDI.',
      ),
    );
  } else {
    const expectedId = trackIds[trackIndex];
    if (expectedId !== null && value.trackId !== expectedId) {
      issues.push(
        createMidiIssue(
          'midi.event.invalid',
          `${path}/trackId`,
          `Event trackId ${describeValue(value.trackId)} does not match track "${expectedId}".`,
          'Compile the song again before exporting MIDI.',
        ),
      );
    }
  }

  if (!isIntegerInRange(value.pitch, 0, 127)) {
    issues.push(
      createMidiIssue(
        'midi.event.invalid',
        `${path}/pitch`,
        'Event pitch must be an integer from 0 to 127.',
        'Compile the song again before exporting MIDI.',
      ),
    );
  }
  if (!isIntegerInRange(value.velocity, 1, 127)) {
    issues.push(
      createMidiIssue(
        'midi.event.invalid',
        `${path}/velocity`,
        'Event velocity must be an integer from 1 to 127.',
        'Compile the song again before exporting MIDI.',
      ),
    );
  }

  const startBeat = value.startBeat;
  const endBeat = value.endBeat;
  if (!isFiniteNumber(startBeat) || startBeat < 0 || startBeat > MAX_BEATS) {
    issues.push(
      createMidiIssue(
        'midi.event.invalid',
        `${path}/startBeat`,
        'Event startBeat must be a finite number from 0 to 12000.',
        'Compile the song again before exporting MIDI.',
      ),
    );
  }
  if (
    !isFiniteNumber(endBeat) ||
    endBeat < 0 ||
    endBeat > MAX_BEATS ||
    (isFiniteNumber(startBeat) && endBeat < startBeat)
  ) {
    issues.push(
      createMidiIssue(
        'midi.event.invalid',
        `${path}/endBeat`,
        'Event endBeat must be finite, at least startBeat, and at most 12000.',
        'Compile the song again before exporting MIDI.',
      ),
    );
  }
  if (typeof value.audible !== 'boolean') {
    issues.push(
      createMidiIssue(
        'midi.event.invalid',
        `${path}/audible`,
        'Event audible flag must be a boolean.',
        'Compile the song again before exporting MIDI.',
      ),
    );
  }
}

function validateTimeline(
  input: unknown,
):
  | { readonly ok: true; readonly timeline: SongTimeline }
  | { readonly ok: false; readonly errors: readonly MidiIssue[] } {
  const issues: MidiIssue[] = [];

  if (!isRecord(input)) {
    return {
      ok: false,
      errors: [
        createMidiIssue(
          'midi.timeline.invalid',
          '',
          'MIDI export requires a canonical SongTimeline object.',
          'Compile a validated song with compileSong or compileValidatedSong, then pass result.timeline.',
        ),
      ],
    };
  }

  if (input.format !== 'vamp.timeline') {
    issues.push(
      createMidiIssue(
        'midi.timeline.invalid',
        '/format',
        `Timeline format marker must be "vamp.timeline", received ${describeValue(input.format)}.`,
        'Pass the timeline produced by @gxaditya/vamp-engine rather than a hand-built object.',
      ),
    );
  }
  if (input.formatVersion !== 1) {
    issues.push(
      createMidiIssue(
        'midi.timeline.invalid',
        '/formatVersion',
        `Timeline formatVersion must be 1, received ${describeValue(input.formatVersion)}.`,
        'Pass a timeline produced by the current @gxaditya/vamp-engine compiler.',
      ),
    );
  }
  if (input.schemaVersion !== '1.0.0') {
    issues.push(
      createMidiIssue(
        'midi.timeline.invalid',
        '/schemaVersion',
        `Timeline schemaVersion must be "1.0.0", received ${describeValue(input.schemaVersion)}.`,
        'Compile a SongSchemaV1 song with the current @gxaditya/vamp-engine compiler.',
      ),
    );
  }
  if (input.sampleRate !== 44100 && input.sampleRate !== 48000) {
    issues.push(
      createMidiIssue(
        'midi.timeline.invalid',
        '/sampleRate',
        `Timeline sampleRate must be 44100 or 48000, received ${describeValue(input.sampleRate)}.`,
        'Compile the song again with a supported sampleRate.',
      ),
    );
  }
  if (!isFiniteNumber(input.renderedSeconds) || input.renderedSeconds < 0) {
    issues.push(
      createMidiIssue(
        'midi.timeline.invalid',
        '/renderedSeconds',
        'Timeline renderedSeconds must be a finite non-negative number.',
        'Compile the song again before exporting MIDI.',
      ),
    );
  }
  if (!isFiniteNumber(input.secondsPerBeat) || input.secondsPerBeat <= 0) {
    issues.push(
      createMidiIssue(
        'midi.timeline.invalid',
        '/secondsPerBeat',
        'Timeline secondsPerBeat must be a finite positive number.',
        'Compile the song again before exporting MIDI.',
      ),
    );
  }

  const meta = input.meta;
  if (!isRecord(meta)) {
    issues.push(
      createMidiIssue(
        'midi.timeline.invalid',
        '/meta',
        'Timeline meta must be an object.',
        'Compile the song again before exporting MIDI.',
      ),
    );
  } else {
    if (typeof meta.title !== 'string') {
      issues.push(
        createMidiIssue(
          'midi.timeline.invalid',
          '/meta/title',
          'Timeline title must be a string.',
          'Compile the song again before exporting MIDI.',
        ),
      );
    }
    if (!isIntegerInRange(meta.bpm, 20, 300)) {
      issues.push(
        createMidiIssue(
          'midi.timeline.invalid',
          '/meta/bpm',
          'Timeline bpm must be an integer from 20 to 300.',
          'Compile the song again before exporting MIDI.',
        ),
      );
    }
    const timeSignature = meta.timeSignature;
    if (!isRecord(timeSignature)) {
      issues.push(
        createMidiIssue(
          'midi.timeline.invalid',
          '/meta/timeSignature',
          'Timeline timeSignature must be an object.',
          'Compile the song again before exporting MIDI.',
        ),
      );
    } else {
      if (!isIntegerInRange(timeSignature.numerator, 1, 32)) {
        issues.push(
          createMidiIssue(
            'midi.timeline.invalid',
            '/meta/timeSignature/numerator',
            'Time-signature numerator must be an integer from 1 to 32.',
            'Compile the song again before exporting MIDI.',
          ),
        );
      }
      if (!isIntegerInRange(timeSignature.denominator, 1, 32)) {
        issues.push(
          createMidiIssue(
            'midi.timeline.invalid',
            '/meta/timeSignature/denominator',
            'Time-signature denominator must be an integer from 1 to 32.',
            'Compile the song again before exporting MIDI.',
          ),
        );
      } else if (!isPowerOfTwo(timeSignature.denominator)) {
        issues.push(
          createMidiIssue(
            'midi.timeline.invalid',
            '/meta/timeSignature/denominator',
            'Time-signature denominator must be a power of two from 1 to 32.',
            'Compile the song again so MIDI can encode the denominator exponent.',
          ),
        );
      }
    }
    const key = meta.key;
    if (!isRecord(key)) {
      issues.push(
        createMidiIssue(
          'midi.timeline.invalid',
          '/meta/key',
          'Timeline key must be an object.',
          'Compile the song again before exporting MIDI.',
        ),
      );
    } else {
      if (typeof key.tonic !== 'string') {
        issues.push(
          createMidiIssue(
            'midi.timeline.invalid',
            '/meta/key/tonic',
            'Key tonic must be a string.',
            'Compile the song again before exporting MIDI.',
          ),
        );
      }
      if (typeof key.mode !== 'string') {
        issues.push(
          createMidiIssue(
            'midi.timeline.invalid',
            '/meta/key/mode',
            'Key mode must be a string.',
            'Compile the song again before exporting MIDI.',
          ),
        );
      }
    }
  }

  const tracks = input.tracks;
  if (!Array.isArray(tracks)) {
    issues.push(
      createMidiIssue(
        'midi.timeline.invalid',
        '/tracks',
        'Timeline tracks must be an array.',
        'Compile the song again before exporting MIDI.',
      ),
    );
  } else if (tracks.length < 1) {
    issues.push(
      createMidiIssue(
        'midi.limit.tracks',
        '/tracks',
        'Timeline must contain at least one track.',
        'Compile a valid SongSchemaV1 song before exporting MIDI.',
      ),
    );
  } else if (tracks.length > MIDI_MAX_TRACKS) {
    issues.push(
      createMidiIssue(
        'midi.limit.tracks',
        '/tracks',
        `Timeline has ${tracks.length} tracks; the supported limit is ${MIDI_MAX_TRACKS}.`,
        'Reduce the track count or export separate songs.',
        { tracks: tracks.length, limit: MIDI_MAX_TRACKS },
      ),
    );
  } else {
    const channelOwners = new Map<number, string>();
    for (const [index, track] of tracks.entries()) {
      validateTrack(track, index, issues, channelOwners);
    }
  }

  const events = input.events;
  if (!Array.isArray(events)) {
    issues.push(
      createMidiIssue(
        'midi.timeline.invalid',
        '/events',
        'Timeline events must be an array.',
        'Compile the song again before exporting MIDI.',
      ),
    );
  } else if (events.length > MIDI_MAX_EVENTS) {
    issues.push(
      createMidiIssue(
        'midi.limit.events',
        '/events',
        `Timeline has ${events.length} events; the supported limit is ${MIDI_MAX_EVENTS}.`,
        'Reduce repeat counts or note density, or split the song into smaller projects.',
        { events: events.length, limit: MIDI_MAX_EVENTS },
      ),
    );
  } else if (Array.isArray(tracks) && tracks.length >= 1 && tracks.length <= MIDI_MAX_TRACKS) {
    const trackIds = tracks.map((track) =>
      isRecord(track) && typeof track.id === 'string' && track.id.length > 0 ? track.id : null,
    );
    for (const [index, event] of events.entries()) {
      validateEvent(event, index, trackIds, issues);
    }
  }

  if (issues.length > 0) {
    return { ok: false, errors: normalizeMidiIssues(issues) };
  }

  return { ok: true, timeline: input as unknown as SongTimeline };
}

const MAJOR_FIFTHS: Readonly<Record<string, number>> = {
  C: 0,
  'C#': 7,
  D: 2,
  'D#': -3,
  E: 4,
  F: -1,
  'F#': 6,
  G: 1,
  'G#': -4,
  A: 3,
  'A#': -2,
  B: 5,
};

const MINOR_FIFTHS: Readonly<Record<string, number>> = {
  C: -3,
  'C#': 4,
  D: -1,
  'D#': 6,
  E: 1,
  F: -4,
  'F#': 3,
  G: -2,
  'G#': 5,
  A: 0,
  'A#': 7,
  B: 2,
};

const ENHARMONIC_MAJOR_TONICS = new Set(['D#', 'G#', 'A#']);

function getKeySignature(
  key: Readonly<Record<string, unknown>>,
): { fifths: number; minor: boolean; enharmonic: boolean } | null {
  const tonic = key.tonic;
  const mode = key.mode;
  if (typeof tonic !== 'string' || typeof mode !== 'string') {
    return null;
  }
  if (mode === 'major') {
    const fifths = MAJOR_FIFTHS[tonic];
    if (fifths === undefined) {
      return null;
    }
    return { fifths, minor: false, enharmonic: ENHARMONIC_MAJOR_TONICS.has(tonic) };
  }
  if (mode === 'minor') {
    const fifths = MINOR_FIFTHS[tonic];
    if (fifths === undefined) {
      return null;
    }
    return { fifths, minor: true, enharmonic: false };
  }
  return null;
}

function getProgramSelection(
  instrument: NormalizedInstrument,
): { program: number; msb: number; lsb: number } | null {
  switch (instrument.type) {
    case 'builtin':
    case 'sfz':
      return null;
    case 'gm':
    case 'soundfont':
      return {
        program: instrument.program,
        msb: Math.floor(instrument.bank / 128),
        lsb: instrument.bank % 128,
      };
  }
}

function volumeToController(value: number): number {
  const clamped = Math.min(2, Math.max(0, value));
  if (clamped <= 1) {
    return Math.round(clamped * 100);
  }
  return 100 + Math.round((clamped - 1) * 27);
}

function panToController(value: number): number {
  const clamped = Math.min(1, Math.max(-1, value));
  return Math.round(((clamped + 1) / 2) * 127);
}

function beatToTick(beat: number): number {
  return Math.round(beat * MIDI_PPQ);
}

function denominatorExponent(denominator: number): number {
  let exponent = 0;
  let value = denominator;
  while (value > 1) {
    value /= 2;
    exponent += 1;
  }
  return exponent;
}

function encodeVarLen(value: number): number[] {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('MIDI variable-length quantity must be a non-negative safe integer.');
  }
  const bytes = [value & 0x7f];
  let remaining = Math.floor(value / 128);
  while (remaining > 0) {
    bytes.unshift((remaining & 0x7f) | 0x80);
    remaining = Math.floor(remaining / 128);
  }
  return bytes;
}

function encodeUint32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function encodeUint16(value: number): number[] {
  return [(value >>> 8) & 0xff, value & 0xff];
}

function encodeTextMeta(type: number, text: string): number[] {
  const data = Array.from(new TextEncoder().encode(text));
  return [0xff, type, ...encodeVarLen(data.length), ...data];
}

function encodeTempoMeta(microsecondsPerQuarter: number): number[] {
  return [
    0xff,
    0x51,
    0x03,
    (microsecondsPerQuarter >>> 16) & 0xff,
    (microsecondsPerQuarter >>> 8) & 0xff,
    microsecondsPerQuarter & 0xff,
  ];
}

function encodeTimeSignatureMeta(
  numerator: number,
  denominator: number,
  clocksPerClick: number,
): number[] {
  return [0xff, 0x58, 0x04, numerator, denominatorExponent(denominator), clocksPerClick, 8];
}

function encodeKeySignatureMeta(fifths: number, minor: boolean): number[] {
  return [0xff, 0x59, 0x02, fifths & 0xff, minor ? 1 : 0];
}

function encodeEndOfTrack(): number[] {
  return [0xff, 0x2f, 0x00];
}

function createPending(
  tick: number,
  priority: number,
  sortNumber: number,
  sortKey: string,
  bytes: readonly number[],
): PendingEvent {
  return { tick, priority, sortNumber, sortKey, bytes };
}

function comparePending(left: PendingEvent, right: PendingEvent): number {
  return (
    left.tick - right.tick ||
    left.priority - right.priority ||
    left.sortNumber - right.sortNumber ||
    compareStrings(left.sortKey, right.sortKey)
  );
}

function pushController(
  pending: PendingEvent[],
  counts: MutableCounts,
  channel: number,
  controller: number,
  value: number,
  tick: number,
  sortKey: string,
): void {
  const clamped = Math.min(127, Math.max(0, Math.round(value)));
  pending.push(createPending(tick, 4, controller, sortKey, [0xb0 | channel, controller, clamped]));
  counts.controlChange += 1;
}

function pushAutomation(
  pending: PendingEvent[],
  counts: MutableCounts,
  channel: number,
  target: 'volume' | 'pan',
  controller: number,
  points: readonly TimelineAutomationPoint[],
  mapValue: (value: number) => number,
  maxTick: number,
): number {
  const first = points[0];
  if (first === undefined) {
    return 0;
  }

  const firstTick = beatToTick(first.timeBeats);
  if (firstTick !== 0) {
    pushController(
      pending,
      counts,
      channel,
      controller,
      mapValue(first.value),
      0,
      `${target}:hold`,
    );
  }

  let omitted = 0;
  for (const [index, point] of points.entries()) {
    const tick = beatToTick(point.timeBeats);
    if (tick > maxTick) {
      omitted += 1;
      continue;
    }
    const suffix = String(index).padStart(5, '0');
    pushController(
      pending,
      counts,
      channel,
      controller,
      mapValue(point.value),
      tick,
      `${target}:${suffix}`,
    );
  }

  return omitted;
}

function encodeTrackChunk(pending: readonly PendingEvent[]): number[] {
  const sorted = [...pending].sort(comparePending);
  const body: number[] = [];
  let lastTick = 0;

  for (const event of sorted) {
    if (event.tick < lastTick) {
      throw new Error('MIDI events are not ordered by tick.');
    }
    appendBytes(body, encodeVarLen(event.tick - lastTick));
    appendBytes(body, event.bytes);
    lastTick = event.tick;
  }

  const chunk = [0x4d, 0x54, 0x72, 0x6b];
  appendBytes(chunk, encodeUint32(body.length));
  appendBytes(chunk, body);
  return chunk;
}

function appendBytes(target: number[], source: readonly number[]): void {
  for (const byte of source) {
    target.push(byte);
  }
}

function buildTrackEvents(
  track: TimelineTrack,
  channel: number,
  maxTick: number,
  includeMixControllers: boolean,
  limitations: MidiLimitation[],
): TrackWork {
  const pending: PendingEvent[] = [];
  const counts = emptyCounts();
  const program = getProgramSelection(track.instrument);

  pending.push(createPending(0, 0, 0, '', encodeTextMeta(0x03, track.name)));
  counts.meta += 1;

  if (program !== null) {
    if (program.msb !== 0 || program.lsb !== 0) {
      pending.push(
        createPending(0, 1, MIDI_BANK_SELECT_MSB, '', [
          0xb0 | channel,
          MIDI_BANK_SELECT_MSB,
          program.msb,
        ]),
      );
      counts.controlChange += 1;
      pending.push(
        createPending(0, 2, MIDI_BANK_SELECT_LSB, '', [
          0xb0 | channel,
          MIDI_BANK_SELECT_LSB,
          program.lsb,
        ]),
      );
      counts.controlChange += 1;
    }
    pending.push(createPending(0, 3, 0, '', [0xc0 | channel, program.program]));
    counts.programChange += 1;
  } else if (track.instrument.type === 'builtin' || track.instrument.type === 'sfz') {
    limitations.push({
      code: 'program.not_encoded',
      message: `Track "${track.name}" uses a ${track.instrument.type} instrument with no direct MIDI program mapping. No program change is emitted.`,
      trackIndex: track.index,
      trackId: track.id,
      params: { trackId: track.id, instrumentType: track.instrument.type },
    });
  }

  const volumePoints = track.automation.volume;
  const panPoints = track.automation.pan;
  let omittedAutomation = 0;

  if (includeMixControllers) {
    if (volumePoints !== undefined) {
      omittedAutomation += pushAutomation(
        pending,
        counts,
        channel,
        'volume',
        MIDI_VOLUME_CONTROLLER,
        volumePoints,
        volumeToController,
        maxTick,
      );
    } else {
      pushController(
        pending,
        counts,
        channel,
        MIDI_VOLUME_CONTROLLER,
        volumeToController(track.volume),
        0,
        'volume:static',
      );
    }

    if (panPoints !== undefined) {
      omittedAutomation += pushAutomation(
        pending,
        counts,
        channel,
        'pan',
        MIDI_PAN_CONTROLLER,
        panPoints,
        panToController,
        maxTick,
      );
    } else {
      pushController(
        pending,
        counts,
        channel,
        MIDI_PAN_CONTROLLER,
        panToController(track.pan),
        0,
        'pan:static',
      );
    }
  }

  if (omittedAutomation > 0) {
    limitations.push({
      code: 'automation.after_end',
      message: `Track "${track.name}" has ${omittedAutomation} volume or pan keyframe(s) after the MIDI end tick. Those inaudible keyframes were omitted.`,
      trackIndex: track.index,
      trackId: track.id,
      params: { trackId: track.id, omittedKeyframes: omittedAutomation },
    });
  }

  if (track.automation.filterCutoffHz !== undefined) {
    limitations.push({
      code: 'automation.filter_not_encoded',
      message: `Track "${track.name}" has filter-cutoff automation. MIDI has no portable mapping for Vamp's low-pass cutoff, so it is not encoded.`,
      trackIndex: track.index,
      trackId: track.id,
      params: { trackId: track.id },
    });
  }

  if (track.effects.length > 0) {
    limitations.push({
      code: 'effects.not_encoded',
      message: `Track "${track.name}" has audio effects (${track.effects
        .map((effect) => effect.type)
        .join(
          ', ',
        )}). EQ, low-pass, delay, and reverb are not represented in a Standard MIDI File.`,
      trackIndex: track.index,
      trackId: track.id,
      params: { trackId: track.id, effects: track.effects.map((effect) => effect.type) },
    });
  }

  return { track, pending, counts, program };
}

function pushNoteEvents(
  events: readonly TimelineNoteEvent[],
  channel: number,
  pending: PendingEvent[],
  counts: MutableCounts,
): number {
  let contentEndTick = 0;

  for (const event of events) {
    const startTick = beatToTick(event.startBeat);
    const endTick = Math.max(startTick + 1, beatToTick(event.endBeat));
    contentEndTick = Math.max(contentEndTick, endTick);

    pending.push(
      createPending(startTick, 6, event.pitch, event.id, [
        0x90 | channel,
        event.pitch,
        event.velocity,
      ]),
    );
    counts.noteOn += 1;

    pending.push(
      createPending(endTick, 5, event.pitch, event.id, [0x80 | channel, event.pitch, 0]),
    );
    counts.noteOff += 1;
  }

  return contentEndTick;
}

function buildReport(
  timeline: SongTimeline,
  options: ResolvedMidiOptions,
  conductorCounts: MutableCounts,
  tracks: readonly TrackWork[],
  endTick: number,
  endTickSource: 'rendered' | 'content',
  renderedTick: number,
  contentEndTick: number,
  keySignature: MidiKeySignatureReport | null,
  limitations: readonly MidiLimitation[],
): MidiExportReport {
  const totalCounts = emptyCounts();
  addCounts(totalCounts, conductorCounts);

  const trackReports: MidiTrackReport[] = timeline.tracks.map((track) => {
    const work = tracks.find((entry) => entry.track.index === track.index);
    if (work === undefined) {
      return {
        timelineIndex: track.index,
        midiTrack: null,
        id: track.id,
        name: track.name,
        kind: track.kind,
        channel: track.channel,
        audible: track.audible,
        included: false,
        omitReason: 'inaudible',
        instrumentType: track.instrument.type,
        program: null,
        bank: null,
        eventCounts: finishCounts(emptyCounts()),
      };
    }

    addCounts(totalCounts, work.counts);
    return {
      timelineIndex: track.index,
      midiTrack: 1 + tracks.indexOf(work),
      id: track.id,
      name: track.name,
      kind: track.kind,
      channel: track.channel,
      audible: track.audible,
      included: true,
      omitReason: null,
      instrumentType: track.instrument.type,
      program: work.program === null ? null : work.program.program,
      bank: work.program === null ? null : { msb: work.program.msb, lsb: work.program.lsb },
      eventCounts: finishCounts(work.counts),
    };
  });

  const denominator = timeline.meta.timeSignature.denominator;
  const clocksPerClick = Math.max(1, Math.round((24 * 4) / denominator));
  const microsecondsPerQuarter = Math.round(60_000_000 / timeline.meta.bpm);

  return {
    format: MIDI_EXPORT_FORMAT,
    formatVersion: MIDI_EXPORT_FORMAT_VERSION,
    fileFormat: MIDI_FILE_FORMAT,
    ppq: MIDI_PPQ,
    title: timeline.meta.title,
    tempo: {
      bpm: timeline.meta.bpm,
      microsecondsPerQuarter,
      rounding: 'nearest',
    },
    timeSignature: {
      numerator: timeline.meta.timeSignature.numerator,
      denominator,
      denominatorExponent: denominatorExponent(denominator),
      clocksPerClick,
      thirtySecondsPerQuarter: 8,
    },
    keySignature,
    endMarker: options.endMarker,
    endTickSource,
    endTick,
    renderedTick,
    contentEndTick,
    renderedSeconds: timeline.renderedSeconds,
    includeInaudibleTracks: options.includeInaudibleTracks,
    includeMixControllers: options.includeMixControllers,
    trackCount: tracks.length,
    midiTrackCount: 1 + tracks.length,
    conductor: {
      midiTrack: 0,
      name: MIDI_CONDUCTOR_TRACK_NAME,
      eventCounts: finishCounts(conductorCounts),
    },
    tracks: trackReports,
    eventCounts: finishCounts(totalCounts),
    limitations: [...limitations].sort(
      (left, right) =>
        compareStrings(left.code, right.code) ||
        (left.trackIndex ?? -1) - (right.trackIndex ?? -1) ||
        compareStrings(left.message, right.message),
    ),
  };
}

function encodeTimeline(timeline: SongTimeline, options: ResolvedMidiOptions): MidiExportSuccess {
  const limitations: MidiLimitation[] = [];

  const microsecondsPerQuarter = Math.round(60_000_000 / timeline.meta.bpm);
  const denominator = timeline.meta.timeSignature.denominator;
  const clocksPerClick = Math.max(1, Math.round((24 * 4) / denominator));

  const conductorPending: PendingEvent[] = [];
  const conductorCounts = emptyCounts();

  conductorPending.push(
    createPending(0, 0, 0, '', encodeTextMeta(0x03, MIDI_CONDUCTOR_TRACK_NAME)),
  );
  conductorCounts.meta += 1;

  conductorPending.push(createPending(0, 1, 0, '', encodeTempoMeta(microsecondsPerQuarter)));
  conductorCounts.meta += 1;

  conductorPending.push(
    createPending(
      0,
      2,
      0,
      '',
      encodeTimeSignatureMeta(timeline.meta.timeSignature.numerator, denominator, clocksPerClick),
    ),
  );
  conductorCounts.meta += 1;

  const key = getKeySignature(timeline.meta.key as unknown as Record<string, unknown>);
  let keyReport: MidiKeySignatureReport | null = null;
  if (key === null) {
    limitations.push({
      code: 'key.not_encoded',
      message: `Key ${String(timeline.meta.key.tonic)} ${timeline.meta.key.mode} has no representable MIDI key signature. The key-signature meta event is omitted.`,
      params: {
        tonic: String(timeline.meta.key.tonic),
        mode: String(timeline.meta.key.mode),
      },
    });
  } else {
    conductorPending.push(
      createPending(0, 3, 0, '', encodeKeySignatureMeta(key.fifths, key.minor)),
    );
    conductorCounts.meta += 1;
    keyReport = {
      tonic: timeline.meta.key.tonic,
      mode: key.minor ? 'minor' : 'major',
      fifths: key.fifths,
      minor: key.minor,
      enharmonic: key.enharmonic,
    };
    if (key.enharmonic) {
      limitations.push({
        code: 'key.enharmonic',
        message: `Key ${timeline.meta.key.tonic} ${timeline.meta.key.mode} is encoded as the enharmonic MIDI key signature with ${Math.abs(key.fifths)} ${key.fifths < 0 ? 'flats' : 'sharps'}. MIDI stores only the circle-of-fifths count, not a tonic spelling.`,
        params: {
          tonic: timeline.meta.key.tonic,
          mode: timeline.meta.key.mode,
          fifths: key.fifths,
        },
      });
    }
  }

  const includedTracks = timeline.tracks.filter(
    (track) => options.includeInaudibleTracks || track.audible,
  );

  for (const track of includedTracks) {
    if (track.tailSeconds > 0) {
      limitations.push({
        code: 'audio.tail_not_encoded',
        message: `Track "${track.name}" has a ${track.tailSeconds}s audio effect tail estimate. MIDI encodes no audio tail; the end marker only reserves timeline time.`,
        trackIndex: track.index,
        trackId: track.id,
        params: { trackId: track.id, tailSeconds: track.tailSeconds },
      });
    }
  }

  if (
    options.includeMixControllers &&
    includedTracks.some(
      (track) => track.automation.volume !== undefined || track.automation.pan !== undefined,
    )
  ) {
    limitations.push({
      code: 'automation.keyframes_only',
      message:
        'Volume and pan automation is exported as keyframe controller events only. Controller values are held between events rather than smoothly interpolated by Vamp, and controller scaling is approximate.',
      params: { volumeController: MIDI_VOLUME_CONTROLLER, panController: MIDI_PAN_CONTROLLER },
    });
  }

  const includedIndexes = new Set(includedTracks.map((track) => track.index));

  let contentEndTick = 0;
  for (const event of timeline.events) {
    if (!includedIndexes.has(event.trackIndex)) {
      continue;
    }
    const startTick = beatToTick(event.startBeat);
    const endTick = Math.max(startTick + 1, beatToTick(event.endBeat));
    contentEndTick = Math.max(contentEndTick, endTick);
  }

  const renderedBeats = timeline.renderedSeconds / timeline.secondsPerBeat;
  const renderedTick = Math.max(0, beatToTick(renderedBeats));

  let endTick: number;
  let endTickSource: 'rendered' | 'content';
  if (options.endMarker === 'rendered') {
    if (renderedTick >= contentEndTick) {
      endTick = renderedTick;
      endTickSource = 'rendered';
    } else {
      endTick = contentEndTick;
      endTickSource = 'content';
    }
  } else {
    endTick = contentEndTick;
    endTickSource = 'content';
  }
  endTick = Math.max(endTick, contentEndTick, 0);

  const eventsByTrack = new Map<number, TimelineNoteEvent[]>();
  for (const event of timeline.events) {
    const bucket = eventsByTrack.get(event.trackIndex);
    if (bucket === undefined) {
      eventsByTrack.set(event.trackIndex, [event]);
    } else {
      bucket.push(event);
    }
  }

  const trackWorks: TrackWork[] = [];

  for (const track of includedTracks) {
    const work = buildTrackEvents(
      track,
      track.channel,
      endTick,
      options.includeMixControllers,
      limitations,
    );
    const events = eventsByTrack.get(track.index) ?? [];
    const trackContentEndTick = pushNoteEvents(events, track.channel, work.pending, work.counts);
    contentEndTick = Math.max(contentEndTick, trackContentEndTick);
    trackWorks.push(work);
  }

  conductorPending.push(createPending(endTick, 9, 0, '', encodeEndOfTrack()));
  conductorCounts.meta += 1;

  for (const work of trackWorks) {
    work.pending.push(createPending(endTick, 9, 0, '', encodeEndOfTrack()));
    work.counts.meta += 1;
  }

  const chunks: number[][] = [encodeTrackChunk(conductorPending)];
  for (const work of trackWorks) {
    chunks.push(encodeTrackChunk(work.pending));
  }

  const bytes: number[] = [
    0x4d,
    0x54,
    0x68,
    0x64,
    ...encodeUint32(6),
    ...encodeUint16(MIDI_FILE_FORMAT),
    ...encodeUint16(chunks.length),
    ...encodeUint16(MIDI_PPQ),
  ];
  for (const chunk of chunks) {
    appendBytes(bytes, chunk);
  }

  const report = buildReport(
    timeline,
    options,
    conductorCounts,
    trackWorks,
    endTick,
    endTickSource,
    renderedTick,
    contentEndTick,
    keyReport,
    limitations,
  );

  return { ok: true, bytes: Uint8Array.from(bytes), report };
}

/**
 * Export a canonical `SongTimeline` as a Type 1 Standard MIDI File.
 *
 * The timeline is read, never mutated. Notes are paired by their source event
 * id, quantized to `MIDI_PPQ`, and reordered at tick resolution so note-offs
 * precede note-ons at the same tick. Expected failures return structured
 * errors and do not throw. Identical timeline and options produce identical
 * bytes.
 */
export function exportMidi(
  timeline: SongTimeline,
  options: MidiExportOptions = {},
): MidiExportResult {
  const resolved = resolveMidiOptions(options);
  if (!resolved.ok) {
    return { ok: false, errors: resolved.errors };
  }

  const validation = validateTimeline(timeline);
  if (!validation.ok) {
    return { ok: false, errors: validation.errors };
  }

  try {
    return encodeTimeline(validation.timeline, resolved.value);
  } catch {
    return {
      ok: false,
      errors: [
        createMidiIssue(
          'midi.encode.failed',
          '',
          'MIDI encoding failed after the timeline passed validation.',
          'This indicates an internal exporter bug or an unsupported timeline value. Recompile the song and report the input if it persists.',
        ),
      ],
    };
  }
}
