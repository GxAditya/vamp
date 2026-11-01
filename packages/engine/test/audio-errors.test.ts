import { describe, expect, it } from 'vitest';

import { BUILTIN_INSTRUMENT_IDS, type SongSchemaV1 } from '@gxaditya/vamp-schema';

import {
  AUDIO_ERROR_CODES,
  AUDIO_ISSUE_CODES,
  AUDIO_WARNING_CODES,
  BUILTIN_SYNTH_BACKEND_CAPABILITIES,
  BUILTIN_SYNTH_INSTRUMENT_IDS,
  createBuiltinSynthBackend,
  encodeWav,
  renderSongAudio,
  renderSongToWav,
  renderTimelineAudio,
  type AudioBackend,
  type AudioBackendTrackResult,
} from '../src/index.js';
import { parseWav, readPcm16, renderSongOk, sameBytes } from './audio-helpers.js';
import { baseSong, clipNote, clipTrack, compileOk, loadValidFixture } from './helpers.js';

function minimalTimeline(): ReturnType<typeof compileOk>['timeline'] {
  return compileOk(
    baseSong({
      durationHint: 1,
      tracks: [clipTrack('keys', [clipNote(60, 0, 1, 100)])],
    }),
    { sampleRate: 48000 },
  ).timeline;
}

/** Forge one track's effect chain or automation on a valid minimal timeline. */
function forgeChain(overrides: {
  readonly effects?: unknown;
  readonly automation?: unknown;
}): unknown {
  const timeline = minimalTimeline();
  const track = timeline.tracks[0];
  if (track === undefined) {
    throw new Error('expected the minimal timeline to contain a track');
  }
  return { ...timeline, tracks: [{ ...track, ...overrides }] };
}

function fakeBackend(
  renderTrack: AudioBackend['renderTrack'],
  overrides: Partial<AudioBackend> = {},
): AudioBackend {
  return {
    id: 'test-backend-v1',
    name: 'Test backend',
    description: 'A test backend used to exercise renderer guards.',
    capabilities: {
      instrumentTypes: ['builtin'],
      builtinIds: ['keys.soft'],
      voicePolicy: 'drop-newest',
    },
    renderTrack,
    ...overrides,
  };
}

function goodStats() {
  return {
    startedVoices: 0,
    droppedVoices: 0,
    stolenVoices: 0,
    peakActiveVoices: 0,
  };
}

function songWithBuiltin(id: string, pitch = 60): SongSchemaV1 {
  return baseSong({
    durationHint: 1,
    tracks: [
      clipTrack('keys', [clipNote(pitch, 0, 1, 100)], {
        instrument: { type: 'builtin', id },
      }),
    ],
  });
}

describe('instrument and feature capability errors', () => {
  it('rejects gm, soundfont, and sfz with a repairable sample-backend capability error', async () => {
    const timeline = compileOk(loadValidFixture('instruments.song.json'), {
      sampleRate: 48000,
    }).timeline;
    const result = await renderTimelineAudio(timeline);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }

    expect(result.errors).toHaveLength(3);
    expect(result.errors.map((issue) => issue.code)).toEqual([
      'audio.instrument.unsupported_variant',
      'audio.instrument.unsupported_variant',
      'audio.instrument.unsupported_variant',
    ]);
    expect(result.errors.map((issue) => issue.path)).toEqual([
      '/tracks/0/instrument',
      '/tracks/1/instrument',
      '/tracks/2/instrument',
    ]);
    expect(result.errors.map((issue) => issue.params?.variant)).toEqual(['gm', 'soundfont', 'sfz']);
    for (const issue of result.errors) {
      expect(issue.message).toContain('sample playback engine');
      expect(issue.hint).toContain('FluidSynth');
      expect(issue.hint).toContain('SFZ');
    }
  });

  it('rejects an unknown builtin id without substituting another instrument', async () => {
    const song = songWithBuiltin('keys.grand');
    const result = await renderSongAudio(song, {
      sampleRate: 48000,
      validation: {
        builtinInstrumentIds: [...BUILTIN_INSTRUMENT_IDS, 'keys.grand'],
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.stage).toBe('audio');
    expect(result.errors[0]).toMatchObject({
      code: 'audio.instrument.unknown_builtin',
      path: '/tracks/0/instrument/id',
      params: { instrumentId: 'keys.grand' },
    });
    expect(result.errors[0]?.hint).toContain('never substitutes');
  });

  it('advertises exactly the six builtin synth IDs and rejects unknown IDs locally', async () => {
    const expectedIds = [
      'bass.sub',
      'drums.kit',
      'guitar.clean',
      'keys.soft',
      'pad.warm',
      'piano.soft',
    ];
    expect(BUILTIN_SYNTH_INSTRUMENT_IDS).toEqual(expectedIds);
    expect(BUILTIN_SYNTH_BACKEND_CAPABILITIES.builtinIds).toEqual(expectedIds);

    const timeline = minimalTimeline();
    const track = timeline.tracks[0];
    if (track === undefined) {
      throw new Error('expected the minimal timeline to contain a track');
    }
    const unknownTrack = {
      ...track,
      instrument: { type: 'builtin', id: 'custom.handpan' },
    } as unknown as typeof track;

    const forged = { ...timeline, tracks: [unknownTrack] };
    const rendered = await renderTimelineAudio(forged);
    expect(rendered.ok).toBe(false);
    if (!rendered.ok) {
      expect(rendered.errors[0]).toMatchObject({
        code: 'audio.instrument.unknown_builtin',
        path: '/tracks/0/instrument/id',
        params: { instrumentId: 'custom.handpan' },
      });
      expect(rendered.errors[0]?.hint).toContain('never substitutes');
    }

    const backend = createBuiltinSynthBackend();
    const direct = await backend.renderTrack({
      track: unknownTrack,
      events: timeline.events.filter((event) => event.trackIndex === track.index),
      sampleRate: timeline.sampleRate,
      frameCount: timeline.renderedSamples,
      seed: timeline.meta.seed,
      maxVoices: 32,
      bpm: timeline.meta.bpm,
    });
    expect(direct.ok).toBe(false);
    if (!direct.ok) {
      expect(direct.errors[0]).toMatchObject({
        code: 'audio.instrument.unknown_builtin',
        path: '/tracks/0/instrument/id',
        params: { instrumentId: 'custom.handpan' },
      });
      expect(direct.errors[0]?.hint).toContain('bass.sub, drums.kit');
    }
  });

  it('renders the canonical effect chain instead of rejecting it', async () => {
    const timeline = compileOk(loadValidFixture('effects.song.json'), {
      sampleRate: 48000,
    }).timeline;
    const result = await renderTimelineAudio(timeline);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.audio.frameCount).toBe(timeline.renderedSamples);
      expect(result.stats.peak).toBeGreaterThan(0);
      expect(result.warnings).toEqual([]);
    }
  });

  it('rejects forged effect entries with audio.timeline.invalid instead of throwing', async () => {
    const timeline = minimalTimeline();
    const track = timeline.tracks[0];
    if (track === undefined) {
      throw new Error('expected the minimal timeline to contain a track');
    }

    for (const effects of [[null], [{}], [{ type: 7 }], [{ type: '' }]]) {
      const forged = { ...timeline, tracks: [{ ...track, effects }] };
      const result = await renderTimelineAudio(forged);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: 'audio.timeline.invalid',
              path: '/tracks/0/effects/0',
            }),
          ]),
        );
        expect(result.errors[0]?.hint).toContain('string "type"');
      }
    }
  });

  it('applies volume, pan, and filter automation from the canonical fixture', async () => {
    const timeline = compileOk(loadValidFixture('automation.song.json'), {
      sampleRate: 48000,
    }).timeline;
    const result = await renderTimelineAudio(timeline);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.audio.frameCount).toBe(timeline.renderedSamples);
      expect(result.stats.peak).toBeGreaterThan(0);
    }
  });

  it('rejects invalid effect parameters with audio.effects.invalid', async () => {
    const cases: { effect: unknown; path: string }[] = [
      { effect: { type: 'reverb', mix: 2, decaySeconds: 1.8 }, path: '/tracks/0/effects/0/mix' },
      {
        effect: { type: 'reverb', mix: 0.25, decaySeconds: 11 },
        path: '/tracks/0/effects/0/decaySeconds',
      },
      {
        effect: { type: 'delay', timeMs: 375, feedback: 1, mix: 0.25 },
        path: '/tracks/0/effects/0/feedback',
      },
      {
        effect: { type: 'delay', timeMs: 5, feedback: 0.3, mix: 0.25 },
        path: '/tracks/0/effects/0/timeMs',
      },
      {
        effect: { type: 'eq', lowGainDb: 30, midGainDb: 0, highGainDb: 0 },
        path: '/tracks/0/effects/0/lowGainDb',
      },
      {
        effect: { type: 'lowpass', cutoffHz: 10, q: 1 },
        path: '/tracks/0/effects/0/cutoffHz',
      },
      { effect: { type: 'lowpass', cutoffHz: 1000, q: 0 }, path: '/tracks/0/effects/0/q' },
      { effect: { type: 'chorus' }, path: '/tracks/0/effects/0' },
    ];

    for (const testCase of cases) {
      const result = await renderTimelineAudio(forgeChain({ effects: [testCase.effect] }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ code: 'audio.effects.invalid', path: testCase.path }),
          ]),
        );
      }
    }
  });

  it('rejects too many effects and more than one low-pass', async () => {
    const nine = Array.from({ length: 9 }, () => ({
      type: 'reverb',
      mix: 0.25,
      decaySeconds: 1.8,
    }));
    const tooMany = await renderTimelineAudio(forgeChain({ effects: nine }));
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) {
      expect(tooMany.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'audio.effects.invalid',
            path: '/tracks/0/effects',
          }),
        ]),
      );
    }

    const twoLowpass = await renderTimelineAudio(
      forgeChain({
        effects: [
          { type: 'lowpass', cutoffHz: 1000, q: 1 },
          { type: 'lowpass', cutoffHz: 2000, q: 1 },
        ],
      }),
    );
    expect(twoLowpass.ok).toBe(false);
    if (!twoLowpass.ok) {
      expect(twoLowpass.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'audio.effects.invalid',
            path: '/tracks/0/effects',
          }),
        ]),
      );
    }
  });

  it('rejects invalid automation shapes, values, and times with audio.automation.invalid', async () => {
    const cases: { automation: unknown; path: string }[] = [
      { automation: { volume: [] }, path: '/tracks/0/automation/volume' },
      {
        automation: {
          volume: [
            { timeBeats: 2, timeSeconds: 1, value: 0.5 },
            { timeBeats: 1, timeSeconds: 0.5, value: 0.5 },
          ],
        },
        path: '/tracks/0/automation/volume/1/timeBeats',
      },
      {
        automation: { volume: [{ timeBeats: 0, timeSeconds: 0, value: 3 }] },
        path: '/tracks/0/automation/volume/0/value',
      },
      {
        automation: {
          volume: [{ timeBeats: 0, timeSeconds: 0, value: Number.NaN }],
        },
        path: '/tracks/0/automation/volume/0/value',
      },
      {
        automation: {
          volume: [{ timeBeats: 0, timeSeconds: 0.25, value: 0.5 }],
        },
        path: '/tracks/0/automation/volume/0/timeSeconds',
      },
      {
        automation: {
          tempo: [{ timeBeats: 0, timeSeconds: 0, value: 120 }],
        },
        path: '/tracks/0/automation/tempo',
      },
    ];

    for (const testCase of cases) {
      const result = await renderTimelineAudio(forgeChain({ automation: testCase.automation }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ code: 'audio.automation.invalid', path: testCase.path }),
          ]),
        );
      }
    }
  });

  it('requires exactly one static-free low-pass for cutoff automation', async () => {
    const noLowpass = compileOk(loadValidFixture('automation.song.json'), {
      sampleRate: 48000,
    }).timeline;
    const trackWithout = noLowpass.tracks[0];
    if (trackWithout === undefined) {
      throw new Error('expected the automation fixture to contain a track');
    }
    const missingTarget = await renderTimelineAudio({
      ...noLowpass,
      tracks: [{ ...trackWithout, effects: [] }],
    });
    expect(missingTarget.ok).toBe(false);
    if (!missingTarget.ok) {
      expect(missingTarget.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'audio.automation.invalid',
            path: '/tracks/0/automation/filterCutoffHz',
          }),
        ]),
      );
    }

    const withStaticCutoff = await renderTimelineAudio({
      ...noLowpass,
      tracks: [
        {
          ...trackWithout,
          effects: [
            { type: 'lowpass', cutoffHz: 1000, q: 0.9 },
            { type: 'reverb', mix: 0.2, decaySeconds: 2.4 },
          ],
        },
      ],
    });
    expect(withStaticCutoff.ok).toBe(false);
    if (!withStaticCutoff.ok) {
      expect(withStaticCutoff.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'audio.automation.invalid',
            path: '/tracks/0/effects/0/cutoffHz',
          }),
        ]),
      );
    }

    const noCutoffOrAutomation = await renderTimelineAudio(
      forgeChain({ effects: [{ type: 'lowpass', q: 1 }] }),
    );
    expect(noCutoffOrAutomation.ok).toBe(false);
    if (!noCutoffOrAutomation.ok) {
      expect(noCutoffOrAutomation.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'audio.automation.invalid',
            path: '/tracks/0/effects/0/cutoffHz',
          }),
        ]),
      );
    }
  });

  it('rejects a drums.kit pitch outside the documented GM range', async () => {
    const song = baseSong({
      durationHint: 1,
      tracks: [
        clipTrack('kit-on-melodic', [clipNote(100, 0, 1, 100)], {
          instrument: { type: 'builtin', id: 'drums.kit' },
        }),
      ],
    });
    const result = await renderSongAudio(song, { sampleRate: 48000 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe('audio');
      expect(result.errors[0]).toMatchObject({
        code: 'audio.drums.pitch_unsupported',
        path: '/tracks/0',
      });
      expect(result.errors[0]?.params?.pitch).toBe(100);
    }
  });
});

describe('structured render and option errors', () => {
  it('does not throw for invalid songs and reports the validation stage', async () => {
    const result = await renderSongToWav({}, { sampleRate: 48000 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe('validation');
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]?.code).toBe('schema.version.missing');
    }
  });

  it('reports invalid compile options at the compile stage', async () => {
    const result = await renderSongToWav(songWithBuiltin('keys.soft'), {
      sampleRate: 96000 as never,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe('compile');
      expect(result.errors[0]?.code).toBe('compile.options.invalid');
      expect(result.errors[0]?.path).toBe('/sampleRate');
    }
  });

  it('rejects invalid audio options and sample-rate mismatches without throwing', async () => {
    const timeline = minimalTimeline();

    const mismatch = await renderTimelineAudio(timeline, { sampleRate: 44100 });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) {
      expect(mismatch.errors[0]).toMatchObject({
        code: 'audio.sample_rate.mismatch',
        path: '/sampleRate',
        params: { timelineSampleRate: 48000, requestedSampleRate: 44100 },
      });
    }

    for (const options of [
      { maxVoicesPerTrack: 0 },
      { maxVoicesPerTrack: 129 },
      { sampleRate: 96000 as never },
      { maxVoicesPerTrack: 2.5 },
    ]) {
      const invalid = await renderTimelineAudio(timeline, options);
      expect(invalid.ok).toBe(false);
      if (!invalid.ok) {
        expect(invalid.errors[0]?.code).toBe('audio.options.invalid');
      }
    }

    const unknown = await renderTimelineAudio(timeline, {
      maxVoicePerTrack: 8,
    } as never);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.errors[0]?.path).toBe('/maxVoicePerTrack');
    }

    const badBackend = await renderTimelineAudio(timeline, { backend: {} as never });
    expect(badBackend.ok).toBe(false);
    if (!badBackend.ok) {
      expect(badBackend.errors[0]?.path).toBe('/backend');
    }

    const badShape = await renderTimelineAudio(timeline, null as never);
    expect(badShape.ok).toBe(false);
    if (!badShape.ok) {
      expect(badShape.errors[0]?.code).toBe('audio.options.invalid');
    }

    const songOptions = await renderSongAudio(songWithBuiltin('keys.soft'), {
      sampleRate: 48000,
      maxVoicesPerTrack: 0,
    });
    expect(songOptions.ok).toBe(false);
    if (!songOptions.ok) {
      expect(songOptions.stage).toBe('audio');
      expect(songOptions.errors[0]?.code).toBe('audio.options.invalid');
    }

    const unknownSongOption = await renderSongAudio(songWithBuiltin('keys.soft'), {
      sampleRate: 48000,
      maxVoicePerTrack: 8,
    } as never);
    expect(unknownSongOption.ok).toBe(false);
    if (!unknownSongOption.ok) {
      expect(unknownSongOption.stage).toBe('audio');
      expect(unknownSongOption.errors[0]?.path).toBe('/maxVoicePerTrack');
    }

    const invalidValidationOptions = await renderSongAudio(songWithBuiltin('keys.soft'), {
      sampleRate: 48000,
      validation: 5,
    } as never);
    expect(invalidValidationOptions.ok).toBe(false);
    if (!invalidValidationOptions.ok) {
      expect(invalidValidationOptions.stage).toBe('compile');
      expect(invalidValidationOptions.errors[0]?.path).toBe('/validation');
    }
  });

  it('rejects malformed timelines with audio.timeline.invalid', async () => {
    const nullTimeline = await renderTimelineAudio(null);
    expect(nullTimeline.ok).toBe(false);
    if (!nullTimeline.ok) {
      expect(nullTimeline.errors[0]?.code).toBe('audio.timeline.invalid');
    }

    const timeline = minimalTimeline();
    const huge = { ...timeline, renderedSamples: Number.MAX_SAFE_INTEGER };
    const tooLong = await renderTimelineAudio(huge);
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) {
      expect(tooLong.errors.some((issue) => issue.code === 'audio.timeline.invalid')).toBe(true);
    }

    const missingMeta = { ...timeline, meta: undefined };
    const noMeta = await renderTimelineAudio(missingMeta);
    expect(noMeta.ok).toBe(false);
    if (!noMeta.ok) {
      expect(noMeta.errors.some((issue) => issue.path === '/meta')).toBe(true);
    }

    const badSeed = { ...timeline, meta: { ...timeline.meta, seed: Number.NaN } };
    const noSeed = await renderTimelineAudio(badSeed);
    expect(noSeed.ok).toBe(false);
    if (!noSeed.ok) {
      expect(noSeed.errors.some((issue) => issue.path === '/meta/seed')).toBe(true);
    }
  });
});

describe('backend output safety', () => {
  it('fails with audio.samples.non_finite when a backend emits NaN', async () => {
    const backend = fakeBackend(async (request) => {
      const samples = new Float32Array(request.frameCount);
      samples[10] = Number.NaN;
      return {
        ok: true,
        samples,
        stats: goodStats(),
        warnings: [],
      } satisfies AudioBackendTrackResult;
    });
    const result = await renderTimelineAudio(minimalTimeline(), { backend });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toMatchObject({
        code: 'audio.samples.non_finite',
        path: '/tracks/0',
        params: { frame: 10, channel: 'mono' },
      });
    }
  });

  it('rejects backend output with the wrong frame count or invalid voice stats', async () => {
    const shortBackend = fakeBackend(async () => ({
      ok: true,
      samples: new Float32Array(5),
      stats: goodStats(),
      warnings: [],
    }));
    const short = await renderTimelineAudio(minimalTimeline(), { backend: shortBackend });
    expect(short.ok).toBe(false);
    if (!short.ok) {
      expect(short.errors[0]?.code).toBe('audio.backend.invalid_output');
    }

    const loudBackend = fakeBackend(async (request) => ({
      ok: true,
      samples: new Float32Array(request.frameCount),
      stats: { ...goodStats(), peakActiveVoices: 99 },
      warnings: [],
    }));
    const loud = await renderTimelineAudio(minimalTimeline(), {
      backend: loudBackend,
      maxVoicesPerTrack: 4,
    });
    expect(loud.ok).toBe(false);
    if (!loud.ok) {
      expect(loud.errors[0]?.code).toBe('audio.backend.invalid_output');
    }
  });

  it('wraps a thrown backend failure as audio.backend.failed', async () => {
    const backend = fakeBackend(async () => {
      throw new Error('native backend exited');
    });
    const result = await renderTimelineAudio(minimalTimeline(), { backend });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toMatchObject({
        code: 'audio.backend.failed',
        path: '/tracks/0',
      });
    }
  });

  it('surfaces a backend voice-stealing policy and stolen voice counts', async () => {
    const backend = fakeBackend(
      async (request) => ({
        ok: true,
        samples: new Float32Array(request.frameCount),
        stats: { startedVoices: 8, droppedVoices: 0, stolenVoices: 2, peakActiveVoices: 4 },
        warnings: [],
      }),
      {
        capabilities: {
          instrumentTypes: ['builtin'],
          builtinIds: ['keys.soft'],
          voicePolicy: 'steal-oldest',
        },
      },
    );
    const result = await renderTimelineAudio(minimalTimeline(), {
      backend,
      maxVoicesPerTrack: 4,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.stats.voiceCapPolicy).toBe('steal-oldest');
      expect(result.stats.stolenVoices).toBe(2);
      expect(result.warnings[0]).toMatchObject({
        code: 'audio.voice.stolen',
        path: '/tracks/0',
        params: { stolenVoices: 2, maxVoices: 4 },
      });
    }
  });

  it('rejects non-finite samples at the WAV boundary', async () => {
    const audio = {
      format: 'vamp.pcm',
      formatVersion: 1,
      sampleRate: 48000,
      frameCount: 4,
      left: new Float32Array([0, 0.25, Number.NaN, 0]),
      right: new Float32Array(4),
    };
    const encoded = encodeWav(audio);
    expect(encoded.ok).toBe(false);
    if (!encoded.ok) {
      expect(encoded.errors[0]).toMatchObject({
        code: 'audio.samples.non_finite',
        path: '/audio/left',
      });
    }
  });

  it('rejects malformed PCM buffers before writing WAV bytes', async () => {
    const valid = await renderSongOk(songWithBuiltin('keys.soft'), { sampleRate: 48000 });
    const mismatched = { ...valid.audio, frameCount: valid.audio.frameCount + 1 };
    const result = encodeWav(mismatched);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toMatchObject({
        code: 'audio.buffer.invalid',
        path: '/audio',
      });
    }

    const wrongMarker = { ...valid.audio, format: 'other.pcm' };
    const marker = encodeWav(wrongMarker);
    expect(marker.ok).toBe(false);
    if (!marker.ok) {
      expect(marker.errors[0]?.code).toBe('audio.buffer.invalid');
    }
  });
});

describe('clipping policy', () => {
  it('clamps, counts, and warns without normalizing the mix', () => {
    const audio = {
      format: 'vamp.pcm',
      formatVersion: 1,
      sampleRate: 48000,
      frameCount: 4,
      left: new Float32Array([0, 1.5, -2, 0.5]),
      right: new Float32Array([0, -1.5, 2, -0.5]),
    };
    const encoded = encodeWav(audio);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) {
      return;
    }

    const parsed = parseWav(encoded.bytes);
    expect(parsed.frameCount).toBe(4);
    expect(encoded.report.peak).toBe(2);
    expect(encoded.report.peakDbfs).toBeCloseTo(6.0206, 3);
    expect(encoded.report.clippedSampleCount).toBe(4);
    expect(encoded.report.clippedFrameCount).toBe(2);
    expect(encoded.warnings).toHaveLength(1);
    expect(encoded.warnings[0]).toMatchObject({
      code: 'audio.pcm.clipped',
      path: '/audio',
      params: { clippedSampleCount: 4, clippedFrameCount: 2, peak: 2 },
    });

    expect(readPcm16(encoded.bytes, parsed, 0, 0)).toBe(0);
    expect(readPcm16(encoded.bytes, parsed, 1, 0)).toBe(32767);
    expect(readPcm16(encoded.bytes, parsed, 1, 1)).toBe(-32768);
    expect(readPcm16(encoded.bytes, parsed, 2, 0)).toBe(-32768);
    expect(readPcm16(encoded.bytes, parsed, 2, 1)).toBe(32767);
    expect(readPcm16(encoded.bytes, parsed, 3, 0)).toBe(16384);
  });

  it('reproduces the same clipping report and bytes across encodes', () => {
    const makeAudio = () => ({
      format: 'vamp.pcm',
      formatVersion: 1,
      sampleRate: 44100,
      frameCount: 2,
      left: new Float32Array([2, -2]),
      right: new Float32Array([-2, 2]),
    });
    const first = encodeWav(makeAudio());
    const second = encodeWav(makeAudio());
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(sameBytes(first.bytes, second.bytes)).toBe(true);
      expect(first.report).toEqual(second.report);
    }
  });
});

describe('audio issue code registry', () => {
  it('exposes stable error and warning code lists', () => {
    expect(AUDIO_ERROR_CODES).toContain('audio.options.invalid');
    expect(AUDIO_ERROR_CODES).toContain('audio.instrument.unsupported_variant');
    expect(AUDIO_ERROR_CODES).toContain('audio.samples.non_finite');
    expect(AUDIO_WARNING_CODES).toContain('audio.voice.dropped');
    expect(AUDIO_WARNING_CODES).toContain('audio.pcm.clipped');
    expect(new Set(AUDIO_ISSUE_CODES).size).toBe(
      AUDIO_ERROR_CODES.length + AUDIO_WARNING_CODES.length,
    );
  });

  it('keeps a clean built-in render free of clipping and audio warnings', async () => {
    const rendered = await renderSongToWav(songWithBuiltin('keys.soft'), { sampleRate: 48000 });
    expect(rendered.ok).toBe(true);
    if (rendered.ok) {
      expect(rendered.report.clippedSampleCount).toBe(0);
      expect(rendered.warnings).toEqual([]);
    }
  });
});
