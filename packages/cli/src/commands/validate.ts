/**
 * `vamp validate <file>`: validate one standalone JSON song file through the
 * shared `@gxaditya/vamp-schema` validator.
 */

import { parseArgs } from '../args.js';
import { countSong, loadSongFile, type SongCounts } from '../files.js';
import { commandHelp } from '../help.js';
import {
  failure,
  formatError,
  formatWarnings,
  success,
  usageFailure,
  type CommandOutcome,
} from '../output.js';
import type { CapabilityCheckStatus } from '@gxaditya/vamp-schema';

export interface ValidateData {
  readonly file: string;
  readonly resolvedPath: string;
  readonly schemaVersion: string;
  readonly capabilityCheck: CapabilityCheckStatus;
  readonly counts: SongCounts;
}

function humanResult(data: ValidateData, warningsText: string): string {
  return [
    'Valid SongSchemaV1',
    `File: ${data.resolvedPath}`,
    `Schema version: ${data.schemaVersion}`,
    `Tracks: ${data.counts.tracks}`,
    `Patterns: ${data.counts.patterns}`,
    `Authored notes: ${data.counts.authoredNotes}`,
    warningsText,
  ].join('\n');
}

export async function runValidate(args: readonly string[]): Promise<CommandOutcome<ValidateData>> {
  const parsed = parseArgs('validate', args);
  if (!parsed.ok) {
    return usageFailure('validate', {
      code: parsed.error.code,
      message: parsed.error.message,
      hint: parsed.error.hint,
    });
  }
  if (parsed.value.help) {
    return { kind: 'text', text: commandHelp('validate') ?? '' };
  }
  if (parsed.value.positionals.length === 0) {
    return usageFailure('validate', {
      code: 'cli.usage.missing_argument',
      message: 'missing required argument <file>',
      hint: 'Pass one JSON song file. Run "vamp validate --help" for details.',
    });
  }
  if (parsed.value.positionals.length > 1) {
    return usageFailure('validate', {
      code: 'cli.usage.unexpected_argument',
      message: `unexpected argument "${parsed.value.positionals[1] ?? ''}"`,
      hint: 'Pass exactly one file. Run "vamp validate --help" for details.',
    });
  }

  const file = parsed.value.positionals[0] ?? '';
  const loaded = await loadSongFile(file);
  if (!loaded.ok) {
    return failure(loaded.error, formatError('validate', loaded.error), {
      warnings: loaded.warnings,
    });
  }

  const counts = countSong(loaded.value.validation);
  const warnings = loaded.value.validation.warnings;
  const data: ValidateData = {
    file: loaded.value.file,
    resolvedPath: loaded.value.resolvedPath,
    schemaVersion: loaded.value.validation.schemaVersion,
    capabilityCheck: loaded.value.validation.capabilityCheck,
    counts,
  };
  return success(data, warnings, humanResult(data, formatWarnings(warnings)));
}
