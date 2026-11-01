/**
 * `vamp doctor`: verify the local music path.
 *
 * Reports the schema, the selected default backend, the discovered SoundFont,
 * the FluidSynth executable and version, and optionally renders a single note
 * through the real sample backend. It never downloads anything and never
 * writes outside a temporary directory.
 */

import {
  INSTRUMENT_REGISTRY_VALIDATION,
  discoverSoundFont,
  isFluidSynthBinaryAvailable,
  probeFluidSynthVersion,
  renderSongAudio,
  selectAutomaticBackend,
} from '@gxaditya/vamp-engine';
import { SONG_SCHEMA_VERSION, type SongSchemaV1 } from '@gxaditya/vamp-schema';

import { hasFlag, parseArgs, type CliOptionSpec } from '../args.js';
import { commandHelp } from '../help.js';
import {
  failure,
  formatError,
  success,
  usageFailure,
  type CliError,
  type CommandOutcome,
} from '../output.js';

const OPTIONS: readonly CliOptionSpec[] = Object.freeze([{ name: 'no-smoke', kind: 'boolean' }]);

export interface DoctorData {
  readonly schemaVersion: string;
  readonly defaultBackend: 'builtin' | 'fluidsynth';
  readonly backendNote: string;
  readonly sampleBackend: {
    readonly executable: {
      readonly path: string;
      readonly available: boolean;
      readonly version: string | null;
    };
    readonly soundFont: {
      readonly path: string | null;
      readonly source: string;
      readonly available: boolean;
      readonly bytes: number | null;
    };
    readonly smoke: {
      readonly attempted: boolean;
      readonly ok: boolean;
      readonly peak: number | null;
      readonly message: string;
    };
  };
  readonly searchedSoundFontPaths: readonly string[];
  readonly nextSteps: readonly string[];
}

function smokeSong(): SongSchemaV1 {
  return {
    schemaVersion: '1.0.0',
    meta: {
      title: 'Vamp doctor smoke',
      bpm: 100,
      timeSignature: { numerator: 4, denominator: 4 },
      key: { tonic: 'C', mode: 'major' },
      seed: 1,
      durationHint: 1,
    },
    tracks: [
      {
        id: 'piano',
        name: 'Smoke Piano',
        kind: 'midi',
        channel: 0,
        instrument: { type: 'gm', program: 0, bank: 0 },
        volume: 0.8,
        notes: [{ pitch: 60, start: 0, duration: 0.5, velocity: 96 }],
      },
    ],
  };
}

function humanResult(data: DoctorData): string {
  const sample = data.sampleBackend;
  const lines = [
    'Vamp doctor',
    `Schema: ${data.schemaVersion}`,
    `Default backend: ${data.defaultBackend}`,
    `Note: ${data.backendNote}`,
    `FluidSynth executable: ${sample.executable.path} (${sample.executable.available ? `available${sample.executable.version === null ? '' : `, version ${sample.executable.version}`}` : 'missing'})`,
    `SoundFont: ${sample.soundFont.path ?? 'not found'} (${sample.soundFont.source}${sample.soundFont.available ? '' : ', unavailable'})`,
  ];
  if (sample.soundFont.bytes !== null) {
    lines.push(`SoundFont bytes: ${sample.soundFont.bytes}`);
  }
  lines.push(
    sample.smoke.attempted
      ? `Sample render smoke test: ${sample.smoke.ok ? 'ok' : 'failed'}${sample.smoke.peak === null ? '' : ` (peak ${sample.smoke.peak.toFixed(4)})`}`
      : 'Sample render smoke test: skipped',
    `Smoke message: ${sample.smoke.message}`,
  );
  if (data.nextSteps.length > 0) {
    lines.push('Next steps:');
    for (const step of data.nextSteps) {
      lines.push(`  - ${step}`);
    }
  }
  return lines.join('\n');
}

export async function runDoctor(args: readonly string[]): Promise<CommandOutcome<DoctorData>> {
  const parsed = parseArgs('doctor', args, OPTIONS);
  if (!parsed.ok) {
    return usageFailure('doctor', {
      code: parsed.error.code,
      message: parsed.error.message,
      hint: parsed.error.hint,
    });
  }
  if (parsed.value.help) {
    return { kind: 'text', text: commandHelp('doctor') ?? '' };
  }
  if (parsed.value.positionals.length > 0) {
    const structured: CliError = {
      code: 'cli.usage.unexpected_argument',
      message: `unexpected argument "${parsed.value.positionals[0] ?? ''}"`,
      hint: 'Run "vamp doctor --help" for usage.',
    };
    return failure(structured, formatError('doctor', structured));
  }

  const selection = await selectAutomaticBackend();
  const discovery = await discoverSoundFont();
  const executableAvailable = await isFluidSynthBinaryAvailable(selection.executable.path);
  const version = executableAvailable
    ? await probeFluidSynthVersion(selection.executable.path)
    : null;

  let smoke = {
    attempted: false,
    ok: false,
    peak: null as number | null,
    message: 'Sample backend is not available.',
  };
  if (selection.id === 'fluidsynth' && !hasFlag(parsed.value, 'no-smoke')) {
    const rendered = await renderSongAudio(smokeSong(), {
      sampleRate: 48_000,
      backend: selection.backend,
      validation: INSTRUMENT_REGISTRY_VALIDATION,
    });
    if (rendered.ok) {
      let peak = 0;
      for (let index = 0; index < rendered.audio.left.length; index += 1) {
        peak = Math.max(peak, Math.abs(rendered.audio.left[index] ?? 0));
        peak = Math.max(peak, Math.abs(rendered.audio.right[index] ?? 0));
      }
      smoke = {
        attempted: true,
        ok: peak > 0,
        peak,
        message:
          peak > 0
            ? 'Rendered one piano note through FluidSynth.'
            : 'Render succeeded but was silent.',
      };
    } else {
      smoke = {
        attempted: true,
        ok: false,
        peak: null,
        message:
          rendered.errors[0]?.message ??
          'The sample render smoke test failed with no error message.',
      };
    }
  } else if (selection.id === 'builtin') {
    smoke.message = 'The sample backend is unavailable, so the built-in synth is the default.';
  } else {
    smoke.message = 'Skipped by --no-smoke.';
  }

  const nextSteps: string[] = [];
  if (!selection.executable.available) {
    nextSteps.push(
      'Install FluidSynth 2.x (Debian/Ubuntu: sudo apt install fluidsynth; macOS: brew install fluid-synth).',
    );
  }
  if (!selection.soundFont.available) {
    nextSteps.push(
      'Provision a GM SoundFont such as FluidR3_GM.sf2 in /usr/share/sounds/sf2, ~/.local/share/vamp/soundfonts, or set VAMP_SOUNDFONT_PATH.',
    );
  }
  if (nextSteps.length === 0) {
    nextSteps.push(
      'Run "vamp init demo --preset lofi" then "vamp render ..." for a sample-backed BGM cue.',
    );
  }

  const data: DoctorData = {
    schemaVersion: SONG_SCHEMA_VERSION,
    defaultBackend: selection.id,
    backendNote: selection.note,
    sampleBackend: {
      executable: {
        path: selection.executable.path,
        available: executableAvailable,
        version,
      },
      soundFont: {
        path: selection.soundFont.path,
        source: selection.soundFont.source,
        available: selection.soundFont.available,
        bytes: discovery.soundFont?.bytes ?? null,
      },
      smoke,
    },
    searchedSoundFontPaths: discovery.searchedPaths,
    nextSteps,
  };

  return success(data, [], humanResult(data));
}
