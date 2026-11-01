import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const [source, target] = process.argv.slice(2);

if (source === undefined || target === undefined) {
  console.error('Usage: node scripts/copy-file.mjs <source> <target>');
  process.exitCode = 1;
} else {
  const destination = resolve(process.cwd(), target);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(resolve(process.cwd(), source), destination);
}
