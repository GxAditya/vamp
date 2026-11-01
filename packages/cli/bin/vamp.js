#!/usr/bin/env node
import { existsSync } from 'node:fs';

const entry = new URL('../dist/index.js', import.meta.url);

if (!existsSync(entry)) {
  console.error('vamp: CLI build output is missing. Run "pnpm build" from the repository root.');
  process.exitCode = 1;
} else {
  await import(entry.href);
}
