import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

interface PackageManifest {
  name: string;
  private?: boolean;
  license?: string;
  bin?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  engines?: Record<string, string>;
  exports?: Record<string, Record<string, string>>;
  files?: string[];
  publishConfig?: { access?: string };
}

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function readManifest(packageDir: string): PackageManifest {
  const path =
    packageDir === '.'
      ? join(repoRoot, 'package.json')
      : join(repoRoot, 'packages', packageDir, 'package.json');
  return JSON.parse(readFileSync(path, 'utf8')) as PackageManifest;
}

const manifests = {
  schema: readManifest('schema'),
  engine: readManifest('engine'),
  project: readManifest('project'),
  cli: readManifest('cli'),
  mcpServer: readManifest('mcp-server'),
  sdk: readManifest('sdk'),
} as const;

function workspaceDependencies(manifest: PackageManifest): string[] {
  return Object.keys(manifest.dependencies ?? {})
    .filter((name) => name.startsWith('@gxaditya/vamp-'))
    .sort();
}

describe('workspace dependency boundaries', () => {
  it('keeps the schema package independent of other workspace packages', () => {
    expect(workspaceDependencies(manifests.schema)).toEqual([]);
  });

  it('allows the engine to depend on schema only', () => {
    expect(workspaceDependencies(manifests.engine)).toEqual(['@gxaditya/vamp-schema']);
  });

  it('makes project storage depend on schema only', () => {
    expect(workspaceDependencies(manifests.project)).toEqual(['@gxaditya/vamp-schema']);
  });

  it('keeps the engine independent of project storage', () => {
    expect(workspaceDependencies(manifests.engine)).not.toContain('@gxaditya/vamp-project');
  });

  it('makes the CLI consume schema, engine, and project storage', () => {
    expect(workspaceDependencies(manifests.cli)).toEqual([
      '@gxaditya/vamp-engine',
      '@gxaditya/vamp-project',
      '@gxaditya/vamp-schema',
    ]);
  });

  it('makes the MCP server and SDK consume schema, engine, and project storage', () => {
    expect(workspaceDependencies(manifests.mcpServer)).toEqual([
      '@gxaditya/vamp-engine',
      '@gxaditya/vamp-project',
      '@gxaditya/vamp-schema',
    ]);
    expect(workspaceDependencies(manifests.sdk)).toEqual([
      '@gxaditya/vamp-engine',
      '@gxaditya/vamp-project',
      '@gxaditya/vamp-schema',
    ]);
  });

  it('links the built SDK for the root examples without giving the SDK consumers', () => {
    // The root package depends on @gxaditya/vamp-sdk as tooling so examples/ imports
    // the built package like an external consumer. The SDK itself must keep
    // depending only on the shared libraries, never on the CLI or MCP server.
    const root = readManifest('.');
    expect(
      Object.keys(root.devDependencies ?? {})
        .filter((name) => name.startsWith('@gxaditya/vamp-'))
        .sort(),
    ).toEqual(['@gxaditya/vamp-cli', '@gxaditya/vamp-mcp-server', '@gxaditya/vamp-sdk']);
    expect(manifests.sdk.dependencies?.['@gxaditya/vamp-cli']).toBeUndefined();
    expect(manifests.sdk.dependencies?.['@gxaditya/vamp-mcp-server']).toBeUndefined();
    // The SDK must declare its built entry points for consumption outside
    // the workspace: types and import both resolve into dist.
    const sdkExports = manifests.sdk.exports?.['.'];
    expect(sdkExports).toMatchObject({
      types: './dist/index.d.ts',
      import: './dist/index.js',
    });
    // Task 21: the SDK tarball must also ship the third-party notices file,
    // copied into the package root at build time like the CLI guide assets.
    expect(manifests.sdk.files).toEqual(['dist', 'THIRD_PARTY_NOTICES.md']);
  });

  it('does not make shared packages depend on consumer packages', () => {
    for (const manifest of [
      manifests.schema,
      manifests.engine,
      manifests.project,
      manifests.mcpServer,
      manifests.sdk,
    ]) {
      expect(workspaceDependencies(manifest)).not.toContain('@gxaditya/vamp-cli');
      expect(workspaceDependencies(manifest)).not.toContain('@gxaditya/vamp-mcp-server');
      expect(workspaceDependencies(manifest)).not.toContain('@gxaditya/vamp-sdk');
    }
  });
});

describe('workspace package metadata', () => {
  it('keeps every package publishable under AGPL-3.0-only', () => {
    for (const manifest of Object.values(manifests)) {
      expect(manifest.private).not.toBe(true);
      expect(manifest.license).toBe('AGPL-3.0-only');
      expect(manifest.publishConfig?.access).toBe('public');
    }
  });

  it('declares Node >=22.13.0 for every package', () => {
    for (const manifest of Object.values(manifests)) {
      expect(manifest.engines?.node).toBe('>=22.13.0');
    }
  });

  it('wires the local vamp bin to the CLI launcher', () => {
    expect(manifests.cli.bin).toEqual({ vamp: './bin/vamp.js' });
  });
});
