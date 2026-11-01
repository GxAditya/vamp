/**
 * Vamp SDK: render one in-memory song without touching project storage.
 *
 * `@gxaditya/vamp-sdk` re-exports the shared engine operations directly, so an
 * embedded consumer can validate and render in one process with no files
 * saved at all. Run from the repository root after `pnpm build`:
 *
 *   node examples/sdk-render-from-memory.mjs
 *
 * The render is deterministic, offline, and uses the built-in synthesizer.
 * Output goes to a temporary directory and is removed on exit.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { estimateRenderedDuration, renderSongArtifacts, validateSong } from '@gxaditya/vamp-sdk';

const song = {
  schemaVersion: '1.0.0',
  meta: {
    title: 'Memory Render Stinger',
    bpm: 100,
    timeSignature: { numerator: 4, denominator: 4 },
    key: { tonic: 'D', mode: 'minor' },
    seed: 5,
    durationHint: 4,
  },
  tracks: [
    {
      id: 'bass',
      name: 'Bass',
      kind: 'midi',
      channel: 0,
      instrument: { type: 'builtin', id: 'bass.sub' },
      notes: [
        { pitch: 38, start: 0, duration: 1.75, velocity: 100 },
        { pitch: 45, start: 2, duration: 1.75, velocity: 96 },
      ],
    },
    {
      id: 'drums',
      name: 'Drums',
      kind: 'drums',
      channel: 9,
      instrument: { type: 'builtin', id: 'drums.kit' },
      notes: [
        { pitch: 36, start: 0, duration: 0.25, velocity: 110 },
        { pitch: 38, start: 1, duration: 0.25, velocity: 98 },
        { pitch: 36, start: 2, duration: 0.25, velocity: 106 },
        { pitch: 49, start: 3.5, duration: 0.25, velocity: 84 },
      ],
    },
  ],
};

// Shared validation from @gxaditya/vamp-schema, re-exported unchanged. Synchronous,
// deterministic, and it never mutates the input.
const validation = validateSong(song);
if (!validation.ok) {
  for (const issue of validation.errors) {
    console.error(`${issue.code} at ${issue.path}: ${issue.message}`);
  }
  throw new Error('song failed validation');
}

const estimate = estimateRenderedDuration(song);
console.log(
  `estimate: ${estimate.renderedSeconds.toFixed(2)}s rendered (hint ${estimate.hintSeconds.toFixed(2)}s, last sound ${estimate.lastSoundSeconds.toFixed(2)}s)`,
);

const outputDir = await mkdtemp(join(tmpdir(), 'vamp-sdk-render-'));
try {
  const result = await renderSongArtifacts(song, {
    outputDir,
    sampleRate: 44100,
  });
  if (!result.ok) {
    const first = result.errors[0];
    throw new Error(`render failed at stage ${result.stage}: ${first?.message ?? 'no issues'}`);
  }
  console.log(`rendered to ${outputDir}`);
  for (const artifact of result.artifacts) {
    console.log(`  ${artifact.role.padEnd(6)} ${artifact.path} (${artifact.bytes} bytes)`);
  }
  const report = JSON.parse(await readFile(join(outputDir, 'report.json'), 'utf8'));
  console.log(
    `report says: actual ${report.duration.actualSeconds.toFixed(2)}s, peak dBFS ${String(report.audio.peakDbfs)}, stems ${String(report.stems.length)}`,
  );
  for (const warning of result.warnings) {
    console.log(`warning: ${warning.code} at ${warning.path}: ${warning.message}`);
  }
} finally {
  await rm(outputDir, { recursive: true, force: true });
}
