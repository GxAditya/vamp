# Third-party notices

This file records third-party runtime and asset notices relevant to the Vamp v1
engine. It is not the workspace package license; Vamp itself is AGPL-3.0-only (see LICENSE).

## FluidSynth

- Project: FluidSynth, a real-time and offline SoundFont synthesizer.
- Use in Vamp: optional native sample backend, invoked as an executable.
- Verified version: 2.3.4.
- License: GNU Lesser General Public License, version 2.1 or later (LGPL-2.1+),
  as reported by `fluidsynth --version` and the upstream distribution.
- Distribution: FluidSynth is not vendored into this repository. Users install
  it from their operating system or package manager. Vamp invokes the installed
  executable with argument arrays and does not link its source into the
  workspace packages.

## FluidR3 GM SoundFont

- Asset: `FluidR3_GM.sf2`, Fluid (R3) General MIDI SoundFont, version 3.1.
- Author: Frank Wen. Copyright (c) 2000-2002, 2008 Frank Wen.
- License: MIT. The upstream Fluid README states that Fluid is released under
  the MIT license, and the Debian `fluid-soundfont-gm` copyright file repeats
  the MIT text.
- Verified bytes: 148,398,306.
- Verified SHA-256:
  `74594e8f4250680adf590507a306655a299935343583256f3b722c48a1bc1cb0`.
- Source recorded by Debian: `http://www.musescore.org/download/fluid-soundfont.tar.gz`.
- Distribution: Vamp does not bundle or commit the SoundFont. Users provision a
  local copy for the optional FluidSynth sample backend. The pinned checksum
  and license are documented in [`docs/instruments.md`](docs/instruments.md).
- Attribution: keep the MIT copyright and permission notice with any
  redistribution of the SoundFont. Vamp's registry records the license and
  provenance for machine-readable reporting.

## Development and runtime dependencies

The workspace uses its pnpm lockfile for exact dependency versions. Direct
runtime and development dependencies relevant to the audio and MIDI paths are:

| Package                     | Use                                                                            | License                           |
| --------------------------- | ------------------------------------------------------------------------------ | --------------------------------- |
| `ajv`, `ajv-formats`        | JSON Schema validation in `@gxaditya/vamp-schema`                              | MIT                               |
| `@modelcontextprotocol/sdk` | MCP stdio server and client transports, protocol types, tool schema conversion | MIT                               |
| `zod`                       | Validated MCP tool input and output schemas                                    | MIT                               |
| `midi-file`                 | Independent MIDI parser in tests only                                          | MIT                               |
| TypeScript and tooling      | Build, lint, test, format                                                      | See lockfile and package licenses |

No dependency may be relicensed by Vamp. Consult each package's own license
text for redistribution terms.
