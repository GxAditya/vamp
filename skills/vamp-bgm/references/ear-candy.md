# Ear candy: small moves that make a cue sound produced

A loop becomes a cue when things happen at the right moments. Each device below is a one-time event: use one or two per section, tie each to something on screen (a cut, a title, a reveal, the end card), and keep them out of the way of narration unless noted.

All snippets are valid `SongSchemaV1` fragments. Times are quarter-note beats; examples assume a hit at beat 32 (bar 9 in 4/4). Shift every `start` / `time` by the same amount to move a device. `examples/explainer-20s.song.json` uses devices 1, 3, 4, 5, 6 and 9 together.

## 1. Snare roll into a section (the classic lift)

8ths turning into 16ths with rising velocity across the last 3 beats before the downbeat. Stop at beat 31.5 so device 4 (air gap) can work. Drums track `notes`:

```json
{ "pitch": 38, "start": 29, "duration": 0.2, "velocity": 50 },
{ "pitch": 38, "start": 29.5, "duration": 0.2, "velocity": 54 },
{ "pitch": 38, "start": 30, "duration": 0.2, "velocity": 58 },
{ "pitch": 38, "start": 30.5, "duration": 0.2, "velocity": 62 },
{ "pitch": 38, "start": 30.75, "duration": 0.2, "velocity": 66 },
{ "pitch": 38, "start": 31, "duration": 0.2, "velocity": 70 },
{ "pitch": 38, "start": 31.25, "duration": 0.2, "velocity": 76 }
```

**Tom variant (cinematic, rock):** high tom 50 → low-mid tom 47 → low tom 45 on 16ths over beats 30-31.75, velocity 70 → 100.

**Shaker lift:** shaker 70 on 16ths for the bar before the fill, velocity climbing from 24 to 40. It raises energy without touching the speech band.

## 2. Phrase-end markers

Mark every 4th bar so the listener feels the structure:

- Open hat 46 on beat 3.5 of bar 4 (velocity 50-58), replacing the closed hat there.
- Kick pickup on beat 3.75 (velocity 70) into the next downbeat.
- Ghost snare 38 at 2.75 or 3.75 (velocity 28-36) in lo-fi and funk grooves.

Write these into a `groove-b` pattern and place it every fourth bar instead of the main groove.

## 3. Filter riser (sweep into the reveal)

Open a low-pass over 2-4 bars. Vamp interpolates cutoff linearly in Hz, so add intermediate points that grow by about 1.3× each to get the exponential sweep the ear expects. The track needs exactly one `lowpass` effect with no `cutoffHz`, and must not set a static cutoff anywhere else:

```json
"automation": {
  "filterCutoffHz": {
    "points": [
      { "time": 0, "value": 2400 },
      { "time": 24, "value": 2400 },
      { "time": 26, "value": 3000 },
      { "time": 28, "value": 3800 },
      { "time": 30, "value": 5200 },
      { "time": 31, "value": 7000 },
      { "time": 31.5, "value": 9500 },
      { "time": 32, "value": 4500 }
    ]
  }
},
"effects": [
  { "type": "lowpass", "q": 1.2 },
  { "type": "reverb", "mix": 0.22, "decaySeconds": 2.0 }
]
```

Use it on a pad, poly synth 90 or the whole chord track. A `q` of 1.2-2 adds a slight resonant "whoosh"; keep it at 0.7-1 under narration.

**Intro filter-in:** the same idea from 600 Hz to 8000 Hz over the first 2 bars makes a cold open feel like it is arriving.

## 4. Air gap before the hit

End everything except a sustained pad (or nothing at all) half a beat before the hit. The silence makes the downbeat land twice as hard as any extra layer could:

- Last drum note at 31.25 (the roll above), nothing at 31.5-32.
- Chord, pluck and bass notes end by `start + duration <= 31.5`.
- Let one pad or reverb tail carry through the gap so it is not dead air.

For comedy and punchlines, make the gap a full beat and drop the pad too.

## 5. The impact stack (reveal, logo, CTA)

Several instruments on the same downbeat:

```json
{ "pitch": 36, "start": 32, "duration": 1, "velocity": 110 },
{ "pitch": 49, "start": 32, "duration": 2, "velocity": 84 }
```

on the drums track, plus:

- a sub note on the bass track: root an octave below the usual bass (G1 31 for G), duration 3-4 beats, velocity 100;
- the full chord on keys / strings, top voice doubled an octave up;
- optional brass section 61 or French horn 60 stab (0.5-1 beat, velocity 96), or crystal 98 for a cleaner "tech" reveal.

Pair it with a volume lift on ducked tracks at the same beat (`mixing-and-delivery.md`): the voice usually stops at the reveal, so the music can finally step forward.

## 6. Sparkle runs (harp, kalimba, crystal)

A fast ascending scale or arpeggio that lands on a transition. Harp 46 with a long reverb is the most versatile:

```json
{ "pitch": 67, "start": 30, "duration": 0.6, "velocity": 50 },
{ "pitch": 69, "start": 30.25, "duration": 0.6, "velocity": 54 },
{ "pitch": 71, "start": 30.5, "duration": 0.6, "velocity": 58 },
{ "pitch": 74, "start": 30.75, "duration": 0.6, "velocity": 62 },
{ "pitch": 76, "start": 31, "duration": 0.6, "velocity": 66 },
{ "pitch": 79, "start": 31.25, "duration": 0.6, "velocity": 70 }
```

(G major pentatonic G4-A4-B4-D5-E5-G5.) Use a pentatonic scale of the key so every note fits every chord. Reverb `mix` 0.3, `decaySeconds` 2.2, pan 0.3. A 4-note version on beat 0 of the intro (`62 67 71 74` at 16ths) is a lovely opening shimmer.

## 7. Delay throw

One pluck or vibraphone note with a tempo-synced delay echoing into a gap:

- `timeMs = 45000 / bpm` (dotted 8th), `feedback` 0.3-0.4, `mix` 0.25.
- Put it on a separate "throw" track so the main parts stay dry, and play one or two notes at the end of a phrase, right after the narrator's sentence ends.
- Delay tails count toward duration (`timeMs/1000 * ceil(ln 0.001 / ln feedback)`), so keep throws away from the final bar.

## 8. Counter-melody answers (call and response)

The narrator is the "call"; a 2-4 note answer fills the pause after each sentence. Use the narration timing to place them:

1. Find pauses ≥ 1 s from captions or `silencedetect` (`SKILL.md` step 1).
2. Convert to beats: `beat = seconds * bpm / 60`. Snap to the nearest 8th.
3. Write a falling or rising 3-note figure from the pentatonic scale, last note on a chord tone, velocity 54-66, on vibraphone 11, marimba 12, kalimba 108, clarinet 71 or flute 73, panned ±0.35.

Never let an answer run into the next sentence; end it 0.25 beats before speech returns.

## 9. Ostinato and pedal point

**Ostinato:** a repeating 8th-note figure on chord tones (example: `67 74 71 74` per half bar on muted guitar 28 at velocity 42-58). It gives momentum and a "produced" feel under speech without demanding attention. Change its notes with the chord, keep its rhythm fixed.

**Pedal point:** keep one note (usually the tonic in the bass or a high 5th in strings) while the chords move above it. Great for tension builds and intros. Over a D pedal, Dm → Bb → C → Dm feels like it is building toward something.

## 10. Octave lift and layering for the final section

Make the last section feel bigger without making it louder:

- Double the ostinato or melody an octave up (+12) at velocity -10.
- Add string ensemble 48 or choir 52 an octave above the pad.
- Switch hats from 8ths to 16ths at lower velocity (28-40), or add a tambourine on the offbeats.
- Move the bass from long notes to 8ths.

Add one of these per 8 bars. If the cue already has 5 or 6 parts sounding, remove one when you add one.

## 11. Endings (the "button")

Pick an ending that matches the cut:

- **Hard button:** everything stops on a downbeat with an impact stack (device 5). Final chord rings 2-4 beats, reverb tail finishes inside the length. Best for logo end cards.
- **Sus4 → major:** the chord before the final one is a sus4 (G: `55 60 62 67` → `55 59 62 67`). Resolve exactly on the cut.
- **Minor plagal (IV → iv → I):** warm and cinematic, perfect for "thank you" and mission endings. In C: F `53 57 60 65` → Fm `53 56 60 65` → C `52 55 60 67`, 2 beats each, last chord long.
- **Picardy third:** a minor cue ending on the major tonic (Dm → D major `50 57 62 66`). The story turns hopeful.
- **Fade by data:** for loops that will be cut by the editor, add `automation.volume` on every track from 1.0 to 0 over the last 2 bars, and still end notes inside the length.
- **Ritardando substitute:** Vamp has one tempo, so lengthen the last 2-4 notes (0.5 → 0.75 → 1.25 → held) instead of slowing down.

## 12. Texture and air

- Rain 96 at volume 0.12-0.2 under lo-fi and focus beds: barely audible, but it fills the silence between notes.
- Atmosphere 99, bowed glass 92 or soundtrack FX 97: a long note across a transition (2-4 bars), velocity 40-55, heavy reverb.
- A "breath" before a section: remove the drums for one bar while the pad keeps going; the return feels like a new section.

## 13. Humanize so it doesn't sound like a grid

- Roll chords: offset chord notes by 0.01-0.03 beats bottom to top (top to bottom for upstrums).
- Alternate hat velocities (strong-weak), accent beat 1 of each bar, and vary every 4th bar slightly.
- Swing: push offbeat 8ths to +0.58 (light), +0.62 (lo-fi) or +0.667 (shuffle).
- Push or pull a few melody notes by ±0.02 beats; never the kick and bass downbeats.
- Let pad notes overlap the next chord by 0.1-0.25 beats so changes are seamless.

## Restraint check

Before keeping a device, ask: does it line up with something on screen, and is the narrator silent while it plays? If not, cut it. One perfectly placed fill is worth more than ten random ones.
