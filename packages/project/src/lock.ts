/**
 * Bounded cross-platform writer lock for one project directory.
 *
 * `open(..., O_CREAT | O_EXCL)` is atomic on local filesystems, so at most one
 * writer can create the lock. Acquisition waits at most `lockTimeoutMs`. A lock
 * older than `staleLockMs` is treated as orphaned and removed, which recovers
 * from crashed writers.
 */

import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { failure, success, type ProjectResult } from './errors.js';
import { PROJECT_LAYOUT } from './limits.js';

export interface ProjectLock {
  readonly nonce: string;
  /** Best-effort release. It only removes the lock if our nonce is still there. */
  release(): Promise<void>;
}

interface LockContents {
  readonly format: 'vamp-lock';
  readonly version: 1;
  readonly nonce: string;
  readonly pid: number;
  readonly createdAt: string;
}

const MAX_LOCK_BYTES = 4096;
const MAX_LOCK_POLL_MS = 25;

function isFileSystemError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function readLockNonce(lockPath: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(lockPath, constants.O_RDONLY);
    const buffer = Buffer.alloc(MAX_LOCK_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const parsed = JSON.parse(buffer.toString('utf8', 0, bytesRead)) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'nonce' in parsed &&
      typeof parsed.nonce === 'string'
    ) {
      return parsed.nonce;
    }
    return null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Acquire the project writer lock. All expected failures are returned as
 * structured values. The caller must release the lock in a finally block.
 */
export async function acquireProjectLock(
  projectDir: string,
  lockTimeoutMs: number,
  staleLockMs: number,
): Promise<ProjectResult<ProjectLock>> {
  const lockPath = join(projectDir, PROJECT_LAYOUT.lockFile);
  const nonce = randomBytes(16).toString('hex');
  const deadline = Date.now() + lockTimeoutMs;

  for (;;) {
    let handle;
    let created = false;
    try {
      handle = await open(
        lockPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
      created = true;
      const contents: LockContents = {
        format: 'vamp-lock',
        version: 1,
        nonce,
        pid: process.pid,
        createdAt: new Date().toISOString(),
      };
      await handle.writeFile(`${JSON.stringify(contents)}\n`);
      await handle.sync();
      await handle.close();
      return success({
        nonce,
        async release(): Promise<void> {
          const current = await readLockNonce(lockPath);
          if (current === nonce) {
            await unlink(lockPath).catch(() => undefined);
          }
        },
      });
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (created) {
        await unlink(lockPath).catch(() => undefined);
      }
      if (!isFileSystemError(error) || error.code !== 'EEXIST') {
        const detail = isFileSystemError(error)
          ? `${error.code ?? 'error'}: ${error.message}`
          : undefined;
        return failure(
          'project.lock.failed',
          'Could not create the project writer lock.',
          'Check that the project directory and lock file are writable, then retry.',
          {
            path: PROJECT_LAYOUT.lockFile,
            ...(detail === undefined ? {} : { detail }),
          },
        );
      }
    }

    let lockInfo;
    try {
      lockInfo = await lstat(lockPath);
    } catch (error) {
      if (isFileSystemError(error) && error.code === 'ENOENT') {
        continue;
      }
      return failure(
        'project.lock.failed',
        'Could not inspect an existing project writer lock.',
        'Check project directory permissions and retry.',
        { path: PROJECT_LAYOUT.lockFile },
      );
    }

    if (!lockInfo.isFile()) {
      return failure(
        'project.lock.invalid',
        'The project lock path exists but is not a regular file.',
        `Remove the unexpected ${PROJECT_LAYOUT.lockFile} entry if no writer is active, then retry.`,
        { path: PROJECT_LAYOUT.lockFile },
      );
    }

    let lockStat;
    try {
      lockStat = await stat(lockPath);
    } catch (error) {
      if (isFileSystemError(error) && error.code === 'ENOENT') {
        continue;
      }
      return failure(
        'project.lock.failed',
        'Could not read project lock timestamps.',
        'Check project directory permissions and retry.',
        { path: PROJECT_LAYOUT.lockFile },
      );
    }

    if (Date.now() - lockStat.mtimeMs > staleLockMs) {
      try {
        await unlink(lockPath);
      } catch (error) {
        if (!isFileSystemError(error) || error.code !== 'ENOENT') {
          return failure(
            'project.lock.failed',
            'Could not remove a stale project writer lock.',
            'Remove the lock file manually if no writer process is alive, then retry.',
            { path: PROJECT_LAYOUT.lockFile },
          );
        }
      }
      continue;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return failure(
        'project.lock.busy',
        'Another writer holds the project lock.',
        'Retry after the other update finishes. The wait is bounded; no change was made.',
        { path: PROJECT_LAYOUT.lockFile },
      );
    }
    await delay(Math.min(remaining, MAX_LOCK_POLL_MS));
  }
}
