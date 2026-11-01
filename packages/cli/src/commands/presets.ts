/**
 * `vamp presets`: list the curated BGM preset packs.
 *
 * A preset is a complete composition recipe. `vamp init <id> --preset <name>`
 * turns one into a valid song.
 */

import { describeBgmPresets, type BgmPresetDescription } from '@gxaditya/vamp-engine';

import { parseArgs } from '../args.js';
import { commandHelp } from '../help.js';
import { success, usageFailure, type CommandOutcome } from '../output.js';

export interface PresetsData {
  readonly presets: readonly BgmPresetDescription[];
}

function humanResult(data: PresetsData): string {
  const lines = [
    'Vamp BGM presets',
    '',
    '| ID | Name | Default | Key | Instruments |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const preset of data.presets) {
    const instruments = preset.instruments.map((entry) => entry.label).join(', ');
    lines.push(
      `| ${preset.id} | ${preset.name} | ${preset.defaultSeconds}s @ ${preset.defaultBpm} BPM | ${preset.defaultKey.tonic} ${preset.defaultKey.mode} | ${instruments} |`,
    );
  }
  lines.push(
    '',
    'Create a project from a preset:',
    '  vamp init my-cue --preset lofi',
    '  vamp init my-cue --preset tutorial_upbeat --duration 30 --bpm 112',
    '',
    'Each preset generates a complete arrangement with intro, groove, velocity variation, effects, and a tail that fits the requested duration.',
  );
  return lines.join('\n');
}

export async function runPresets(args: readonly string[]): Promise<CommandOutcome<PresetsData>> {
  const parsed = parseArgs('presets', args);
  if (!parsed.ok) {
    return usageFailure('presets', {
      code: parsed.error.code,
      message: parsed.error.message,
      hint: parsed.error.hint,
    });
  }
  if (parsed.value.help) {
    return { kind: 'text', text: commandHelp('presets') ?? '' };
  }
  if (parsed.value.positionals.length > 0) {
    return usageFailure('presets', {
      code: 'cli.usage.unexpected_argument',
      message: `unexpected argument "${parsed.value.positionals[0] ?? ''}"`,
      hint: 'Run "vamp presets" without arguments.',
    });
  }
  const data: PresetsData = { presets: describeBgmPresets() };
  return success(data, [], humanResult(data));
}
