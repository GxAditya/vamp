/**
 * Vamp SDK quickstart: a complete local BGM workflow with the thin typed
 * TypeScript SDK. No network access, no service, and no native dependency is
 * required. Run from the repository root after `pnpm build`:
 *
 *   node examples/sdk-quickstart.mjs
 *
 * Everything below runs against a temporary projects root, so it is safe to
 * re-run. It mirrors the agent workflow: describe -> discover -> author ->
 * validate -> render -> inspect -> edit -> re-render.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { VampClient } from '@gxaditya/vamp-sdk';

const root = await mkdtemp(join(tmpdir(), 'vamp-sdk-quickstart-'));
try {
  // 1. The client is a thin typed facade over the shared schema, engine, and
  //    project libraries. One line, no server to start.
  const client = new VampClient({ root });
  console.log(`projects root: ${root}`);

  // 2. Discover the schema and the curated instruments before authoring.
  const { schemaVersion } = client.describeSchema();
  const instruments = client.listInstruments();
  const curatedIds = instruments.instruments.map((entry) => entry.id);
  console.log(`schemaVersion: ${schemaVersion}`);
  console.log(`instruments: ${curatedIds.join(', ')}`);

  // 3. Author an editable SongSchemaV1 draft: a short, sparse 8-bar coding
  //    BGM loop using only deterministic built-in instruments.
  const draft = {
    schemaVersion: '1.0.0',
    meta: {
      title: 'Quickstart Focus Bed',
      bpm: 92,
      timeSignature: { numerator: 4, denominator: 4 },
      key: { tonic: 'A', mode: 'minor' },
      seed: 21,
      durationHint: 16,
      mood: 'calm',
      tags: ['bgm', 'focus'],
    },
    tracks: [
      {
        id: 'pad',
        name: 'Pad',
        kind: 'midi',
        channel: 0,
        instrument: { type: 'builtin', id: 'pad.warm' },
        volume: 0.6,
        pan: -0.2,
        notes: [
          { pitch: 57, start: 0, duration: 7.5, velocity: 64 },
          { pitch: 60, start: 0, duration: 7.5, velocity: 58 },
          { pitch: 64, start: 8, duration: 7.5, velocity: 62 },
          { pitch: 67, start: 8, duration: 7.5, velocity: 58 },
        ],
      },
      {
        id: 'bass',
        name: 'Bass',
        kind: 'midi',
        channel: 1,
        instrument: { type: 'builtin', id: 'bass.sub' },
        volume: 0.8,
        notes: [
          { pitch: 33, start: 0, duration: 3.5, velocity: 88 },
          { pitch: 40, start: 4, duration: 3.5, velocity: 84 },
          { pitch: 36, start: 8, duration: 3.5, velocity: 88 },
          { pitch: 43, start: 12, duration: 3.5, velocity: 82 },
        ],
      },
      {
        id: 'keys',
        name: 'Keys',
        kind: 'midi',
        channel: 2,
        instrument: { type: 'builtin', id: 'keys.soft' },
        volume: 0.7,
        pan: 0.15,
        notes: [
          { pitch: 69, start: 2, duration: 1.5, velocity: 72 },
          { pitch: 72, start: 6, duration: 1.5, velocity: 70 },
          { pitch: 76, start: 10, duration: 1.5, velocity: 72 },
          { pitch: 74, start: 14, duration: 1.5, velocity: 68 },
        ],
      },
    ],
  };

  // 4. Validate first. The result carries stable, repairable issues and
  //    warnings; validation never mutates the draft.
  const validated = client.validate(draft);
  if (!validated.ok) {
    for (const issue of validated.errors) {
      console.error(
        `validation ${issue.severity} ${issue.code} at ${issue.path}: ${issue.message}`,
      );
    }
    throw new Error('the draft song failed validation');
  }
  console.log(`validate: ok (${validated.warnings.length} warning(s))`);

  // 5. Save it as a project. Storage validates again and records revision 1.
  const created = await client.createProject({ projectId: 'quickstart', song: draft });
  if (!created.ok) {
    throw new Error(`${created.code}: ${created.message}`);
  }
  console.log(`create: revision ${created.value.revision}`);

  // 6. Every edit must pass the revision it was based on. A stale revision is
  //    refused with project.revision.conflict instead of overwriting work.
  const stale = await client.updateTrack('quickstart', {
    expectedRevision: 99,
    trackId: 'keys',
    changes: { volume: 0.5 },
  });
  console.log(
    `stale edit: rejected with ${stale.ok === false ? stale.code : 'unexpected success'}`,
  );

  const edited = await client.addNotes('quickstart', {
    expectedRevision: 1,
    trackId: 'keys',
    notes: [{ pitch: 69, start: 15, duration: 0.5, velocity: 60 }],
  });
  if (!edited.ok) {
    throw new Error(`${edited.code}: ${edited.message}`);
  }
  console.log(`edit: revision ${edited.value.revision}`);

  // 7. Render master WAV, per-track stems, MIDI, and the JSON report into the
  //    project's confined renders/ directory with the built-in backend.
  const rendered = await client.renderProject('quickstart', {
    expectedRevision: edited.value.revision,
    sampleRate: 44100,
  });
  if (!rendered.ok) {
    throw new Error(`render failed: ${'code' in rendered ? rendered.code : rendered.stage}`);
  }
  console.log(`render: ${rendered.value.renderPath} at revision ${rendered.value.revision}`);
  for (const artifact of rendered.value.artifacts) {
    console.log(`  ${artifact.role.padEnd(6)} ${artifact.path} (${artifact.bytes} bytes)`);
  }

  // 8. Inspect the report before shipping. It states the real rendered
  //    duration, backend, clipping, loudness, and every honest warning.
  const reportFile = await readFile(join(rendered.value.outputDir, 'report.json'), 'utf8');
  const report = JSON.parse(reportFile);
  console.log(
    `report: ${report.duration.actualSeconds.toFixed(2)}s actual vs ${report.duration.requestedSeconds.toFixed(2)}s requested, clipped samples: ${report.audio.clipping.clippedSampleCount}`,
  );

  // 9. Revision-safe re-render after a follow-up edit.
  const quieter = await client.updateTrack('quickstart', {
    expectedRevision: edited.value.revision,
    trackId: 'pad',
    changes: { volume: 0.5 },
  });
  if (!quieter.ok) {
    throw new Error(`${quieter.code}: ${quieter.message}`);
  }
  const rerender = await client.renderProject('quickstart', {
    expectedRevision: quieter.value.revision,
    sampleRate: 44100,
    renderPath: 'renders/v2',
  });
  if (!rerender.ok) {
    throw new Error('the re-render failed');
  }
  console.log(`re-render: renders/v2 at revision ${rerender.value.revision}`);
  console.log('done: everything ran locally with no network access.');
} finally {
  await rm(root, { recursive: true, force: true });
}
