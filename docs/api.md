# Vamp API reference

One reference for every callable surface in Vamp: the `vamp` command line, the
`@gxaditya/vamp-sdk` TypeScript client, and the public exports of `@gxaditya/vamp-schema`,
`@gxaditya/vamp-engine`, and `@gxaditya/vamp-project`. The MCP tool surface is documented in
[`mcp.md`](./mcp.md), and the SongSchemaV1 field contract is in
[`schema-guide.md`](./schema-guide.md).

Version support is `node` >= 22.13.0. All packages are ESM only.

## Command line interface

### Command summary

| Command           | Purpose                                                 |
| ----------------- | ------------------------------------------------------- |
| `init`            | Create a playable minimal project with a template song. |
| `validate <file>` | Validate one JSON song file with SongSchemaV1.          |
| `info <file>`     | Inspect a JSON song file. This is not audio inspection. |
| `render <file>`   | Render WAV, stems, MIDI, and a JSON report offline.     |
| `schema`          | Print the canonical JSON Schema.                        |
| `schema --guide`  | Print the agent-oriented schema guide.                  |
| `help [command]`  | Print general or command help.                          |
| `version`         | Print the CLI package version.                          |

Every command is non-interactive. There are no prompts.

### Output contract

- Human success output is written to stdout.
- Human diagnostics and failures are written to stderr.
- Render progress is written only to stderr in human mode. It is suppressed in
  `--json` mode.
- With `--json`, stdout contains exactly one JSON envelope and expected
  failures write nothing to stderr.
- `--json` may appear before or after the command, for example
  `vamp --json validate song.json` or `vamp validate song.json --json`.
- `--help` prints text even when `--json` is also present.
- Apart from `render` progress, the commands do not print progress output.

#### Exit codes

| Code | Meaning                                                                        |
| ---- | ------------------------------------------------------------------------------ |
| 0    | Success, including validation success with warnings.                           |
| 1    | Validation, file, project, render, or runtime failure, including cancellation. |
| 2    | Usage error, including unknown commands, options, or arguments.                |

The CLI never exits zero after a caught failure. A cancelled render exits 1 with
`cli.render.cancelled`; it never reports success.

#### Success envelope

```json
{
  "command": "validate",
  "ok": true,
  "data": {
    "file": "song.json",
    "resolvedPath": "/work/song.json",
    "schemaVersion": "1.0.0",
    "capabilityCheck": "not_checked",
    "counts": {
      "tracks": 3,
      "midiTracks": 2,
      "drumTracks": 1,
      "patterns": 0,
      "placements": 0,
      "freeNotes": 72,
      "patternNotes": 0,
      "authoredNotes": 72
    }
  },
  "warnings": []
}
```

Every success envelope has `command`, `ok: true`, `data`, and `warnings`.
Warnings use the shared schema `ValidationIssue` shape.

#### Error envelope

```json
{
  "command": "validate",
  "ok": false,
  "error": {
    "code": "cli.file.malformed_json",
    "message": "Song file \"bad.json\" is not valid JSON.",
    "hint": "Fix the JSON syntax and retry. The file was not modified.",
    "path": "bad.json",
    "details": {
      "detail": "Expected double-quoted property name in JSON at position 27",
      "resolvedPath": "/work/bad.json"
    }
  },
  "warnings": []
}
```

Every error envelope has `command`, `ok: false`, `error`, and `warnings`.

`error` fields:

| Field     | Required | Meaning                                                                |
| --------- | -------- | ---------------------------------------------------------------------- |
| `code`    | yes      | Stable machine code.                                                   |
| `message` | yes      | One-sentence explanation.                                              |
| `hint`    | yes      | Actionable repair guidance.                                            |
| `path`    | no       | The input path or a project-relative schema path.                      |
| `issues`  | no       | Shared validation issues for schema failures.                          |
| `details` | no       | Additional safe scalar context, such as `resolvedPath` or `projectId`. |

Validation issues keep the shared schema fields: `code`, `severity`, `path`
(JSON Pointer), `message`, `hint`, and optional `params`. The document root uses
an empty `path` in issue objects.

### `init`

```sh
vamp init [project-id] [--root <dir>] [--title <title>] [--force] [--json]
```

Defaults:

| Setting       | Default           | Meaning                                      |
| ------------- | ----------------- | -------------------------------------------- |
| Project id    | `demo`            | Directory name below the projects root.      |
| Projects root | `./vamp-projects` | Resolved from the current working directory. |
| Title         | `Vamp Demo`       | Written to `song.json` as `meta.title`.      |

The projects root is created when it does not exist, with a private directory
mode where the platform supports it. A relative `--root` is resolved from the
current working directory. The final `root`, `projectDirectory`, and `songFile`
values in JSON output are absolute and canonical.

Project ids follow `ProjectStore` rules: 1 to 64 lowercase ASCII characters from
`a-z`, `0-9`, `.`, `_`, and `-`, starting and ending with a letter or digit, and
never a Windows device name.

The created layout is:

```text
vamp-projects/
  demo/
    .vamp-project.json
    song.json
    assets/
    renders/
```

The template song:

- uses `schemaVersion: "1.0.0"`;
- uses only `keys.soft`, `bass.sub`, and `drums.kit`;
- contains free notes only, with no patterns, automation, or effects;
- uses unique melodic channels 0 and 1 and drums channel 9;
- is validated through `@gxaditya/vamp-project` with the engine instrument registry;
- is renderable offline by the deterministic built-in synthesizer with
  `vamp render`.

#### Collisions and overwrite

`init` refuses an existing project by default with exit code 1 and
`error.code` set to `project.exists`. The existing song is not changed. Choose a
different id or pass `--force`.

`--force` replaces the song in an existing readable Vamp project. It first
reads the current project revision through `ProjectStore`, then calls
`updateSong` with that revision and the template. This is an atomic, validated
write that increments the revision. It does not delete the project directory,
assets, or renders.

`--force` never overwrites a directory that is not a readable Vamp project. It
returns `cli.init.overwrite_refused` and leaves the directory untouched. There
is no delete command.

#### `init` success data

| Field              | Meaning                                                          |
| ------------------ | ---------------------------------------------------------------- |
| `projectId`        | Project id.                                                      |
| `root`             | Canonical absolute projects root.                                |
| `projectDirectory` | Absolute project directory.                                      |
| `songFile`         | Absolute path to `song.json`.                                    |
| `revision`         | New project revision, 1 for a create and an increment for force. |
| `title`            | Song title from the new song.                                    |
| `overwritten`      | `false` for a create, `true` for `--force`.                      |
| `previousRevision` | Present only when `--force` replaced an existing song.           |
| `nextCommands`     | Supported commands to run next.                                  |

Human output prints the project directory, song file, revision, and next
commands.

### `validate <file>`

```sh
vamp validate <file> [--json]
```

The file is resolved from the current working directory unless it is absolute.
It must be a regular UTF-8 file. Symbolic links are rejected instead of
followed. The read is bounded at 8 MiB; oversized files are rejected before
parsing. The command never writes or rewrites the file.

The command passes `INSTRUMENT_REGISTRY_VALIDATION` from `@gxaditya/vamp-engine`, so an
unknown builtin instrument ID is a hard error. Backend capability is not
checked by this command and is reported as `capabilityCheck: "not_checked"`.

#### `validate` success data

| Field                  | Meaning                                                               |
| ---------------------- | --------------------------------------------------------------------- |
| `file`                 | Path exactly as supplied.                                             |
| `resolvedPath`         | Absolute path that was read.                                          |
| `schemaVersion`        | Validated schema version, currently `1.0.0`.                          |
| `capabilityCheck`      | `not_checked`; rendering backends perform their own capability check. |
| `counts.tracks`        | Number of tracks.                                                     |     | `counts.midiTracks` | Melodic tracks. |
| `counts.drumTracks`    | Drum tracks.                                                          |
| `counts.patterns`      | Defined patterns.                                                     |
| `counts.placements`    | Pattern placements across tracks.                                     |
| `counts.freeNotes`     | Free-form notes across tracks.                                        |
| `counts.patternNotes`  | Notes defined inside patterns, before repeats.                        |
| `counts.authoredNotes` | Free notes plus pattern notes.                                        |

Warnings are returned in the envelope and do not change the exit code. A valid
song with warnings exits 0.

#### `validate` error codes

| Code                                 | Meaning                                                |
| ------------------------------------ | ------------------------------------------------------ |
| `cli.file.invalid_path`              | Empty path or a path containing a NUL byte.            |
| `cli.file.missing`                   | The file does not exist.                               |
| `cli.file.not_file`                  | The path is not a regular file.                        |
| `cli.file.symlink`                   | The final path is a symbolic link.                     |
| `cli.file.too_large`                 | The file exceeds 8 MiB.                                |
| `cli.file.unreadable`                | Permission or I/O failure.                             |
| `cli.file.invalid_utf8`              | The bytes are not valid UTF-8.                         |
| `cli.file.malformed_json`            | JSON parsing failed. The file was not modified.        |
| `cli.validation.unsupported_version` | `schemaVersion` is missing or unsupported.             |
| `cli.validation.invalid`             | Structural or semantic SongSchemaV1 validation failed. |

For `cli.validation.*` failures, `error.issues` contains the complete stable
schema issue list with JSON Pointer paths and repair hints.

### `info <file>`

```sh
vamp info <file> [--json]
```

`info` inspects a JSON song, not audio. It uses the same bounded read,
validation, and instrument allowlist as `validate`, so invalid input returns
the same `cli.file.*` and `cli.validation.*` errors with exit code 1.

Event counts come from `compileValidatedSong` in `@gxaditya/vamp-engine` at 48 kHz.
Duration estimates come from the shared `estimateRenderedDuration` helper in
`@gxaditya/vamp-schema`.

#### `info` success data

| Field                                   | Meaning                                                                                             |
| --------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `file`, `resolvedPath`, `schemaVersion` | Same as `validate` success data.                                                                    |
| `title`                                 | `meta.title`.                                                                                       |
| `bpm`                                   | Constant quarter-note tempo.                                                                        |
| `timeSignature`                         | `{ numerator, denominator }`.                                                                       |
| `key`                                   | `{ tonic, mode }`.                                                                                  |
| `seed`                                  | Explicit `meta.seed`.                                                                               |
| `durationHint.beats`                    | `meta.durationHint` in quarter-note beats.                                                          |
| `durationHint.bars`                     | Hint divided by the song meter's quarter-note bar length.                                           |
| `durationHint.seconds`                  | Hint converted with the constant BPM.                                                               |
| `duration.hintSeconds`                  | Same value as `durationHint.seconds`.                                                               |
| `duration.lastSoundSeconds`             | Last audible content plus capped effect tails.                                                      |
| `duration.estimatedRenderedSeconds`     | `max(hintSeconds, lastSoundSeconds)` from the shared duration formula.                              |
| `counts.*`                              | Same counts as `validate` success data, plus the two rows below.                                    |
| `counts.expandedEvents`                 | Compiled timeline note-event count, including inaudible events.                                     |
| `counts.warnings`                       | Validation warning count.                                                                           |
| `tracks[]`                              | `{ id, name, kind, channel, instrument, volume, pan, mute, solo, freeNotes, placements, effects }`. |
| `instruments[]`                         | `{ type, label, trackIds }` plus `id`, `program`, `bank`, or `path` as applicable.                  |

Static `volume` and `pan` report the documented normalization defaults (`1` and
`0`) when omitted. `mute` and `solo` report `false` when omitted. Banks report
`0` when omitted.

Instrument labels are stable summaries:

- `builtin:<id>`
- `gm:<program>/<bank>`
- `soundfont:<path>#<program>/<bank>`
- `sfz:<path>`

Human output prints one line per track and one line per distinct instrument
group, followed by warnings. Warnings are also in the envelope and do not change
the exit code.

### `render <file>`

```sh
vamp render <file> --out <directory> [options]
```

`render` is a thin adapter over `renderSongArtifacts` in `@gxaditya/vamp-engine`.

`--out` is required. A new output directory is published with one atomic
directory rename, so its parent directory must already exist. An existing
output directory is updated per artifact with rollback protection. Artifact
names are flat in that directory:

| Artifact | Name                                                      |
| -------- | --------------------------------------------------------- |
| Master   | `master.wav`                                              |
| Stem     | `stem-<two digit track index>-<sanitized track name>.wav` |
| MIDI     | `song.mid`                                                |
| Report   | `report.json`                                             |

A bare render writes all four kinds, matching the complete artifact default.

#### Options

| Option                           | Default              | Meaning                                                                                     |
| -------------------------------- | -------------------- | ------------------------------------------------------------------------------------------- |
| `--out <directory>`              | required             | Destination directory. Relative paths resolve from the current working directory.           |
| `--format wav`                   | `wav`                | Only supported format. MP3 export is not implemented in v1; `--format mp3` exits 2.         |
| `--sample-rate <rate>`           | `48000`              | `44100` or `48000`. Unsupported values are usage errors. Audio is never resampled.          |
| `--backend <name>`               | `auto`               | `auto`, `builtin`, or `fluidsynth`. Auto prefers a locally discovered sample path.          |
| `--stems` / `--no-stems`         | write                | Include or omit one post-effect WAV per audible track.                                      |
| `--midi` / `--no-midi`           | write                | Include or omit the Type 1 Standard MIDI File.                                              |
| `--report` / `--no-report`       | write                | Include or omit `report.json`. Report data is returned in the envelope either way.          |
| `--normalize` / `--no-normalize` | on                   | Normalize master and stems to -1 dBFS with at most +9 dB boost.                             |
| `--overwrite`                    | refused              | Permit replacing artifact files from an earlier render.                                     |
| `--fluidsynth-path <path>`       | `fluidsynth` on PATH | FluidSynth executable, absolute or PATH name. Environment fallback `VAMP_FLUIDSYNTH_PATH`.  |
| `--soundfont <path>`             | none                 | Trusted GM `.sf2` for `gm` and curated builtin instruments. Fallback `VAMP_SOUNDFONT_PATH`. |
| `--project-root <dir>`           | song file directory  | Root for song-referenced `.sf2` assets, including confinement checks.                       |
| `--verify-soundfont`             | off                  | Verify the GM SoundFont against the pinned FluidR3 SHA-256.                                 |
| `--json`                         | off                  | Print exactly one JSON envelope on stdout.                                                  |

Passing both a positive and negative switch, such as `--stems --no-stems`, is a
usage error. FluidSynth options passed with `--backend builtin` are also usage
errors rather than silently ignored.

#### Backend selection

The default `auto` backend uses FluidSynth and a locally discovered GM SoundFont
when both are available, and otherwise the built-in synthesizer. It needs no
manual setup when a system font such as FluidR3 GM is installed. The FluidSynth
sample backend can also be selected explicitly:

```sh
vamp render song.json --out out \
  --backend fluidsynth \
  --fluidsynth-path /usr/bin/fluidsynth \
  --soundfont /usr/share/sounds/sf2/FluidR3_GM.sf2 \
  --verify-soundfont
```

The `--soundfont` path may be relative to the current directory; the CLI
resolves it before configuring the backend. A missing executable is reported
before any render work begins.

`--project-root` applies only to `soundfont` instruments whose asset path is
authored relative to a project.

A song that requests `gm`, `soundfont`, or SFZ cannot render on the built-in
fallback. The engine returns `audio.instrument.unsupported_variant` with a hint
that names `--backend fluidsynth` and `--soundfont`. Use the named GM catalog
returned by `list_instruments` for real sampled instruments; the catalog is
data, and the schema accepts any GM program from 0 to 127.

#### `render` success data

| Field          | Meaning                                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `file`         | Path exactly as supplied.                                                                                                      |
| `resolvedPath` | Absolute path that was read.                                                                                                   |
| `format`       | `wav`.                                                                                                                         |
| `sampleRate`   | `44100` or `48000`.                                                                                                            |
| `outputDir`    | Absolute output directory that was published.                                                                                  |
| `backend`      | `builtin` or `fluidsynth`, matching the selected CLI backend.                                                                  |
| `artifacts[]`  | Engine artifact metadata plus an `absolutePath`: role, relative path, format, bytes, SHA-256, WAV report.                      |
| `reportFile`   | `{ path, absolutePath }` for `report.json`, or `null` when `--no-report` was used.                                             |
| `outputs`      | Relative names for master, stems, MIDI, and report. Opted-out entries are `null` or empty.                                     |
| `report`       | The complete `vamp.render-report` v1 object, even when the report file is disabled.                                            |
| `warnings`     | `{ validation, audio }`. Validation warnings are also in the envelope `warnings` array.                                        |
| `summary`      | Title, duration seconds, sample rate, backend ID, artifact and stem counts, MIDI/report flags, peak dBFS, and integrated LUFS. |

Report numbers are finite or `null`. The CLI does not inject `NaN` or
`Infinity` into JSON.

```json
{
  "command": "render",
  "ok": true,
  "data": {
    "file": "song.json",
    "resolvedPath": "/work/song.json",
    "outputDir": "/work/out",
    "format": "wav",
    "sampleRate": 48000,
    "backend": "builtin",
    "artifacts": [
      {
        "role": "master",
        "path": "master.wav",
        "absolutePath": "/work/out/master.wav",
        "format": "wav",
        "bytes": 512044,
        "sha256": "…",
        "wav": { "sampleRate": 48000, "frameCount": 128000 }
      }
    ],
    "reportFile": {
      "path": "report.json",
      "absolutePath": "/work/out/report.json"
    },
    "outputs": {
      "master": "master.wav",
      "stems": [],
      "midi": "song.mid",
      "report": "report.json"
    },
    "report": { "format": "vamp.render-report", "formatVersion": 1 },
    "warnings": { "validation": [], "audio": [] },
    "summary": { "title": "Demo", "sampleRate": 48000, "artifactCount": 3 }
  },
  "warnings": []
}
```

The example abbreviates nested report and artifact fields. Errors use the same
`ok: false`, `error`, `warnings` shape as the other commands.

Human mode prints the output directory, backend, duration, peak, integrated
loudness, clipping count, and absolute artifact paths to stdout. Progress is
written to stderr. `--json` suppresses progress entirely.

#### `render` errors

Expected failures use the standard error envelope. File reads use the same
bounded reader and `cli.file.*` errors as `validate` and `info`. Invalid
songs return `cli.validation.invalid` or `cli.validation.unsupported_version`
with shared schema issues.

Engine issues keep their stable codes, including:

| Code                                   | Meaning                                                        |
| -------------------------------------- | -------------------------------------------------------------- |
| `audio.artifacts.exists`               | An artifact already exists and `--overwrite` was not passed.   |
| `audio.artifacts.output_invalid`       | The output path is a file or has no usable parent directory.   |
| `audio.artifacts.unwritable`           | The destination cannot be inspected or written.                |
| `audio.instrument.unsupported_variant` | The selected backend cannot render the instrument variant.     |
| `audio.backend.missing_dependency`     | The FluidSynth executable was not found.                       |
| `audio.backend.timeout`                | FluidSynth exceeded its bounded timeout.                       |
| `audio.backend.process_failed`         | FluidSynth exited nonzero or was signalled; stderr is bounded. |
| `audio.asset.missing`                  | A required GM or project SoundFont is missing.                 |
| `audio.asset.invalid`                  | A SoundFont is corrupt, wrong format, or oversized.            |
| `audio.asset.confined`                 | A project SoundFont path escapes `--project-root`.             |
| `audio.asset.checksum_mismatch`        | `--verify-soundfont` did not match the pinned digest.          |
| `audio.config.invalid`                 | Invalid backend configuration, such as a missing project root. |
| `audio.cancelled`                      | The engine observed cancellation at a safe boundary.           |

The CLI maps an engine cancellation to `cli.render.cancelled`. Compile failures
use `cli.render.compile_failed` with the underlying issue in `error.details`.
Overwrite errors include a hint that names `--overwrite`; unsupported instrument
errors include a hint that names the FluidSynth flags.

#### Cancellation

`SIGINT` and `SIGTERM` abort the shared artifact renderer through its
`AbortSignal`. The engine checks cancellation before and between tracks, stem
captures, finalization, and publication. It removes the private job directory
and any files this job published, and restores replaced artifacts when an
existing directory was being updated. No partial artifact set is left behind.

An in-flight native FluidSynth call is not interrupted. The current child
process finishes, is reaped, and its temporary files are removed; cleanup then
happens at the next safe boundary. The command waits for that cleanup before
exiting. It returns exit code 1 with `cli.render.cancelled`.

#### Formats and deferred features

WAV is the only render format. `--format mp3` exits 2 with
`cli.usage.unsupported_format`. MP3 export and playback are not implemented in
v1. There is no `play` command, and help does not advertise one.

### `schema`

```sh
vamp schema [--guide] [--json]
```

`schema` prints the canonical SongSchemaV1 JSON Schema from
`@gxaditya/vamp-schema`. It does not read files from the current directory and does not
use the network.

- `vamp schema` prints the raw schema document as pretty JSON.
- `vamp schema --json` prints a success envelope with
  `data.schemaVersion`, `data.schemaId`, and `data.schema`.
- `vamp schema --guide` prints the Markdown schema guide.
- `vamp schema --guide --json` prints a success envelope with
  `data.schemaVersion`, `data.format: "markdown"`, and `data.guide`.

The guide source is `docs/schema-guide.md`. If the guide cannot be found, the
command returns `cli.schema.guide_unavailable` with exit code 1.

## TypeScript SDK

### Surface

All of the following are re-exported unchanged from the owning package or the
client module.

- `@gxaditya/vamp-schema`: `SONG_SCHEMA_ID`, `SONG_SCHEMA_VERSION`,
  `SUPPORTED_SCHEMA_VERSIONS`, `getSongSchemaV1`, `validateSong`,
  `normalizeSong`, `NORMALIZATION_DEFAULTS`, `estimateRenderedDuration`,
  `MAX_RENDER_SECONDS`, `TRACK_TAIL_CAP_SECONDS`, `ISSUE_CODES`,
  `ISSUE_CODE_REFERENCE`, and the generated types `SongSchemaV1`, `Track`,
  `Instrument`, `Note`, `Pattern`, `Placement`, `Automation`, effect variants,
  `ValidationIssue`, `ValidationResult`, `ValidationSuccess`,
  `ValidationFailure`, and `ValidateSongOptions`.
- `@gxaditya/vamp-engine`: `describeInstrumentRegistry` (also as
  `client.listInstruments()`), `CURATED_INSTRUMENT_IDS`,
  `GM_INSTRUMENT_CATALOG`, `GM_DRUM_NOTE_MAP`, `GM_STANDARD_DRUM_KIT`,
  `BGM_PRESETS`, `describeBgmPresets`, `createPresetSong`,
  `selectAutomaticBackend`, `discoverSoundFont`, `INSTRUMENT_REGISTRY_VALIDATION`,
  `renderSongArtifacts`, `renderSongAudio`, `renderSongToWav`, `compileSong`,
  `compileValidatedSong`, `exportMidi`, and `createFluidSynthBackend`.
- `@gxaditya/vamp-project`: `ProjectStore`, `PROJECT_ERROR_CODES`, `PROJECT_LAYOUT`,
  `isValidProjectId`, and the result/snapshot/summary/location types.

The client uses `INSTRUMENT_REGISTRY_VALIDATION` by default, exactly like the
CLI and the MCP server. `renderProject` defaults to `backend: "auto"`, which
prefers FluidSynth plus a locally discovered GM SoundFont and otherwise uses
the built-in synthesizer. Pass `"builtin"` to force the fallback, or pass
`createFluidSynthBackend(...)` output for explicit control (see
[`instruments.md`](./instruments.md)). `renderProject` also normalizes to
-1 dBFS by default; pass `normalize: false` for raw levels.

#### `VampClient`

```ts
const client = new VampClient({
  root: '/abs/path/to/projects', // shared with the CLI and MCP server
  // validation defaults to INSTRUMENT_REGISTRY_VALIDATION
  // limits optionally tightens storage bounds
});
```

Discovery and validation: `describeSchema()`, `listInstruments()`,
`validate(song)`.

Projects: `createProject`, `getProject`, `listProjects`, `getLocation`,
`resolveRenderDirectory`, and the full and granular edits `updateSong`,
`addTrack`, `updateTrack`, `removeTrack`, `addNotes`, `updateNote`,
`removeNote`, `setPattern`, `removePattern`, `setInstrument`. Every edit
requires `expectedRevision` and returns `ProjectResult<ProjectSnapshot>`; a
stale revision fails with `project.revision.conflict` carrying
`expectedRevision` and `actualRevision`.

Rendering:

```ts
const rendered = await client.renderProject('my-song', {
  expectedRevision: snapshot.revision, // optional render pin
  sampleRate: 48000, // 44100 or 48000
  renderPath: 'renders/master-v2', // confined below renders/
  // stems/midi/report default to true, overwrite defaults to false
});
```

`renderProject` returns `ProjectRenderResult`, a union of
`{ ok: true; value: ProjectRenderSuccess }`, the shared `ProjectError` (read,
revision, or confinement failures), and the shared engine failure union
(`stage: 'validation' | 'compile' | 'options' | 'audio' | 'artifacts' |
'cancelled'` with repairable issues). The success value adds `projectId`,
the rendered `revision`, and the confined `renderPath` to the engine result.

## Schema, validation, and the instrument registry

### Validation and normalization API

`validateSong(input, options?)` accepts any programmatic value. The function
performs version dispatch, non-finite scanning, structural validation with
Ajv 2020 and ajv-formats, cross-item semantic checks, and normalization of
successful songs. It never applies Ajv defaults to the caller's object, never
rewrites or migrates the song, and never injects timestamps or seeds.

`normalizeSong(song)` is exported separately for callers that already hold a
validated song. It is pure and returns a deep copy.

#### Result shapes

Success:

```ts
{
  ok: true;
  schemaVersion: '1.0.0';
  song: SongSchemaV1;
  normalized: NormalizedSongV1;
  warnings: ValidationIssue[];
  capabilityCheck: 'checked' | 'not_checked';
}
```

Failure:

```ts
{
  ok: false;
  schemaVersion: string | null; // source version when one was recognized
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}
```

Both arrays are deterministically sorted by JSON Pointer path, then code, then
message. Duplicate issues are removed. Every issue is JSON serializable.

#### Issue shape

```ts
{
  code: IssueCode;
  severity: 'error' | 'warning';
  path: string;   // JSON Pointer, '' for the document root
  message: string;
  hint: string;   // actionable repair guidance
  params?: Record<string, string | number | boolean | null | string[]>;
}
```

Discriminated instrument and effect unions are revalidated against the
matching variant, so an unknown `type` produces one issue at
`/tracks/N/instrument/type` or `/tracks/N/effects/N/type`.

JSON Pointer segments escape `~` as `~0` and `/` as `~1`. Arrays use zero-based
numeric segments. Examples: `/tracks/0/notes/2/velocity`, `/patterns/1/notes/0`,
`/meta/durationHint`.

### Duration helper

`estimateRenderedDuration(song): RenderedDurationEstimate` implements the
duration and tail formula from the schema guide. Validation uses this same
function for the 600 second bound and the trailing-silence warning. It returns:

- `secondsPerBeat`, `hintSeconds`, `lastSoundSeconds`, `renderedSeconds`.
- One `TrackDurationContribution` per track with `audible`, `contentEndBeats`,
  `contentEndSeconds`, `tailSeconds` (capped at 30 and zero for inaudible
  tracks), and `endSeconds`.

### Package exports

`@gxaditya/vamp-schema` exports the schema JSON at
`@gxaditya/vamp-schema/schema/song.schema.json`, the runtime API, issue types and code
reference, generated TypeScript types, version constants, normalization types,
duration helpers, capability types, builtin instrument ids, and the migration
extension point. Package `files` include `dist`, `schema`, and `python`.

### Authoritative registry

`INSTRUMENT_REGISTRY` is the single machine-readable source for curated IDs.
Every entry contains:

| Field                                    | Meaning                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------- |
| `id`, `name`, `category`, `kind`         | Stable builtin ID, display name, family, melodic or percussion.                 |
| `description`                            | Short musical role for agents and docs.                                         |
| `midiProgram`, `midiBank`, `midiChannel` | Suggested MIDI selection and channel metadata.                                  |
| `capabilities`                           | Builtin-synth availability, FluidSynth availability, percussion flag, variants. |
| `sampleBackend`                          | Backend ID, neutral MIDI variant, program, bank, channel, preset name.          |
| `asset`                                  | File name, format, byte size, SHA-256, size ceiling, license, provenance.       |
| `license`, `provenance`                  | Repeated directly for easy inspection and serialization.                        |

`CURATED_INSTRUMENT_IDS` lists the IDs in registry order.
`INSTRUMENT_REGISTRY_VALIDATION` is a ready-made `ValidateSongOptions` value
whose `builtinInstrumentIds` reconciles the schema package's seed allowlist with
this registry.

`describeInstrumentRegistry()` returns a JSON-serializable description.

#### Curated IDs and sample mappings

| ID             | Name                  | Builtin synth | FluidSynth mapping                                 |
| -------------- | --------------------- | ------------- | -------------------------------------------------- |
| `piano.soft`   | Soft Piano            | yes           | GM program 0, bank 0, channel 0 (Acoustic Grand)   |
| `keys.soft`    | Soft Electric Keys    | yes           | GM program 4, bank 0, channel 0 (Electric Piano 1) |
| `bass.sub`     | Synth Sub Bass        | yes           | GM program 38, bank 0, channel 0 (Synth Bass 1)    |
| `pad.warm`     | Warm Pad              | yes           | GM program 89, bank 0, channel 0 (Pad 2, warm)     |
| `guitar.clean` | Clean Electric Guitar | yes           | GM program 27, bank 0, channel 0 (Clean Electric)  |
| `drums.kit`    | Studio Drums          | yes           | Percussion bank 128, program 0, channel 9          |

#### Instrument variants

| Song variant | Sample backend behavior                                                              |
| ------------ | ------------------------------------------------------------------------------------ |
| `builtin`    | Six curated IDs above; unknown IDs fail with `audio.instrument.unknown_builtin`.     |
| `gm`         | Program and bank from the song; melodic tracks only, rendered with the GM SoundFont. |
| `soundfont`  | Program and bank from the song plus a confined project `.sf2` asset.                 |
| `sfz`        | Unsupported by this backend with an actionable capability error.                     |

GM percussion is not portable as a melodic program, so a `gm` instrument on a
drums track is rejected by schema validation and by the backend guard.

### Backend configuration

```ts
import { createFluidSynthBackend } from '@gxaditya/vamp-engine';

const backend = createFluidSynthBackend({
  binaryPath: '/usr/bin/fluidsynth', // or "fluidsynth" from PATH
  gmSoundFont: '/usr/share/sounds/sf2/FluidR3_GM.sf2',
  projectRoot: '/path/to/song-project',
  verifyGmSoundFontChecksum: true,
  timeoutMs: 30_000,
});
```

`projectRoot` is required only for `soundfont` instruments. `gmSoundFont` is
required for `gm` and for the curated builtin mappings. Both checks return
structured errors when missing.

#### Trusted GM SoundFont versus song assets

- `gmSoundFont` is trusted backend configuration. It may live outside the
  project root, for example in `/usr/share/sounds/sf2`. It is still checked for
  file type, size, RIFF/sfbk header, and optional checksum.
- A `soundfont` instrument's `path` is a song asset. It must be relative to
  `projectRoot` and resolve inside that root after realpath. Absolute paths,
  Windows drive paths, backslashes, empty or dot segments, traversal, symlink
  escapes (including escapes through an existing parent directory), missing
  files, directories, wrong extensions, oversized files, and configured
  checksum mismatches are rejected before FluidSynth starts.

Set optional expected digests per project path:

```ts
createFluidSynthBackend({
  projectRoot,
  assetChecksums: { 'assets/piano.sf2': '<64 lowercase hex characters>' },
});
```

#### Capabilities

`createFluidSynthBackend(...).capabilities` declares:

- Instrument types: `builtin`, `gm`, `soundfont`.
- Builtin IDs: the six registry IDs.
- Voice policy: `drop-newest`.

The shared renderer checks these before calling the backend, so unsupported
tracks fail as a group with structured errors. SFZ is explicitly absent.

## Timeline compiler

### Timeline compiler API

```ts
import { validateSong } from '@gxaditya/vamp-schema';
import { compileSong, compileValidatedSong } from '@gxaditya/vamp-engine';

// Reuse a validation result without validating twice.
const validation = validateSong(unknownSong);
if (validation.ok) {
  const compiled = compileValidatedSong(validation, { sampleRate: 48000 });
}
```

`compileSong(input, options)` accepts `unknown` and calls
`validateSong(input, options.validation)`. A validation failure returns the
schema issues with `stage: "validation"` and no timeline. Compile options are
checked before validation.

`compileValidatedSong(validation, options)` accepts only a `ValidationSuccess`
from `validateSong`. It does not validate again, and it reads
`validation.normalized` without mutating it. A malformed token is rejected with
a structured `compile.input.invalid` error rather than throwing.

`sampleRate` is required. The supported rates are `44100` and `48000`.

#### Options

```ts
interface CompileSongOptions {
  sampleRate: 44100 | 48000;
  limits?: Partial<CompileLimits>;
  validation?: ValidateSongOptions; // forwarded only by compileSong
}

interface CompileLimits {
  maxAuthoredNotes: number; // default 10000
  maxExpandedNotes: number; // default 20000
  maxRenderedSeconds: number; // default 600
}
```

Limits may be tightened. Values above the documented hard limits are clamped to
the hard limit, so compile options can never bypass the schema bounds. Note
counts must be positive integers. `maxRenderedSeconds` must be a positive finite
number.

#### Result

```ts
type CompileSongResult =
  | {
      ok: true;
      timeline: SongTimeline;
      warnings: ValidationIssue[];
    }
  | {
      ok: false;
      stage: 'validation';
      errors: ValidationIssue[];
      warnings: ValidationIssue[];
    }
  | {
      ok: false;
      stage: 'compile';
      errors: CompileIssue[];
      warnings: ValidationIssue[];
    };
```

Validation warnings are passed through from `@gxaditya/vamp-schema`. Compile failures keep
validation warnings when validation succeeded. The result is JSON serializable.

## Audio rendering

### Audio rendering API

```ts
import {
  compileSong,
  encodeWav,
  renderSongToWav,
  renderTimelineAudio,
} from '@gxaditya/vamp-engine';

const wav = await renderSongToWav(input, { sampleRate: 48000 });
// On success: wav.bytes (Uint8Array WAV), wav.report, wav.stats, wav.timeline.
// On failure: wav.stage is "validation", "compile", "audio", or "encode".

// PCM path: render one compiled timeline to stereo Float32 channels.
const compiled = compileSong(input, { sampleRate: 48000 });
if (compiled.ok) {
  const pcm = await renderTimelineAudio(compiled.timeline);
  const encoded = encodeWav(pcm.audio); // encoded.bytes, encoded.report
}
```

`renderTimelineAudio(timeline, options?)` consumes a canonical `SongTimeline`.
It does not validate the song, expand patterns, resolve mute or solo, or
recompute duration and tails. It checks only the timeline container shape needed
to prevent crashes and to reject forged input.

`renderSongAudio(input, options)` is the convenience path for an unknown song.
It calls `compileSong` and then `renderTimelineAudio`. `renderSongToWav` adds
`encodeWav` and omits the intermediate Float32 buffer from its success value.
Use `renderSongAudio` plus `encodeWav` when both representations are needed.

`encodeWav(audio)` is synchronous. It accepts only a version 1
`vamp.pcm` stereo buffer.

#### Options

| Option              | Default           | Meaning                                                                                          |
| ------------------- | ----------------- | ------------------------------------------------------------------------------------------------ |
| `sampleRate`        | timeline rate     | Optional guard for `renderTimelineAudio`. Must equal the timeline rate; no resampling is done.   |
| `backend`           | built-in synth    | An `AudioBackend` implementation. The FluidSynth sample backend is one such implementation.      |
| `maxVoicesPerTrack` | 32                | Per-track active voice cap, 1 to 128. A backend must enforce the cap and report drops or steals. |
| `onTrackAudio`      | none              | Optional post-effect stereo capture sink, called once per rendered audible track.                |
| `signal`            | none              | Optional AbortSignal checked before each track and before the final master is returned.          |
| `limits`            | compiler defaults | `renderSongAudio` and `renderSongToWav` forward compile limits.                                  |
| `validation`        | validator default | Forwarded validation options, for example a newer builtin ID registry.                           |

Unknown option keys are rejected with `audio.options.invalid`. Compile options
such as `sampleRate`, `limits`, and `validation` keep their `compile.*` errors at
the compile stage. Audio-specific option failures use `audio.*` codes.

#### Result shapes

`renderTimelineAudio` and `renderSongAudio` success values contain:

- `audio`: `format: "vamp.pcm"`, `formatVersion: 1`, `sampleRate`, `frameCount`,
  `left: Float32Array`, and `right: Float32Array`.
- `stats`: backend ID, voice policy, voice cap, per-track voice counts, event
  counts, master peak, and peak in dBFS.
- `warnings`: JSON-serializable `AudioIssue` values, sorted deterministically.
- For the song convenience path: `timeline` and `validationWarnings`.

When `onTrackAudio` is supplied, it receives one `TrackAudioCapture` per
rendered audible track, immediately after that track's post-effect stereo pair
is summed into the master. The channel arrays are the renderer's reusable
scratch buffers, so the sink must consume them before its promise settles. The
master in this capture path is the float accumulation of the captured pairs.
Inaudible tracks never invoke the sink and never contribute an effect tail.

Failures contain `errors` and `warnings`. The song path adds a `stage` of
`"validation"`, `"compile"`, `"audio"`, or `"encode"`. Expected failures return
values. Invalid songs, unsupported instruments or features, non-finite samples,
and invalid options do not throw.

### Backend interface

```ts
interface AudioBackend {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly capabilities: AudioBackendCapabilities;
  renderTrack(request: AudioTrackRenderRequest): Promise<AudioBackendTrackResult>;
}

interface AudioBackendCapabilities {
  readonly instrumentTypes: readonly ('builtin' | 'gm' | 'soundfont' | 'sfz')[];
  readonly builtinIds: readonly string[];
  readonly voicePolicy: 'drop-newest' | 'steal-oldest';
}

interface AudioTrackRenderRequest {
  readonly track: TimelineTrack;
  readonly events: readonly TimelineNoteEvent[]; // audible events for this track
  readonly sampleRate: 44100 | 48000;
  readonly frameCount: number;
  readonly seed: number;
  readonly maxVoices: number;
  readonly bpm: number; // song tempo for per-track MIDI timing
}
```

A successful track result is
`{ ok: true, samples: Float32Array, stats, warnings }`. `samples` must contain
exactly `frameCount` finite mono samples. A failure is
`{ ok: false, errors: AudioIssue[] }`.

A backend reports `startedVoices`, `droppedVoices`, `stolenVoices`, and
`peakActiveVoices`. The renderer exposes the declared policy as
`stats.voiceCapPolicy` and turns nonzero dropped or stolen counts into
warnings. Non-finite backend audio becomes `audio.samples.non_finite`, and
malformed output becomes `audio.backend.invalid_output`.

## MIDI export and project storage

### MIDI export API

```ts
import { compileSong, exportMidi } from '@gxaditya/vamp-engine';

const compiled = compileSong(input, { sampleRate: 48000 });
if (compiled.ok) {
  const exported = exportMidi(compiled.timeline, {
    includeInaudibleTracks: false,
    endMarker: 'rendered',
  });
  // On success: exported.bytes (Uint8Array, Type 1 SMF) and exported.report:
  // channels, programs, tick resolution, counts, limitations.
  // On failure: exported.errors, structured and JSON-serializable issues.
}
```

`exportMidi(timeline, options?)` accepts only a canonical `SongTimeline`. It
does not accept an authored song and does not compile. Validation, pattern
expansion, mute/solo resolution, duration, and tails are already complete in the
timeline. The convenience flow is `compileSong` or `compileValidatedSong`
followed by `exportMidi`.

The exporter never mutates the timeline, its tracks, its events, or its
automation. Identical timeline and options produce byte-identical output.

#### Options

| Option                   | Default      | Meaning                                                                                             |
| ------------------------ | ------------ | --------------------------------------------------------------------------------------------------- |
| `includeInaudibleTracks` | `false`      | Omit tracks whose resolved `audible` flag is false. Set true to include them with `audible: false`. |
| `endMarker`              | `"rendered"` | Place the final marker at `renderedSeconds`, or at the last included note end with `"content"`.     |
| `omitMixControllers`     | `false`      | Suppress CC7 volume and CC10 pan, including their automation. Used for neutral internal MIDI.       |

`omitMixControllers: true` is the neutral mode used by the FluidSynth sample
backend, whose volume and pan are applied by the shared audio mixer. Note,
program, and bank selection still follow the normal rules, and
`report.includeMixControllers` records whether controllers were emitted.

Unknown option values are rejected with `midi.options.invalid`. Options are not
migrated or silently coerced.

#### Result

Success:

```ts
{
  ok: true;
  bytes: Uint8Array;
  report: MidiExportReport;
}
```

Failure:

```ts
{
  ok: false;
  errors: MidiIssue[]; // code, severity "error", JSON Pointer path, message, hint, params?
}
```

Expected failures return values. `exportMidi` does not throw for malformed
timelines, channel collisions, unsupported limits, or invalid options. An
internal encoder failure is reported as `midi.encode.failed` instead of leaking
an exception.

### Complete render operation

```ts
import { renderSongArtifacts } from '@gxaditya/vamp-engine';

const result = await renderSongArtifacts(songInput, {
  outputDir: 'out',
  sampleRate: 48000,
});

if (!result.ok) {
  // result.stage is "options", "validation", "compile", "audio",
  // "artifacts", or "cancelled".
  // Every issue has a stable code, path, message, and repair hint.
} else {
  // result.outputDir, result.report, result.artifacts, result.timeline
}
```

`renderSongArtifacts` is the single engine operation behind the CLI `vamp
render` command, the MCP `render_song` tool, and the SDK `client.renderProject`.

Default artifact selection is a complete render: master WAV, one stem per
audible track, Type 1 MIDI, and the JSON report. Set `stems`, `midi`, or
`report` to `false` for explicit opt-outs. The master is always produced. The
success value always contains report data even when the report file is disabled.

| Option              | Default  | Meaning                                                                    |
| ------------------- | -------- | -------------------------------------------------------------------------- |
| `outputDir`         | required | Destination directory. Relative paths resolve against the process cwd.     |
| `sampleRate`        | required | `44100` or `48000`. Audio is never resampled.                              |
| `backend`           | built-in | Shared `AudioBackend`. CLI/MCP/SDK default to auto sample selection above. |
| `maxVoicesPerTrack` | 32       | Per-track voice cap, 1 to 128.                                             |
| `limits`            | schema   | Compile limits. They may tighten but not exceed the schema hard bounds.    |
| `validation`        | default  | Validation options, for example an instrument registry allowlist.          |
| `stems`             | `true`   | Write one post-effect stereo WAV per audible track.                        |
| `midi`              | `true`   | Write a Type 1 Standard MIDI File.                                         |
| `report`            | `true`   | Write `report.json`. Report data is returned either way.                   |
| `mastering`         | off      | `{ normalize?, targetDbfs?, maxBoostDb? }` deterministic master/stem gain. |
| `overwrite`         | `false`  | Permit replacing existing artifact files.                                  |
| `signal`            | none     | AbortSignal checked before and between tracks, artifacts, and publishes.   |

Unknown option keys are rejected with `audio.options.invalid`.

### Project storage API

```ts
import { ProjectStore } from '@gxaditya/vamp-project';

const store = new ProjectStore({
  root: '/absolute/path/to/projects',
  // Optional validation override, for example the engine registry allowlist.
  validation: { builtinInstrumentIds: ['keys.soft', 'bass.sub'] },
});

const created = await store.create({ projectId: 'demo', song });

if (created.ok) {
  const snapshot = await store.updateSong('demo', {
    expectedRevision: created.value.revision,
    song: replacementSong,
  });
}
```

Every public operation returns a discriminated result. Success is
`{ ok: true, value }`. Expected failures are `{ ok: false, code, message, hint,
... }` values. Public methods also catch unexpected exceptions and convert them
to `project.internal`, so callers do not need a try/catch for expected
conditions.

#### Project operations

| Method                                              | Purpose                                                                 |
| --------------------------------------------------- | ----------------------------------------------------------------------- |
| `create({ projectId, song })`                       | Validate the song, reserve the project directory, and write revision 1. |
| `get(projectId)`                                    | Resolve metadata and the complete validated song.                       |
| `list()`                                            | Return complete projects sorted by project id.                          |
| `getLocation(projectId)`                            | Return the confined project, song, assets, and renders paths.           |
| `updateSong(projectId, { expectedRevision, song })` | Replace the complete song after validation.                             |

#### Granular edits

| Method                                                                  | Identity and semantics                                                                                |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `addTrack(projectId, { expectedRevision, track, index? })`              | Appends or inserts a complete track. Duplicate track ids are rejected before saving.                  |
| `updateTrack(projectId, { expectedRevision, trackId, changes })`        | Patches only `name`, `channel`, `volume`, `pan`, `mute`, and `solo`. Unknown patch keys are rejected. |
| `removeTrack(projectId, { expectedRevision, trackId })`                 | Removes one track, then validates the complete song.                                                  |
| `addNotes(projectId, { expectedRevision, trackId, notes, index? })`     | Appends or inserts free notes on one track.                                                           |
| `updateNote(projectId, { expectedRevision, trackId, noteIndex, note })` | Replaces one free note by positional index.                                                           |
| `removeNote(projectId, { expectedRevision, trackId, noteIndex })`       | Removes one free note by positional index.                                                            |
| `setPattern(projectId, { expectedRevision, pattern })`                  | Replaces the pattern with the same id in place, or appends a new pattern.                             |
| `removePattern(projectId, { expectedRevision, patternId })`             | Removes a pattern, then validates that placements still resolve.                                      |
| `setInstrument(projectId, { expectedRevision, trackId, instrument })`   | Replaces one track instrument.                                                                        |

`updateSong` is explicit full replacement. The granular methods are explicit
partial edits over a loaded revision. Every edit clones the loaded validated
song, mutates only the named part, validates the complete result, and only then
stages a write.

#### Asset and render paths

| Method                                              | Purpose                                                                                  |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `resolveAsset(projectId, relativePath)`             | Resolve an existing asset below `assets/`; returns its canonical absolute path and size. |
| `readAsset(projectId, relativePath, { maxBytes? })` | Read a confined asset with a byte bound.                                                 |
| `resolveRenderDirectory(projectId, relativePath?)`  | Resolve a destination below `renders/`. The destination may not exist yet.               |

Asset paths are relative to the project directory and must begin with `assets/`,
matching the string stored in a song instrument reference. For example, a song
stores `assets/piano.sf2`, and the resolver returns
`<projects-root>/<project-id>/assets/piano.sf2` after realpath checks. Render
paths must begin with `renders/`; the default is `renders` itself.

Every create and update also checks SoundFont and SFZ references in the
resulting song for lexical and realpath confinement. A referenced asset that is
not provisioned yet is allowed at save time. An existing non-file or a symlink
escape is rejected before the song is written. Oversized assets are rejected
when they are resolved or read.
