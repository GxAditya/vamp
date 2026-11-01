# Form and arrangement

## Macro forms (bar counts in 4/4)

| Form                 | Map                                                                               | Good for                         |
| -------------------- | --------------------------------------------------------------------------------- | -------------------------------- |
| ABA'                 | intro 2-4 · A 8 · B 8 · A' 8 · coda 2-4                                           | lyrical pieces, themes, 60-100 s |
| AABA (32-bar)        | A 8 · A 8 · B 8 · A 8 (+ tag)                                                     | jazz-ish, standards, game music  |
| Verse-chorus         | intro 4 · V 8 · PC 4 · C 8 · V 8 · PC 4 · C 8 · bridge 8 · C 8 (lifted) · outro 4 | pop, rock, anthems               |
| Loop music           | intro 8 · A 16 · B 16 · breakdown 8 · A' 16 · outro 8                             | electronic, lo-fi, house         |
| Theme and variations | theme 8-16, then 3-5 variations changing one dimension each                       | showcasing one idea, études      |
| Game loop            | A 8-16 · B 8-16 · back to A, with the last bar leading seamlessly to bar 1        | background loops                 |
| Through-composed cue | sections follow a story with a recurring motif                                    | film-like pieces, trailers       |
| Short sting / jingle | 2-4 bars: setup → hook → button                                                   | logos, notifications             |

Length check: `seconds = bars * barBeats * 60 / bpm`. At 88 BPM, 4/4, a bar is 2.73 s; 30 bars ≈ 82 s.

## Energy arc

Write a value 1-10 per section before arranging:

```text
intro 2 | A 4 | B 6 | A' 8 | coda 3          (Paper Lanterns)
intro 3 | V1 4 | PC 6 | C1 7 | V2 5 | PC 7 | C2 8 | bridge 5 | C3 10 | outro 3
```

- One main peak around 65-80% through; at least one dip before it.
- The intro promises; it doesn't give everything away.
- Never let energy plateau for more than 16 bars without a change of some kind.

## Section contrast (change at least two per boundary)

| Dimension | Lower energy                      | Higher energy                                   |
| --------- | --------------------------------- | ----------------------------------------------- |
| Register  | narrow, middle                    | wide, melody up an octave, bass down an octave  |
| Density   | 2-3 parts                         | 5-6 parts, doublings                            |
| Rhythm    | long notes, half-time             | 8ths and 16ths, syncopation, fills              |
| Harmony   | slow harmonic rhythm, tonic pedal | faster changes, secondary dominants, modulation |
| Timbre    | soft (EP, nylon, flute low, pads) | bright (piano high, strings, brass, open hats)  |
| Dynamics  | velocities 40-65                  | velocities 75-105                               |
| Space     | drier, closer                     | wider pan, more reverb on the leads             |

Transitions: a fill or pickup in the last bar, a dropout (remove drums or bass for 1 bar or 2 beats), a riser (`filterCutoffHz` or volume swell), or a harp/mallet run into the downbeat.

## Orchestration: every part has a job

Layers (use only what the piece needs):

1. **Melody**: one at a time. Make it stronger by **octave doubling** (two instruments an octave apart, the lower one softer) at the peak, not by stacking unisons.
2. **Counter-melody**: in the gaps or a 3rd-6th below; different timbre (clarinet under flute, cello under violin, vibes under EP).
3. **Harmony**: comping (rhythmic chords), arpeggios (Alberti 1-5-3-5, broken chords), or sustained pads. Usually one active harmony part plus one sustain.
4. **Bass**: roots on strong beats, 5ths and approach notes (a step or half step into the next root) on weak ones.
5. **Rhythm**: drums and/or an ostinato.
6. **Colour**: harp, mallets, celesta-like crystal 98, FX pads, for transitions and peaks only.

Register map (avoid two parts in the same register **and** the same rhythm):

| Part        | Range (MIDI) | Comfortable GM choices                                                                         |
| ----------- | ------------ | ---------------------------------------------------------------------------------------------- |
| Sub / bass  | 28-50        | upright 32, finger 33, picked 34, fretless 35, synth 38, cello 42, bassoon 70                  |
| Low harmony | 45-60        | cello 42, horn 60, strings 48 (low), piano LH                                                  |
| Mid harmony | 52-72        | piano 0, EP 4/5, nylon 24, strings 48, organ 16, poly pad 90                                   |
| Melody      | 60-84        | flute 73, clarinet 71, oboe 68, violin 40, trumpet 56, vibraphone 11, piano RH, fifths lead 86 |
| High colour | 72-96        | harp 46, kalimba 108, crystal 98, marimba 12, glock-like mallets                               |

Instrument notes:

- Flute is weak below G4 (67) and bright above C6 (84): put flute tunes in 67-86.
- Clarinet is warm and dark from 52-70: ideal for counter-melodies and B sections.
- Strings ensemble 48 is a glue pad: low velocity, `lowpass` 5-7 kHz, long notes.
- Tremolo strings 44 means tension; pizzicato 45 means playful; harp 46 runs mean transition.
- Brass 61 is for stabs and swells, not sustained beds; horn 60 is warm enough for melodies.
- Choir 52 sits an octave above the pad, at low velocity.
- Saw lead 81 is a game/EDM accent only.

## Writing accompaniment that breathes

- **Alberti / broken chord:** indices [0, 2, 1, 2] over a 3-note voicing in 8ths. It is classical-sounding and gentle (used in Paper Lanterns).
- **Pop piano 8ths:** the full chord on 1, then 8th-note repeated upper notes with an accent pattern 1 . . 1 . . 1 . (3+3+2).
- **Comping (jazz / neo-soul):** short chords on the and-of-2 and the and-of-4, a sustained chord on 1 every other bar.
- **Guitar strum:** down-up pattern with low → high note offsets of 0.02 beats on downstrums; upstrums only the top 3 strings, softer.
- **Pads:** one voicing per chord, ending 0.05 beats before the next, overlapping by a hair in ambient music.

## Groove writing

- Kick and bass agree on the downbeats. Snare/clap marks the backbeat (2 and 4, which are beats 1 and 3 in zero-based beats).
- Hats carry the subdivision with strong/weak velocity alternation; open hats mark phrase ends.
- Ghost notes (snare 25-40) and a syncopated kick (the and-of-2, 1.5 or 2.5) create groove.
- Write at least two drum patterns per piece (verse / chorus) plus a fill. Use patterns and placements in Vamp, with free notes for fills.
- Half-time feel (snare only on beat 3) for breakdowns; double-time hats for lifts.

## Producing in Vamp

| Goal                 | Vamp move                                                                                      |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| Push a part back     | lower `volume`, raise reverb `mix` (0.3-0.4), `lowpass` 3-5 kHz                                |
| Bring a part forward | higher `volume`, drier (`mix` 0.1-0.15), `eq` `midGainDb` +1 to +2                             |
| Warmth               | `eq` `highGainDb` -2, `lowpass` 6-8 kHz on keys and pads                                       |
| Clarity              | `eq` `lowGainDb` -2 to -4 on non-bass parts to clear the low end                               |
| Width                | pan supporting parts ±0.2-0.5, keep bass / kick / lead centered                                |
| Build                | `automation.filterCutoffHz` 800 → 9000 over 2-4 bars (add points that grow ×1.3)               |
| Swell                | `automation.volume` 0.2 → 1.0 over 1-2 bars on strings or pads                                 |
| Echo                 | `delay` at `45000/bpm` ms (dotted 8th), feedback 0.3, mix 0.2 on one lead                      |
| Shared room          | similar reverb `decaySeconds` on all tracks (for example 2.0-2.4 s), different `mix` per depth |
| Ending               | let tails finish inside `durationHint`; check `vamp info --json`                               |

The master has no limiter or bus; normalization brings the peak to -1 dBFS with at most +9 dB. If the report shows the +9 dB cap, raise track volumes.
