import { chmodSync } from 'node:fs';
import { resolve } from 'node:path';

const target = process.argv[2];

if (target === undefined) {
  console.error('Usage: node scripts/make-executable.mjs <file>');
  process.exitCode = 1;
} else if (process.platform !== 'win32') {
  // npm/pnpm bin shims handle Windows; Unix needs the executable bit set.
  chmodSync(resolve(process.cwd(), target), 0o755);
}
