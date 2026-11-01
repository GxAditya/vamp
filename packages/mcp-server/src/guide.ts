/**
 * Offline access to the authoritative agent-oriented schema guide.
 *
 * `docs/schema-guide.md` is the single source of truth. The MCP server build
 * copies that file to `dist/schema-guide.md`, matching the CLI pattern, so a
 * built package does not depend on a repository-relative path. A source-tree
 * fallback keeps direct source execution working during development.
 *
 * The guide is documentation, not a second schema or validator. Tool output
 * identifies the source label but does not rewrite or parse the content.
 */

import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Stable source label returned to agents. */
export const SCHEMA_GUIDE_SOURCE = 'docs/schema-guide.md' as const;

const MAX_GUIDE_BYTES = 2 * 1024 * 1024;

const CANDIDATES = [
  new URL('./schema-guide.md', import.meta.url),
  new URL('../../../docs/schema-guide.md', import.meta.url),
] as const;

export type SchemaGuideReadResult =
  | { readonly ok: true; readonly markdown: string; readonly path: string }
  | { readonly ok: false; readonly message: string };

export function readSchemaGuide(): SchemaGuideReadResult {
  for (const candidate of CANDIDATES) {
    let path: string;
    try {
      path = fileURLToPath(candidate);
      const info = statSync(path);
      if (!info.isFile() || info.size === 0 || info.size > MAX_GUIDE_BYTES) {
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
      'The schema guide is unavailable. Run "pnpm build" from the repository root to copy docs/schema-guide.md into the MCP server build output.',
  };
}
