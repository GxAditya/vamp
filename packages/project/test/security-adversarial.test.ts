/**
 * Task 19 adversarial path and filename matrix for the project store.
 *
 * These cases run on every supported platform: the checks are lexical and
 * platform-neutral by design, so a song that is safe on Linux is also safe
 * when the same project directory is moved to macOS or Windows. Real
 * platform-specific filesystem semantics live in `security-platform.test.ts`.
 *
 * The suite focuses on hostile strings: Windows drive and UNC prefixes,
 * alternate separators, device names, stream syntax, NUL and control
 * characters, trailing dots and spaces, over-long segments, and hostile
 * render directory names. Spaces and Unicode must stay legal.
 */

import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { SongSchemaV1 } from '@gxaditya/vamp-schema';

import { ProjectStore, type ProjectResult } from '../src/index.js';
import { writeFileAtomic } from '../src/atomic.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeHarness(): { base: string; root: string; store: ProjectStore } {
  const base = mkdtempSync(join(tmpdir(), 'vamp-security-project-'));
  temporaryDirectories.push(base);
  const root = join(base, 'projects');
  mkdirSync(root);
  return { base, root, store: new ProjectStore({ root }) };
}

function minimalSong(instrument?: SongSchemaV1['tracks'][number]['instrument']): SongSchemaV1 {
  return {
    schemaVersion: '1.0.0',
    meta: {
      title: 'Adversarial matrix',
      bpm: 90,
      timeSignature: { numerator: 4, denominator: 4 },
      key: { tonic: 'C', mode: 'major' },
      seed: 7,
      durationHint: 4,
    },
    tracks: [
      {
        id: 'keys',
        name: 'Keys',
        kind: 'midi',
        channel: 0,
        instrument: instrument ?? { type: 'builtin', id: 'keys.soft' },
        notes: [{ pitch: 60, start: 0, duration: 2 }],
      },
    ],
  };
}

function expectFailureCode<T>(result: ProjectResult<T>): string {
  if (result.ok) {
    throw new Error('Expected a structured failure, received success.');
  }
  return result.code;
}

async function createProject(store: ProjectStore, projectId = 'demo'): Promise<void> {
  const created = await store.create({ projectId, song: minimalSong() });
  if (!created.ok) {
    throw new Error(`Project creation failed: ${created.code} ${created.message}`);
  }
}

/** Names that must never be accepted as asset or render paths on any OS. */
const HOSTILE_PATHS: readonly { readonly path: string; readonly reason: string }[] = [
  { path: 'assets/../escape.sf2', reason: 'traversal' },
  { path: 'assets/../../escape.sf2', reason: 'double traversal' },
  { path: 'assets/./x.sf2', reason: 'dot segment' },
  { path: 'assets//x.sf2', reason: 'empty segment' },
  { path: '/assets/x.sf2', reason: 'POSIX absolute' },
  { path: 'C:/assets/x.sf2', reason: 'Windows drive with slash' },
  { path: 'c:\\assets\\x.sf2', reason: 'Windows drive with backslash' },
  { path: 'Z:x.sf2', reason: 'drive-relative' },
  { path: '\\\\server\\share\\x.sf2', reason: 'UNC prefix' },
  { path: '\\\\?\\C:\\x.sf2', reason: 'Windows extended-length prefix' },
  { path: 'assets\\x.sf2', reason: 'backslash separator' },
  { path: 'assets/a\0x.sf2', reason: 'NUL byte' },
  { path: 'assets/a\u0007x.sf2', reason: 'BEL control character' },
  { path: 'assets/a\u001bx.sf2', reason: 'ESC control character' },
  { path: 'assets/CON', reason: 'Windows reserved device' },
  { path: 'assets/con.txt', reason: 'Windows reserved device with extension' },
  { path: 'assets/NUL.wav', reason: 'Windows NUL device' },
  { path: 'assets/LPT9', reason: 'Windows parallel port' },
  { path: 'assets/COM1', reason: 'Windows serial port' },
  { path: 'assets/x.sf2:stream', reason: 'NTFS alternate data stream syntax' },
  { path: 'assets/x<y.sf2', reason: 'redirection character' },
  { path: 'assets/x|y.sf2', reason: 'pipe character' },
  { path: 'assets/x?.sf2', reason: 'wildcard character' },
  { path: 'assets/trailing.', reason: 'trailing dot' },
  { path: 'assets/trailing ', reason: 'trailing space' },
  { path: `assets/${'a'.repeat(300)}.sf2`, reason: 'segment above 255 bytes' },
];

function isPathRejection(code: string): boolean {
  return (
    code === 'project.path.confined' ||
    code === 'project.path.invalid' ||
    code === 'project.song.invalid'
  );
}

describe('adversarial asset path matrix', () => {
  it('rejects every hostile asset path before any filesystem access', async () => {
    const harness = makeHarness();
    await createProject(harness.store);
    for (const { path, reason } of HOSTILE_PATHS) {
      const code = expectFailureCode(await harness.store.resolveAsset('demo', path));
      expect(isPathRejection(code), `${reason}: ${path} produced ${code}`).toBe(true);
    }
  });

  it('rejects hostile instrument references when saving a song, without touching storage', async () => {
    const harness = makeHarness();
    await createProject(harness.store);
    const baseBefore = readdirSync(harness.base).sort();
    for (const { path, reason } of HOSTILE_PATHS) {
      const code = expectFailureCode(
        await harness.store.updateSong('demo', {
          expectedRevision: 1,
          song: minimalSong({ type: 'soundfont', path, program: 0, bank: 0 }),
        }),
      );
      expect(isPathRejection(code), `${reason}: ${path} produced ${code}`).toBe(true);
    }
    const snapshot = await harness.store.get('demo');
    expect(snapshot.ok).toBe(true);
    if (snapshot.ok) {
      expect(snapshot.value.revision).toBe(1);
    }
    // Rejected saves must not leave staged temporary files behind.
    const projectDirectory = join(harness.root, 'demo');
    expect(readdirSync(projectDirectory).filter((name) => name.startsWith('.vamp-tmp-'))).toEqual(
      [],
    );
    expect(readdirSync(harness.base).sort()).toEqual(baseBefore);
  });

  it('accepts spaces, Unicode, dots, and shell-inert punctuation in asset paths', async () => {
    const harness = makeHarness();
    await createProject(harness.store);
    const assets = join(harness.root, 'demo', 'assets');
    const names = [
      'piano soft.sf2',
      '背景 sound.sf2',
      'v1.2-final.sf2',
      "weird; $()'name.sf2",
      'café.wav',
    ];
    for (const name of names) {
      writeFileSync(join(assets, name), 'RIFFx');
      const resolved = await harness.store.resolveAsset('demo', `assets/${name}`);
      expect(resolved.ok, name).toBe(true);
    }
  });
});

describe('adversarial render destination matrix', () => {
  it('rejects hostile render names and keeps legal ones', async () => {
    const harness = makeHarness();
    await createProject(harness.store);
    for (const { path, reason } of HOSTILE_PATHS) {
      const renderPath = path.replace(/^assets/, 'renders');
      const code = expectFailureCode(
        await harness.store.resolveRenderDirectory('demo', renderPath),
      );
      expect(isPathRejection(code), `${reason}: ${renderPath} produced ${code}`).toBe(true);
    }

    const legal = ['renders/take 01', 'renders/背景 mix', 'renders/v2.1-final', 'renders/NUL-free'];
    for (const renderPath of legal) {
      const resolved = await harness.store.resolveRenderDirectory('demo', renderPath);
      expect(resolved.ok, renderPath).toBe(true);
    }
  });

  it('rejects hostile project ids lexically', async () => {
    const harness = makeHarness();
    await createProject(harness.store);
    for (const id of ['..', 'C:', 'a'.repeat(66), 'NUL', 'nul', 'com1', 'a/b', 'a\\b', 'CON.txt']) {
      const code = expectFailureCode(await harness.store.get(id));
      expect(code, id).toBe('project.id.invalid');
    }
  });
});

describe('atomic writer hostile targets', () => {
  it('cleans the staged temporary file when the destination is a directory', async () => {
    const harness = makeHarness();
    mkdirSync(join(harness.base, 'a-directory'), { recursive: true });
    const result = await writeFileAtomic(join(harness.base, 'a-directory'), Buffer.from('x'));
    expect(result.ok).toBe(false);
    expect(readdirSync(harness.base).filter((name) => name.startsWith('.vamp-tmp-'))).toEqual([]);
  });

  it('refuses relative and NUL-bearing absolute targets without writing anything', async () => {
    const harness = makeHarness();
    expect((await writeFileAtomic('relative/target', Buffer.from('x'))).ok).toBe(false);
    expect((await writeFileAtomic(join(harness.base, 'a\0b'), Buffer.from('x'))).ok).toBe(false);
    expect(readdirSync(harness.base).filter((name) => name.startsWith('.vamp-tmp-'))).toEqual([]);
  });
});
