---
name: vamp-bgm
description: Compose tasteful, original background music for a video with Vamp, the local MCP/CLI music engine. Turns video info (length, fps, scenes, narration timing, hit points, mood, platform) into a cue sheet, a tempo locked to the picture, an arranged multi-track SongSchemaV1 song with speech-safe mixing and ear candy, a rendered WAV/stems/MIDI take, and placement in Remotion or ffmpeg. Use whenever the user asks for background music, BGM, a soundtrack, score, underscore, music bed, jingle, intro/outro music, logo sting, or "music for this video", or when a video project (Remotion, ffmpeg, screen recording, explainer, trailer, launch reel) needs audio. Requires the Vamp MCP server (health_check, create_song, render_song...) or the `vamp` CLI.
---

# Vamp BGM: background music that serves the picture

Vamp renders songs that are plain JSON (`SongSchemaV1`) into `master.wav`, per-track stems, `song.mid` and `report.json`, fully offline. You write the music as data. This skill is how to write music a video editor would actually keep: it supports the voice, moves with the cuts, and lands the moments.

Three rules sit above everything else:

1. **The voice and the picture lead; the music serves them.** A bed that gets noticed in the wrong place has failed, however good it is.
2. **Never invent schema fields, instrument IDs or tool arguments.** Discover them (below). If a field is not in `get_schema_guide`, it does not exist.
3. **Do the math.** Durations, hit points and delay times are computed, not eyeballed. A cue that ends 0.3 s late or a hit two frames off reads as amateur.

Reference files (read when the step needs them):

- `references/styles.md`: style cookbook (tempo, key, progressions with exact MIDI voicings, GM instruments, drum grids) for 12 common video genres.
- `references/ear-candy.md`: arrangement devices that lift quality (fills, risers, air gaps, sparkle, counter-melody, endings) with copy-ready Vamp JSON.
- `references/mixing-and-delivery.md`: speech-safe mixing inside Vamp, the dB table, ducking by automation, and placing the render in Remotion or ffmpeg at the right level.
- `examples/explainer-20s.song.json`: a complete, validated 20 s explainer cue (narration ducking, ostinato, filter riser, fill, air gap, logo hit on a bar line, tail that ends inside the length). Read it before writing your first song; it shows every pattern in this skill working together.

## Step 0: check the engine

Call `health_check` (MCP) or run `vamp doctor` (CLI) first.

- **FluidSynth + GM SoundFont available:** use named GM programs (`{ "type": "gm", "program": N, "bank": 0 }`) from `list_instruments` → `gmCatalog`. This is the only path to real sampled pianos, strings, guitars and brass.
- **Built-in synth only:** you may only use the six curated IDs `piano.soft`, `keys.soft`, `bass.sub`, `pad.warm`, `guitar.clean`, `drums.kit`. `gm` instruments will fail. Tell the user the result will sound synthesized and that `sudo apt install fluidsynth fluid-soundfont-gm` (or `brew install fluid-synth` plus a GM `.sf2`) fixes it. Do not present synth output as sampled.
- Drums are always `{ "type": "builtin", "id": "drums.kit" }` on a `kind: "drums"` track, channel 9. GM percussion keys: kick 36, side stick 37, snare 38, clap 39, electric snare 40, closed hat 42, pedal hat 44, low tom 45, open hat 46, low-mid tom 47, crash 49, high tom 50, ride 51, ride bell 53, tambourine 54, cowbell 56, shaker 70, claves 75.

Then call `get_schema_guide` once per session and `list_presets` if a preset might fit.

## Step 1: turn the video into a cue sheet

Gather facts before choosing a note. Infer them from the project first and ask only for what you cannot find:

| Fact                 | Where to find it                                                                                                                                                                                            |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact length and fps | Remotion: `<Composition durationInFrames fps>` in `Root.tsx`. Any file: `ffprobe -v error -show_entries format=duration -of csv=p=0 video.mp4`                                                              |
| Scenes and cuts      | Remotion `<Sequence from durationInFrames>` / `<Series.Sequence>` boundaries (seconds = frames / fps). Footage: `ffmpeg -i video.mp4 -vf "select='gt(scene,0.4)',showinfo" -f null - 2>&1 \| grep pts_time` |
| Narration timing     | Captions (SRT/VTT/JSON), the script, or `ffmpeg -i vo.wav -af silencedetect=noise=-35dB:d=0.4 -f null -` (speech = the gaps between silences)                                                               |
| Hit points           | Logo reveal, title card, product shot, CTA, punchline, transition frames                                                                                                                                    |
| Mood and brand       | User's words, script tone, visual pace (cuts per minute), colour palette, audience                                                                                                                          |
| Platform             | YouTube / social short / product page / conference / ad (sets loudness and length)                                                                                                                          |

Write the cue sheet down (in your reply or a scratch file) before composing:

```text
Cue: product-explainer   Length: 20.000 s (600 frames @ 30 fps)   Platform: YouTube
Mood: bright, confident, calm under voice      Narration: 2.0 s - 15.5 s (dense)
Scenes:  0.0 intro logo | 2.0 problem | 8.0 product demo | 12.0 features | 16.0 logo + CTA
Hits:    16.0 logo reveal (hard)   8.0 demo start (soft)
Ending:  button on the downbeat, ring out, silent by 19.8 s
```

## Step 2: pick the palette

Map the brief to a style in `references/styles.md` (tempo range, mode, progression, instruments, groove). Rules of thumb:

- **Energy maps to tempo and rhythmic density, not loudness.** Calm 60-85 BPM, conversational 85-105, upbeat 105-125, urgent 125-140.
- **Valence maps to mode and voicing.** Major and open add9/6 voicings read optimistic; minor with 7ths and 9ths reads warm or serious; suspended chords read as anticipation.
- **Cutting pace sets the harmonic rhythm.** One chord per bar for most edits; two chords per bar only for fast montage; one chord per two bars for ambient or slow reveals.
- **Under dense narration, choose texture over tune.** Pad + bass + a rhythmic ostinato + light drums. Save melody for the gaps and for music-only moments.
- If a preset fits the brief (`lofi`, `tutorial_upbeat`, `ambient_focus`, `corporate_clean`, `stinger`), `create_song` with `preset`, `bpm` and `durationSeconds` gives a credible start. Then `get_song` and improve it with this skill (ducking, hits, ear candy), because presets know nothing about your picture.

## Step 3: lock the tempo to the picture

Vamp has one constant tempo per song, so the tempo is what makes hits land. Time in Vamp is quarter-note beats.

```text
secondsPerBeat = 60 / bpm          beats = seconds * bpm / 60          bar (4/4) = 4 beats
```

**One hard hit at T seconds** (measured from where the music starts): pick a whole number of bars `k` so `bpm = 60 * 4k / T` lands inside the style's tempo range. 16.0 s with k = 8 → 120 BPM; k = 7 → 105 BPM; k = 6 → 90 BPM.

**Several hits:** search tempos and keep the one with the smallest worst error, accepting at most one frame (33 ms at 30 fps, 42 ms at 24 fps). Strong hits should land on a downbeat; soft ones on any beat. Run this instead of guessing:

```sh
node -e '
const hits=[{t:8.0,bar:false},{t:16.0,bar:true}], fps=30, lo=96, hi=126;
const rows=[];
for(let bpm=lo;bpm<=hi;bpm++){let worst=0;for(const h of hits){const b=h.t*bpm/60,g=h.bar?4:1;
worst=Math.max(worst,Math.abs(b-Math.round(b/g)*g)*60/bpm)}rows.push([bpm,+(worst*1000).toFixed(1)])}
rows.sort((a,b)=>a[1]-b[1]);console.log("bpm, worst error ms (<=",(1000/fps).toFixed(0),"ok):",rows.slice(0,5))'
```

If no tempo fits, you have two honest levers: start the cue earlier or later in the edit (an offset `o` so `T - o` is a whole number of bars), or put the hit on a pickup structure (the downbeat on the hit, the earlier music starting mid-bar). Do not scatter hits on random 16ths.

**Length:** `durationHint = seconds * bpm / 60` beats (20 s at 120 BPM = 40). It is a minimum, not a cut: the render extends through any note or reverb/delay tail that runs past it. End the last notes early enough that `lastNoteEndSeconds + longest tail` fits inside the length. Verify with `vamp info --json` (`duration.estimatedRenderedSeconds`) or the render report.

## Step 4: arrange in sections that follow the scenes

Map scenes to an energy curve. A good default for a narrated 15-60 s cue:

| Section          | Picture                 | What plays                                                                     |
| ---------------- | ----------------------- | ------------------------------------------------------------------------------ |
| Intro (1-2 bars) | logo / cold open        | pad or keys alone, a sparkle on beat 1                                         |
| Establish        | first narration         | add bass and the lightest groove; keep it thin                                 |
| Body             | demo / main points      | ostinato and full groove at low velocity; change one element every 4 or 8 bars |
| Lift (1-2 bars)  | build before the reveal | shaker 16ths, filter riser, drum fill, then an air gap                         |
| Hit              | reveal / CTA            | crash + kick + full chord on the downbeat, music swells once the voice stops   |
| Button           | end card                | final chord rings, reverb tail finishes before the cut                         |

- **Build by addition and subtraction, not by volume.** Every 4 or 8 bars, add or remove one layer (hats, ostinato, pad octave). A loop that never changes is wallpaper; one that changes every bar is distracting.
- **Phrase in 4 and 8 bars**, and put the change on the downbeat that matches a cut.
- **Leave space before big moments.** The half beat of near-silence before a hit (the "air gap") makes the hit twice as big as any extra layer would.
- **Long cues (60 s and up):** A (thin) → B (fuller) → A' (thinner breakdown under the densest narration) → B' (fullest, octave lift) → button. Use different pattern variants so repeats are not identical.

## Step 5: write the parts

Give every part its own register and job. Pitches are MIDI keys (C4 = 60).

| Role             | Register                       | Job and rules                                                                                                                                                                                                                   |
| ---------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bass             | 28-50 (E1-D3)                  | Root on beat 1, motion on the "and"s, a fifth or octave pickup into the next chord. Short notes (0.4-0.9 beats) for upbeat, long for ambient. Bass and kick on the same beat 1.                                                 |
| Chords / keys    | lowest note ≥ 48, mostly 52-72 | Spread voicings: wide intervals low, close intervals high; no thirds below C3 (48), no clusters below C4. Smooth voice leading: move each voice by the smallest step. Drop the root (the bass has it) and use 7ths, 9ths, 6ths. |
| Pad              | 43-67, low-passed              | Whole-bar sustains at velocity 45-62 to glue the harmony. Low-pass 2-4 kHz under narration.                                                                                                                                     |
| Ostinato / pulse | 64-79, off-center              | Repeated 8th-note pattern on chord tones (muted guitar 28, kalimba 108, harp 46, pizzicato 45, marimba 12). It carries momentum without asking for attention. Velocity 40-60.                                                   |
| Melody / answers | 72-91, off-center              | Sparse: 2-4 note answers in narration gaps, or a real hook only in music-only sections. Never a continuous line under speech.                                                                                                   |
| Drums            | GM keys                        | Groove from the style grid; velocities vary per hit. Under speech: kick 85-105, snare/clap 55-75, closed hats 30-48, open hats/crash 50-70.                                                                                     |

**Humanize everything.** Never use one flat velocity. Accent downbeats (+8 to +14), alternate strong and weak hats, rise into fills. For swing, push offbeat 8ths from `+0.5` to `+0.58` (light), `+0.62` (lo-fi) or `+0.667` (triplet shuffle) within each beat. Keep chord notes in one hit within about 6 velocity of each other, top note slightly louder or softer by role.

**Use patterns for repetition and variants for development.** Placements cannot transpose or change velocity, so author `groove-a`, `groove-b`, `fill` as separate patterns instead of one pattern repeated 40 times. Free notes and placements can coexist on a track.

Ready-made progressions with exact voicings, plus genre drum grids: `references/styles.md`.

## Step 6: make room for the voice

Vamp has no master bus and no sidechain, so speech-safe mixing is done in the arrangement and per track (details and numbers in `references/mixing-and-delivery.md`):

1. **Arrange around speech first.** Fewer layers (3-4) and no melody while someone talks; fills, answers and swells go in the gaps.
2. **Duck with `automation.volume`.** Drop the busiest mid-range tracks to 0.5 (-6 dB) or 0.35 (-9 dB) from just before narration starts until it ends, with 0.25-0.8 s ramps, and swell back in pauses longer than about 1.5 s. A track with `automation.volume` must not also set `volume`.
3. **Carve, don't bury.** Vamp's EQ bands are fixed: low shelf 250 Hz, peak 1 kHz (Q 1), high shelf 4 kHz. On keys, guitars and pads under speech: `midGainDb` -2 to -4, `highGainDb` -1 to -3. Low-pass pads to 2-4 kHz.
4. **Keep the center for the voice.** Kick, bass and pad stay near center; keys, ostinato and melody go to ±0.2 to ±0.5.
5. **Delays in time:** quarter = `60000 / bpm` ms, 8th = `30000 / bpm`, dotted 8th = `45000 / bpm`. Keep `mix` ≤ 0.2 and `feedback` ≤ 0.35 under speech; reverb `mix` 0.1-0.25 and `decaySeconds` 1.2-2.4 for beds.

## Step 7: add ear candy where the picture asks for it

Small, one-time events that make a loop feel produced: a drum fill or snare roll into a new section, a low-pass filter riser over 2-4 bars, an air gap before the hit, crash + kick + sub note on the reveal, a harp or kalimba sparkle on transitions, a dotted-8th delay throw on one pluck, a counter-melody answer between sentences, an octave lift for the final section, a sus4 that resolves on the button, a minor-plagal (IV → iv → I) ending. Use one or two per section, tie each to something on screen, and keep them under the voice. Copy-ready JSON: `references/ear-candy.md`.

## Step 8: validate, render, review, revise

1. `validate_song` with the full song (no write). Fix every error at the reported path.
2. `create_song` with `projectId` (lowercase, digits, `.`, `_`, `-`) and either `song` or `preset`, never both. Remember the returned `revision`.
3. `render_song` with `projectId`, the `expectedRevision` you just read, and a `renderName` such as `take-1`. CLI equivalent: `vamp render song.json --out renders/take-1`.
4. Read the report before calling it done:
   - `duration.actualSeconds` equals the video length (`deltaSeconds` ≈ 0).
   - `audio.clipping.clipped` is false and there are no `warnings`.
   - `audio.mastering.gainDb` at the +9 dB cap means the mix is very quiet: raise track volumes so the shape survives normalization.
   - `loudness.integratedLufs` is a relative check between takes, not a delivery target. The final level is set in the editor (Step 9).
   - The backend is the one you expected (`fluidsynth-sf2-v1` for sampled instruments).
5. Self-review the data, since you cannot listen: at every narration second, count melodic layers (≤ 4) and check no melody is sounding; check velocity spread (≥ 15 between weakest and strongest hats); check every hit point has a downbeat event; check the last note plus tail ends inside the length.
6. Revise the data, not your expectations. `get_song` for the current revision, then `update_song` / `add_track` / `add_notes` / `set_pattern` / `set_instrument` with that `expectedRevision`. On `project.revision.conflict`, re-read and reapply. Render the new revision as `take-2` so earlier takes survive.

## Step 9: deliver

Give the user the artifact paths (`master.wav`, stems, `song.mid`, `report.json`), the song revision, the tempo and the hit-point math. Then place it:

- Music sits about 15-24 dB (LU) under the voice while someone speaks and comes up 6-10 dB in music-only moments. In editor terms the rendered (normalized) master usually needs a volume around 0.1-0.2 under narration and 0.5-0.9 alone.
- Remotion and ffmpeg snippets, including ducking keyed to narration and a final `loudnorm`, are in `references/mixing-and-delivery.md`.
- Stems let the user rebalance later (for example, pull the ostinato down under one sentence) without a re-render.

## Avoid by default

- Whole-note chords for the entire cue, or one continuous nursery-rhyme melody.
- Identical velocities, identical bars, and six instruments playing all the time.
- A bright lead (saw 81, solo violin, flute, sax) in the center under speech.
- Loud hats or crashes during narration; reverb washes over fast speech.
- Hits off the bar line, a tail that runs past the cut, or a hint rounded "to be safe".
- Inventing instrument IDs, schema fields or tool arguments; claiming sampled sound on the synth backend.
