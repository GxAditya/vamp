# Mixing for speech and delivering the cue

## How Vamp's mix works (constraints to design around)

- Per track: notes → volume (linear gain) → pan (equal power) → up to 8 effects in order → sum. There is **no master bus, no sends, no sidechain, no compressor or limiter**.
- The render normalizes master and stems together to a -1 dBFS peak with at most +9 dB of boost (default on). The absolute WAV level is therefore not your balance with the voice. That is set in the editor.
- The EQ has fixed bands: low shelf 250 Hz, peaking 1 kHz (Q 1), high shelf 4 kHz, each -18 to +18 dB.
- One `lowpass` per track; `filterCutoffHz` automation needs it and it must omit `cutoffHz`.
- A track with `automation.volume` must not set `volume`; the automation's first value holds before its first point.

## Linear gain ↔ dB

`gain = 10^(dB / 20)`

| dB   | 0   | -1.5 | -3   | -4.5 | -6  | -9   | -12  | -15  | -18  | -20 | -24   |
| ---- | --- | ---- | ---- | ---- | --- | ---- | ---- | ---- | ---- | --- | ----- |
| gain | 1.0 | 0.84 | 0.71 | 0.6  | 0.5 | 0.35 | 0.25 | 0.18 | 0.13 | 0.1 | 0.063 |

## Speech-safe recipe (inside the song)

Speech intelligibility lives mostly between 1 and 4 kHz (consonants 2-5 kHz). Music that sits under a voice has a sparse middle, energy below 500 Hz and above 6 kHz, no vocals, and no lead in the center.

1. **Arrange first.** ≤ 4 sounding layers under narration, no continuous melody, answers only in pauses.
2. **Duck the mid-range tracks** (keys, guitars, ostinato, melody) with `automation.volume`, not the bass or kick.
3. **EQ under speech:** keys / guitars / pads `midGainDb` -2 to -4, `highGainDb` -1 to -3. Bass `lowGainDb` 0 to -2 if it is boomy.
4. **Low-pass pads** at 2-4 kHz while there is narration; open them (automation) in music-only sections.
5. **Pan:** kick, bass, pad centered; keys -0.15 to -0.3; ostinato / melody ±0.3 to ±0.5. The center stays for the voice.
6. **Starting volumes:** drums 0.55-0.7, bass 0.8-0.9, keys 0.75-0.9, pad 0.4-0.55, ostinato 0.45-0.55, melody 0.5-0.6, sparkle 0.5-0.6.

### Ducking by automation

Convert narration windows to beats (`beat = seconds * bpm / 60`) and dip 6-9 dB with 0.25-0.8 s ramps. Return to full level only in pauses longer than about 1.5 s, otherwise the music pumps between sentences. Example at 120 BPM, narration 2.0-7.5 s and 9.0-15.5 s, hit at 16 s:

```json
"automation": {
  "volume": {
    "points": [
      { "time": 0, "value": 0.85 },
      { "time": 3.5, "value": 0.85 },
      { "time": 4, "value": 0.5 },
      { "time": 15, "value": 0.5 },
      { "time": 15.5, "value": 0.7 },
      { "time": 17.5, "value": 0.7 },
      { "time": 18, "value": 0.5 },
      { "time": 31, "value": 0.5 },
      { "time": 32, "value": 0.9 }
    ]
  }
}
```

Ramps start slightly before speech (0.5 beat = 250 ms at 120 BPM) so the first syllable is clear, and release after it ends (a full beat = 500 ms) so the swell feels natural. The 1.5 s pause (beats 15-18) gets only a partial lift.

## Report checks

| Field                                     | Good                                   | Fix when                                                                               |
| ----------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------- |
| `duration.actualSeconds` / `deltaSeconds` | equals the video length, delta 0       | longer: end notes earlier or shorten reverb/delay tails; shorter: raise `durationHint` |
| `audio.clipping.clipped`                  | false                                  | true: lower track volumes or velocities (rare with normalization)                      |
| `audio.mastering.gainDb`                  | 0 to +6                                | at +9 (the cap): the mix is very quiet; raise volumes so the arrangement survives      |
| `audio.loudness.integratedLufs`           | about -20 to -14 for a bed             | compare takes only; it is an approximation, not a delivery measurement                 |
| `warnings.validation` / `warnings.audio`  | empty                                  | read each and repair the data                                                          |
| `backend.id`                              | `fluidsynth-sf2-v1` for GM instruments | `builtin-synth-v1`: samples not active; say so                                         |

## Level in the final video

Targets that hold for most online video:

- Music is about 15-24 dB (LU) under the voice while someone speaks (documentary channels sit even lower), and comes up 6-10 dB in music-only moments.
- Finished mix around -14 LUFS integrated for YouTube and social (-16 for spoken-word heavy content), true peak at or below -1 dBTP.
- Always test on a phone speaker at low volume: if the words are hard to follow there, the bed is too loud.

Because Vamp normalizes to -1 dBFS peak, a reasonable starting volume for `master.wav` in the editor is 0.12-0.2 under narration and 0.5-0.9 alone. Adjust by ear.

## Remotion

Copy the render into `public/` (for example `public/music/cue.wav`), then:

```tsx
import { Audio, interpolate, staticFile, useVideoConfig } from 'remotion';

const NARRATION: Array<[number, number]> = [
  [2.0, 7.5],
  [9.0, 15.5],
];
const UNDER = 0.14;
const ALONE = 0.6;
const RAMP = 0.4;

export const Music = () => {
  const { fps } = useVideoConfig();
  return (
    <Audio
      src={staticFile('music/cue.wav')}
      volume={(frame) => {
        const t = frame / fps;
        const duck = Math.max(
          0,
          ...NARRATION.map(([a, b]) =>
            interpolate(t, [a - RAMP, a, b, b + RAMP], [0, 1, 1, 0], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            }),
          ),
        );
        return ALONE + (UNDER - ALONE) * duck;
      }}
    />
  );
};
```

Place `<Music />` at the composition root (or inside a `<Sequence from={offsetFrames}>` when the cue starts later; then hit points move by the same offset). The cue's length should equal `durationInFrames / fps`.

## ffmpeg

Fixed bed level under an existing voice track, then loudness-normalize the mix:

```sh
ffmpeg -i video.mp4 -i master.wav -filter_complex \
  "[1:a]volume=0.16[m];[0:a][m]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11[a]" \
  -map 0:v -map "[a]" -c:v copy -c:a aac -b:a 192k out.mp4
```

Automatic ducking keyed from the voice (gentle: ratio 4, 20 ms attack, 400 ms release):

```sh
ffmpeg -i video.mp4 -i master.wav -filter_complex \
  "[0:a]asplit=2[vo][key];[1:a]volume=0.3[m];[m][key]sidechaincompress=threshold=0.02:ratio=4:attack=20:release=400[duck];[vo][duck]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11[a]" \
  -map 0:v -map "[a]" -c:v copy -c:a aac -b:a 192k out.mp4
```

Video without its own audio (music only):

```sh
ffmpeg -i video.mp4 -i master.wav -map 0:v -map 1:a -c:v copy -c:a aac -b:a 192k -shortest out.mp4
```

Starting the cue at an offset (for example 1.5 s): add `adelay=1500|1500` to the music chain before `volume`.

## Stems

Each stem is the post-effect track with the same mastering gain, so the stems sum to the master. Hand them over when the editor may want to rebalance (pull the ostinato down under one line, mute drums in a quiet scene) without a new render.
