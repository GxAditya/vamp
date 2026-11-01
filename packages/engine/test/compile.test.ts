import { describe, expect, it } from 'vitest';

import { validateSong } from '@gxaditya/vamp-schema';

import {
  COMPILE_LIMITS,
  compileSong,
  compileValidatedSong,
  getTimelineBoundaries,
  type CompileSongFailure,
  type CompileSongOptions,
  type SampleRate,
} from '../src/index.js';
import {
  baseSong,
  clipNote,
  clipTrack,
  compileOk,
  deepFreeze,
  loadValidFixture,
} from './helpers.js';

function compileFailure(song: unknown, options: CompileSongOptions): CompileSongFailure {
  const result = compileSong(song, options);
  if (result.ok) {
    throw new Error('Expected compile failure.');
  }
  return result;
}

describe('compileSong free notes', () => {
  it('compiles the minimal fixture into an exact canonical timeline', () => {
    const result = compileOk(loadValidFixture('minimal.song.json'), { sampleRate: 48000 });
    const timeline = result.timeline;

    expect(timeline.format).toBe('vamp.timeline');
    expect(timeline.formatVersion).toBe(1);
    expect(timeline.schemaVersion).toBe('1.0.0');
    expect(timeline.sampleRate).toBe(48000);
    expect(timeline.beatsPerBar).toBe(4);
    expect(timeline.secondsPerBeat).toBeCloseTo(2 / 3, 12);
    expect(timeline.hintSeconds).toBeCloseTo(16 / 3, 12);
    expect(timeline.lastSoundSeconds).toBeCloseTo(5, 12);
    expect(timeline.renderedSeconds).toBeCloseTo(16 / 3, 12);
    expect(timeline.renderedSamples).toBe(Math.ceil(timeline.renderedSeconds * 48000));
    expect(timeline.renderedSamples).toBe(256000);
    expect(timeline.meta).toMatchObject({
      title: 'Minimal Vamp Song',
      bpm: 90,
      seed: 1,
      durationHintBeats: 8,
      timeSignature: { numerator: 4, denominator: 4 },
      key: { tonic: 'C', mode: 'major' },
    });
    expect(timeline.meta).not.toHaveProperty('mood');
    expect(timeline.meta).not.toHaveProperty('tags');
    expect(timeline.meta).not.toHaveProperty('createdAt');

    expect(timeline.tracks).toHaveLength(1);
    expect(timeline.tracks[0]).toMatchObject({
      index: 0,
      id: 'keys',
      name: 'Keys',
      kind: 'midi',
      channel: 0,
      instrument: { type: 'builtin', id: 'keys.soft' },
      audible: true,
      mute: false,
      solo: false,
      volume: 1,
      pan: 0,
      automation: {},
      effects: [],
      contentEndBeats: 7.5,
      contentEndSeconds: 5,
      tailSeconds: 0,
      endSeconds: 5,
      eventCount: 4,
    });

    expect(
      timeline.events.map((event) => [
        event.id,
        event.trackId,
        event.pitch,
        event.velocity,
        event.startBeat,
        event.durationBeats,
        event.endBeat,
        event.startSample,
        event.endSample,
      ]),
    ).toEqual([
      ['keys:free:0', 'keys', 60, 100, 0, 4, 4, 0, 128000],
      ['keys:free:1', 'keys', 64, 100, 0, 4, 4, 0, 128000],
      ['keys:free:2', 'keys', 67, 100, 0, 4, 4, 0, 128000],
      ['keys:free:3', 'keys', 72, 90, 4, 3.5, 7.5, 128000, 240000],
    ]);

    expect(timeline.stats).toEqual({
      trackCount: 1,
      authoredNoteCount: 4,
      expandedNoteCount: 4,
      audibleEventCount: 4,
    });
    expect(result.warnings).toEqual([]);
  });

  it('consumes normalized defaults for velocity, repeat, banks, and effects', () => {
    const song = baseSong({
      durationHint: 8,
      patterns: [{ id: 'once', lengthBeats: 2, notes: [clipNote(64, 0, 1)] }],
      tracks: [
        clipTrack('defaults', [clipNote(60, 0, 1)], {
          placements: [{ pattern: 'once', start: 2 }],
          instrument: { type: 'gm', program: 0 },
          effects: [{ type: 'reverb' }, { type: 'delay' }, { type: 'eq' }, { type: 'lowpass' }],
        }),
        clipTrack('sf', [clipNote(50, 0, 1)], {
          channel: 1,
          instrument: { type: 'soundfont', path: 'assets/x.sf2', program: 1 },
        }),
      ],
    });

    const timeline = compileOk(song).timeline;

    expect(timeline.tracks[0]).toMatchObject({
      volume: 1,
      pan: 0,
      mute: false,
      solo: false,
      instrument: { type: 'gm', program: 0, bank: 0 },
    });
    expect(timeline.tracks[1]?.instrument).toEqual({
      type: 'soundfont',
      path: 'assets/x.sf2',
      program: 1,
      bank: 0,
    });

    expect(
      timeline.events.map((event) => [event.trackId, event.pitch, event.velocity, event.startBeat]),
    ).toEqual([
      ['defaults', 60, 100, 0],
      ['sf', 50, 100, 0],
      ['defaults', 64, 100, 2],
    ]);
    expect(timeline.events.filter((event) => event.source.type === 'pattern')).toHaveLength(1);

    expect(timeline.tracks[0]?.effects).toEqual([
      { type: 'reverb', mix: 0.25, decaySeconds: 1.8 },
      { type: 'delay', timeMs: 375, feedback: 0.35, mix: 0.25 },
      { type: 'eq', lowGainDb: 0, midGainDb: 0, highGainDb: 0 },
      { type: 'lowpass', cutoffHz: 20000, q: 1 },
    ]);
    expect(timeline.tracks[0]?.tailSeconds).toBeCloseTo(4.425, 12);
  });

  it('merges free notes and pattern placements on the same song-relative timeline', () => {
    const song = baseSong({
      bpm: 120,
      durationHint: 16,
      patterns: [
        { id: 'pulse', lengthBeats: 4, notes: [clipNote(60, 0, 1)] },
        { id: 'implicit', notes: [clipNote(62, 0, 1.5)] },
      ],
      tracks: [
        clipTrack('explicit', [clipNote(72, 1, 1)], {
          channel: 0,
          placements: [{ pattern: 'pulse', start: 2, repeat: 3 }],
        }),
        clipTrack('implicit', [], {
          channel: 1,
          placements: [{ pattern: 'implicit', start: 0, repeat: 3 }],
        }),
      ],
    });

    const timeline = compileOk(song).timeline;

    expect(
      timeline.events.map((event) => [
        event.id,
        event.trackId,
        event.pitch,
        event.startBeat,
        event.endBeat,
      ]),
    ).toEqual([
      ['implicit:placement:0:0:0', 'implicit', 62, 0, 1.5],
      ['explicit:free:0', 'explicit', 72, 1, 2],
      ['implicit:placement:0:1:0', 'implicit', 62, 1.5, 3],
      ['explicit:placement:0:0:0', 'explicit', 60, 2, 3],
      ['implicit:placement:0:2:0', 'implicit', 62, 3, 4.5],
      ['explicit:placement:0:1:0', 'explicit', 60, 6, 7],
      ['explicit:placement:0:2:0', 'explicit', 60, 10, 11],
    ]);

    expect(timeline.stats).toEqual({
      trackCount: 2,
      authoredNoteCount: 3,
      expandedNoteCount: 7,
      audibleEventCount: 7,
    });
    expect(timeline.tracks.map((track) => track.eventCount)).toEqual([4, 3]);
    expect(timeline.tracks[0]?.contentEndBeats).toBe(11);
    expect(timeline.tracks[0]?.contentEndSeconds).toBe(5.5);
  });

  it('uses the real pattern fixture, including its implicit 7.5 beat length', () => {
    const timeline = compileOk(loadValidFixture('patterns.song.json')).timeline;

    expect(timeline.stats).toMatchObject({
      trackCount: 2,
      authoredNoteCount: 12,
      expandedNoteCount: 80,
      audibleEventCount: 80,
    });
    expect(timeline.tracks.map((track) => track.eventCount)).toEqual([64, 16]);
    expect(timeline.tracks[0]?.contentEndBeats).toBe(32);
    expect(timeline.tracks[1]?.contentEndBeats).toBe(30);

    const secondBassPlay = timeline.events.find((event) => event.id === 'bass:placement:0:1:0');
    expect(secondBassPlay).toMatchObject({
      trackId: 'bass',
      pitch: 45,
      startBeat: 7.5,
      endBeat: 9,
      source: {
        type: 'pattern',
        patternId: 'bassline',
        placementIndex: 0,
        playIndex: 1,
        noteIndex: 0,
      },
    });

    const sampleAtSevenAndAHalfBeats = Math.round(7.5 * (60 / 112) * 48000);
    expect(secondBassPlay?.startSample).toBe(sampleAtSevenAndAHalfBeats);
    const boundariesAtSample = getTimelineBoundaries(timeline).filter(
      (boundary) => boundary.timeSample === sampleAtSevenAndAHalfBeats,
    );
    expect(boundariesAtSample[0]?.kind).toBe('note-off');
  });
});

describe('compileSong ordering', () => {
  it('orders simultaneous events by track, then pitch, then source order', () => {
    const song = baseSong({
      tracks: [
        clipTrack('first', [clipNote(64, 0, 1), clipNote(60, 0, 1), clipNote(60, 0.5, 1)], {
          channel: 0,
        }),
        clipTrack('second', [clipNote(48, 0, 1)], { channel: 1 }),
      ],
    });

    const timeline = compileOk(song).timeline;
    expect(
      timeline.events.map((event) => [event.trackId, event.pitch, event.startBeat, event.velocity]),
    ).toEqual([
      ['first', 60, 0, 100],
      ['first', 64, 0, 100],
      ['second', 48, 0, 100],
      ['first', 60, 0.5, 100],
    ]);
    expect(timeline.events.map((event) => event.id)).toEqual([
      'first:free:1',
      'first:free:0',
      'second:free:0',
      'first:free:2',
    ]);
  });

  it('orders note-offs before note-ons at equal sample timestamps', () => {
    const song = baseSong({
      tracks: [clipTrack('keys', [clipNote(60, 0, 2), clipNote(60, 2, 2), clipNote(62, 2, 1)])],
    });

    const timeline = compileOk(song).timeline;
    const atBeatTwo = getTimelineBoundaries(timeline).filter(
      (boundary) => boundary.timeSample === 48000,
    );

    expect(atBeatTwo.map((boundary) => [boundary.kind, boundary.eventId, boundary.pitch])).toEqual([
      ['note-off', 'keys:free:0', 60],
      ['note-on', 'keys:free:1', 60],
      ['note-on', 'keys:free:2', 62],
    ]);
  });

  it('orders note-offs before note-ons when sample rounding collapses distinct beats', () => {
    const song = baseSong({
      tracks: [clipTrack('keys', [clipNote(60, 0, 2.000001), clipNote(62, 2, 1)])],
    });

    const timeline = compileOk(song).timeline;
    const atSample = getTimelineBoundaries(timeline).filter(
      (boundary) => boundary.timeSample === 48000,
    );

    expect(
      atSample.map((boundary) => [boundary.kind, boundary.eventId, boundary.timeBeats]),
    ).toEqual([
      ['note-off', 'keys:free:0', 2.000001],
      ['note-on', 'keys:free:1', 2],
    ]);
  });

  it('keeps overlapping same-pitch notes distinct with deterministic boundaries', () => {
    const song = baseSong({
      tracks: [
        clipTrack('keys', [
          clipNote(60, 0, 4, 100),
          clipNote(60, 1, 4, 60),
          clipNote(60, 1, 2, 90),
        ]),
      ],
    });

    const timeline = compileOk(song).timeline;

    expect(
      timeline.events.map((event) => ({
        id: event.id,
        start: event.startBeat,
        end: event.endBeat,
        velocity: event.velocity,
      })),
    ).toEqual([
      { id: 'keys:free:0', start: 0, end: 4, velocity: 100 },
      { id: 'keys:free:1', start: 1, end: 5, velocity: 60 },
      { id: 'keys:free:2', start: 1, end: 3, velocity: 90 },
    ]);

    expect(
      getTimelineBoundaries(timeline).map((boundary) => [
        boundary.kind,
        boundary.eventId,
        boundary.timeBeats,
      ]),
    ).toEqual([
      ['note-on', 'keys:free:0', 0],
      ['note-on', 'keys:free:1', 1],
      ['note-on', 'keys:free:2', 1],
      ['note-off', 'keys:free:2', 3],
      ['note-off', 'keys:free:0', 4],
      ['note-off', 'keys:free:1', 5],
    ]);
  });
});

describe('compileSong meter handling', () => {
  it('keeps 7/8 beat positions exact and never snaps to bars', () => {
    const song = baseSong({
      bpm: 120,
      durationHint: 7,
      timeSignature: { numerator: 7, denominator: 8 },
      patterns: [{ id: 'seven', lengthBeats: 3.5, notes: [clipNote(60, 0, 0.5)] }],
      tracks: [
        clipTrack('meter', [clipNote(72, 3.25, 0.25)], {
          placements: [{ pattern: 'seven', start: 0, repeat: 2 }],
        }),
      ],
    });

    const timeline = compileOk(song).timeline;

    expect(timeline.beatsPerBar).toBe(3.5);
    expect(timeline.meta.timeSignature).toEqual({ numerator: 7, denominator: 8 });
    expect(
      timeline.events.map((event) => [
        event.id,
        event.startBeat,
        event.endBeat,
        event.startSample,
        event.endSample,
      ]),
    ).toEqual([
      ['meter:placement:0:0:0', 0, 0.5, 0, 12000],
      ['meter:free:0', 3.25, 3.5, 78000, 84000],
      ['meter:placement:0:1:0', 3.5, 4, 84000, 96000],
    ]);
    expect(timeline.tracks[0]?.contentEndBeats).toBe(4);
    expect(timeline.hintSeconds).toBe(3.5);
    expect(timeline.renderedSeconds).toBe(3.5);
    expect(timeline.renderedSamples).toBe(168000);
  });

  it('exposes beats per bar for a 6/8 effects fixture without changing timing', () => {
    const timeline = compileOk(loadValidFixture('effects.song.json')).timeline;
    expect(timeline.beatsPerBar).toBe(3);
    expect(timeline.meta.timeSignature).toEqual({ numerator: 6, denominator: 8 });
    expect(timeline.events.map((event) => event.startBeat)).toEqual([0, 1, 2, 4]);
  });
});

describe('compileSong audibility', () => {
  it('retains muted and non-soloed tracks and events with explicit audibility flags', () => {
    const timeline = compileOk(loadValidFixture('free-notes.song.json')).timeline;

    expect(
      timeline.tracks.map((track) => [track.id, track.audible, track.mute, track.solo]),
    ).toEqual([
      ['lead', true, false, true],
      ['pad', false, true, false],
    ]);
    expect(timeline.events).toHaveLength(7);
    expect(
      timeline.events.filter((event) => event.trackId === 'lead').every((event) => event.audible),
    ).toBe(true);
    expect(
      timeline.events.filter((event) => event.trackId === 'pad').every((event) => !event.audible),
    ).toBe(true);
    expect(timeline.stats).toMatchObject({
      authoredNoteCount: 7,
      expandedNoteCount: 7,
      audibleEventCount: 4,
    });
    expect(timeline.lastSoundSeconds).toBeCloseTo(4.5, 12);
    expect(timeline.renderedSeconds).toBeCloseTo(9.6, 12);
    expect(timeline.meta).not.toHaveProperty('createdAt');
  });

  it('makes non-soloed tracks inaudible when another track is soloed', () => {
    const song = baseSong({
      tracks: [
        clipTrack('lead', [clipNote(60, 0, 1)], { solo: true }),
        clipTrack('bed', [clipNote(62, 0, 1)], { channel: 1 }),
      ],
    });

    const timeline = compileOk(song).timeline;
    expect(timeline.tracks.map((track) => [track.id, track.audible])).toEqual([
      ['lead', true],
      ['bed', false],
    ]);
    expect(timeline.events.find((event) => event.trackId === 'bed')?.audible).toBe(false);
    expect(timeline.stats.audibleEventCount).toBe(1);
  });

  it('keeps fully muted songs silent while preserving events and ignoring tails', () => {
    const song = baseSong({
      durationHint: 4,
      tracks: [
        clipTrack('muted', [clipNote(60, 0, 1)], {
          mute: true,
          effects: [{ type: 'reverb', decaySeconds: 2 }],
        }),
      ],
    });

    const timeline = compileOk(song).timeline;
    expect(timeline.tracks[0]).toMatchObject({
      audible: false,
      mute: true,
      contentEndBeats: 1,
      contentEndSeconds: 0.5,
      tailSeconds: 0,
      endSeconds: 0.5,
      eventCount: 1,
    });
    expect(timeline.events).toHaveLength(1);
    expect(timeline.events[0]?.audible).toBe(false);
    expect(timeline.lastSoundSeconds).toBe(0);
    expect(timeline.renderedSeconds).toBe(2);
    expect(timeline.renderedSamples).toBe(96000);
    expect(getTimelineBoundaries(timeline).every((boundary) => !boundary.audible)).toBe(true);
  });
});

describe('compileSong duration and tails', () => {
  it('extends a too-short hint through the audible content', () => {
    const timeline = compileOk(
      baseSong({
        durationHint: 4,
        tracks: [clipTrack('long', [clipNote(60, 0, 8)])],
      }),
    ).timeline;

    expect(timeline.hintSeconds).toBe(2);
    expect(timeline.lastSoundSeconds).toBe(4);
    expect(timeline.renderedSeconds).toBe(4);
    expect(timeline.renderedSamples).toBe(192000);
    expect(timeline.tracks[0]).toMatchObject({
      contentEndBeats: 8,
      contentEndSeconds: 4,
      tailSeconds: 0,
      endSeconds: 4,
    });
  });

  it('extends a too-short hint through an effect tail', () => {
    const timeline = compileOk(
      baseSong({
        durationHint: 2,
        tracks: [
          clipTrack('tail', [clipNote(60, 0, 4)], {
            effects: [{ type: 'reverb', decaySeconds: 2 }],
          }),
        ],
      }),
    ).timeline;

    expect(timeline.hintSeconds).toBe(1);
    expect(timeline.tracks[0]).toMatchObject({
      contentEndBeats: 4,
      contentEndSeconds: 2,
      tailSeconds: 2,
      endSeconds: 4,
    });
    expect(timeline.lastSoundSeconds).toBe(4);
    expect(timeline.renderedSeconds).toBe(4);
    expect(timeline.renderedSamples).toBe(192000);
  });

  it('keeps trailing silence when the hint is longer than content and tails', () => {
    const timeline = compileOk(
      baseSong({
        durationHint: 8,
        tracks: [clipTrack('short', [clipNote(60, 0, 2)])],
      }),
    ).timeline;

    expect(timeline.lastSoundSeconds).toBe(1);
    expect(timeline.renderedSeconds).toBe(4);
    expect(timeline.renderedSamples).toBe(192000);
  });

  it('accepts exactly 600 rendered seconds at 48 kHz', () => {
    const timeline = compileOk(
      baseSong({
        bpm: 300,
        durationHint: 3000,
        tracks: [clipTrack('keys', [clipNote(60, 0, 4)])],
      }),
    ).timeline;

    expect(timeline.renderedSeconds).toBe(600);
    expect(timeline.renderedSamples).toBe(28800000);
    expect(timeline.lastSoundSeconds).toBeCloseTo(0.8, 12);
  });

  it('uses the shared duration helper for automated fixtures and effect tails', () => {
    const timeline = compileOk(loadValidFixture('automation.song.json')).timeline;
    const track = timeline.tracks[0];

    expect(track).toMatchObject({ contentEndBeats: 16, tailSeconds: 2.4 });
    expect(track?.endSeconds).toBeCloseTo(16 * (60 / 84) + 2.4, 12);
    expect(timeline.hintSeconds).toBeCloseTo(24 * (60 / 84), 12);
    expect(timeline.renderedSeconds).toBeCloseTo(timeline.hintSeconds, 12);
    expect(timeline.tracks[0]?.effects).toEqual([
      { type: 'lowpass', q: 0.9 },
      { type: 'reverb', mix: 0.2, decaySeconds: 2.4 },
    ]);
  });

  it('uses the shared 30 second per-track tail cap', () => {
    const timeline = compileOk(
      baseSong({
        durationHint: 1,
        tracks: [
          clipTrack('tail', [clipNote(60, 0, 1)], {
            effects: [
              { type: 'delay', timeMs: 2000, feedback: 0.9, mix: 0.5 },
              { type: 'reverb', decaySeconds: 10, mix: 0.5 },
            ],
          }),
        ],
      }),
    ).timeline;

    expect(timeline.tracks[0]).toMatchObject({
      contentEndBeats: 1,
      tailSeconds: 30,
      endSeconds: 30.5,
    });
    expect(timeline.lastSoundSeconds).toBe(30.5);
    expect(timeline.renderedSeconds).toBe(30.5);
    expect(timeline.renderedSamples).toBe(1464000);
  });
});

describe('compileSong sample rates and rounding', () => {
  it('produces matching seconds with different sample positions at 44.1 and 48 kHz', () => {
    const song = baseSong({
      durationHint: 4,
      tracks: [clipTrack('keys', [clipNote(60, 1, 1)])],
    });

    const at44100 = compileOk(song, { sampleRate: 44100 }).timeline;
    const at48000 = compileOk(song, { sampleRate: 48000 }).timeline;

    expect(at44100.events[0]?.startSeconds).toBe(0.5);
    expect(at44100.events[0]?.endSeconds).toBe(1);
    expect(at44100.events[0]?.startSample).toBe(22050);
    expect(at44100.events[0]?.endSample).toBe(44100);
    expect(at44100.renderedSamples).toBe(88200);

    expect(at48000.events[0]?.startSeconds).toBe(0.5);
    expect(at48000.events[0]?.endSeconds).toBe(1);
    expect(at48000.events[0]?.startSample).toBe(24000);
    expect(at48000.events[0]?.endSample).toBe(48000);
    expect(at48000.renderedSamples).toBe(96000);

    expect(at44100.events.map((event) => [event.startBeat, event.endBeat])).toEqual(
      at48000.events.map((event) => [event.startBeat, event.endBeat]),
    );
  });

  it('rounds note boundaries to nearest samples and never places an end before its start', () => {
    const timeline = compileOk(
      baseSong({
        bpm: 60,
        durationHint: 0.001,
        tracks: [clipTrack('tiny', [clipNote(60, 0.1, 0.000001)])],
      }),
      { sampleRate: 44100 },
    ).timeline;

    const event = timeline.events[0];
    expect(event?.startSample).toBe(4410);
    expect(event?.endSample).toBe(4410);
    expect(event?.endSample).toBeGreaterThanOrEqual(event?.startSample ?? -1);
    expect(event?.endSeconds).toBeGreaterThan(event?.startSeconds ?? 0);

    const zeroSampleTimeline = compileOk(
      baseSong({
        bpm: 60,
        durationHint: 0.001,
        tracks: [clipTrack('tiny', [clipNote(60, 0.000001, 0.000001)])],
      }),
      { sampleRate: 44100 },
    ).timeline;

    const zeroSampleEvent = zeroSampleTimeline.events[0];
    expect(zeroSampleEvent?.startSample).toBe(0);
    expect(zeroSampleEvent?.endSample).toBe(0);
  });
});

describe('compileSong determinism and non-mutation', () => {
  it('compiles identical input to identical output repeatedly', () => {
    const song = loadValidFixture('automation.song.json');
    const options = { sampleRate: 48000 } as const;

    const first = compileSong(song, options);
    const second = compileSong(song, options);

    expect(first).toEqual(second);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    if (first.ok) {
      expect(first.timeline.meta).not.toHaveProperty('createdAt');
    }
  });

  it('does not mutate the song or a validation success', () => {
    const song = deepFreeze(loadValidFixture('automation.song.json'));
    const songSnapshot = JSON.stringify(song);
    const options = { sampleRate: 48000 } as const;

    const compiledFromRaw = compileSong(song, options);
    expect(compiledFromRaw.ok).toBe(true);
    expect(JSON.stringify(song)).toBe(songSnapshot);

    const validation = validateSong(song);
    expect(validation.ok).toBe(true);
    if (!validation.ok) {
      return;
    }

    const normalizedSnapshot = JSON.stringify(validation.normalized);
    const warningsSnapshot = JSON.stringify(validation.warnings);
    deepFreeze(validation);

    const compiledFromValidation = compileValidatedSong(validation, options);
    expect(compiledFromValidation).toEqual(compiledFromRaw);
    expect(JSON.stringify(validation.normalized)).toBe(normalizedSnapshot);
    expect(JSON.stringify(validation.warnings)).toBe(warningsSnapshot);
    expect(JSON.stringify(validation.song)).toBe(songSnapshot);
  });
});

describe('compileSong validation failures', () => {
  it('surfaces schema issues unchanged and never throws', () => {
    const invalid: unknown = {
      schemaVersion: '1.0.0',
      meta: { title: 'Broken' },
      tracks: [],
    };

    const validation = validateSong(invalid);
    expect(validation.ok).toBe(false);
    const result = compileSong(invalid, { sampleRate: 48000 });
    expect(result.ok).toBe(false);
    if (result.ok || validation.ok) {
      throw new Error('Expected both validation and compile to fail.');
    }

    expect(result.stage).toBe('validation');
    expect(result.errors).toEqual(validation.errors);
    expect(result.warnings).toEqual(validation.warnings);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.every((issue) => issue.code.startsWith('schema.'))).toBe(true);
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it('reports document and version failures with their schema codes', () => {
    const notASong = compileFailure(null, { sampleRate: 48000 });
    expect(notASong.stage).toBe('validation');
    expect(notASong.errors).toContainEqual(
      expect.objectContaining({ code: 'schema.document.invalid', path: '' }),
    );

    const unsupported = compileFailure(
      { schemaVersion: '2.0.0', meta: {}, tracks: [] },
      { sampleRate: 48000 },
    );
    expect(unsupported.stage).toBe('validation');
    expect(unsupported.errors).toContainEqual(
      expect.objectContaining({
        code: 'schema.version.unsupported',
        path: '/schemaVersion',
      }),
    );

    expect(() => compileSong('not a song', { sampleRate: 48000 })).not.toThrow();
  });
});

describe('compileSong options and compile-time bounds', () => {
  it('returns structured errors for invalid compile options', () => {
    const song = baseSong();

    const badRate = compileFailure(song, { sampleRate: 22050 as SampleRate });
    expect(badRate.stage).toBe('compile');
    expect(badRate.errors).toContainEqual(
      expect.objectContaining({ code: 'compile.options.invalid', path: '/sampleRate' }),
    );

    const missingOptions = compileFailure(song, undefined as unknown as CompileSongOptions);
    expect(missingOptions.errors).toContainEqual(
      expect.objectContaining({ code: 'compile.options.invalid', path: '' }),
    );

    const badLimits = compileFailure(song, {
      sampleRate: 48000,
      limits: { maxAuthoredNotes: 1.5 },
    });
    expect(badLimits.errors).toContainEqual(
      expect.objectContaining({
        code: 'compile.options.invalid',
        path: '/limits/maxAuthoredNotes',
      }),
    );

    const zeroLimit = compileFailure(song, {
      sampleRate: 48000,
      limits: { maxExpandedNotes: 0 },
    });
    expect(zeroLimit.errors).toContainEqual(
      expect.objectContaining({
        code: 'compile.options.invalid',
        path: '/limits/maxExpandedNotes',
      }),
    );

    const badLimitsShape = compileFailure(song, {
      sampleRate: 48000,
      limits: [] as unknown as Partial<typeof COMPILE_LIMITS>,
    });
    expect(badLimitsShape.errors).toContainEqual(
      expect.objectContaining({
        code: 'compile.options.invalid',
        path: '/limits',
      }),
    );
  });

  it('keeps validation warnings when compile options fail on a validation success', () => {
    const song = baseSong({
      durationHint: 100,
      tracks: [clipTrack('short', [clipNote(60, 0, 1)])],
    });
    const validation = validateSong(song);
    expect(validation.ok).toBe(true);
    if (!validation.ok) {
      return;
    }
    expect(validation.warnings).toContainEqual(
      expect.objectContaining({ code: 'song.warning.hint_exceeds_content' }),
    );

    const success = compileOk(song);
    expect(success.warnings).toContainEqual(
      expect.objectContaining({ code: 'song.warning.hint_exceeds_content' }),
    );

    const result = compileValidatedSong(validation, { sampleRate: 22050 as SampleRate });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.stage).toBe('compile');
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: 'compile.options.invalid', path: '/sampleRate' }),
    );
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: 'song.warning.hint_exceeds_content' }),
    );
  });

  it('enforces compile-time authored, expanded, and duration bounds', () => {
    expect(COMPILE_LIMITS).toEqual({
      maxAuthoredNotes: 10000,
      maxExpandedNotes: 20000,
      maxRenderedSeconds: 600,
    });

    const authored = compileFailure(
      baseSong({
        tracks: [clipTrack('keys', [clipNote(60, 0, 1), clipNote(62, 0, 1)])],
      }),
      { sampleRate: 48000, limits: { maxAuthoredNotes: 1 } },
    );
    expect(authored.stage).toBe('compile');
    expect(authored.errors).toContainEqual(
      expect.objectContaining({
        code: 'compile.limit.authored_notes',
        path: '',
        params: expect.objectContaining({ authoredNotes: 2, limit: 1 }),
      }),
    );

    const patternSong = baseSong({
      patterns: [{ id: 'p', notes: [clipNote(60, 0, 1)] }],
      tracks: [clipTrack('arp', [], { placements: [{ pattern: 'p', start: 0, repeat: 3 }] })],
    });
    const expanded = compileFailure(patternSong, {
      sampleRate: 48000,
      limits: { maxExpandedNotes: 2 },
    });
    expect(expanded.errors).toContainEqual(
      expect.objectContaining({
        code: 'compile.limit.expanded_notes',
        path: '',
        params: expect.objectContaining({ expandedNotes: 3, limit: 2 }),
      }),
    );

    const duration = compileFailure(loadValidFixture('minimal.song.json'), {
      sampleRate: 48000,
      limits: { maxRenderedSeconds: 5 },
    });
    expect(duration.errors).toContainEqual(
      expect.objectContaining({
        code: 'compile.limit.duration',
        path: '',
        params: expect.objectContaining({ limitSeconds: 5 }),
      }),
    );

    expect(() =>
      compileSong(patternSong, { sampleRate: 48000, limits: { maxExpandedNotes: 2 } }),
    ).not.toThrow();
    expect(() => JSON.stringify(expanded)).not.toThrow();
  });

  it('forwards schema validation options without duplicating validation', () => {
    const song = baseSong({
      tracks: [
        clipTrack('keys', [clipNote(60, 0, 1)], {
          instrument: { type: 'builtin', id: 'custom.keys' },
        }),
      ],
    });

    const rejected = compileFailure(song, { sampleRate: 48000 });
    expect(rejected.stage).toBe('validation');
    expect(rejected.errors).toContainEqual(
      expect.objectContaining({ code: 'song.instrument.unknown_builtin' }),
    );

    const accepted = compileOk(song, {
      sampleRate: 48000,
      validation: { builtinInstrumentIds: ['custom.keys'] },
    });
    expect(accepted.timeline.tracks[0]?.instrument).toEqual({
      type: 'builtin',
      id: 'custom.keys',
    });
  });

  it('allows tighter limits when they still fit and clamps looser limits', () => {
    const minimal = loadValidFixture('minimal.song.json');
    const allowed = compileOk(minimal, {
      sampleRate: 48000,
      limits: { maxRenderedSeconds: 6 },
    });
    expect(allowed.timeline.renderedSeconds).toBeCloseTo(16 / 3, 12);

    const clamped = compileOk(baseSong(), {
      sampleRate: 48000,
      limits: {
        maxAuthoredNotes: 100000,
        maxExpandedNotes: 100000,
        maxRenderedSeconds: 100000,
      },
    });
    expect(clamped.timeline.events).toHaveLength(1);
  });
});

describe('compileValidatedSong defensive checks', () => {
  it('rejects a malformed validation token without throwing', () => {
    const validation = validateSong(baseSong());
    expect(validation.ok).toBe(true);
    if (!validation.ok) {
      return;
    }

    const malformed = { ...validation, ok: false } as unknown as typeof validation;
    const result = compileValidatedSong(malformed, { sampleRate: 48000 });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.stage).toBe('compile');
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: 'compile.input.invalid', path: '' }),
    );
  });

  it('rechecks pattern resolution on a forged validation success', () => {
    const validation = validateSong(loadValidFixture('patterns.song.json'));
    expect(validation.ok).toBe(true);
    if (!validation.ok) {
      return;
    }

    const forged = {
      ...validation,
      normalized: { ...validation.normalized, patterns: [] },
    };
    const result = compileValidatedSong(forged, { sampleRate: 48000 });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.stage).toBe('compile');
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'compile.pattern.unresolved',
        path: '/tracks/0/placements/0/pattern',
      }),
    );
  });
});

describe('compileSong fixture metadata', () => {
  it('retains drums, channel, and instrument details', () => {
    const timeline = compileOk(loadValidFixture('drums.song.json')).timeline;

    expect(timeline.tracks[0]).toMatchObject({
      kind: 'drums',
      channel: 9,
      instrument: {
        type: 'soundfont',
        path: 'assets/drums/studio-kit.sf2',
        program: 0,
        bank: 128,
      },
      eventCount: 8,
    });
    expect(timeline.events.map((event) => event.velocity)).toEqual([
      112, 100, 104, 100, 112, 100, 104, 88,
    ]);
  });

  it('retains GM, SoundFont, and SFZ instruments with resolved banks', () => {
    const timeline = compileOk(loadValidFixture('instruments.song.json')).timeline;

    expect(timeline.tracks.map((track) => track.instrument)).toEqual([
      { type: 'gm', program: 0, bank: 0 },
      {
        type: 'soundfont',
        path: 'assets/strings/warm-ensemble.sf2',
        program: 48,
        bank: 0,
      },
      { type: 'sfz', path: 'assets/flute/air.sfz' },
    ]);
  });

  it('retains ordered effects and normalized parameters without applying them', () => {
    const timeline = compileOk(loadValidFixture('effects.song.json')).timeline;

    expect(timeline.tracks[0]?.effects).toEqual([
      { type: 'eq', lowGainDb: -2, midGainDb: 1.5, highGainDb: 2 },
      { type: 'lowpass', cutoffHz: 4200, q: 0.7 },
      { type: 'delay', timeMs: 375, feedback: 0.3, mix: 0.18 },
      { type: 'reverb', mix: 0.22, decaySeconds: 2.2 },
    ]);
    expect(timeline.tracks[0]?.tailSeconds).toBeCloseTo(4.45, 12);
    expect(timeline.tracks[0]?.effects).not.toHaveLength(0);
  });

  it('retains automation keyframes in beats and seconds without per-sample work', () => {
    const timeline = compileOk(loadValidFixture('automation.song.json')).timeline;
    const automation = timeline.tracks[0]?.automation;

    expect(timeline.tracks[0]).toMatchObject({ volume: 1, pan: 0 });
    expect(automation?.volume?.map((point) => [point.timeBeats, point.value])).toEqual([
      [0, 0.6],
      [8, 1],
      [16, 0],
    ]);
    expect(automation?.pan?.map((point) => [point.timeBeats, point.value])).toEqual([
      [0, -0.5],
      [16, 0.5],
    ]);
    expect(automation?.filterCutoffHz?.map((point) => [point.timeBeats, point.value])).toEqual([
      [0, 400],
      [8, 8000],
      [16, 1200],
      [24, 600],
    ]);
    expect(automation?.volume?.[1]?.timeSeconds).toBeCloseTo(8 * (60 / 84), 12);
    expect(automation?.filterCutoffHz?.[3]?.timeSeconds).toBeCloseTo(24 * (60 / 84), 12);
    expect(timeline.tracks[0]?.effects[0]).toEqual({ type: 'lowpass', q: 0.9 });
  });
});
