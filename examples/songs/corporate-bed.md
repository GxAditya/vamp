# corporate-bed.song.json: Quarterly Update Bed

A 30 second clean corporate bed at 108 BPM with a clear ending. This is the
full-quality example: it is authored with the six curated built-in IDs, so it
renders with no native dependency, and it is also the example to use when
demonstrating the curated FluidSynth sample mappings, where those same IDs play
as real GM presets.

## Brief

| Field              | Value                                                               |
| ------------------ | ------------------------------------------------------------------- |
| Intended video use | Product pitches, quarterly updates, SaaS demos, talking-head intros |
| Target duration    | 30.000 seconds                                                      |
| Tempo and meter    | 108 BPM, 4/4                                                        |
| Key                | C major (C Am F G twice, then Am F C G, then C)                     |
| Seed               | `770429`                                                            |
| `durationHint`     | 54 beats, 13.5 bars                                                 |
| Mood and tags      | `clean, confident`, corporate, background, narration-safe           |
| Backends           | `auto` (FluidSynth when available), `builtin-synth-v1` fallback     |
| Structure          | 5 patterns, 5 placements, 72 authored notes, 240 expanded events    |

## Instrumentation

| Track    | Instrument     | Role                                  | Register      | Volume     | Pan   | Effects                              |
| -------- | -------------- | ------------------------------------- | ------------- | ---------- | ----- | ------------------------------------ |
| `piano`  | `piano.soft`   | Chords with a short re-articulation   | 53 to 72      | 0.85       | -0.15 | low-pass 6500 Hz, reverb 0.2 / 1.8 s |
| `bass`   | `bass.sub`     | Two note root pulse                   | 33 to 43      | 0.92       | 0     | none                                 |
| `guitar` | `guitar.clean` | Arpeggio, bars 5 to 12 and the ending | 65 to 79      | 0.52       | 0.38  | reverb 0.15 / 1.6 s                  |
| `pad`    | `pad.warm`     | Two voice glue with a volume lift     | 57 to 67      | automation | 0.20  | reverb 0.24 / 1.8 s                  |
| `drums`  | `drums.kit`    | Side stick and kick, no crash until 3 | keys 36 to 49 | 0.48       | 0     | none                                 |

The pad volume automation runs 0.60, 0.80, 1.00, 0.90 at beats 0, 16, 32, and
48, and it replaces a static gain, so the file has no `volume` field on that
track.

## Why it sits under a voiceover

- The piano plays chord blocks with a soft re-articulation instead of a melody,
  so there is no line for a narrator to talk over.
- Nothing is centered except bass and drums. Piano leans left at -0.15 and the
  guitar sits right at 0.38, which leaves the middle of the image free.
- Hats are velocity 44 to 48 and the backbeat is a side stick (key 37), which
  reads as pulse rather than as a beat you can count while listening to speech.
- A 6500 Hz low-pass on the piano tames the inharmonic upper partials that turn
  "bright" into "nasal" next to a microphone.
- The ending is deliberate: the kit stops on the last downbeat, the C chord is
  notated 2.5 beats, and the reverb finishes before the cut, so an editor can
  trim to picture without an obvious loop point.

## Exact duration behavior

At 108 BPM one beat is `60 / 108 = 0.555556` seconds.

| Track    | Last notated end | In seconds | Effect tail | Last sound |
| -------- | ---------------- | ---------- | ----------- | ---------- |
| `piano`  | beat 50.5        | 28.0556 s  | reverb 1.8  | 29.8556 s  |
| `pad`    | beat 50.5        | 28.0556 s  | reverb 1.8  | 29.8556 s  |
| `guitar` | beat 50.5        | 28.0556 s  | reverb 1.6  | 29.6556 s  |
| `bass`   | beat 50.5        | 28.0556 s  | none        | 28.0556 s  |
| `drums`  | beat 48.25       | 26.8056 s  | none        | 26.8056 s  |

`durationHint` 54 beats is 30.000 seconds, so the render is
`max(30.000, 29.8556)` and writes 1,440,000 frames at 48 kHz with
`deltaSeconds` 0. Note the shape of the number: 13 bars of music end at beat 52,
the hint is 54 beats, and the difference is 1.111 seconds of ring-out plus
0.144 seconds of silence.

## Built-in render

From the repository root, after `pnpm build`:

```sh
pnpm exec vamp render examples/songs/corporate-bed.song.json \
  --out /tmp/vamp-renders/quarterly-update \
  --backend builtin --no-normalize
```

Verified report values with `--backend builtin --no-normalize` (48 kHz):

| Field                                     | Value          |
| ----------------------------------------- | -------------- |
| `duration.actualSeconds` / `actualFrames` | 30 / 1440000   |
| `duration.deltaSeconds`                   | 0              |
| `audio.peak` / `audio.peakDbfs`           | 0.381 / -8.38  |
| `audio.clipping.clippedSampleCount`       | 0              |
| `audio.loudness.integratedLufs`           | -25.21         |
| Stems                                     | 5, no clipping |
| `warnings.validation` / `warnings.audio`  | empty / empty  |

Stem peaks: drums 0.204, piano 0.136, bass 0.130, guitar 0.091, pad 0.039.

## Full-quality sample render

Provision once, as documented in
[`docs/instruments.md`](../../docs/instruments.md). Nothing in this repository
downloads or commits the SoundFont.

```sh
sudo apt install fluidsynth fluid-soundfont-gm
node scripts/verify-soundfont.mjs /usr/share/sounds/sf2/FluidR3_GM.sf2
```

Then render the same file through the curated mappings:

```sh
pnpm exec vamp render examples/songs/corporate-bed.song.json \
  --out /tmp/vamp-renders/quarterly-update-fluidsynth \
  --backend fluidsynth \
  --fluidsynth-path /usr/bin/fluidsynth \
  --soundfont /usr/share/sounds/sf2/FluidR3_GM.sf2 \
  --verify-soundfont
```

Those IDs are not substituted; they are mapped explicitly by the registry:
`piano.soft` to GM program 0, `guitar.clean` to 27, `bass.sub` to 38,
`pad.warm` to 89, `keys.soft` to 4, and `drums.kit` to the percussion bank on
channel 9.

Verified on this machine with FluidSynth 2.3.4 and the pinned FluidR3 GM file:

| Field                                                | Value                                                         |
| ---------------------------------------------------- | ------------------------------------------------------------- |
| `backend.id` / `backend.version`                     | `fluidsynth-sf2-v1` / 2.3.4 (probe)                           |
| `duration.actualSeconds` / `deltaSeconds`            | 30 / 0                                                        |
| `audio.peak` / `audio.peakDbfs`                      | 0.261 / -11.68                                                |
| `audio.clipping.clippedSampleCount`                  | 0                                                             |
| `audio.loudness.integratedLufs`                      | -28.77                                                        |
| `assets.registry[0].assetId`                         | `fluidr3-gm`                                                  |
| `assets.registry[0].checksum.value`                  | `74594e8f...c1cb0` (SHA-256, pinned)                          |
| `assets.registry[0].license.spdx` / `redistribution` | MIT / `not_bundled`                                           |
| `assets.project`                                     | empty, no song referenced asset                               |
| Stem peaks                                           | piano 0.122, bass 0.117, pad 0.062, drums 0.099, guitar 0.054 |

The sample pass is about 3.6 LU quieter than the built-in pass even though the
notes and gains are identical: FluidSynth renders these presets with `-g 1.0`
and Vamp never normalizes. Match loudness per backend, by raising track volumes
for the sample pass and re-reading the report, rather than assuming one set of
gains is correct for both.

### Using an explicit GM reference

The same file can be pushed one step further by naming GM programs directly.
Verified by editing the `piano` track to
`{ "type": "gm", "program": 0, "bank": 0 }` and the `pad` track to
`{ "type": "gm", "program": 89, "bank": 0 }`:

```sh
pnpm exec vamp render /tmp/corporate-gm-variant.song.json \
  --out /tmp/vamp-renders/quarterly-update-gm \
  --backend fluidsynth --soundfont /usr/share/sounds/sf2/FluidR3_GM.sf2 --verify-soundfont
```

That render succeeds and produces the same stem peaks as the curated pass above,
because program 0 and program 89 are exactly what `piano.soft` and `pad.warm`
map to. The point of the variant is what happens on the other backend: the same
file rendered with the default built-in backend exits 1 with
`audio.instrument.unsupported_variant` on `/tracks/0/instrument` and a hint to
pass `--backend fluidsynth`. `gm` and `soundfont` instruments require the sample
backend, and Vamp never substitutes them.

Through the SDK the same swap is one call, and it needs the backend passed
explicitly:

```js
import { createFluidSynthBackend } from '@gxaditya/vamp-sdk';

const edited = await client.setInstrument('quarterly-update', {
  expectedRevision: snapshot.revision,
  trackId: 'piano',
  instrument: { type: 'gm', program: 0, bank: 0 },
});
const rendered = await client.renderProject('quarterly-update', {
  expectedRevision: edited.value.revision,
  backend: createFluidSynthBackend({
    binaryPath: '/usr/bin/fluidsynth',
    gmSoundFont: '/usr/share/sounds/sf2/FluidR3_GM.sf2',
    verifyGmSoundFontChecksum: true,
  }),
  renderPath: 'renders/gm-piano',
});
```

## Revision-safe edit prompts

- "Use a real strings patch on the pad." Use `setInstrument` with
  `{ "type": "gm", "program": 48, "bank": 0 }`, then render only through the
  sample backend. Validate first: `vamp validate` still passes because schema
  validation is backend neutral, and the built-in render then fails with
  `audio.instrument.unsupported_variant` by design.
- "Cut it to 20 seconds." Use `updateSong` to reduce `piano-chords` and
  `bass-roots` to two repeats, move the ending notes to beats 32 and 34, drop the
  `pad-wash` free notes after beat 34, and set `durationHint` to 36 beats. With
  the 1.8 s reverb on piano and pad the last notated end must stay at or before
  beat 32.7.
- "Keep the crash but lose the kick." Use `setPattern` to replace `drums-clean`
  with the same grid minus the two kick notes. Re-render and confirm
  `audio.clipping.clippedSampleCount` is still 0, which is the failure mode when
  a bed gets denser.
- "Let the last chord ring longer." Use `updateSong` to raise `durationHint` from
  54 to 60 beats and extend the piano, pad, and bass final note durations from
  2.5 to 4.5 beats. The 1.8 s reverb estimate is unchanged, so the last sound
  moves from 29.86 s to about 30.97 s inside a 33.33 s window and
  `vamp info` still reports no overrun.
- "Match the built-in loudness in the sample pass." Raise every track volume and
  the pad automation points by about 1.9x for the sample render only, and read
  the report again: the target is the same -25 LUFS region the built-in pass
  produced, with peak below 1.0 and zero clipped samples.

## Related

- [`docs/instruments.md`](../../docs/instruments.md) for the registry, the GM
  mappings, the pinned FluidR3 GM checksum, and provisioning on Linux, macOS,
  and Windows.
- [`docs/api.md`](../../docs/api.md) for every render flag, envelope, and report
  format.
- [`examples/README.md`](../README.md) for the catalog and the audition checklist.
