# Vamp

[![CI](https://github.com/GxAditya/vamp/actions/workflows/ci.yml/badge.svg)](https://github.com/GxAditya/vamp/actions/workflows/ci.yml)

Vamp is a local-first, headless music engine for coding agents: a versioned
JSON song format with a deterministic offline renderer, a CLI, an MCP server,
and a TypeScript SDK. It lets an agent compose original, editable background
music on its own machine — no account, no cloud API, and no network access at
render time.

## Highlights

- **Fully local.** Rendering is a local process over a JSON file. Nothing is
  downloaded at render time; on Linux the offline guarantee is enforced inside
  a network-free namespace in CI.
- **Editable source, not a prompt lottery.** A song is data — notes,
  instruments, patterns, effects, automation — so edits are revision-safe and
  deterministic instead of re-rolls.
- **Real sampled instruments by default.** The `auto` backend renders General
  MIDI presets through FluidSynth and a local GM SoundFont, with a
  dependency-free oscillator synth as fallback.
- **Complete render artifacts.** Every render produces a master WAV,
  per-track stems, a Type 1 MIDI file, and a report (duration, peak, clipping,
  loudness, backend, hashes, warnings).
- **Agent-native surfaces.** CLI with JSON envelopes and stable exit codes, a
  stdio MCP server with 14 tools, and a typed SDK — all revision-safe and
  confined to a project root.

## Status

v1 is feature complete and CI-verified on Linux, macOS, and Windows. The
packages are prepared for npm as `@gxaditya/vamp-*` but are not yet published;
build from source below. WAV is the only render format — MP3 export and
playback are not implemented.

## Requirements

- **Node.js ≥ 22.13** and **pnpm 10.15.1** (via `corepack enable`).
- **Python ≥ 3.11** — only for the generated-types import check; stdlib only.
- **FluidSynth 2.x + a GM SoundFont (recommended)** for sampled rendering.
  Without them, everything works through the built-in synth.

  ```sh
  # Debian/Ubuntu
  sudo apt install fluidsynth fluid-soundfont-gm
  # macOS — plus a GM .sf2 under ~/.local/share/vamp/soundfonts/ (or VAMP_SOUNDFONT_PATH)
  brew install fluid-synth
  ```

  Provisioning, search order, and the pinned FluidR3 checksum are in
  [`docs/instruments.md`](./docs/instruments.md).

## Build and verify

```sh
pnpm install
pnpm build
pnpm check:generated      # generated types in sync with the schema
pnpm lint && pnpm typecheck
pnpm test                 # fast + native + security suites
```

## Quick start (CLI)

```sh
pnpm exec vamp doctor          # check FluidSynth / SoundFont provisioning
pnpm exec vamp init my-cue --preset lofi --duration 45 --bpm 90
pnpm exec vamp validate vamp-projects/my-cue/song.json
pnpm exec vamp render vamp-projects/my-cue/song.json \
  --out vamp-projects/my-cue/renders/master
```

A render writes `master.wav`, one `stem-*.wav` per audible track, `song.mid`,
and `report.json`, refusing overwrites without `--overwrite`. Useful options:
`--sample-rate 44100|48000` (default 48000), `--backend auto|builtin|fluidsynth`,
`--no-stems`, `--no-midi`, `--no-report`, `--no-normalize`, `--json` for a
single machine-readable envelope. Exit codes: `0` success (validation warnings
do not fail), `1` failure (validation, file, project, render, cancellation),
`2` usage error.

Commands: `init`, `validate`, `info`, `render`, `schema`, `presets`, `doctor`.
Full contracts and envelope shapes: [`docs/api.md`](./docs/api.md).

## MCP server

The `vamp-mcp` stdio server exposes the whole agent loop over 14 tools:
discovery (`health_check`, `get_schema_guide`, `list_instruments`,
`list_presets`), authoring and revision-safe edits (`validate_song`,
`create_song`, `get_song`, `list_projects`, `update_song`, `add_track`,
`add_notes`, `set_pattern`, `set_instrument`), and `render_song` for bounded,
confined rendering into a project's `renders/` tree.

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

Configuration also comes from `VAMP_PROJECT_ROOT`, `VAMP_FLUIDSYNTH_PATH`, and
`VAMP_SOUNDFONT_PATH`; arguments take precedence over environment variables.
Every persisted edit requires `expectedRevision` — a stale revision returns a
repairable `project.revision.conflict` and changes nothing. Client setup for
Claude Code, Cursor, and Codex, plus full tool contracts:
[`docs/mcp.md`](./docs/mcp.md).

## SDK

`@gxaditya/vamp-sdk` is a typed facade over the shared libraries — the same
result, error, and revision contracts with no HTTP and no service:

```ts
import { VampClient } from '@gxaditya/vamp-sdk';

const client = new VampClient({ root: '/absolute/path/to/vamp-projects' });
// validate, create, edit with expectedRevision, render, and inspect reports
```

## Example songs

`examples/songs/` ships five authored BGM cues that render fully offline on
the built-in instruments, each with a brief, duration math, render commands,
and revision-safe edit prompts:

| Song                          | Use                  | Length | BPM | Key     |
| ----------------------------- | -------------------- | ------ | --- | ------- |
| `lofi-coding-bed.song.json`   | Lo-fi coding bed     | 45 s   | 90  | A minor |
| `explainer-upbeat.song.json`  | Tutorial / explainer | 30 s   | 112 | G major |
| `ambient-focus-bed.song.json` | Ambient focus        | 60 s   | 60  | A minor |
| `corporate-bed.song.json`     | Corporate clean      | 30 s   | 108 | C major |
| `tension-stinger.song.json`   | Dramatic stinger     | 6 s    | 110 | D minor |

See [`examples/README.md`](./examples/README.md) for the catalog and audition
checklist.

## Packages

| Package                     | Purpose                                                                                         |
| --------------------------- | ----------------------------------------------------------------------------------------------- |
| `@gxaditya/vamp`            | Umbrella: CLI + MCP server + SDK                                                                |
| `@gxaditya/vamp-schema`     | Canonical JSON Schema, generated TS/Python types, validation, normalization                     |
| `@gxaditya/vamp-engine`     | Song→timeline compiler, MIDI export, built-in and FluidSynth backends, WAV/stem/report renderer |
| `@gxaditya/vamp-project`    | Filesystem projects: revision-safe edits, atomic writes, locks, root confinement                |
| `@gxaditya/vamp-cli`        | The `vamp` command line                                                                         |
| `@gxaditya/vamp-mcp-server` | The `vamp-mcp` stdio MCP server                                                                 |
| `@gxaditya/vamp-sdk`        | Typed local client facade                                                                       |

Architecture and data flow: [`docs/architecture.md`](./docs/architecture.md).

## Development

ESM-only TypeScript (strict, NodeNext), Vitest, ESLint + Prettier. Common
commands from the repo root:

| Command                                       | Purpose                                      |
| --------------------------------------------- | -------------------------------------------- |
| `pnpm build`                                  | Build all packages to `dist/`                |
| `pnpm test`                                   | Full suite (builds first)                    |
| `pnpm test:fast`                              | Fast regression suite                        |
| `pnpm test:native`                            | FluidSynth + pinned-SoundFont suite          |
| `pnpm test:security`                          | Hardening and adversarial suites             |
| `pnpm lint` / `pnpm format:check`             | ESLint / Prettier gates                      |
| `pnpm check:generated` / `check:python-types` | Generated-type drift checks                  |
| `pnpm generate:types`                         | Regenerate TS + Python types from the schema |
| `pnpm verify:soundfont <path>`                | Verify the pinned FluidR3 checksum offline   |

CI ([`.github/workflows/ci.yml`](./.github/workflows/ci.yml)) runs three job
groups on every push: core checks on Linux, a platform matrix
(ubuntu/macos/windows) with build, lint, typecheck, and test gates plus
CLI/MCP/render smokes, and a native matrix that provisions FluidSynth and the
pinned SoundFont on all three OSes and runs the native suite offline —
including a network-free `unshare --net` render on Linux.

## Guarantees and scope

- **Determinism.** The built-in synth is byte-deterministic for identical
  song, options, engine build, and platform. FluidSynth output is pinned
  same-machine only — cross-platform byte identity is not claimed.
- **Offline.** No network or model calls after provisioning; no audio device
  required.
- **Security model.** Lexical + realpath project-root confinement (including
  symlink escapes), argument-array subprocesses with sanitized environments
  and bounded output, atomic writes, advisory locks. Enforced in process
  logic, not an OS sandbox.
- **Versioning.** Package SemVer and song `schemaVersion` are independent.
  Loading never migrates; a future schema version requires an explicit,
  user-invoked migration.
- **Not in v1.** MP3 export, realtime playback, HTTP MCP transport, Python
  SDK, GUI, generative models, tempo maps, vocals. The schema rejects unknown
  fields rather than half-supporting them.

## Troubleshooting

- **`audio.backend.missing_dependency`** — FluidSynth not on `PATH`. Install
  it or pass `--fluidsynth-path` (Windows health checks rely on `PATHEXT`
  resolution). `VAMP_FLUIDSYNTH_PATH` avoids repeating the flag.
- **`audio.asset.checksum_mismatch`** — the SoundFont on disk is not the
  pinned FluidR3 bytes. Re-provision per `docs/instruments.md`; never edit the
  checksum to make a check pass.
- **`project.path.confined`** — the path uses traversal, an absolute/drive/UNC
  form, or an escaping symlink. Use plain forward-slash relative paths under
  `assets/` or `renders/`.
- **macOS paths show `/private/...`** — `/tmp` and `/var` are symlinks; the
  store realpath-resolves the root. This is confinement working, not
  corruption.
- **`project.lock.busy`** — another writer holds the project lock; the wait is
  bounded, and crashed-process locks are recovered as stale automatically.

## License

[AGPL-3.0-only](./LICENSE). Third-party notices:
[`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md).
