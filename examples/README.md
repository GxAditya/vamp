# Examples

Two things live here: runnable TypeScript SDK scripts, and the v1 BGM song
library under [`songs/`](./songs). Everything in this directory runs offline. No
example needs network access or an audio device, no example downloads an asset
during a render, and no generated WAV, MIDI, or stem bytes are committed.

## Song library

Five original, editable `SongSchemaV1` cues aimed at code-to-video work. Each
one has a brief, an arrangement rationale, exact duration math, verified render
commands, and revision-safe edit prompts in a companion Markdown file.

| Song                                                                 | Style                    | Length | BPM | Key     | Tracks | Backends                      |
| -------------------------------------------------------------------- | ------------------------ | ------ | --- | ------- | ------ | ----------------------------- |
| [`lofi-coding-bed.song.json`](./songs/lofi-coding-bed.song.json)     | Lo-fi coding bed         | 45 s   | 90  | A minor | 5      | auto (sampled when available) |
| [`explainer-upbeat.song.json`](./songs/explainer-upbeat.song.json)   | Tutorial and explainer   | 30 s   | 112 | G major | 5      | auto (sampled when available) |
| [`ambient-focus-bed.song.json`](./songs/ambient-focus-bed.song.json) | Ambient and focus        | 60 s   | 60  | A minor | 3      | auto (sampled when available) |
| [`corporate-bed.song.json`](./songs/corporate-bed.song.json)         | Corporate and clean bed  | 30 s   | 108 | C major | 5      | auto (sampled when available) |
| [`tension-stinger.song.json`](./songs/tension-stinger.song.json)     | Dramatic tension stinger | 6 s    | 110 | D minor | 4      | auto (sampled when available) |

Guides: [`lofi-coding-bed.md`](./songs/lofi-coding-bed.md),
[`explainer-upbeat.md`](./songs/explainer-upbeat.md),
[`ambient-focus-bed.md`](./songs/ambient-focus-bed.md),
[`corporate-bed.md`](./songs/corporate-bed.md),
[`tension-stinger.md`](./songs/tension-stinger.md).

All five are authored with the six curated registry IDs (`piano.soft`,
`keys.soft`, `bass.sub`, `pad.warm`, `guitar.clean`, `drums.kit`), so every one
of them still renders on the deterministic built-in backend with zero assets.
The current default is `auto`: the same files render through FluidSynth and a
discovered GM SoundFont when one is available, and normalization lifts the
master to a -1 dBFS peak. The verified peak and LUFS values in the per-cue
guides were recorded with the earlier built-in, pre-normalization path; use
`--backend builtin --no-normalize` to reproduce those exact figures.
`corporate-bed.song.json` additionally demonstrates the curated FluidSynth
mappings, where those same IDs play as GM presets, and shows what an explicit
`gm` reference costs you: the sample backend becomes mandatory. See
[`docs/instruments.md`](../docs/instruments.md) for the mappings, the pinned
FluidR3 GM checksum, and the provisioning steps. Nothing references a `.sf2`
inside a committed song file, so no example depends on an asset you have not
provisioned yourself.

Each cue declares an explicit `meta.seed`, a `durationHint` in beats, and a
musical ending whose effect tails land inside the declared length. The 45 second
lo-fi cue is the reference case for exact duration behavior: its hint is 67.5
beats, which is 16.875 bars, and the render still closes at 45.000 seconds.

## Render a song

From the repository root, after `pnpm build`. A brand-new `--out` directory is
published with one atomic rename, so its parent must exist first; create it
once. Every `/tmp/vamp-renders/...` command in this directory's guides assumes
`/tmp/vamp-renders` exists.

```sh
mkdir -p /tmp/vamp-renders
pnpm exec vamp validate examples/songs/lofi-coding-bed.song.json
pnpm exec vamp info examples/songs/lofi-coding-bed.song.json
pnpm exec vamp render examples/songs/lofi-coding-bed.song.json \
  --out /tmp/vamp-renders/notebook-drift
```

To render the whole library into one folder:

```sh
for f in examples/songs/*.song.json; do
  pnpm exec vamp render "$f" --out "/tmp/vamp-renders/$(basename "$f" .song.json)"
done
```

Add the sample backend pass for the corporate bed, after provisioning
FluidSynth 2.x and the pinned SoundFont once:

```sh
pnpm exec vamp render examples/songs/corporate-bed.song.json \
  --out /tmp/vamp-renders/corporate-fluidsynth \
  --backend fluidsynth \
  --fluidsynth-path /usr/bin/fluidsynth \
  --soundfont /usr/share/sounds/sf2/FluidR3_GM.sf2 \
  --verify-soundfont
```

Each render writes `master.wav`, one post-effect stem per audible track,
`song.mid`, and `report.json`. Read the report before using the audio: duration,
peak, clipping, approximate LUFS, backend identity, assets, and warnings.

## SDK scripts

The scripts below import the built `@gxaditya/vamp-sdk` package, run entirely offline,
and need no native dependency.

```sh
pnpm build
node examples/sdk-quickstart.mjs
node examples/sdk-render-from-memory.mjs
```

| File                         | What it demonstrates                                                                                                                                                                                                               |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sdk-quickstart.mjs`         | The full agent workflow through `VampClient`: schema and instrument discovery, authoring an editable `SongSchemaV1`, validation, project create, revision-safe edits, a stale-revision conflict, rendering, and report inspection. |
| `sdk-render-from-memory.mjs` | Using the re-exported shared operations directly (`validateSong`, `estimateRenderedDuration`, `renderSongArtifacts`) with no project storage at all.                                                                               |

To turn a library song into a revision-tracked project, load the file and use
the same client. This is the shape used by the edit prompts in each guide:

```js
import { readFileSync } from 'node:fs';
import { VampClient } from '@gxaditya/vamp-sdk';

const song = JSON.parse(readFileSync('examples/songs/tension-stinger.song.json', 'utf8'));
const client = new VampClient({ root: '/abs/path/to/vamp-projects' });
const created = await client.createProject({ projectId: 'cutaway-stinger', song });
const rendered = await client.renderProject('cutaway-stinger', {
  expectedRevision: created.value.revision,
  sampleRate: 48000,
});
console.log(rendered.value.report.duration, rendered.value.report.audio);
```

## What the automated tests cover

`test/examples.test.ts` validates all five songs through `@gxaditya/vamp-schema` with the
curated registry allowlist from `@gxaditya/vamp-engine`, asserts that each song contains
only curated built-in instruments, checks that every song's effect tails fit
inside its declared target, and renders the 6 second stinger and the 45 second
lo-fi cue offline through the built-in backend. The render assertions are on the
report: exact duration and frame count, zero clipped samples in master and stems,
empty validation and audio warnings, the built-in backend identity, and a complete
artifact set on disk. Renders go to a temporary directory and are removed.

Run just that suite:

```sh
pnpm build
pnpm exec vitest run test/examples.test.ts
```

## Human audition checklist

Automated tests can prove that a song is valid, offline, and exactly as long as
declared. They cannot prove that it is good. The library ships with these numbers
and no listening verdict, so **no example in this library has been listened
to**. Everything below is the pass for the owner to make that judgment once, in
one sitting.

Preparation, about two minutes:

1. `pnpm build`, then render the whole library with the loop above.
2. Open the five `master.wav` files in your editor or player at a fixed monitor
   level, with any "loudness equalization" or automatic volume feature turned off.
3. Keep `report.json` from each render beside you.
4. Have a short voiceover clip ready to place on top. Every one of these is
   narration BGM, so judge them with speech over them, not alone.

Per cue, about 45 seconds each:

| Check                          | What to listen for                                                                                     | If it fails                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| First 5 seconds                | Nothing startling. The lo-fi and corporate beds should already be under the voice.                     | Lower the entry track volume and re-render.                                                 |
| Speech intelligibility         | Read a paragraph of narration over the middle section. Consonants must stay clear.                     | Lower the midrange track, or tighten its low-pass. Keys and guitar are the usual offenders. |
| Loop point                     | Play the cue twice back to back. The restart should not feel like a jolt.                              | Reduce the final reverb decay so the tail does not collide with the restart.                |
| Ending                         | The last note must release cleanly and the tail must stop before the file does.                        | Pull the final notated end earlier. See the duration table in the cue guide.                |
| Stereo image                   | Narration should sit in the middle with music left and right. Nothing should pull the ear to one side. | Change the pan values; the mixes are authored at -0.25 to 0.4 on purpose.                   |
| Loudness                       | Peak should read near the figure in the cue guide, and `clippedSampleCount` must stay 0.               | Reduce gains. There is no master limiter.                                                   |
| Balance against the other cues | Cues used in one video must feel like the same session.                                                | Match by ear first, then verify against `audio.loudness.integratedLufs`.                    |

Cross-cutting checks:

- Render `ambient-focus-bed` at 44100 and 48000 and confirm the duration figure
  is unchanged and the tonal balance still works on your speakers.
- Render `corporate-bed` twice: once with the built-in backend and once with
  `--backend fluidsynth`. The sample pass measures about 3.6 LU quieter with the
  same gains, so decide which loudness target the library should author to.
- If you provision the SoundFont, run `node scripts/verify-soundfont.mjs` on it
  before trusting a sample render.
- Note anything that sounds like music you already know. Original authored data
  does not guarantee legal clearance or the absence of accidental similarity;
  that review stays with a human.

Record which cues passed, which need a revision, and who listened. Golden audio
fixtures are already frozen from this library, so the musical verdict can land
without touching them; if a cue is revised, regenerate the goldens through
`pnpm golden:regenerate` deliberately, not accidentally.

## Related documents

- [`docs/api.md`](../docs/api.md): the CLI and SDK surfaces used above.
- [`docs/mcp.md`](../docs/mcp.md): the tool loop these examples are written
  against, with client setup for Claude Code, Cursor, and Codex.
- [`docs/schema-guide.md`](../docs/schema-guide.md): timing, duration and tails,
  instruments, and the BGM planning guidance.
- [`docs/instruments.md`](../docs/instruments.md): curated IDs, sample mappings,
  licensing, and provisioning.
