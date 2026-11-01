import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SongSchemaV1 } from '@gxaditya/vamp-schema';

import { PROJECT_LAYOUT, ProjectStore } from '../src/index.js';

const renameControl = vi.hoisted(() => ({ failMetadataRename: false }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    async rename(
      oldPath: Parameters<typeof actual.rename>[0],
      newPath: Parameters<typeof actual.rename>[1],
    ) {
      if (renameControl.failMetadataRename && String(newPath).endsWith('.vamp-project.json')) {
        const error = new Error('injected metadata rename failure') as NodeJS.ErrnoException;
        error.code = 'EIO';
        throw error;
      }
      return actual.rename(oldPath, newPath);
    },
  };
});

const temporaryDirectories: string[] = [];

afterEach(() => {
  renameControl.failMetadataRename = false;
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function song(title: string): SongSchemaV1 {
  return {
    schemaVersion: '1.0.0',
    meta: {
      title,
      bpm: 90,
      timeSignature: { numerator: 4, denominator: 4 },
      key: { tonic: 'C', mode: 'major' },
      seed: 1,
      durationHint: 8,
    },
    tracks: [
      {
        id: 'keys',
        name: 'Keys',
        kind: 'midi',
        channel: 0,
        instrument: { type: 'builtin', id: 'keys.soft' },
        notes: [{ pitch: 60, start: 0, duration: 2 }],
      },
    ],
  };
}

describe('two-file project commit failure', () => {
  it('restores the previous song and revision when metadata cannot be published', async () => {
    const base = mkdtempSync(join(tmpdir(), 'vamp-project-commit-failure-'));
    temporaryDirectories.push(base);
    const root = join(base, 'projects');
    mkdirSync(root);
    const store = new ProjectStore({ root });
    const created = await store.create({ projectId: 'demo', song: song('Before') });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }

    const projectDir = join(root, 'demo');
    const songPath = join(projectDir, PROJECT_LAYOUT.songFile);
    const metadataPath = join(projectDir, PROJECT_LAYOUT.metadataFile);
    const songBefore = readFileSync(songPath);
    const metadataBefore = readFileSync(metadataPath);

    renameControl.failMetadataRename = true;
    const updated = await store.updateSong('demo', {
      expectedRevision: created.value.revision,
      song: song('After'),
    });

    expect(updated.ok).toBe(false);
    if (updated.ok) {
      return;
    }
    expect(updated.code).toBe('project.io.commit_failed');
    expect(updated.hint).toContain('restored');
    expect(readFileSync(songPath)).toStrictEqual(songBefore);
    expect(readFileSync(metadataPath)).toStrictEqual(metadataBefore);
    expect(readdirSync(projectDir).filter((name) => name.startsWith('.vamp-tmp-'))).toEqual([]);
    expect(readdirSync(projectDir)).not.toContain(PROJECT_LAYOUT.lockFile);

    renameControl.failMetadataRename = false;
    const loaded = await store.get('demo');
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.revision).toBe(1);
      expect(loaded.value.title).toBe('Before');
    }
  });
});
