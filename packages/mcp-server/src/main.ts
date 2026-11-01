#!/usr/bin/env node
/**
 * Vamp MCP server executable entrypoint.
 *
 * Stdout is reserved for MCP JSON-RPC traffic. Every log line, warning,
 * configuration observation, and unexpected-error report goes to stderr.
 *
 * Lifecycle: the transport starts after configuration and tool registration.
 * SIGINT, SIGTERM, stdin end, and transport close all run one guarded shutdown
 * path, which first aborts active render jobs so the engine cleans up native
 * children and job output. No native dependency is probed during startup, so the
 * server starts even when FluidSynth or a SoundFont is absent.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { MCP_HELP, SERVER_NAME, parseMcpServerConfig, readPackageVersion } from './config.js';
import { RenderJobQueue } from './render-jobs.js';
import { createVampMcpServer } from './server.js';

const MAX_STDIN_MESSAGE_BYTES = 4 * 1024 * 1024;

/**
 * How long shutdown waits for aborted renders to unwind so the engine can remove
 * job output and stop native children. An in-flight native backend call finishes
 * first; after this bound the force timer ends the process.
 */
const RENDER_SETTLE_DEADLINE_MS = 1500;

function writeStderr(message: string): void {
  process.stderr.write(`${message}\n`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const parsed = parseMcpServerConfig(process.argv.slice(2));

if (!parsed.ok) {
  writeStderr(`vamp-mcp: ${parsed.message}`);
  writeStderr(`Hint: ${parsed.hint}`);
  process.exitCode = 2;
} else if (parsed.action === 'help') {
  process.stdout.write(MCP_HELP);
} else if (parsed.action === 'version') {
  process.stdout.write(`${SERVER_NAME} ${readPackageVersion()}\n`);
} else if (parsed.action === 'run') {
  const config = parsed.config;
  for (const warning of config.warnings) {
    writeStderr(`vamp-mcp: configuration warning: ${warning}`);
  }
  writeStderr(
    `vamp-mcp: starting ${config.serverName} ${config.serverVersion} on stdio (project root ${
      config.projectRoot.path === null ? 'not configured' : 'configured'
    })`,
  );

  const renderJobs = new RenderJobQueue(config.jobs);
  const server = createVampMcpServer(config, { renderJobs });
  const transport = new StdioServerTransport(process.stdin, process.stdout, {
    maxBufferSize: MAX_STDIN_MESSAGE_BYTES,
  });

  let shuttingDown = false;

  async function shutdown(reason: string, exitCode: number): Promise<void> {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    writeStderr(`vamp-mcp: shutting down (${reason})`);
    // The force timer is unref'd so a successful close exits promptly.
    setTimeout(() => process.exit(exitCode), 2000).unref();

    // Abort active and queued renders first so the engine can remove job output
    // directories and stop native children at its next boundary, then give the
    // unwinding renders a bounded window. An in-flight native backend call
    // finishes before that cleanup, so the window can expire; the force timer
    // above is the last backstop.
    const activeRenders = renderJobs.activeCount + renderJobs.waitingCount;
    if (activeRenders > 0) {
      writeStderr(`vamp-mcp: aborting ${activeRenders} render job(s) before shutdown`);
    }
    renderJobs.abortAll();
    await renderJobs.settleActive(RENDER_SETTLE_DEADLINE_MS);

    try {
      await server.close();
    } catch (error) {
      writeStderr(`vamp-mcp: shutdown error: ${errorMessage(error)}`);
      process.exit(1);
    }
    process.exit(exitCode);
  }

  transport.onerror = (error) => {
    writeStderr(`vamp-mcp: transport error: ${error.message}`);
  };
  server.server.onclose = () => {
    void shutdown('transport closed', 0);
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT', 0);
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM', 0);
  });
  process.stdin.once('end', () => {
    void shutdown('stdin closed', 0);
  });
  process.stdin.once('close', () => {
    void shutdown('stdin closed', 0);
  });
  process.on('uncaughtException', (error) => {
    writeStderr(`vamp-mcp: uncaught exception: ${error.stack ?? error.message}`);
    void shutdown('uncaught exception', 1);
  });
  process.on('unhandledRejection', (reason) => {
    writeStderr(`vamp-mcp: unhandled rejection: ${errorMessage(reason)}`);
    void shutdown('unhandled rejection', 1);
  });

  try {
    await server.connect(transport);
    writeStderr('vamp-mcp: ready');
  } catch (error) {
    writeStderr(`vamp-mcp: failed to start: ${errorMessage(error)}`);
    await shutdown('startup failure', 1);
  }
}
