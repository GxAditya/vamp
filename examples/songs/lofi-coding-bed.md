# lofi-coding-bed.song.json: Notebook Drift

A 45 second lo-fi coding bed at 90 BPM. Four bars of keys and bass, then pad,
drums, and a sparse piano line enter one section at a time, and the cue resolves
to Am9 with its reverb landing inside the video cut.

This is the reference example for exact duration behavior: the hint is 67.5
beats, which is not a whole number of bars, and the render still lands on
45.000 seconds.

## Brief

| Field              | Value                                                                      |
| ------------------ | -------------------------------------------------------------------------- |
| Intended video use | Screen-record coding sessions, long walkthroughs, "watch me type" segments |
| Target duration    | 45.000 seconds                                                             |
| Tempo and meter    | 90 BPM, 4/4                                                                |
| Key                | A minor (diatonic Am7 Fmaj7 Cmaj7 G6 loop)                                 |
| Seed               | `20260417`                                                                 |
| `durationHint`     | 67.5 beats                                                                 |
| Mood and tags      | `warm, low-distraction`, lo-fi, coding, narration-safe                     |
| Backend            | `auto` (sampled when available; `builtin-synth-v1` fallback)               |
| Structure          | 8 patterns, 8 placements, 114 authored notes, 264 expanded events          |

## Instrumentation

| Track   | Instrument   | Role                                   | Register      | Volume            | Pan   | Effects                                                  |
| ------- | ------------ | -------------------------------------- | ------------- | ----------------- | ----- | -------------------------------------------------------- |
| `keys`  | `keys.soft`  | Seventh-chord bed, the harmonic anchor | 53 to 71      | 0.92              | -0.25 | low-pass 5600 Hz, reverb 0.18 mix / 2.4 s                |
| `piano` | `piano.soft` | Sparse high answer line                | 71 to 79      | 0.85              | 0.30  | delay 500 ms / 0.3 feedback / 0.2 mix                    |
| `bass`  | `bass.sub`   | Root pulse, two notes per bar          | 29 to 36      | 1.05              | 0     | none                                                     |
| `pad`   | `pad.warm`   | Two voice wash that swells in level    | 57 to 64      | volume automation | 0.35  | low-pass with cutoff automation, reverb 0.22 mix / 2.4 s |
| `drums` | `drums.kit`  | Soft boom-bap, low velocity hats       | keys 36 to 49 | 0.55              | 0     | none                                                     |

All five IDs are curated registry IDs, so the same file also renders through the
curated FluidSynth mappings; see [`docs/instruments.md`](../../docs/instruments.md).

## Why it sits under a voiceover

- Nothing plays a centered lead melody. Keys are panned -0.25, piano and pad are
  panned right, and the only centered tracks are bass and drums.
- The midrange stays empty. Keys occupy 53 to 71 with mostly sustained chords,
  and the piano ornament only answers in the gaps between them.
- Percussion is quiet by authoring, not by luck: hats sit at velocity 40 to 52
  and the snare at 66 to 72, so the kit never fights speech.
- Both chord tracks run through a low-pass (5600 Hz on keys, 900 to 2200 Hz
  automated on the pad), which removes the tine and pad brightness that would
  otherwise collide with consonants.
- The arrangement builds by adding tracks rather than by raising the master, so
  the report peak stays flat across the cue.

## Exact duration behavior

At 90 BPM one beat is `60 / 90 = 0.666667` seconds.

| Track   | Last notated end | In seconds | Effect tail added by the formula | Last sound |
| ------- | ---------------- | ---------- | -------------------------------- | ---------- |
| `keys`  | beat 63.5        | 42.3333 s  | reverb `decaySeconds` 2.4        | 44.7333 s  |
| `piano` | beat 59          | 39.3333 s  | delay `0.5 s x 6` = 3.0 s        | 42.3333 s  |
| `bass`  | beat 63          | 42.0000 s  | none                             | 42.0000 s  |
| `pad`   | beat 63.4        | 42.2667 s  | reverb 2.4 s                     | 44.6667 s  |
| `drums` | beat 55.75       | 37.1667 s  | none                             | 37.1667 s  |

`durationHint` 67.5 beats is 45.000 seconds. The shared formula takes
`max(hint, last sound)`, so `max(45.000, 44.7333) = 45.000` seconds and the
render is exactly 2,160,000 frames at 48 kHz. The delay tail estimate is
`timeMs / 1000 * ceil(ln(0.001) / ln(feedback))`, which is 6 repeats of 0.5 s.

Practical consequences for this cue:

- 67.5 beats is 16.875 bars. The music is 16 bars (64 beats) and the remaining
  3.5 beats are tail room. Do not "fix" the hint to 64 beats: that would cut the
  final reverb short and the render would be 45.067 s instead of 45.000 s.
- The final Am9 is notated to end at beat 63.5 rather than at the end of bar 16
  (beat 64) precisely so that its 2.4 s reverb tail finishes before the cut. The
  last sound lands at 44.7333 s, leaving 0.267 s of exact silence for the edit.
- Drums stop at beat 56, two bars early, so the ending is a held chord instead
  of a hard stop.
- The pad, keys, and piano releases (1.4 s, 0.25 s, 0.45 s) all finish inside
  the window, so nothing is truncated at the boundary.

## Render

From the repository root, after `pnpm build`:

```sh
pnpm exec vamp validate examples/songs/lofi-coding-bed.song.json
pnpm exec vamp info examples/songs/lofi-coding-bed.song.json
pnpm exec vamp render examples/songs/lofi-coding-bed.song.json \
  --out /tmp/vamp-renders/notebook-drift \
  --backend builtin --no-normalize
```

`info` reports `durationHint` as 67.5 beats, 16.875 bars, 45 seconds and an
estimated rendered duration of 45 seconds before anything is synthesized.

Verified report values for that command with `--backend builtin --no-normalize` (48 kHz):

| Field                                    | Value             |
| ---------------------------------------- | ----------------- |
| `duration.requestedSeconds`              | 45                |
| `duration.actualSeconds`                 | 45                |
| `duration.actualFrames`                  | 2160000           |
| `duration.deltaSeconds`                  | 0                 |
| `audio.peak` / `audio.peakDbfs`          | 0.407 / -7.81     |
| `audio.clipping.clippedSampleCount`      | 0                 |
| `audio.loudness.integratedLufs`          | -25.16            |
| Stems                                    | 5 (one per track) |
| `warnings.validation` / `warnings.audio` | empty / empty     |

Stem peaks run 0.238 (drums), 0.160 (keys), 0.140 (bass), 0.064 (piano), 0.064
(pad), which is the balance this cue is authored for.

### Through the SDK

```js
import { readFileSync } from 'node:fs';
import { VampClient } from '@gxaditya/vamp-sdk';

const song = JSON.parse(readFileSync('examples/songs/lofi-coding-bed.song.json', 'utf8'));
const client = new VampClient({ root: '/abs/path/to/vamp-projects' });
const created = await client.createProject({ projectId: 'notebook-drift', song });
const rendered = await client.renderProject('notebook-drift', {
  expectedRevision: created.value.revision,
  sampleRate: 48000,
});
console.log(rendered.value.report.duration, rendered.value.report.audio);
```

## Revision-safe edit prompts

Work through the SDK edits or the MCP tools so each change is pinned to the
revision it read. See [`docs/mcp.md`](../../docs/mcp.md) for the full workflow
and [`docs/api.md`](../../docs/api.md) for the SDK surface.

- "Bring the bed down about 3 dB, the narration is dense." Edit `keys`, `bass`,
  `piano`, and `drums` with `updateTrack` volumes 0.64, 0.74, 0.60, and 0.39, and
  scale the `pad` volume automation points by the same factor. Re-render and
  expect a report peak near 0.29 with the same 45.000 s duration.
- "Start the piano ornament four bars earlier." Use `updateSong` to change the
  `piano` placement `start` from 32 to 16. Duration does not move because the
  last piano note still ends at beat 59.
- "Make the drums a shaker groove." Use `setPattern` to replace `drum-bar` and
  `drum-bar-open` with the same grid using keys 54 (Tambourine) and 70 (Maracas)
  at velocity 44 to 52, keeping the kick. Re-render and check that
  `warnings.audio` is still empty.
- "End it on a fade instead of the final chord." Add volume automation to `keys`
  with points at beats 0, 60, and 63.5 descending to 0, and drop the static
  `volume` field, which the schema forbids alongside automation. Keep the last
  keyframe at or before beat 63.5 so validation does not warn about automation
  after content.
- "Loop it to 90 seconds for a longer session." 90 seconds at 90 BPM is 135
  beats. Use `updateSong` to raise the `keys-loop`, `bass-loop`, `pad-loop`, and
  `drum-bar` repeat counts, move the `keys-outro` and `bass-outro` placements to
  beat 115 so the final chord ends at beat 130.5, and set `durationHint` to 135.
  Re-check `vamp info`: with the 2.4 s keys reverb the last notated end must stay
  at or before beat 131.4, otherwise the tail grows the render past the video.

## Related

- [`docs/schema-guide.md`](../../docs/schema-guide.md) for timing, tails, and the
  BGM planning table.
- [`docs/instruments.md`](../../docs/instruments.md) for the curated IDs and the
  sample-backend mappings.
- [`examples/README.md`](../README.md) for the catalog and the audition checklist.
