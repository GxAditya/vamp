#!/usr/bin/env node
import { existsSync } from 'node:fs';

const entry = new URL('../dist/main.js', import.meta.url);

if (!existsSync(entry)) {
  console.error(
    'vamp-mcp: MCP server build output is missing. Run "pnpm build" from the repository root.',
  );
  process.exitCode = 1;
} else {
  await import(entry.href);
}
