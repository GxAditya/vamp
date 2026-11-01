/**
 * Integration test: the SDK drives a complete local workflow against a
 * temporary projects root: create -> edit -> validate -> render -> report
 * inspection -> revision-safe edit -> re-render.
 *
 * It uses the deterministic built-in synthesizer only, so no native
 * dependency and no network access are required.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  VampClient,
  type Note,
  type ProjectRenderSuccess,
  type ProjectSnapshot,
  type SongSchemaV1,
} from '../src/index.js';

function draftSong(): SongSchemaV1 {
  const keys: Note[] = [
    { pitch: 60, start: 0, duration: 1.5, velocity: 84 },
    { pitch: 64, start: 2, duration: 1.5, velocity: 80 },
    { pitch: 67, start: 4, duration: 1.5, velocity: 84 },
    { pitch: 71, start: 6, duration: 1.5, velocity: 88 },
  ];
  return {
    schemaVersion: '1.0.0',
    meta: {
      title: 'SDK Workflow',
      bpm: 120,
      timeSignature: { numerator: 4, denominator: 4 },
      key: { tonic: 'C', mode: 'major' },
      seed: 42,
      durationHint: 8,
      mood: 'calm',
      tags: ['sdk', 'fixture'],
    },
    tracks: [
      {
        id: 'keys',
        name: 'Keys',
        kind: 'midi',
        channel: 0,
        instrument: { type: 'builtin', id: 'keys.soft' },
        volume: 0.85,
        notes: keys,
      },
      {
        id: 'bass',
        name: 'Bass',
        kind: 'midi',
        channel: 1,
        instrument: { type: 'builtin', id: 'bass.sub' },
        volume: 0.9,
        notes: [
          { pitch: 36, start: 0, duration: 1.75, velocity: 96 },
          { pitch: 43, start: 4, duration: 1.75, velocity: 92 },
        ],
      },
      {
        id: 'drums',
        name: 'Drums',
        kind: 'drums',
        channel: 9,
        instrument: { type: 'builtin', id: 'drums.kit' },
        volume: 0.7,
        notes: [
          { pitch: 36, start: 0, duration: 0.25, velocity: 108 },
          { pitch: 38, start: 1, duration: 0.25, velocity: 96 },
          { pitch: 36, start: 4, duration: 0.25, velocity: 108 },
          { pitch: 38, start: 5, duration: 0.25, velocity: 96 },
        ],
      },
    ],
  };
}

describe('SDK end-to-end local workflow', () => {
  let root = '';
  let client: VampClient;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'vamp-sdk-workflow-'));
    client = new VampClient({ root });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('creates, edits, validates, renders, inspects the report, edits safely, and re-renders', async () => {
    // Discovery before authoring.
    const schema = client.describeSchema();
    expect(schema.jsonSchema['properties']).toBeTypeOf('object');
    const instruments = client.listInstruments();
    const registryIds = instruments.instruments.map((entry) => entry.id);
    expect(registryIds).toEqual(expect.arrayContaining(['keys.soft', 'bass.sub', 'drums.kit']));

    // Author and validate a draft before saving.
    const draft = draftSong();
    const validated = client.validate(draft);
    expect(validated.ok).toBe(true);

    // Create the project. Revisioned metadata starts at 1.
    const created = await client.createProject({ projectId: 'sdk-demo', song: draft });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      throw new Error(`${String(created.code)}: ${created.message}`);
    }
    const initial = created.value;
    expect(initial.revision).toBe(1);
    expect(initial.song.meta.title).toBe('SDK Workflow');

    const listed = await client.listProjects();
    expect(listed.ok && listed.value.length).toBe(1);

    // Granular revision-safe edit: append notes on the keys track.
    const edited = await client.addNotes('sdk-demo', {
      expectedRevision: 1,
      trackId: 'keys',
      notes: [{ pitch: 72, start: 7, duration: 0.5, velocity: 76 }],
    });
    expect(edited.ok).toBe(true);
    if (!edited.ok) {
      throw new Error(`${String(edited.code)}: ${edited.message}`);
    }
    const editedSnapshot = edited.value;
    expect(editedSnapshot.revision).toBe(2);

    // The stored song is validated on read; stale edits conflict.
    const stale = await client.addNotes('sdk-demo', {
      expectedRevision: 1,
      trackId: 'keys',
      notes: [{ pitch: 65, start: 3, duration: 0.5 }],
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.code).toBe('project.revision.conflict');
      expect(stale.expectedRevision).toBe(1);
      expect(stale.actualRevision).toBe(2);
      expect(stale.projectId).toBe('sdk-demo');
    }

    // An invalid replacement song fails with repairable schema issues.
    const broken = { ...draft, meta: { ...draft.meta, bpm: 0 } };
    const invalidUpdate = await client.updateSong('sdk-demo', {
      expectedRevision: 2,
      song: broken,
    });
    expect(invalidUpdate.ok).toBe(false);
    if (!invalidUpdate.ok) {
      expect(invalidUpdate.code).toBe('project.song.invalid');
      expect(invalidUpdate.issues?.length).toBeGreaterThan(0);
    }
    const stillCurrent = await client.getProject('sdk-demo');
    expect(stillCurrent.ok && stillCurrent.value.revision).toBe(2);

    // Render the current revision into the confined renders/ tree with the
    // built-in backend. 44.1 kHz keeps the fixture fast; behavior is shared.
    const rendered = await client.renderProject('sdk-demo', {
      expectedRevision: 2,
      sampleRate: 44100,
    });
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) {
      throw new Error(
        'code' in rendered
          ? `${String(rendered.code)}: ${rendered.message}`
          : `stage ${rendered.stage}: ${rendered.errors[0]?.message ?? 'no issues'}`,
      );
    }
    const render = rendered.value satisfies ProjectRenderSuccess;
    expect(render.projectId).toBe('sdk-demo');
    expect(render.revision).toBe(2);
    expect(render.renderPath).toBe('renders');
    expect(render.report.title).toBe('SDK Workflow');

    const outputDir = render.outputDir;
    const masterPath = join(outputDir, 'master.wav');
    const midiPath = join(outputDir, 'song.mid');
    const reportPath = join(outputDir, 'report.json');

    const master = await readFile(masterPath);
    expect(master.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(master.subarray(8, 12).toString('ascii')).toBe('WAVE');

    const midi = await readFile(midiPath);
    expect(midi.subarray(0, 4).toString('ascii')).toBe('MThd');

    // The published report parses and agrees with the in-memory report.
    const parsedReport = JSON.parse(await readFile(reportPath, 'utf8')) as {
      format: string;
      formatVersion: number;
      duration: { actualSeconds: number; sampleRate: number };
    };
    expect(parsedReport.format).toBe('vamp.render-report');
    expect(parsedReport.formatVersion).toBe(1);
    expect(parsedReport.duration.actualSeconds).toBeGreaterThan(3);
    expect(parsedReport.duration.actualSeconds).toBeLessThanOrEqual(
      render.report.duration.actualSeconds + 0.0001,
    );
    expect(parsedReport.duration.sampleRate).toBe(44100);
    expect(render.report.stems.length).toBe(3);
    for (const artifact of render.artifacts) {
      const bytes = await readFile(join(outputDir, artifact.path));
      expect(bytes.byteLength).toBe(artifact.bytes);
    }

    // Re-rendering the same destination without overwrite is refused with the
    // shared artifact-exists issue and publishes nothing partial.
    const collision = await client.renderProject('sdk-demo', {
      sampleRate: 44100,
      renderPath: 'renders',
    });
    expect(collision.ok).toBe(false);
    if (!collision.ok && 'errors' in collision) {
      expect(collision.errors.map((issue) => issue.code)).toContain('audio.artifacts.exists');
    }

    // A render pinned to a stale revision conflicts before touching the engine.
    const staleRender = await client.renderProject('sdk-demo', { expectedRevision: 1 });
    expect(staleRender.ok).toBe(false);
    if (!staleRender.ok && 'code' in staleRender) {
      expect(staleRender.code).toBe('project.revision.conflict');
      expect(staleRender.actualRevision).toBe(2);
    }

    // Revision-safe edit against the current revision, then re-render into a
    // new confined destination with the pattern API exercised end to end.
    const patterned = await client.setPattern('sdk-demo', {
      expectedRevision: 2,
      pattern: {
        id: 'tail',
        name: 'Tail',
        lengthBeats: 2,
        notes: [{ pitch: 72, start: 0, duration: 1.5, velocity: 70 }],
      },
    });
    expect(patterned.ok).toBe(true);
    if (!patterned.ok) {
      throw new Error(`${String(patterned.code)}: ${patterned.message}`);
    }
    const nextSnapshot: ProjectSnapshot = patterned.value;
    expect(nextSnapshot.revision).toBe(3);

    const withPlacement = await client.updateSong('sdk-demo', {
      expectedRevision: 3,
      song: {
        ...nextSnapshot.song,
        tracks: nextSnapshot.song.tracks.map((track) =>
          track.id === 'keys' ? { ...track, placements: [{ pattern: 'tail', start: 8 }] } : track,
        ),
        meta: { ...nextSnapshot.song.meta, durationHint: 10, title: 'SDK Workflow v2' },
      },
    });
    expect(withPlacement.ok).toBe(true);
    expect(withPlacement.ok && withPlacement.value.revision).toBe(4);

    const rerendered = await client.renderProject('sdk-demo', {
      expectedRevision: 4,
      sampleRate: 44100,
      renderPath: 'renders/v2',
      overwrite: true,
    });
    expect(rerendered.ok).toBe(true);
    if (rerendered.ok) {
      expect(rerendered.value.revision).toBe(4);
      expect(rerendered.value.renderPath).toBe('renders/v2');
      expect(rerendered.value.report.title).toBe('SDK Workflow v2');
      expect(rerendered.value.report.duration.requestedBeats).toBe(10);
      const reportAgain = JSON.parse(
        await readFile(join(rerendered.value.outputDir, 'report.json'), 'utf8'),
      ) as { title: string };
      expect(reportAgain.title).toBe('SDK Workflow v2');
    }

    // Render destinations stay inside the project directory.
    const escape = await client.renderProject('sdk-demo', { renderPath: 'renders/../outside' });
    expect(escape.ok).toBe(false);
    if (!escape.ok && 'code' in escape) {
      expect(escape.code).toBe('project.path.confined');
    }
  });
});
