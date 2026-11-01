import { parseMidi } from 'midi-file';
import { describe, expect, it } from 'vitest';

import type { SongTimeline } from '../src/index.js';
import { exportMidi, type MidiExportOptions } from '../src/index.js';
import { baseSong, clipNote, clipTrack, compileOk, loadValidFixture } from './helpers.js';

function compileFixture(name: string): SongTimeline {
  return compileOk(loadValidFixture(name), { sampleRate: 48000 }).timeline;
}

function failCodes(result: ReturnType<typeof exportMidi>): string[] {
  if (result.ok) {
    throw new Error('Expected MIDI export failure.');
  }
  return result.errors.map((issue) => issue.code);
}

describe('structured MIDI export failures', () => {
  it('rejects non-object timelines without throwing', () => {
    const result = exportMidi(null as unknown as SongTimeline);
    expect(result.ok).toBe(false);
    expect(failCodes(result)).toEqual(['midi.timeline.invalid']);
  });

  it('rejects malformed timeline format markers', () => {
    const base = compileFixture('minimal.song.json');
    const forged = {
      ...base,
      format: 'not-a-timeline',
      formatVersion: 2,
      schemaVersion: '2.0.0',
    } as unknown as SongTimeline;

    let result: ReturnType<typeof exportMidi> | undefined;
    expect(() => {
      result = exportMidi(forged);
    }).not.toThrow();
    expect(result?.ok).toBe(false);
    if (result === undefined) {
      return;
    }
    expect(failCodes(result)).toEqual([
      'midi.timeline.invalid',
      'midi.timeline.invalid',
      'midi.timeline.invalid',
    ]);
    if (!result.ok) {
      expect(result.errors.map((issue) => issue.path)).toEqual([
        '/format',
        '/formatVersion',
        '/schemaVersion',
      ]);
    }
  });

  it('rejects duplicate melodic channels instead of silently moving a track', () => {
    const timeline = compileOk(
      baseSong({
        tracks: [
          clipTrack('lead', [clipNote(60, 0, 1)], { channel: 0 }),
          clipTrack('pad', [clipNote(64, 0, 1)], { channel: 1 }),
        ],
      }),
      { sampleRate: 48000 },
    ).timeline;
    const first = timeline.tracks[0];
    const second = timeline.tracks[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) {
      return;
    }

    const forged = {
      ...timeline,
      tracks: [first, { ...second, channel: first.channel }],
    } as unknown as SongTimeline;

    let result: ReturnType<typeof exportMidi> | undefined;
    expect(() => {
      result = exportMidi(forged);
    }).not.toThrow();
    expect(result?.ok).toBe(false);
    if (result === undefined || result.ok) {
      return;
    }
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      code: 'midi.channel.collision',
      path: '/tracks/1/channel',
    });
  });

  it('rejects melodic tracks on the drum channel and drums on melodic channels', () => {
    const midiTimeline = compileOk(baseSong(), { sampleRate: 48000 }).timeline;
    const melodic = midiTimeline.tracks[0];
    expect(melodic).toBeDefined();
    if (melodic === undefined) {
      return;
    }
    const melodicOnNine = {
      ...midiTimeline,
      tracks: [{ ...melodic, channel: 9 }],
    } as unknown as SongTimeline;
    const melodicResult = exportMidi(melodicOnNine);
    expect(melodicResult.ok).toBe(false);
    expect(failCodes(melodicResult)).toContain('midi.channel.invalid');

    const drumTimeline = compileOk(
      baseSong({
        tracks: [
          {
            id: 'drums',
            name: 'Drums',
            kind: 'drums',
            channel: 9,
            instrument: { type: 'builtin', id: 'drums.kit' },
            notes: [clipNote(36, 0, 0.25)],
          },
        ],
      }),
      { sampleRate: 48000 },
    ).timeline;
    const drums = drumTimeline.tracks[0];
    expect(drums).toBeDefined();
    if (drums === undefined) {
      return;
    }
    const drumsOnZero = {
      ...drumTimeline,
      tracks: [{ ...drums, channel: 0 }],
    } as unknown as SongTimeline;
    const drumsResult = exportMidi(drumsOnZero);
    expect(drumsResult.ok).toBe(false);
    expect(failCodes(drumsResult)).toContain('midi.channel.invalid');
  });

  it('rejects out-of-range event fields with event paths', () => {
    const timeline = compileFixture('minimal.song.json');
    const event = timeline.events[0];
    expect(event).toBeDefined();
    if (event === undefined) {
      return;
    }
    const forged = {
      ...timeline,
      events: [{ ...event, pitch: 200, velocity: 0, endBeat: -1 }],
    } as unknown as SongTimeline;
    const result = exportMidi(forged);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors.map((issue) => issue.path)).toEqual([
      '/events/0/endBeat',
      '/events/0/pitch',
      '/events/0/velocity',
    ]);
    expect(result.errors.every((issue) => issue.code === 'midi.event.invalid')).toBe(true);
  });

  it('rejects unsupported track and event counts', () => {
    const timeline = compileFixture('minimal.song.json');
    const track = timeline.tracks[0];
    const event = timeline.events[0];
    expect(track).toBeDefined();
    expect(event).toBeDefined();
    if (track === undefined || event === undefined) {
      return;
    }

    const tooManyTracks = {
      ...timeline,
      tracks: Array.from({ length: 17 }, (_, index) => ({
        ...track,
        index,
        id: `track-${index}`,
        name: `Track ${index}`,
      })),
    } as unknown as SongTimeline;
    const trackResult = exportMidi(tooManyTracks);
    expect(trackResult.ok).toBe(false);
    expect(failCodes(trackResult)).toEqual(['midi.limit.tracks']);

    const tooManyEvents = {
      ...timeline,
      events: Array.from({ length: 20_001 }, () => event),
    } as unknown as SongTimeline;
    const eventResult = exportMidi(tooManyEvents);
    expect(eventResult.ok).toBe(false);
    expect(failCodes(eventResult)).toEqual(['midi.limit.events']);
  });

  it('rejects automation point arrays over the supported limit', () => {
    const timeline = compileOk(baseSong(), { sampleRate: 48000 }).timeline;
    const track = timeline.tracks[0];
    expect(track).toBeDefined();
    if (track === undefined) {
      return;
    }
    const forged = {
      ...timeline,
      tracks: [
        {
          ...track,
          automation: {
            volume: Array.from({ length: 513 }, (_, index) => ({
              timeBeats: index / 100,
              timeSeconds: index / 200,
              value: 1,
            })),
          },
        },
      ],
    } as unknown as SongTimeline;
    const result = exportMidi(forged);
    expect(result.ok).toBe(false);
    expect(failCodes(result)).toEqual(['midi.limit.automation']);
  });

  it('rejects malformed options with stable codes', () => {
    const timeline = compileFixture('minimal.song.json');
    const result = exportMidi(timeline, {
      includeInaudibleTracks: 'yes',
      endMarker: 'loop',
    } as unknown as MidiExportOptions);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors.map((issue) => issue.code)).toEqual([
      'midi.options.invalid',
      'midi.options.invalid',
    ]);
    expect(result.errors.map((issue) => issue.path)).toEqual([
      '/endMarker',
      '/includeInaudibleTracks',
    ]);
  });
});

describe('key-signature representation limits', () => {
  it('omits an unrepresentable key without inventing another key', () => {
    const base = compileFixture('minimal.song.json');
    const forged = {
      ...base,
      meta: { ...base.meta, key: { tonic: 'H', mode: 'major' } },
    } as unknown as SongTimeline;

    const result = exportMidi(forged);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.report.keySignature).toBeNull();
    expect(result.report.limitations.map((limitation) => limitation.code)).toContain(
      'key.not_encoded',
    );

    const parsed = parseMidi(result.bytes);
    const conductor = parsed.tracks[0];
    expect(conductor).toBeDefined();
    if (conductor === undefined) {
      return;
    }
    expect(conductor.filter((event) => event.type === 'keySignature')).toHaveLength(0);
    expect(conductor.some((event) => event.type === 'setTempo')).toBe(true);
  });

  it('omits a key signature for an unknown mode', () => {
    const base = compileFixture('minimal.song.json');
    const forged = {
      ...base,
      meta: { ...base.meta, key: { tonic: 'C', mode: 'dorian' } },
    } as unknown as SongTimeline;

    const result = exportMidi(forged);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.report.keySignature).toBeNull();
    expect(result.report.limitations.map((limitation) => limitation.code)).toContain(
      'key.not_encoded',
    );
  });

  it('rejects a non-power-of-two meter denominator instead of guessing an exponent', () => {
    const base = compileFixture('minimal.song.json');
    const forged = {
      ...base,
      meta: {
        ...base.meta,
        timeSignature: { numerator: 5, denominator: 3 },
      },
    } as unknown as SongTimeline;

    const result = exportMidi(forged);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors.map((issue) => issue.code)).toEqual(['midi.timeline.invalid']);
    expect(result.errors[0]?.path).toBe('/meta/timeSignature/denominator');
  });
});
