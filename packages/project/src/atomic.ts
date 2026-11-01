/**
 * Atomic file replacement for project storage.
 *
 * A temporary file is created in the destination directory, written, flushed
 * with `fsync`, closed, and renamed over the destination. A failure removes the
 * temporary file. This provides per-file atomicity on supported local
 * filesystems; it is not a transaction manager and does not replace the
 * revision lock used by `ProjectStore`.
 */

import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

import { failure, success, type ProjectResult } from './errors.js';

export interface AtomicWriteOptions {
  /** POSIX file mode for the destination. Defaults to 0o600. */
  readonly mode?: number;
}

export interface StagedWrite {
  readonly targetPath: string;
  readonly tempPath: string;
  /** Atomically publish the temporary file over the destination. */
  commit(): Promise<ProjectResult<void>>;
  /** Remove the temporary file. Safe to call after a failed commit. */
  discard(): Promise<void>;
}

const DEFAULT_FILE_MODE = 0o600;

function isFileSystemError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

/** Keep directory entries durable after a rename where the platform supports it. */
async function syncDirectoryBestEffort(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, constants.O_RDONLY);
    await handle.sync();
  } catch {
    // Directory fsync is not available on every platform or filesystem.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Stage an atomic write without publishing it. Callers that need to update two
 * files, such as song.json and the metadata revision, can stage both first and
 * only then publish them.
 */
export async function stageAtomicWrite(
  targetPath: string,
  data: Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<ProjectResult<StagedWrite>> {
  if (
    typeof targetPath !== 'string' ||
    targetPath.length === 0 ||
    targetPath.includes('\0') ||
    !isAbsolute(targetPath)
  ) {
    return failure(
      'project.path.invalid',
      'An atomic write target must be an absolute path without NUL bytes.',
      'Confine the target path before calling the atomic writer.',
    );
  }

  const mode = options.mode ?? DEFAULT_FILE_MODE;
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) {
    return failure(
      'project.config.invalid',
      'The atomic write mode must be an integer between 0 and 0o777.',
      'Use a POSIX mode such as 0o600.',
    );
  }

  const directory = dirname(targetPath);
  const tempPath = join(directory, `.vamp-tmp-${randomBytes(12).toString('hex')}`);

  let handle;
  try {
    handle = await open(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
    await handle.writeFile(data);
    await handle.sync();
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(tempPath).catch(() => undefined);
    const detail = isFileSystemError(error)
      ? `${error.code ?? 'error'}: ${error.message}`
      : undefined;
    return failure(
      'project.io.failed',
      `Could not write a temporary file for "${targetPath}".`,
      'Check that the project directory exists and is writable, then retry.',
      {
        path: targetPath,
        ...(detail === undefined ? {} : { detail }),
      },
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }

  let settled = false;
  const discard = async (): Promise<void> => {
    if (settled) {
      return;
    }
    settled = true;
    await unlink(tempPath).catch(() => undefined);
  };

  return success({
    targetPath,
    tempPath,
    async commit(): Promise<ProjectResult<void>> {
      if (settled) {
        return failure(
          'project.internal',
          'This staged write has already been committed or discarded.',
          'Stage a fresh write before committing again.',
        );
      }
      try {
        await rename(tempPath, targetPath);
        settled = true;
      } catch (error) {
        await discard();
        const detail = isFileSystemError(error)
          ? `${error.code ?? 'error'}: ${error.message}`
          : undefined;
        return failure(
          'project.io.failed',
          `Could not replace "${targetPath}" with the temporary file.`,
          'Check file permissions and whether the destination was replaced by a directory or another process.',
          {
            path: targetPath,
            ...(detail === undefined ? {} : { detail }),
          },
        );
      }
      await syncDirectoryBestEffort(directory);
      return success(undefined);
    },
    discard,
  });
}

/**
 * Write one file atomically. The caller owns path confinement. Expected I/O
 * failures are returned as values and never thrown.
 */
export async function writeFileAtomic(
  targetPath: string,
  data: Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<ProjectResult<void>> {
  const staged = await stageAtomicWrite(targetPath, data, options);
  if (!staged.ok) {
    return staged;
  }
  return staged.value.commit();
}
