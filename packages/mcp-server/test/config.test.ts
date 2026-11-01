import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { MCP_JOB_SETTINGS, parseMcpServerConfig, type McpServerConfig } from '../src/config.js';
import { buildHealthReport } from '../src/health.js';

const temporaryDirectories: string[] = [];

function tempDirectory(prefix = 'vamp-mcp-config-'): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterAll(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function runConfig(
  args: readonly string[],
  env: Record<string, string | undefined> = {},
): McpServerConfig {
  const parsed = parseMcpServerConfig(args, env);
  expect(parsed).toMatchObject({ ok: true, action: 'run' });
  if (!parsed.ok || parsed.action !== 'run') {
    throw new Error('expected a runnable configuration');
  }
  return parsed.config;
}

describe('MCP server configuration', () => {
  it('reports help and version without requiring configuration', () => {
    expect(parseMcpServerConfig(['--help'], {})).toEqual({ ok: true, action: 'help' });
    expect(parseMcpServerConfig(['-v'], {})).toEqual({ ok: true, action: 'version' });
  });

  it('accepts project root and native dependency paths from arguments', () => {
    const config = runConfig([
      '--project-root',
      '/tmp/vamp-projects',
      '--fluidsynth-path=/opt/bin/fluidsynth',
      '--soundfont',
      '/sounds/FluidR3_GM.sf2',
    ]);
    expect(config.projectRoot).toEqual({ path: '/tmp/vamp-projects', source: 'argument' });
    expect(config.fluidSynth).toEqual({
      binaryPath: '/opt/bin/fluidsynth',
      binarySource: 'argument',
      soundFontPath: '/sounds/FluidR3_GM.sf2',
      soundFontSource: 'argument',
    });
    expect(config.jobs).toEqual(MCP_JOB_SETTINGS.defaults);
  });

  it('falls back to environment values and gives arguments precedence', () => {
    const environment = {
      VAMP_PROJECT_ROOT: '/env/projects',
      VAMP_FLUIDSYNTH_PATH: '/env/fluidsynth',
      VAMP_SOUNDFONT_PATH: '/env/sound.sf2',
    };
    const fromEnvironment = runConfig([], environment);
    expect(fromEnvironment.projectRoot).toEqual({ path: '/env/projects', source: 'environment' });
    expect(fromEnvironment.fluidSynth.binaryPath).toBe('/env/fluidsynth');
    expect(fromEnvironment.fluidSynth.soundFontPath).toBe('/env/sound.sf2');

    const mixed = runConfig(['--project-root', '/arg/projects'], environment);
    expect(mixed.projectRoot).toEqual({ path: '/arg/projects', source: 'argument' });
    expect(mixed.fluidSynth.binaryPath).toBe('/env/fluidsynth');
  });

  it('starts without a configured project root', () => {
    const config = runConfig([], {});
    expect(config.projectRoot).toEqual({ path: null, source: 'none' });
    expect(config.fluidSynth.binaryPath).toBe('fluidsynth');
    expect(config.fluidSynth.binarySource).toBe('default');
    expect(config.fluidSynth.soundFontPath).toBeNull();
  });

  it('bounds job settings and records invalid environment numbers as warnings', () => {
    const environmentOnly = runConfig([], {
      VAMP_MCP_MAX_CONCURRENT_RENDERS: '99',
      VAMP_MCP_MAX_PENDING_JOBS: 'not-a-number',
      VAMP_MCP_RENDER_TIMEOUT_MS: '5000',
    });
    expect(environmentOnly.jobs).toEqual(MCP_JOB_SETTINGS.defaults);
    expect(environmentOnly.warnings).toHaveLength(3);
    expect(
      environmentOnly.warnings.some((warning) =>
        warning.includes('VAMP_MCP_MAX_CONCURRENT_RENDERS'),
      ),
    ).toBe(true);
    expect(
      environmentOnly.warnings.some((warning) => warning.includes('VAMP_MCP_MAX_PENDING_JOBS')),
    ).toBe(true);
    expect(
      environmentOnly.warnings.some((warning) => warning.includes('VAMP_MCP_RENDER_TIMEOUT_MS')),
    ).toBe(true);

    const explicitArguments = runConfig(
      ['--max-concurrent-renders', '2', '--max-pending-jobs', '0', '--render-timeout-ms', '30000'],
      {
        VAMP_MCP_MAX_CONCURRENT_RENDERS: '3',
        VAMP_MCP_MAX_PENDING_JOBS: '2',
        VAMP_MCP_RENDER_TIMEOUT_MS: '60000',
      },
    );
    expect(explicitArguments.jobs).toEqual({
      ...MCP_JOB_SETTINGS.defaults,
      maxConcurrentRenders: 2,
      maxPendingJobs: 0,
      renderTimeoutMs: 30_000,
    });
    expect(explicitArguments.warnings).toEqual([]);
  });

  it('rejects invalid command-line values as usage errors', () => {
    expect(parseMcpServerConfig(['--max-concurrent-renders', '0'], {})).toMatchObject({
      ok: false,
      code: 'mcp.usage.invalid_value',
    });
    expect(parseMcpServerConfig(['--unknown'], {})).toMatchObject({
      ok: false,
      code: 'mcp.usage.unknown_option',
    });
    expect(parseMcpServerConfig(['--project-root'], {})).toMatchObject({
      ok: false,
      code: 'mcp.usage.missing_value',
    });
    expect(parseMcpServerConfig(['positional'], {})).toMatchObject({
      ok: false,
      code: 'mcp.usage.unexpected_argument',
    });
  });

  it('reports a missing configured project root without failing health', async () => {
    const missing = join(tempDirectory(), 'does-not-exist');
    const config = runConfig(['--project-root', missing], {
      VAMP_FLUIDSYNTH_PATH: '/definitely/missing/fluidsynth',
      VAMP_SOUNDFONT_PATH: '/definitely/missing/FluidR3_GM.sf2',
    });
    const report = await buildHealthReport(config);
    expect(report.builtInRendering.status).toBe('usable');
    expect(report.status).toBe('ok');
    expect(report.projectRoot).toMatchObject({
      configured: true,
      status: 'missing',
      code: 'project.root.not_found',
      path: missing,
      projectCount: null,
    });
    expect(report.sampleBackend).toMatchObject({
      status: 'unavailable',
      optional: true,
      missingDependencies: ['executable', 'soundfont'],
    });
  });

  it('reports a relative project root as invalid through @gxaditya/vamp-project', async () => {
    const config = runConfig(['--project-root', 'relative/projects'], {
      VAMP_FLUIDSYNTH_PATH: '/definitely/missing/fluidsynth',
      VAMP_SOUNDFONT_PATH: '/definitely/missing/FluidR3_GM.sf2',
    });
    const report = await buildHealthReport(config);
    expect(report.projectRoot).toMatchObject({
      configured: true,
      status: 'invalid',
      code: 'project.root.invalid',
    });
  });

  it('reports only the missing executable when a SoundFont file exists', async () => {
    const soundFont = join(tempDirectory(), 'present.sf2');
    const header = Buffer.alloc(24);
    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(16, 4);
    header.write('sfbk', 8, 'ascii');
    writeFileSync(soundFont, header);
    const config = runConfig(
      [
        '--project-root',
        tempDirectory(),
        '--fluidsynth-path',
        '/definitely/missing/fluidsynth',
        '--soundfont',
        soundFont,
      ],
      {},
    );
    const report = await buildHealthReport(config);
    expect(report.sampleBackend).toMatchObject({
      status: 'unavailable',
      missingDependencies: ['executable'],
      executable: { available: false, status: 'missing', version: null },
      soundFont: {
        configured: true,
        path: soundFont,
        available: true,
        status: 'available',
        bytes: expect.any(Number),
      },
    });
    expect(report.builtInRendering.status).toBe('usable');
    expect(report.status).toBe('ok');
  });

  it('reports a usable empty project root and its project count', async () => {
    const root = tempDirectory();
    mkdirSync(join(root, 'assets'), { recursive: true });
    const config = runConfig(['--project-root', root], {
      VAMP_FLUIDSYNTH_PATH: '/definitely/missing/fluidsynth',
      VAMP_SOUNDFONT_PATH: '/definitely/missing/FluidR3_GM.sf2',
    });
    const report = await buildHealthReport(config);
    expect(report.projectRoot).toMatchObject({
      configured: true,
      status: 'valid',
      path: root,
      projectCount: 0,
      code: null,
    });
  });
});
