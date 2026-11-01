import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { Pattern, SongSchemaV1, Track } from '@gxaditya/vamp-schema';

import {
  DEFAULT_PROJECT_LIMITS,
  PROJECT_LAYOUT,
  ProjectStore,
  type ProjectError,
  type ProjectErrorCode,
  type ProjectResult,
  type ProjectSnapshot,
} from '../src/index.js';
import { writeFileAtomic } from '../src/atomic.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface Harness {
  readonly base: string;
  readonly root: string;
  readonly store: ProjectStore;
}

function makeHarness(limits: Partial<typeof DEFAULT_PROJECT_LIMITS> = {}): Harness {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'vamp-project-test-')));
  temporaryDirectories.push(base);
  const root = join(base, 'projects');
  mkdirSync(root);
  return { base, root, store: new ProjectStore({ root, limits }) };
}

function minimalSong(title = 'Minimal Project'): SongSchemaV1 {
  return {
    schemaVersion: '1.0.0',
    meta: {
      title,
      bpm: 90,
      timeSignature: { numerator: 4, denominator: 4 },
      key: { tonic: 'C', mode: 'major' },
      seed: 7,
      durationHint: 8,
      mood: 'focused',
      tags: ['test'],
      createdAt: '2026-01-02T03:04:05.000Z',
    },
    tracks: [
      {
        id: 'keys',
        name: 'Keys',
        kind: 'midi',
        channel: 0,
        instrument: { type: 'builtin', id: 'keys.soft' },
        notes: [
          { pitch: 60, start: 0, duration: 2 },
          { pitch: 64, start: 2, duration: 2 },
        ],
      },
    ],
  };
}

function secondTrack(): Track {
  return {
    id: 'bass',
    name: 'Bass',
    kind: 'midi',
    channel: 1,
    instrument: { type: 'builtin', id: 'bass.sub' },
    notes: [{ pitch: 36, start: 0, duration: 4 }],
  };
}

function pattern(): Pattern {
  return {
    id: 'riff',
    name: 'Riff',
    lengthBeats: 4,
    notes: [
      { pitch: 67, start: 0, duration: 1 },
      { pitch: 69, start: 2, duration: 1 },
    ],
  };
}

function unwrap<T>(result: ProjectResult<T>): T {
  if (!result.ok) {
    throw new Error(`Expected success, received ${result.code}: ${result.message}`);
  }
  return result.value;
}

function expectFailure<T>(result: ProjectResult<T>, code?: ProjectErrorCode): ProjectError {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error('Expected a structured failure.');
  }
  if (code) {
    expect(result.code).toBe(code);
  }
  return result;
}

async function createProject(
  store: ProjectStore,
  projectId = 'demo',
  song: SongSchemaV1 = minimalSong(),
): Promise<ProjectSnapshot> {
  return unwrap(await store.create({ projectId, song }));
}

function projectDirectory(harness: Harness, projectId = 'demo'): string {
  return join(harness.root, projectId);
}

function readBytes(path: string): Buffer {
  return readFileSync(path);
}

function songPath(harness: Harness, projectId = 'demo'): string {
  return join(projectDirectory(harness, projectId), PROJECT_LAYOUT.songFile);
}

function metadataPath(harness: Harness, projectId = 'demo'): string {
  return join(projectDirectory(harness, projectId), PROJECT_LAYOUT.metadataFile);
}

function assertNoTemporaryFiles(directory: string): void {
  expect(readdirSync(directory).filter((name) => name.startsWith('.vamp-tmp-'))).toEqual([]);
}

describe('project creation, reading, listing, and location', () => {
  it('creates the documented layout and reads through a fresh store instance', async () => {
    const harness = makeHarness();
    const created = await createProject(harness.store);
    expect(created.revision).toBe(1);
    expect(created.title).toBe('Minimal Project');
    expect(created.song).toStrictEqual(minimalSong());

    const directory = projectDirectory(harness);
    for (const name of [
      PROJECT_LAYOUT.songFile,
      PROJECT_LAYOUT.metadataFile,
      PROJECT_LAYOUT.assetsDirectory,
      PROJECT_LAYOUT.rendersDirectory,
    ]) {
      expect(statSync(join(directory, name))).toBeDefined();
    }
    expect(statSync(join(directory, PROJECT_LAYOUT.assetsDirectory)).isDirectory()).toBe(true);
    expect(statSync(join(directory, PROJECT_LAYOUT.rendersDirectory)).isDirectory()).toBe(true);

    const fresh = new ProjectStore({ root: harness.root });
    const loaded = unwrap(await fresh.get('demo'));
    expect(loaded).toStrictEqual(created);

    const location = unwrap(await fresh.getLocation('demo'));
    expect(location.directory).toBe(directory);
    expect(location.songPath).toBe(songPath(harness));
    expect(location.assetsDirectory).toBe(join(directory, 'assets'));
    expect(location.rendersDirectory).toBe(join(directory, 'renders'));
  });

  it('lists complete projects in stable id order and ignores unrelated entries', async () => {
    const harness = makeHarness();
    await createProject(harness.store, 'zeta', minimalSong('Zeta'));
    await createProject(harness.store, 'alpha', minimalSong('Alpha'));
    mkdirSync(join(harness.root, 'not-a-project'));
    writeFileSync(join(harness.root, 'README.txt'), 'ignore me');

    const listed = unwrap(await harness.store.list());
    expect(listed.map((project) => project.projectId)).toEqual(['alpha', 'zeta']);
    expect(listed.map((project) => project.title)).toEqual(['Alpha', 'Zeta']);
  });

  it('reports missing projects and duplicate creation', async () => {
    const harness = makeHarness();
    expectFailure(await harness.store.get('missing'), 'project.not_found');
    await createProject(harness.store);
    expectFailure(
      await harness.store.create({ projectId: 'demo', song: minimalSong() }),
      'project.exists',
    );
  });
});

describe('song replacement and granular editing', () => {
  it('edits tracks, notes, patterns, and instruments while preserving song metadata', async () => {
    const harness = makeHarness();
    let snapshot = await createProject(harness.store);
    const originalMeta = snapshot.song.meta;

    snapshot = unwrap(
      await harness.store.addTrack('demo', {
        expectedRevision: snapshot.revision,
        track: secondTrack(),
      }),
    );
    expect(snapshot.revision).toBe(2);
    expect(snapshot.song.tracks).toHaveLength(2);
    expect(snapshot.song.meta).toStrictEqual(originalMeta);

    snapshot = unwrap(
      await harness.store.updateTrack('demo', {
        expectedRevision: snapshot.revision,
        trackId: 'bass',
        changes: { name: 'Sub Bass', pan: -0.25, mute: false },
      }),
    );
    expect(snapshot.revision).toBe(3);
    const bass = snapshot.song.tracks[1];
    expect(bass?.name).toBe('Sub Bass');
    expect(bass?.pan).toBe(-0.25);
    expect(snapshot.song.meta).toStrictEqual(originalMeta);

    snapshot = unwrap(
      await harness.store.setInstrument('demo', {
        expectedRevision: snapshot.revision,
        trackId: 'bass',
        instrument: { type: 'gm', program: 38, bank: 0 },
      }),
    );
    expect(snapshot.revision).toBe(4);
    expect(snapshot.song.tracks[1]?.instrument).toEqual({ type: 'gm', program: 38, bank: 0 });

    snapshot = unwrap(
      await harness.store.addNotes('demo', {
        expectedRevision: snapshot.revision,
        trackId: 'keys',
        notes: [{ pitch: 67, start: 4, duration: 2 }],
      }),
    );
    expect(snapshot.revision).toBe(5);
    expect(snapshot.song.tracks[0]?.notes).toHaveLength(3);

    snapshot = unwrap(
      await harness.store.updateNote('demo', {
        expectedRevision: snapshot.revision,
        trackId: 'keys',
        noteIndex: 1,
        note: { pitch: 65, start: 2, duration: 1.5, velocity: 80 },
      }),
    );
    expect(snapshot.revision).toBe(6);
    expect(snapshot.song.tracks[0]?.notes?.[1]).toEqual({
      pitch: 65,
      start: 2,
      duration: 1.5,
      velocity: 80,
    });
    expect(snapshot.song.tracks[0]?.notes?.[2]).toEqual({
      pitch: 67,
      start: 4,
      duration: 2,
    });

    snapshot = unwrap(
      await harness.store.removeNote('demo', {
        expectedRevision: snapshot.revision,
        trackId: 'keys',
        noteIndex: 0,
      }),
    );
    expect(snapshot.revision).toBe(7);
    expect(snapshot.song.tracks[0]?.notes).toHaveLength(2);

    snapshot = unwrap(
      await harness.store.setPattern('demo', {
        expectedRevision: snapshot.revision,
        pattern: pattern(),
      }),
    );
    expect(snapshot.revision).toBe(8);
    expect(snapshot.song.patterns).toHaveLength(1);
    expect(
      snapshot.warnings.some((warning) => warning.code === 'song.warning.unused_pattern'),
    ).toBe(true);

    snapshot = unwrap(
      await harness.store.setPattern('demo', {
        expectedRevision: snapshot.revision,
        pattern: { ...pattern(), name: 'Riff v2' },
      }),
    );
    expect(snapshot.revision).toBe(9);
    expect(snapshot.song.patterns).toHaveLength(1);
    expect(snapshot.song.patterns?.[0]?.id).toBe('riff');
    expect(snapshot.song.patterns?.[0]?.name).toBe('Riff v2');

    snapshot = unwrap(
      await harness.store.removePattern('demo', {
        expectedRevision: snapshot.revision,
        patternId: 'riff',
      }),
    );
    expect(snapshot.revision).toBe(10);
    expect(snapshot.song.patterns).toBeUndefined();

    snapshot = unwrap(
      await harness.store.removeTrack('demo', {
        expectedRevision: snapshot.revision,
        trackId: 'bass',
      }),
    );
    expect(snapshot.revision).toBe(11);
    expect(snapshot.song.tracks.map((track) => track.id)).toEqual(['keys']);

    const loaded = unwrap(await new ProjectStore({ root: harness.root }).get('demo'));
    expect(loaded.revision).toBe(11);
    expect(loaded.song).toStrictEqual(snapshot.song);
    expect(Object.keys(loaded.song).sort()).toEqual(['meta', 'schemaVersion', 'tracks']);
    expect(Object.keys(loaded.song.tracks[0]?.notes?.[0] ?? {}).sort()).toEqual([
      'duration',
      'pitch',
      'start',
      'velocity',
    ]);
    expect(loaded.song.meta).toStrictEqual(originalMeta);
  });

  it('replaces the complete song explicitly', async () => {
    const harness = makeHarness();
    const created = await createProject(harness.store);
    const replacement = minimalSong('Replaced');
    replacement.meta.bpm = 101;
    const updated = unwrap(
      await harness.store.updateSong('demo', {
        expectedRevision: created.revision,
        song: replacement,
      }),
    );
    expect(updated.revision).toBe(2);
    expect(updated.title).toBe('Replaced');
    expect(updated.song.meta.bpm).toBe(101);
    expect(unwrap(await harness.store.get('demo')).song).toStrictEqual(replacement);
  });
});

describe('validation and revision safety', () => {
  it('leaves song and metadata bytes unchanged after invalid edits', async () => {
    const harness = makeHarness();
    const created = await createProject(harness.store);
    const songBefore = readBytes(songPath(harness));
    const metadataBefore = readBytes(metadataPath(harness));

    expectFailure(
      await harness.store.addTrack('demo', {
        expectedRevision: created.revision,
        track: { ...secondTrack(), id: 'keys', channel: 1 },
      }),
      'project.edit.duplicate_track',
    );
    expectFailure(
      await harness.store.addNotes('demo', {
        expectedRevision: created.revision,
        trackId: 'keys',
        notes: [{ pitch: 200, start: 0, duration: 1 }],
      }),
      'project.song.invalid',
    );
    expectFailure(
      await harness.store.setInstrument('demo', {
        expectedRevision: created.revision,
        trackId: 'keys',
        instrument: { type: 'builtin', id: 'not.registered' },
      }),
      'project.song.invalid',
    );
    expectFailure(
      await harness.store.updateSong('demo', {
        expectedRevision: created.revision,
        song: { ...minimalSong(), meta: { ...minimalSong().meta, bpm: 1000 } },
      }),
      'project.song.invalid',
    );
    expectFailure(
      await harness.store.updateSong('demo', {
        expectedRevision: created.revision,
        song: { ...minimalSong(), unexpected: true } as unknown,
      }),
      'project.song.invalid',
    );
    expectFailure(
      await harness.store.removeTrack('demo', {
        expectedRevision: created.revision,
        trackId: 'keys',
      }),
      'project.song.invalid',
    );
    expectFailure(
      await harness.store.updateNote('demo', {
        expectedRevision: created.revision,
        trackId: 'keys',
        noteIndex: 99,
        note: { pitch: 60, start: 0, duration: 1 },
      }),
      'project.edit.note_not_found',
    );

    expect(readBytes(songPath(harness))).toStrictEqual(songBefore);
    expect(readBytes(metadataPath(harness))).toStrictEqual(metadataBefore);
    expect(unwrap(await harness.store.get('demo')).revision).toBe(1);
    assertNoTemporaryFiles(projectDirectory(harness));
  });

  it('returns structured stale revision conflicts and supports concurrent writers', async () => {
    const harness = makeHarness({ lockTimeoutMs: 5000 });
    const created = await createProject(harness.store);
    const updated = unwrap(
      await harness.store.updateSong('demo', {
        expectedRevision: created.revision,
        song: minimalSong('First update'),
      }),
    );
    expect(updated.revision).toBe(2);
    const bytesAfterUpdate = readBytes(songPath(harness));

    const conflict = expectFailure(
      await harness.store.updateSong('demo', {
        expectedRevision: created.revision,
        song: minimalSong('Stale update'),
      }),
      'project.revision.conflict',
    );
    expect(conflict.expectedRevision).toBe(1);
    expect(conflict.actualRevision).toBe(2);
    expect(readBytes(songPath(harness))).toStrictEqual(bytesAfterUpdate);

    expectFailure(
      await harness.store.updateSong('demo', {
        expectedRevision: 0,
        song: minimalSong('Invalid revision'),
      }),
      'project.revision.invalid',
    );

    const results = await Promise.all([
      harness.store.updateSong('demo', {
        expectedRevision: 2,
        song: minimalSong('Concurrent A'),
      }),
      harness.store.updateSong('demo', {
        expectedRevision: 2,
        song: minimalSong('Concurrent B'),
      }),
    ]);
    const wins = results.filter((result) => result.ok);
    const losses = results.filter((result) => !result.ok);
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);
    const loss = losses[0];
    if (loss && !loss.ok) {
      expect(loss.code).toBe('project.revision.conflict');
      expect(loss.actualRevision).toBe(3);
    }
    const final = unwrap(await harness.store.get('demo'));
    expect(final.revision).toBe(3);
    expect(['Concurrent A', 'Concurrent B']).toContain(final.title);
    expect(readdirSync(projectDirectory(harness))).not.toContain(PROJECT_LAYOUT.lockFile);
  });
});

describe('atomic writes and malformed storage', () => {
  it('removes the temporary file when an atomic write cannot be published', async () => {
    const harness = makeHarness();
    const target = join(harness.base, 'target-as-directory');
    mkdirSync(target);
    const result = await writeFileAtomic(target, Buffer.from('data'));
    expectFailure(result, 'project.io.failed');
    expect(statSync(target).isDirectory()).toBe(true);
    assertNoTemporaryFiles(harness.base);
  });

  it('rejects malformed, oversized, and unsupported-version songs', async () => {
    const harness = makeHarness();
    await createProject(harness.store, 'malformed');
    writeFileSync(songPath(harness, 'malformed'), '{ not json');
    expectFailure(await harness.store.get('malformed'), 'project.song.malformed_json');

    await createProject(harness.store, 'oversized');
    const tiny = new ProjectStore({ root: harness.root, limits: { maxSongBytes: 100 } });
    expectFailure(await tiny.get('oversized'), 'project.song.too_large');

    await createProject(harness.store, 'version');
    const versioned = JSON.parse(readFileSync(songPath(harness, 'version'), 'utf8')) as Record<
      string,
      unknown
    >;
    versioned.schemaVersion = '2.0.0';
    writeFileSync(songPath(harness, 'version'), `${JSON.stringify(versioned, null, 2)}\n`);
    expectFailure(await harness.store.get('version'), 'project.song.unsupported_version');
  });

  it('rejects malformed metadata, unsupported formats, and invalid revisions', async () => {
    const harness = makeHarness();
    await createProject(harness.store, 'bad-json');
    writeFileSync(metadataPath(harness, 'bad-json'), '{ nope');
    expectFailure(await harness.store.get('bad-json'), 'project.metadata.malformed');

    await createProject(harness.store, 'bad-version');
    const versioned = JSON.parse(
      readFileSync(metadataPath(harness, 'bad-version'), 'utf8'),
    ) as Record<string, unknown>;
    versioned.formatVersion = 99;
    writeFileSync(metadataPath(harness, 'bad-version'), `${JSON.stringify(versioned)}\n`);
    expectFailure(await harness.store.get('bad-version'), 'project.metadata.unsupported');

    await createProject(harness.store, 'bad-revision');
    const revision = JSON.parse(
      readFileSync(metadataPath(harness, 'bad-revision'), 'utf8'),
    ) as Record<string, unknown>;
    revision.revision = 0;
    writeFileSync(metadataPath(harness, 'bad-revision'), `${JSON.stringify(revision)}\n`);
    expectFailure(await harness.store.get('bad-revision'), 'project.revision.invalid');
  });

  it('honors bounded lock acquisition and recovers an orphaned stale lock', async () => {
    const harness = makeHarness({ lockTimeoutMs: 50, staleLockMs: 60_000 });
    const created = await createProject(harness.store);
    const lockPath = join(projectDirectory(harness), PROJECT_LAYOUT.lockFile);
    writeFileSync(lockPath, '{"nonce":"other"}\n');
    const before = readBytes(songPath(harness));
    const busy = expectFailure(
      await harness.store.updateSong('demo', {
        expectedRevision: created.revision,
        song: minimalSong('Blocked'),
      }),
      'project.lock.busy',
    );
    expect(busy.message).toContain('project lock');
    expect(readBytes(songPath(harness))).toStrictEqual(before);

    utimesSync(lockPath, new Date(0), new Date(0));
    const staleStore = new ProjectStore({
      root: harness.root,
      limits: { lockTimeoutMs: 500, staleLockMs: 100 },
    });
    const recovered = unwrap(
      await staleStore.updateSong('demo', {
        expectedRevision: created.revision,
        song: minimalSong('Recovered'),
      }),
    );
    expect(recovered.revision).toBe(2);
    expect(readdirSync(projectDirectory(harness))).not.toContain(PROJECT_LAYOUT.lockFile);
  });
});

describe('project root confinement', () => {
  it('rejects invalid ids, traversal, absolute paths, and dangerous names', async () => {
    const harness = makeHarness();
    await createProject(harness.store);

    for (const id of ['../escape', 'a/b', 'Upper', 'CON', '.', '', 'a'.repeat(65), 'a\0b']) {
      expectFailure(await harness.store.get(id), 'project.id.invalid');
    }

    const badAssets = [
      '../song.json',
      '/etc/passwd',
      'assets/../song.json',
      'assets\\piano.sf2',
      'song.json',
      'assets/',
      'assets/CON',
      'assets/CON.txt',
      'assets/foo.',
      'assets/foo ',
      'assets/a\0b.sf2',
      'assets/' + 'a'.repeat(600),
    ];
    for (const assetPath of badAssets) {
      const failure = expectFailure(
        await harness.store.resolveAsset('demo', assetPath),
        assetPath.length > 512 ? 'project.path.invalid' : 'project.path.confined',
      );
      expect(failure.projectId).toBe('demo');
    }

    expectFailure(
      await harness.store.resolveRenderDirectory('demo', 'renders/../song.json'),
      'project.path.confined',
    );
    expectFailure(
      await harness.store.resolveRenderDirectory('demo', '/tmp/escape'),
      'project.path.confined',
    );

    const relativeRoot = new ProjectStore({ root: 'relative/projects' });
    expectFailure(await relativeRoot.list(), 'project.root.invalid');
    const missingRoot = new ProjectStore({ root: join(harness.base, 'missing-root') });
    expectFailure(await missingRoot.list(), 'project.root.not_found');
  });

  it('resolves confined assets and render destinations inside the project', async () => {
    const harness = makeHarness();
    await createProject(harness.store);
    const directory = projectDirectory(harness);
    writeFileSync(join(directory, 'assets', 'piano.sf2'), 'RIFFdata');

    const resolved = unwrap(await harness.store.resolveAsset('demo', 'assets/piano.sf2'));
    expect(resolved.absolutePath).toBe(join(directory, 'assets', 'piano.sf2'));
    expect(resolved.relativePath).toBe('assets/piano.sf2');
    expect(resolved.bytes).toBe(8);

    const read = unwrap(await harness.store.readAsset('demo', 'assets/piano.sf2'));
    expect(Buffer.from(read.data).toString('utf8')).toBe('RIFFdata');

    writeFileSync(join(directory, 'assets', '背景 sound.sf2'), 'unicode');
    const unicode = unwrap(await harness.store.resolveAsset('demo', 'assets/背景 sound.sf2'));
    expect(unicode.absolutePath).toBe(join(directory, 'assets', '背景 sound.sf2'));
    expect(
      Buffer.from(
        unwrap(await harness.store.readAsset('demo', 'assets/背景 sound.sf2')).data,
      ).toString('utf8'),
    ).toBe('unicode');

    const existing = unwrap(await harness.store.resolveRenderDirectory('demo'));
    expect(existing.relativePath).toBe('renders');
    expect(existing.exists).toBe(true);
    expect(existing.absolutePath).toBe(join(directory, 'renders'));

    const future = unwrap(await harness.store.resolveRenderDirectory('demo', 'renders/take-01'));
    expect(future.exists).toBe(false);
    expect(future.absolutePath).toBe(join(directory, 'renders', 'take-01'));

    const futureAssetSong = minimalSong('Future asset');
    const futureTrack = futureAssetSong.tracks[0];
    if (futureTrack) {
      futureTrack.instrument = {
        type: 'soundfont',
        path: 'assets/not-yet-provisioned.sf2',
        program: 0,
      };
    }
    const futureAssetProject = await createProject(harness.store, 'future-asset', futureAssetSong);
    expect(futureAssetProject.revision).toBe(1);

    expectFailure(
      await harness.store.resolveAsset('demo', 'assets/missing.sf2'),
      'project.asset.missing',
    );
  });

  it('rejects symlink escapes through files, parents, renders, and project directories', async () => {
    if (process.platform === 'win32') {
      return;
    }
    const harness = makeHarness();
    await createProject(harness.store);
    const directory = projectDirectory(harness);
    const outside = join(harness.base, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'evil.sf2'), 'outside');
    mkdirSync(join(outside, 'render'));
    writeFileSync(join(directory, 'assets', 'real.sf2'), 'inside');

    symlinkSync(outside, join(directory, 'assets', 'linked'));
    expectFailure(
      await harness.store.resolveAsset('demo', 'assets/linked/evil.sf2'),
      'project.path.confined',
    );

    const escapedSong = minimalSong('Escaped asset');
    const escapedTrack = escapedSong.tracks[0];
    if (escapedTrack) {
      escapedTrack.instrument = {
        type: 'soundfont',
        path: 'assets/linked/evil.sf2',
        program: 0,
      };
    }
    const beforeEscapedSave = readBytes(songPath(harness));
    expectFailure(
      await harness.store.updateSong('demo', {
        expectedRevision: 1,
        song: escapedSong,
      }),
      'project.path.confined',
    );
    expect(readBytes(songPath(harness))).toStrictEqual(beforeEscapedSave);

    symlinkSync(join(outside, 'evil.sf2'), join(directory, 'assets', 'escaped.sf2'));
    expectFailure(
      await harness.store.resolveAsset('demo', 'assets/escaped.sf2'),
      'project.path.confined',
    );

    symlinkSync(join(directory, 'assets', 'real.sf2'), join(directory, 'assets', 'internal.sf2'));
    const internal = unwrap(await harness.store.resolveAsset('demo', 'assets/internal.sf2'));
    expect(
      Buffer.from(
        unwrap(await harness.store.readAsset('demo', 'assets/internal.sf2')).data,
      ).toString('utf8'),
    ).toBe('inside');
    expect(internal.absolutePath).toBe(join(directory, 'assets', 'real.sf2'));

    symlinkSync(join(outside, 'render'), join(directory, 'renders', 'linked'));
    expectFailure(
      await harness.store.resolveRenderDirectory('demo', 'renders/linked/take'),
      'project.path.confined',
    );

    await createProject(harness.store, 'swap');
    renameSync(join(harness.root, 'swap'), join(harness.base, 'swapped-project'));
    symlinkSync(join(harness.base, 'swapped-project'), join(harness.root, 'swap'));
    expectFailure(await harness.store.get('swap'), 'project.path.confined');

    await createProject(harness.store, 'song-link');
    renameSync(
      songPath(harness, 'song-link'),
      join(projectDirectory(harness, 'song-link'), 'real.json'),
    );
    symlinkSync(join(outside, 'evil.sf2'), songPath(harness, 'song-link'));
    expectFailure(await harness.store.get('song-link'), 'project.path.confined');

    await createProject(harness.store, 'metadata-link');
    renameSync(
      metadataPath(harness, 'metadata-link'),
      join(projectDirectory(harness, 'metadata-link'), 'real-metadata.json'),
    );
    symlinkSync(join(outside, 'evil.sf2'), metadataPath(harness, 'metadata-link'));
    expectFailure(await harness.store.get('metadata-link'), 'project.metadata.invalid');

    await createProject(harness.store, 'assets-link');
    renameSync(
      join(projectDirectory(harness, 'assets-link'), 'assets'),
      join(projectDirectory(harness, 'assets-link'), 'real-assets'),
    );
    symlinkSync(outside, join(projectDirectory(harness, 'assets-link'), 'assets'));
    expectFailure(
      await harness.store.resolveAsset('assets-link', 'assets/evil.sf2'),
      'project.path.confined',
    );
  });
});

describe('storage bounds', () => {
  it('bounds project count and root enumeration', async () => {
    const limited = makeHarness({ maxProjects: 2 });
    await createProject(limited.store, 'one');
    await createProject(limited.store, 'two');
    expectFailure(
      await limited.store.create({ projectId: 'three', song: minimalSong() }),
      'project.limit.projects',
    );

    const enumerated = makeHarness({ maxDirectoryEntries: 2 });
    writeFileSync(join(enumerated.root, 'a'), '');
    writeFileSync(join(enumerated.root, 'b'), '');
    writeFileSync(join(enumerated.root, 'c'), '');
    expectFailure(await enumerated.store.list(), 'project.limit.enumeration');
  });

  it('bounds asset and song byte sizes', async () => {
    const harness = makeHarness({ maxAssetBytes: 8 });
    await createProject(harness.store);
    const asset = join(projectDirectory(harness), 'assets', 'large.sf2');
    writeFileSync(asset, 'x'.repeat(9));
    expectFailure(
      await harness.store.resolveAsset('demo', 'assets/large.sf2'),
      'project.asset.too_large',
    );
    const defaultLimitStore = new ProjectStore({ root: harness.root });
    expectFailure(
      await defaultLimitStore.readAsset('demo', 'assets/large.sf2', { maxBytes: 4 }),
      'project.asset.too_large',
    );

    const tinySong = new ProjectStore({ root: harness.root, limits: { maxSongBytes: 64 } });
    expectFailure(
      await tinySong.create({ projectId: 'huge', song: minimalSong() }),
      'project.song.too_large',
    );
    expectFailure(await tinySong.get('demo'), 'project.song.too_large');
  });
});
