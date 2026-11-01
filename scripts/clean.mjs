import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const packagesDir = join(repoRoot, 'packages');

for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
  if (entry.isDirectory()) {
    rmSync(join(packagesDir, entry.name, 'dist'), { recursive: true, force: true });
    // Build-time copy of the root notices file (see Task 21 packaging).
    rmSync(join(packagesDir, entry.name, 'THIRD_PARTY_NOTICES.md'), { force: true });
  }
}

rmSync(join(repoRoot, 'coverage'), { recursive: true, force: true });
