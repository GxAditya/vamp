/**
 * Task 19 platform-specific security semantics.
 *
 * These cases target behavior that only exists on one operating system:
 * case-insensitive path comparison on macOS and Windows, the `/tmp` to
 * `/private/tmp` symlink on macOS, and Windows-style containment casing.
 * Each case runs only on its platform; on every other platform it reports as
 * skipped with the platform named.
 *
 * IMPORTANT (Task 19 honesty note): this repository was authored and verified
 * on Linux. The darwin and win32 gates below therefore executed nothing on
 * the verification host. They are recorded as authored-but-not-executed in the
 * CI workflow header, and the Task 19 CI matrix is what actually runs them.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { SongSchemaV1 } from '@gxaditya/vamp-schema';

import { PROJECT_LAYOUT, ProjectStore } from '../src/index.js';
import { isInsidePath } from '../src/paths.js';

const isWindows = process.platform === 'win32';
const isMacos = process.platform === 'darwin';
const isPosix = !isWindows;

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function minimalSong(): SongSchemaV1 {
  return {
    schemaVersion: '1.0.0',
    meta: {
      title: 'Platform matrix',
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
        instrument: { type: 'builtin', id: 'keys.soft' },
        notes: [{ pitch: 60, start: 0, duration: 2 }],
      },
    ],
  };
}

describe('isInsidePath containment semantics', () => {
  it.runIf(isPosix)('is case-sensitive on POSIX (this branch executes on Linux)', () => {
    expect(isInsidePath('/Root/Projects', '/root/projects/demo')).toBe(false);
    expect(isInsidePath('/Root/Projects', '/Root/Projects/demo')).toBe(true);
  });

  // Authored for the Windows CI job. On the Linux verification host this
  // gate skips; the assertion below is what the Windows runner executes.
  it.runIf(isWindows)('compares case-insensitively on Windows', () => {
    expect(isInsidePath('C:\\Projects\\Root', 'c:\\projects\\root\\demo')).toBe(true);
    expect(isInsidePath('C:\\Projects\\Root', 'C:\\Projects\\Root\\demo')).toBe(true);
    expect(isInsidePath('C:\\Projects\\Root', 'C:\\Projects\\Other\\demo')).toBe(false);
  });

  // Authored for the macOS CI job. macOS' default APFS volume is
  // case-insensitive but case-preserving; Vamp's containment check stays
  // case-sensitive there, which is the conservative direction: a real escape
  // is still caught and only same-case paths can ever be considered inside.
  it.runIf(isMacos)('stays case-sensitive on macOS and confines real paths', () => {
    expect(isInsidePath('/Root/Projects', '/root/projects/demo')).toBe(false);
    expect(isInsidePath('/Root/Projects', '/Root/Projects/demo')).toBe(true);
  });
});

describe('macOS /tmp symlink handling (authored for the macOS CI job)', () => {
  // On macOS, /tmp is a symlink to /private/tmp. The store realpath-resolves
  // the configured root, so a projects root addressed through /tmp must
  // still confine every project under the resolved /private/tmp path.
  it.runIf(isMacos)(
    'confines projects whose root is addressed through the /tmp symlink',
    async () => {
      const base = mkdtempSync('/tmp/vamp-security-macos-');
      temporaryDirectories.push(base);
      const resolvedBase = realpathSync(base);
      expect(resolvedBase.startsWith('/private/tmp/')).toBe(true);
      const root = join(base, 'projects');
      mkdirSync(root);
      const store = new ProjectStore({ root });
      const created = await store.create({ projectId: 'macos-root', song: minimalSong() });
      expect(created.ok).toBe(true);
      const location = await store.getLocation('macos-root');
      expect(location.ok).toBe(true);
      if (location.ok) {
        expect(location.value.rootDirectory).toBe(join(resolvedBase, 'projects'));
        expect(location.value.directory.startsWith(resolvedBase)).toBe(true);
        // An asset addressed through the unresolved /tmp path still confines.
        writeFileSync(join(resolvedBase, 'projects', 'macos-root', 'assets', 'soft.sf2'), 'RIFFx');
        const asset = await store.resolveAsset('macos-root', 'assets/soft.sf2');
        expect(asset.ok).toBe(true);
      }
    },
  );
});

describe('Windows path-semantics matrix (authored for the Windows CI job)', () => {
  // NTFS treats these names as device aliases even with extensions or
  // trailing spaces and dots. The lexical matrix in
  // `security-adversarial.test.ts` already rejects them on every platform;
  // this gate documents the platform that actually needs the protection and
  // adds the drive-letter casing case.
  it.runIf(isWindows)(
    'rejects case-varied drive prefixes and reserved aliases for render names',
    async () => {
      const base = mkdtempSync(join(tmpdir(), 'vamp-security-win-'));
      temporaryDirectories.push(base);
      const root = join(base, 'projects');
      mkdirSync(root);
      const store = new ProjectStore({ root });
      const created = await store.create({ projectId: 'win', song: minimalSong() });
      expect(created.ok).toBe(true);
      for (const renderPath of [
        'renders/C:\\escape',
        'renders/\\\\server\\share',
        'renders/con',
        'renders/nul.wav',
        'renders/aux.txt',
        'renders/com9.txt',
      ]) {
        const result = await store.resolveRenderDirectory('win', renderPath);
        expect(result.ok, renderPath).toBe(false);
        if (!result.ok) {
          expect(['project.path.confined', 'project.path.invalid']).toContain(result.code);
        }
      }
    },
  );

  // A symlinked render parent requires developer mode or elevation on
  // Windows; this case documents that the store rejects the escape rather
  // than following it. Authored for the Windows CI job, which runs with
  // developer mode enabled on the hosted runner image.
  it.runIf(isWindows)(
    'rejects render destinations under a symlinked parent directory',
    async () => {
      const base = mkdtempSync(join(tmpdir(), 'vamp-security-win-'));
      temporaryDirectories.push(base);
      const root = join(base, 'projects');
      mkdirSync(root);
      const store = new ProjectStore({ root });
      const created = await store.create({ projectId: 'win-link', song: minimalSong() });
      expect(created.ok).toBe(true);
      const outside = join(base, 'outside');
      mkdirSync(outside);
      const renders = join(root, 'win-link', PROJECT_LAYOUT.rendersDirectory);
      try {
        symlinkSync(outside, join(renders, 'linked'), 'junction');
      } catch {
        // Without developer mode or elevation, symlink creation itself fails;
        // that is an environment limitation, not a security pass. Report it.
        throw new Error('Windows symlink creation requires developer mode on the runner');
      }
      const result = await store.resolveRenderDirectory('win-link', 'renders/linked/take');
      expect(result.ok).toBe(false);
    },
  );
});
