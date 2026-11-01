# MCP server reference

A stdio MCP server exposing fourteen tools: four discovery tools
(`health_check`, `get_schema_guide`, `list_instruments`, `list_presets`), the
authoring and edit tools `validate_song`, `create_song`, `get_song`,
`list_projects`, `update_song`, `add_track`, `add_notes`, `set_pattern`,
`set_instrument`, and `render_song`.
Built on the official TypeScript MCP SDK. Stdout carries protocol traffic only,
all diagnostics go to stderr, and the server makes no network calls and downloads
nothing at runtime.

## Build and run locally

From the repository root:

```sh
pnpm install
pnpm build
node packages/mcp-server/dist/main.js --project-root "$PWD/vamp-projects"
```

`pnpm install` links the `vamp-mcp` binary at the workspace root.
`pnpm exec vamp-mcp --project-root "$PWD/vamp-projects"` runs the same built
entrypoint. `packages/mcp-server/bin/vamp-mcp.js` is the checked-in launcher.
It loads `dist/main.js` and prints a build hint when the build output is
missing. `--help` and `--version` write their requested text to stdout and
exit before any MCP session starts; `node packages/mcp-server/dist/main.js
--help` must print usage and exit 0, and if it prints a build hint, run
`pnpm build`.

## Run the published package

Once `@gxaditya/vamp-mcp-server` is on npm, clients do not need a checkout or a
build. The package ships a `vamp-mcp` bin, so `npx` resolves and runs it:

```sh
npx -y @gxaditya/vamp-mcp-server --project-root "$PWD/vamp-projects"
```

In every client configuration below, the repo-local `command`/`args` pair can be
replaced with:

```json
{
  "command": "npx",
  "args": ["-y", "@gxaditya/vamp-mcp-server", "--project-root", "/absolute/path/to/vamp-projects"]
}
```

Pin a version with `npx -y @gxaditya/vamp-mcp-server@0.1.0` when reproducibility
matters. The optional flags and environment variables are identical on both
paths.

The umbrella package `@gxaditya/vamp` exposes the same `vamp-mcp` bin plus the
`vamp` CLI and the SDK under one name: `npm i -g @gxaditya/vamp`, or
`npx -p @gxaditya/vamp vamp-mcp --project-root <dir>` in a client config.

## Generic stdio client configuration

Use absolute paths. A generic MCP client configuration can launch the built
entrypoint directly:

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

The equivalent environment configuration is:

```json
{
  "mcpServers": {
    "vamp": {
      "command": "node",
      "args": ["/absolute/path/to/vamp/packages/mcp-server/dist/main.js"],
      "env": {
        "VAMP_PROJECT_ROOT": "/absolute/path/to/vamp-projects",
        "VAMP_FLUIDSYNTH_PATH": "/usr/bin/fluidsynth",
        "VAMP_SOUNDFONT_PATH": "/usr/share/sounds/sf2/FluidR3_GM.sf2"
      }
    }
  }
}
```

The native paths are optional. Omit them to use the built-in renderer and let
`health_check` report the missing sample backend.

### Client-specific configuration

**Claude Code, Cursor, and Codex.** These blocks follow each client's published
configuration format; they have not been launched inside those applications
here, so confirm with each client's own MCP status view. The server must be
started with absolute paths, and the projects root must be an existing absolute
directory, created once with `mkdir -p`. Rebuild and restart the client after
any source change, because the launched server is
`packages/mcp-server/dist/main.js`.

**Claude Code.** Project-wide, put an `.mcp.json` in the project root where
Claude Code runs, using the `mcpServers` block above. Or add it from the
Claude Code CLI:

```sh
claude mcp add vamp -- node /absolute/path/to/vamp/packages/mcp-server/dist/main.js --project-root /absolute/path/to/vamp-projects
```

Check the connection with `/mcp` inside Claude Code. `health_check` is the
cheapest tool to confirm the server responds.

**Cursor.** Cursor reads project MCP config from `.cursor/mcp.json`, or the
same block in Settings, MCP, Add Global MCP. The environment-variable form also
works: pass `"env": { "VAMP_PROJECT_ROOT": "/absolute/path/to/vamp-projects" }`
instead of the two `--project-root` arguments. Arguments take precedence over
environment variables.

**Devin and Windsurf.** These clients read dedicated MCP config files. Project
scope lives in `.devin/mcp_config.json` (commit it to share the server with the
team); machine-local or secret-bearing entries belong in
`.devin/mcp_config.local.json`, which is gitignored. User scope is
`~/.config/devin/mcp_config.json`. The block shape is the same `mcpServers`
object:

```json
{
  "mcpServers": {
    "vamp": {
      "command": "npx",
      "args": [
        "-y",
        "@gxaditya/vamp-mcp-server",
        "--project-root",
        "/absolute/path/to/vamp-projects"
      ]
    }
  }
}
```

Or from the Devin CLI: `devin mcp add vamp -- npx -y @gxaditya/vamp-mcp-server --project-root /absolute/path/to/vamp-projects`. Verify with `devin mcp list`.

**Codex.** The Codex CLI reads MCP servers from `~/.codex/config.toml`:

```toml
[mcp_servers.vamp]
command = "node"
args = [
  "/absolute/path/to/vamp/packages/mcp-server/dist/main.js",
  "--project-root",
  "/absolute/path/to/vamp-projects",
]
```

Restart the Codex session after editing the file. The server then appears as the
`vamp` tool group with the fourteen tools.

### Smoke-testing without a client

The MCP Inspector is the standard manual check: it spawns the server, lists its
tools, and lets you call them from a browser UI.

```sh
npx @modelcontextprotocol/inspector node packages/mcp-server/dist/main.js \
  --project-root "$PWD/vamp-projects"
```

Or against the published package:

```sh
npx @modelcontextprotocol/inspector npx -y @gxaditya/vamp-mcp-server \
  --project-root "$PWD/vamp-projects"
```

Call `health_check` first: it reports the schema, project root, default backend,
FluidSynth, discovered SoundFont, and a one-note smoke render.

## Configuration

Arguments take precedence over environment variables, which take precedence
over defaults.

| Setting               | Argument                       | Environment                       | Default              |
| --------------------- | ------------------------------ | --------------------------------- | -------------------- |
| Project root          | `--project-root <dir>`         | `VAMP_PROJECT_ROOT`               | none                 |
| FluidSynth executable | `--fluidsynth-path <path>`     | `VAMP_FLUIDSYNTH_PATH`            | `fluidsynth` on PATH |
| Trusted GM SoundFont  | `--soundfont <path>`           | `VAMP_SOUNDFONT_PATH`             | none                 |
| Concurrent renders    | `--max-concurrent-renders <n>` | `VAMP_MCP_MAX_CONCURRENT_RENDERS` | 1                    |
| Pending render jobs   | `--max-pending-jobs <n>`       | `VAMP_MCP_MAX_PENDING_JOBS`       | 4                    |
| Render timeout        | `--render-timeout-ms <n>`      | `VAMP_MCP_RENDER_TIMEOUT_MS`      | 120000               |

Job settings are bounded: concurrency 1 to 4, pending jobs 0 to 16, and timeout
10000 to 600000 milliseconds. Invalid command-line values are usage errors.
Invalid environment numbers fall back to the default and appear in
`health_check.configurationWarnings`. `maxToolInputElements` is fixed at 20000
for this server. The three render bounds are enforced by the `render_song` job
queue described below, and `health_check` reports the values in force.

### Project root behavior

The project root is optional for discovery. The server always starts, even when
the root is absent, missing, relative, or not a directory. `health_check` reports
the status using the shared `@gxaditya/vamp-project` conventions:

| Status           | Meaning                                                                 |
| ---------------- | ----------------------------------------------------------------------- |
| `not_configured` | No root was supplied. Discovery tools work.                             |
| `valid`          | The root is an absolute existing directory. `projectCount` is reported. |
| `missing`        | The configured path does not exist.                                     |
| `invalid`        | The path is relative, empty, not a directory, or otherwise rejected.    |
| `error`          | The root exists but cannot be enumerated or validated.                  |

Missing and invalid roots include the stable `@gxaditya/vamp-project` error code, message,
and hint. The server does not create the root and does not rewrite projects. The
authoring and edit tools use the same store and return these codes as tool
failures, and `list_projects` and `get_song` require a valid root.

### Optional native dependencies

Built-in rendering is pure TypeScript and always independent of FluidSynth. The
server does not probe native dependencies during startup. `health_check` runs a
bounded executable lookup and, when available, a bounded `fluidsynth --version`
probe. It also checks the configured SoundFont file with a local `stat` only.

A missing executable or SoundFont makes the sample backend `unavailable`. That
does not make health `degraded` and does not break built-in rendering. The
`missingDependencies` array distinguishes `executable` from `soundfont`. No
download occurs at runtime; provisioning instructions are in
[`instruments.md`](./instruments.md).

## Tools

Fourteen tools are exposed. The four discovery tools are read-only, offline,
and idempotent; they accept an empty object as input. The nine authoring and
edit tools and the one render tool are confined to the configured project root
and bound by the shared file, event, project, and job limits. Wrong argument
types, extra top-level arguments, or oversized requests produce an MCP tool
error result (`isError: true`) with an actionable message; they do not crash
the server or contaminate stdout.

### `health_check`

Reports:

- Server name, package version, stdio transport, and exposed tool names.
- Song schema version and ID, supported versions, and instrument registry version.
- Built-in renderer status, backend ID and name, sample rates, voice policy,
  curated instrument count, and a note that separates a usable renderer from a
  missing optional dependency.
- FluidSynth backend status, executable path and source, availability and probed
  version, SoundFont path, source, status and byte size, missing dependencies,
  and an install hint.
- Schema guide availability and source label.
- Project root configuration source, path, status, project count, stable code,
  message, and hint.
- Bounded job settings.
- Configuration warnings.
- Capability notes, including that WAV is the only audio format, that the
  authoring, edit, and render tools are confined to the configured root, and how
  the bounded render lifecycle behaves.

It never enumerates or prints arbitrary environment variables and never reads
secrets. Configured dependency paths are reported. The report includes the
default render backend, the discovered or configured SoundFont, and a one-note
FluidSynth smoke render when the sample path is available. The top-level
`status` is `degraded` when the required built-in renderer is not usable, the
guide is unavailable, or the default sample backend reports a failed smoke
render. A missing optional FluidSynth executable or SoundFont leaves the server
usable with the built-in fallback and is reported as such.

### `get_schema_guide`

Returns the authoritative agent-oriented guide as Markdown in both text content
and `structuredContent.markdown`. The source is
[`docs/schema-guide.md`](./schema-guide.md). The response also includes
`schemaVersion`, `format`, `source`, and UTF-8 `bytes`.

### `list_instruments`

Returns the output of `describeInstrumentRegistry()` from `@gxaditya/vamp-engine` plus a
runtime availability overlay. Each instrument includes:

- Stable `id`, `name`, `category`, `kind`, and `description`.
- MIDI program, bank, and channel.
- Backend capabilities and song variants.
- FluidSynth sample backend mapping.
- SoundFont asset ID, file name, size, SHA-256 checksum, and license.
- Provenance and license evidence.
- Current availability for built-in and sample rendering, missing dependencies,
  and a note about the instrument's mapping.

The top-level output includes the registry version, schema version, sample
backend ID and supported instrument variants, and the SoundFont asset records.
It also includes `gmCatalog`, a named catalog of 56 General MIDI presets
(piano, keys, organ, bass, guitar, strings, pads, choir, brass, woodwind, sax,
mallets, leads, plucks, FX), each with the exact `songInstrument` object, and
`drumKit` with the GM Standard Kit and a readable note map. The six curated IDs
are the only builtin IDs the fallback can synthesize; GM catalog presets need
the FluidSynth sample backend. `docs/instruments.md` documents provisioning and
licenses.

### `list_presets`

Returns the five BGM recipe packs (`lofi`, `tutorial_upbeat`, `ambient_focus`,
`corporate_clean`, `stinger`) with default tempo, key, duration, chord loop,
instruments, groove, arrangement, mix guidance, and pitfalls. Use a recipe when
authoring a custom song, or call `create_song` with `preset` to generate it
directly.

## Authoring and edit tools

Song structure and semantics are validated by `@gxaditya/vamp-schema` with the
authoritative curated instrument allowlist, and the complete resulting song is
re-validated before any atomic save. Every tool requires a valid project root
and returns a structured error when it is missing or invalid; the one exception
is `validate_song`, which reads and writes nothing and works without a root.

Times and note durations are quarter-note beats, pitch is MIDI 0 to 127, and
velocity is optional 1 to 127. Song, track, note, pattern, and instrument
payloads are plain JSON objects; the shared schema validator, not Zod, reports
the precise field-path issues.

### `validate_song`

Validates unsaved `SongSchemaV1` data in place. Input is a single `song` object.
It never creates or touches a project, never applies defaults to the input, and
never migrates versions. It returns a normal result (not `isError`) even when
the song is invalid, so an agent reads the structured fields: `valid`,
`errorCount`, `warningCount`, `errors`, `warnings`, `schemaVersion`,
`capabilityCheck`, and a `counts` summary of tracks, patterns, and authored
notes. Errors and warnings carry the same stable codes, JSON Pointer paths,
messages, and repair hints as `@gxaditya/vamp-schema`.

### `create_song`

Creates a project directory at revision 1 under the configured root. Input is
`projectId` (1 to 64 characters from `a-z`, `0-9`, `.`, `_`, `-`; it must start
and end with a letter or digit and must not be a Windows reserved device name)
plus exactly one of `song` or `preset`.

- `song`: a complete SongSchemaV1 object for custom work.
- `preset`: `lofi`, `tutorial_upbeat`, `ambient_focus`, `corporate_clean`, or
  `stinger`. The server generates a complete arrangement with sampled GM
  instruments, a groove, velocity variation, effects, and a duration-correct
  tail. Optional `title`, `bpm` (20-300), and `durationSeconds` (2-600) override
  the preset defaults.

The complete song is validated first; invalid data, a duplicate project id, or
a root escape returns a structured `project.*` error and leaves the filesystem
unchanged. Returns `project` with identity, revision, the stored song, and
warnings. A repeated create for an existing id returns `project.exists`.

### `get_song`

Reads one project and returns `project` with its validated song, current
`revision`, identity, timestamps, and warnings. Use it to learn the exact
revision before any persisted edit and to re-read after a conflict. It resolves
the confined project through `@gxaditya/vamp-project` and rejects symlink or traversal
escapes. A missing or malformed project returns `project.not_found` or a
`project.*` metadata/song code.

### `list_projects`

Takes no input and lists every complete project in the root, sorted by id, each
with `projectId`, `revision`, `title`, and timestamps but not the song body.
Enumeration is bounded and non-project directories are skipped. A missing or
invalid root returns a structured `project.root.*` error rather than an empty
list.

### `update_song`

Replaces the entire song explicitly. This is full replacement, not a merge or
JSON patch: pass a complete valid song. Input is `projectId`,
`expectedRevision`, and `song`. For small changes prefer the granular tools so
you do not overwrite concurrent edits or lose fields.

### `add_track`, `add_notes`, `set_pattern`, `set_instrument`

Granular mutations by stable identity:

- `add_track` appends or inserts a complete track by unique `id`. A duplicate
  id returns `project.edit.duplicate_track` and changes nothing.
- `add_notes` appends or inserts free notes on one `trackId`. Free notes have no
  schema ids, so their identity is positional within the current revision:
  `(trackId, zero-based index, expectedRevision)`. Set `index` to insert, or
  omit it to append. Re-read after a successful edit before targeting a
  specific position, because inserts and removals shift later indices.
- `set_pattern` creates or replaces one pattern by its stable `id`. A pattern
  with the same id is replaced in place, so re-sending the same pattern at the
  same revision does not duplicate it.
- `set_instrument` replaces one track instrument. `list_instruments` is the
  source of truth for valid builtin ids; `soundfont` and `sfz` asset paths are
  confined to the project `assets/` directory.

### Revision-safe edit loop

Every persisted mutation (`update_song`, `add_track`, `add_notes`, `set_pattern`,
`set_instrument`) requires `expectedRevision`. A successful edit increments the
revision by exactly one and returns the new `revision`, `previousRevision`, the
resulting `project`, and warnings. A stale `expectedRevision` returns a
repairable `project.revision.conflict` with both `expectedRevision` and
`actualRevision` and changes nothing.

After `validate_song` and `create_song`, read the current `revision` with
`get_song`, apply edits with that revision, and re-read after each successful
edit. A missing project root returns `mcp.project_root.not_configured` with a
hint to set `--project-root` or `VAMP_PROJECT_ROOT`.

### Structured project errors

Each persisted tool maps every `ProjectResult` failure to an MCP `isError`
result. An error carries its machine-readable payload in the text content, not
in `structuredContent`. The result has two text items: a human line with the
message and stable `Code: ...`, and a JSON object of the form
`{ "error": { "code", "message", "hint", ... } }`. The error object contains a
stable `code`, `message`, and `hint`, plus, when relevant, `projectId`, a `path`
(project-relative path or JSON Pointer), `expectedRevision` and `actualRevision`
for conflicts, `issues` (the full schema issue list for invalid songs), and
`detail`. Agents read the `isError` flag, then parse the JSON text item for the
repair fields. The codes are the stable `project.*` codes of
`@gxaditya/vamp-project`.

## Render tool

`render_song` renders one saved project revision into a confined directory under
that project's `renders/` tree. It is a thin adapter over the shared engine
operation `renderSongArtifacts`.

Inputs:

| Argument                  | Type                                         | Default             | Meaning                                                                                                                                                                                                 |
| ------------------------- | -------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `projectId`               | project id, 1 to 64 characters               | required            | The stored project to render.                                                                                                                                                                           |
| `expectedRevision`        | integer 1 or higher, optional                | current revision    | Refuse to render unless the stored revision matches exactly. A mismatch returns `project.revision.conflict`.                                                                                            |
| `renderName`              | `[a-z0-9][a-z0-9._-]{0,63}`, optional        | `render-<revision>` | Directory name under `renders/`. Path separators and dot segments are rejected by input validation, so a name cannot escape.                                                                            |
| `backend`                 | `auto`, `builtin`, or `fluidsynth`, optional | `auto`              | Auto uses FluidSynth plus a locally discovered GM SoundFont when available, otherwise the built-in synth. `builtin` forces the fallback; `fluidsynth` requires the configured executable and SoundFont. |
| `sampleRate`              | `44100` or `48000`, optional                 | `48000`             | Output sample rate. Audio is never resampled.                                                                                                                                                           |
| `stems`, `midi`, `report` | booleans, optional                           | `true`              | Artifact selection, passed straight to the engine. Report data is always returned even when the file is disabled.                                                                                       |
| `normalize`               | boolean, optional                            | `true`              | Normalize master and every stem to -1 dBFS with at most +9 dB of boost. Pass false for raw authored levels.                                                                                             |
| `overwrite`               | boolean, optional                            | `false`             | Permit replacing artifact files already in the chosen render directory.                                                                                                                                 |

What it does: it reads the project through `ProjectStore.get` and renders its
validated song as an in-memory snapshot, so a concurrent edit cannot change the
data mid-render. `auto` and `fluidsynth` build the engine's sample backend from
`McpServerConfig` and local discovery only (executable path, explicit or
discovered SoundFont, and the project directory as the asset root); no tool
argument can name an executable or an asset outside the project. Auto falls back
to the built-in synth with a note in `backendSelection.note` when the sample
path is unavailable. The render is submitted to the bounded job queue
with the request cancellation signal, published through the engine's atomic
artifact publisher, and returns only when the files are on disk.

Results: `schemaVersion`, `projectId`, `revision`, `renderName`, `renderPath`,
`outputDirectory`, `backend`, `backendSelection` (requested, selected, note),
`sampleRate`, `artifacts` (role, relative name, absolute path, format, bytes,
sha256, and owning `trackId` for stems), `reportFile`, `outputs`, `summary`,
`report`, `warnings`, and `message`. The report contains duration, peak, dBFS,
mastering gain and peak before/after, clipping, loudness, backend identity and
version, registry and project asset records, the embedded MIDI report, stem
metadata, artifact hashes, the stem reconstruction tolerance, and the run block.

### Bounded render lifecycle

The `RenderJobQueue` uses the resolved `McpServerConfig.jobs` settings, which are
enforced rather than advisory:

- at most `maxConcurrentRenders` renders execute at once;
- at most `maxPendingJobs` renders may wait for a slot, and any further request is
  rejected immediately so the queue cannot grow without bound;
- every running render gets a `renderTimeoutMs` deadline and its own
  `AbortController`;
- the job signal is also aborted by MCP request cancellation and by server
  shutdown.

Distinct lifecycle errors, all in the shared text-content error format:

| Code               | Meaning                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------- |
| `render.busy`      | Concurrency and pending bounds are full, or the server is shutting down. Nothing started.                     |
| `render.timeout`   | The render passed its deadline. The job is aborted, keeps its slot until it unwinds, and reports `timeoutMs`. |
| `render.cancelled` | The render was cancelled by the client request or by shutdown before any artifact was published.              |

Failure mapping for the render itself reuses the shared codes: `project.song.invalid`
when the stored song no longer validates, `render.compile.failed` when the
timeline cannot be built, and the engine's own `audio.*` code, message, hint,
and issue list for option, backend, instrument, asset, artifact, and output
failures (for example `audio.backend.missing_dependency`, `audio.asset.missing`,
`audio.artifacts.exists`, `audio.instrument.unsupported_variant`). Every payload
also carries `projectId`, `revision`, `renderPath`, and `stage` so an agent can
repair the right thing. Because the engine publishes atomically, none of these
paths leaves a partial render behind.

### Repair and re-render loop

The full agent loop over tools only:

1. `health_check`, `get_schema_guide`, `list_instruments`, and `list_presets`.
2. `validate_song` on the drafted song, then `create_song` to save revision 1.
   For a named brief, `create_song` also accepts `preset` plus optional `title`,
   `bpm`, and `durationSeconds` and generates the song server-side.
3. `render_song` with `expectedRevision` set to that revision.
4. Read `summary`, `report.audio` (including `mastering`), `report.duration`,
   `report.stems`, `report.artifacts`, and `warnings`.
5. Repair the data with `update_song` or the granular edit tools against the
   revision just rendered, which returns the new revision.
6. `render_song` again with the new `expectedRevision`. The default
   `render-<revision>` directory keeps the previous render intact; use
   `renderName` to choose a name, and `overwrite` only when replacing a render is
   the intent.

## Protocol safety

Stdout carries only newline-delimited MCP JSON-RPC messages while the server is
running. Every startup line, warning, tool diagnostic, shutdown notice, and
unexpected-error report goes to stderr. The server never calls `console.log`.
The FluidSynth availability probe captures child stdout and stderr internally,
so native output cannot reach the protocol stream.

The server enforces a 4 MiB stdin message bound through the stdio transport and a
20000-element tool input bound through the MCP server. Tool outputs are validated
against declared Zod schemas before they are sent. An unexpected handler failure
becomes a structured tool error:

```json
{
  "error": {
    "code": "mcp.internal",
    "message": "The health_check tool failed unexpectedly.",
    "hint": "Retry the call. If the failure persists, inspect the server stderr diagnostics and rebuild the workspace."
  }
}
```

Invalid tool arguments are rejected by the official SDK before the handler runs.
The SDK returns a `CallToolResult` with `isError: true` and an input validation
message. Unknown tools receive the same kind of tool error. Neither case emits
protocol noise or terminates the server.

## Lifecycle

The server shuts down through one guarded path on:

- SIGINT
- SIGTERM
- stdin end, for example when the client closes the connection
- transport close
- an uncaught exception or unhandled rejection

Shutdown first aborts the render job queue, which cancels every waiting render
with `render.busy` and aborts every running render so the engine removes its
private job directory and stops native children at its next boundary. It then
waits up to 1500 ms for unwinding renders, closes the MCP server and transport,
and exits with status 0 for a requested shutdown and 1 for an internal failure. A
two-second force timer prevents a hung close from blocking termination. An
in-flight native backend call always finishes before that boundary cleanup, so a
render that cannot unwind inside the window is left to the force timer rather
than interrupted mid-syscall.
