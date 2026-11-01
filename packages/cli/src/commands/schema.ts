/**
 * `vamp schema`: print the canonical JSON Schema or the agent-oriented guide.
 */

import { SONG_SCHEMA_ID, SONG_SCHEMA_VERSION, getSongSchemaV1 } from '@gxaditya/vamp-schema';

import { hasFlag, parseArgs, type CliOptionSpec } from '../args.js';
import { readSchemaGuide } from '../guide.js';
import { commandHelp } from '../help.js';
import { failure, success, usageFailure, type CliError, type CommandOutcome } from '../output.js';

const OPTIONS: readonly CliOptionSpec[] = Object.freeze([{ name: 'guide', kind: 'boolean' }]);

export interface SchemaData {
  readonly schemaVersion: string;
  readonly schemaId: string;
  readonly schema: Readonly<Record<string, unknown>>;
}

export interface GuideData {
  readonly schemaVersion: string;
  readonly format: 'markdown';
  readonly guide: string;
}

export async function runSchema(
  args: readonly string[],
): Promise<CommandOutcome<SchemaData | GuideData>> {
  const parsed = parseArgs('schema', args, OPTIONS);
  if (!parsed.ok) {
    return usageFailure('schema', {
      code: parsed.error.code,
      message: parsed.error.message,
      hint: parsed.error.hint,
    });
  }
  if (parsed.value.help) {
    return { kind: 'text', text: commandHelp('schema') ?? '' };
  }
  if (parsed.value.positionals.length > 0) {
    return usageFailure('schema', {
      code: 'cli.usage.unexpected_argument',
      message: `unexpected argument "${parsed.value.positionals[0] ?? ''}"`,
      hint: 'Run "vamp schema --help" for usage.',
    });
  }

  if (hasFlag(parsed.value, 'guide')) {
    const guide = readSchemaGuide();
    if (!guide.ok) {
      const structured: CliError = {
        code: 'cli.schema.guide_unavailable',
        message: guide.message,
        hint: 'Rebuild the CLI or provision docs/schema-guide.md. The command never uses the network.',
      };
      return failure(structured, `vamp schema: ${structured.message}\nHint: ${structured.hint}`);
    }
    const data: GuideData = {
      schemaVersion: SONG_SCHEMA_VERSION,
      format: 'markdown',
      guide: guide.markdown,
    };
    return success(data, [], guide.markdown);
  }

  const data: SchemaData = {
    schemaVersion: SONG_SCHEMA_VERSION,
    schemaId: SONG_SCHEMA_ID,
    schema: getSongSchemaV1(),
  };
  return success(data, [], JSON.stringify(data.schema, null, 2));
}
