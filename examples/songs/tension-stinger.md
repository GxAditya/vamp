# tension-stinger.song.json: Cutaway Stinger

A 6 second dramatic stinger at 110 BPM. A low eighth-note pulse, a pad that
opens its filter and drifts across the stereo field, four guitar plucks that
only arrive in the second half, and a tom build that lands a kick and crash on
beat 8.5 for the cut.

## Brief

| Field              | Value                                                          |
| ------------------ | -------------------------------------------------------------- |
| Intended video use | Scene changes, reveals, "and then it broke" beats, teaser cuts |
| Target duration    | 6.000 seconds                                                  |
| Tempo and meter    | 110 BPM, 4/4                                                   |
| Key                | D minor, with a D and D sharp semitone rub in the pad          |
| Seed               | `1307`                                                         |
| `durationHint`     | 11 beats, 2.75 bars                                            |
| Mood and tags      | `tense, dramatic`, stinger, transition                         |
| Backend            | `auto` (sampled when available; `builtin-synth-v1` fallback)   |
| Structure          | 1 pattern, 1 placement, 27 authored notes, 35 expanded events  |

## Instrumentation

| Track   | Instrument     | Role                                      | Register      | Volume     | Pan                      | Effects                                             |
| ------- | -------------- | ----------------------------------------- | ------------- | ---------- | ------------------------ | --------------------------------------------------- |
| `pulse` | `bass.sub`     | Eighth note ostinato, then a low dyad hit | 26 to 38      | automation | 0                        | none                                                |
| `swell` | `pad.warm`     | D minor triad plus a semitone rub         | 50 to 57      | 1.30       | automation -0.50 to 0.35 | low-pass with cutoff automation, reverb 0.3 / 0.8 s |
| `pluck` | `guitar.clean` | Four high notes in the second half        | 74 to 81      | 0.68       | 0.30                     | reverb 0.25 / 0.6 s                                 |
| `hits`  | `drums.kit`    | Kick, toms, clap build, crash on the out  | keys 35 to 55 | 0.80       | 0                        | none                                                |

The pulse grows with volume automation 0.50, 0.76, 1.00 at beats 0, 4, and 8,
which is the whole tension arc in one field. The swell automates both pan and
filter cutoff, so it has no static `pan` and its single `lowpass` has no static
`cutoffHz`.

## Why it works as a cut point

- It is short and it never becomes a song. Four tracks, no melody line, and the
  pitch content is one triad plus one dissonance.
- The register split is deliberate: the sub sits at 26 to 38, the pad at 50 to
  57, and the guitar at 74 to 81, so nothing occupies the 60 to 70 band where a
  voice or a title card animation usually lives.
- The filter opening from 180 Hz to 2200 Hz reads as a riser without any extra
  track, and cutoff automation is evaluated continuously in both backends.
- The landing is on beat 8.5 (4.636 s), leaving more than a second for the shot
  to breathe before the file ends, which is what makes a stinger editable.

## Exact duration behavior

At 110 BPM one beat is `60 / 110 = 0.545455` seconds.

| Track   | Last notated end | In seconds | Effect tail | Last sound |
| ------- | ---------------- | ---------- | ----------- | ---------- |
| `swell` | beat 8.9         | 4.8545 s   | reverb 0.8  | 5.6545 s   |
| `pulse` | beat 9.5         | 5.1818 s   | none        | 5.1818 s   |
| `pluck` | beat 8           | 4.3636 s   | reverb 0.6  | 4.9636 s   |
| `hits`  | beat 8.75        | 4.7727 s   | none        | 4.7727 s   |

`durationHint` 11 beats is 6.000 seconds, so the render is
`max(6.000, 5.6545)` and writes 288,000 frames at 48 kHz with `deltaSeconds` 0.
The last 0.345 s is exact silence, which is what lets an editor butt the clip
against a cut without an audible cliff.

One honest caveat that this cue is a good illustration of: drum one-shots are not
part of the duration formula. The crash on beat 8.5 starts at 4.636 s and its
internal decay is longer than the remaining 1.364 s, so it is truncated at the
output boundary. That is documented renderer behavior, not a bug, and the fix is
to raise `durationHint` rather than to add an effect, because an effect tail on
another track is what the formula can see.

## Render

From the repository root, after `pnpm build`:

```sh
pnpm exec vamp validate examples/songs/tension-stinger.song.json
pnpm exec vamp render examples/songs/tension-stinger.song.json \
  --out /tmp/vamp-renders/cutaway-stinger \
  --backend builtin --no-normalize
```

Verified report values for that command with `--backend builtin --no-normalize` (48 kHz):

| Field                                     | Value          |
| ----------------------------------------- | -------------- |
| `duration.actualSeconds` / `actualFrames` | 6 / 288000     |
| `duration.deltaSeconds`                   | 0              |
| `audio.peak` / `audio.peakDbfs`           | 0.462 / -6.71  |
| `audio.clipping.clippedSampleCount`       | 0              |
| `audio.loudness.integratedLufs`           | -22.73         |
| Stems                                     | 4, no clipping |
| `warnings.validation` / `warnings.audio`  | empty / empty  |

Stem peaks: hits 0.376, pulse 0.203, swell 0.092, pluck 0.089. This is also the
example the workspace test suite renders offline, so those numbers are checked by
`pnpm test`.

## Revision-safe edit prompts

- "Make it a 3 second sting." Set `durationHint` to 5.5 beats, keep one
  `pulse-bar` placement at beat 0, move the closing dyad to beat 4 with duration
  1.1 (ends at 2.78 s, so its 0.14 s release still fits), shorten all four swell
  notes to end at beat 3.9, and move the crash to beat 3.5. With the 0.8 s reverb
  estimate the swell may not end later than beat 4.03, or the last sound passes
  3.000 s and the render grows past the cut. Move or drop the guitar notes,
  which currently start at beat 5.
- "Give me more of a riser." Use `updateSong` to add filter cutoff keyframes at
  beats 5, 6.5, and 8 with values 400, 1100, and 3000. Cutoff interpolates
  linearly in hertz, so a logarithmic sweep needs those extra points.
- "Drop the guitar." Use `updateTrack` with `{ "mute": true }` on `pluck`. A
  muted track contributes no audio, no stem, and no reverb tail, so the last
  sound moves to the swell at 5.6545 s and the render stays 6.000 s.
- "Hit it a fifth higher." v1 has no per-placement transpose and no pitch shift,
  so rewrite the pitches: `setPattern` for `pulse-bar` with key 45 instead of 38
  and `updateSong` for the swell notes at 57, 60, 64, and 58. Validation will not
  complain about the change because key is metadata and does not restrict
  pitches, but the semitone rub is what makes the cue tense, so keep one.
- "Longer decay on the crash." Raise `durationHint` to 14 beats (7.636 s) rather
  than adding reverb to the drums track, which would also add an effect tail to
  the formula. Re-read the report and confirm `duration.actualSeconds` is 7.636.

## Related

- [`docs/schema-guide.md`](../../docs/schema-guide.md) for automation rules and
  the duration formula this cue follows.
- [`examples/README.md`](../README.md) for the catalog and the audition checklist.
