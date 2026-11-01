# Vamp

Vamp is a fully local, headless music engine for coding agents: an
agent-friendly, versioned song format with an offline renderer, CLI, MCP server,
and SDK, built so an agent authoring code-to-video work can produce original,
editable background music on its own machine instead of calling a cloud music
service. The authoring guidance is in
[`docs/schema-guide.md`](./docs/schema-guide.md).

## Why this replaces Suno for agent code-to-video BGM

- **Local and unlimited.** No account, credit meter, queue, or cloud music API.
  A render is a local process over a versioned JSON file.
- **Editable at the source.** The song is data: notes, velocities, instruments,
  a 2-4 chord loop, drum patterns, effects, and automation. A revision-safe edit
  changes the music, not a prompt lottery.
- **Real instruments by default when provisioned.** The default `auto` backend
  renders sampled General MIDI through FluidSynth and a local SoundFont. The
  oscillator synth remains only as a dependency-free fallback.
- **Built for narration.** The presets and guide favor pads, e-piano, clean or
  muted guitar, finger or sub bass, sparse melodies, groove, and low-passed
  beds that leave the speech band open. They do not default to square leads or
  nursery-rhyme tunes.
- **Agent-native.** MCP exposes health, schema, a named 56-preset GM catalog, a
  drum map, five complete BGM recipes, project editing, and render/repair with
  structured errors and reports.
- **Auditable output.** Every render returns master WAV, per-track stems, MIDI,
  and a report with duration, peak, mastering gain, clipping, LUFS, backend,
  warnings, and hashes.

The tradeoff is that Vamp composes explicitly rather than generating a finished
vocal song from a text prompt. For code-to-video background beds, that
constraint is the point: a stronger agent can author and revise the exact cue,
and a mid-tier model can start from a preset.

> **Status.** V1 is feature complete and verified on Linux. The macOS and
> Windows CI legs are authored but have not been executed, as the CI section
> below records. Nothing is published to npm, and the license and package names
> are still open decisions.
> The canonical v1 JSON Schema, generated TypeScript and Python types, structural
> and semantic validation, normalization, duration helpers, and version dispatch
> exist in `@gxaditya/vamp-schema`. `@gxaditya/vamp-engine` compiles validated songs into a
> deterministic, sample-aware event timeline, exports that timeline as a Type 1
> Standard MIDI File with a structured report, and renders it offline through
> either a real FluidSynth SoundFont backend (the default when the executable
> and a GM SoundFont are found locally) or the dependency-free built-in
> synthesizer fallback. The shared pipeline evaluates volume,
> pan, and low-pass cutoff automation and applies the complete v1 track effect
> chain (reverb, delay, three-band EQ, and low-pass) in authored order with
> finite, deterministic tails. `renderSongArtifacts` produces a master WAV,
> aligned post-effect stems, MIDI, and a JSON report with peak, clipping,
> approximate integrated LUFS, backend and asset metadata, seed, warnings, and
> output paths. It writes through a private job directory, refuses overwrites by
> default, cleans up on failure or cancellation, and publishes atomically where
> the platform allows. The authoritative instrument registry covers six curated
> dual-backend IDs, a named 56-preset General MIDI catalog, the GM drum map, the
> FluidR3 GM asset provenance and checksum, and project asset confinement. Five
> BGM preset packs generate complete arrangements with real sampled instruments,
> groove, velocity variation, effects, and a duration-correct tail. Master and
> stems are normalized to -1 dBFS by default with one shared gain. `@gxaditya/vamp-project`
> provides filesystem projects containing `song.json`, `assets/`, `renders/`, and
> private revision metadata, with validated atomic edits, stale-revision
> conflicts, bounded writer locks, and root confinement for assets and render
> destinations.
> The CLI provides `init`, `validate`, `info`, `render`, `schema`, `presets`, and `doctor` with
> consistent human and JSON output, stable exit codes, bounded file reads, and
> project-root defaults. `vamp render song.json --out out/` writes a master WAV,
> stems, MIDI, and a report offline, with explicit opt-outs, sample-rate and
> backend choices, overwrite control, and cancellation cleanup. WAV is the only
> render format. MP3 export and `play` are not implemented and are not
> advertised. The `@gxaditya/vamp-mcp-server` package provides a runnable stdio MCP
> server with `health_check`, `get_schema_guide`, `list_instruments`, and
> `list_presets`, the authoring and edit tools `validate_song`, `create_song`,
> `get_song`, `list_projects`, `update_song`, `add_track`, `add_notes`,
> `set_pattern`, and `set_instrument`, and the `render_song` tool that renders a saved revision into
> that project's confined `renders/` tree through the shared engine operation and
> returns artifact paths, the revision rendered, the report, and warnings. All
> tools are revision-safe and confined to the configured project root, with a
> protocol-safe lifecycle and a bounded render lifecycle: concurrent renders are
> capped, extra calls queue up to the pending limit, and timeouts, busy queues,
> cancellation, and shutdown are actionable structured errors. The thin typed
> `@gxaditya/vamp-sdk` calls the shared schema, engine, and project libraries directly,
> so embedded TypeScript consumers can discover the schema and instruments,
> create, edit, validate, render, inspect, and re-render projects locally with
> the same result, error, and revision contracts, no HTTP, no service, and no
> required native dependency (auto uses FluidSynth samples when present). Runnable offline examples live in `examples/`, and the
> agent-ready song library there holds five authored BGM cues (lo-fi coding bed,
> upbeat explainer, ambient focus bed, corporate bed, and a tension stinger) with
> per-cue briefs, exact duration math, verified render commands, and revision-safe
> edit prompts.
> Packages are licensed AGPL-3.0-only and prepared for npm as
> `@gxaditya/vamp-*` at version 0.1.0. Tarballs were packed and tested as local
> files; `pnpm -r publish`, name verification, and git tagging remain the final
> manual steps.

## Prerequisites

- Node.js 22 LTS or newer, with at least 22.13 within the 22.x line for the
  development toolchain. These checks were run with Node.js v24.18.0.
- pnpm 10.15.1, enabled through Corepack:

  ```sh
  corepack enable
  corepack prepare pnpm@10.15.1 --activate
  ```

- Python 3.11 or newer to run the generated Python type import check. The check
  uses only the Python standard library and does not require a Python SDK.
- **Strongly recommended** sample rendering: FluidSynth 2.x and a provisioned
  GM SoundFont. The verified configuration is FluidSynth 2.3.4 with FluidR3 GM
  3.1 (MIT, 148,398,306 bytes, SHA-256
  `74594e8f4250680adf590507a306655a299935343583256f3b722c48a1bc1cb0`). The asset
  is not committed. On Debian/Ubuntu:

  ```sh
  sudo apt install fluidsynth fluid-soundfont-gm
  pnpm exec vamp doctor
  ```

  On macOS, `brew install fluid-synth` plus a GM `.sf2` in
  `~/.local/share/vamp/soundfonts/` (or set `VAMP_SOUNDFONT_PATH`). On Windows,
  install FluidSynth and place a GM `.sf2` in `%ProgramData%\Vamp\soundfonts\`
  (or set `VAMP_SOUNDFONT_PATH`). The CLI, MCP server, and SDK auto-discover the
  font; nothing is downloaded during a render. See
  [`docs/instruments.md`](./docs/instruments.md) for the search order, pinned
  checksum, and license. Without a font, Vamp falls back to the six-voice
  built-in synth.

No audio device or network access is required for rendering or checks. Network
access is needed only to install dependencies or to provision external assets
once during setup.

## Install and validate the workspace

From the repository root:

```sh
pnpm install
pnpm check:generated
pnpm check:python-types
pnpm build
pnpm lint
pnpm typecheck
pnpm test
pnpm format:check
```

`pnpm typecheck` and `pnpm test` build the workspace themselves because tests
exercise the compiled CLI and resolved workspace packages. `pnpm test` is not
just a source-level unit test run.

`pnpm check:generated` fails when checked-in generated types differ from the
canonical schema. Regenerate both TypeScript and Python types from the repository
root with:

```sh
pnpm generate:types
```

`pnpm check:python-types` imports the generated `vamp_schema` TypedDicts and
resolves their forward references with the Python standard library only.

If a SoundFont is provisioned for native sample rendering, verify its pinned
size and SHA-256 without network access:

```sh
pnpm verify:soundfont /usr/share/sounds/sf2/FluidR3_GM.sf2
```

Use `pnpm clean` to remove generated `dist/` directories, the build-copied
per-package `THIRD_PARTY_NOTICES.md` files, and `coverage/`, and
`pnpm format` / `pnpm format:check` for Prettier.

## Run the locally built CLI

Build first, then use the workspace-local `vamp` binary (linked from
`packages/cli/package.json` by `pnpm install`):

```sh
pnpm build
pnpm exec vamp --help
pnpm exec vamp --version
```

You can also run the built entrypoint directly:

```sh
node packages/cli/dist/index.js --help
node packages/cli/dist/index.js --version
```

`packages/cli/bin/vamp.js` is a small checked-in launcher with the `vamp` bin
mapping. It loads the compiled entrypoint and prints a build hint if `dist/` is
missing; the compiled entrypoint also carries a shebang and an executable bit.
Both invoke the same implementation.

The reported version comes from `packages/cli/package.json`. Help and version
exit with status 0. Unknown commands, unknown options, and missing arguments
print an error to stderr and exit with status 2.

### Complete terminal workflow

The CLI provides `init`, `validate`, `info`, `render`, `schema`, `presets`, and
`doctor`. Every command is non-interactive, works without an audio device or
network, and never rewrites a song unless `init --force` explicitly asks it to.
WAV is the only render format. MP3 export and `play` are not implemented and are
not advertised.

```sh
pnpm build

# 0. Check the real sample path (FluidSynth, SoundFont, one-note smoke render).
pnpm exec vamp doctor

# 1. Create a complete 45 s lo-fi BGM project from a preset.
pnpm exec vamp init lofi-demo --preset lofi --duration 45 --bpm 90

# 2. Validate the generated song.
pnpm exec vamp validate vamp-projects/lofi-demo/song.json

# 3. Render a complete artifact set offline. Auto uses FluidSynth + SoundFont.
pnpm exec vamp render vamp-projects/lofi-demo/song.json \
  --out vamp-projects/lofi-demo/renders/master


# 4. Inspect the report from a JSON render.
pnpm exec vamp render vamp-projects/lofi-demo/song.json \
  --out vamp-projects/lofi-demo/renders/inspect --json |
  node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const e=JSON.parse(s);console.log(e.data.report.duration,e.data.report.audio,e.data.report.backend)})'

# 5. Edit vamp-projects/lofi-demo/song.json with your tooling, then re-render.
pnpm exec vamp render vamp-projects/lofi-demo/song.json \
  --out vamp-projects/lofi-demo/renders/master --overwrite

# Optional: force FluidSynth and verify the pinned FluidR3 checksum.
pnpm exec vamp render vamp-projects/lofi-demo/song.json \
  --out vamp-projects/lofi-demo/renders/fluid \
  --backend fluidsynth \
  --fluidsynth-path /usr/bin/fluidsynth \
  --soundfont /usr/share/sounds/sf2/FluidR3_GM.sf2 \
  --verify-soundfont

# Optional: raw authored levels without mastering gain.
pnpm exec vamp render vamp-projects/lofi-demo/song.json \
  --out vamp-projects/lofi-demo/renders/raw --no-normalize
```

A bare `render` writes `master.wav`, one post-effect `stem-*.wav` file per
audible track, `song.mid`, and `report.json`. It refuses to replace existing
artifacts without `--overwrite` and publishes through the engine's private job
directory. Use `--sample-rate 44100` or `--sample-rate 48000` (the default), and
`--no-stems`, `--no-midi`, or `--no-report` for explicit opt-outs. The success
envelope always contains the full report, even when the report file is disabled.
Progress goes to stderr in human mode and is suppressed for `--json`, where
stdout contains exactly one envelope.

`vamp init` creates `./vamp-projects/demo/` by default, containing the shared
project layout (`song.json`, `assets/`, `renders/`, and private revision
metadata). Without `--preset` the template is a small SongSchemaV1 demo using
builtin `keys.soft`, `bass.sub`, and `drums.kit`. With `--preset` it generates a
complete arrangement: tine e-piano or electric grand, finger or picked bass,
pads or strings, a sparse melody, a varied drum groove, per-track effects, and a
duration-correct tail. The default auto backend renders presets through
FluidSynth and a discovered GM SoundFont when available; `vamp doctor` tells you
which path is active.

Defaults and options:

| Setting       | Default           | Option                                 |
| ------------- | ----------------- | -------------------------------------- |
| Project id    | `demo`            | `vamp init [project-id]`               |
| Projects root | `./vamp-projects` | `--root <dir>`                         |
| Song title    | `Vamp Demo`       | `--title <title>`                      |
| BGM preset    | none (demo)       | `--preset lofi` (or other preset ID)   |
| Duration      | preset default    | `--duration <seconds>` with `--preset` |
| Tempo         | preset default    | `--bpm <tempo>` with `--preset`        |
| Overwrite     | refused           | `--force` after reading the revision   |

A relative projects root is resolved from the current working directory and
created if missing. `ProjectStore` requires an absolute existing root, so the
CLI resolves and creates the root before delegating. Project ids follow
`ProjectStore` rules: 1 to 64 lowercase ASCII letters, digits, `.`, `_`, and `-`,
starting and ending with a letter or digit.

Running `pnpm exec vamp init demo` again exits 1 with `project.exists` and
leaves the song unchanged. `pnpm exec vamp init demo --force` reads the existing
project revision and replaces only its song with the template through
`ProjectStore.updateSong`, incrementing the revision and preserving assets and
renders. It refuses to overwrite a directory that is not a readable Vamp
project.

`validate`, `info`, and `render` resolve their file argument from the current
working directory or accept an absolute path. They read regular UTF-8 files
only, reject symbolic links, and bound reads at 8 MiB before parsing. `validate`
uses the shared `@gxaditya/vamp-schema` validator with the engine instrument registry.
`info` reports song metadata, duration hints, counts, tracks, and instruments;
it inspects JSON, not audio. `render` passes the parsed document to the shared
engine artifact operation, which performs validation, compilation, rendering,
stem capture, report generation, and publication exactly once. Successful
validation with warnings still exits 0.

The default `auto` backend uses FluidSynth plus a locally discovered GM
SoundFont when both are available, otherwise the dependency-free built-in
synthesizer. A song that requests `gm` or `soundfont` instruments still fails on
the built-in fallback with `audio.instrument.unsupported_variant` and a hint to
select FluidSynth; it is never silently substituted. `--fluidsynth-path`
accepts an absolute path or a PATH name (`VAMP_FLUIDSYNTH_PATH` fallback).
`--soundfont` selects the trusted GM asset (`VAMP_SOUNDFONT_PATH` fallback);
without it, the CLI checks `VAMP_SOUNDFONT_DIR`, the Vamp data directory, and
standard system SoundFont directories. `--project-root` defaults to the song
file directory and confines song-referenced `.sf2` assets. `--verify-soundfont`
checks the pinned FluidR3 digest. All asset setup happens before a render; no
asset is downloaded during rendering.

`SIGINT` and `SIGTERM` abort a render through the engine `AbortSignal`. Job
outputs and native temporary files are cleaned up and no partial artifacts are
published, with one explicit boundary: an in-flight FluidSynth call is not
interrupted, so cleanup happens at the next safe boundary. A cancelled render
exits 1 with `cli.render.cancelled`.

### Musical examples

`examples/songs/` holds the v1 BGM library: five original, editable
`SongSchemaV1` cues written for code-to-video work. Every one of them is authored
with the six curated built-in instrument IDs, so all five render offline with no
native dependency and no assets. The same files render through FluidSynth and a
discovered GM SoundFont with the default auto backend, where those IDs play as
GM presets, and normalization lifts the master to a -1 dBFS peak.

| Song                          | Use                      | Length | BPM | Key     | Guide                                 |
| ----------------------------- | ------------------------ | ------ | --- | ------- | ------------------------------------- |
| `lofi-coding-bed.song.json`   | Lo-fi coding bed         | 45 s   | 90  | A minor | `examples/songs/lofi-coding-bed.md`   |
| `explainer-upbeat.song.json`  | Tutorial and explainer   | 30 s   | 112 | G major | `examples/songs/explainer-upbeat.md`  |
| `ambient-focus-bed.song.json` | Ambient and focus        | 60 s   | 60  | A minor | `examples/songs/ambient-focus-bed.md` |
| `corporate-bed.song.json`     | Corporate and clean bed  | 30 s   | 108 | C major | `examples/songs/corporate-bed.md`     |
| `tension-stinger.song.json`   | Dramatic tension stinger | 6 s    | 110 | D minor | `examples/songs/tension-stinger.md`   |

```sh
pnpm build
mkdir -p /tmp/vamp-renders
pnpm exec vamp info examples/songs/lofi-coding-bed.song.json
pnpm exec vamp render examples/songs/lofi-coding-bed.song.json \
  --out /tmp/vamp-renders/notebook-drift
```

A brand-new `--out` directory is published with one atomic directory rename, so
its parent must already exist. `/tmp/vamp-renders` is created above for that
reason; every `/tmp/vamp-renders/...` command in this repository's guides
assumes it.

Each guide states the target duration, the instrumentation and voicing, why the
arrangement leaves room for narration, the exact duration arithmetic behind its
`durationHint` (including the 45 second cue whose hint is 67.5 beats, not a whole
number of bars), the verified report figures, and concrete revision-safe edit
prompts. `examples/README.md` catalogs the library and carries the human audition
checklist, because automated tests can prove that a cue is valid, offline, and
exactly as long as declared but cannot establish musical quality. No generated
WAV, MIDI, or stem bytes are committed.

### Exit codes

| Code | Meaning                                                                        |
| ---- | ------------------------------------------------------------------------------ |
| 0    | Success, including validation success with warnings.                           |
| 1    | Validation, file, project, render, or runtime failure, including cancellation. |
| 2    | Usage error: unknown command, option, or argument.                             |

### JSON envelopes

`--json` keeps stdout to exactly one JSON document and writes no expected
failure diagnostics to stderr. It can appear before or after the command.

Success:

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

Failure:

```json
{
  "command": "validate",
  "ok": false,
  "error": {
    "code": "cli.file.malformed_json",
    "message": "Song file \"bad.json\" is not valid JSON.",
    "hint": "Fix the JSON syntax and retry. The file was not modified.",
    "path": "bad.json"
  },
  "warnings": []
}
```

Schema validation failures include `error.issues` with stable codes, JSON
Pointer paths, messages, and repair hints. Unsupported or missing schema
versions use the distinct `cli.validation.unsupported_version` command code
while preserving the shared `schema.version.*` issues.

`schema` prints the raw canonical JSON Schema by default, the Markdown guide
with `--guide`, and the envelope form with `--json`. The guide is copied into
`packages/cli/dist/schema-guide.md` at build time, so these commands do not use
the network.

See the [API reference](./docs/api.md) for every field, option, error code, and
the `init`, `validate`, and `info` contracts.

## Run the local MCP server

The stdio MCP server lives in `packages/mcp-server`. It uses
the official TypeScript MCP SDK, reserves stdout for MCP protocol traffic, sends
all diagnostics to stderr, and starts even when optional native dependencies are
absent. It exposes discovery, health, the authoring and granular edit tools, and
`render_song`, all confined to the configured project root and revision-safe.
Fourteen tools cover the whole agent loop: discover, author, validate, save,
render, read the report, repair, and re-render.

```sh
pnpm build
pnpm exec vamp-mcp --help
pnpm exec vamp-mcp --version
pnpm exec vamp-mcp --project-root "$PWD/vamp-projects"
```

The built entrypoint also runs directly:

```sh
node packages/mcp-server/dist/main.js --project-root "$PWD/vamp-projects"
```

A generic stdio MCP client can launch the same absolute path:

```json
{
  "mcpServers": {
    "vamp": {
      "command": "node",
      "args": [
        "/absolute/path/to/vamp/packages/mcp-server/dist/main.js",
        "--project-root",
        "/absolute/path/to/vamp-projects"
      ]
    }
  }
}
```

The project root and native dependency paths can also be supplied through
`VAMP_PROJECT_ROOT`, `VAMP_FLUIDSYNTH_PATH`, and `VAMP_SOUNDFONT_PATH`. When no
SoundFont is configured, the server discovers one from `VAMP_SOUNDFONT_DIR`,
`~/.local/share/vamp/soundfonts`, and standard system SoundFont directories.
Discovery is filesystem-only and never downloads. Arguments take precedence over
environment variables. The project root is optional for the
discovery tools and required by every project read, edit, and render tool, which
return `mcp.project_root.not_configured` when it is absent. A missing or invalid
root is reported by `health_check` with a stable `@gxaditya/vamp-project` code and does
not prevent startup.

Discovery tools:

| Tool               | Purpose                                                                                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `health_check`     | Report the default backend, FluidSynth, discovered SoundFont, a one-note smoke render, schema and backend versions, project-root status, and job settings. |
| `get_schema_guide` | Return the authoritative `docs/schema-guide.md`, including timing, instruments, effects, duration, BGM recipes, and the render workflow.                   |
| `list_instruments` | Return curated IDs, the named 56-preset GM catalog, the drum map, mappings, licenses, provenance, checksums, and availability.                             |
| `list_presets`     | Return the five BGM recipe packs with tempo, key, chord loop, instruments, groove, arrangement, mix, and pitfalls.                                         |

Authoring and edit tools, all confined to the configured root and validated
through `@gxaditya/vamp-schema` and `@gxaditya/vamp-project`:

| Tool             | Purpose                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------ |
| `validate_song`  | Validate unsaved song data in place, surfacing stable issues and warnings, without writing a project.  |
| `create_song`    | Create a project at revision 1 from a complete song or a BGM preset, after full-song validation.       |
| `get_song`       | Read one project and its current revision, song, and warnings.                                         |
| `list_projects`  | List projects and revisions in the configured root.                                                    |
| `update_song`    | Replace the whole song at an `expectedRevision`.                                                       |
| `add_track`      | Append or insert one track by unique id at an `expectedRevision`.                                      |
| `add_notes`      | Append or insert free notes on a track; notes are positional within the current revision.              |
| `set_pattern`    | Create or replace one pattern by stable id at an `expectedRevision`.                                   |
| `set_instrument` | Replace one track instrument with a valid reference from `list_instruments`, confined for asset paths. |

Every persisted edit requires `expectedRevision`. A successful edit increments the
revision by exactly one and returns the resulting revision, project and song
identity, and warnings. A stale revision returns a repairable
`project.revision.conflict` with both revisions and changes nothing, so a retried
call cannot duplicate tracks or notes.

Render tool, confined to the same root and driven by the shared engine operation
`renderSongArtifacts`:

| Tool          | Purpose                                                                                                                                   |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `render_song` | Render one saved revision into that project's confined `renders/` tree and return artifact paths, the revision, the report, and warnings. |

`render_song` inputs are `projectId`, optional `expectedRevision`, optional
`renderName`, optional `backend` (`auto` by default, or `builtin`/`fluidsynth`),
optional `sampleRate`, `stems`, `midi`, `report`, `normalize`, and `overwrite`.
Auto uses the server-configured or locally discovered FluidSynth path and falls
back to the built-in synth with a note; a tool argument never points at a path.
Normalization is on by default and applies one deterministic gain to the master
and every stem to reach a -1 dBFS peak target. It reads the stored song, takes a
validated in-memory snapshot so a concurrent edit cannot change the data
mid-render, resolves the destination through `ProjectStore` confinement, and
waits until every file is published before returning success. The default
`renderName` is `render-<revision>`, so a re-render after an edit keeps the
earlier render intact.

Renders run inside the bounded job settings: at most `--max-concurrent-renders`
execute, at most `--max-pending-jobs` wait, and each running render has a
`--render-timeout-ms` deadline. Beyond those bounds the tool answers
`render.busy`, a render past its deadline answers `render.timeout`, and
cancellation or shutdown answers `render.cancelled`. None of them publishes
partial artifacts, because the engine aborts at artifact boundaries and removes
its private job directory. Shutdown aborts active renders so native children and
job output are cleaned up; an in-flight native backend call finishes before that
boundary cleanup.

The recommended agent loop is therefore: `health_check`, `get_schema_guide`,
`list_instruments`, and `list_presets` for discovery, `validate_song` for a
draft, `create_song` to save (or to generate a preset cue), `get_song` to read
the current revision, `render_song` for that revision,
read the report (duration, peak, loudness, clipping, stems, artifact hashes) and
the warnings, repair the data with the edit tools against the new revision, and
`render_song` again. See the
[MCP server reference](./docs/mcp.md) for full inputs, results, structured
errors, and the revision-safe edit loop.

Missing FluidSynth or SoundFont setup is distinguished from a broken built-in
renderer. The server performs no network or model calls. See the
[MCP server reference](./docs/mcp.md) for configuration bounds, output shapes,
protocol safety, lifecycle, and tests.

## Agent quickstart

MCP client setup for Claude Code, Cursor, and Codex is in
[`docs/mcp.md`](./docs/mcp.md). The short version, on any of the three surfaces:

1. Discover: `vamp doctor`, `vamp schema --guide`, `vamp presets`, MCP
   `health_check`, `get_schema_guide`, `list_instruments`, and `list_presets`.
   The named GM catalog is the instrument menu; reserve the six curated builtin
   IDs for machines without a SoundFont.
2. Start from a preset or author an editable `SongSchemaV1` JSON song. For a
   named brief prefer `vamp init my-cue --preset lofi` or MCP
   `create_song({ preset: "lofi", durationSeconds: 45 })`. Convert custom
   target seconds to beats first: `beats = seconds * bpm / 60`.
3. Validate: `vamp validate song.json`, MCP `validate_song`, or
   `client.validate(song)`. Fix every error from its code, JSON Pointer path,
   and hint.
4. Save and render: `vamp render song.json --out out/`, MCP `create_song` then
   `render_song`, or `client.createProject(...)` then `client.renderProject(...)`.
   The default auto backend uses real samples when provisioned and normalizes
   the master and stems to -1 dBFS.
5. Read the report before shipping: duration delta, peak, mastering gain,
   clipping, approximate LUFS, backend, and warnings.
6. Edit against the exact revision you read (`expectedRevision`), and re-render.
   Stale revisions return `project.revision.conflict` and change nothing.

## Workspace layout

| Path                  | Purpose                                                                                                                                                                                                                                        |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/schema`     | Canonical v1 JSON Schema, generated TypeScript/Python types, validator, normalization, and duration helpers.                                                                                                                                   |
| `packages/engine`     | Deterministic song-to-timeline compiler, Standard MIDI exporter, built-in synthesizer, FluidSynth sample backend, shared automation and effects DSP, offline stereo PCM/WAV renderer, instrument registry, stem and report artifact operation. |
| `packages/project`    | Filesystem project storage over validated songs: revision-safe edits, atomic writes, bounded locks, and root confinement for assets and render destinations.                                                                                   |
| `packages/cli`        | The `vamp` command-line adapter: init, validate, info, render, schema, and structured JSON output.                                                                                                                                             |
| `packages/mcp-server` | Stdio MCP server with protocol-safe lifecycle, configuration, health, schema-guide, and instrument-discovery tools, revision-safe authoring and edit tools, and a bounded `render_song` tool over the shared packages.                         |
| `packages/sdk`        | Thin typed TypeScript SDK: a local client facade over the shared schema, engine, and project libraries with the same result/error/revision contracts.                                                                                          |
| `examples/`           | Runnable offline SDK examples plus the five agent-ready BGM song cues and their guides.                                                                                                                                                        |
| `docs/`               | Architecture, the consolidated API reference for the CLI, SDK, and package surfaces, the song schema guide, validation issue codes, the MCP server, and instruments and assets.                                                                |
| `test/`               | Cross-package tests, including enforcement of workspace dependency boundaries.                                                                                                                                                                 |
| `scripts/`            | Small cross-platform repository scripts for cleaning and bin permissions.                                                                                                                                                                      |

See [`docs/architecture.md`](./docs/architecture.md) for package
responsibilities, the enforced dependency direction, and the intended
schema → normalized song → engine → artifacts data flow. `@gxaditya/vamp-project`
provides the validated save and edit layer around that flow.

The canonical song schema is
[`packages/schema/schema/song.schema.json`](./packages/schema/schema/song.schema.json)
with fixtures under [`packages/schema/fixtures`](./packages/schema/fixtures).
Units, defaults, instrument variants, effects, duration behavior, resource
bounds, and agent-oriented BGM guidance are documented in the
[schema guide](./docs/schema-guide.md). Validation, issue codes, normalization,
generated types, and duration helpers are documented in the
[validation reference](./docs/validation.md). Instrument IDs, curated sample
mappings, the FluidR3 GM license/checksum, and provisioning are in the
[instrument and asset reference](./docs/instruments.md). Every callable surface
is collected in one place: the [API reference](./docs/api.md) covers the CLI
command contracts, exit codes, and JSON envelopes, the SDK surface and shared
result/error/revision contracts, and the public exports and option and result
types of `@gxaditya/vamp-schema`, `@gxaditya/vamp-engine`, and `@gxaditya/vamp-project`, including the
timeline, MIDI, audio, artifact, stem, and report operations and the project
storage layer. System design, revision semantics, atomic writes, locks, and root
confinement are in [`docs/architecture.md`](./docs/architecture.md). MCP
transport, configuration, tool shapes, client setup, protocol safety, and
lifecycle are in the [MCP server reference](./docs/mcp.md). The five BGM cues,
their briefs, render commands, and the audition checklist are in
[`examples/README.md`](./examples/README.md).

`@gxaditya/vamp-schema` exports the schema JSON at
`@gxaditya/vamp-schema/schema/song.schema.json` and a runtime API. A minimal validation
call:

```ts
import { validateSong } from '@gxaditya/vamp-schema';

const result = validateSong(input);
if (!result.ok) {
  console.log(result.errors);
} else {
  console.log(result.normalized, result.warnings);
}
```

Validation never mutates the input, applies defaults, injects timestamps or
seeds, or rewrites a saved song. `result.normalized` is a separate copy with the
documented defaults resolved. Generated TypeScript declarations are exported from
the package, and generated Python TypedDicts live under `packages/schema/python`.

Compile a validated song into the canonical timeline:

```ts
import { validateSong } from '@gxaditya/vamp-schema';
import { compileSong } from '@gxaditya/vamp-engine';

const result = compileSong(input, { sampleRate: 48000 });
if (!result.ok) {
  console.log(result.stage, result.errors);
} else {
  console.log(result.timeline.renderedSeconds, result.timeline.events.length);
}
```

`compileSong` validates first and returns schema issues unchanged when validation
fails. When validation already happened, `compileValidatedSong(validation,
options)` reuses the normalized copy without validating twice. The timeline
contains exact beat, second, and sample positions, resolved audibility, track
instruments and effects, automation keyframes, and shared duration and tail
metadata. See the [API reference](./docs/api.md).

Export a compiled timeline as a Type 1 Standard MIDI File:

```ts
import { compileSong, exportMidi } from '@gxaditya/vamp-engine';

const compiled = compileSong(input, { sampleRate: 48000 });
if (compiled.ok) {
  const midi = exportMidi(compiled.timeline, { endMarker: 'rendered' });
  if (midi.ok) {
    // midi.bytes: Uint8Array, midi.report: channels, programs, limitations
  } else {
    console.log(midi.errors);
  }
}
```

MIDI export uses 960 PPQ, writes a conductor track plus one named track per
included song track, and reports audio-only effects and program-selection limits
instead of claiming audio parity. See the [API reference](./docs/api.md).

Render the same timeline offline to a WAV:

```ts
import { renderSongToWav } from '@gxaditya/vamp-engine';

const rendered = await renderSongToWav(input, { sampleRate: 48000 });
if (!rendered.ok) {
  console.log(rendered.stage, rendered.errors);
} else {
  // rendered.bytes: 16-bit stereo PCM WAV
  // rendered.report: frame count, peak, clipping count
  // rendered.stats: backend, voice policy, per-track voice counts
}
```

Rendering uses six deterministic builtin instrument IDs:
`keys.soft`, `piano.soft`, `bass.sub`, `pad.warm`, `guitar.clean`, and
`drums.kit`. `drums.kit` uses the GM percussion map for keys 35 through 81.
The mixer applies volume, pan, and cutoff automation plus reverb, delay,
three-band EQ, and low-pass effects. It applies track volume and
equal-power pan before the effect chain, preserves headroom, and reports
clipping instead of normalizing. See the [API reference](./docs/api.md).

The artifact operation writes a master WAV,
one post-effect stem per audible track, Type 1 MIDI, and `report.json` into the
output directory. Stems align with the master, and files are published through a
private job directory with overwrite refusal and cleanup on failure.

```ts
import { renderSongArtifacts } from '@gxaditya/vamp-engine';

const result = await renderSongArtifacts(input, {
  outputDir: 'out',
  sampleRate: 48000,
});

if (!result.ok) {
  console.log(result.stage, result.errors);
} else {
  // out/master.wav, out/stem-01-*.wav, out/song.mid, out/report.json
  console.log(result.report.audio.peak, result.report.audio.loudness.integratedLufs);
}
```

Set `stems: false`, `midi: false`, or `report: false` for explicit opt-outs.
See the [API reference](./docs/api.md) for naming, report fields, the stem and
loudness figures, and the overwrite and cancellation policy.

The default `auto` backend uses FluidSynth and a locally discovered GM
SoundFont when both are available, otherwise the built-in synthesizer. The
sample backend supports the six curated IDs through documented GM mappings,
plus the named 56-preset GM catalog and project `soundfont` instruments; SFZ is
reported as unsupported. Use `createFluidSynthBackend` or a `backend` option
when you need explicit control, and `vamp doctor` or MCP `health_check` to see
which path is active.

```ts
import { createFluidSynthBackend, renderSongAudio } from '@gxaditya/vamp-engine';

const backend = createFluidSynthBackend({
  binaryPath: '/usr/bin/fluidsynth',
  gmSoundFont: '/usr/share/sounds/sf2/FluidR3_GM.sf2',
  projectRoot: '/path/to/project',
});

const rendered = await renderSongAudio(input, { sampleRate: 48000, backend });
```

Provisioning, the curated mapping table, the FluidR3 MIT provenance and pinned
SHA-256, project asset confinement, process limits, and the determinism scope
are documented in the [instrument and asset reference](./docs/instruments.md).
Set `verifyGmSoundFontChecksum: true` to check the trusted GM asset against the
pinned digest. No asset is downloaded during a render, and no audio device is
used.

Development conventions:

- ESM-only TypeScript, strict mode, NodeNext module resolution, shared
  `tsconfig.base.json`.
- Vitest is the single test runner.
- ESLint (flat config) plus Prettier.
- Packages build to `dist/` with declarations and source maps.
- Package SemVer is independent of the song `schemaVersion`.
- Generated files are never edited manually. Their headers name the source and
  regeneration command.
- Packages publish as `@gxaditya/vamp-*` (version 0.1.0, AGPL-3.0-only, public access).

Toolchain notes: TypeScript is pinned to 5.9 because typescript-eslint 8 does
not yet declare support for TypeScript 7. Current ESLint (10), Vitest (5), and
the workspace tooling require Node.js 22.13 or newer within the 22.x LTS line,
which is why the workspace `engines` field records `>=22.13.0`.

## CI

[`.github/workflows/ci.yml`](./.github/workflows/ci.yml) runs three groups:

- `core-checks` on Linux: `pnpm install --frozen-lockfile` on Node.js 22,
  generated-type drift, Python type import, lint, format, build, typecheck,
  `pnpm test:fast`, and `pnpm test:security`.
- `platform-matrix` on ubuntu-latest, macos-latest, and windows-latest: the
  same drift, build, lint, typecheck, fast, and security gates per OS, plus
  package-build smokes that run the built CLI and MCP entrypoints and a
  built-in offline render.
- `native-matrix` on the same three OSes: pins and provisions FluidSynth 2.x
  and the MIT FluidR3 GM SoundFont (downloaded and SHA-256 verified, never
  committed), then runs `pnpm test:native`, a CLI native render smoke, and a
  verification that the SoundFont bytes match without network access. After
  provisioning, execution is offline: on Linux the final smoke runs inside a
  network-free `unshare --net` namespace, and on every OS a static scan fails
  the security suite if any shipped source tree references a network API, a
  shell, or dynamic code evaluation.

Important honesty note: this checkout has no git remote, so none of these
jobs has executed yet. The workflow header records exactly which legs are
authored-but-not-executed and lists the remaining launch-blocking gaps for the
fully-local cross-platform claim. The vitest determinism harness (forks pool,
`maxWorkers: 4`, 30 second timeouts) is inherited by every job, and no CI leg
adds a wall-clock speed gate.

## Determinism and loudness scope

Three claims, kept deliberately narrow:

- The built-in synthesizer is byte-deterministic for identical song data,
  options, engine build, and platform. That is the default path and it needs
  no assets.
- FluidSynth sample rendering is pinned same-machine only: identical bytes are
  promised for one pinned FluidSynth version, one byte-identical SoundFont, one
  platform, one song, and one options set. Cross-platform byte identity is not
  promised and the golden pins are calibrated to this Linux host.
- The report's `integratedLufs` is a documented local approximation computed in
  the engine, not an EBU R128 certification. Peak, dBFS, and clipping counts
  are exact measurements of the emitted PCM.

Duration behavior (`durationHint` as a minimum, effect-tail estimates, the 30
second per-track cap, and the 600 second rendered bound) is defined once in the
[schema guide](./docs/schema-guide.md) and reused by the compiler, reports, and
estimates. See the [API reference](./docs/api.md) for the rest of the scope.

## Security model and the local trust boundary

Vamp enforces its guarantees in process logic, not in the kernel. There is no
OS-level sandbox. Project-root confinement is lexical plus realpath-based,
including symlink escapes through parent directories; the only subprocess is
the FluidSynth offline command line, spawned with argument arrays, `shell:
false`, a minimal sanitized environment, bounded output, a bounded timeout,
process-group kill at the deadline, and temporary-directory cleanup on every
exit path. Writes are atomic and rolled back on failure. Advisory locks
serialize well-behaved writers only and are stale-lock recoverable. TOCTOU
and symlink races against other processes running as the same account remain
possible. The security suite map is `test/security-hardening.test.ts`,
`packages/project/test/security-adversarial.test.ts`, and the platform-gated
`packages/project/test/security-platform.test.ts`. Run them with:

```sh
pnpm test:security
```

## Versioning and migration policy

Package SemVer and the song `schemaVersion` are independent. All workspace
packages are at `0.1.0`; the song format is pinned at `schemaVersion`
`"1.0.0"` (`urn:vamp:schema:song:1.0.0`). Bumping a package never reinterprets a
saved song, and a future schema version will not ride along silently in a patch
release. The policy itself:

- Loading validates and never migrates. Unknown or missing `schemaVersion`
  values fail with a clear `schema.version.*` issue; nothing is coerced or
  rewritten.
- `migrateSong` in `@gxaditya/vamp-schema` is an explicit, separate pure operation over a
  migration registry. v1 registers no migrations, so there is no path by which
  opening a file changes it.
- A future schema version needs its own schema document and explicit,
  user-invoked migration; saved v1 songs must remain loadable and renderable.
- See the [validation reference](./docs/validation.md) and the
  [schema guide](./docs/schema-guide.md) for the version-dispatch surface.

## Deferred and not in v1

Honest scope:

- Deferred optional v1 candidates: MP3 export (`--format mp3` exits 2 with a
  deferral message), `play`/realtime playback, HTTP MCP transport, a Python SDK,
  and single-binary packaging. None is implemented and none is advertised.
- Out of v1 entirely (post-v1 ideas): GUI, DSL, local generative models,
  voiceover/TTS, timeline-aware composition, tempo maps, swing, vocals, master
  effects, per-placement transposition, and pattern nesting. The schema rejects
  unknown fields rather than half-supporting them.
- The launch-blocking gaps for the fully-local cross-platform claim are
  listed explicitly in
  [`.github/workflows/ci.yml`](./.github/workflows/ci.yml): no CI run has
  executed yet (no git remote), macOS and Windows provisioning and
  platform-gated suites are authored-not-executed, Windows native provisioning
  is the weakest link, runtime offline enforcement is Linux-only and unexecuted,
  and the pinned golden layer is calibrated to this Linux host. Until those
  clear, the verified claim is: fully local on Linux, cross-platform code paths
  designed and smoke-tested on Linux, not yet proven on macOS or Windows.

## Troubleshooting (macOS, Linux, Windows)

- Native tests or `--backend fluidsynth` skip or fail with
  `audio.backend.missing_dependency`: FluidSynth is not on `PATH`. Install it
  (Linux: your distribution's `fluidsynth` package; macOS: `brew install
fluidsynth`; Windows: place a FluidSynth 2.x build on `PATH` and pass its
  absolute path with `--fluidsynth-path`, because Windows health checks rely
  on `PATHEXT` resolution). Set `VAMP_FLUIDSYNTH_PATH` to avoid repeating the
  flag.
- `audio.asset.checksum_mismatch` or a failed `pnpm verify:soundfont`: the
  SoundFont on disk is not the pinned FluidR3 GM bytes (148,398,306 bytes,
  SHA-256 starting with `74594e8f`). Re-provision it from
  `docs/instruments.md`; never edit the checksum to make a check pass.
- Asset or render path rejected with `project.path.confined`: the path uses
  traversal, an absolute or drive or UNC form, a backslash, a control or NUL
  character, a Windows reserved device name, or a symlink that escapes the
  project. These checks are deliberately platform-neutral: a name rejected on
  Linux would also be dangerous on Windows. Use plain forward-slash relative
  paths below `assets/` or `renders/`; spaces and Unicode are fine.
- macOS: `/tmp` and `/var` are symlinks into `/private`. Project stores
  realpath-resolve the configured root, so pass `/private/tmp/...` or accept
  that reported absolute paths begin with `/private`. This is confinement
  working, not corruption. The macOS platform cases in
  `packages/project/test/security-platform.test.ts` only run on macOS.
- Windows: creating symlinks or testing symlink escapes requires developer
  mode or elevation; without it the Windows-gated platform tests fail with an
  explicit environment-limitation message rather than a fake pass. Path
  semantics (drive letters, UNC, reserved names) are rejected on every
  platform by design, so the same project directory can move between OSes.
- Lock contention (`project.lock.busy`): another Vamp writer holds the
  project lock. The wait is bounded and no change was made; retry. If a
  crashed process left the lock behind, it is treated as stale after the
  configured window and recovered automatically.
- Tests that spawn subprocesses flake on small machines: they should not,
  because vitest runs in forks with `maxWorkers: 4` and 30 second timeouts.
  If you raise concurrency locally, native and CLI suites can starve their
  children; keep the checked-in configuration.

## License

Vamp is licensed under the **GNU Affero General Public License v3.0**
(`AGPL-3.0-only`); see `LICENSE`. The AGPL is a strong copyleft license: anyone
who distributes this software or a modified version — including offering it as a
network service — must provide the corresponding source under the same license.
Each published package ships its own copy of `LICENSE`. Third-party runtime
and asset notices are recorded in
[`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md); the FluidR3 GM SoundFont
is not bundled.
