import { parseMidi, type MidiEvent } from 'midi-file';
import { describe, expect, it } from 'vitest';

import type { SongSchemaV1 } from '@gxaditya/vamp-schema';

import {
  MIDI_EXPORT_FORMAT,
  MIDI_EXPORT_FORMAT_VERSION,
  MIDI_FILE_FORMAT,
  MIDI_PPQ,
  exportMidi,
  type MidiExportOptions,
  type MidiExportSuccess,
  type SongTimeline,
} from '../src/index.js';
import {
  baseSong,
  clipNote,
  clipTrack,
  compileOk,
  deepFreeze,
  loadValidFixture,
} from './helpers.js';

interface TimedEvent {
  readonly tick: number;
  readonly event: MidiEvent;
}

type TimedTrack = readonly TimedEvent[];

function compileFixture(name: string): SongTimeline {
  return compileOk(loadValidFixture(name), { sampleRate: 48000 }).timeline;
}

function parseTimedTracks(bytes: Uint8Array): {
  readonly header: ReturnType<typeof parseMidi>['header'];
  readonly tracks: readonly TimedTrack[];
} {
  const parsed = parseMidi(bytes);
  const tracks = parsed.tracks.map((events) => {
    let tick = 0;
    return events.map((event) => {
      tick += event.deltaTime;
      return { tick, event };
    });
  });
  return { header: parsed.header, tracks };
}

function eventsByType<T extends MidiEvent['type']>(
  track: TimedTrack,
  type: T,
): (TimedEvent & { readonly event: Extract<MidiEvent, { type: T }> })[] {
  return track.filter(
    (entry): entry is TimedEvent & { readonly event: Extract<MidiEvent, { type: T }> } =>
      entry.event.type === type,
  );
}

function exportOk(timeline: SongTimeline, options?: MidiExportOptions): MidiExportSuccess {
  const result = exportMidi(timeline, options);
  if (!result.ok) {
    throw new Error(`Expected MIDI export success: ${JSON.stringify(result.errors)}`);
  }
  return result;
}

function trackName(track: TimedTrack): string {
  const name = eventsByType(track, 'trackName')[0];
  if (name === undefined) {
    throw new Error('Expected a track-name meta event.');
  }
  return name.event.text;
}

function absoluteNoteEvents(track: TimedTrack, type: 'noteOn' | 'noteOff') {
  return eventsByType(track, type).map((entry) => ({
    tick: entry.tick,
    pitch: entry.event.noteNumber,
    velocity: entry.event.velocity,
    channel: entry.event.channel,
  }));
}

function controllerEvents(track: TimedTrack) {
  return eventsByType(track, 'controller').map((entry) => ({
    tick: entry.tick,
    controller: entry.event.controllerType,
    value: entry.event.value,
    channel: entry.event.channel,
  }));
}

function programEvents(track: TimedTrack) {
  return eventsByType(track, 'programChange').map((entry) => ({
    tick: entry.tick,
    program: entry.event.programNumber,
    channel: entry.event.channel,
  }));
}

function songWithKey(tonic: string, mode: string): SongSchemaV1 {
  const song = baseSong();
  return {
    ...song,
    meta: {
      ...song.meta,
      key: { tonic, mode } as SongSchemaV1['meta']['key'],
    },
  };
}

describe('MIDI header and conductor metadata', () => {
  it('emits a deterministic Type 1 file at 960 PPQ with conductor metadata', () => {
    const timeline = compileFixture('minimal.song.json');
    const result = exportOk(timeline);
    const { header, tracks } = parseTimedTracks(result.bytes);

    expect(header).toEqual({ format: 1, numTracks: 2, ticksPerBeat: 960 });
    expect(result.bytes[0]).toBe(0x4d);
    expect(result.bytes[1]).toBe(0x54);
    expect(result.bytes[2]).toBe(0x68);
    expect(result.bytes[3]).toBe(0x64);
    expect(result.report).toMatchObject({
      format: MIDI_EXPORT_FORMAT,
      formatVersion: MIDI_EXPORT_FORMAT_VERSION,
      fileFormat: MIDI_FILE_FORMAT,
      ppq: MIDI_PPQ,
      title: 'Minimal Vamp Song',
      endMarker: 'rendered',
      endTickSource: 'rendered',
      endTick: 7680,
      renderedTick: 7680,
      contentEndTick: 7200,
      trackCount: 1,
      midiTrackCount: 2,
    });
    expect(result.report.tempo).toEqual({
      bpm: 90,
      microsecondsPerQuarter: 666667,
      rounding: 'nearest',
    });
    expect(result.report.timeSignature).toEqual({
      numerator: 4,
      denominator: 4,
      denominatorExponent: 2,
      clocksPerClick: 24,
      thirtySecondsPerQuarter: 8,
    });
    expect(result.report.keySignature).toEqual({
      tonic: 'C',
      mode: 'major',
      fifths: 0,
      minor: false,
      enharmonic: false,
    });

    const conductor = tracks[0];
    expect(conductor).toBeDefined();
    if (conductor === undefined) {
      return;
    }
    expect(trackName(conductor)).toBe('Conductor');
    const tempo = eventsByType(conductor, 'setTempo');
    expect(tempo).toHaveLength(1);
    expect(tempo[0]?.tick).toBe(0);
    expect(tempo[0]?.event.microsecondsPerBeat).toBe(666667);
    const meter = eventsByType(conductor, 'timeSignature');
    expect(meter).toHaveLength(1);
    expect(meter[0]?.event).toMatchObject({
      numerator: 4,
      denominator: 4,
      metronome: 24,
      thirtyseconds: 8,
    });
    const key = eventsByType(conductor, 'keySignature');
    expect(key).toHaveLength(1);
    expect(key[0]?.event).toMatchObject({ key: 0, scale: 0 });
    expect(eventsByType(conductor, 'endOfTrack')[0]?.tick).toBe(7680);
  });

  it('maps the 6/8 effects fixture tempo, meter, and key signature', () => {
    const timeline = compileFixture('effects.song.json');
    const result = exportOk(timeline);
    const { tracks } = parseTimedTracks(result.bytes);
    const conductor = tracks[0];
    expect(conductor).toBeDefined();
    if (conductor === undefined) {
      return;
    }

    expect(result.report.tempo.microsecondsPerQuarter).toBe(625000);
    expect(result.report.timeSignature).toEqual({
      numerator: 6,
      denominator: 8,
      denominatorExponent: 3,
      clocksPerClick: 12,
      thirtySecondsPerQuarter: 8,
    });
    expect(result.report.keySignature).toMatchObject({
      tonic: 'F',
      mode: 'major',
      fifths: -1,
      minor: false,
    });
    expect(eventsByType(conductor, 'timeSignature')[0]?.event).toMatchObject({
      numerator: 6,
      denominator: 8,
      metronome: 12,
      thirtyseconds: 8,
    });
    expect(eventsByType(conductor, 'keySignature')[0]?.event).toMatchObject({
      key: -1,
      scale: 0,
    });
    expect(result.report.endTick).toBe(23040);
    expect(result.report.contentEndTick).toBe(5280);
  });
});

describe('named musical tracks, programs, and channels', () => {
  it('emits one named track per timeline track in order with GM and SoundFont programs', () => {
    const song = baseSong({
      tracks: [
        clipTrack('gm-bass', [clipNote(40, 0, 1)], {
          name: 'GM Bass',
          channel: 0,
          instrument: { type: 'gm', program: 40, bank: 2 },
        }),
        clipTrack('sf-strings', [clipNote(62, 0, 1)], {
          name: 'SF Strings',
          channel: 1,
          instrument: { type: 'soundfont', path: 'assets/strings.sf2', program: 48, bank: 128 },
        }),
        clipTrack('builtin-keys', [clipNote(64, 0, 1)], {
          name: 'Builtin Keys',
          channel: 3,
          instrument: { type: 'builtin', id: 'keys.soft' },
        }),
        clipTrack('sfz-flute', [clipNote(65, 0, 1)], {
          name: 'SFZ Flute',
          channel: 4,
          instrument: { type: 'sfz', path: 'assets/flute.sfz' },
        }),
      ],
    });

    const timeline = compileOk(song, { sampleRate: 48000 }).timeline;
    const result = exportOk(timeline);
    const { header, tracks } = parseTimedTracks(result.bytes);

    expect(header.numTracks).toBe(5);
    expect(tracks.map(trackName)).toEqual([
      'Conductor',
      'GM Bass',
      'SF Strings',
      'Builtin Keys',
      'SFZ Flute',
    ]);

    const bass = tracks[1];
    expect(bass).toBeDefined();
    if (bass === undefined) {
      return;
    }
    expect(controllerEvents(bass).slice(0, 2)).toEqual([
      { tick: 0, controller: 0, value: 0, channel: 0 },
      { tick: 0, controller: 32, value: 2, channel: 0 },
    ]);
    expect(programEvents(bass)).toEqual([{ tick: 0, program: 40, channel: 0 }]);
    expect(absoluteNoteEvents(bass, 'noteOn')).toEqual([
      { tick: 0, pitch: 40, velocity: 100, channel: 0 },
    ]);

    const strings = tracks[2];
    expect(strings).toBeDefined();
    if (strings === undefined) {
      return;
    }
    expect(controllerEvents(strings).slice(0, 2)).toEqual([
      { tick: 0, controller: 0, value: 1, channel: 1 },
      { tick: 0, controller: 32, value: 0, channel: 1 },
    ]);
    expect(programEvents(strings)).toEqual([{ tick: 0, program: 48, channel: 1 }]);

    const builtin = tracks[3];
    const sfz = tracks[4];
    expect(builtin).toBeDefined();
    expect(sfz).toBeDefined();
    if (builtin === undefined || sfz === undefined) {
      return;
    }
    expect(programEvents(builtin)).toEqual([]);
    expect(programEvents(sfz)).toEqual([]);
    expect(
      controllerEvents(builtin).filter(
        (event) => event.controller === 0 || event.controller === 32,
      ),
    ).toEqual([]);

    expect(result.report.tracks.map((track) => track.program)).toEqual([40, 48, null, null]);
    expect(result.report.tracks.map((track) => track.bank)).toEqual([
      { msb: 0, lsb: 2 },
      { msb: 1, lsb: 0 },
      null,
      null,
    ]);
    expect(result.report.limitations.map((limitation) => limitation.code)).toContain(
      'program.not_encoded',
    );
    expect(
      result.report.limitations.filter((item) => item.code === 'program.not_encoded'),
    ).toHaveLength(2);
  });

  it('uses channel 9 for drums and does not invent a melodic program for built-in kits', () => {
    const song = baseSong({
      tracks: [
        {
          id: 'drums',
          name: 'Builtin Kit',
          kind: 'drums',
          channel: 9,
          instrument: { type: 'builtin', id: 'drums.kit' },
          notes: [clipNote(36, 0, 0.25, 112), clipNote(42, 0.5, 0.25)],
        },
      ],
    });

    const timeline = compileOk(song, { sampleRate: 48000 }).timeline;
    const result = exportOk(timeline);
    const { tracks } = parseTimedTracks(result.bytes);
    const drums = tracks[1];
    expect(drums).toBeDefined();
    if (drums === undefined) {
      return;
    }

    expect(trackName(drums)).toBe('Builtin Kit');
    expect(programEvents(drums)).toEqual([]);
    expect(
      controllerEvents(drums).filter((event) => event.controller === 0 || event.controller === 32),
    ).toEqual([]);
    expect(absoluteNoteEvents(drums, 'noteOn')).toEqual([
      { tick: 0, pitch: 36, velocity: 112, channel: 9 },
      { tick: 480, pitch: 42, velocity: 100, channel: 9 },
    ]);
    expect(result.report.tracks[0]).toMatchObject({
      kind: 'drums',
      channel: 9,
      program: null,
      bank: null,
    });
    expect(result.report.limitations.map((limitation) => limitation.code)).toContain(
      'program.not_encoded',
    );
  });

  it('exports the drums fixture end to end with SoundFont bank 128 on channel 9', () => {
    const timeline = compileFixture('drums.song.json');
    const result = exportOk(timeline);
    const { header, tracks } = parseTimedTracks(result.bytes);

    expect(header.numTracks).toBe(2);
    const drums = tracks[1];
    expect(drums).toBeDefined();
    if (drums === undefined) {
      return;
    }
    expect(trackName(drums)).toBe('Drum Kit');
    expect(controllerEvents(drums).slice(0, 2)).toEqual([
      { tick: 0, controller: 0, value: 1, channel: 9 },
      { tick: 0, controller: 32, value: 0, channel: 9 },
    ]);
    expect(programEvents(drums)).toEqual([{ tick: 0, program: 0, channel: 9 }]);
    expect(absoluteNoteEvents(drums, 'noteOn')).toEqual([
      { tick: 0, pitch: 36, velocity: 112, channel: 9 },
      { tick: 480, pitch: 42, velocity: 100, channel: 9 },
      { tick: 960, pitch: 38, velocity: 104, channel: 9 },
      { tick: 1440, pitch: 42, velocity: 100, channel: 9 },
      { tick: 1920, pitch: 36, velocity: 112, channel: 9 },
      { tick: 2400, pitch: 42, velocity: 100, channel: 9 },
      { tick: 2880, pitch: 38, velocity: 104, channel: 9 },
      { tick: 3360, pitch: 46, velocity: 88, channel: 9 },
    ]);
    expect(result.report.tracks[0]).toMatchObject({
      program: 0,
      bank: { msb: 1, lsb: 0 },
    });
  });
});

describe('note timing, overlap, and ordering', () => {
  it('preserves beats, velocities, and note-off-before-note-on at equal ticks', () => {
    const timeline = compileFixture('minimal.song.json');
    const result = exportOk(timeline);
    const { tracks } = parseTimedTracks(result.bytes);
    const keys = tracks[1];
    expect(keys).toBeDefined();
    if (keys === undefined) {
      return;
    }

    expect(trackName(keys)).toBe('Keys');
    expect(absoluteNoteEvents(keys, 'noteOn')).toEqual([
      { tick: 0, pitch: 60, velocity: 100, channel: 0 },
      { tick: 0, pitch: 64, velocity: 100, channel: 0 },
      { tick: 0, pitch: 67, velocity: 100, channel: 0 },
      { tick: 3840, pitch: 72, velocity: 90, channel: 0 },
    ]);
    expect(absoluteNoteEvents(keys, 'noteOff')).toEqual([
      { tick: 3840, pitch: 60, velocity: 0, channel: 0 },
      { tick: 3840, pitch: 64, velocity: 0, channel: 0 },
      { tick: 3840, pitch: 67, velocity: 0, channel: 0 },
      { tick: 7200, pitch: 72, velocity: 0, channel: 0 },
    ]);

    const tick3840 = keys.filter((entry) => entry.tick === 3840).map((entry) => entry.event.type);
    expect(tick3840).toEqual(['noteOff', 'noteOff', 'noteOff', 'noteOn']);
  });

  it('preserves overlapping repeated pitches with distinct note-on velocities', () => {
    const timeline = compileFixture('free-notes.song.json');
    const result = exportOk(timeline);
    const { tracks } = parseTimedTracks(result.bytes);
    const lead = tracks[1];
    expect(lead).toBeDefined();
    if (lead === undefined) {
      return;
    }

    expect(absoluteNoteEvents(lead, 'noteOn')).toEqual([
      { tick: 0, pitch: 67, velocity: 96, channel: 0 },
      { tick: 960, pitch: 67, velocity: 72, channel: 0 },
      { tick: 1920, pitch: 71, velocity: 100, channel: 0 },
      { tick: 3840, pitch: 74, velocity: 100, channel: 0 },
    ]);
    expect(absoluteNoteEvents(lead, 'noteOff')).toEqual([
      { tick: 1920, pitch: 67, velocity: 0, channel: 0 },
      { tick: 2880, pitch: 67, velocity: 0, channel: 0 },
      { tick: 3840, pitch: 71, velocity: 0, channel: 0 },
      { tick: 7200, pitch: 74, velocity: 0, channel: 0 },
    ]);

    expect(
      lead.filter((entry) => entry.tick === 1920).map((entry) => `${entry.event.type}`),
    ).toEqual(['noteOff', 'noteOn']);
    expect(
      lead.filter((entry) => entry.tick === 3840).map((entry) => `${entry.event.type}`),
    ).toEqual(['noteOff', 'noteOn']);
  });

  it('reapplies note-off-before-note-on when quantization collapses distinct beats', () => {
    const song = baseSong({
      bpm: 120,
      tracks: [clipTrack('collapse', [clipNote(60, 0, 1.4 / 960), clipNote(62, 1.45 / 960, 1)])],
    });
    const timeline = compileOk(song, { sampleRate: 48000 }).timeline;
    const result = exportOk(timeline);
    const { tracks } = parseTimedTracks(result.bytes);
    const collapse = tracks[1];
    expect(collapse).toBeDefined();
    if (collapse === undefined) {
      return;
    }

    expect(collapse.filter((entry) => entry.tick === 1).map((entry) => entry.event.type)).toEqual([
      'noteOff',
      'noteOn',
    ]);
    expect(collapse.filter((entry) => entry.tick === 1)).toEqual([
      expect.objectContaining({
        event: expect.objectContaining({ type: 'noteOff', noteNumber: 60 }),
      }),
      expect.objectContaining({
        event: expect.objectContaining({ type: 'noteOn', noteNumber: 62 }),
      }),
    ]);
  });

  it('lengthens sub-tick notes to one tick instead of dropping them', () => {
    const song = baseSong({
      bpm: 300,
      tracks: [clipTrack('fast', [clipNote(60, 0, 0.0001)])],
    });
    const timeline = compileOk(song, { sampleRate: 48000 }).timeline;
    const result = exportOk(timeline);
    const { tracks } = parseTimedTracks(result.bytes);
    const fast = tracks[1];
    expect(fast).toBeDefined();
    if (fast === undefined) {
      return;
    }
    expect(absoluteNoteEvents(fast, 'noteOn')).toEqual([
      { tick: 0, pitch: 60, velocity: 100, channel: 0 },
    ]);
    expect(absoluteNoteEvents(fast, 'noteOff')).toEqual([
      { tick: 1, pitch: 60, velocity: 0, channel: 0 },
    ]);
  });
});

describe('automation controllers', () => {
  it('exports volume and pan keyframes as CC7 and CC10 with documented scaling', () => {
    const timeline = compileFixture('automation.song.json');
    const result = exportOk(timeline);
    const { tracks } = parseTimedTracks(result.bytes);
    const synth = tracks[1];
    expect(synth).toBeDefined();
    if (synth === undefined) {
      return;
    }

    expect(controllerEvents(synth)).toEqual([
      { tick: 0, controller: 7, value: 60, channel: 0 },
      { tick: 0, controller: 10, value: 32, channel: 0 },
      { tick: 7680, controller: 7, value: 100, channel: 0 },
      { tick: 15360, controller: 7, value: 0, channel: 0 },
      { tick: 15360, controller: 10, value: 95, channel: 0 },
    ]);
    expect(result.report.limitations.map((limitation) => limitation.code)).toEqual(
      expect.arrayContaining([
        'automation.keyframes_only',
        'automation.filter_not_encoded',
        'effects.not_encoded',
        'audio.tail_not_encoded',
      ]),
    );
    expect(result.report.keySignature).toMatchObject({
      tonic: 'D',
      mode: 'minor',
      fifths: -1,
      minor: true,
    });
  });

  it('holds the first automation value from tick zero when its keyframe starts later', () => {
    const song = baseSong({
      tracks: [
        clipTrack('auto', [clipNote(60, 0, 4)], {
          channel: 0,
          automation: {
            volume: {
              points: [
                { time: 2, value: 0.5 },
                { time: 4, value: 1.5 },
              ],
            },
          },
        }),
      ],
    });
    const timeline = compileOk(song, { sampleRate: 48000 }).timeline;
    const result = exportOk(timeline);
    const { tracks } = parseTimedTracks(result.bytes);
    const auto = tracks[1];
    expect(auto).toBeDefined();
    if (auto === undefined) {
      return;
    }
    expect(controllerEvents(auto).filter((event) => event.controller === 7)).toEqual([
      { tick: 0, controller: 7, value: 50, channel: 0 },
      { tick: 1920, controller: 7, value: 50, channel: 0 },
      { tick: 3840, controller: 7, value: 114, channel: 0 },
    ]);
  });

  it('omits automation keyframes that fall after the end marker and reports it', () => {
    const song = baseSong({
      durationHint: 1,
      tracks: [
        clipTrack('late-auto', [clipNote(60, 0, 1)], {
          channel: 0,
          automation: {
            volume: {
              points: [
                { time: 0, value: 1 },
                { time: 8, value: 0 },
              ],
            },
          },
        }),
      ],
    });
    const timeline = compileOk(song, { sampleRate: 48000 }).timeline;
    const result = exportOk(timeline);
    const { tracks } = parseTimedTracks(result.bytes);
    const auto = tracks[1];
    expect(auto).toBeDefined();
    if (auto === undefined) {
      return;
    }
    expect(result.report.endTick).toBe(960);
    expect(controllerEvents(auto).filter((event) => event.controller === 7)).toEqual([
      { tick: 0, controller: 7, value: 100, channel: 0 },
    ]);
    expect(eventsByType(auto, 'endOfTrack')[0]?.tick).toBe(960);
    expect(result.report.limitations.map((limitation) => limitation.code)).toContain(
      'automation.after_end',
    );
  });

  it('emits static volume and pan when a track has no automation target', () => {
    const timeline = compileFixture('effects.song.json');
    const result = exportOk(timeline);
    const { tracks } = parseTimedTracks(result.bytes);
    const guitar = tracks[1];
    expect(guitar).toBeDefined();
    if (guitar === undefined) {
      return;
    }
    expect(controllerEvents(guitar)).toEqual([
      { tick: 0, controller: 7, value: 75, channel: 2 },
      { tick: 0, controller: 10, value: 73, channel: 2 },
    ]);
  });
});

describe('audibility policy', () => {
  it('omits inaudible tracks by default and can include them explicitly', () => {
    const timeline = compileFixture('free-notes.song.json');

    const omittedResult = exportOk(timeline);
    const omittedParsed = parseTimedTracks(omittedResult.bytes);
    expect(omittedParsed.tracks.map(trackName)).toEqual(['Conductor', 'Soft Lead']);
    expect(omittedResult.report.trackCount).toBe(1);
    expect(omittedResult.report.tracks).toHaveLength(2);
    expect(omittedResult.report.tracks[1]).toMatchObject({
      id: 'pad',
      included: false,
      midiTrack: null,
      omitReason: 'inaudible',
      audible: false,
    });

    const includedResult = exportOk(timeline, { includeInaudibleTracks: true });
    const includedParsed = parseTimedTracks(includedResult.bytes);
    expect(includedParsed.tracks.map(trackName)).toEqual(['Conductor', 'Soft Lead', 'Quiet Pad']);
    expect(includedResult.report.trackCount).toBe(2);
    expect(includedResult.report.tracks[1]).toMatchObject({
      id: 'pad',
      included: true,
      midiTrack: 2,
      omitReason: null,
      audible: false,
    });
    expect(includedResult.report.tracks[0]).toMatchObject({
      id: 'lead',
      audible: true,
      included: true,
    });
  });

  it('emits a conductor-only file when every track is inaudible and omission is used', () => {
    const song = baseSong({
      tracks: [clipTrack('muted', [clipNote(60, 0, 1)], { mute: true })],
    });
    const timeline = compileOk(song, { sampleRate: 48000 }).timeline;
    const result = exportOk(timeline);
    const { header, tracks } = parseTimedTracks(result.bytes);
    expect(header.numTracks).toBe(1);
    expect(tracks).toHaveLength(1);
    expect(result.report.trackCount).toBe(0);
    expect(result.report.midiTrackCount).toBe(1);
    expect(result.report.tracks[0]).toMatchObject({ included: false, omitReason: 'inaudible' });
  });
});

describe('end marker', () => {
  it('follows renderedSeconds by default and content end on request', () => {
    const timeline = compileFixture('automation.song.json');

    const rendered = exportOk(timeline);
    expect(rendered.report.endMarker).toBe('rendered');
    expect(rendered.report.endTickSource).toBe('rendered');
    expect(rendered.report.endTick).toBe(23040);
    expect(rendered.report.contentEndTick).toBe(15360);
    const renderedParsed = parseTimedTracks(rendered.bytes);
    expect(
      renderedParsed.tracks.map((track) => eventsByType(track, 'endOfTrack')[0]?.tick),
    ).toEqual([23040, 23040]);

    const content = exportOk(timeline, { endMarker: 'content' });
    expect(content.report.endMarker).toBe('content');
    expect(content.report.endTickSource).toBe('content');
    expect(content.report.endTick).toBe(15360);
    const contentParsed = parseTimedTracks(content.bytes);
    expect(contentParsed.tracks.map((track) => eventsByType(track, 'endOfTrack')[0]?.tick)).toEqual(
      [15360, 15360],
    );
  });

  it('never places the end marker before included note content', () => {
    const song = baseSong({
      durationHint: 1,
      tracks: [
        clipTrack('long-muted', [clipNote(60, 0, 8)], { mute: true }),
        clipTrack('short', [clipNote(62, 0, 1)], { channel: 1 }),
      ],
    });
    const timeline = compileOk(song, { sampleRate: 48000 }).timeline;
    const result = exportOk(timeline, {
      includeInaudibleTracks: true,
      endMarker: 'rendered',
    });
    expect(result.report.renderedTick).toBe(960);
    expect(result.report.contentEndTick).toBe(7680);
    expect(result.report.endTick).toBe(7680);
    expect(result.report.endTickSource).toBe('content');
  });
});

describe('key signatures', () => {
  it.each([
    ['C', 'major', 0, false, false],
    ['C#', 'major', 7, false, false],
    ['F#', 'major', 6, false, false],
    ['F', 'major', -1, false, false],
    ['D#', 'major', -3, false, true],
    ['G#', 'major', -4, false, true],
    ['A#', 'major', -2, false, true],
    ['A', 'minor', 0, true, false],
    ['D', 'minor', -1, true, false],
    ['D#', 'minor', 6, true, false],
    ['G#', 'minor', 5, true, false],
    ['A#', 'minor', 7, true, false],
  ])(
    'maps %s %s to fifths %i, minor %s, enharmonic %s',
    (tonic, mode, fifths, minor, enharmonic) => {
      const song = songWithKey(tonic, mode);
      const timeline = compileOk(song, { sampleRate: 48000 }).timeline;
      const result = exportOk(timeline);
      expect(result.report.keySignature).toEqual({
        tonic,
        mode,
        fifths,
        minor,
        enharmonic,
      });
      const { tracks } = parseTimedTracks(result.bytes);
      const key = tracks[0] === undefined ? undefined : eventsByType(tracks[0], 'keySignature')[0];
      expect(key?.event).toMatchObject({ key: fifths, scale: minor ? 1 : 0 });
    },
  );
});

describe('determinism and report integrity', () => {
  it('produces byte-identical output and does not mutate the timeline', () => {
    const timeline = deepFreeze(compileFixture('effects.song.json'));
    const first = exportOk(timeline);
    const second = exportOk(timeline);

    expect(Array.from(first.bytes)).toEqual(Array.from(second.bytes));
    expect(first.report).toEqual(second.report);
    expect(first.bytes).not.toBe(second.bytes);

    const parsed = parseTimedTracks(first.bytes);
    expect(parsed.header).toEqual({ format: 1, numTracks: 2, ticksPerBeat: 960 });
  });

  it('reports event counts that match an independent parse', () => {
    const timeline = compileFixture('free-notes.song.json');
    const result = exportOk(timeline, { includeInaudibleTracks: true });
    const { tracks } = parseTimedTracks(result.bytes);
    const all = tracks.flatMap((track) => track.map((entry) => entry.event));

    const counts = {
      noteOn: all.filter((event) => event.type === 'noteOn').length,
      noteOff: all.filter((event) => event.type === 'noteOff').length,
      controlChange: all.filter((event) => event.type === 'controller').length,
      programChange: all.filter((event) => event.type === 'programChange').length,
      meta: all.filter(
        (event) =>
          event.type !== 'noteOn' &&
          event.type !== 'noteOff' &&
          event.type !== 'controller' &&
          event.type !== 'programChange',
      ).length,
      total: all.length,
    };
    expect(result.report.eventCounts).toEqual(counts);
    expect(result.report.conductor.eventCounts.meta).toBe(5);
    expect(result.report.tracks.map((track) => track.eventCounts.total)).toEqual([12, 10]);
  });
});
