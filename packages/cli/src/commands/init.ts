/**
 * `vamp init`: create a playable minimal filesystem project.
 *
 * The command is a thin adapter over `ProjectStore`. It creates the configured
 * projects root when needed, delegates validation and collision-safe storage to
 * `@gxaditya/vamp-project`, and never deletes or rewrites an unrelated directory.
 */

import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  BGM_PRESETS,
  INSTRUMENT_REGISTRY_VALIDATION,
  createPresetSong,
  getBgmPreset,
} from '@gxaditya/vamp-engine';
import { ProjectStore, type ProjectError } from '@gxaditya/vamp-project';
import type { ValidationIssue } from '@gxaditya/vamp-schema';

import { getStringOption, hasFlag, parseArgs, type CliOptionSpec } from '../args.js';
import { commandHelp } from '../help.js';
import {
  failure,
  formatError,
  success,
  usageFailure,
  type CliError,
  type CommandOutcome,
  type StructuredValue,
} from '../output.js';
import {
  DEFAULT_PROJECT_ID,
  DEFAULT_PROJECT_ROOT,
  DEFAULT_PROJECT_TITLE,
  createTemplateSong,
} from '../template.js';

const OPTIONS: readonly CliOptionSpec[] = Object.freeze([
  { name: 'root', kind: 'string' },
  { name: 'title', kind: 'string' },
  { name: 'preset', kind: 'string' },
  { name: 'duration', kind: 'string' },
  { name: 'bpm', kind: 'string' },
  { name: 'force', kind: 'boolean' },
]);

export interface InitData {
  readonly projectId: string;
  readonly root: string;
  readonly projectDirectory: string;
  readonly songFile: string;
  readonly revision: number;
  readonly title: string;
  readonly preset: string | null;
  readonly bpm: number;
  readonly durationSeconds: number;
  readonly overwritten: boolean;
  readonly previousRevision?: number;
  readonly nextCommands: readonly string[];
}

function usage(command: string, error: CliError): CommandOutcome<InitData> {
  return usageFailure(command, error);
}

function projectDetails(error: ProjectError): Readonly<Record<string, StructuredValue>> {
  const details: Record<string, StructuredValue> = {};
  if (error.projectId !== undefined) {
    details.projectId = error.projectId;
  }
  if (error.expectedRevision !== undefined) {
    details.expectedRevision = error.expectedRevision;
  }
  if (error.actualRevision !== undefined) {
    details.actualRevision = error.actualRevision;
  }
  if (error.detail !== undefined) {
    details.detail = error.detail;
  }
  return details;
}

function projectError(error: ProjectError, hint?: string): CliError {
  return {
    code: error.code,
    message: error.message,
    hint: hint ?? error.hint,
    ...(error.path === undefined ? {} : { path: error.path }),
    ...(error.issues === undefined ? {} : { issues: error.issues }),
    details: projectDetails(error),
  };
}

function quoteArgument(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : JSON.stringify(value);
}

function nextCommands(songFile: string): string[] {
  const file = quoteArgument(songFile);
  return [
    `vamp validate ${file}`,
    `vamp info ${file}`,
    `vamp render ${file} --out ./renders/master`,
    'vamp schema --guide',
  ];
}

function humanResult(
  data: InitData,
  warnings: readonly ValidationIssue[],
  overwritten: boolean,
  previousRevision: number | undefined,
): string {
  const action = overwritten ? 'Replaced the song in project' : 'Created project';
  const lines = [
    `${action} "${data.projectId}"`,
    `Project directory: ${data.projectDirectory}`,
    `Song file: ${data.songFile}`,
    data.preset === null
      ? 'Song template: minimal demo (six curated builtin instruments)'
      : `BGM preset: ${data.preset} at ${data.bpm} BPM, ${data.durationSeconds} s`,
    overwritten && previousRevision !== undefined
      ? `Revision: ${data.revision} (previously ${previousRevision})`
      : `Revision: ${data.revision}`,
    '',
    'Next commands:',
    ...data.nextCommands.map((command) => `  ${command}`),
  ];
  if (warnings.length > 0) {
    lines.push('', `Warnings (${warnings.length}):`);
    for (const warning of warnings) {
      lines.push(`  - [${warning.code}] ${warning.path}: ${warning.message}`);
    }
  }
  return lines.join('\n');
}

export async function runInit(args: readonly string[]): Promise<CommandOutcome<InitData>> {
  const parsed = parseArgs('init', args, OPTIONS);
  if (!parsed.ok) {
    return usage('init', {
      code: parsed.error.code,
      message: parsed.error.message,
      hint: parsed.error.hint,
    });
  }
  if (parsed.value.help) {
    return { kind: 'text', text: commandHelp('init') ?? '' };
  }

  if (parsed.value.positionals.length > 1) {
    return usage('init', {
      code: 'cli.usage.unexpected_argument',
      message: `unexpected argument "${parsed.value.positionals[1] ?? ''}"`,
      hint: 'Pass at most one project id. Run "vamp init --help" for usage.',
    });
  }

  const projectId = parsed.value.positionals[0] ?? DEFAULT_PROJECT_ID;
  const presetOption = getStringOption(parsed.value, 'preset');
  const durationOption = getStringOption(parsed.value, 'duration');
  const bpmOption = getStringOption(parsed.value, 'bpm');
  const titleOption = getStringOption(parsed.value, 'title');

  if (presetOption === undefined && (durationOption !== undefined || bpmOption !== undefined)) {
    return usage('init', {
      code: 'cli.usage.invalid_option_combination',
      message: '--duration and --bpm require --preset',
      hint: `Pass --preset with one of: ${BGM_PRESETS.map((preset) => preset.id).join(', ')}.`,
    });
  }

  let durationSeconds: number | undefined;
  if (durationOption !== undefined) {
    if (!/^[0-9]+(\.[0-9]+)?$/.test(durationOption.trim())) {
      return usage('init', {
        code: 'cli.usage.invalid_option_value',
        message: `invalid --duration value "${durationOption}"`,
        hint: 'Pass a positive number of seconds, for example --duration 45.',
      });
    }
    durationSeconds = Number(durationOption);
    if (!Number.isFinite(durationSeconds) || durationSeconds < 2 || durationSeconds > 600) {
      return usage('init', {
        code: 'cli.usage.invalid_option_value',
        message: `--duration must be between 2 and 600 seconds, received "${durationOption}"`,
        hint: 'Use a duration in seconds, for example --duration 45.',
      });
    }
  }
  let bpm: number | undefined;
  if (bpmOption !== undefined) {
    if (!/^[0-9]+$/.test(bpmOption.trim())) {
      return usage('init', {
        code: 'cli.usage.invalid_option_value',
        message: `invalid --bpm value "${bpmOption}"`,
        hint: 'Pass an integer tempo from 20 to 300, for example --bpm 90.',
      });
    }
    bpm = Number(bpmOption);
    if (!Number.isSafeInteger(bpm) || bpm < 20 || bpm > 300) {
      return usage('init', {
        code: 'cli.usage.invalid_option_value',
        message: `--bpm must be an integer from 20 to 300, received "${bpmOption}"`,
        hint: 'Use a tempo such as --bpm 90.',
      });
    }
  }

  let presetId: string | null = null;
  let title: string;
  let song;
  if (presetOption !== undefined) {
    const preset = getBgmPreset(presetOption.trim());
    if (preset === undefined) {
      return usage('init', {
        code: 'cli.usage.invalid_option_value',
        message: `unknown BGM preset "${presetOption}"`,
        hint: `Use one of: ${BGM_PRESETS.map((entry) => entry.id).join(', ')}.`,
      });
    }
    presetId = preset.id;
    title = titleOption ?? preset.name;
    song = createPresetSong(preset.id, {
      title,
      ...(durationSeconds === undefined ? {} : { durationSeconds }),
      ...(bpm === undefined ? {} : { bpm }),
    });
  } else {
    title = titleOption ?? DEFAULT_PROJECT_TITLE;
    song = createTemplateSong(title);
  }

  const force = hasFlag(parsed.value, 'force');
  const rootOption = getStringOption(parsed.value, 'root') ?? DEFAULT_PROJECT_ROOT;
  const root = resolve(process.cwd(), rootOption);

  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as NodeJS.ErrnoException).code)
        : 'unknown';
    const structured: CliError = {
      code: 'cli.init.root_create_failed',
      message: `Could not create the projects root "${root}".`,
      hint: 'Pass --root with a directory you can create or choose an existing directory.',
      path: root,
      details: { errno: code },
    };
    return failure(structured, formatError('init', structured));
  }

  const store = new ProjectStore({
    root,
    validation: INSTRUMENT_REGISTRY_VALIDATION,
  });
  const created = await store.create({ projectId, song });

  let snapshot = created;
  let overwritten = false;
  let previousRevision: number | undefined;

  if (!created.ok && created.code === 'project.exists' && force) {
    const current = await store.get(projectId);
    if (!current.ok) {
      const structured: CliError = {
        code: 'cli.init.overwrite_refused',
        message: `Project "${projectId}" exists but cannot be read safely, so it was not overwritten.`,
        hint: 'Fix the existing project or choose another project id. --force never overwrites a directory that is not a readable Vamp project.',
        path: root,
        details: { causeCode: current.code },
      };
      return failure(structured, `${formatError('init', structured)}\nCause: ${current.message}`);
    }
    previousRevision = current.value.revision;
    snapshot = await store.updateSong(projectId, {
      expectedRevision: current.value.revision,
      song,
    });
    overwritten = true;
  }

  if (!snapshot.ok) {
    const collision = snapshot.code === 'project.exists' && !force;
    const structured = projectError(
      snapshot,
      collision
        ? `Project "${projectId}" already exists. Choose another id, or pass --force to replace its song with the template.`
        : undefined,
    );
    return failure(structured, formatError('init', structured));
  }

  const location = await store.getLocation(projectId);
  if (!location.ok) {
    const structured = projectError(location);
    return failure(structured, formatError('init', structured));
  }

  const commands = nextCommands(location.value.songPath);
  const data: InitData = {
    projectId,
    root: location.value.rootDirectory,
    projectDirectory: location.value.directory,
    songFile: location.value.songPath,
    revision: snapshot.value.revision,
    title: snapshot.value.title,
    preset: presetId,
    bpm: song.meta.bpm,
    durationSeconds: Number(((song.meta.durationHint * 60) / song.meta.bpm).toFixed(3)),
    overwritten,
    ...(previousRevision === undefined ? {} : { previousRevision }),
    nextCommands: commands,
  };

  const human = humanResult(data, snapshot.value.warnings, overwritten, previousRevision);
  return success(data, snapshot.value.warnings, human);
}
