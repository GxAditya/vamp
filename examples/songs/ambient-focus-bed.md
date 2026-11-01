# ambient-focus-bed.song.json: Deep Work

A 60 second ambient focus bed at 60 BPM. Three tracks: a slow pad that drifts in
stereo and in filter cutoff, a sub drone that follows the roots, and distant
piano bells that appear about every four bars. No percussion.

## Brief

| Field              | Value                                                                       |
| ------------------ | --------------------------------------------------------------------------- |
| Intended video use | Long screen-record sessions, timelapses, "code with me" loops, reading time |
| Target duration    | 60.000 seconds                                                              |
| Tempo and meter    | 60 BPM, 4/4                                                                 |
| Key                | A minor (Am F G Am harmonic rhythm, one chord per 8 to 16 beats)            |
| Seed               | `90210`                                                                     |
| `durationHint`     | 60 beats, exactly 15 bars                                                   |
| Mood and tags      | `patient, unobtrusive`, ambient, focus, loop-bed                            |
| Backend            | `auto` (sampled when available; `builtin-synth-v1` fallback)                |
| Structure          | 2 patterns, 2 placements, 23 authored notes, 23 expanded events             |

At 60 BPM one beat is exactly one second, so beat numbers and seconds line up
and this is the easiest cue to re-time.

## Instrumentation

| Track   | Instrument   | Role                                    | Register | Volume | Pan                      | Effects                                              |
| ------- | ------------ | --------------------------------------- | -------- | ------ | ------------------------ | ---------------------------------------------------- |
| `pad`   | `pad.warm`   | Three voice wash, one chord per 8 beats | 41 to 57 | 1.30   | automation -0.45 to 0.35 | low-pass with cutoff automation, reverb 0.28 / 2.8 s |
| `drone` | `bass.sub`   | Root drone, one pitch per half section  | 29 to 33 | 1.60   | 0                        | none                                                 |
| `bells` | `piano.soft` | Seven single notes across the whole cue | 72 to 81 | 0.95   | 0.25                     | reverb 0.3 mix / 3.2 s                               |

The pad automates pan across beats 0, 28, and 56 and cutoff across beats 0, 16,
32, and 56 (420, 1200, 620, and 900 Hz). It has no static `pan` field, because
the schema forbids a static value beside automation for the same target, and its
single `lowpass` effect omits `cutoffHz` for the same reason.

## Why it sits under a voiceover

- There is no rhythm section at all, so nothing competes with the cadence of
  speech.
- The pad lives below 900 Hz after the low-pass, which is where it stops
  interfering with consonants and stays in the space under a voice.
- Bells appear roughly every four bars, one note at a time, at velocity 46 to 62. They mark time without becoming a melody an editor has to cut around.
- The drone is the loudest stem at 0.129 peak, and it is nearly all sub
  content, so it disappears on small laptop speakers and reappears on headphones
  without any change to the file.
- Slow automation replaces dynamics. Nothing in this cue needs a fade.

## Exact duration behavior

| Track   | Last notated end | In seconds | Effect tail | Last sound |
| ------- | ---------------- | ---------- | ----------- | ---------- |
| `pad`   | beat 57          | 57.000 s   | reverb 2.8  | 59.800 s   |
| `drone` | beat 56          | 56.000 s   | none        | 56.000 s   |
| `bells` | beat 53          | 53.000 s   | reverb 3.2  | 56.200 s   |

`durationHint` 60 beats is 60.000 seconds, so `max(60.000, 59.800)` renders
2,880,000 frames at 48 kHz with `deltaSeconds` 0. The pad note ends 3 beats early
because its 2.8 s reverb would otherwise push the last sound to 60.6 s and grow
the render past the video.

Two authored choices matter here, and both are documented schema behavior rather
than renderer quirks:

- Instrument release is not part of the formula. `pad.warm` releases over
  1.4 s, and it fits because the note stops at beat 57, not at beat 60.
- The 15.5 and 13 beat note lengths inside the pad are notated ends. The audible
  wash you hear after beat 57 is the reverb tail that the duration formula
  already paid for.

## Render

From the repository root, after `pnpm build`:

```sh
pnpm exec vamp validate examples/songs/ambient-focus-bed.song.json
pnpm exec vamp info examples/songs/ambient-focus-bed.song.json
pnpm exec vamp render examples/songs/ambient-focus-bed.song.json \
  --out /tmp/vamp-renders/deep-work \
  --backend builtin --no-normalize
```

Verified report values for that command with `--backend builtin --no-normalize` (48 kHz):

| Field                                    | Value             |
| ---------------------------------------- | ----------------- |
| `duration.requestedSeconds`              | 60                |
| `duration.actualSeconds`                 | 60                |
| `duration.actualFrames`                  | 2880000           |
| `duration.deltaSeconds`                  | 0                 |
| `audio.peak` / `audio.peakDbfs`          | 0.183 / -14.73    |
| `audio.clipping.clippedSampleCount`      | 0                 |
| `audio.loudness.integratedLufs`          | -26.56            |
| Stems                                    | 3 (one per track) |
| `warnings.validation` / `warnings.audio` | empty / empty     |

This is deliberately the quietest cue in the library, at roughly 1.3 LU below the
others and about 15 dB of peak headroom. K-weighted loudness reads sustained
low-frequency material low, so judge it by ear and not by the peak figure.

## Extending it, and the v1 ceiling

The pad and drone patterns are 32 beats, so a longer bed is a placement change,
not new notes:

```json
{ "pattern": "pad-drift", "start": 60, "repeat": 4 }
```

With `durationHint` 188 beats that is a 3:08 bed at 60 BPM. Stay under the
documented semantic bound: a single Vamp render cannot exceed 600 seconds, and
`durationHint` cannot exceed 12000 beats. A 30 minute focus video is therefore a
looping job for the editor, not one render, and validation fails the request
rather than silently truncating it.

## Revision-safe edit prompts

- "Stretch it to five minutes." Use `updateSong` to add `pad-drift` and
  `bass-drone` placements at beats 60, 120, and 180 with `repeat: 1`, move the
  four free pad notes and the two free drone notes to the new end, and set
  `durationHint` to 300. Keep the final pad note at least 3 beats short of the
  hint so the 2.8 s tail still lands inside. Check `vamp info` before rendering.
- "Too dull on laptop speakers." Use `updateSong` to raise the
  `filterCutoffHz` automation values, for example 900, 1800, 1100, 1500. Cutoff
  interpolates linearly in hertz, so a curve needs extra keyframes.
- "Drop the bells after 0:40." Use `removeNote` with the zero-based index into
  `bells.notes`, which is positional within the current revision. The track still
  has notes, so it stays audible and the duration is unchanged.
- "Mute the drone and see what is left." Use `updateTrack` with
  `{ "mute": true }`. A muted track renders no audio, no stem, and no tail, so
  the stem count drops to 2 while the pad tail still defines the last sound at
  59.8 s and the render stays 60.000 s.
- "Swap the bells for an electric piano." Use `setInstrument` on `bells` with
  `{ "type": "builtin", "id": "keys.soft" }`. `keys.soft` releases in 0.25 s, so
  the same notated ends still fit.

## Related

- [`docs/schema-guide.md`](../../docs/schema-guide.md) for automation rules,
  release behavior, and the 600 second render bound.
- [`examples/README.md`](../README.md) for the catalog and the audition checklist.
