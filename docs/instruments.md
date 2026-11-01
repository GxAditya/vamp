# Instruments and sample assets

Vamp has two offline backends and one default policy:

- `builtin-synth-v1`, the dependency-free deterministic fallback, supports the
  six curated builtin IDs. It is a real synthesizer, not a toy beep engine, but
  it is not a sample library.
- `fluidsynth-sf2-v1`, the real sample backend, renders General MIDI presets
  through FluidSynth 2.x and a provisioned SoundFont. It supports `builtin`,
  `gm`, and `soundfont` instrument variants. It does not support SFZ.
- The default `auto` mode uses FluidSynth plus a locally discovered GM
  SoundFont when both are available, and otherwise falls back to the built-in
  synthesizer with an explicit warning.

The agent-facing catalog is richer than six IDs. `list_instruments` returns:

- the six curated dual-backend IDs (`piano.soft`, `keys.soft`, `bass.sub`,
  `pad.warm`, `guitar.clean`, `drums.kit`), and
- a named catalog of 56 General MIDI presets across piano, keys, organ, bass,
  guitar, strings, pads, choir, brass, woodwind, sax, mallets, leads, plucks,
  and FX, each with the exact `{ "type": "gm", "program", "bank" }` object, and
- the GM Standard Kit with a readable drum key map.

Source:
[`packages/engine/src/instruments.ts`](../packages/engine/src/instruments.ts),
[`packages/engine/src/presets.ts`](../packages/engine/src/presets.ts), and
[`packages/engine/src/audio/fluidsynth.ts`](../packages/engine/src/audio/fluidsynth.ts).

> Why this backend uses FluidSynth and SF2, plus the pinned FluidR3 GM asset facts (file, version, byte size, SHA-256, MIT license, and the rule to provision rather than bundle), are documented in [Vamp architecture](./architecture.md).

## Setup

Install FluidSynth 2.x and provision the SoundFont once, before rendering. Do
not download assets from inside a render, CLI render, or MCP call.

`vamp doctor` reports the executable, the discovered font, and a one-note
FluidSynth smoke render. MCP `health_check` reports the same information.

### Automatic discovery

When `--soundfont` and `VAMP_SOUNDFONT_PATH` are absent, Vamp looks for a local
font in this order:

1. `VAMP_SOUNDFONT_PATH` (explicit file)
2. `VAMP_SOUNDFONT_DIR` (directory)
3. `$XDG_DATA_HOME/vamp/soundfonts` or `~/.local/share/vamp/soundfonts`
4. Standard system directories, including `/usr/share/sounds/sf2`,
   `/usr/share/soundfonts`, `/usr/local/share/soundfonts` on Linux,
   `/opt/homebrew/share/soundfonts` on macOS, and the ProgramData/Program Files
   Vamp and FluidSynth locations on Windows.

`.sf2` is preferred over `.sf3`, and names such as GeneralUser, FluidR3 GM,
MuseScore General, and default-GM are preferred within a directory. A candidate
must be a regular file of at least 1 MiB with a RIFF/sfbk header. Discovery is
filesystem-only and never downloads.

### Linux (Debian/Ubuntu)

```sh
sudo apt install fluidsynth fluid-soundfont-gm
node scripts/verify-soundfont.mjs /usr/share/sounds/sf2/FluidR3_GM.sf2
```

Expected paths are `/usr/bin/fluidsynth` and
`/usr/share/sounds/sf2/FluidR3_GM.sf2`. The package version used for the pinned
checksum was 3.1-5.3 with FluidSynth 2.3.4.

### macOS

```sh
brew install fluid-synth
# Obtain FluidR3_GM.sf2 from the pinned upstream source and extract it.
node scripts/verify-soundfont.mjs /absolute/path/FluidR3_GM.sf2
```

Use the pinned checksum recorded in [Vamp architecture](./architecture.md) to
confirm that the extracted file is the pinned version. `brew` does not supply the
SoundFont.

### Windows

Install FluidSynth 2.x from the official release channel or your package
manager, add `fluidsynth.exe` to `PATH` or pass its absolute path, then obtain
`FluidR3_GM.sf2` from the pinned source and verify it:

```powershell
node scripts/verify-soundfont.mjs C:\path\to\FluidR3_GM.sf2
```

Do not commit the SoundFont to a project repository. Keep it in a local
provisioned location and configure its absolute path.

### Verification script

`scripts/verify-soundfont.mjs` checks the file type, exact byte size, and
SHA-256 against its own pinned values, which match the asset facts in
[Vamp architecture](./architecture.md). It uses the Node standard library and
performs no network access. Run it during setup, not during renders.

## Errors

| Code                                   | Meaning                                                                      |
| -------------------------------------- | ---------------------------------------------------------------------------- |
| `audio.backend.missing_dependency`     | FluidSynth executable not found.                                             |
| `audio.backend.timeout`                | FluidSynth exceeded the configured timeout and was killed.                   |
| `audio.backend.process_failed`         | Nonzero exit, signal, or spawn failure; includes a bounded stderr excerpt.   |
| `audio.backend.output_invalid`         | Missing, oversized, wrong-format, wrong-rate, or undecodable WAV.            |
| `audio.config.invalid`                 | Bad backend configuration, missing project root, or invalid checksum config. |
| `audio.asset.missing`                  | Required GM SoundFont or project asset does not exist.                       |
| `audio.asset.invalid`                  | Wrong extension, not a file, corrupt/truncated, or oversized asset.          |
| `audio.asset.confined`                 | Absolute, traversal, backslash, or symlink-escaped project asset path.       |
| `audio.asset.checksum_mismatch`        | Configured expected SHA-256 does not match the asset.                        |
| `audio.instrument.unsupported_variant` | SFZ or another unsupported variant; no substitution.                         |
| `audio.instrument.unknown_builtin`     | Builtin ID is not in the registry.                                           |

All errors use the shared audio issue shape with a stable code, JSON Pointer
path, message, hint, and optional params.
