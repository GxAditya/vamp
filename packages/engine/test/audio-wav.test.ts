import { describe, expect, it } from 'vitest';

import type { SongSchemaV1, Track } from '@gxaditya/vamp-schema';

import { encodeWav } from '../src/index.js';
import {
  assertFinite,
  countNonZeroPcmFrames,
  measureAudio,
  parseWav,
  readPcm16,
  renderSongOk,
  renderTimelineOk,
  renderWavOk,
  sameBytes,
  sameFloat32,
  wavReportMatchesParsed,
} from './audio-helpers.js';
import { baseSong, clipNote, clipTrack, compileOk, deepFreeze } from './helpers.js';

function shortSong(): SongSchemaV1 {
  return baseSong({
    durationHint: 4,
    tracks: [
      clipTrack(
        'keys',
        [clipNote(60, 0, 2), clipNote(64, 0, 2), clipNote(67, 0, 2), clipNote(72, 2, 1.5, 90)],
        { volume: 0.7, pan: -0.25 },
      ),
      clipTrack('bass', [clipNote(36, 0, 3, 110), clipNote(41, 2, 2, 100)], {
        channel: 1,
        volume: 0.65,
        pan: 0.2,
        instrument: { type: 'builtin', id: 'bass.sub' },
      }),
    ],
  });
}

function singleTrackSong(volume: number, pan: number): SongSchemaV1 {
  return baseSong({
    durationHint: 1,
    tracks: [
      clipTrack('keys', [clipNote(60, 0, 1, 110)], {
        volume,
        pan,
        instrument: { type: 'builtin', id: 'keys.soft' },
      }),
    ],
  });
}

describe('WAV encoding and independent header checks', () => {
  it.each([
    { sampleRate: 44100 as const, byteRate: 176400 },
    { sampleRate: 48000 as const, byteRate: 192000 },
  ])(
    'writes a standards-compliant 16-bit stereo PCM WAV at $sampleRate Hz',
    async ({ sampleRate, byteRate }) => {
      const song = shortSong();
      const rendered = await renderWavOk(song, { sampleRate });
      const parsed = parseWav(rendered.bytes);

      expect(parsed.riff).toBe('RIFF');
      expect(parsed.wave).toBe('WAVE');
      expect(parsed.formatChunkId).toBe('fmt ');
      expect(parsed.formatChunkSize).toBe(16);
      expect(parsed.audioFormat).toBe(1);
      expect(parsed.channels).toBe(2);
      expect(parsed.sampleRate).toBe(sampleRate);
      expect(parsed.bitDepth).toBe(16);
      expect(parsed.blockAlign).toBe(4);
      expect(parsed.byteRate).toBe(byteRate);
      expect(parsed.dataChunkId).toBe('data');
      expect(parsed.dataOffset).toBe(44);
      expect(parsed.frameCount).toBe(rendered.timeline.renderedSamples);
      expect(parsed.dataSize).toBe(parsed.frameCount * 4);
      expect(parsed.fileBytes).toBe(44 + parsed.dataSize);
      expect(parsed.riffChunkSize).toBe(parsed.fileBytes - 8);
      expect(rendered.report).toEqual(
        expect.objectContaining({
          encoding: 'pcm-s16le',
          audioFormat: 1,
          channels: 2,
          sampleRate,
          bitDepth: 16,
          frameCount: rendered.timeline.renderedSamples,
          blockAlign: 4,
          byteRate,
          dataBytes: parsed.frameCount * 4,
          fileBytes: parsed.frameCount * 4 + 44,
          clippedSampleCount: 0,
          clippedFrameCount: 0,
        }),
      );
      expect(wavReportMatchesParsed(rendered.report, parsed)).toBe(true);

      // The fixture is a two-track cue, so most frames must carry signal.
      expect(countNonZeroPcmFrames(rendered.bytes, parsed)).toBeGreaterThan(
        parsed.frameCount * 0.5,
      );
      expect(rendered.report.peak).toBeGreaterThan(0.02);
      expect(rendered.report.peak).toBeLessThan(1);
      expect(rendered.report.peakDbfs).toBeLessThan(0);

      // The file is exactly the header plus the declared data chunk.
      expect(rendered.bytes.length).toBe(44 + parsed.dataSize);
    },
  );

  it('writes stereo-interleaved samples with left and right different under pan', async () => {
    const rendered = await renderWavOk(shortSong(), { sampleRate: 48000 });
    const parsed = parseWav(rendered.bytes);
    let differingFrames = 0;
    for (let frame = 0; frame < parsed.frameCount; frame += 32) {
      if (
        readPcm16(rendered.bytes, parsed, frame, 0) !== readPcm16(rendered.bytes, parsed, frame, 1)
      ) {
        differingFrames += 1;
      }
    }
    expect(differingFrames).toBeGreaterThan(0);
  });

  it('produces byte-identical WAV output for repeated renders of the same song', async () => {
    const song = shortSong();
    const first = await renderWavOk(song, { sampleRate: 44100 });
    const second = await renderWavOk(song, { sampleRate: 44100 });
    expect(first.bytes.length).toBe(second.bytes.length);
    expect(sameBytes(first.bytes, second.bytes)).toBe(true);
    expect(first.report).toEqual(second.report);
  });

  it('renders identical PCM and WAV bytes twice from one frozen timeline', async () => {
    const compiled = compileOk(shortSong(), { sampleRate: 48000 });
    const before = JSON.stringify(compiled.timeline);
    deepFreeze(compiled.timeline);

    const first = await renderTimelineOk(compiled.timeline);
    const second = await renderTimelineOk(compiled.timeline);
    expect(sameFloat32(first.audio.left, second.audio.left)).toBe(true);
    expect(sameFloat32(first.audio.right, second.audio.right)).toBe(true);
    expect(first.stats).toEqual(second.stats);
    expect(JSON.stringify(compiled.timeline)).toBe(before);

    const firstWav = encodeWav(first.audio);
    const secondWav = encodeWav(second.audio);
    expect(firstWav.ok).toBe(true);
    expect(secondWav.ok).toBe(true);
    if (firstWav.ok && secondWav.ok) {
      expect(sameBytes(firstWav.bytes, secondWav.bytes)).toBe(true);
    }
  });
});

describe('track gain and equal-power pan', () => {
  it('scales the master linearly with static track volume', async () => {
    const full = await renderSongOk(singleTrackSong(1, 0), { sampleRate: 48000 });
    const half = await renderSongOk(singleTrackSong(0.5, 0), { sampleRate: 48000 });
    const fullPeak = measureAudio(full.audio).peak;
    const halfPeak = measureAudio(half.audio).peak;
    expect(fullPeak).toBeGreaterThan(0.01);
    expect(halfPeak / fullPeak).toBeCloseTo(0.5, 6);
    expect(half.stats.tracks[0]?.peak).toBeCloseTo(full.stats.tracks[0]?.peak ?? 0, 6);
  });

  it('uses the documented cosine and sine equal-power pan law', async () => {
    const left = await renderSongOk(singleTrackSong(1, -1), { sampleRate: 48000 });
    const center = await renderSongOk(singleTrackSong(1, 0), { sampleRate: 48000 });
    const right = await renderSongOk(singleTrackSong(1, 1), { sampleRate: 48000 });

    const leftPeak = measureAudio(left.audio).peak;
    const centerPeak = measureAudio(center.audio).peak;
    const rightPeak = measureAudio(right.audio).peak;

    let leftChannelPeak = 0;
    let rightChannelPeak = 0;
    let centerLeftPeak = 0;
    let centerRightPeak = 0;
    let leftLeak = 0;
    let rightLeak = 0;
    for (let frame = 0; frame < left.audio.frameCount; frame += 1) {
      leftChannelPeak = Math.max(leftChannelPeak, Math.abs(left.audio.left[frame] ?? 0));
      leftLeak = Math.max(leftLeak, Math.abs(left.audio.right[frame] ?? 0));
      rightChannelPeak = Math.max(rightChannelPeak, Math.abs(right.audio.right[frame] ?? 0));
      rightLeak = Math.max(rightLeak, Math.abs(right.audio.left[frame] ?? 0));
      centerLeftPeak = Math.max(centerLeftPeak, Math.abs(center.audio.left[frame] ?? 0));
      centerRightPeak = Math.max(centerRightPeak, Math.abs(center.audio.right[frame] ?? 0));
    }

    expect(leftChannelPeak).toBeGreaterThan(0.01);
    expect(leftLeak).toBeLessThan(1e-9);
    expect(rightChannelPeak).toBeGreaterThan(0.01);
    expect(rightLeak).toBeLessThan(1e-9);
    expect(centerLeftPeak).toBeCloseTo(leftChannelPeak * Math.SQRT1_2, 5);
    expect(centerRightPeak).toBeCloseTo(rightChannelPeak * Math.SQRT1_2, 5);
    expect(leftPeak).toBeCloseTo(rightPeak, 6);
    expect(centerPeak).toBeCloseTo(leftPeak * Math.SQRT1_2, 5);
  });
});

describe('mute and solo', () => {
  function twoTrackSong(extraA: Partial<Track>, extraB: Partial<Track>): SongSchemaV1 {
    return baseSong({
      durationHint: 4,
      tracks: [
        clipTrack('a', [clipNote(60, 0, 2, 100)], {
          volume: 0.5,
          pan: -0.3,
          instrument: { type: 'builtin', id: 'keys.soft' },
          ...extraA,
        }),
        clipTrack('b', [clipNote(48, 0, 2, 100)], {
          channel: 1,
          volume: 0.4,
          pan: 0.4,
          instrument: { type: 'builtin', id: 'bass.sub' },
          ...extraB,
        }),
      ],
    });
  }

  function onlyA(): SongSchemaV1 {
    return baseSong({
      durationHint: 4,
      tracks: [
        clipTrack('a', [clipNote(60, 0, 2, 100)], {
          volume: 0.5,
          pan: -0.3,
          instrument: { type: 'builtin', id: 'keys.soft' },
        }),
      ],
    });
  }

  function onlyB(): SongSchemaV1 {
    return baseSong({
      durationHint: 4,
      tracks: [
        clipTrack('b', [clipNote(48, 0, 2, 100)], {
          channel: 1,
          volume: 0.4,
          pan: 0.4,
          instrument: { type: 'builtin', id: 'bass.sub' },
        }),
      ],
    });
  }

  it('soloes only the soloed track and leaves inaudible tracks silent', async () => {
    const soloed = await renderSongOk(twoTrackSong({ solo: true }, {}), { sampleRate: 48000 });
    const reference = await renderSongOk(onlyA(), { sampleRate: 48000 });
    expect(sameFloat32(soloed.audio.left, reference.audio.left)).toBe(true);
    expect(sameFloat32(soloed.audio.right, reference.audio.right)).toBe(true);
    expect(soloed.stats.tracks.map((track) => track.audible)).toEqual([true, false]);
    expect(soloed.stats.audibleTrackCount).toBe(1);
  });

  it('mutes a track even when no other track is soloed', async () => {
    const muted = await renderSongOk(twoTrackSong({ mute: true }, {}), { sampleRate: 48000 });
    const reference = await renderSongOk(onlyB(), { sampleRate: 48000 });
    expect(sameFloat32(muted.audio.left, reference.audio.left)).toBe(true);
    expect(sameFloat32(muted.audio.right, reference.audio.right)).toBe(true);
    expect(muted.stats.tracks.map((track) => track.audible)).toEqual([false, true]);
  });

  it('lets mute win over solo and reports silence without error', async () => {
    const silent = await renderSongOk(twoTrackSong({ mute: true, solo: true }, {}), {
      sampleRate: 48000,
    });
    assertFinite(silent.audio);
    expect(measureAudio(silent.audio).peak).toBe(0);
    expect(silent.stats.audibleTrackCount).toBe(0);
    expect(silent.stats.peak).toBe(0);
    expect(silent.stats.peakDbfs).toBeNull();
  });
});
