# Vamp Song Schema guide

Field reference and the semantic rules the validator enforces.

- Canonical schema: [`packages/schema/schema/song.schema.json`](../packages/schema/schema/song.schema.json)
- Stable schema ID: `urn:vamp:schema:song:1.0.0`
- JSON Schema draft: 2020-12
- `schemaVersion` value: `"1.0.0"`
- Structural fixtures: [`packages/schema/fixtures`](../packages/schema/fixtures)
- Validation, issue codes, and generated types: [`validation.md`](./validation.md)

Ajv 2020 and ajv-formats are runtime dependencies of `@gxaditya/vamp-schema`, configured with defaults disabled and no type coercion.

## Minimal valid song

This is exactly the data of
[`fixtures/valid/minimal.song.json`](../packages/schema/fixtures/valid/minimal.song.json)
(typeset here with short objects inlined; the validator compares them deep-
equal). It uses one built-in instrument, free-form notes, optional defaults, and no patterns, automation, effects, or drums.

```json
{
  "schemaVersion": "1.0.0",
  "meta": {
    "title": "Minimal Vamp Song",
    "bpm": 90,
    "timeSignature": { "numerator": 4, "denominator": 4 },
    "key": { "tonic": "C", "mode": "major" },
    "seed": 1,
    "durationHint": 8
  },
  "tracks": [
    {
      "id": "keys",
      "name": "Keys",
      "kind": "midi",
      "channel": 0,
      "instrument": { "type": "builtin", "id": "keys.soft" },
      "notes": [
        { "pitch": 60, "start": 0, "duration": 4 },
        { "pitch": 64, "start": 0, "duration": 4 },
        { "pitch": 67, "start": 0, "duration": 4 },
        { "pitch": 72, "start": 4, "duration": 3.5, "velocity": 90 }
      ]
    }
  ]
}
```

## Core conventions

| Topic        | Convention                                                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Time unit    | Quarter-note beats. Every `start`, `duration`, `lengthBeats`, `time`, and `durationHint` uses this unit.                 |
| Tempo        | One constant tempo from `meta.bpm`. Quarter-note BPM, even in meters such as 6/8. No tempo maps.                         |
| Fractional   | Note and automation times may be fractional beats. They are not quantized by the schema.                                 |
| Pitch        | Integer MIDI key number, 0 to 127. 60 is middle C (C4).                                                                  |
| Velocity     | Integer 1 to 127. 0 is not a note-on velocity in this schema.                                                            |
| MIDI channel | Zero-based 0 to 15. Channel 9 is drums. This is channel 10 in one-based MIDI documentation.                              |
| Gain         | Linear amplitude. 1 is unity. 2 is about +6.02 dB.                                                                       |
| Pan          | -1 hard left to 1 hard right. Equal-power law. 0 is center.                                                              |
| Paths        | Project-relative, forward-slash paths. No absolute paths, drive letters, backslashes, dot segments, or parent traversal. |
| Defaults     | The schema annotates defaults but never applies them. Defaults are resolved only by later normalization.                 |
| Timestamps   | `createdAt` is optional and is never injected automatically.                                                             |
| Seed         | Required unsigned 32-bit integer. Never generated automatically.                                                         |
| Master bus   | None. Effects are track-local; the master is the sum of audible post-effect tracks.                                      |

## Processing model

Audio processing order for each track:

```text
note voices (velocity, instrument)
        |
        v
static or automated volume (linear gain)
        |
        v
static or automated equal-power pan (mono to stereo)
        |
        v
track-local effects in array order
        |
        v
sum of audible tracks (master has no effects, EQ, limiter, or normalization)
```

A track is audible when it is not muted and either no track is soloed or the track is soloed. Mute wins over solo. Muted and non-soloed tracks produce no audio, no effect tails, and no stems content. Stems are post-effect stereo track outputs, so stems sum to the master.

Automation and effect state are deterministic. Effects start with empty buffers. Nothing is randomized at render time except operations that explicitly use the song seed.

The pan law is equal power. For a mono track sum, with `p` from -1 to 1:

```text
leftGain  = cos((p + 1) * pi / 4)
rightGain = sin((p + 1) * pi / 4)
```

At center both gains are 0.7071, about -3.01 dB, so total power stays constant. The pan law is fixed equal-power; there is no constant-gain option and no automatic pan compensation. Panning happens before the track effect chain, so reverb and delay tails keep the track's pan position.

## Top-level fields

| Field           | Required | Type            | Purpose and rules                                                                                                     |
| --------------- | -------- | --------------- | --------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion` | yes      | string constant | Must be `"1.0.0"`. Unknown versions must be rejected, not migrated silently.                                          |
| `meta`          | yes      | object          | Song metadata and tempo, meter, key, seed, and requested length.                                                      |
| `patterns`      | no       | array           | Up to 64 reusable patterns. Absent or empty means no patterns. Pattern IDs must be unique, which is a semantic check. |
| `tracks`        | yes      | array           | 1 to 16 tracks in authoring and mix order. At most one track may have `kind: "drums"`. Track IDs must be unique.      |

Unknown top-level properties are rejected by `additionalProperties: false`.

## `meta`

| Field           | Required | Type and range                                 | Default in normalization | Purpose and notes                                                                                              |
| --------------- | -------- | ---------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `title`         | yes      | string, 1 to 200 characters                    | none                     | Human-readable title. Metadata only.                                                                           |
| `bpm`           | yes      | integer, 20 to 300                             | none                     | Constant quarter-note tempo. BPM is an integer.                                                                |
| `timeSignature` | yes      | object                                         | none                     | Meter. It groups bars and feeds MIDI time-signature metadata. It does not change the meaning of a beat.        |
| `key`           | yes      | object                                         | none                     | Tonic and major or minor mode. It does not restrict pitches.                                                   |
| `seed`          | yes      | integer, 0 to 4294967295                       | none                     | Explicit 32-bit unsigned determinism seed. Identical song and seed must render identically.                    |
| `durationHint`  | yes      | number, greater than 0 and at most 12000 beats | none                     | Requested minimum audio length. It is not a hard cutoff. See [duration](#duration-and-tails).                  |
| `mood`          | no       | string, 1 to 100 characters                    | absent                   | Free-form descriptive label. No rendering effect.                                                              |
| `tags`          | no       | array of 1 to 20 unique strings, each 1 to 50  | absent                   | Descriptive tags. No rendering effect.                                                                         |
| `createdAt`     | no       | RFC 3339 date-time string                      | absent                   | Authoring record only. Tools must not add the current time implicitly. It is not part of deterministic output. |

### `meta.timeSignature`

| Field         | Required | Type and range           | Purpose                                                                       |
| ------------- | -------- | ------------------------ | ----------------------------------------------------------------------------- |
| `numerator`   | yes      | integer, 1 to 32         | Number of denominator-note units per bar.                                     |
| `denominator` | yes      | integer, 1, 2, 4, ... 32 | Note value that receives one meter beat. Must be a power of two from 1 to 32. |

A bar lasts `numerator * 4 / denominator` quarter-note beats. For example, 3/4 is 3 beats per bar, 6/8 is 3 beats per bar, and 7/8 is 3.5 beats per bar. BPM always counts quarter notes. In 6/8 at 120 BPM one bar lasts 1.5 seconds, not 3 seconds.

### `meta.key`

| Field   | Required | Type and range                                 | Purpose                                                                        |
| ------- | -------- | ---------------------------------------------- | ------------------------------------------------------------------------------ |
| `tonic` | yes      | one of C, C#, D, D#, E, F, F#, G, G#, A, A#, B | Pitch-class tonic. Enharmonic equivalents use sharps, so B flat is written A#. |
| `mode`  | yes      | `major` or `minor`                             | Mode. Only major and minor are represented.                                    |

Key is metadata and a MIDI key-signature hint. Any chromatic pitch remains valid.

## `tracks[]`

| Field        | Required | Type and range                                                | Default in normalization | Purpose and notes                                                                                                                   |
| ------------ | -------- | ------------------------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `id`         | yes      | string matching `^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$`, 1 to 64 | none                     | Stable identifier, unique among tracks. Used for stems, reports, and edits.                                                         |
| `name`       | yes      | string, 1 to 100 characters                                   | none                     | Display name. Stem filenames are derived from it safely, but it is not an identifier.                                               |
| `kind`       | yes      | `midi` or `drums`                                             | none                     | Selects melodic or percussion rules.                                                                                                |
| `channel`    | yes      | integer, 0 to 15                                              | none                     | Zero-based MIDI channel. `midi` tracks cannot use 9. `drums` tracks must use 9. Melodic channels must be unique, which is semantic. |
| `instrument` | yes      | instrument reference object                                   | none                     | Exactly one of builtin, gm, soundfont, or sfz.                                                                                      |
| `volume`     | no       | number, 0 to 2                                                | 1                        | Static linear gain. Omit when volume automation is present.                                                                         |
| `pan`        | no       | number, -1 to 1                                               | 0                        | Static pan. Omit when pan automation is present.                                                                                    |
| `mute`       | no       | boolean                                                       | false                    | Mute wins over solo.                                                                                                                |
| `solo`       | no       | boolean                                                       | false                    | If any non-muted track is soloed, only non-muted solo tracks are audible.                                                           |
| `notes`      | no       | array of notes, 1 to 2048 items                               | empty                    | Free-form notes at song-relative beats. A track must have `notes`, `placements`, or both.                                           |
| `placements` | no       | array of placements, 1 to 256 items                           | empty                    | Pattern placements. A track must have `notes`, `placements`, or both.                                                               |
| `automation` | no       | automation object                                             | absent                   | Volume, pan, or low-pass cutoff curves. Each target replaces its static value.                                                      |
| `effects`    | no       | array of effects, 0 to 8 items                                | empty                    | Track-local chain in processing order. At most one `lowpass`. There are no master effects or sends.                                 |

Rules enforced structurally:

- `kind: "drums"` requires channel 9 and forbids the `gm` instrument variant.
- `kind: "midi"` forbids channel 9.
- A track cannot mix a static `volume` with `automation.volume`, a static `pan` with `automation.pan`, or a static low-pass `cutoffHz` with `automation.filterCutoffHz`.
- A track with `automation.filterCutoffHz` must have exactly one `lowpass` effect.
- The song has at most one drums track.

## Instrument references

`instrument` is a discriminated union. Always include `type`. Unknown variants are rejected.

### Built-in instrument

```json
{ "type": "builtin", "id": "pad.warm" }
```

| Field  | Required | Type and range                                                 | Purpose                                                                                  |
| ------ | -------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `type` | yes      | `"builtin"`                                                    | Discriminator.                                                                           |
| `id`   | yes      | lowercase segments separated by `.` or `-`, 1 to 64 characters | Registry ID. The authoritative list belongs to the instrument registry, not this schema. |

The six curated IDs are `piano.soft`, `keys.soft`, `bass.sub`, `pad.warm`, `guitar.clean`, and `drums.kit`. They render on both backends: the dependency-free synth has a dedicated voice for each, and FluidSynth maps each to a documented GM preset. Unknown IDs are hard capability errors. The authoritative registry is `@gxaditya/vamp-engine` (`INSTRUMENT_REGISTRY`). Pass `INSTRUMENT_REGISTRY_VALIDATION` as `ValidateSongOptions` to reconcile validation with the registry.

For real sampled ensembles, prefer the named GM catalog returned by `list_instruments` in `gmCatalog`. It covers pianos, e-pianos, organs, basses, guitars, strings, pads, choir, brass, woodwind, sax, mallets, plucked instruments, and a small FX set. Catalog IDs such as `gm.keys.ep-tine` are discovery labels, not builtin IDs. Copy each preset's `songInstrument` object verbatim:

```json
{ "type": "gm", "program": 4, "bank": 0 }
```

The default render backend is `auto`: it uses FluidSynth plus a locally discovered GM SoundFont when both are available, and otherwise falls back to the built-in synth with a clear warning. GM instruments cannot render on the built-in fallback, so if a machine has no SoundFont, use only the six curated IDs or install FluidSynth and a GM font. The CLI command `vamp doctor` and the MCP `health_check` report which path is active.

### General MIDI program

```json
{ "type": "gm", "program": 0, "bank": 0 }
```

| Field     | Required | Type and range    | Default in normalization | Purpose                                                                                                            |
| --------- | -------- | ----------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `type`    | yes      | `"gm"`            | none                     | Discriminator.                                                                                                     |
| `program` | yes      | integer, 0 to 127 | none                     | Zero-based GM program. 0 is Acoustic Grand Piano, 4 Tine E-Piano, 33 Finger Bass, 48 String Ensemble, 89 Warm Pad. |
| `bank`    | no       | integer, 0 to 127 | 0                        | Zero-based MIDI bank. Nonzero banks depend on the SoundFont and backend.                                           |

Any GM program from 0 to 127 is valid, but `list_instruments` returns a curated, named, BGM-relevant subset with exact copy-ready instrument objects. GM instruments require the FluidSynth sample backend; the built-in fallback cannot render them.

### SoundFont asset

```json
{
  "type": "soundfont",
  "path": "assets/strings/warm-ensemble.sf2",
  "program": 48,
  "bank": 0
}
```

| Field     | Required | Type and range                                                  | Default in normalization | Purpose                                                                    |
| --------- | -------- | --------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------- |
| `type`    | yes      | `"soundfont"`                                                   | none                     | Discriminator.                                                             |
| `path`    | yes      | confined relative path ending in `.sf2`, at most 512 characters | none                     | SF2 asset path relative to the configured project root.                    |
| `program` | yes      | integer, 0 to 127                                               | none                     | Zero-based SoundFont preset program. Required so the preset is explicit.   |
| `bank`    | no       | integer, 0 to 128                                               | 0                        | Zero-based preset bank. 128 is the conventional SoundFont percussion bank. |

For a drum kit, select the percussion preset and normally use bank 128. The schema cannot verify that the selected preset is a kit; semantic and backend capability checks must.

### SFZ asset

```json
{ "type": "sfz", "path": "assets/flute/air.sfz" }
```

| Field  | Required | Type and range                                                  | Purpose                                                 |
| ------ | -------- | --------------------------------------------------------------- | ------------------------------------------------------- |
| `type` | yes      | `"sfz"`                                                         | Discriminator.                                          |
| `path` | yes      | confined relative path ending in `.sfz`, at most 512 characters | SFZ asset path relative to the configured project root. |

No backend renders SFZ. SFZ files define their own mapping, so no `program` or `bank` fields are accepted.

### Backend capability matrix

| Variant     | Built-in synth backend | FluidSynth sample backend | sfizz sample backend               | MIDI export                                                |
| ----------- | ---------------------- | ------------------------- | ---------------------------------- | ---------------------------------------------------------- |
| `builtin`   | Six curated IDs only   | Curated GM mapping        | Curated GM mapping                 | No direct program map; explicit limitation                 |
| `gm`        | No                     | Yes with a GM SoundFont   | Only if the chosen SFZ setup is GM | Native program and bank                                    |
| `soundfont` | No                     | Yes                       | No                                 | Program and bank where the MIDI target supports them       |
| `sfz`       | No                     | No                        | Yes                                | No direct SFZ mapping; report the approximation limitation |

The default `auto` backend chooses FluidSynth when both the executable and a GM SoundFont are available locally. `vamp doctor`, MCP `health_check`, and MCP `list_instruments` report the current choice and why. When auto falls back to the built-in synth, only the six curated IDs can render.

Unsupported combinations must fail with an explicit capability error. Silent substitution with a sine wave or a different instrument is forbidden.

### Drum kit and note map

A song has at most one `kind: "drums"` track on channel 9. Use `{ "type": "builtin", "id": "drums.kit" }`; both backends treat that ID as the GM Standard Kit (bank 128, program 0, channel 9). GM percussion keys 35 to 81 are valid. Common aliases returned by `list_instruments`:

| Alias       | Key | Alias           | Key | Alias        | Key |
| ----------- | --- | --------------- | --- | ------------ | --- |
| `kick`      | 36  | `snare`         | 38  | `clap`       | 39  |
| `hatClosed` | 42  | `hatPedal`      | 44  | `hatOpen`    | 46  |
| `sideStick` | 37  | `snareElectric` | 40  | `tomLow`     | 45  |
| `tomLowMid` | 47  | `tomHigh`       | 50  | `crash`      | 49  |
| `ride`      | 51  | `rideBell`      | 53  | `tambourine` | 54  |
| `shaker`    | 70  | `cowbell`       | 56  | `claves`     | 75  |

Write varied velocities, not one flat value. A typical soft bed uses kick 90-110, snare 60-80, closed hats 32-52, and open hats or crashes 50-70. Loud hats mask speech.

### Asset path confinement

Every asset path must satisfy all of these lexical rules:

- Relative, never absolute.
- Forward slashes only. A backslash is rejected.
- No drive prefix or colon.
- No empty segment (`//`).
- No `.` or `..` segment, including `assets/../x.sf2` and `./x.sf2`.
- No trailing slash.
- No control characters and none of `< > : | ? *`.
- At most 512 characters.
- `.sf2` for SoundFont assets and `.sfz` for SFZ assets, lowercase.

Spaces and Unicode are allowed. The schema checks only the lexical form. The project layer must resolve the path against the configured project root, reject symlink escapes, and verify existence, type, size, and checksums. Resolving against the process working directory is never allowed.

## Notes

```json
{ "pitch": 60, "start": 0, "duration": 4, "velocity": 96 }
```

| Field      | Required | Type and range                        | Default in normalization | Purpose and notes                                                                                               |
| ---------- | -------- | ------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `pitch`    | yes      | integer, 0 to 127                     | none                     | MIDI key. 60 is C4. On drums tracks it is a GM percussion key and semantic validation restricts it to 35 to 81. |
| `start`    | yes      | number, 0 to 12000 beats              | none                     | Free notes are song-relative. Pattern notes are pattern-relative.                                               |
| `duration` | yes      | number, greater than 0, at most 12000 | none                     | Notated length. Zero and negative durations fail structurally. `start + duration` must not exceed 12000 beats.  |
| `velocity` | no       | integer, 1 to 127                     | 100                      | Note-on velocity.                                                                                               |

Overlapping notes are allowed, including overlapping notes at the same pitch. Two identical notes are not a structural error. The timeline compiler must order note-offs before note-ons at the same beat and must handle repeated pitches deterministically. The instrument release envelope is applied after the notated end, but release is not added to the duration formula; if notated content ends exactly at the requested length, the release may be truncated. End notes slightly early if a clean release is required.

Drums use the General MIDI percussion map. Common keys: 35 Acoustic Bass Drum, 36 Bass Drum 1, 38 Acoustic Snare, 42 Closed Hi-Hat, 46 Open Hi-Hat, 49 Crash Cymbal 1. Drum pitches are restricted to 35 through 81.

## Patterns and placements

Patterns are song-level and reusable. A pattern contains notes only, never placements, so patterns cannot nest. Track IDs and pattern IDs are separate namespaces: each namespace must be internally unique, but a track and a pattern may share the same ID string.

### Pattern

```json
{
  "id": "pulse",
  "name": "Eighth-note pulse",
  "lengthBeats": 4,
  "notes": [
    { "pitch": 69, "start": 0, "duration": 0.5 },
    { "pitch": 72, "start": 0.5, "duration": 0.5 }
  ]
}
```

| Field         | Required | Type and range                        | Default in normalization        | Purpose                                                                       |
| ------------- | -------- | ------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------- |
| `id`          | yes      | identifier string                     | none                            | Unique among patterns. Referenced by placements.                              |
| `name`        | no       | string, 1 to 100 characters           | absent                          | Descriptive name only.                                                        |
| `lengthBeats` | no       | number, greater than 0, at most 12000 | maximum note end in the pattern | Repeat period. Every note must end at or before this value, a semantic check. |
| `notes`       | yes      | array of 1 to 256 notes               | none                            | Pattern-local notes.                                                          |

If `lengthBeats` is omitted, the effective length is the maximum `start + duration` among the pattern notes. With an explicit length, a note that ends after the length is a semantic error. Leading silence is allowed and is part of the pattern.

### Placement

```json
{ "pattern": "pulse", "start": 0, "repeat": 4 }
```

| Field     | Required | Type and range            | Default in normalization | Purpose                                                                                                      |
| --------- | -------- | ------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `pattern` | yes      | pattern identifier string | none                     | Must resolve to a pattern, a semantic check.                                                                 |
| `start`   | yes      | number, 0 to 12000 beats  | none                     | Song-relative start of the first play.                                                                       |
| `repeat`  | no       | integer, 1 to 256         | 1                        | Total number of plays, including the first. Play `r` starts at `start + r * effectiveLengthBeats`, r from 0. |

Repeats tile consecutively. There is no per-placement transpose, gain, velocity scale, start offset inside the pattern, or pattern-in-pattern placement. To vary a repeated pattern, author a second pattern or use free notes and automation.

Free notes and placements may coexist on a track. Their events merge at the same song-relative timeline. Placement expansion limits are listed in [resource bounds](#resource-bounds).

## Automation

Automation is optional and track-local. The three targets are volume, pan, and low-pass cutoff. Each target is a list of keyframes with absolute values.

```json
{
  "volume": {
    "points": [
      { "time": 0, "value": 0.6 },
      { "time": 8, "value": 1 },
      { "time": 16, "value": 0 }
    ]
  },
  "filterCutoffHz": {
    "points": [
      { "time": 0, "value": 400 },
      { "time": 8, "value": 8000 }
    ]
  }
}
```

| Target           | Value type and range       | Replaces static field | Notes                                                                  |
| ---------------- | -------------------------- | --------------------- | ---------------------------------------------------------------------- |
| `volume`         | number, 0 to 2 linear gain | `track.volume`        | Absolute, not a multiplier.                                            |
| `pan`            | number, -1 to 1            | `track.pan`           | Absolute. Equal-power pan law.                                         |
| `filterCutoffHz` | number, 20 to 20000 Hz     | low-pass `cutoffHz`   | Requires exactly one lowpass effect. That effect must omit `cutoffHz`. |

Keyframe fields:

| Field   | Required | Type and range              | Purpose                      |
| ------- | -------- | --------------------------- | ---------------------------- |
| `time`  | yes      | number, 0 to 12000 beats    | Song-relative keyframe time. |
| `value` | yes      | target-specific range above | Absolute target value.       |

Rules:

- A target has 1 to 512 points.
- Points must be sorted by strictly increasing time. Duplicate times are semantic errors.
- Interpolation is linear between points. There are no curve shapes, exponential segments, or step modes.
- Before the first point, the first value holds. After the last point, the last value holds.
- Volume and pan interpolate in their direct units. Cutoff interpolates linearly in hertz, not logarithmically. Agents that need an exponential sweep can add intermediate points.
- Automation is evaluated continuously during audio rendering. MIDI export can only approximate it with controller events and must document that limitation.
- Automation points do not extend the rendered duration. Points after the last note have no audible effect.
- If a target is present, its static field must be omitted. The schema enforces this for volume, pan, and cutoff.

## Effects

The order of the `effects` array is the processing order. At most eight effects and at most one low-pass are allowed per track. Effects are track-local; there is no master bus, sends, sidechain, or parallel chains.

Effects run after track volume and pan and before the master sum. They are audio-only. MIDI export does not carry EQ, delay, reverb, or filter automation. A renderer must not add backend-internal reverb or chorus that the song did not request, and must disable such defaults in sample backends.

All parameters are optional and use normalization defaults when omitted.

### Reverb

| Field          | Required | Type and range    | Default in normalization | Purpose                                                     |
| -------------- | -------- | ----------------- | ------------------------ | ----------------------------------------------------------- |
| `type`         | yes      | `"reverb"`        | none                     | Discriminator.                                              |
| `mix`          | no       | number, 0 to 1    | 0.25                     | 0 is dry, 1 is fully wet.                                   |
| `decaySeconds` | no       | number, 0.2 to 10 | 1.8                      | Approximate RT60 decay time. Also the reverb tail estimate. |

### Delay

| Field      | Required | Type and range     | Default in normalization | Purpose                                         |
| ---------- | -------- | ------------------ | ------------------------ | ----------------------------------------------- |
| `type`     | yes      | `"delay"`          | none                     | Discriminator.                                  |
| `timeMs`   | no       | number, 10 to 2000 | 375                      | Delay period in milliseconds.                   |
| `feedback` | no       | number, 0 to 0.9   | 0.35                     | Feedback amount. Bounded so the tail is finite. |
| `mix`      | no       | number, 0 to 1     | 0.25                     | 0 is dry, 1 is fully wet.                       |

### Equalizer

| Field        | Required | Type and range    | Default in normalization | Purpose                        |
| ------------ | -------- | ----------------- | ------------------------ | ------------------------------ |
| `type`       | yes      | `"eq"`            | none                     | Discriminator.                 |
| `lowGainDb`  | no       | number, -18 to 18 | 0                        | Low shelf gain in decibels.    |
| `midGainDb`  | no       | number, -18 to 18 | 0                        | Peaking band gain in decibels. |
| `highGainDb` | no       | number, -18 to 18 | 0                        | High shelf gain in decibels.   |

The filter design is fixed: low shelf at 250 Hz, peaking band at 1 kHz with Q 1, high shelf at 4 kHz. Frequencies and Q are not configurable.

### Low-pass

| Field      | Required | Type and range      | Default in normalization                   | Purpose                                            |
| ---------- | -------- | ------------------- | ------------------------------------------ | -------------------------------------------------- |
| `type`     | yes      | `"lowpass"`         | none                                       | Discriminator.                                     |
| `cutoffHz` | no       | number, 20 to 20000 | 20000 when no cutoff automation is present | Static cutoff. Omit when cutoff automation exists. |
| `q`        | no       | number, 0.1 to 10   | 1                                          | Resonance. 0.7071 is approximately Butterworth.    |

A second-order low-pass is intended. Only one low-pass is allowed per track so `filterCutoffHz` has one unambiguous target.

### Effect order and tails

Recommended order for a natural result is EQ or low-pass first, then delay, then reverb. This is guidance, not enforcement; authored order is authoritative.

Tail estimates used by the duration formula:

- Reverb: `decaySeconds`.
- Delay: `timeMs / 1000` when feedback is 0. Otherwise `(timeMs / 1000) * ceil(ln(0.001) / ln(feedback))`, the approximate time to decay 60 dB.
- EQ and low-pass: 0 seconds.
- Reverb or delay with `mix: 0`: 0 seconds, because the effect is fully dry.

Sum the estimates for all effects on a track, then cap the per-track tail at 30 seconds after that track's last notated content. Residual audio past the cap is truncated or faded deterministically. Effects on muted or non-soloed tracks produce no tail. The 30 second cap is a hard bound.

## Duration and tails

All durations are derived from quarter-note beats and the constant `bpm`. Let:

```text
secondsPerBeat = 60 / bpm
trackContentEndBeats(t) = max(start + duration)
                          over free notes and expanded placement notes on track t
trackTailSeconds(t) = min(30, sum of effect tail estimates on track t)
lastSoundSeconds = 0 if no track is audibly active, otherwise the maximum
                   over audibly active tracks t of
                   (trackContentEndBeats(t) * secondsPerBeat + trackTailSeconds(t))
hintSeconds = durationHint * secondsPerBeat
renderedSeconds = max(hintSeconds, lastSoundSeconds)
audioFrames = ceil(renderedSeconds * sampleRate)
```

Consequences:

- `durationHint` is a minimum, not a trim.
- If the hint is longer than the audible content plus tails, the output includes trailing silence.
- If the hint is shorter, the output extends through the tail. A hint shorter than the audible content is not itself an error; validation fails only when the computed render exceeds 600 seconds.
- To obtain exactly N seconds, set `durationHint = N * bpm / 60` and make sure every note ends early enough that its release and effect tail finish by N seconds.
- Instrument release is not added by the formula. If content ends exactly at the boundary, release can be truncated.
- Automation points and muted content do not extend the duration.
- At 44.1 kHz and 48 kHz the frame count rounds up to a whole sample. A WAV file's exact duration can therefore be one sample longer than the fractional value.
- MIDI has no audio tail.

Rendered audio is capped at 600 seconds. That is a semantic check because it combines BPM, durations, repeats, mute/solo, and effect tails. `durationHint` is also capped at 12000 beats by the structural schema. At 300 BPM, 12000 beats is 2400 seconds, and at 20 BPM it is 36000 seconds, so the 600 second rendered-duration cap is stricter than the hint cap for long requests.

Example: 45 seconds at 90 BPM is 67.5 beats. If the last note ends at beat 64 and the longest effect tail is 2.4 seconds, last sound is `64 * 0.6667 + 2.4 = 45.07 seconds`, so the render extends slightly past 45 seconds. To land at or under 45 seconds, end content earlier or shorten the tail.

## Defaults and normalization

The JSON Schema contains `default` annotations for documentation and type generation. They are annotations, not behavior. The validator does not enable Ajv `useDefaults`, does not mutate the caller's song, and does not inject timestamps or seeds. `normalizeSong` returns a separate normalized copy and resolves the defaults listed below.

Defaults resolved during normalization:

| Location               | Field                   | Default                                        |
| ---------------------- | ----------------------- | ---------------------------------------------- |
| Track                  | `volume`                | 1                                              |
| Track                  | `pan`                   | 0                                              |
| Track                  | `mute`                  | false                                          |
| Track                  | `solo`                  | false                                          |
| Note                   | `velocity`              | 100                                            |
| Placement              | `repeat`                | 1                                              |
| `gm` instrument        | `bank`                  | 0                                              |
| `soundfont` instrument | `bank`                  | 0                                              |
| Reverb                 | `mix`                   | 0.25                                           |
| Reverb                 | `decaySeconds`          | 1.8                                            |
| Delay                  | `timeMs`                | 375                                            |
| Delay                  | `feedback`              | 0.35                                           |
| Delay                  | `mix`                   | 0.25                                           |
| EQ                     | all gains               | 0                                              |
| Low-pass               | `cutoffHz`              | 20000, only when there is no cutoff automation |
| Low-pass               | `q`                     | 1                                              |
| Pattern                | effective `lengthBeats` | maximum note end; never written back           |

No default exists for `title`, `bpm`, `timeSignature`, `key`, `seed`, `durationHint`, track identity, channel, instrument, or `schemaVersion`. Those are required.

`seed` and `createdAt` have special rules. `seed` is required so determinism is explicit and is never generated. `createdAt` is optional and is never generated implicitly by validation, rendering, or project tools.

## Semantic checks

The schema enforces structure, ranges, discriminated variants, conditional channel and instrument rules, the single drum track, the single low-pass, static-automation conflicts, and lexical asset paths. The following cross-item or computational rules are enforced by the shared validator with stable error paths:

1. Track IDs are unique.
2. Pattern IDs are unique.
3. Melodic MIDI channels are unique and are not 9.
4. Every placement references an existing pattern.
5. Every pattern note ends at or before the explicit or effective pattern length.
6. Every note satisfies `start + duration <= 12000` beats.
7. Every expanded placement ends at or before 12000 beats.
8. Drums track pitches are in the GM percussion range 35 to 81.
9. Automation points are sorted by strictly increasing time within each target.
10. `filterCutoffHz` automation resolves to exactly one low-pass.
11. Total authored note definitions do not exceed 10000.
12. Total expanded note events do not exceed 20000.
13. Computed rendered duration does not exceed 600 seconds.
14. Built-in instrument IDs resolve in the registry.
15. The selected backend supports the instrument variant and the referenced asset.
16. No numeric value is non-finite. JSON cannot encode NaN or Infinity, but programmatic callers can; the validator must reject them.
17. Pattern expansion counts and placement repeat counts stay within documented limits.

Warnings, not hard errors, cover automation points after the last note, a hint that leaves more than 8 seconds of trailing silence, and unused patterns.

## Resource bounds

| Scope                          | Bound                                  | Enforcement |
| ------------------------------ | -------------------------------------- | ----------- |
| Tracks                         | 1 to 16                                | schema      |
| Drum tracks                    | At most 1                              | schema      |
| Patterns                       | At most 64                             | schema      |
| Placements per track           | At most 256                            | schema      |
| Repeat count                   | 1 to 256                               | schema      |
| Notes per pattern              | 1 to 256                               | schema      |
| Free notes per track           | At most 2048                           | schema      |
| Automation points per target   | 1 to 512                               | schema      |
| Automation points per track    | At most 1536                           | semantic    |
| Effects per track              | At most 8                              | schema      |
| Low-pass effects per track     | At most 1                              | schema      |
| Tags                           | At most 20                             | schema      |
| BPM                            | 20 to 300                              | schema      |
| Seed                           | 0 to 4294967295                        | schema      |
| durationHint                   | Greater than 0 and at most 12000 beats | schema      |
| Note, placement, keyframe time | 0 to 12000 beats                       | schema      |
| Asset path length              | 512 characters                         | schema      |
| Total authored notes           | At most 10000                          | semantic    |
| Total expanded note events     | At most 20000                          | semantic    |
| Rendered audio                 | At most 600 seconds                    | semantic    |
| Song JSON file size            | 8 MiB                                  | project     |

Semantic bounds are hard errors, not silent truncation. Total authored notes means all free notes plus all notes defined inside patterns. Total expanded note events means free notes plus, for every placement, `repeat * pattern.notes.length`. `@gxaditya/vamp-project` adds an 8 MiB song-file bound and other storage bounds; they are not part of this schema.

## BGM recipes

These are the five recipes behind `vamp presets`, MCP `list_presets`, and `create_song` presets. Start from one of them and edit, rather than writing a nursery-rhyme melody over whole-note chords.

| Recipe            | Default       | Key     | Loop                     | Core instruments                                                                  |
| ----------------- | ------------- | ------- | ------------------------ | --------------------------------------------------------------------------------- |
| `lofi`            | 45 s, 90 BPM  | A minor | i7 - VI7 - III7 - VII7   | Tine EP (4), Warm Pad (89), Finger Bass (33), Vibraphone (11), Standard Kit       |
| `tutorial_upbeat` | 30 s, 112 BPM | G major | I6 - V - vi7 - IV        | Soft EP (5), String Ensemble (48), Picked Bass (34), Marimba (12), Standard Kit   |
| `ambient_focus`   | 60 s, 60 BPM  | D major | Imaj7 - vi7 - IVmaj7 - V | Warm Pad (89), Halo Pad (94), Fretless Bass (35), Kalimba (108), no drums         |
| `corporate_clean` | 30 s, 108 BPM | C major | Imaj7 - V - vi7 - IVmaj7 | Electric Grand (2), String Ensemble (48), Finger Bass (33), Flute (73), light kit |
| `stinger`         | 6 s, 110 BPM  | D minor | i - iv - V - i           | Tremolo Strings (44), Brass Section (61), Cello (42), crash/kick/toms             |

### Lo-fi coding bed (45 s, 90 BPM)

- **Chords:** `{ "type": "gm", "program": 4 }` at volume 0.8, pan -0.2. Comping hits on beat 1, the and-of-2, and beat 3, velocities 66-86. Low-pass 5600 Hz, reverb 0.18 / 2.4 s.
- **Pad:** program 89 at volume 0.62, pan 0.28. One sustained chord per bar, velocity 52-60. Low-pass 3200 Hz, reverb 0.24 / 2.8 s.
- **Bass:** program 33 at volume 0.9. Root on 1, root on the and-of-2, fifth on 3, octave pickup on the and-of-4. Velocities 74-96. Keep it below MIDI 45.
- **Melody:** program 11 at volume 0.52, pan 0.32. Three quiet notes every four bars, never continuous. Delay 500 ms / 0.3 feedback / 0.18 mix.
- **Drums:** `drums.kit` at volume 0.6. Kick 1 and and-of-3; snare 2 and 4; closed hats on eighths at velocity 32-52; ghost snare at 34 occasionally; open hat at the end of four-bar phrases.
- **Arrangement:** three bars of keys and pad, bass enters, drums enter, melody answers from bar 6, drums drop out for the final two bars, final Am9 rings into the cut.
- **Duration:** 45 s at 90 BPM is 67.5 beats. Reserve about 4.8 beats for the delay and reverb tail, so the last chord ends near beat 62.7. Do not round the hint to 64 beats or the reverb is cut.
- **Mix:** leave 1-4 kHz open for speech; no centered lead; drums quiet by velocity, not by a limiter.

### Upbeat explainer (30 s, 112 BPM)

- **Chords:** program 5, quarter-note hits with accents on 1 and 3, velocities 74-88. Low-pass 9000 Hz, short reverb 0.1 / 1.4 s.
- **Pad:** program 48 at volume 0.5, whole-bar notes, reverb 0.12 / 1.6 s.
- **Bass:** program 34, eighth-note pulse with a fifth on beat 3 and an octave pickup on the and-of-4. Velocities 76-96.
- **Melody:** program 12, a three-note marimba answer every two bars, velocities 62-76. Delay 375 ms / 0.22 / 0.12.
- **Drums:** four-on-the-floor kick at velocity 90-105, clap on 2 and 4 at 72-84, closed hats on offbeats at 36-48, open hat every fourth bar.
- **Arrangement:** two-bar intro, bass and drums by bar 3, hook from bar 5, one-bar drum break before the final chord.
- **Mix:** piano-forward, strings low, short bass, no aggressive synth leads. A clean -16 to -18 LUFS bed is plenty.

### Ambient focus bed (60 s, 60 BPM)

- **Pads:** program 89 as the main wash at volume 0.88, plus program 94 as an upper layer at 0.6. Whole-bar notes, velocities 48-62, low-pass 2600-3400 Hz, reverb 0.3 / 3.2 s.
- **Bass:** program 35, one root per chord, velocity 60-66, long release.
- **Melody:** program 108, two or three notes every eight bars at velocity 40-48. Delay 750 ms / 0.35 / 0.24.
- **Drums:** none by default. If the edit needs a pulse, use a quiet shaker at 28-40, never a full kit.
- **Arrangement:** four-bar pad intro, upper pad enters, bass after eight bars, kalimba every eight bars, everything decays before the cut.
- **Mix:** leave the midrange almost empty. No bright plucks in the speech band, no busy melody.

### Soft corporate bed (30 s, 108 BPM)

- **Chords:** program 2, half-note hits on 1 and 3, velocities 70-84. EQ low -1 dB, mid +1 dB, high -1 dB; reverb 0.14 / 1.8 s.
- **Pad:** program 48 at volume 0.55, reverb 0.16 / 2.0 s.
- **Bass:** program 33, root on 1 and fifth on 3, velocities 74-90.
- **Melody:** program 73, a short phrase every four bars, velocities 56-66.
- **Drums:** kick 1 and 3, clap 2 and 4, quiet eighth hats, tambourine on the offbeats. Velocities conservative.
- **Arrangement:** two-bar intro, bass and percussion enter, strings widen the middle, flute marks every fourth bar, drums drop before the final chord.
- **Mix:** balanced and mid-forward, short reverb, controlled highs. Aim for a clean bed under a confident voice.

### Short tension stinger (6 s, 110 BPM)

- **Strings:** program 44, two-beat tremolo swell at velocity 100.
- **Brass:** program 61, a short hit into the reveal, reverb 0.24 / 2.0 s.
- **Low:** program 42 cello root and fifth. No bass guitar.
- **Drums:** crash and kick on the downbeat, snare on beat 3, a two-note tom fill into the final hit.
- **Arrangement:** swell, reveal, final tonic chord rings out. Do not add a melody after the hit.
- **Duration:** 6 s at 110 BPM is 11 beats. Reserve the reverb tail and let the final chord end near beat 6.6.

### Quality checklist

Before calling a BGM render done, verify:

1. There is an audible groove with velocity variation, not flat whole notes.
2. Bass, chords, and melody occupy separate registers; the melody is not the only content.
3. The mix leaves room for speech: no continuous lead, controlled hats, and low-passed pads or keys.
4. The arrangement changes across time: intro, main, breakdown or drop, final chord.
5. The requested duration is exact: `durationHint` covers the content and its reverb/delay tail.
6. Effects support the genre: lo-fi and ambient use low-pass plus reverb; corporate stays clean; stingers use space and impact.
7. The render report is checked for clipping, peak, LUFS, and warnings. Normalization is applied by default in the CLI, MCP, and SDK.

Avoid by default: square/saw leads, nursery-rhyme single-line melodies, whole-note-only chords for the entire cue, identical velocities on every note, and six instruments playing continuously.

### Engine, guide, and model

Bland output has three independent causes, and fixing one does not fix the others:

1. **Weak instruments.** Six oscillator voices cannot sound like a sampled ensemble. The default `auto` backend plus the named GM catalog fixes this when a SoundFont is provisioned. Without one, the fallback is still synthesized; say so instead of presenting it as sampled.
2. **Weak guidance.** A model that writes whole-note chords and one continuous melody will sound bland on any engine. The presets and recipes above encode a groove, bass motion, register separation, velocity variation, effects, and an arrangement shape.
3. **Weak composition reasoning.** A model can follow a recipe and still choose poor voicings or overwrite the vocal band. A stronger coding model helps with custom structure, but it is not a substitute for provisioning the sample path or following the guide.

The recommended order is therefore: provision the engine, start from a preset or recipe, then use model judgment for the specific brief. Do not treat "use a smarter model" as a fix for missing samples.

## Recommended agent instructions

Paste this into a coding agent before asking for BGM:

```text
You have Vamp, a local headless music engine exposed through MCP and the vamp CLI.
Before composing: call health_check, get_schema_guide, list_instruments, and list_presets.
Use the default auto backend; it renders real FluidSynth samples when available.
For a named brief, prefer create_song with a preset (lofi, tutorial_upbeat,
ambient_focus, corporate_clean, stinger) and override title, bpm, and durationSeconds.
For custom work, use the six curated builtin IDs only if the sample backend is
unavailable; otherwise use named GM programs from list_instruments.gmCatalog.
Always: write a 2-4 chord loop, a bass line, a drum groove with velocity variation,
and a pad or chord layer; keep the melody sparse; reserve reverb/delay tail inside
durationHint; leave the speech band open. Render, read report.json for peak,
clipping, LUFS, duration, and backend warnings, then revise the song rather than
accepting a toy or clipped result. Never invent schema fields or instrument IDs.
```

## Complete render output workflow

Every public surface uses the same flow: versioned schema, validated and normalized song, shared engine, artifacts. The CLI, the MCP server, and the SDK must not invent a second renderer or output layout. The local CLI and the MCP `render_song` tool both reach the same `renderSongArtifacts` engine operation.

1. Create or provision a project. `vamp init demo --root ./vamp-projects` writes a playable `song.json`, or you can author JSON directly and validate it with `vamp validate <file> --json`.
2. Inspect before rendering. `vamp info <file> --json` reports schema counts, instrument expansion, estimated rendered duration, and warnings. It does not render audio. Through MCP, call `health_check` to confirm the schema, project root, default backend, FluidSynth, discovered SoundFont, and smoke render.
3. Render a complete artifact set with `vamp render <file> --out <directory>`. A bare render writes:
   - `master.wav`: stereo, 16-bit PCM at 44.1 kHz or 48 kHz. WAV is the only output format. Normalization is on by default.
   - one post-effect WAV stem per audible track, named after the track. The same mastering gain is applied to each stem, so stems still sum to the master.
   - `song.mid`: a Type 1 Standard MIDI File, which cannot encode audio effects.
   - `report.json`: duration, frame counts, peak, clipping, mastering gain and peak before/after, approximate integrated LUFS, backend identity and version, asset metadata, seed, warnings, and artifact names.
4. Read the report before declaring success. Check `audio.peak`, `audio.mastering`, clipping counts, rendered seconds against the video length, backend warnings, and the output paths. A render that succeeds can still be musically or technically unsuitable.
5. Change the data, validate, and render again. Use `--overwrite` only after confirming the previous output directory may be replaced. The engine publishes a new directory atomically where the platform allows and refuses to overwrite by default.
6. Hand the caller the artifact paths and report summary, not just "rendered". Keep track of the song revision and the exact options used for the take.

Useful render options:

| Option                                   | Meaning                                                                      |
| ---------------------------------------- | ---------------------------------------------------------------------------- |
| `--sample-rate 48000`                    | Select 44100 or 48000. Audio is never resampled.                             |
| `--backend auto`                         | Default. FluidSynth plus a locally discovered GM SoundFont when available.   |
| `--backend builtin`                      | Force the pure TypeScript oscillator fallback.                               |
| `--backend fluidsynth`                   | Require FluidSynth 2.x and a trusted GM SoundFont.                           |
| `--normalize` / `--no-normalize`         | Normalize master and stems to -1 dBFS with at most +9 dB boost. Default: on. |
| `--no-stems`, `--no-midi`, `--no-report` | Explicitly omit artifacts. A bare render includes all four.                  |
| `--overwrite`                            | Replace artifacts from an earlier render.                                    |
| `--json`                                 | One machine-readable envelope. Human progress goes to stderr.                |

The MCP server exposes `health_check`, `get_schema_guide`, `list_instruments`, `list_presets`, the authoring and edit tools (`validate_song`, `create_song`, `get_song`, `list_projects`, `update_song`, `add_track`, `add_notes`, `set_pattern`, `set_instrument`), and `render_song`, which renders one saved revision into that project's confined `renders/` tree through the same engine operation the CLI uses. `create_song` accepts either a complete `song` object or a `preset` ID with optional `title`, `bpm`, and `durationSeconds`. `health_check` reports the default backend, whether FluidSynth and a GM SoundFont are available, and whether a one-note smoke render succeeded.

A failed validation, render, or publication exits nonzero with a stable code and leaves no partial artifacts. WAV, stem, and MIDI bytes are deterministic for identical song data, options, backend versions, and platform. `report.json` includes run metadata and is not byte-identical across runs.

## Schema version

`schemaVersion` must be `"1.0.0"`. Any other value fails with `schema.version.unsupported`, and validation never rewrites a saved file.

Five authored cues with briefs and render commands are in [`examples/songs`](../examples/songs).
