/**
 * Task 17 example library tests.
 *
 * These checks protect the contract the examples teach: every song in
 * `examples/songs` is schema-valid against `SongSchemaV1` with the authoritative
 * curated instrument registry allowlist, every song declares a target duration
 * that its own effect tails fit inside, and the short examples render fully
 * offline through the deterministic built-in backend with the exact duration and
 * a clean report.
 *
 * They are deliberately light. Nothing here renders through a native backend,
 * and no generated WAV or MIDI bytes are committed. Task 18 builds the golden
 * audio regressions on top of this library.
 *
 * `@gxaditya/vamp-sdk` re-exports `validateSong` and `estimateRenderedDuration` unchanged
 * from `@gxaditya/vamp-schema` and the registry validation options from `@gxaditya/vamp-engine`, so
 * this root-level suite exercises the same validator the CLI and MCP server use
 * without giving the workspace root a direct dependency on shared packages.
 */

import { readFileSync, realpathSync } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  BUILTIN_SYNTH_BACKEND_ID,
  CURATED_INSTRUMENT_IDS,
  INSTRUMENT_REGISTRY_VALIDATION,
  createBuiltinSynthBackend,
  estimateRenderedDuration,
  renderSongArtifacts,
  validateSong,
  type SongSchemaV1,
} from '@gxaditya/vamp-sdk';

const songsRoot = fileURLToPath(new URL('../examples/songs/', import.meta.url));

interface ExampleExpectation {
  readonly file: string;
  readonly title: string;
  readonly bpm: number;
  /** Declared video target in seconds; equals `durationHint` converted at `bpm`. */
  readonly targetSeconds: number;
  readonly audibleTrackIds: readonly string[];
  /** Render offline in this suite. Long native renders stay out of the default run. */
  readonly renderedOffline: boolean;
}

const EXAMPLES: readonly ExampleExpectation[] = [
  {
    file: 'lofi-coding-bed.song.json',
    title: 'Notebook Drift',
    bpm: 90,
    targetSeconds: 45,
    audibleTrackIds: ['keys', 'piano', 'bass', 'pad', 'drums'],
    renderedOffline: true,
  },
  {
    file: 'explainer-upbeat.song.json',
    title: 'Sidebar Walkthrough',
    bpm: 112,
    targetSeconds: 30,
    audibleTrackIds: ['keys', 'bass', 'guitar', 'pad', 'drums'],
    renderedOffline: false,
  },
  {
    file: 'ambient-focus-bed.song.json',
    title: 'Deep Work',
    bpm: 60,
    targetSeconds: 60,
    audibleTrackIds: ['pad', 'drone', 'bells'],
    renderedOffline: false,
  },
  {
    file: 'corporate-bed.song.json',
    title: 'Quarterly Update Bed',
    bpm: 108,
    targetSeconds: 30,
    audibleTrackIds: ['piano', 'bass', 'guitar', 'pad', 'drums'],
    renderedOffline: false,
  },
  {
    file: 'tension-stinger.song.json',
    title: 'Cutaway Stinger',
    bpm: 110,
    targetSeconds: 6,
    audibleTrackIds: ['pulse', 'swell', 'pluck', 'hits'],
    renderedOffline: true,
  },
];

function loadSong(file: string): SongSchemaV1 {
  return JSON.parse(readFileSync(join(songsRoot, file), 'utf8')) as SongSchemaV1;
}

describe('Vamp example song library', () => {
  it('keeps the catalog complete', () => {
    expect(EXAMPLES).toHaveLength(5);
    for (const example of EXAMPLES) {
      expect(() => loadSong(example.file)).not.toThrow();
    }
  });

  for (const example of EXAMPLES) {
    describe(example.file, () => {
      const song = loadSong(example.file);

      it('matches its catalog metadata', () => {
        expect(song.meta.title).toBe(example.title);
        expect(song.meta.bpm).toBe(example.bpm);
        // Every example states an explicit seed so renders are reproducible.
        expect(Number.isInteger(song.meta.seed)).toBe(true);
        expect(song.meta.seed).toBeGreaterThanOrEqual(0);
        expect(song.tracks.length).toBeGreaterThanOrEqual(2);
        expect(song.tracks.length).toBeLessThanOrEqual(6);
      });

      it('validates against SongSchemaV1 with the curated registry allowlist', () => {
        const result = validateSong(song, INSTRUMENT_REGISTRY_VALIDATION);
        if (!result.ok) {
          throw new Error(
            `${example.file} failed validation: ${result.errors
              .map((issue) => `${issue.code} at ${issue.path}: ${issue.message}`)
              .join('; ')}`,
          );
        }
        expect(result.schemaVersion).toBe('1.0.0');
        expect(result.capabilityCheck).toBe('not_checked');
        // No unintended warnings: the examples must not rely on ignored fields.
        expect(result.warnings.map((issue) => `${issue.code} at ${issue.path}`)).toEqual([]);
      });

      it('stays inside what the built-in backend declares it supports', () => {
        // `@gxaditya/vamp-engine` backends declare `instrumentTypes` and `builtinIds`, while
        // `@gxaditya/vamp-schema` validation takes `supportedInstrumentTypes` and
        // `supportedBuiltinIds`. The examples map between the two shapes so a
        // capability failure here is a song problem, not a naming accident.
        const builtIn = createBuiltinSynthBackend();
        const result = validateSong(song, {
          ...INSTRUMENT_REGISTRY_VALIDATION,
          capabilities: {
            id: builtIn.id,
            supportedInstrumentTypes: builtIn.capabilities.instrumentTypes,
            supportedBuiltinIds: builtIn.capabilities.builtinIds,
          },
        });
        if (!result.ok) {
          throw new Error(
            `${example.file} is not renderable offline: ${result.errors
              .map((issue) => `${issue.code} at ${issue.path}`)
              .join('; ')}`,
          );
        }
        expect(result.capabilityCheck).toBe('checked');
      });

      it('only uses curated builtin instruments that both backends honor', () => {
        for (const track of song.tracks) {
          // Narrow the discriminated union instead of assuming the variant, so a
          // future gm or soundfont reference in an example fails loudly here.
          if (track.instrument.type !== 'builtin') {
            throw new Error(
              `${example.file} track "${track.id}" uses ${track.instrument.type}, ` +
                'which the built-in backend cannot render.',
            );
          }
          expect(CURATED_INSTRUMENT_IDS).toContain(track.instrument.id);
        }
        // Exactly one drums track at most, so the kit is never doubled.
        expect(song.tracks.filter((track) => track.kind === 'drums').length).toBeLessThanOrEqual(1);
      });

      it('declares a target duration its own tails fit inside', () => {
        const estimate = estimateRenderedDuration(song);
        expect(estimate.hintSeconds).toBeCloseTo(example.targetSeconds, 6);
        // The documented formula is max(hint, last sound). Reaching the target
        // exactly means no effect tail spills past the video cut.
        expect(estimate.lastSoundSeconds).toBeLessThanOrEqual(estimate.hintSeconds + 1e-9);
        expect(estimate.renderedSeconds).toBeCloseTo(example.targetSeconds, 6);
      });

      it('ends every audible track before the target so releases are clean', () => {
        const estimate = estimateRenderedDuration(song);
        for (const track of estimate.tracks) {
          if (!track.audible) {
            continue;
          }
          expect(track.contentEndBeats).toBeGreaterThan(0);
          expect(track.endSeconds).toBeLessThanOrEqual(estimate.hintSeconds + 1e-9);
        }
        expect(estimate.tracks.map((track) => track.trackId)).toEqual(example.audibleTrackIds);
      });
    });
  }
});

describe('offline built-in renders of the short examples', () => {
  const rendered = EXAMPLES.filter((example) => example.renderedOffline);

  it('renders the built-in path with no native dependency', async () => {
    const outputRoot = realpathSync.native(await mkdtemp(join(tmpdir(), 'vamp-examples-render-')));
    try {
      for (const example of rendered) {
        const song = loadSong(example.file);
        const outputDir = join(outputRoot, example.file.replace(/\.song\.json$/, ''));
        const result = await renderSongArtifacts(song, { outputDir, sampleRate: 48_000 });
        if (!result.ok) {
          throw new Error(
            `${example.file} failed at stage ${result.stage}: ${JSON.stringify(
              'errors' in result ? result.errors : [],
            )}`,
          );
        }

        const { report } = result;
        expect(report.backend.id).toBe(BUILTIN_SYNTH_BACKEND_ID);
        // Duration contract: the report lands on the declared video target.
        expect(report.duration.requestedSeconds).toBeCloseTo(example.targetSeconds, 6);
        expect(report.duration.actualSeconds).toBeCloseTo(example.targetSeconds, 6);
        expect(report.duration.actualFrames).toBe(Math.round(example.targetSeconds * 48_000));
        expect(report.duration.deltaSeconds).toBeCloseTo(0, 6);

        // No unintended clipping anywhere in the master or the stems.
        expect(report.audio.clipping.clipped).toBe(false);
        expect(report.audio.clipping.clippedSampleCount).toBe(0);
        expect(report.audio.clipping.clippedFrameCount).toBe(0);
        for (const stem of report.stems) {
          expect(stem.audio.wav?.clippedSampleCount).toBe(0);
        }

        // No missing-instrument or backend issues, and no silent substitution.
        const issueCodes = [
          ...report.warnings.audio.map((i) => i.code),
          ...result.warnings.map((i) => i.code),
        ];
        expect(issueCodes).toEqual([]);
        expect(report.warnings.validation).toEqual([]);
        expect(report.assets.project).toEqual([]);

        // The render is audible but keeps headroom below full scale.
        expect(report.audio.peak).toBeGreaterThan(0);
        expect(report.audio.peak).toBeLessThanOrEqual(1);
        expect(report.stems.map((stem) => stem.trackId)).toEqual(example.audibleTrackIds);

        // Complete artifact set on disk, and the master is exactly the reported length.
        const master = await stat(join(outputDir, 'master.wav'));
        expect(master.size).toBe(44 + report.duration.actualFrames * 4);
        await expect(stat(join(outputDir, 'song.mid'))).resolves.toBeTruthy();
        await expect(stat(join(outputDir, 'report.json'))).resolves.toBeTruthy();
      }
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  }, 60_000);
});
