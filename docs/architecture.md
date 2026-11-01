# Architecture

Vamp turns a JSON song file into finished audio on the local machine. No
network, no audio device, no interactive step.

## Packages

| Package                     | Responsibility                                                                 |
| --------------------------- | ------------------------------------------------------------------------------ |
| `@gxaditya/vamp-schema`     | SongSchemaV1, generated types, validation, normalization, duration estimates   |
| `@gxaditya/vamp-engine`     | Timeline compilation, MIDI export, the two backends, mix, effects, artifacts   |
| `@gxaditya/vamp-project`    | Filesystem project storage with revisions, atomic writes, and path confinement |
| `@gxaditya/vamp-cli`        | The `vamp` command                                                             |
| `@gxaditya/vamp-mcp-server` | The `vamp-mcp` stdio server                                                    |
| `@gxaditya/vamp-sdk`        | `VampClient`, a thin typed facade over the three libraries                     |

Dependency direction, enforced by `test/workspace-boundaries.test.ts`:

```text
@gxaditya/vamp-schema  <-  @gxaditya/vamp-engine
@gxaditya/vamp-schema, @gxaditya/vamp-engine, @gxaditya/vamp-project  <-  @gxaditya/vamp-cli, @gxaditya/vamp-mcp-server, @gxaditya/vamp-sdk
```

`@gxaditya/vamp-engine` never depends on `@gxaditya/vamp-project`. The CLI, the MCP server, and the
SDK are adapters over the same three libraries. None of them carries a second
validator, storage layer, instrument registry, or renderer, so the three surfaces
cannot disagree.

## Pipeline

```text
song JSON -> validate -> normalize -> compile -> backend -> mix and effects -> master -> artifacts
```

1. **Validate.** Structure, ranges, and variants against the JSON Schema, then
   cross-item rules such as unique IDs, resolved pattern references, and channel
   legality. Validation never rewrites your file.
2. **Normalize.** Fills omitted defaults (velocity 100, volume 1, pan 0, repeat 1)
   into the in-memory copy used downstream.
3. **Compile.** Expands pattern placements into a `SongTimeline` of song-relative
   note events with bar and beat boundaries. Deterministic and pure.
4. **Render voices.** Each backend emits dry mono voices at unity gain. The
   built-in synth synthesizes them; FluidSynth reads them from a SoundFont.
5. **Mix.** The shared pipeline applies per-sample volume and pan automation,
   equal-power panning, and the track's authored effect chain in array order, then
   sums to the master. Because mixing is shared, both backends produce the same
   stereo field and the same effects behavior.
6. **Publish.** `master.wav`, one post-effect `stem-<NN>-<slug>.wav` per audible
   track, `song.mid`, and `report.json` are staged in a temporary job directory
   and published by a single atomic rename. The parent of the output directory
   must already exist. On interruption or a failed publish, nothing partial is
   left behind, and `--overwrite` rolls replaced files back.

Length is computed, not requested: `renderedSeconds` is
`max(hintSeconds, lastNoteEndSeconds + capped effect tail)`. The formula and every
bound are in [schema-guide.md](./schema-guide.md).

## Backends

`builtin-synth-v1` is the dependency-free fallback. Pure TypeScript, six curated
voices, zero assets, no child process. It remains available when no native
dependencies are installed.

`fluidsynth-sf2-v1` is the real sample backend. It spawns a bounded FluidSynth
child, supports the `gm` and `soundfont` variants, and loads assets only from
inside the configured project root. You provision the SoundFont; Vamp never
downloads one. Setup and the pinned checksum are in
[instruments.md](./instruments.md).

The CLI, MCP server, and SDK default to `auto`: FluidSynth plus a locally
discovered GM SoundFont when both are available, otherwise the built-in synth
with an explicit warning. `builtin` and `fluidsynth` remain explicit choices.
The named GM catalog and preset packs are in the instrument registry and
`presets.ts`.

Instruments are never substituted. An unsupported variant or unknown ID is an
error with the supported list in its hint.

## Determinism

The same song data, options, backend, and platform produce identical bytes, which
is what makes re-renders after an edit reviewable. Byte identity does not hold
across operating systems or FluidSynth builds, because the native library and
libm differ. Everything in this repository was executed on Linux; the Windows and
macOS code paths are written for those platforms but were not run there.

## Project storage

A project is a directory holding `.vamp-project.json`, `song.json`, `assets/`, and
`renders/`. Edits carry an `expectedRevision` and fail with
`project.revision.conflict` instead of overwriting a concurrent change. Writes go
to a temporary file in the same directory, are fsynced, then renamed, under a
bounded lock. Reads and writes are confined to the project root by both lexical
and resolved-path checks, so `..` and symlinks cannot escape it.

## Interfaces

The MCP server speaks newline-delimited JSON-RPC over stdio only, exposes fourteen
tools, keeps stdout protocol-only with all diagnostics on stderr, and runs renders
inside bounded concurrency, queue, and timeout settings. See
[mcp.md](./mcp.md).

Every failure in every surface is a structured object with a stable code, a JSON
Pointer path, a message, and a hint. CLI exit codes are 0 success, 1 validation,
file, or runtime failure, 2 usage error. The codes are catalogued in
[validation.md](./validation.md) and the callables in [api.md](./api.md).

## Out of scope in v1

MP3 or any non-WAV output; audio playback; audio file input, sampling, or
resampling; tempo changes; pattern nesting; per-placement transposition or gain;
effects beyond reverb, delay, fixed-band EQ, and low-pass; master bus, sends, and
sidechain; configurable EQ bands; modes other than major and minor; per-note
envelopes, pitch bend, and microtonal pitch; automation other than volume, pan,
and low-pass cutoff; vocals and text to speech; HTTP transport; SFZ rendering.
