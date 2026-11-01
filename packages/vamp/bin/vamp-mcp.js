#!/usr/bin/env node
// Umbrella bin: forwards to @gxaditya/vamp-mcp-server's real launcher. The
// dependency carries the stdio MCP server; this shim only resolves and
// executes it in-process so argv and stdio behave identically.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

function packageRoot(spec) {
  try {
    return dirname(require.resolve(`${spec}/package.json`));
  } catch {
    // An exports map without a package.json subpath: "." resolves to the
    // library entry under dist/, two levels below the package root.
    return dirname(dirname(require.resolve(spec)));
  }
}

const bin = join(packageRoot('@gxaditya/vamp-mcp-server'), 'bin', 'vamp-mcp.js');

if (!existsSync(bin)) {
  console.error(
    'vamp-mcp: @gxaditya/vamp-mcp-server is missing its launcher. Reinstall @gxaditya/vamp.',
  );
  process.exitCode = 1;
} else {
  await import(pathToFileURL(bin).href);
}
