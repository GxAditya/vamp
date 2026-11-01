/**
 * Task 15 bounded render lifecycle tests.
 *
 * Two layers are covered here:
 *
 * - `RenderJobQueue` unit tests for concurrency, pending depth, busy and timeout
 *   rejections, request cancellation, and shutdown aborts;
 * - the `render_song` tool through the official MCP SDK `Client` with an
 *   in-memory transport and a deliberately slow fake render path, so busy,
 *   timeout, and shutdown behavior is observed without slowing the production
 *   engine, which always runs `renderSongArtifacts`.
 *
 * Everything is offline and confined to temporary directories.
 */

import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProjectStore } from '@gxaditya/vamp-project';
import {
  INSTRUMENT_REGISTRY_VALIDATION,
  renderSongArtifacts,
  type RenderSongArtifactsResult,
} from '@gxaditya/vamp-engine';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, describe, expect, it, vi } from 'vitest';

import {
  MCP_JOB_SETTINGS,
  parseMcpServerConfig,
  type McpJobSettings,
  type McpServerConfig,
} from '../src/config.js';
import { RenderJobQueue } from '../src/render-jobs.js';
import { createVampMcpServer } from '../src/server.js';
import type { ArtifactRenderer } from '../src/render-tools.js';

vi.setConfig({ testTimeout: 60_000 });

const temporaryDirectories: string[] = [];

function tempDirectory(prefix = 'vamp-render-jobs-'): string {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  temporaryDirectories.push(directory);
  return directory;
}

afterAll(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function song(): Record<string, unknown> {
  return {
    schemaVersion: '1.0.0',
    meta: {
      title: 'Lifecycle Loop',
      bpm: 90,
      timeSignature: { numerator: 4, denominator: 4 },
      key: { tonic: 'C', mode: 'major' },
      seed: 5,
      durationHint: 4,
    },
    tracks: [
      {
        id: 'keys',
        name: 'Keys',
        kind: 'midi',
        channel: 0,
        instrument: { type: 'builtin', id: 'keys.soft' },
        notes: [
          { pitch: 60, start: 0, duration: 1.5 },
          { pitch: 64, start: 2, duration: 1.5 },
        ],
      },
    ],
  };
}

function jobSettings(overrides: Partial<McpJobSettings> = {}): McpJobSettings {
  return { ...MCP_JOB_SETTINGS.defaults, ...overrides };
}

function serverConfig(root: string, overrides: Partial<McpJobSettings> = {}): McpServerConfig {
  const parsed = parseMcpServerConfig(['--project-root', root], {});
  if (parsed.ok !== true || parsed.action !== 'run') {
    throw new Error('test configuration must parse');
  }
  // The lifecycle tests need bounds far below the production minimum, so the
  // queue settings are overridden here rather than through the CLI parser.
  return { ...parsed.config, jobs: jobSettings(overrides) };
}

interface Gate {
  readonly wait: Promise<void>;
  readonly release: () => void;
  readonly signals: AbortSignal[];
}

function createGate(): Gate {
  const signals: AbortSignal[] = [];
  let release: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release, signals };
}

/**
 * Slow fake render path used only by these tests: it blocks on a gate, honours
 * the job signal, and then delegates to the real engine so the success shape is
 * the production one.
 */
function gatedRenderer(gate: Gate): ArtifactRenderer {
  return async (input, options) => {
    gate.signals.push(options.signal ?? new AbortController().signal);
    await Promise.race([
      gate.wait,
      new Promise<void>((resolve) => {
        if (options.signal?.aborted === true) {
          resolve();
          return;
        }
        options.signal?.addEventListener('abort', () => resolve(), { once: true });
      }),
    ]);
    if (options.signal?.aborted === true) {
      return {
        ok: false,
        stage: 'cancelled',
        errors: [
          {
            code: 'audio.cancelled',
            severity: 'error',
            path: '/outputDir',
            message: 'Artifact rendering was cancelled by the caller.',
            hint: 'No job artifacts were published.',
          },
        ],
        warnings: [],
      } satisfies RenderSongArtifactsResult;
    }
    return renderSongArtifacts(input, options);
  };
}

interface Harness {
  readonly client: Client;
  readonly server: ReturnType<typeof createVampMcpServer>;
  readonly queue: RenderJobQueue;
  readonly root: string;
  readonly stderr: string[];
  readonly call: (args: Record<string, unknown>) => Promise<CallToolResult>;
  readonly close: () => Promise<void>;
}

async function createHarness(
  overrides: Partial<McpJobSettings> = {},
  renderer?: ArtifactRenderer,
): Promise<Harness> {
  const root = tempDirectory();
  const store = new ProjectStore({ root, validation: INSTRUMENT_REGISTRY_VALIDATION });
  const created = await store.create({ projectId: 'lifecycle', song: song() });
  expect(created.ok).toBe(true);

  const stderr: string[] = [];
  const config = serverConfig(root, overrides);
  const queue = new RenderJobQueue(config.jobs);
  const server = createVampMcpServer(config, {
    renderJobs: queue,
    logger: (message) => stderr.push(message),
    ...(renderer === undefined ? {} : { renderer }),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'vamp-render-jobs-client', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    server,
    queue,
    root,
    stderr,
    call: async (args) =>
      (await client.callTool({ name: 'render_song', arguments: args })) as CallToolResult,
    close: async () => {
      await client.close();
    },
  };
}

function errorCode(result: CallToolResult): Record<string, unknown> {
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toBeUndefined();
  const item = result.content.find(
    (entry) => entry.type === 'text' && entry.text.trimStart().startsWith('{'),
  );
  if (item === undefined || item.type !== 'text') {
    throw new Error('expected JSON error text content');
  }
  return (JSON.parse(item.text) as Record<string, unknown>)['error'] as Record<string, unknown>;
}

describe('RenderJobQueue bounds', () => {
  it('runs at most maxConcurrentRenders jobs at once and completes every one', async () => {
    const queue = new RenderJobQueue(jobSettings({ maxConcurrentRenders: 2, maxPendingJobs: 8 }));
    let live = 0;
    let peak = 0;
    const runs = Array.from({ length: 6 }, (_value, index) =>
      queue.submit(async () => {
        live += 1;
        peak = Math.max(peak, live);
        await new Promise((resolve) => setTimeout(resolve, 10));
        live -= 1;
        return index;
      }),
    );
    const results = await Promise.all(runs);
    expect(peak).toBe(2);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(queue.activeCount).toBe(0);
    expect(queue.waitingCount).toBe(0);
  });

  it('rejects beyond the pending limit with busy and keeps queued work inside the bound', async () => {
    const queue = new RenderJobQueue(jobSettings({ maxConcurrentRenders: 1, maxPendingJobs: 1 }));
    const gate = createGate();
    const first = queue.submit(async () => {
      await gate.wait;
      return 'first';
    });
    const second = queue.submit(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return 'second';
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const third = await queue.submit(async () => 'third');
    expect(third.ok).toBe(false);
    if (!third.ok) {
      expect(third.rejection.status).toBe('busy');
    }
    gate.release();
    const firstResult = await first;
    const secondResult = await second;
    expect(firstResult.ok).toBe(true);
    expect(secondResult.ok).toBe(true);
    if (secondResult.ok) {
      expect(secondResult.value).toBe('second');
      expect(secondResult.queuedMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('reports a timeout distinctly and holds the slot until the aborted job unwinds', async () => {
    const queue = new RenderJobQueue(jobSettings({ maxConcurrentRenders: 1, renderTimeoutMs: 30 }));
    let released = false;
    const result = await queue.submit(async (signal) => {
      await new Promise<void>((resolve) => {
        const check = (): void => {
          if (signal.aborted || released) {
            resolve();
            return;
          }
          setTimeout(check, 5);
        };
        check();
      });
      return 'late';
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rejection.status).toBe('timeout');
    }
    // The slot is still occupied while the aborted render unwinds.
    expect(queue.activeCount).toBe(1);
    released = true;
    await queue.settleActive(1_000);
    expect(queue.activeCount).toBe(0);
  });

  it('cancels a waiting job when the request signal aborts', async () => {
    const queue = new RenderJobQueue(jobSettings({ maxConcurrentRenders: 1, maxPendingJobs: 4 }));
    const gate = createGate();
    const running = queue.submit(async () => {
      await gate.wait;
      return 'running';
    });
    const requestController = new AbortController();
    const waiting = queue.submit(async () => 'never', requestController.signal);
    await new Promise((resolve) => setTimeout(resolve, 5));
    requestController.abort();
    const waitingResult = await waiting;
    expect(waitingResult.ok).toBe(false);
    if (!waitingResult.ok) {
      expect(waitingResult.rejection.status).toBe('cancelled');
    }
    gate.release();
    expect((await running).ok).toBe(true);
  });

  it('aborts running and waiting jobs on shutdown and rejects new work', async () => {
    const queue = new RenderJobQueue(jobSettings({ maxConcurrentRenders: 1, maxPendingJobs: 4 }));
    const observed: boolean[] = [];
    const running = queue.submit(async (signal) => {
      await new Promise<void>((resolve) => {
        const check = (): void => {
          if (signal.aborted) {
            observed.push(true);
            resolve();
            return;
          }
          setTimeout(check, 5);
        };
        check();
      });
      return 'aborted';
    });
    const waiting = queue.submit(async () => 'never-starts');
    await new Promise((resolve) => setTimeout(resolve, 10));
    queue.abortAll();
    const [runningResult, waitingResult] = await Promise.all([running, waiting]);
    expect(runningResult.ok).toBe(false);
    expect(waitingResult.ok).toBe(false);
    if (!runningResult.ok) {
      expect(runningResult.rejection.status).toBe('cancelled');
    }
    if (!waitingResult.ok) {
      expect(waitingResult.rejection.status).toBe('closed');
    }
    expect(observed).toEqual([true]);
    const after = await queue.submit(async () => 'too late');
    expect(after.ok).toBe(false);
    if (!after.ok) {
      expect(after.rejection.status).toBe('closed');
    }
    await queue.settleActive(1_000);
    expect(queue.activeCount).toBe(0);
  });
});

describe('render_song bounded lifecycle through the SDK client', () => {
  it('returns render.busy while the concurrency bound is reached and succeeds after the slot frees', async () => {
    const gate = createGate();
    const harness = await createHarness(
      { maxConcurrentRenders: 1, maxPendingJobs: 0, renderTimeoutMs: 120_000 },
      gatedRenderer(gate),
    );
    try {
      const started = harness.call({ projectId: 'lifecycle', renderName: 'busy-first' });
      await new Promise((resolve) => setTimeout(resolve, 25));
      const busy = await harness.call({ projectId: 'lifecycle', renderName: 'busy-second' });
      const busyError = errorCode(busy);
      expect(busyError['code']).toBe('render.busy');
      expect(busyError['maxConcurrentRenders']).toBe(1);
      expect(existsSync(join(harness.root, 'lifecycle', 'renders', 'busy-second'))).toBe(false);

      gate.release();
      const first = await started;
      expect(first.isError).not.toBe(true);
      const data = first.structuredContent as Record<string, unknown>;
      expect(data['renderPath']).toBe('renders/busy-first');
      expect(existsSync(join(data['outputDirectory'] as string, 'master.wav'))).toBe(true);

      // The queue released its slot, so the next render runs normally.
      const after = await harness.call({ projectId: 'lifecycle', renderName: 'busy-third' });
      expect(after.isError).not.toBe(true);
    } finally {
      await harness.close();
    }
  });

  it('returns render.timeout for a render past the deadline without publishing partial output', async () => {
    const gate = createGate();
    const harness = await createHarness(
      { maxConcurrentRenders: 1, maxPendingJobs: 0, renderTimeoutMs: 30 },
      gatedRenderer(gate),
    );
    try {
      const timedOut = await harness.call({ projectId: 'lifecycle', renderName: 'slow' });
      const error = errorCode(timedOut);
      expect(error['code']).toBe('render.timeout');
      expect(error['timeoutMs']).toBe(30);
      const directory = join(harness.root, 'lifecycle', 'renders', 'slow');
      expect(existsSync(directory) ? existsSync(join(directory, 'master.wav')) : false).toBe(false);
      gate.release();
      await harness.queue.settleActive(2_000);
      expect(harness.queue.activeCount).toBe(0);
      // The stored project is untouched by the failed render.
      const read = await new ProjectStore({
        root: harness.root,
        validation: INSTRUMENT_REGISTRY_VALIDATION,
      }).get('lifecycle');
      expect(read.ok).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it('returns render.cancelled when shutdown aborts an active render', async () => {
    const gate = createGate();
    const harness = await createHarness(
      { maxConcurrentRenders: 1, maxPendingJobs: 2, renderTimeoutMs: 120_000 },
      gatedRenderer(gate),
    );
    try {
      const started = harness.call({ projectId: 'lifecycle', renderName: 'interrupted' });
      // Poll rather than sleeping a fixed interval: under load (e.g. Windows
      // CI runners) the job can take well over 25 ms to become active.
      const deadline = Date.now() + 10_000;
      while (harness.queue.activeCount === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(harness.queue.activeCount).toBe(1);
      expect(gate.signals.length).toBe(1);
      expect(gate.signals[0]?.aborted).toBe(false);

      // The executable shutdown path aborts jobs first, then waits briefly.
      harness.queue.abortAll();
      await harness.queue.settleActive(1_000);
      expect(gate.signals[0]?.aborted).toBe(true);
      const result = await started;
      const error = errorCode(result);
      expect(error['code']).toBe('render.cancelled');
      expect(error['hint']).toContain('partial artifacts');
      const directory = join(harness.root, 'lifecycle', 'renders', 'interrupted');
      expect(existsSync(directory) ? existsSync(join(directory, 'master.wav')) : false).toBe(false);
      expect(harness.queue.activeCount).toBe(0);
    } finally {
      gate.release();
      await harness.close();
    }
  });

  it('keeps the configured bounds visible through health_check', async () => {
    const harness = await createHarness({
      maxConcurrentRenders: 3,
      maxPendingJobs: 2,
      renderTimeoutMs: 15_000,
    });
    try {
      const health = (await harness.client.callTool({
        name: 'health_check',
        arguments: {},
      })) as CallToolResult;
      expect(health.structuredContent).toMatchObject({
        jobs: { maxConcurrentRenders: 3, maxPendingJobs: 2, renderTimeoutMs: 15_000 },
      });
      const tools = await harness.client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain('render_song');
    } finally {
      await harness.close();
    }
  });
});
