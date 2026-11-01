/**
 * SoundFont asset validation for the FluidSynth sample backend.
 *
 * Task 10 will centralize project confinement for the CLI, MCP server, and SDK.
 * This resolver is deliberately small: it enforces the schema's lexical asset
 * rules plus realpath containment, file type, size, header, and optional
 * checksum checks for the one asset type this backend loads. Do not grow it into
 * a second project storage layer.
 *
 * Trust boundary: a project-referenced `.sf2` must resolve inside the configured
 * project root, including through symlinked files or parent directories. A
 * globally configured GM SoundFont is trusted backend configuration, not a song
 * asset, so it may live outside the project root; it is still checked for type,
 * size, header, and optional checksum.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep } from 'node:path';

import type { IssueParams } from '@gxaditya/vamp-schema';
/** Default cap for a project SoundFont. FluidR3 GM is about 142 MB. */
export const DEFAULT_MAX_SOUNDFONT_BYTES = 536_870_912;

/** Maximum lexical asset path length accepted by SongSchemaV1. */
export const MAX_ASSET_PATH_LENGTH = 512;

export interface AssetValidationIssue {
  readonly code:
    | 'audio.asset.missing'
    | 'audio.asset.invalid'
    | 'audio.asset.confined'
    | 'audio.asset.checksum_mismatch'
    | 'audio.config.invalid';
  readonly message: string;
  readonly hint: string;
  readonly params?: IssueParams;
}

export interface ResolvedAsset {
  /** Absolute path after realpath resolution. */
  readonly absolutePath: string;
  /** Path relative to the project root as authored, using forward slashes. */
  readonly relativePath: string;
  readonly bytes: number;
  readonly sha256: string | null;
}

export type AssetResolution =
  | { readonly ok: true; readonly asset: ResolvedAsset }
  | { readonly ok: false; readonly issue: AssetValidationIssue };

export interface SoundFontOptions {
  /** Size ceiling in bytes. Defaults to `DEFAULT_MAX_SOUNDFONT_BYTES`. */
  readonly maxBytes?: number;
  /** Optional expected lowercase hexadecimal SHA-256. */
  readonly expectedSha256?: string | null;
  /** Skip the `RIFF`/`sfbk` header check. Only tests should need this. */
  readonly skipHeaderCheck?: boolean;
}

export interface ResolveProjectAssetOptions extends SoundFontOptions {
  /** Trusted project root. Must exist. */
  readonly projectRoot: string;
  /** Lexically confined relative path from the song instrument reference. */
  readonly relativePath: string;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function invalid(message: string, hint: string, params?: IssueParams): AssetResolution {
  return {
    ok: false,
    issue: { code: 'audio.asset.invalid', message, hint, ...(params ? { params } : {}) },
  };
}

function confined(message: string, hint: string, params?: IssueParams): AssetResolution {
  return {
    ok: false,
    issue: { code: 'audio.asset.confined', message, hint, ...(params ? { params } : {}) },
  };
}

function missing(message: string, hint: string, params?: IssueParams): AssetResolution {
  return {
    ok: false,
    issue: { code: 'audio.asset.missing', message, hint, ...(params ? { params } : {}) },
  };
}

function checksumMismatch(expected: string, actual: string): AssetResolution {
  return {
    ok: false,
    issue: {
      code: 'audio.asset.checksum_mismatch',
      message: `SoundFont checksum mismatch: expected ${expected}, received ${actual}.`,
      hint: 'Provision the pinned asset described in docs/instruments.md, or update the explicitly configured checksum if you intentionally use a different SoundFont. The file was not loaded.',
      params: { expectedSha256: expected, actualSha256: actual },
    },
  };
}

/** True for POSIX, Windows drive, or UNC-style absolute paths. */
function hasAbsolutePrefix(path: string): boolean {
  return isAbsolute(path) || /^[a-zA-Z]:[\\/]/.test(path) || /^\\\\/.test(path);
}

function hasUnsafeSegments(path: string): boolean {
  if (path.includes('\0') || path.includes('\\')) {
    return true;
  }
  return path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..');
}

function isInside(root: string, candidate: string): boolean {
  if (candidate === root) {
    return true;
  }
  return candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

async function readHeader(path: string): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(12);
    const { bytesRead } = await handle.read(buffer, 0, 12, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function isSoundFontHeader(header: Buffer): boolean {
  return (
    header.length >= 12 &&
    header.toString('ascii', 0, 4) === 'RIFF' &&
    header.toString('ascii', 8, 12) === 'sfbk'
  );
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

async function validateFileTypeSizeAndHeader(
  path: string,
  options: SoundFontOptions,
): Promise<
  AssetResolution | { readonly ok: true; readonly bytes: number; readonly sha256: string | null }
> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_SOUNDFONT_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    return {
      ok: false,
      issue: {
        code: 'audio.config.invalid',
        message: 'The SoundFont size limit must be a positive safe integer.',
        hint: 'Pass a byte ceiling such as 536870912.',
      },
    };
  }

  let info;
  try {
    info = await stat(path);
  } catch {
    return missing(
      `SoundFont asset "${path}" does not exist.`,
      'Provision the asset before rendering. Vamp never downloads assets during a render.',
      { path },
    );
  }

  if (!info.isFile()) {
    return invalid(
      `SoundFont asset "${path}" is not a regular file.`,
      'Point the instrument at a real .sf2 file, not a directory, device, or socket.',
      { path },
    );
  }
  if (info.size > maxBytes) {
    return invalid(
      `SoundFont asset "${path}" is ${info.size} bytes, above the ${maxBytes} byte limit.`,
      'Raise maxAssetBytes deliberately or use a smaller asset. Oversized assets are rejected before loading.',
      { path, bytes: info.size, maxBytes },
    );
  }
  if (info.size < 12) {
    return invalid(
      `SoundFont asset "${path}" is too small to be a SoundFont.`,
      'Replace the corrupt or truncated .sf2 file with a provisioned SoundFont.',
      { path, bytes: info.size },
    );
  }

  if (options.skipHeaderCheck !== true) {
    let header: Buffer;
    try {
      header = await readHeader(path);
    } catch {
      return missing(
        `SoundFont asset "${path}" could not be read.`,
        'Check file permissions and re-provision the asset.',
        { path },
      );
    }
    if (!isSoundFontHeader(header)) {
      return invalid(
        `SoundFont asset "${path}" is not a RIFF/sfbk SoundFont file.`,
        'Replace the corrupt or wrong-format file with a valid .sf2 SoundFont.',
        { path, header: header.toString('hex') },
      );
    }
  }

  let digest: string | null = null;
  const expected = options.expectedSha256 ?? null;
  if (expected !== null) {
    const normalized = expected.toLowerCase();
    if (!SHA256_PATTERN.test(normalized)) {
      return {
        ok: false,
        issue: {
          code: 'audio.config.invalid',
          message: 'The configured SoundFont checksum is not a lowercase SHA-256 hex digest.',
          hint: 'Pass 64 hexadecimal characters, for example the pinned FluidR3_GM.sf2 digest from docs/instruments.md.',
          params: { expectedSha256: expected },
        },
      };
    }
    try {
      digest = await sha256File(path);
    } catch {
      return missing(
        `SoundFont asset "${path}" could not be read for checksum verification.`,
        'Check file permissions and re-provision the asset.',
        { path },
      );
    }
    if (digest !== normalized) {
      return checksumMismatch(normalized, digest);
    }
  }

  return { ok: true, bytes: info.size, sha256: digest };
}

/**
 * Validate a trusted, globally configured GM SoundFont. It is backend
 * configuration rather than a song asset, so it is not confined to the project
 * root, but it still gets type, size, header, and optional checksum checks.
 */
export async function validateTrustedSoundFont(
  path: string,
  options: SoundFontOptions = {},
): Promise<AssetResolution> {
  if (typeof path !== 'string' || path.trim().length === 0) {
    return {
      ok: false,
      issue: {
        code: 'audio.config.invalid',
        message: 'No GM SoundFont path is configured for the FluidSynth backend.',
        hint: 'Configure gmSoundFont with a provisioned FluidR3_GM.sf2 path, or use the built-in synthesizer backend.',
      },
    };
  }
  if (!hasAbsolutePrefix(path)) {
    return {
      ok: false,
      issue: {
        code: 'audio.config.invalid',
        message: `The configured GM SoundFont path "${path}" is relative.`,
        hint: 'Use an absolute path for trusted backend configuration so renders do not depend on the process working directory.',
        params: { path },
      },
    };
  }
  const result = await validateFileTypeSizeAndHeader(resolve(path), options);
  if (!('bytes' in result)) {
    return result;
  }
  return {
    ok: true,
    asset: {
      absolutePath: resolve(path),
      relativePath: path,
      bytes: result.bytes,
      sha256: result.sha256,
    },
  };
}

/**
 * Resolve a song-referenced SoundFont inside a trusted project root.
 *
 * Rejects absolute paths, Windows separators, empty or dot segments, traversal,
 * symlink escapes (including escapes through an existing parent directory),
 * missing files, non-files, oversized files, wrong extensions, invalid RIFF/sfbk
 * headers, and optional checksum mismatches. Every failure is a structured
 * issue; this function does not throw for expected asset problems.
 */
export async function resolveProjectSoundFont(
  options: ResolveProjectAssetOptions,
): Promise<AssetResolution> {
  const relativePath = options.relativePath;
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    return missing(
      'The SoundFont instrument has no asset path.',
      'Set instrument.path to a .sf2 file inside the project root.',
    );
  }
  if (relativePath.length > MAX_ASSET_PATH_LENGTH) {
    return invalid(
      `The SoundFont path is ${relativePath.length} characters; the schema limit is ${MAX_ASSET_PATH_LENGTH}.`,
      'Use a shorter relative path inside the project root.',
      { length: relativePath.length, maxLength: MAX_ASSET_PATH_LENGTH },
    );
  }
  if (hasAbsolutePrefix(relativePath)) {
    return confined(
      `SoundFont path "${relativePath}" is absolute.`,
      'Use a path relative to the configured project root. Absolute paths are never accepted for song assets.',
      { path: relativePath },
    );
  }
  if (hasUnsafeSegments(relativePath)) {
    return confined(
      `SoundFont path "${relativePath}" contains an empty, dot, traversal, backslash, or NUL segment.`,
      'Use a plain forward-slash relative path such as "assets/piano.sf2" with no "." or ".." segments.',
      { path: relativePath },
    );
  }
  if (!relativePath.toLowerCase().endsWith('.sf2')) {
    return invalid(
      `SoundFont path "${relativePath}" does not end in ".sf2".`,
      'The FluidSynth sample backend loads .sf2 files only. SFZ is not supported by this backend.',
      { path: relativePath },
    );
  }

  if (!isAbsolute(options.projectRoot)) {
    return {
      ok: false,
      issue: {
        code: 'audio.config.invalid',
        message: `The configured project root "${options.projectRoot}" is relative.`,
        hint: 'Configure an absolute project directory so asset resolution does not depend on the process working directory.',
        params: { projectRoot: options.projectRoot },
      },
    };
  }

  let rootReal: string;
  try {
    rootReal = await realpath(resolve(options.projectRoot));
  } catch {
    return {
      ok: false,
      issue: {
        code: 'audio.config.invalid',
        message: `The configured project root "${options.projectRoot}" does not exist.`,
        hint: 'Configure projectRoot with the existing project directory that contains song assets.',
        params: { projectRoot: options.projectRoot },
      },
    };
  }

  const rootStat = await stat(rootReal);
  if (!rootStat.isDirectory()) {
    return {
      ok: false,
      issue: {
        code: 'audio.config.invalid',
        message: `The configured project root "${options.projectRoot}" is not a directory.`,
        hint: 'Configure projectRoot with the project directory, not a file.',
        params: { projectRoot: options.projectRoot },
      },
    };
  }

  const candidate = resolve(rootReal, relativePath);
  if (!isInside(rootReal, candidate)) {
    return confined(
      `SoundFont path "${relativePath}" resolves outside the project root.`,
      'Use a relative path inside the project root. Path traversal is rejected before any file access.',
      { path: relativePath },
    );
  }

  // Check the nearest existing ancestor before following the final path. This
  // catches an escape through a symlinked parent directory even when the file
  // itself is missing, and it avoids leaking whether an out-of-root target
  // exists.
  let ancestor = candidate;
  for (;;) {
    try {
      await lstat(ancestor);
      break;
    } catch {
      const parent = dirname(ancestor);
      if (parent === ancestor) {
        break;
      }
      ancestor = parent;
    }
  }
  try {
    const ancestorReal = await realpath(ancestor);
    if (!isInside(rootReal, ancestorReal)) {
      return confined(
        `SoundFont path "${relativePath}" escapes the project root through a symlinked parent directory.`,
        'Keep project asset directories inside the project root and avoid symlinks that point elsewhere.',
        { path: relativePath },
      );
    }
  } catch {
    // The ancestor is unusable; the final stat below reports a missing asset.
  }

  try {
    await lstat(candidate);
  } catch {
    const outside = !isInside(rootReal, candidate);
    if (outside) {
      return confined(
        `SoundFont path "${relativePath}" resolves outside the project root.`,
        'Use a relative path inside the project root.',
        { path: relativePath },
      );
    }
    return missing(
      `SoundFont asset "${relativePath}" does not exist in the project root.`,
      'Provision the asset inside the project and check the path spelling and case. Vamp never downloads assets during a render.',
      { path: relativePath },
    );
  }

  let candidateReal: string;
  try {
    candidateReal = await realpath(candidate);
  } catch {
    return missing(
      `SoundFont asset "${relativePath}" could not be resolved.`,
      'Check for a broken symlink and re-provision the asset.',
      { path: relativePath },
    );
  }
  if (!isInside(rootReal, candidateReal)) {
    return confined(
      `SoundFont asset "${relativePath}" is a symlink that resolves outside the project root.`,
      'Use a regular file or a symlink that stays inside the project root. Symlink escapes are rejected after realpath resolution.',
      { path: relativePath },
    );
  }

  const result = await validateFileTypeSizeAndHeader(candidateReal, options);
  if (!('bytes' in result)) {
    return result;
  }
  return {
    ok: true,
    asset: {
      absolutePath: candidateReal,
      relativePath,
      bytes: result.bytes,
      sha256: result.sha256,
    },
  };
}
