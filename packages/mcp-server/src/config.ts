/**
 * MCP server configuration.
 *
 * The server reads an optional absolute project root and optional native
 * backend paths from command-line arguments or environment variables. Arguments
 * take precedence over environment variables, which take precedence over
 * defaults. A missing or invalid project root is deliberately not fatal: the
 * discovery tools must remain available so an agent can diagnose setup through
 * `health_check`.
 *
 * All values are bounded. Invalid numeric environment values fall back to the
 * default and become health-check warnings; invalid command-line values are
 * usage errors because the connection itself is misconfigured.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const SERVER_NAME = 'vamp-mcp-server' as const;

export const PROJECT_ROOT_ENV = 'VAMP_PROJECT_ROOT' as const;
export const FLUIDSYNTH_PATH_ENV = 'VAMP_FLUIDSYNTH_PATH' as const;
export const SOUNDFONT_PATH_ENV = 'VAMP_SOUNDFONT_PATH' as const;
export const MAX_CONCURRENT_RENDERS_ENV = 'VAMP_MCP_MAX_CONCURRENT_RENDERS' as const;
export const MAX_PENDING_JOBS_ENV = 'VAMP_MCP_MAX_PENDING_JOBS' as const;
export const RENDER_TIMEOUT_MS_ENV = 'VAMP_MCP_RENDER_TIMEOUT_MS' as const;

/** Default FluidSynth lookup name, matching the CLI and engine defaults. */
export const DEFAULT_FLUIDSYNTH_PATH = 'fluidsynth' as const;

/** Bounded job settings for the render tools added after Task 13. */
export interface McpJobSettings {
  /** Maximum renders that may execute at once. */
  readonly maxConcurrentRenders: number;
  /** Maximum queued renders beyond the executing set. */
  readonly maxPendingJobs: number;
  /** Wall-clock timeout for one render job in milliseconds. */
  readonly renderTimeoutMs: number;
  /** Maximum combined array and object members accepted in one tool call. */
  readonly maxToolInputElements: number;
}

export const MCP_JOB_SETTINGS = Object.freeze({
  defaults: Object.freeze({
    maxConcurrentRenders: 1,
    maxPendingJobs: 4,
    renderTimeoutMs: 120_000,
    maxToolInputElements: 20_000,
  } satisfies McpJobSettings),
  bounds: Object.freeze({
    maxConcurrentRenders: Object.freeze({ minimum: 1, maximum: 4 }),
    maxPendingJobs: Object.freeze({ minimum: 0, maximum: 16 }),
    renderTimeoutMs: Object.freeze({ minimum: 10_000, maximum: 600_000 }),
  }),
});

export type ConfigurationSource = 'argument' | 'environment';

export interface ProjectRootConfiguration {
  /** Absolute configured root, or null when the server has no project root. */
  readonly path: string | null;
  readonly source: ConfigurationSource | 'none';
}

export interface FluidSynthConfiguration {
  /** Executable name or path. Defaults to `fluidsynth` resolved through PATH. */
  readonly binaryPath: string;
  /** Where the executable value came from. */
  readonly binarySource: ConfigurationSource | 'default';
  /** Configured trusted GM SoundFont, or null. */
  readonly soundFontPath: string | null;
  readonly soundFontSource: ConfigurationSource | 'none';
}

export interface McpServerConfig {
  readonly serverName: typeof SERVER_NAME;
  readonly serverVersion: string;
  readonly transport: 'stdio';
  readonly projectRoot: ProjectRootConfiguration;
  readonly fluidSynth: FluidSynthConfiguration;
  readonly jobs: McpJobSettings;
  /** Non-fatal configuration observations safe to expose through health_check. */
  readonly warnings: readonly string[];
}

export type ConfigParseResult =
  | { readonly ok: true; readonly action: 'run'; readonly config: McpServerConfig }
  | { readonly ok: true; readonly action: 'help' | 'version' }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly hint: string;
    };

export function readPackageVersion(): string {
  const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('version' in parsed) ||
    typeof parsed.version !== 'string' ||
    parsed.version.length === 0
  ) {
    throw new Error('MCP server package metadata does not contain a valid version.');
  }
  return parsed.version;
}

function optionalValue(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function parseBoundedInteger(
  raw: string,
  minimum: number,
  maximum: number,
): { readonly ok: true; readonly value: number } | { readonly ok: false; readonly reason: string } {
  if (!/^[0-9]+$/.test(raw)) {
    return { ok: false, reason: `must be an integer from ${minimum} to ${maximum}` };
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    return { ok: false, reason: `must be an integer from ${minimum} to ${maximum}` };
  }
  return { ok: true, value };
}

function environmentInteger(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
  warnings: string[],
): number {
  const raw = optionalValue(env[name]);
  if (raw === null) {
    return fallback;
  }
  const parsed = parseBoundedInteger(raw, minimum, maximum);
  if (!parsed.ok) {
    warnings.push(`${name} ${parsed.reason}; using ${fallback}.`);
    return fallback;
  }
  return parsed.value;
}

function argumentInteger(
  raw: string,
  name: string,
  minimum: number,
  maximum: number,
):
  { readonly ok: true; readonly value: number } | { readonly ok: false; readonly message: string } {
  const parsed = parseBoundedInteger(raw, minimum, maximum);
  if (!parsed.ok) {
    return { ok: false, message: `${name} ${parsed.reason}.` };
  }
  return parsed;
}

export const MCP_HELP = `Vamp MCP server

Usage: vamp-mcp [options]

Runs a local stdio MCP server for the Vamp music engine. Stdout carries MCP
protocol traffic only. Diagnostics and logs are written to stderr. The server
uses no network access and no model services.

Options:
  --project-root <dir>          Absolute projects root. Discovery tools work
                                without it; project and render tools require it.
                                Environment fallback: ${PROJECT_ROOT_ENV}.
  --fluidsynth-path <path>      Optional FluidSynth executable name or path.
                                Environment fallback: ${FLUIDSYNTH_PATH_ENV}.
  --soundfont <path>            Optional trusted General MIDI .sf2 SoundFont.
                                Environment fallback: ${SOUNDFONT_PATH_ENV}.
                                When omitted, a local font is auto-discovered;
                                nothing is downloaded.
  --max-concurrent-renders <n>  1 to 4 (default 1). Environment fallback:
                                ${MAX_CONCURRENT_RENDERS_ENV}.
  --max-pending-jobs <n>        0 to 16 (default 4). Environment fallback:
                                ${MAX_PENDING_JOBS_ENV}.
  --render-timeout-ms <n>       10000 to 600000 (default 120000). Environment
                                fallback: ${RENDER_TIMEOUT_MS_ENV}.
  -h, --help                    Show this help and exit.
  -v, --version                 Show the server version and exit.

Tools:
  health_check        Diagnose rendering, dependencies, schema, and project root.
  get_schema_guide    Return the authoritative SongSchemaV1 authoring guide.
  list_instruments    List curated IDs, the named GM catalog, and the drum map.
  list_presets        List curated BGM recipe packs.
  validate_song       Validate unsaved song data without writing a project.
  create_song         Create a project from a song or a BGM preset.
  get_song            Read one project and its current revision.
  list_projects       List projects and revisions in the configured root.
  update_song         Replace a whole song at an expected revision.
  add_track           Append or insert one track by stable id.
  add_notes           Append or insert free notes on a track by position.
  set_pattern         Create or replace one pattern by stable id.
  set_instrument      Replace one track instrument.
  render_song         Render a saved revision into the project renders/ tree.

Lifecycle:
  The server shuts down cleanly on SIGINT, SIGTERM, stdin close, or transport
  close. render_song runs inside the bounded job settings above: concurrent
  renders are capped, extra calls queue up to the pending limit, and a render
  past the deadline is aborted with a timeout error. Shutdown aborts active
  render jobs so native children and job output are cleaned up. Native
  FluidSynth is optional; built-in rendering works without it.

Run "pnpm build" from the repository root before starting the built server.
`;

interface MutableConfig {
  projectRootPath: string | null;
  projectRootSource: ConfigurationSource | 'none';
  fluidSynthPath: string;
  fluidSynthSource: ConfigurationSource | 'default';
  soundFontPath: string | null;
  soundFontSource: ConfigurationSource | 'none';
  jobs: {
    maxConcurrentRenders: number;
    maxPendingJobs: number;
    renderTimeoutMs: number;
  };
  jobsFromArguments: {
    maxConcurrentRenders: boolean;
    maxPendingJobs: boolean;
    renderTimeoutMs: boolean;
  };
  help: boolean;
  version: boolean;
}

type OptionResult = {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly hint: string;
};

function readOptionValue(
  args: readonly string[],
  index: number,
  option: string,
  inlineValue: string | undefined,
): { readonly ok: true; readonly value: string; readonly nextIndex: number } | OptionResult {
  if (inlineValue !== undefined) {
    if (inlineValue.length === 0) {
      return {
        ok: false,
        code: 'mcp.usage.missing_value',
        message: `Option ${option} requires a value.`,
        hint: 'Run "vamp-mcp --help" for usage.',
      };
    }
    return { ok: true, value: inlineValue, nextIndex: index };
  }
  const next = args[index + 1];
  if (next === undefined || next.startsWith('-')) {
    return {
      ok: false,
      code: 'mcp.usage.missing_value',
      message: `Option ${option} requires a value.`,
      hint: 'Run "vamp-mcp --help" for usage.',
    };
  }
  return { ok: true, value: next, nextIndex: index + 1 };
}

function parseOptions(args: readonly string[]):
  | {
      readonly ok: true;
      readonly values: MutableConfig;
    }
  | OptionResult {
  const values: MutableConfig = {
    projectRootPath: null,
    projectRootSource: 'none',
    fluidSynthPath: DEFAULT_FLUIDSYNTH_PATH,
    fluidSynthSource: 'default',
    soundFontPath: null,
    soundFontSource: 'none',
    jobs: {
      maxConcurrentRenders: MCP_JOB_SETTINGS.defaults.maxConcurrentRenders,
      maxPendingJobs: MCP_JOB_SETTINGS.defaults.maxPendingJobs,
      renderTimeoutMs: MCP_JOB_SETTINGS.defaults.renderTimeoutMs,
    },
    jobsFromArguments: {
      maxConcurrentRenders: false,
      maxPendingJobs: false,
      renderTimeoutMs: false,
    },
    help: false,
    version: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] ?? '';
    const separator = token.indexOf('=');
    const option = token.startsWith('--') && separator > 0 ? token.slice(0, separator) : token;
    const inlineValue = option === token ? undefined : token.slice(separator + 1);

    switch (option) {
      case '--help':
      case '-h':
        values.help = true;
        break;
      case '--version':
      case '-v':
        values.version = true;
        break;
      case '--project-root': {
        const read = readOptionValue(args, index, option, inlineValue);
        if (!read.ok) {
          return read;
        }
        values.projectRootPath = read.value;
        values.projectRootSource = 'argument';
        index = read.nextIndex;
        break;
      }
      case '--fluidsynth-path': {
        const read = readOptionValue(args, index, option, inlineValue);
        if (!read.ok) {
          return read;
        }
        values.fluidSynthPath = read.value;
        values.fluidSynthSource = 'argument';
        index = read.nextIndex;
        break;
      }
      case '--soundfont': {
        const read = readOptionValue(args, index, option, inlineValue);
        if (!read.ok) {
          return read;
        }
        values.soundFontPath = read.value;
        values.soundFontSource = 'argument';
        index = read.nextIndex;
        break;
      }
      case '--max-concurrent-renders': {
        const read = readOptionValue(args, index, option, inlineValue);
        if (!read.ok) {
          return read;
        }
        const range = MCP_JOB_SETTINGS.bounds.maxConcurrentRenders;
        const parsed = argumentInteger(read.value, option, range.minimum, range.maximum);
        if (!parsed.ok) {
          return {
            ok: false,
            code: 'mcp.usage.invalid_value',
            message: parsed.message,
            hint: 'Run "vamp-mcp --help" for the bounded setting ranges.',
          };
        }
        values.jobs.maxConcurrentRenders = parsed.value;
        values.jobsFromArguments.maxConcurrentRenders = true;
        index = read.nextIndex;
        break;
      }
      case '--max-pending-jobs': {
        const read = readOptionValue(args, index, option, inlineValue);
        if (!read.ok) {
          return read;
        }
        const range = MCP_JOB_SETTINGS.bounds.maxPendingJobs;
        const parsed = argumentInteger(read.value, option, range.minimum, range.maximum);
        if (!parsed.ok) {
          return {
            ok: false,
            code: 'mcp.usage.invalid_value',
            message: parsed.message,
            hint: 'Run "vamp-mcp --help" for the bounded setting ranges.',
          };
        }
        values.jobs.maxPendingJobs = parsed.value;
        values.jobsFromArguments.maxPendingJobs = true;
        index = read.nextIndex;
        break;
      }
      case '--render-timeout-ms': {
        const read = readOptionValue(args, index, option, inlineValue);
        if (!read.ok) {
          return read;
        }
        const range = MCP_JOB_SETTINGS.bounds.renderTimeoutMs;
        const parsed = argumentInteger(read.value, option, range.minimum, range.maximum);
        if (!parsed.ok) {
          return {
            ok: false,
            code: 'mcp.usage.invalid_value',
            message: parsed.message,
            hint: 'Run "vamp-mcp --help" for the bounded setting ranges.',
          };
        }
        values.jobs.renderTimeoutMs = parsed.value;
        values.jobsFromArguments.renderTimeoutMs = true;
        index = read.nextIndex;
        break;
      }
      default: {
        const message = token.startsWith('-')
          ? `Unknown option "${token}".`
          : `Unexpected argument "${token}".`;
        return {
          ok: false,
          code: token.startsWith('-')
            ? 'mcp.usage.unknown_option'
            : 'mcp.usage.unexpected_argument',
          message,
          hint: 'Run "vamp-mcp --help" for usage.',
        };
      }
    }
  }

  return { ok: true, values };
}

/**
 * Resolve server configuration from arguments and environment.
 *
 * Command-line values always win. Environment values are validated and bounded;
 * a bad environment number becomes a warning instead of preventing startup.
 */
export function parseMcpServerConfig(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): ConfigParseResult {
  const parsed = parseOptions(args);
  if (!parsed.ok) {
    return parsed;
  }
  const values = parsed.values;
  if (values.help) {
    return { ok: true, action: 'help' };
  }
  if (values.version) {
    return { ok: true, action: 'version' };
  }

  const warnings: string[] = [];

  let projectRootPath = values.projectRootPath;
  let projectRootSource = values.projectRootSource;
  if (projectRootPath === null) {
    const fromEnvironment = optionalValue(env[PROJECT_ROOT_ENV]);
    if (fromEnvironment !== null) {
      projectRootPath = fromEnvironment;
      projectRootSource = 'environment';
    }
  }

  let fluidSynthPath = values.fluidSynthPath;
  let fluidSynthSource = values.fluidSynthSource;
  if (fluidSynthSource === 'default') {
    const fromEnvironment = optionalValue(env[FLUIDSYNTH_PATH_ENV]);
    if (fromEnvironment !== null) {
      fluidSynthPath = fromEnvironment;
      fluidSynthSource = 'environment';
    }
  }

  let soundFontPath = values.soundFontPath;
  let soundFontSource = values.soundFontSource;
  if (soundFontPath === null) {
    const fromEnvironment = optionalValue(env[SOUNDFONT_PATH_ENV]);
    if (fromEnvironment !== null) {
      soundFontPath = fromEnvironment;
      soundFontSource = 'environment';
    }
  }

  const jobs = {
    maxConcurrentRenders: values.jobsFromArguments.maxConcurrentRenders
      ? values.jobs.maxConcurrentRenders
      : environmentInteger(
          env,
          MAX_CONCURRENT_RENDERS_ENV,
          values.jobs.maxConcurrentRenders,
          MCP_JOB_SETTINGS.bounds.maxConcurrentRenders.minimum,
          MCP_JOB_SETTINGS.bounds.maxConcurrentRenders.maximum,
          warnings,
        ),
    maxPendingJobs: values.jobsFromArguments.maxPendingJobs
      ? values.jobs.maxPendingJobs
      : environmentInteger(
          env,
          MAX_PENDING_JOBS_ENV,
          values.jobs.maxPendingJobs,
          MCP_JOB_SETTINGS.bounds.maxPendingJobs.minimum,
          MCP_JOB_SETTINGS.bounds.maxPendingJobs.maximum,
          warnings,
        ),
    renderTimeoutMs: values.jobsFromArguments.renderTimeoutMs
      ? values.jobs.renderTimeoutMs
      : environmentInteger(
          env,
          RENDER_TIMEOUT_MS_ENV,
          values.jobs.renderTimeoutMs,
          MCP_JOB_SETTINGS.bounds.renderTimeoutMs.minimum,
          MCP_JOB_SETTINGS.bounds.renderTimeoutMs.maximum,
          warnings,
        ),
  };

  // A bare executable name stays on PATH. Path-like values are resolved against
  // the server process directory so stored configuration does not depend on a
  // temporary FluidSynth working directory. The project root is deliberately
  // left as provided because ProjectStore owns root validation.
  const absoluteBinary =
    fluidSynthPath.includes('/') || fluidSynthPath.includes('\\')
      ? resolve(process.cwd(), fluidSynthPath)
      : fluidSynthPath;
  const absoluteSoundFont = soundFontPath === null ? null : resolve(process.cwd(), soundFontPath);

  return {
    ok: true,
    action: 'run',
    config: {
      serverName: SERVER_NAME,
      serverVersion: readPackageVersion(),
      transport: 'stdio',
      projectRoot: { path: projectRootPath, source: projectRootSource },
      fluidSynth: {
        binaryPath: absoluteBinary,
        binarySource: fluidSynthSource,
        soundFontPath: absoluteSoundFont,
        soundFontSource,
      },
      jobs: {
        ...jobs,
        maxToolInputElements: MCP_JOB_SETTINGS.defaults.maxToolInputElements,
      },
      warnings,
    },
  };
}
