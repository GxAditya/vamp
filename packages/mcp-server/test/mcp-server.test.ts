import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { INSTRUMENT_REGISTRY_VALIDATION, describeInstrumentRegistry } from '@gxaditya/vamp-engine';
import { ProjectStore } from '@gxaditya/vamp-project';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 30_000 });

const serverEntry = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const launcher = fileURLToPath(new URL('../bin/vamp-mcp.js', import.meta.url));
const nativeBinary = process.env.VAMP_FLUIDSYNTH_PATH ?? '/usr/bin/fluidsynth';
const nativeSoundFont = process.env.VAMP_SOUNDFONT_PATH ?? '/usr/share/sounds/sf2/FluidR3_GM.sf2';
const nativeAvailable = existsSync(nativeBinary) && existsSync(nativeSoundFont);

const MISSING_BINARY = '/definitely/missing/vamp-fluidsynth';
const MISSING_SOUNDFONT = '/definitely/missing/FluidR3_GM.sf2';
const SECRET_VALUE = 'vamp-mcp-test-secret-never-report';

const temporaryDirectories: string[] = [];

function tempDirectory(prefix = 'vamp-mcp-test-'): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterAll(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function minimalSong(title = 'MCP Test Song'): Record<string, unknown> {
  return {
    schemaVersion: '1.0.0',
    meta: {
      title,
      bpm: 100,
      timeSignature: { numerator: 4, denominator: 4 },
      key: { tonic: 'C', mode: 'major' },
      seed: 11,
      durationHint: 2,
    },
    tracks: [
      {
        id: 'keys',
        name: 'Keys',
        kind: 'midi',
        channel: 0,
        instrument: { type: 'builtin', id: 'keys.soft' },
        notes: [{ pitch: 60, start: 0, duration: 2 }],
      },
    ],
  };
}

async function createProject(root: string, projectId = 'demo'): Promise<void> {
  const store = new ProjectStore({ root, validation: INSTRUMENT_REGISTRY_VALIDATION });
  const created = await store.create({ projectId, song: minimalSong() });
  expect(created.ok).toBe(true);
}

function structuredContent(result: CallToolResult): Record<string, unknown> {
  expect(result.structuredContent).toBeDefined();
  return result.structuredContent as Record<string, unknown>;
}

async function callTool(
  session: Session,
  name: string,
  args: Record<string, unknown> = {},
): Promise<CallToolResult> {
  return (await session.client.callTool({ name, arguments: args })) as CallToolResult;
}

function textContent(result: CallToolResult): string {
  const first = result.content[0];
  expect(first).toBeDefined();
  if (first === undefined || first.type !== 'text') {
    throw new Error('expected text content');
  }
  return first.text;
}

interface Session {
  readonly client: Client;
  readonly transport: StdioClientTransport;
  readonly stderr: () => string;
  readonly close: () => Promise<void>;
}

async function connectSession(
  args: readonly string[],
  environment: Readonly<Record<string, string>>,
): Promise<Session> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry, ...args],
    cwd: tempDirectory('vamp-mcp-cwd-'),
    env: { ...environment },
    stderr: 'pipe',
  });
  const chunks: Buffer[] = [];
  transport.stderr?.on('data', (chunk: Buffer | string) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  const client = new Client({ name: 'vamp-mcp-test-client', version: '1.0.0' });
  await client.connect(transport);
  return {
    client,
    transport,
    stderr: () => Buffer.concat(chunks).toString('utf8'),
    close: async () => {
      await client.close();
    },
  };
}

const deterministicEnvironment = {
  VAMP_PROJECT_ROOT: '',
  VAMP_FLUIDSYNTH_PATH: MISSING_BINARY,
  VAMP_SOUNDFONT_PATH: MISSING_SOUNDFONT,
  VAMP_TEST_SECRET: SECRET_VALUE,
} as const;

describe('Vamp MCP server over the official SDK client', () => {
  it('initializes, lists only real discovery tools, and shuts down cleanly', async () => {
    const session = await connectSession([], deterministicEnvironment);
    try {
      const version = session.client.getServerVersion();
      expect(version).toMatchObject({ name: 'vamp-mcp-server', version: '0.1.0' });

      const listed = await session.client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([
        'health_check',
        'get_schema_guide',
        'list_instruments',
        'list_presets',
        'validate_song',
        'create_song',
        'get_song',
        'list_projects',
        'update_song',
        'add_track',
        'add_notes',
        'set_pattern',
        'set_instrument',
        'render_song',
      ]);
      const names = listed.tools.map((tool) => tool.name);
      expect(names).toContain('validate_song');
      expect(names).toContain('create_song');
      expect(names).toContain('get_song');
      expect(names).toContain('list_projects');
      expect(names).toContain('update_song');
      expect(names).toContain('add_track');
      expect(names).toContain('add_notes');
      expect(names).toContain('set_pattern');
      expect(names).toContain('set_instrument');
      expect(names).toContain('render_song');
      const discoveryNames = ['health_check', 'get_schema_guide', 'list_instruments'];
      for (const tool of listed.tools) {
        expect(tool.description?.length).toBeGreaterThan(200);
        expect(tool.inputSchema).toMatchObject({ type: 'object' });
        expect(tool.outputSchema).toBeDefined();
        expect(tool.annotations).toMatchObject({ openWorldHint: false });
        if (discoveryNames.includes(tool.name)) {
          expect(tool.annotations).toMatchObject({
            readOnlyHint: true,
            destructiveHint: false,
          });
        }
      }
    } finally {
      await session.close();
    }
    const stderr = session.stderr();
    expect(stderr).toContain('vamp-mcp: ready');
    expect(stderr).toContain('shutting down (stdin closed)');
    expect(stderr).not.toContain(SECRET_VALUE);
  });

  it('calls all three tools, reports setup, and returns the authoritative guide and registry', async () => {
    const root = tempDirectory('vamp-mcp-projects-');
    await createProject(root, 'demo');
    const session = await connectSession(['--project-root', root], {
      ...deterministicEnvironment,
      VAMP_PROJECT_ROOT: join(root, 'ignored-environment-root'),
    });
    try {
      const health = await callTool(session, 'health_check');
      expect(health.isError).not.toBe(true);
      const healthData = structuredContent(health);
      expect(healthData).toMatchObject({
        status: 'ok',
        server: {
          name: 'vamp-mcp-server',
          version: '0.1.0',
          transport: 'stdio',
        },
        versions: {
          schema: '1.0.0',
          schemaId: 'urn:vamp:schema:song:1.0.0',
          instrumentRegistry: 1,
        },
        builtInRendering: {
          status: 'usable',
          backendId: 'builtin-synth-v1',
          required: true,
          maxVoicesPerTrack: 32,
          curatedInstrumentCount: 6,
        },
        sampleBackend: {
          status: 'unavailable',
          optional: true,
          missingDependencies: ['executable', 'soundfont'],
        },
        guide: { available: true, source: 'docs/schema-guide.md' },
        projectRoot: {
          configured: true,
          source: 'argument',
          path: root,
          status: 'valid',
          projectCount: 1,
        },
        jobs: {
          maxConcurrentRenders: 1,
          maxPendingJobs: 4,
          renderTimeoutMs: 120_000,
          maxToolInputElements: 20_000,
        },
      });
      expect(healthData['configurationWarnings']).toEqual([]);
      expect(textContent(health)).toContain('Vamp MCP health: ok');
      expect(textContent(health)).toContain('Built-in rendering: usable');
      expect(textContent(health)).toContain('Default render backend: builtin (unavailable)');

      const guide = await callTool(session, 'get_schema_guide');
      expect(guide.isError).not.toBe(true);
      const guideData = structuredContent(guide);
      const markdown = guideData['markdown'];
      expect(typeof markdown).toBe('string');
      if (typeof markdown !== 'string') {
        throw new Error('expected markdown guide');
      }
      expect(guideData).toMatchObject({
        schemaVersion: '1.0.0',
        format: 'markdown',
        source: 'docs/schema-guide.md',
        bytes: Buffer.byteLength(markdown, 'utf8'),
      });
      expect(markdown).toContain('# Vamp Song Schema guide');
      expect(markdown).toContain('## Complete render output workflow');
      expect(textContent(guide)).toBe(markdown);

      const instruments = await callTool(session, 'list_instruments');
      expect(instruments.isError).not.toBe(true);
      const instrumentData = structuredContent(instruments);
      const entries = instrumentData['instruments'];
      expect(Array.isArray(entries)).toBe(true);
      if (!Array.isArray(entries)) {
        throw new Error('expected instrument entries');
      }
      const registry = describeInstrumentRegistry();
      expect(instrumentData['registryVersion']).toBe(registry.registryVersion);
      expect(instrumentData['sampleBackendId']).toBe('fluidsynth-sf2-v1');
      expect(instrumentData['availability']).toMatchObject({
        builtin: true,
        sampleBackend: false,
        missingDependencies: ['executable', 'soundfont'],
      });
      expect(entries.map((entry) => (entry as Record<string, unknown>)['id'])).toEqual(
        registry.instruments.map((entry) => entry.id),
      );
      for (const entry of entries) {
        const instrument = entry as Record<string, unknown>;
        expect(instrument['description']).toEqual(expect.any(String));
        expect(instrument['category']).toEqual(expect.any(String));
        expect(instrument['sampleBackend']).toMatchObject({
          backendId: 'fluidsynth-sf2-v1',
          program: expect.any(Number),
          bank: expect.any(Number),
          channel: expect.any(Number),
        });
        const asset = instrument['asset'] as Record<string, unknown>;
        const checksum = asset['checksum'] as Record<string, unknown>;
        expect(checksum['algorithm']).toBe('sha256');
        expect(checksum['value']).toMatch(/^[0-9a-f]{64}$/);
        expect(instrument['provenance']).toMatchObject({ author: 'Frank Wen' });
        expect(instrument['license']).toMatchObject({ spdx: 'MIT' });
        expect(instrument['availability']).toMatchObject({
          builtin: true,
          sampleBackend: false,
          missingDependencies: ['executable', 'soundfont'],
        });
      }
      expect(textContent(instruments)).toContain('piano.soft');
      expect(textContent(instruments)).toContain('drums.kit');

      const serialized = JSON.stringify({ health, guide, instruments });
      expect(serialized).not.toContain(SECRET_VALUE);
    } finally {
      await session.close();
    }
    expect(session.stderr()).toContain('shutting down (stdin closed)');
  });

  it('returns structured tool errors for invalid input and unknown tools without crashing', async () => {
    const session = await connectSession([], deterministicEnvironment);
    try {
      for (const name of ['health_check', 'get_schema_guide', 'list_instruments']) {
        const result = await callTool(session, name, { unexpected: true });
        expect(result.isError).toBe(true);
        expect(textContent(result)).toContain('Input validation error');
      }

      const unknown = await callTool(session, 'render_album');
      expect(unknown.isError).toBe(true);
      expect(textContent(unknown)).toContain('not found');

      const after = await callTool(session, 'health_check');
      expect(after.isError).not.toBe(true);
      expect(structuredContent(after)['status']).toBe('ok');
    } finally {
      await session.close();
    }
  });

  it('starts without a project root and reports missing or invalid roots without hard-failing', async () => {
    const noRoot = await connectSession([], deterministicEnvironment);
    try {
      const health = await callTool(noRoot, 'health_check');
      expect(health.isError).not.toBe(true);
      expect(structuredContent(health)['projectRoot']).toMatchObject({
        configured: false,
        source: 'none',
        path: null,
        status: 'not_configured',
      });
    } finally {
      await noRoot.close();
    }

    const missingRoot = join(tempDirectory(), 'missing-root');
    const withMissing = await connectSession([], {
      ...deterministicEnvironment,
      VAMP_PROJECT_ROOT: missingRoot,
    });
    try {
      const health = await callTool(withMissing, 'health_check');
      expect(health.isError).not.toBe(true);
      expect(structuredContent(health)['projectRoot']).toMatchObject({
        configured: true,
        source: 'environment',
        path: missingRoot,
        status: 'missing',
        code: 'project.root.not_found',
      });
      const guide = await callTool(withMissing, 'get_schema_guide');
      expect(guide.isError).not.toBe(true);
    } finally {
      await withMissing.close();
    }
  });

  it.runIf(nativeAvailable)(
    'reports provisioned FluidSynth and SoundFont availability with a safe version',
    async () => {
      const session = await connectSession(
        ['--fluidsynth-path', nativeBinary, '--soundfont', nativeSoundFont],
        { VAMP_PROJECT_ROOT: '' },
      );
      try {
        const health = await callTool(session, 'health_check');
        expect(health.isError).not.toBe(true);
        const sample = structuredContent(health)['sampleBackend'] as Record<string, unknown>;
        expect(sample).toMatchObject({
          status: 'available',
          optional: true,
          missingDependencies: [],
          executable: {
            configuredPath: nativeBinary,
            source: 'argument',
            available: true,
            status: 'available',
            version: expect.any(String),
          },
          soundFont: {
            path: nativeSoundFont,
            available: true,
            status: 'available',
            bytes: expect.any(Number),
          },
        });
        const instruments = await callTool(session, 'list_instruments');
        expect(instruments.isError).not.toBe(true);
        const registry = structuredContent(instruments);
        expect(registry['availability']).toMatchObject({
          builtin: true,
          sampleBackend: true,
          missingDependencies: [],
        });
        const entries = registry['instruments'];
        expect(Array.isArray(entries)).toBe(true);
        if (Array.isArray(entries)) {
          for (const entry of entries) {
            expect((entry as Record<string, unknown>)['availability']).toMatchObject({
              builtin: true,
              sampleBackend: true,
              missingDependencies: [],
            });
          }
        }
      } finally {
        await session.close();
      }
    },
  );
});

function bassTrack(): Record<string, unknown> {
  return {
    id: 'bass',
    name: 'Bass',
    kind: 'midi',
    channel: 1,
    instrument: { type: 'builtin', id: 'bass.sub' },
    notes: [{ pitch: 40, start: 0, duration: 2 }],
  };
}

function structuredError(result: CallToolResult): Record<string, unknown> {
  expect(result.isError).toBe(true);
  // Tool errors carry no structuredContent (it must conform to the success
  // outputSchema). The machine-readable payload is the JSON text item.
  const jsonItem = result.content.find(
    (item) => item.type === 'text' && item.text.trimStart().startsWith('{'),
  );
  expect(jsonItem).toBeDefined();
  if (jsonItem === undefined || jsonItem.type !== 'text') {
    throw new Error('expected JSON error text content');
  }
  const parsed = JSON.parse(jsonItem.text) as Record<string, unknown>;
  const error = parsed['error'];
  expect(error).toBeDefined();
  expect(typeof error).toBe('object');
  return error as Record<string, unknown>;
}

function projectFrom(result: CallToolResult): Record<string, unknown> {
  expect(result.isError).not.toBe(true);
  const project = structuredContent(result)['project'];
  expect(project).toBeDefined();
  return project as Record<string, unknown>;
}

async function currentRevision(session: Session, projectId: string): Promise<number> {
  const got = await callTool(session, 'get_song', { projectId });
  return projectFrom(got)['revision'] as number;
}

describe('Vamp MCP authoring and edit tools', () => {
  it('validates unsaved songs without writing, then creates, reads, lists, and replaces a project', async () => {
    const root = tempDirectory('vamp-mcp-author-');
    const session = await connectSession(['--project-root', root], deterministicEnvironment);
    try {
      const draft = await callTool(session, 'validate_song', {
        song: {
          ...minimalSong('Draft'),
          patterns: [{ id: 'loop', notes: [{ pitch: 60, start: 0, duration: 1 }] }],
        },
      });
      expect(draft.isError).not.toBe(true);
      const draftData = structuredContent(draft);
      expect(draftData).toMatchObject({
        valid: true,
        errorCount: 0,
        capabilityCheck: 'not_checked',
      });
      expect(draftData['schemaVersion']).toBe('1.0.0');
      expect(draftData['warnings']).toEqual(expect.any(Array));
      expect((draftData['warnings'] as unknown[]).length).toBeGreaterThan(0);
      // validate_song must not create any project.
      const emptyList = await callTool(session, 'list_projects');
      expect(structuredContent(emptyList)['count']).toBe(0);

      const invalid = await callTool(session, 'validate_song', {
        song: { schemaVersion: '1.0.0', meta: {}, tracks: [] },
      });
      expect(invalid.isError).not.toBe(true);
      const invalidData = structuredContent(invalid);
      expect(invalidData['valid']).toBe(false);
      expect((invalidData['errors'] as unknown[]).length).toBeGreaterThan(0);
      expect(invalidData['errorCount']).toBeGreaterThan(0);

      const created = await callTool(session, 'create_song', {
        projectId: 'demo',
        song: minimalSong(),
      });
      const createdProject = projectFrom(created);
      expect(createdProject['projectId']).toBe('demo');
      expect(createdProject['revision']).toBe(1);
      const song = createdProject['song'] as Record<string, unknown>;
      expect((song['meta'] as Record<string, unknown>)['title']).toBe('MCP Test Song');

      const got = await callTool(session, 'get_song', { projectId: 'demo' });
      expect(projectFrom(got)['revision']).toBe(1);

      const listed = await callTool(session, 'list_projects');
      expect(listed.isError).not.toBe(true);
      const listedData = structuredContent(listed);
      expect(listedData['count']).toBe(1);
      const projects = listedData['projects'] as Record<string, unknown>[];
      expect(projects.map((project) => project['projectId'])).toEqual(['demo']);
      expect(projects[0]).not.toHaveProperty('song');

      const updated = await callTool(session, 'update_song', {
        projectId: 'demo',
        expectedRevision: 1,
        song: minimalSong('Renamed'),
      });
      const updatedProject = projectFrom(updated);
      expect(updatedProject['revision']).toBe(2);
      expect(structuredContent(updated)['previousRevision']).toBe(2 - 1);
      expect((updatedProject['song'] as Record<string, unknown>)['meta']).toMatchObject({
        title: 'Renamed',
      });

      const duplicate = await callTool(session, 'create_song', {
        projectId: 'demo',
        song: minimalSong('Other'),
      });
      expect(structuredError(duplicate)['code']).toBe('project.exists');
      expect(await currentRevision(session, 'demo')).toBe(2);
    } finally {
      await session.close();
    }
  });

  it('adds a track, notes, a pattern, and an instrument, then persists across a server restart', async () => {
    const root = tempDirectory('vamp-mcp-author-');
    const first = await connectSession(['--project-root', root], deterministicEnvironment);
    try {
      await callTool(first, 'create_song', { projectId: 'demo', song: minimalSong() });

      const addedTrack = await callTool(first, 'add_track', {
        projectId: 'demo',
        expectedRevision: 1,
        track: bassTrack(),
      });
      expect(projectFrom(addedTrack)['revision']).toBe(2);

      const addedNotes = await callTool(first, 'add_notes', {
        projectId: 'demo',
        expectedRevision: 2,
        trackId: 'keys',
        notes: [{ pitch: 64, start: 2, duration: 1 }],
      });
      expect(projectFrom(addedNotes)['revision']).toBe(3);

      const setPattern = await callTool(first, 'set_pattern', {
        projectId: 'demo',
        expectedRevision: 3,
        pattern: { id: 'loop', lengthBeats: 2, notes: [{ pitch: 62, start: 0, duration: 1 }] },
      });
      expect(projectFrom(setPattern)['revision']).toBe(4);

      const setInstrument = await callTool(first, 'set_instrument', {
        projectId: 'demo',
        expectedRevision: 4,
        trackId: 'keys',
        instrument: { type: 'builtin', id: 'piano.soft' },
      });
      const instrumentProject = projectFrom(setInstrument);
      expect(instrumentProject['revision']).toBe(5);
      const instrumentSong = instrumentProject['song'] as Record<string, unknown>;
      const tracks = instrumentSong['tracks'] as Record<string, unknown>[];
      expect(tracks.map((track) => track['id'])).toEqual(['keys', 'bass']);
    } finally {
      await first.close();
    }

    const restarted = await connectSession(['--project-root', root], deterministicEnvironment);
    try {
      const got = await callTool(restarted, 'get_song', { projectId: 'demo' });
      const project = projectFrom(got);
      expect(project['revision']).toBe(5);
      const song = project['song'] as Record<string, unknown>;
      const tracks = song['tracks'] as Record<string, unknown>[];
      expect(tracks.map((track) => track['id'])).toContain('bass');
      const keys = tracks.find((track) => track['id'] === 'keys') as Record<string, unknown>;
      expect(keys['instrument']).toMatchObject({ type: 'builtin', id: 'piano.soft' });
      expect((keys['notes'] as unknown[]).length).toBe(2);
      expect(song['patterns']).toEqual([
        { id: 'loop', lengthBeats: 2, notes: [{ pitch: 62, start: 0, duration: 1 }] },
      ]);
    } finally {
      await restarted.close();
    }
  });

  it('rejects invalid edits, stale revisions, duplicate ids, and missing projects without changing valid data', async () => {
    const root = tempDirectory('vamp-mcp-author-');
    const session = await connectSession(['--project-root', root], deterministicEnvironment);
    try {
      await callTool(session, 'create_song', { projectId: 'demo', song: minimalSong() });

      const unknownBuiltin = await callTool(session, 'add_track', {
        projectId: 'demo',
        expectedRevision: 1,
        track: {
          id: 'ghost',
          name: 'Ghost',
          kind: 'midi',
          channel: 1,
          instrument: { type: 'builtin', id: 'not.a.real.id' },
          notes: [{ pitch: 60, start: 0, duration: 1 }],
        },
      });
      const unknownError = structuredError(unknownBuiltin);
      expect(unknownError['code']).toBe('project.song.invalid');
      expect(Array.isArray(unknownError['issues'])).toBe(true);
      expect((unknownError['issues'] as unknown[]).length).toBeGreaterThan(0);

      const stale = await callTool(session, 'add_notes', {
        projectId: 'demo',
        expectedRevision: 999,
        trackId: 'keys',
        notes: [{ pitch: 60, start: 4, duration: 1 }],
      });
      const staleError = structuredError(stale);
      expect(staleError['code']).toBe('project.revision.conflict');
      expect(staleError['expectedRevision']).toBe(999);
      expect(staleError['actualRevision']).toBe(1);

      const duplicateTrack = await callTool(session, 'add_track', {
        projectId: 'demo',
        expectedRevision: 1,
        track: { ...bassTrack(), id: 'keys' },
      });
      expect(structuredError(duplicateTrack)['code']).toBe('project.edit.duplicate_track');

      const missingTrack = await callTool(session, 'add_notes', {
        projectId: 'demo',
        expectedRevision: 1,
        trackId: 'does-not-exist',
        notes: [{ pitch: 60, start: 0, duration: 1 }],
      });
      expect(structuredError(missingTrack)['code']).toBe('project.edit.track_not_found');

      const missingProject = await callTool(session, 'get_song', { projectId: 'absent' });
      expect(structuredError(missingProject)['code']).toBe('project.not_found');

      const badInput = await callTool(session, 'create_song', {
        projectId: 'demo',
        song: minimalSong(),
        unexpected: 'value',
      });
      expect(badInput.isError).toBe(true);
      expect(textContent(badInput)).toContain('Input validation error');

      // Every rejected edit left the only valid project untouched at revision 1.
      expect(await currentRevision(session, 'demo')).toBe(1);
    } finally {
      await session.close();
    }
  });

  it('returns structured errors to a conforming client that called tools/list first', async () => {
    // Regression: the official SDK client validates structuredContent against a
    // tool's outputSchema even on error results. A tools-first client must not
    // throw when an edit is rejected, so tool errors carry their payload in text
    // content, never in structuredContent.
    const root = tempDirectory('vamp-mcp-listfirst-');
    const session = await connectSession(['--project-root', root], deterministicEnvironment);
    try {
      await session.client.listTools();
      await callTool(session, 'create_song', { projectId: 'demo', song: minimalSong() });

      const stale = await callTool(session, 'add_notes', {
        projectId: 'demo',
        expectedRevision: 999,
        trackId: 'keys',
        notes: [{ pitch: 60, start: 4, duration: 1 }],
      });
      expect(stale.isError).toBe(true);
      expect(stale.structuredContent).toBeUndefined();
      expect(structuredError(stale)['code']).toBe('project.revision.conflict');

      const guide = await callTool(session, 'get_schema_guide', {});
      expect(guide.isError).not.toBe(true);
      expect(structuredContent(guide)['schemaVersion']).toBeDefined();

      expect(await currentRevision(session, 'demo')).toBe(1);
    } finally {
      await session.close();
    }
  });

  it('rejects oversized requests, traversal, and symlink asset escapes without crashing or writing', async () => {
    const root = tempDirectory('vamp-mcp-author-');
    const session = await connectSession(['--project-root', root], deterministicEnvironment);
    try {
      await callTool(session, 'create_song', { projectId: 'demo', song: minimalSong() });

      const oversized = await callTool(session, 'update_song', {
        projectId: 'demo',
        expectedRevision: 1,
        song: {
          ...minimalSong(),
          tracks: [
            {
              id: 'keys',
              name: 'Keys',
              kind: 'midi',
              channel: 0,
              instrument: { type: 'builtin', id: 'keys.soft' },
              notes: Array.from({ length: 6000 }, (_, index) => ({
                pitch: 48 + (index % 24),
                start: index % 8,
                duration: 1,
              })),
            },
          ],
        },
      });
      expect(oversized.isError).toBe(true);
      expect(textContent(oversized)).toMatch(/maximum|elements/i);

      const traversal = await callTool(session, 'update_song', {
        projectId: 'demo',
        expectedRevision: 1,
        song: {
          ...minimalSong(),
          tracks: [
            {
              id: 'keys',
              name: 'Keys',
              kind: 'midi',
              channel: 0,
              instrument: { type: 'soundfont', path: 'assets/../../outside.sf2', program: 0 },
              notes: [{ pitch: 60, start: 0, duration: 1 }],
            },
          ],
        },
      });
      const traversalCode = structuredError(traversal)['code'] as string;
      expect(['project.song.invalid', 'project.path.confined']).toContain(traversalCode);

      const outsideTarget = join(root, 'outside-target.sf2');
      writeFileSync(outsideTarget, 'RIFF-outside-not-a-real-soundfont', 'utf8');
      symlinkSync(outsideTarget, join(root, 'demo', 'assets', 'escape.sf2'));
      const symlinkEscape = await callTool(session, 'set_instrument', {
        projectId: 'demo',
        expectedRevision: 1,
        trackId: 'keys',
        instrument: { type: 'soundfont', path: 'assets/escape.sf2', program: 0 },
      });
      expect(structuredError(symlinkEscape)['code']).toBe('project.path.confined');

      // The server survived every rejection and the project is still intact at revision 1.
      expect(await currentRevision(session, 'demo')).toBe(1);
      const health = await callTool(session, 'health_check');
      expect(health.isError).not.toBe(true);
    } finally {
      await session.close();
    }
  });

  it('requires a configured project root and returns an actionable structured error', async () => {
    const session = await connectSession([], deterministicEnvironment);
    const calls: readonly { readonly name: string; readonly args: Record<string, unknown> }[] = [
      { name: 'create_song', args: { projectId: 'demo', song: minimalSong() } },
      { name: 'get_song', args: { projectId: 'demo' } },
      { name: 'list_projects', args: {} },
      {
        name: 'update_song',
        args: { projectId: 'demo', expectedRevision: 1, song: minimalSong() },
      },
      {
        name: 'add_track',
        args: { projectId: 'demo', expectedRevision: 1, track: bassTrack() },
      },
      {
        name: 'add_notes',
        args: {
          projectId: 'demo',
          expectedRevision: 1,
          trackId: 'keys',
          notes: [{ pitch: 60, start: 0, duration: 1 }],
        },
      },
      {
        name: 'set_pattern',
        args: {
          projectId: 'demo',
          expectedRevision: 1,
          pattern: { id: 'loop', notes: [{ pitch: 60, start: 0, duration: 1 }] },
        },
      },
      {
        name: 'set_instrument',
        args: {
          projectId: 'demo',
          expectedRevision: 1,
          trackId: 'keys',
          instrument: { type: 'builtin', id: 'piano.soft' },
        },
      },
    ];
    try {
      for (const call of calls) {
        const result = await callTool(session, call.name, call.args);
        expect(result.isError).toBe(true);
        const error = structuredError(result);
        expect(error['code']).toBe('mcp.project_root.not_configured');
        expect(error['hint']).toContain('VAMP_PROJECT_ROOT');
      }
      // validate_song still works without a root because it writes nothing.
      const validate = await callTool(session, 'validate_song', { song: minimalSong() });
      expect(validate.isError).not.toBe(true);
      expect(structuredContent(validate)['valid']).toBe(true);
    } finally {
      await session.close();
    }
  });
});

interface RawServer {
  readonly child: ChildProcessWithoutNullStreams;
  readonly lines: string[];
  readonly messages: Record<string, unknown>[];
  readonly request: (
    method: string,
    params?: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  readonly notify: (method: string) => void;
  readonly stderr: () => string;
  readonly waitForExit: () => Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  readonly stop: () => void;
}

function spawnRaw(
  args: readonly string[],
  environment: Readonly<Record<string, string>>,
): RawServer {
  const child = spawn(process.execPath, [serverEntry, ...args], {
    cwd: tempDirectory('vamp-mcp-raw-'),
    env: { ...environment },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines: string[] = [];
  const messages: Record<string, unknown>[] = [];
  const pending = new Map<number, (message: Record<string, unknown>) => void>();
  const stderrChunks: Buffer[] = [];
  child.stderr.on('data', (chunk: Buffer | string) => {
    stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
  reader.on('line', (line) => {
    lines.push(line);
    const parsed: unknown = JSON.parse(line);
    expect(typeof parsed).toBe('object');
    expect(parsed).not.toBeNull();
    const message = parsed as Record<string, unknown>;
    messages.push(message);
    if (typeof message['id'] === 'number') {
      const resolve = pending.get(message['id']);
      if (resolve !== undefined) {
        pending.delete(message['id']);
        resolve(message);
      }
    }
  });

  let nextId = 1;
  const request = (
    method: string,
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const id = nextId;
    nextId += 1;
    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timed out waiting for ${method}`));
      }, 10_000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return response;
  };

  const notify = (method: string): void => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  };

  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
    },
  );

  return {
    child,
    lines,
    messages,
    request,
    notify,
    stderr: () => Buffer.concat(stderrChunks).toString('utf8'),
    waitForExit: () => exitPromise,
    stop: () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    },
  };
}

async function initializeRaw(server: RawServer): Promise<void> {
  const response = await server.request('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'vamp-raw-test', version: '1.0.0' },
  });
  const result = response['result'] as Record<string, unknown>;
  expect(result['serverInfo']).toMatchObject({ name: 'vamp-mcp-server' });
  expect(result['capabilities']).toMatchObject({ tools: expect.any(Object) });
  server.notify('notifications/initialized');
}

describe('Vamp MCP protocol safety and process lifecycle', () => {
  it('keeps stdout byte-clean JSON-RPC while all diagnostics go to stderr', async () => {
    const server = spawnRaw([], {
      ...deterministicEnvironment,
    });
    try {
      await initializeRaw(server);
      const tools = await server.request('tools/list');
      expect(tools['result']).toMatchObject({ tools: expect.any(Array) });
      const health = await server.request('tools/call', { name: 'health_check', arguments: {} });
      expect((health['result'] as Record<string, unknown>)['isError']).not.toBe(true);
      const guide = await server.request('tools/call', { name: 'get_schema_guide', arguments: {} });
      expect((guide['result'] as Record<string, unknown>)['isError']).not.toBe(true);
      const instruments = await server.request('tools/call', {
        name: 'list_instruments',
        arguments: {},
      });
      expect((instruments['result'] as Record<string, unknown>)['isError']).not.toBe(true);
      const invalid = await server.request('tools/call', {
        name: 'health_check',
        arguments: { unexpected: true },
      });
      expect((invalid['result'] as Record<string, unknown>)['isError']).toBe(true);

      server.child.stdin.end();
      const exit = await server.waitForExit();
      expect(exit).toEqual({ code: 0, signal: null });

      expect(server.lines.length).toBeGreaterThan(0);
      for (const line of server.lines) {
        const parsed: unknown = JSON.parse(line);
        expect(typeof parsed).toBe('object');
        expect(parsed).not.toBeNull();
        const message = parsed as Record<string, unknown>;
        expect(message['jsonrpc']).toBe('2.0');
        const hasId = typeof message['id'] === 'number';
        const hasMethod = typeof message['method'] === 'string';
        expect(hasId || hasMethod).toBe(true);
      }
      const stderr = server.stderr();
      expect(stderr).toContain('vamp-mcp: ready');
      expect(stderr).toContain('shutting down (stdin closed)');
      expect(stderr).not.toContain(SECRET_VALUE);
      expect(server.lines.join('\n')).not.toContain('vamp-mcp: ready');
    } finally {
      server.stop();
    }
  });

  it('shuts down with exit code 0 on SIGTERM and SIGINT', async () => {
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      const server = spawnRaw([], deterministicEnvironment);
      try {
        await initializeRaw(server);
        server.child.kill(signal);
        const exit = await server.waitForExit();
        expect(exit).toEqual({ code: 0, signal: null });
        expect(server.stderr()).toContain(`shutting down (${signal})`);
      } finally {
        server.stop();
      }
    }
  });

  it('starts from the checked-in launcher without publishing', async () => {
    const child = spawn(process.execPath, [launcher, '--version'], {
      cwd: tempDirectory('vamp-mcp-launcher-'),
      env: { ...deterministicEnvironment },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    const code = await new Promise<number | null>((resolve) => {
      child.once('exit', (exitCode) => resolve(exitCode));
    });
    expect(code).toBe(0);
    expect(Buffer.concat(stdout).toString('utf8')).toBe('vamp-mcp-server 0.1.0\n');
    expect(Buffer.concat(stderr).toString('utf8')).toBe('');
  });
});

describe('MCP instrument and preset discovery', () => {
  it('exposes the named GM catalog, drum map, and BGM preset packs', async () => {
    const session = await connectSession([], deterministicEnvironment);
    try {
      const instruments = await callTool(session, 'list_instruments');
      expect(instruments.isError).not.toBe(true);
      const data = structuredContent(instruments) as {
        instruments: Array<{ id: string }>;
        gmCatalog: Array<{ id: string; program: number; songInstrument: unknown }>;
        drumKit: { noteMap: Record<string, number>; notes: unknown[] };
      };
      expect(data.instruments.map((instrument) => instrument.id)).toEqual([
        'piano.soft',
        'keys.soft',
        'bass.sub',
        'pad.warm',
        'guitar.clean',
        'drums.kit',
      ]);
      expect(data.gmCatalog.length).toBeGreaterThanOrEqual(50);
      expect(data.gmCatalog.find((preset) => preset.id === 'gm.keys.ep-tine')).toMatchObject({
        program: 4,
        songInstrument: { type: 'gm', program: 4, bank: 0 },
      });
      expect(data.drumKit.noteMap).toMatchObject({ kick: 36, snare: 38, hatClosed: 42 });
      expect(data.drumKit.notes.length).toBe(47);

      const presets = await callTool(session, 'list_presets');
      expect(presets.isError).not.toBe(true);
      const presetData = structuredContent(presets) as {
        presets: Array<{ id: string; instruments: unknown[]; groove: string }>;
      };
      expect(presetData.presets.map((preset) => preset.id)).toEqual([
        'lofi',
        'tutorial_upbeat',
        'ambient_focus',
        'corporate_clean',
        'stinger',
      ]);
      for (const preset of presetData.presets) {
        expect(preset.instruments.length).toBeGreaterThanOrEqual(3);
        expect(preset.groove.length).toBeGreaterThan(10);
      }
    } finally {
      await session.close();
    }
  });
});
