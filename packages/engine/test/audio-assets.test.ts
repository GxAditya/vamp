import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  MAX_ASSET_PATH_LENGTH,
  resolveProjectSoundFont,
  sha256File,
  validateTrustedSoundFont,
} from '../src/index.js';

const roots: string[] = [];

function makeRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vamp-assets-')));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

/** Minimal byte string that passes the RIFF/sfbk header check. */
function fakeSoundFontBytes(): Buffer {
  const buffer = Buffer.alloc(24);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(16, 4);
  buffer.write('sfbk', 8, 'ascii');
  buffer.write('LIST', 12, 'ascii');
  return buffer;
}

function writeAsset(path: string, bytes: Buffer = fakeSoundFontBytes()): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return path;
}

describe('project SoundFont confinement', () => {
  it('accepts relative .sf2 files including spaces and Unicode', async () => {
    const root = makeRoot();
    const relative = 'assets/My Sounds/ピアノ.sf2';
    writeAsset(join(root, relative));

    const result = await resolveProjectSoundFont({ projectRoot: root, relativePath: relative });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.asset.relativePath).toBe(relative);
      expect(result.asset.bytes).toBe(24);
      expect(result.asset.sha256).toBeNull();
    }
  });

  it('rejects missing files, directories, wrong extensions, and oversized files', async () => {
    const root = makeRoot();
    const missing = await resolveProjectSoundFont({
      projectRoot: root,
      relativePath: 'assets/missing.sf2',
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.issue.code).toBe('audio.asset.missing');
    }

    mkdirSync(join(root, 'assets', 'directory.sf2'), { recursive: true });
    const directory = await resolveProjectSoundFont({
      projectRoot: root,
      relativePath: 'assets/directory.sf2',
    });
    expect(directory.ok).toBe(false);
    if (!directory.ok) {
      expect(directory.issue.code).toBe('audio.asset.invalid');
    }

    writeAsset(join(root, 'assets', 'pad.sfz'));
    const wrongExtension = await resolveProjectSoundFont({
      projectRoot: root,
      relativePath: 'assets/pad.sfz',
    });
    expect(wrongExtension.ok).toBe(false);
    if (!wrongExtension.ok) {
      expect(wrongExtension.issue.code).toBe('audio.asset.invalid');
      expect(wrongExtension.issue.hint).toContain('SFZ');
    }

    writeAsset(join(root, 'assets', 'big.sf2'), Buffer.alloc(64));
    const oversized = await resolveProjectSoundFont({
      projectRoot: root,
      relativePath: 'assets/big.sf2',
      maxBytes: 32,
    });
    expect(oversized.ok).toBe(false);
    if (!oversized.ok) {
      expect(oversized.issue.code).toBe('audio.asset.invalid');
      expect(oversized.issue.message).toContain('above the 32 byte limit');
    }
  });

  it('rejects absolute paths, traversal, backslashes, and overlong paths', async () => {
    const root = makeRoot();
    for (const relativePath of [
      '/etc/passwd.sf2',
      'C:\\assets\\piano.sf2',
      '\\\\server\\share\\piano.sf2',
      '../outside.sf2',
      'assets/../../outside.sf2',
      './assets/piano.sf2',
      'assets//piano.sf2',
      'assets\\piano.sf2',
    ]) {
      const result = await resolveProjectSoundFont({ projectRoot: root, relativePath });
      expect(result.ok, relativePath).toBe(false);
      if (!result.ok) {
        expect(result.issue.code, relativePath).toBe('audio.asset.confined');
      }
    }

    const overlong = await resolveProjectSoundFont({
      projectRoot: root,
      relativePath: `${'a'.repeat(MAX_ASSET_PATH_LENGTH)}.sf2`,
    });
    expect(overlong.ok).toBe(false);
    if (!overlong.ok) {
      expect(overlong.issue.code).toBe('audio.asset.invalid');
    }
  });

  it('rejects corrupt headers and optional checksum mismatches', async () => {
    const root = makeRoot();
    writeAsset(join(root, 'assets', 'corrupt.sf2'), Buffer.from('not a soundfont at all'));
    const corrupt = await resolveProjectSoundFont({
      projectRoot: root,
      relativePath: 'assets/corrupt.sf2',
    });
    expect(corrupt.ok).toBe(false);
    if (!corrupt.ok) {
      expect(corrupt.issue.code).toBe('audio.asset.invalid');
      expect(corrupt.issue.message).toContain('RIFF/sfbk');
    }

    const path = writeAsset(join(root, 'assets', 'good.sf2'));
    const digest = await sha256File(path);
    const good = await resolveProjectSoundFont({
      projectRoot: root,
      relativePath: 'assets/good.sf2',
      expectedSha256: digest,
    });
    expect(good.ok).toBe(true);
    if (good.ok) {
      expect(good.asset.sha256).toBe(digest);
    }

    const mismatch = await resolveProjectSoundFont({
      projectRoot: root,
      relativePath: 'assets/good.sf2',
      expectedSha256: '0'.repeat(64),
    });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) {
      expect(mismatch.issue.code).toBe('audio.asset.checksum_mismatch');
      expect(mismatch.issue.params).toMatchObject({
        expectedSha256: '0'.repeat(64),
        actualSha256: digest,
      });
    }
  });

  it.skipIf(process.platform === 'win32')(
    'rejects symlinked files and parents that escape the project root',
    async () => {
      const root = makeRoot();
      const outside = makeRoot();
      writeAsset(join(outside, 'outside.sf2'));
      mkdirSync(join(root, 'assets'), { recursive: true });
      symlinkSync(join(outside, 'outside.sf2'), join(root, 'assets', 'linked.sf2'));
      symlinkSync(outside, join(root, 'linked-dir'));

      const fileEscape = await resolveProjectSoundFont({
        projectRoot: root,
        relativePath: 'assets/linked.sf2',
      });
      expect(fileEscape.ok).toBe(false);
      if (!fileEscape.ok) {
        expect(fileEscape.issue.code).toBe('audio.asset.confined');
        expect(fileEscape.issue.message).toContain('symlink');
      }

      const parentEscape = await resolveProjectSoundFont({
        projectRoot: root,
        relativePath: 'linked-dir/outside.sf2',
      });
      expect(parentEscape.ok).toBe(false);
      if (!parentEscape.ok) {
        expect(parentEscape.issue.code).toBe('audio.asset.confined');
      }

      const missingParentEscape = await resolveProjectSoundFont({
        projectRoot: root,
        relativePath: 'linked-dir/not-there.sf2',
      });
      expect(missingParentEscape.ok).toBe(false);
      if (!missingParentEscape.ok) {
        expect(missingParentEscape.issue.code).toBe('audio.asset.confined');
      }

      writeAsset(join(root, 'assets', 'real.sf2'));
      const inside = await resolveProjectSoundFont({
        projectRoot: root,
        relativePath: 'assets/real.sf2',
      });
      expect(inside.ok).toBe(true);
    },
  );

  it('reports a missing or invalid project root as configuration errors', async () => {
    const missingRoot = await resolveProjectSoundFont({
      projectRoot: join(tmpdir(), 'vamp-does-not-exist-root'),
      relativePath: 'assets/piano.sf2',
    });
    expect(missingRoot.ok).toBe(false);
    if (!missingRoot.ok) {
      expect(missingRoot.issue.code).toBe('audio.config.invalid');
    }

    const relativeRoot = await resolveProjectSoundFont({
      projectRoot: 'relative/project',
      relativePath: 'assets/piano.sf2',
    });
    expect(relativeRoot.ok).toBe(false);
    if (!relativeRoot.ok) {
      expect(relativeRoot.issue.code).toBe('audio.config.invalid');
    }

    const root = makeRoot();
    const file = writeAsset(join(root, 'not-a-dir'));
    const notDirectory = await resolveProjectSoundFont({
      projectRoot: file,
      relativePath: 'assets/piano.sf2',
    });
    expect(notDirectory.ok).toBe(false);
    if (!notDirectory.ok) {
      expect(notDirectory.issue.code).toBe('audio.config.invalid');
    }
  });
});

describe('trusted GM SoundFont configuration', () => {
  it('accepts an absolute path outside the project root and checks the header', async () => {
    const root = makeRoot();
    const font = writeAsset(join(root, 'global', 'FluidR3_GM.sf2'));
    const result = await validateTrustedSoundFont(font);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.asset.absolutePath).toBe(font);
    }
  });

  it('rejects relative configuration, missing files, and bad checksums', async () => {
    const relative = await validateTrustedSoundFont('sounds/font.sf2');
    expect(relative.ok).toBe(false);
    if (!relative.ok) {
      expect(relative.issue.code).toBe('audio.config.invalid');
    }

    const missing = await validateTrustedSoundFont('/tmp/vamp-no-such-font.sf2');
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.issue.code).toBe('audio.asset.missing');
    }

    const root = makeRoot();
    const font = writeAsset(join(root, 'font.sf2'));
    const badChecksum = await validateTrustedSoundFont(font, {
      expectedSha256: 'f'.repeat(64),
    });
    expect(badChecksum.ok).toBe(false);
    if (!badChecksum.ok) {
      expect(badChecksum.issue.code).toBe('audio.asset.checksum_mismatch');
    }
  });

  it('is not affected by the executable permission bit', async () => {
    const root = makeRoot();
    const font = writeAsset(join(root, 'font.sf2'));
    chmodSync(font, 0o600);
    const result = await validateTrustedSoundFont(font);
    expect(result.ok).toBe(true);
  });
});
