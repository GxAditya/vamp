/**
 * Task 18 tolerance-based audio regression suite (fast layer).
 *
 * These checks run on every supported platform with no native dependency.
 * They deliberately assert physical behavior, not bytes: frame counts are
 * exact (the deterministic contract), while energy, peak, and spectral checks
 * use windows wide enough to absorb cross-platform libm/Float32 rounding yet
 * tight enough to catch a real DSP, mixing, or duration regression. The
 * byte-exact golden fixtures live in `regression-golden.pinned.test.ts` and
 * run under the pinned/native gate on the recorded environment.
 *
 * Tolerance windows were measured on the repository environment described in
 * `PROGRESS.md` (Linux x86_64, Node.js v24.18.0, built-in backend) with
 * roughly +/- 10 percent headroom. The five `examples/songs` cues are the
 * fixtures. `durationHint` is quarter-note beats, so hints below convert at
 * the song BPM.
 */

import { readFileSync } from 'node:fs';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import type { Note, SongSchemaV1, Track } from '@gxaditya/vamp-schema';
import { estimateRenderedDuration } from '@gxaditya/vamp-schema';

import {
  MASTER_AUDIO_FILENAME,
  renderSongArtifacts,
  renderSongAudio,
  renderTimelineAudio,
  stemReconstructionToleranceLsb,
  type SampleRate,
  type StereoAudioBuffer,
} from '../src/index.js';
import {
  constantSignal,
  createSignalBackend,
  measureAudio,
  parseWav,
  readPcm16,
  sameBytes,
} from './audio-helpers.js';
import { baseSong, clipNote, clipTrack, compileOk } from './helpers.js';

const exampleRoot = fileURLToPath(new URL('../../../examples/songs/', import.meta.url));

type TailKind = 'nearSilence' | 'quietEnd' | 'audibleEnd' | 'truncatedAtBoundary';

interface ExampleProfile {
  readonly file: string;
  readonly label: string;
  /** ceil(renderedSeconds * sampleRate), exact, both rates. */
  readonly frames: Readonly<Record<SampleRate, number>>;
  /** Measured built-in master peak and RMS; the band is +/- 10 percent. */
  readonly peak: number;
  readonly rms: number;
  readonly tail: TailKind;
  readonly stems: number;
}

const EXAMPLES: readonly ExampleProfile[] = [
  {
    file: 'lofi-coding-bed.song.json',
    label: 'lofi 45 s bed',
    frames: { 44100: 1_984_500, 48000: 2_160_000 },
    peak: 0.407,
    rms: 0.0544,
    tail: 'nearSilence',
    stems: 5,
  },
  {
    file: 'explainer-upbeat.song.json',
    label: 'explainer 30 s bed',
    frames: { 44100: 1_323_000, 48000: 1_440_000 },
    peak: 0.416,
    rms: 0.0442,
    tail: 'audibleEnd',
    stems: 5,
  },
  {
    file: 'ambient-focus-bed.song.json',
    label: 'ambient 60 s bed',
    frames: { 44100: 2_646_000, 48000: 2_880_000 },
    peak: 0.1834,
    rms: 0.0542,
    tail: 'quietEnd',
    stems: 3,
  },
  {
    file: 'corporate-bed.song.json',
    label: 'corporate 30 s bed',
    frames: { 44100: 1_323_000, 48000: 1_440_000 },
    peak: 0.3811,
    rms: 0.0497,
    tail: 'quietEnd',
    stems: 5,
  },
  {
    file: 'tension-stinger.song.json',
    label: 'tension 6 s stinger',
    frames: { 44100: 264_600, 48000: 288_000 },
    peak: 0.4616,
    rms: 0.0671,
    tail: 'truncatedAtBoundary',
    stems: 4,
  },
];

function loadExample(file: string): SongSchemaV1 {
  return JSON.parse(readFileSync(join(exampleRoot, file), 'utf8')) as SongSchemaV1;
}

function windowRms(channel: Float32Array, sampleRate: number, from: number, to: number): number {
  const start = Math.max(0, Math.floor(from * sampleRate));
  const end = Math.min(channel.length, Math.ceil(to * sampleRate));
  let energy = 0;
  for (let frame = start; frame < end; frame += 1) {
    const value = channel[frame] ?? 0;
    energy += value * value;
  }
  return Math.sqrt(energy / Math.max(1, end - start));
}

/**
 * Goertzel band magnitude normalized so a pure sine of amplitude A measures
 * about A. Used for spectral tolerance checks that must hold on any platform.
 */
function toneAmplitude(
  channel: Float32Array,
  sampleRate: number,
  frequency: number,
  from: number,
  to: number,
): number {
  const start = Math.max(0, Math.floor(from * sampleRate));
  const end = Math.min(channel.length, Math.ceil(to * sampleRate));
  const omega = (2 * Math.PI * frequency) / sampleRate;
  const coefficient = 2 * Math.cos(omega);
  let previous1 = 0;
  let previous2 = 0;
  for (let frame = start; frame < end; frame += 1) {
    const current = (channel[frame] ?? 0) + coefficient * previous1 - previous2;
    previous2 = previous1;
    previous1 = current;
  }
  const real = previous1 - previous2 * Math.cos(omega);
  const imaginary = previous2 * Math.sin(omega);
  return (2 * Math.hypot(real, imaginary)) / Math.max(1, end - start);
}

function allFinite(audio: StereoAudioBuffer): boolean {
  for (let frame = 0; frame < audio.frameCount; frame += 1) {
    if (!Number.isFinite(audio.left[frame] ?? 0) || !Number.isFinite(audio.right[frame] ?? 0)) {
      return false;
    }
  }
  return true;
}

function pcmBytes(audio: StereoAudioBuffer): Uint8Array {
  const combined = new Uint8Array(audio.left.byteLength + audio.right.byteLength);
  combined.set(new Uint8Array(audio.left.buffer), 0);
  combined.set(new Uint8Array(audio.right.buffer), audio.left.byteLength);
  return combined;
}

const temporaryRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'vamp-regression-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop();
    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe('example cue tolerance regression (built-in backend)', () => {
  for (const example of EXAMPLES) {
    for (const sampleRate of [48000, 44100] as const) {
      it(`renders ${example.label} at ${sampleRate} Hz with exact duration, in-band energy and peak, and no clipping`, async () => {
        const song = loadExample(example.file);
        const result = await renderSongAudio(song, { sampleRate });
        if (!result.ok) {
          throw new Error(`${example.file} failed: ${JSON.stringify(result.errors)}`);
        }

        // Exact deterministic duration contract, not a tolerance:
        // renderedSamples = ceil(renderedSeconds * sampleRate).
        const estimate = estimateRenderedDuration(song);
        expect(result.timeline.renderedSamples).toBe(
          Math.ceil(estimate.renderedSeconds * sampleRate),
        );
        expect(result.audio.frameCount).toBe(example.frames[sampleRate]);
        expect(result.audio.frameCount).toBe(result.timeline.renderedSamples);

        // +/- 10 percent around the measured single-machine values. The band
        // absorbs cross-platform libm rounding in the Float32 mix while still
        // failing on real gain, voicing, or duration regressions.
        const metrics = measureAudio(result.audio);
        expect(metrics.peak).toBeGreaterThan(example.peak * 0.9);
        expect(metrics.peak).toBeLessThan(example.peak * 1.1);
        expect(metrics.rms).toBeGreaterThan(example.rms * 0.9);
        expect(metrics.rms).toBeLessThan(example.rms * 1.1);

        // Documented headroom: every example mixes below full scale with no
        // clamped samples and no unintended warnings.
        expect(metrics.peak).toBeLessThan(1);
        expect(allFinite(result.audio)).toBe(true);
        expect(result.warnings).toEqual([]);

        // Documented boundary behavior per cue. The stinger crash tail is
        // truncated at the render boundary by design (drum one-shot decay is
        // not in the tail formula); that is encoded here as audible residual
        // energy in the final 50 ms, not as a regression.
        const seconds = result.audio.frameCount / sampleRate;
        const tail = windowRms(result.audio.left, sampleRate, seconds - 0.05, seconds);
        const lastFrame = Math.abs(result.audio.left[result.audio.frameCount - 1] ?? 0);
        switch (example.tail) {
          case 'nearSilence': {
            // lofi's audible content ends at 44.733 s of 45 s. The trailing
            // hint region carries only the fully decayed reverb remainder
            // (below -110 dBFS), which is the documented tail-estimate
            // behavior: the estimate marks audibility, not exact zeros.
            expect(tail).toBeLessThan(1e-5);
            expect(lastFrame).toBeLessThan(1e-6);
            break;
          }
          case 'quietEnd': {
            expect(tail).toBeLessThan(1e-4);
            break;
          }
          case 'audibleEnd': {
            // The explainer pad releases within the final 50 ms: quiet but
            // measurably still sounding.
            expect(tail).toBeGreaterThan(1e-5);
            expect(tail).toBeLessThan(1e-2);
            break;
          }
          case 'truncatedAtBoundary': {
            expect(tail).toBeGreaterThan(2e-3);
            expect(lastFrame).toBeGreaterThan(1e-3);
            break;
          }
        }
      });
    }
  }

  it('keeps repeat built-in renders byte-identical for the short cues on this platform', async () => {
    for (const file of ['tension-stinger.song.json', 'corporate-bed.song.json']) {
      const song = loadExample(file);
      const first = await renderSongAudio(song, { sampleRate: 48000 });
      const second = await renderSongAudio(song, { sampleRate: 48000 });
      if (!first.ok || !second.ok) {
        throw new Error(`Repeat render failed for ${file}`);
      }
      expect(sameBytes(pcmBytes(first.audio), pcmBytes(second.audio))).toBe(true);
    }
  });

  it('reconstructs the master from independently decoded stems within the documented tolerance', async () => {
    for (const example of [
      EXAMPLES.find((entry) => entry.file === 'tension-stinger.song.json'),
      EXAMPLES.find((entry) => entry.file === 'lofi-coding-bed.song.json'),
    ]) {
      if (example === undefined) {
        throw new Error('expected stinger and lofi profiles');
      }
      const song = loadExample(example.file);
      const root = tempRoot();
      const outputDir = join(root, 'out');
      const result = await renderSongArtifacts(song, { outputDir, sampleRate: 48000 });
      if (!result.ok) {
        throw new Error(`${example.file} artifact render failed: ${JSON.stringify(result.errors)}`);
      }

      const tolerance = result.report.stemInvariant.pcm16ToleranceLsb;
      const stemFiles = readdirSync(outputDir)
        .filter((name) => name.startsWith('stem-'))
        .sort();
      expect(stemFiles.length).toBe(example.stems);
      expect(result.report.stems.length).toBe(example.stems);
      expect(tolerance).toBe(stemReconstructionToleranceLsb(stemFiles.length));

      const masterBytes = new Uint8Array(readFileSync(join(outputDir, MASTER_AUDIO_FILENAME)));
      const masterParsed = parseWav(masterBytes);
      expect(masterParsed.frameCount).toBe(result.report.duration.actualFrames);

      const stems = stemFiles.map((name) => {
        const bytes = new Uint8Array(readFileSync(join(outputDir, name)));
        return { bytes, parsed: parseWav(bytes) };
      });
      for (const stem of stems) {
        expect(stem.parsed.frameCount).toBe(masterParsed.frameCount);
      }

      let maximumDifference = 0;
      for (let frame = 0; frame < masterParsed.frameCount; frame += 1) {
        for (const channel of [0, 1] as const) {
          let sum = 0;
          for (const stem of stems) {
            sum += readPcm16(stem.bytes, stem.parsed, frame, channel);
          }
          const difference = Math.abs(sum - readPcm16(masterBytes, masterParsed, frame, channel));
          maximumDifference = Math.max(maximumDifference, difference);
        }
      }
      // Task 09 bound: ceil((stemCount + 1) / 2) signed 16-bit steps, with no
      // clamping at the 16-bit boundary in these cues. Typical difference is
      // 1 step; anything beyond the bound is a stem capture regression.
      expect(maximumDifference).toBeLessThanOrEqual(tolerance);
    }
  }, 90_000);
});

describe('effect and automation behavior through the full render path', () => {
  function signalSong(
    options: {
      effects?: Track['effects'];
      automation?: Track['automation'];
      extraTrack?: Partial<Track>;
    },
    durationHintBeats: number,
  ): SongSchemaV1 {
    const track = clipTrack('fx', [clipNote(60, 0, durationHintBeats - 0.1)], {
      instrument: { type: 'builtin', id: 'keys.soft' },
      ...options.extraTrack,
      ...(options.effects === undefined ? {} : { effects: options.effects }),
      ...(options.automation === undefined ? {} : { automation: options.automation }),
    });
    // 120 BPM: durationHint is in beats, so seconds = hint / 2.
    return baseSong({ bpm: 120, durationHint: durationHintBeats, tracks: [track] });
  }

  async function renderWithSignal(
    song: SongSchemaV1,
    signal: (frame: number) => number,
    sampleRate: SampleRate = 48000,
  ) {
    const result = await renderSongAudio(song, {
      sampleRate,
      backend: createSignalBackend(signal),
    });
    if (!result.ok) {
      throw new Error(`Signal render failed: ${JSON.stringify(result.errors)}`);
    }
    return result;
  }

  const twoTone = (frame: number): number =>
    0.25 * Math.sin((2 * Math.PI * 220 * frame) / 48000) +
    0.25 * Math.sin((2 * Math.PI * 6600 * frame) / 48000);

  it('places delay echoes at exact frame multiples with feedback decay through the mixer', async () => {
    // Four beats at 120 BPM is two seconds; timeMs 250 at 48 kHz puts echo n
    // exactly at frame n * round(0.25 * 48000) = n * 12000.
    const rendered = await renderWithSignal(
      signalSong({ effects: [{ type: 'delay', timeMs: 250, feedback: 0.5, mix: 0.25 }] }, 4),
      (frame) => (frame === 0 ? 1 : 0),
    );
    // Content 1.95 s + documented delay tail 0.25 * 10 = 2.5 s -> 4.45 s.
    expect(rendered.audio.frameCount).toBe(213_600);
    const delayFrames = 12_000;
    const center = Math.SQRT1_2; // static center pan is applied before effects
    const mix = 0.25;

    // The dry input itself at frame 0: (1 - mix) * impulse * pan gain.
    expect(rendered.audio.left[0] ?? 0).toBeCloseTo((1 - mix) * center, 6);
    for (let echo = 1; echo <= 4; echo += 1) {
      const at = echo * delayFrames;
      const expected = mix * Math.pow(0.5, echo - 1) * center;
      expect(rendered.audio.left[at] ?? 0).toBeCloseTo(expected, 6);
      // Nothing between echoes: the tail is exactly the echo train.
      expect(Math.abs(rendered.audio.left[at - 250] ?? 0)).toBeLessThan(1e-12);
      expect(Math.abs(rendered.audio.left[at + 250] ?? 0)).toBeLessThan(1e-12);
    }
    // Identical algorithms per channel keep the pan position exactly.
    expect(rendered.audio.right[2 * delayFrames] ?? 0).toBeCloseTo(mix * 0.5 * center, 6);
  });

  it('attenuates high-frequency content with a static low-pass by more than 20 dB', async () => {
    const dry = await renderWithSignal(signalSong({}, 4), twoTone);
    const wet = await renderWithSignal(
      signalSong({ effects: [{ type: 'lowpass', cutoffHz: 500, q: 0.707 }] }, 4),
      twoTone,
    );

    // Measure the second half so filter warm-up is excluded.
    const lowDry = toneAmplitude(dry.audio.left, 48000, 220, 1, 2);
    const highDry = toneAmplitude(dry.audio.left, 48000, 6600, 1, 2);
    const lowWet = toneAmplitude(wet.audio.left, 48000, 220, 1, 2);
    const highWet = toneAmplitude(wet.audio.left, 48000, 6600, 1, 2);

    expect(highDry).toBeGreaterThan(0.1);
    expect(lowDry).toBeGreaterThan(0.1);
    // A second-order RBJ low-pass at 500 Hz is tens of dB down at 6.6 kHz;
    // 20 dB is a conservative floor for a real attenuation regression.
    expect(20 * Math.log10(Math.max(highWet, 1e-12) / highDry)).toBeLessThan(-20);
    // The low band passes essentially untouched (within 1 dB).
    expect(Math.abs(20 * Math.log10(lowWet / lowDry))).toBeLessThan(1);
  });

  it('moves the low-pass cutoff with filterCutoffHz automation over time', async () => {
    // Cutoff sweeps 12000 Hz to 200 Hz across the first two beats and holds:
    // automation times are beats at 120 BPM, so the sweep covers the first
    // second of the two-second render.
    const rendered = await renderWithSignal(
      signalSong(
        {
          effects: [{ type: 'lowpass', q: 0.707 }],
          automation: {
            filterCutoffHz: {
              points: [
                { time: 0, value: 12000 },
                { time: 2, value: 200 },
                { time: 4, value: 200 },
              ],
            },
          },
        },
        4,
      ),
      twoTone,
    );
    expect(rendered.audio.frameCount).toBe(96_000);

    const highEarly = toneAmplitude(rendered.audio.left, 48000, 6600, 0, 0.4);
    const highLate = toneAmplitude(rendered.audio.left, 48000, 6600, 1.5, 1.95);
    const lowEarly = toneAmplitude(rendered.audio.left, 48000, 220, 0, 0.4);
    const lowLate = toneAmplitude(rendered.audio.left, 48000, 220, 1.5, 1.95);

    // Early the 12 kHz cutoff leaves the 6.6 kHz tone nearly untouched; late
    // the 400 Hz cutoff removes it by at least 26 dB.
    expect(highEarly).toBeGreaterThan(0.1);
    expect(20 * Math.log10(Math.max(highLate, 1e-12) / highEarly)).toBeLessThan(-26);
    // The low band rides through the sweep (constant source, so within 6 dB).
    expect(lowLate).toBeGreaterThan(lowEarly * 0.5);
  });

  it('applies volume automation as an absolute rising curve', async () => {
    const rendered = await renderWithSignal(
      signalSong(
        {
          automation: {
            volume: {
              points: [
                { time: 0, value: 0.4 },
                { time: 4, value: 1.6 },
              ],
            },
          },
        },
        4,
      ),
      constantSignal(0.2),
    );
    const firstHalf = windowRms(rendered.audio.left, 48000, 0.5, 1);
    const secondHalf = windowRms(rendered.audio.left, 48000, 1.5, 1.95);
    // Linear 0.4 to 1.6 across two seconds: the late window sits near 1.3 to
    // 1.55 while the early window sits near 0.5 to 0.7, a 2 to 3x level gap.
    // The 2 ms de-zipper lag only matters on sub-frame ramps.
    expect(secondHalf).toBeGreaterThan(firstHalf * 1.5);
    expect(secondHalf).toBeLessThan(firstHalf * 2.2);
  });

  it('renders long effect tails past the content and truncates them at the deterministic boundary', async () => {
    // Reverb decay 2.5 s extends the window by the documented tail estimate:
    // content ends at 0.2 s (hint 0.4 beats is below that), so rendered is
    // 0.2 + 2.5 = 2.7 s.
    const song = signalSong({ effects: [{ type: 'reverb', decaySeconds: 2.5, mix: 0.8 }] }, 0.5);
    const timeline = compileOk(song, { sampleRate: 48000 }).timeline;
    const track = timeline.tracks[0];
    expect(track?.tailSeconds).toBeCloseTo(2.5, 6);
    expect(timeline.renderedSeconds).toBeCloseTo(2.7, 4);
    expect(timeline.renderedSamples).toBe(Math.ceil(timeline.renderedSeconds * 48000));

    const rendered = await renderTimelineAudio(timeline, {
      backend: createSignalBackend((frame) => (frame === 0 ? 1 : 0)),
    });
    if (!rendered.ok) {
      throw new Error(`Tail render failed: ${JSON.stringify(rendered.errors)}`);
    }
    expect(rendered.audio.frameCount).toBe(timeline.renderedSamples);

    // Tail energy decays monotonically across the window and is still
    // nonzero at the boundary, where it is deterministically truncated. The
    // dry input exists only at frame 0, so everything past 0.2 s is tail.
    const early = windowRms(rendered.audio.left, 48000, 0.3, 0.4);
    const mid = windowRms(rendered.audio.left, 48000, 1.0, 1.1);
    const late = windowRms(rendered.audio.left, 48000, 2.4, 2.5);
    expect(early).toBeGreaterThan(1e-6);
    expect(early).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(late);
    expect(late).toBeGreaterThan(0);
    expect(allFinite(rendered.audio)).toBe(true);
  });
});

describe('mixing edge cases', () => {
  function twoTrackSong(first: Partial<Track> = {}, second: Partial<Track> = {}): SongSchemaV1 {
    return baseSong({
      bpm: 120,
      durationHint: 2,
      tracks: [
        clipTrack('a', [clipNote(60, 0, 0.9)], {
          instrument: { type: 'builtin', id: 'keys.soft' },
          ...first,
        }),
        clipTrack('b', [clipNote(64, 0.5, 0.9)], {
          channel: 1,
          instrument: { type: 'builtin', id: 'keys.soft' },
          ...second,
        }),
      ],
    });
  }

  it('drops muted tracks and honors solo semantics in the mix', async () => {
    const backend = createSignalBackend(constantSignal(0.3));

    const both = await renderSongAudio(twoTrackSong(), { sampleRate: 48000, backend });
    const muted = await renderSongAudio(twoTrackSong({}, { mute: true }), {
      sampleRate: 48000,
      backend,
    });
    const soloed = await renderSongAudio(twoTrackSong({ solo: true }, {}), {
      sampleRate: 48000,
      backend,
    });
    if (!both.ok || !muted.ok || !soloed.ok) {
      throw new Error('Mix render failed');
    }

    const compiledMute = compileOk(twoTrackSong({}, { mute: true }), { sampleRate: 48000 });
    expect(compiledMute.timeline.tracks.map((t) => t.audible)).toEqual([true, false]);
    const compiledSolo = compileOk(twoTrackSong({ solo: true }, {}), { sampleRate: 48000 });
    expect(compiledSolo.timeline.tracks.map((t) => t.audible)).toEqual([true, false]);

    // The signal backend ignores event timing and outputs a constant while
    // audible, so muting exactly halves the two-track center sum everywhere.
    for (let frame = 0; frame < both.audio.frameCount; frame += 1) {
      const full = both.audio.left[frame] ?? 0;
      const withoutB = muted.audio.left[frame] ?? 0;
      const soloA = soloed.audio.left[frame] ?? 0;
      expect(Number.isFinite(full)).toBe(true);
      expect(Math.abs(withoutB * 2 - full)).toBeLessThan(1e-6);
      expect(Math.abs(withoutB - soloA)).toBe(0);
    }
    expect(measureAudio(muted.audio).peak).toBeCloseTo(0.3 * Math.SQRT1_2, 6);
  });

  it('renders fully muted songs and note-less tracks as exact digital silence successes', async () => {
    const mutedRender = await renderSongAudio(twoTrackSong({ mute: true }, { mute: true }), {
      sampleRate: 48000,
    });
    expect(mutedRender.ok).toBe(true);
    if (mutedRender.ok) {
      expect(mutedRender.audio.frameCount).toBe(48_000);
      for (let frame = 0; frame < mutedRender.audio.frameCount; frame += 1) {
        expect(mutedRender.audio.left[frame]).toBe(0);
        expect(mutedRender.audio.right[frame]).toBe(0);
      }
    }

    // A track without notes or placements is not permitted by the schema
    // (SongSchemaV1 requires content per track), so "silent where permitted"
    // means fully muted songs above, not empty tracks. The rejection is part
    // of the malformed-file contract and stays a structured failure.
    const emptyTrackSong = baseSong({
      bpm: 120,
      durationHint: 2,
      tracks: [clipTrack('quiet', [], { instrument: { type: 'builtin', id: 'pad.warm' } })],
    });
    const emptyRender = await renderSongAudio(emptyTrackSong, { sampleRate: 44100 });
    expect(emptyRender.ok).toBe(false);
    if (!emptyRender.ok && emptyRender.stage === 'validation') {
      expect(emptyRender.errors[0]?.code).toBe('schema.structure.constraint_failed');
      expect(emptyRender.errors[0]?.path).toBe('/tracks/0');
    }
  });

  it('enforces the voice cap deterministically for dense polyphony', async () => {
    const notes: Note[] = [];
    for (let index = 0; index < 64; index += 1) {
      notes.push(clipNote(48 + index, 0, 1, 100));
    }
    const song = baseSong({
      bpm: 120,
      durationHint: 4,
      tracks: [clipTrack('dense', notes, { instrument: { type: 'builtin', id: 'keys.soft' } })],
    });
    const options = { sampleRate: 48000 as const, maxVoicesPerTrack: 16 };
    const first = await renderSongAudio(song, options);
    const second = await renderSongAudio(song, options);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) {
      return;
    }
    expect(first.stats.tracks[0]).toMatchObject({
      startedVoices: 16,
      droppedVoices: 48,
      stolenVoices: 0,
      peakActiveVoices: 16,
    });
    expect(first.warnings.filter((issue) => issue.code === 'audio.voice.dropped')).toHaveLength(1);
    expect(sameBytes(pcmBytes(first.audio), pcmBytes(second.audio))).toBe(true);
    const metrics = measureAudio(first.audio);
    expect(metrics.peak).toBeGreaterThan(0);
    expect(metrics.peak).toBeLessThanOrEqual(1);
  });

  it('renders repeated and overlapping pitches without artifacts and stays byte-deterministic', async () => {
    const song = baseSong({
      bpm: 120,
      durationHint: 4,
      tracks: [
        clipTrack(
          'echoes',
          [clipNote(60, 0, 1, 100), clipNote(60, 0.5, 1, 90), clipNote(60, 0.5, 1, 80)],
          { instrument: { type: 'builtin', id: 'piano.soft' } },
        ),
      ],
    });
    const first = await renderSongAudio(song, { sampleRate: 48000 });
    const second = await renderSongAudio(song, { sampleRate: 48000 });
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(sameBytes(pcmBytes(first.audio), pcmBytes(second.audio))).toBe(true);
    }
    expect(first.timeline.events).toHaveLength(3);
    const metrics = measureAudio(first.audio);
    expect(metrics.peak).toBeGreaterThan(0.01);
    expect(metrics.peak).toBeLessThanOrEqual(1);
    expect(allFinite(first.audio)).toBe(true);
  });

  it('mixes hard-panned tracks to opposite channels with equal-power gains', async () => {
    const backend = createSignalBackend(constantSignal(0.5));
    const panned = (id: string, pan: number): SongSchemaV1 =>
      baseSong({
        bpm: 120,
        durationHint: 2,
        tracks: [
          clipTrack(id, [clipNote(60, 0, 0.9)], {
            pan,
            instrument: { type: 'builtin', id: 'keys.soft' },
          }),
        ],
      });

    const leftOnly = await renderSongAudio(panned('lefty', -1), { sampleRate: 48000, backend });
    const rightOnly = await renderSongAudio(panned('righty', 1), { sampleRate: 48000, backend });
    const both = await renderSongAudio(twoTrackSong({ pan: -1 }, { pan: 1 }), {
      sampleRate: 48000,
      backend,
    });
    expect(leftOnly.ok).toBe(true);
    expect(rightOnly.ok).toBe(true);
    expect(both.ok).toBe(true);
    if (!leftOnly.ok || !rightOnly.ok || !both.ok) {
      return;
    }
    // Cardinal pan positions are exact: unity on one side, zero on the other.
    const frame = 24_000;
    expect(leftOnly.audio.left[frame] ?? 0).toBeCloseTo(0.5, 6);
    expect(Math.abs(leftOnly.audio.right[frame] ?? 0)).toBeLessThan(1e-9);
    expect(rightOnly.audio.right[frame] ?? 0).toBeCloseTo(0.5, 6);
    expect(Math.abs(rightOnly.audio.left[frame] ?? 0)).toBeLessThan(1e-9);
    // The summed two-track mix carries each side in its own channel.
    expect(both.audio.left[frame] ?? 0).toBeCloseTo(0.5, 6);
    expect(both.audio.right[frame] ?? 0).toBeCloseTo(0.5, 6);
  });
});

describe('malformed input and resource-limit regression', () => {
  it('rejects structurally and semantically invalid songs at the validation stage', async () => {
    const badVelocity = baseSong({
      tracks: [clipTrack('t', [{ pitch: 60, start: 0, duration: 1, velocity: 200 }])],
    });
    const velocityResult = await renderSongAudio(badVelocity, { sampleRate: 48000 });
    expect(velocityResult.ok).toBe(false);
    if (!velocityResult.ok && velocityResult.stage === 'validation') {
      expect(velocityResult.errors.some((issue) => issue.code.startsWith('schema.'))).toBe(true);
    }

    const futureVersion = { ...baseSong({}), schemaVersion: '2.5.0' };
    const versionResult = await renderSongAudio(futureVersion, { sampleRate: 48000 });
    expect(versionResult.ok).toBe(false);
    if (!versionResult.ok) {
      expect(versionResult.errors[0]?.code).toBe('schema.version.unsupported');
    }

    const nonFinite = JSON.parse(JSON.stringify(baseSong({})) as string) as Record<string, unknown>;
    (nonFinite['meta'] as Record<string, unknown>)['bpm'] = Number.POSITIVE_INFINITY;
    const nonFiniteResult = await renderSongAudio(nonFinite, { sampleRate: 48000 });
    expect(nonFiniteResult.ok).toBe(false);
    if (!nonFiniteResult.ok) {
      expect(nonFiniteResult.errors[0]?.code).toBe('value.non_finite');
    }
  });

  it('rejects forged timeline containers before touching DSP', async () => {
    const timeline = compileOk(baseSong({}), { sampleRate: 48000 }).timeline;
    // Mutable JSON copy so the forgery can set the read-only effects field.
    const forged = JSON.parse(JSON.stringify(timeline) as string) as {
      tracks?: { effects?: unknown }[];
    };
    const track = forged.tracks?.[0];
    if (track === undefined) {
      throw new Error('expected one track');
    }
    track.effects = [null];
    const result = await renderTimelineAudio(forged);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.code).toBe('audio.timeline.invalid');
    }
  });

  it('renders a delay-forged but valid timeline through the shared chain', async () => {
    // The same timeline with a genuine effect entry renders and encodes; the
    // boundary guard above must not over-reject.
    const timeline = compileOk(baseSong({}), { sampleRate: 48000 }).timeline;
    const withEffect = JSON.parse(JSON.stringify(timeline) as string) as {
      renderedSamples: number;
      tracks?: { effects?: unknown }[];
    };
    const track = withEffect.tracks?.[0];
    if (track === undefined) {
      throw new Error('expected one track');
    }
    track.effects = [{ type: 'delay', timeMs: 250, feedback: 0.5, mix: 0.25 }];
    const rendered = await renderTimelineAudio(withEffect);
    expect(rendered.ok).toBe(true);
    if (rendered.ok) {
      expect(rendered.audio.frameCount).toBe(withEffect.renderedSamples);
      expect(allFinite(rendered.audio)).toBe(true);
    }
  });

  it('enforces tightened compile limits through the render path', async () => {
    const song = loadExample('lofi-coding-bed.song.json');

    const durationCapped = await renderSongAudio(song, {
      sampleRate: 48000,
      limits: { maxRenderedSeconds: 10 },
    });
    expect(durationCapped.ok).toBe(false);
    if (!durationCapped.ok && durationCapped.stage === 'compile') {
      expect(durationCapped.errors[0]?.code).toBe('compile.limit.duration');
    }

    const noteCapped = await renderSongAudio(song, {
      sampleRate: 48000,
      limits: { maxAuthoredNotes: 5 },
    });
    expect(noteCapped.ok).toBe(false);
    if (!noteCapped.ok && noteCapped.stage === 'compile') {
      expect(noteCapped.errors[0]?.code).toBe('compile.limit.authored_notes');
    }

    const expandedCapped = await renderSongAudio(song, {
      sampleRate: 48000,
      limits: { maxExpandedNotes: 10 },
    });
    expect(expandedCapped.ok).toBe(false);
    if (!expandedCapped.ok && expandedCapped.stage === 'compile') {
      expect(expandedCapped.errors[0]?.code).toBe('compile.limit.expanded_notes');
    }
  });

  it('reports sample-rate mismatch instead of resampling', async () => {
    const timeline = compileOk(baseSong({}), { sampleRate: 48000 }).timeline;
    const result = await renderTimelineAudio(timeline, { sampleRate: 44100 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.code).toBe('audio.sample_rate.mismatch');
    }
  });
});
