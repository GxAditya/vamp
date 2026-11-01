#!/usr/bin/env node
/**
 * Vamp CLI entrypoint.
 *
 * The CLI provides `init`, `validate`, `info`, `render`, and `schema`. MCP and
 * the SDK are separate packages. All commands are non-interactive and reuse the
 * shared schema, engine, and project packages.
 */

import { runDoctor } from './commands/doctor.js';
import { runInfo } from './commands/info.js';
import { runInit } from './commands/init.js';
import { runPresets } from './commands/presets.js';
import { runRender } from './commands/render.js';
import { runSchema } from './commands/schema.js';
import { runValidate } from './commands/validate.js';
import { commandHelp, generalHelp, isCommandName, readPackageVersion } from './help.js';
import {
  EXIT_SUCCESS,
  internalFailure,
  emitOutcome,
  usageFailure,
  writeStdout,
  type CliError,
  type CommandOutcome,
  type ExitCode,
} from './output.js';

function usageError(code: string, message: string, hint: string): CliError {
  return { code, message, hint };
}

function emitUsage(
  command: string,
  json: boolean,
  code: string,
  message: string,
  hint: string,
): ExitCode {
  return emitOutcome(
    command,
    json,
    usageFailure(command === '' ? 'cli' : command, usageError(code, message, hint)),
  );
}

async function dispatch(
  command: string,
  args: readonly string[],
): Promise<CommandOutcome<unknown> | null> {
  switch (command) {
    case 'init':
      return runInit(args);
    case 'validate':
      return runValidate(args);
    case 'info':
      return runInfo(args);
    case 'render':
      return runRender(args);
    case 'schema':
      return runSchema(args);
    case 'presets':
      return runPresets(args);
    case 'doctor':
      return runDoctor(args);
    default:
      return null;
  }
}

function effectiveJson(commandArgs: readonly string[], globalJson: boolean): boolean {
  let json = globalJson;
  for (const token of commandArgs) {
    if (token === '--') {
      break;
    }
    if (token === '--json') {
      json = true;
    }
  }
  return json;
}

function helpCommand(args: readonly string[]): ExitCode {
  if (args.length === 0) {
    writeStdout(generalHelp(readPackageVersion()));
    return EXIT_SUCCESS;
  }
  const [name, ...rest] = args;
  if (rest.length > 0) {
    return emitUsage(
      'help',
      false,
      'cli.usage.unexpected_argument',
      `unexpected argument "${rest[0] ?? ''}"`,
      'Run "vamp help" or "vamp help <command>".',
    );
  }
  if (name === undefined || !isCommandName(name)) {
    return emitUsage(
      'help',
      false,
      'cli.usage.unknown_command',
      `unknown command "${name ?? ''}"`,
      'Run "vamp --help" to see available commands.',
    );
  }
  const help = commandHelp(name);
  if (help === null) {
    return emitUsage(
      'help',
      false,
      'cli.usage.unknown_command',
      `unknown command "${name}"`,
      'Run "vamp --help" to see available commands.',
    );
  }
  writeStdout(help);
  return EXIT_SUCCESS;
}

async function main(args: readonly string[]): Promise<ExitCode> {
  let globalJson = false;
  let index = 0;
  while (args[index] === '--json') {
    globalJson = true;
    index += 1;
  }

  const command = args[index];
  const rest = args.slice(index + 1);
  // The command adapters also need to know that --json was supplied globally,
  // because render suppresses progress in JSON mode. Keep global --json in the
  // argument list handed to the adapter; every command parser accepts it.
  const commandArgs = globalJson ? ['--json', ...rest] : rest;

  if (command === undefined) {
    if (globalJson) {
      return emitUsage(
        'cli',
        true,
        'cli.usage.missing_command',
        'missing command',
        'Pass init, validate, info, render, schema, presets, or doctor. Run "vamp --help" for usage.',
      );
    }
    writeStdout(generalHelp(readPackageVersion()));
    return EXIT_SUCCESS;
  }

  if (command === 'help') {
    return helpCommand(rest);
  }

  if (command === '--help' || command === '-h') {
    if (rest.length > 0) {
      return emitUsage(
        'cli',
        false,
        'cli.usage.unexpected_argument',
        `unexpected argument "${rest[0] ?? ''}"`,
        'Run "vamp --help" for usage.',
      );
    }
    writeStdout(generalHelp(readPackageVersion()));
    return EXIT_SUCCESS;
  }

  if (command === 'version' || command === '--version' || command === '-v') {
    if (rest.length > 0) {
      return emitUsage(
        'cli',
        false,
        'cli.usage.unexpected_argument',
        `unexpected argument "${rest[0] ?? ''}"`,
        'Run "vamp --version" without extra arguments.',
      );
    }
    writeStdout(`vamp ${readPackageVersion()}`);
    return EXIT_SUCCESS;
  }

  if (command.startsWith('-')) {
    return emitUsage(
      'cli',
      globalJson,
      'cli.usage.unknown_option',
      `unknown option "${command}"`,
      'Run "vamp --help" to see available commands.',
    );
  }

  if (!isCommandName(command)) {
    return emitUsage(
      'cli',
      globalJson,
      'cli.usage.unknown_command',
      `unknown command "${command}"`,
      'Run "vamp --help" to see available commands.',
    );
  }

  const json = effectiveJson(rest, globalJson);
  try {
    const outcome = await dispatch(command, commandArgs);
    if (outcome === null) {
      return emitUsage(
        'cli',
        json,
        'cli.usage.unknown_command',
        `unknown command "${command}"`,
        'Run "vamp --help" to see available commands.',
      );
    }
    return emitOutcome(command, json, outcome);
  } catch (error) {
    return emitOutcome(command, json, internalFailure(error, command));
  }
}

const exitCode = await main(process.argv.slice(2));
process.exitCode = exitCode;
