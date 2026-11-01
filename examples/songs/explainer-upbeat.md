# explainer-upbeat.song.json: Sidebar Walkthrough

A 30 second upbeat explainer bed at 112 BPM. Short keyboard stabs, a root and
fifth bass drive, an off-center clean guitar arpeggio for the lift, a pad swell
in the last third, and a two bar ending that puts the final chord on beat 52 and
lets the reverb finish the cue.

## Brief

| Field              | Value                                                                  |
| ------------------ | ---------------------------------------------------------------------- |
| Intended video use | Product tours, feature callouts, 30 second explainers, UI walkthroughs |
| Target duration    | 30.000 seconds                                                         |
| Tempo and meter    | 112 BPM, 4/4                                                           |
| Key                | G major (G Em C D cycle, C G ending)                                   |
| Seed               | `31415`                                                                |
| `durationHint`     | 56 beats, exactly 14 bars                                              |
| Mood and tags      | `bright, helpful`, tutorial, explainer, narration-safe                 |
| Backend            | `auto` (sampled when available; `builtin-synth-v1` fallback)           |
| Structure          | 6 patterns, 6 placements, 96 authored notes, 236 expanded events       |

## Instrumentation

| Track    | Instrument     | Role                                     | Register      | Volume     | Pan   | Effects                                   |
| -------- | -------------- | ---------------------------------------- | ------------- | ---------- | ----- | ----------------------------------------- |
| `keys`   | `keys.soft`    | Short three note stabs on 1, 3, and 4    | 59 to 69      | automation | -0.20 | reverb 0.16 mix / 1.6 s                   |
| `bass`   | `bass.sub`     | Root and fifth drive                     | 36 to 50      | 0.92       | 0     | none                                      |
| `guitar` | `guitar.clean` | Quarter note arpeggio, enters at bar 7   | 66 to 79      | 0.60       | 0.40  | low-pass 5500 Hz, reverb 0.14 mix / 1.2 s |
| `pad`    | `pad.warm`     | Two voice swell under the last four bars | 55 to 67      | 0.80       | 0.25  | reverb 0.2 mix / 1.6 s                    |
| `drums`  | `drums.kit`    | Light backbeat, then a driving bar       | keys 36 to 49 | 0.50       | 0     | none                                      |

The keys volume automation runs 0.74, 0.86, 0.98, 0.90 at beats 0, 16, 32, and
48, which is the only crescendo in the cue. Every other track keeps a static
gain so the mix balance is readable from the file.

## Why it sits under a voiceover

- The chord stabs are 0.45 beats long, so there is real air between words.
  Nothing sustains through a full bar in the midrange.
- The only moving line is the guitar, and it is panned 0.40 right with a
  5500 Hz low-pass, which keeps its plucked attack out of the speech band.
- Hats sit at velocity 48 to 54 and the snare at 74 to 80, so the kit reads as
  pulse rather than as a competing rhythm.
- Energy comes from arrangement density and the keys automation curve, not from
  a louder master. Peak stays flat across the cue at about -7.6 dBFS.
- The last two bars drop the groove and land one chord per bar, which gives an
  editor a clean out point.

## Exact duration behavior

At 112 BPM one beat is `60 / 112 = 0.535714` seconds.

| Track    | Last notated end | In seconds | Effect tail | Last sound |
| -------- | ---------------- | ---------- | ----------- | ---------- |
| `keys`   | beat 52.45       | 28.0982 s  | reverb 1.6  | 29.6982 s  |
| `pad`    | beat 52.4        | 28.0714 s  | reverb 1.6  | 29.6714 s  |
| `guitar` | beat 52.4        | 28.0714 s  | reverb 1.2  | 29.2714 s  |
| `bass`   | beat 54          | 28.9286 s  | none        | 28.9286 s  |
| `drums`  | beat 52.25       | 27.9911 s  | none        | 27.9911 s  |

`durationHint` 56 beats is 30.000 seconds, so `max(30.000, 29.6982)` renders
1,440,000 frames at 48 kHz and `deltaSeconds` is 0. The final G chord is struck
on beat 52, the start of bar 14, and notated only 0.45 beats long: a short stab
whose 1.6 s reverb carries the last 0.3 s of the window.

This cue also shows why a hint in beats can be shorter than the music. Bass is
notated through beat 54 and still ends 1.07 s before the cut because it has no
tail, while keys stops notating at beat 52.45 and is the track that actually
defines the end.

## Render

From the repository root, after `pnpm build`:

```sh
pnpm exec vamp validate examples/songs/explainer-upbeat.song.json
pnpm exec vamp info examples/songs/explainer-upbeat.song.json
pnpm exec vamp render examples/songs/explainer-upbeat.song.json \
  --out /tmp/vamp-renders/sidebar-walkthrough \
  --backend builtin --no-normalize
```

Verified report values for that command with `--backend builtin --no-normalize` (48 kHz):

| Field                                    | Value             |
| ---------------------------------------- | ----------------- |
| `duration.requestedSeconds`              | 30                |
| `duration.actualSeconds`                 | 30                |
| `duration.actualFrames`                  | 1440000           |
| `duration.deltaSeconds`                  | 0                 |
| `audio.peak` / `audio.peakDbfs`          | 0.415 / -7.63     |
| `audio.clipping.clippedSampleCount`      | 0                 |
| `audio.loudness.integratedLufs`          | -25.31            |
| Stems                                    | 5 (one per track) |
| `warnings.validation` / `warnings.audio` | empty / empty     |

Stem peaks run drums 0.238, keys 0.157, bass 0.137, guitar 0.093, pad 0.050.

Through the SDK, load the file and use `createProject` plus `renderProject`
exactly as shown in
[`examples/songs/lofi-coding-bed.md`](./lofi-coding-bed.md#through-the-sdk).

## Revision-safe edit prompts

- "Fit this to a 15 second cut." Use `updateSong` to keep two `keys-stabs`
  repeats, move the ending notes to beats 24 and 26, drop the guitar placement,
  and set `durationHint` to 28 beats. With the 1.6 s keys reverb the last keys
  note must end at or before beat 25.02, so a stab at beat 24 with duration 0.45
  is safe. Confirm with `vamp info` that the estimate is still 15.000 s.
- "Duck it between 0:02 and 0:20 while the narrator talks." Insert volume
  automation points on `keys` at beats 4 and 40 at about 0.55 of the surrounding
  values, and replace `bass`, `guitar`, `pad`, and `drums` static volumes with
  matching automation curves. A static `volume` cannot coexist with volume
  automation, so the field must be removed in the same edit.
- "Make it warmer, less plinky." Use `setInstrument` to move `keys` to
  `piano.soft`, and use `updateSong` to raise the guitar low-pass `cutoffHz`
  from 5500 to 4200. `updateTrack` only patches name, channel, volume, pan,
  mute, and solo, so effects go through `updateSong`.
- "Punch the last chord." Use `addNotes` on `drums` with
  `{ "pitch": 49, "start": 52, "duration": 0.25, "velocity": 96 }` and a matching
  kick. The drums tail is unchanged, so the duration stays 30.000 s.
- "Add a second guitar layer for the final four bars." Use `addTrack` with a new
  channel (any melodic channel that is not already used and is not 9), then
  `setPattern` a complementary figure. Watch the report peak: there is no master
  limiter, and this cue already sits near -7.6 dBFS.

## Related

- [`docs/schema-guide.md`](../../docs/schema-guide.md) for the duration formula
  and the tutorial instrumentation guidance.
- [`docs/mcp.md`](../../docs/mcp.md) for the tool loop this file assumes:
  validate, render, read the report, edit, re-render.
- [`examples/README.md`](../README.md) for the catalog and the audition checklist.
