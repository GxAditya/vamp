/**
 * Help and version text for the CLI.
 */

import { readFileSync } from 'node:fs';

import { DEFAULT_PROJECT_ID, DEFAULT_PROJECT_ROOT, DEFAULT_PROJECT_TITLE } from './template.js';

const BIN_NAME = 'vamp';

export const COMMAND_NAMES = [
  'init',
  'validate',
  'info',
  'render',
  'schema',
  'presets',
  'doctor',
  'help',
  'version',
] as const;
export type CommandName = (typeof COMMAND_NAMES)[number];

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
    throw new Error('CLI package metadata does not contain a valid version.');
  }

  return parsed.version;
}

export function generalHelp(version: string): string {
  return `${BIN_NAME} ${version}

Usage: ${BIN_NAME} <command> [options]

Commands:
  init [project-id]   Create a project, optionally from a BGM preset
  validate <file>     Validate a JSON song file with SongSchemaV1
  info <file>         Inspect a JSON song file (not audio)
  render <file>       Render a song to WAV, stems, MIDI, and a report
  schema [--guide]    Print the canonical JSON Schema or the schema guide
  presets             List the curated BGM preset packs
  doctor              Check SoundFont, FluidSynth, and the default backend
  help [command]      Show general or command help
  version             Show the Vamp CLI version

Global options:
  --json              Print one machine-readable JSON envelope on stdout
  -h, --help          Show help
  -v, --version       Show the CLI version

Exit codes:
  0                   Success
  1                   Validation, file, project, or runtime failure
  2                   Usage error

Every command is non-interactive. Human results go to stdout. Human
diagnostics and render progress go to stderr. With --json, stdout contains only
the envelope.

WAV is the only render format. MP3 export and play are not implemented.

Run "${BIN_NAME} <command> --help" for command details.
`;
}

export function commandHelp(command: CommandName): string | null {
  switch (command) {
    case 'init':
      return `Usage: ${BIN_NAME} init [project-id] [options]

Create a playable Vamp project with a SongSchemaV1 song. Without --preset the
template is a small builtin demo. With a BGM preset the song is a complete
arrangement with real GM instruments, groove, velocity variation, effects, and
an intro/main/outro shape. The default auto render backend uses FluidSynth when
a local SoundFont is available, so preset songs sound like sampled instruments.

Positionals:
  project-id           Project id (default: ${DEFAULT_PROJECT_ID})
                       Lowercase a-z, 0-9, ".", "_", and "-"; must start and end
                       with a letter or digit.

Options:
  --root <dir>         Projects root (default: ./${DEFAULT_PROJECT_ROOT})
                       A relative path is resolved from the current directory.
                       The root is created if missing. ProjectStore requires an
                       absolute existing root, so the CLI creates it first.
  --title <title>      Song title (default: ${DEFAULT_PROJECT_TITLE} or the
                       preset name)
  --preset <id>        Generate a complete BGM cue instead of the minimal demo.
                       One of: lofi, tutorial_upbeat, ambient_focus,
                       corporate_clean, stinger.
  --duration <seconds> Override the preset duration (2 to 600).
  --bpm <tempo>        Override the preset tempo (20 to 300).
  --force              Replace the song of an existing Vamp project with the
                       template after reading its current revision. Assets and
                       renders are preserved. Non-project directories are never
                       overwritten.
  --json               Print one JSON envelope on stdout
  -h, --help           Show this help

Exit codes: 0 created, 1 failure, 2 usage error.
`;
    case 'validate':
      return `Usage: ${BIN_NAME} validate <file> [options]

Validate one JSON song file with the shared @gxaditya/vamp-schema validator. The file is
read as a regular UTF-8 file from the current working directory or an absolute
path, with an 8 MiB bound. Symbolic links are rejected.

Options:
  --json               Print one JSON envelope on stdout
  -h, --help           Show this help

Success data fields:
  file, resolvedPath, schemaVersion, capabilityCheck,
  counts { tracks, midiTracks, drumTracks, patterns, placements,
           freeNotes, patternNotes, authoredNotes }

Warnings are reported in the envelope. Validation failures include stable issue
codes, JSON Pointer paths, and repair hints in error.issues.

Exit codes: 0 valid, 1 invalid or unreadable, 2 usage error.
`;
    case 'info':
      return `Usage: ${BIN_NAME} info <file> [options]

Inspect a JSON song file. This reports song metadata and counts. It does not
inspect audio, requires no audio device, and does not render.

Options:
  --json               Print one JSON envelope on stdout
  -h, --help           Show this help

Success data fields:
  file, resolvedPath, schemaVersion, title, bpm, timeSignature, key, seed,
  durationHint { beats, bars, seconds },
  duration { hintSeconds, lastSoundSeconds, estimatedRenderedSeconds },
  counts { tracks, midiTracks, drumTracks, patterns, placements, freeNotes,
           patternNotes, authoredNotes, expandedEvents, warnings },
  tracks [{ id, name, kind, channel, instrument, freeNotes, placements,
            effects, mute, solo }],
  instruments [{ type, label, trackIds, id?, program?, bank?, path? }]

expandedEvents is the compiled note-event count from the shared engine
timeline and includes muted or non-soloed tracks. Warnings are reported in the
envelope.

Exit codes: 0 inspected, 1 invalid or unreadable, 2 usage error.
`;
    case 'render':
      return `Usage: ${BIN_NAME} render <file> --out <directory> [options]

Render one JSON song file offline. A bare render writes master.wav, one
post-effect WAV stem per audible track, song.mid, and report.json, matching the
complete artifact default. No audio device or network is used.

Options:
  --out <directory>          Required output directory. A new directory is
                             published atomically; its parent must exist.
  --format wav               Output format (default: wav). MP3 is deferred and
                             is rejected with a helpful error.
  --sample-rate <rate>       44100 or 48000 (default: 48000). Audio is never
                             resampled.
  --backend <name>           auto (default), builtin, or fluidsynth. Auto uses
                             FluidSynth plus a locally discovered GM SoundFont
                             when both are available, otherwise the built-in
                             synth with a warning.
  --stems / --no-stems       Write or omit per-track stems (default: write).
  --midi / --no-midi         Write or omit song.mid (default: write).
  --report / --no-report     Write or omit report.json (default: write). The
                             success envelope always contains report data.
  --normalize / --no-normalize
                             Normalize the master and stems to -1 dBFS with at
                             most +9 dB of boost (default: normalize). The same
                             gain is applied to every stem so stems still sum to
                             the master. Use --no-normalize for raw mix levels.
  --overwrite                Replace existing artifacts from an earlier render.
                             Without it, existing files are refused.
  --fluidsynth-path <path>   FluidSynth executable, absolute or on PATH.
                             Environment fallback: VAMP_FLUIDSYNTH_PATH.
  --soundfont <path>         Trusted General MIDI .sf2 for gm and curated
                             builtin instruments. Environment fallback:
                             VAMP_SOUNDFONT_PATH. Required when the song needs
                             a GM SoundFont.
  --project-root <dir>       Project root for song-referenced .sf2 assets.
                             Default: the song file directory. The root and
                             asset must exist and the asset must stay confined.
  --verify-soundfont         Verify the GM SoundFont against the pinned
                             FluidR3 SHA-256 before rendering.
  --json                     Print one JSON envelope on stdout. Progress and
                             expected diagnostics never contaminate stdout.
  -h, --help                 Show this help

The default auto backend prefers real sample instruments. FluidSynth is used
when the executable and a provisioned GM SoundFont are available locally;
otherwise Vamp falls back to the dependency-free built-in synth and reports
why. Songs that request gm or soundfont instruments still fail on the built-in
backend with a structured error and a hint to provision the sample path.
Instruments are never substituted silently.

SoundFont discovery checks VAMP_SOUNDFONT_PATH, VAMP_SOUNDFONT_DIR,
~/.local/share/vamp/soundfonts, and standard system SoundFont directories. It
never downloads a file. Run "vamp doctor" to see what was found.

Cancellation: SIGINT and SIGTERM abort through the shared artifact renderer.
Job outputs are cleaned up and no partial artifacts are published. An in-flight
native FluidSynth call is not interrupted; cleanup happens at the next safe
boundary.

Exit codes: 0 rendered, 1 validation/file/render/runtime failure or
cancellation, 2 usage error.
`;
    case 'schema':
      return `Usage: ${BIN_NAME} schema [options]

Print the canonical SongSchemaV1 JSON Schema to stdout. The schema is loaded
from @gxaditya/vamp-schema, never from the current directory or the network.

Options:
  --guide              Print the agent-oriented schema guide instead
  --json               Print one JSON envelope on stdout
  -h, --help           Show this help

Without --json, "schema" prints the raw canonical JSON document and
"schema --guide" prints Markdown. With --json the schema is in
data.schema and the guide is in data.guide.

Exit codes: 0 success, 1 guide unavailable, 2 usage error.
`;
    case 'presets':
      return `Usage: ${BIN_NAME} presets [options]

List the curated BGM preset packs. Each preset is a complete arrangement
recipe: instruments, chord loop, groove, mix, and default duration.

Options:
  --json               Print one JSON envelope on stdout
  -h, --help           Show this help

Create a project from one with:
  ${BIN_NAME} init my-cue --preset lofi --duration 45 --bpm 90

Exit codes: 0 success, 2 usage error.
`;
    case 'doctor':
      return `Usage: ${BIN_NAME} doctor [options]

Check the local music path before rendering: schema, default backend,
FluidSynth executable and version, the discovered GM SoundFont, and a tiny
one-note sample render through FluidSynth. Discovery is filesystem-only and
never downloads.

Options:
  --no-smoke           Skip the one-note render check
  --json               Print one JSON envelope on stdout
  -h, --help           Show this help

Exit codes: 0 check completed (inspect data for availability), 1 failure,
2 usage error.
`;
    case 'help':
      return `Usage: ${BIN_NAME} help [command]

Show general help or help for init, validate, info, render, schema, presets,
doctor, help, or version.
`;
    case 'version':
      return `Usage: ${BIN_NAME} version

Print the Vamp CLI package version.
`;
    default:
      return null;
  }
}

export function isCommandName(value: string): value is CommandName {
  return (COMMAND_NAMES as readonly string[]).includes(value);
}
