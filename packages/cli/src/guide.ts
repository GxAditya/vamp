/**
 * Offline access to the agent-oriented schema guide.
 *
 * The authoritative source is `docs/schema-guide.md`. The CLI build copies it
 * to `packages/cli/dist/schema-guide.md` so a built package does not depend on
 * repository-relative paths. A source-tree fallback keeps direct source runs
 * working during development.
 */

import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MAX_GUIDE_BYTES = 2 * 1024 * 1024;

const CANDIDATES = [
  new URL('./schema-guide.md', import.meta.url),
  new URL('../../../docs/schema-guide.md', import.meta.url),
] as const;

export type SchemaGuideResult =
  | { readonly ok: true; readonly markdown: string; readonly path: string }
  | { readonly ok: false; readonly message: string };

export function readSchemaGuide(): SchemaGuideResult {
  for (const candidate of CANDIDATES) {
    let path: string;
    try {
      path = fileURLToPath(candidate);
      const info = statSync(path);
      if (!info.isFile() || info.size > MAX_GUIDE_BYTES) {
        continue;
      }
    } catch {
      continue;
    }
    try {
      return { ok: true, markdown: readFileSync(path, 'utf8'), path };
    } catch {
      continue;
    }
  }
  return {
    ok: false,
    message:
      'The schema guide is unavailable. Run "pnpm build" from the repository root to copy docs/schema-guide.md into the CLI build output.',
  };
}
