# Style cookbook

Twelve video genres, each with a tempo range, key, progression, exact voicings, instruments and a groove. Every instrument is a real Vamp GM program (`{ "type": "gm", "program": N, "bank": 0 }`) from `list_instruments` → `gmCatalog`; drums are `drums.kit`. On the built-in synth fallback, substitute the closest curated ID (`piano.soft`, `keys.soft`, `bass.sub`, `pad.warm`, `guitar.clean`).

How to read the tables:

- **Voicings** are MIDI keys for the chord / keys / pad track, one chord per bar unless noted. The bass track plays the listed root. C4 = 60.
- **Grooves** list positions in quarter-note beats inside one 4/4 bar (0, 0.5, 1 ... 3.5) with suggested velocities. Put each groove in a pattern with `lengthBeats: 4`, then write a second variant (an extra kick, an open hat at 3.5, a ghost snare) for every fourth bar.
- Transpose a whole style by adding the same number of semitones to every pitch. Keep chord bottoms at 48 or above and bass between 28 and 50.

Quick picker:

| Brief                                                         | Style                       |
| ------------------------------------------------------------- | --------------------------- |
| Coding tutorial, dev tool walkthrough, docs video             | 1 Tech explainer or 2 Lo-fi |
| Product launch, feature reel, SaaS promo                      | 3 Launch pop                |
| Company intro, B2B, onboarding                                | 4 Corporate clean           |
| Beauty shots, focus, meditative intro, slow product turntable | 5 Ambient                   |
| Data story, research, documentary, case study                 | 6 Documentary underscore    |
| Trailer, keynote opener, big reveal                           | 7 Cinematic build           |
| Testimonial, mission, thank-you, retrospective                | 8 Emotional piano           |
| Kids, comedy, quirky how-to                                   | 9 Playful                   |
| Gaming, retro tech, night city, hacker aesthetic              | 10 Synthwave                |
| Small business, travel, craft, food                           | 11 Acoustic folk            |
| Problem statement, security incident, mystery                 | 12 Tension                  |

---

## 1. Tech explainer (upbeat, narration-friendly)

- **Tempo / key:** 105-122 BPM, G major. Bright but not hyped.
- **Progression:** I - V/3 - vi7 - IV(add9): Gadd9 - D/F# - Em7 - Cadd9.
- **Voicings:** Gadd9 `55 59 62 69` · D/F# `57 62 66 69` · Em7 `55 59 62 64` · Cadd9 `55 60 62 64`. Bass G2 43 · F#2 42 · E2 40 · C2 36.
- **Instruments:** soft EP 5 (chords) · string ensemble 48 (pad, 0.4-0.5) · picked bass 34 · muted guitar 28 or marimba 12 (8th-note ostinato, panned 0.4) · harp 46 (sparkle).
- **Keys comp:** hits at 0 (1.4 beats, vel 78), 1.5 (0.45, 62), 2 (1.4, 72), 3.5 (0.45, 58).
- **Bass:** root 0 (0.9, 92) · root 1.5 (0.4, 72) · fifth 2 (0.9, 84) · octave 3.5 (0.4, 68).
- **Groove:** kick 0 (94), 2 (86), 2.75 (58) · side stick 1 (60), 3 (64) · closed hat 0.5/1.5/2.5/3.5 (40, 34, 44, 36). Add a clap on 1 and 3 and shaker 16ths only in the lift.
- **Full worked example:** `examples/explainer-20s.song.json`.

## 2. Lo-fi coding bed

- **Tempo / key:** 74-90 BPM, A minor. Swing the 8ths to +0.62.
- **Progression:** i9 - VImaj9 - IIImaj9 - VII(add9): Am9 - Fmaj9 - Cmaj9 - Gadd9.
- **Voicings:** Am9 `55 60 64 71` · Fmaj9 `57 60 64 67` · Cmaj9 `55 59 62 64` · Gadd9 `55 59 62 69`. Bass A1 33 · F1 29 · C2 36 · G1 31.
- **Instruments:** tine EP 4 (low-pass 4500-5600 Hz) · warm pad 89 or poly pad 90 (low-pass 3000) · finger bass 33 or upright 32 · vibraphone 11 answers (delay dotted-8th) · rain 96 at volume 0.15 for texture.
- **Keys comp:** 0 (1.25, 76), 1.62 (0.38, 62), 2.5 (1.0, 70). Roll each chord: offset notes by 0.02 beats bottom to top.
- **Bass:** root 0 (1.2, 90) · root 1.62 (0.38, 70) · fifth 2.5 (0.9, 80) · octave pickup 3.62 (0.3, 66).
- **Groove (boom-bap):** kick 0 (100), 1.62 (78), 2.5 (92) · snare 1 (72), 3 (76) · ghost snare 2.87 (32) · closed hats every 8th, swung, 32-50 alternating · open hat 3.62 every fourth bar (52).
- **Mix:** keys pan -0.2, vibes 0.35. Low-pass everything above 6 kHz; that is the lo-fi sound and it keeps out of the voice.

## 3. Launch pop (product reveal, feature reel)

- **Tempo / key:** 118-128 BPM, A minor / C major. Four-on-the-floor.
- **Progression:** vi7 - IV(add9) - I/3 - V: Am7 - Fadd9 - C/E - G.
- **Voicings:** Am7 `55 60 64 69` · Fadd9 `53 57 60 67` · C/E `55 60 64 67` · G `55 59 62 67`. Bass A1 33 · F2 41 · E2 40 · G2 43, in 8ths with octave jumps on the offbeats (root, root+12).
- **Instruments:** bright piano 1 (short stabs on 0.5 and 2.5) · poly synth pad 90 (low-pass automation riser) · synth bass 38 · fifths lead 86 for a 4-note hook in music-only bars only · crystal 98 on the reveal.
- **Groove:** kick every beat (104, 92, 100, 92) · clap 1 and 3 (82) · open hat on every offbeat 0.5/1.5/2.5/3.5 (48-58) · closed hat 16ths in the lift (28-44).
- **Arrangement:** 2-bar filtered intro (cutoff 600 → 9000), full groove at the first feature, drop to pad + hook for one bar, air gap, reveal.

## 4. Corporate clean

- **Tempo / key:** 100-112 BPM, C major. Confident, mid-forward, short reverb.
- **Progression:** Imaj9 - V - vi7 - IVmaj7: Cmaj9 - G - Am7 - Fmaj7.
- **Voicings:** Cmaj9 `52 55 59 62` · G `55 59 62 67` · Am7 `57 60 64 67` · Fmaj7 `53 57 60 64`. Bass C2 36 · G2 43 · A2 45 · F2 41.
- **Instruments:** electric grand 2 (half-note hits on 0 and 2) · string ensemble 48 (pad 0.5) · finger bass 33 · flute 73 (a 3-4 note phrase every fourth bar, pan 0.35) · pizzicato 45 optional 8ths.
- **Groove:** kick 0 (96), 2 (90) · clap 1 (70), 3 (74) · closed hat 8ths (34-46) · tambourine 0.5/1.5/2.5/3.5 (30-40).
- **Mix:** EQ chords `lowGainDb -1, midGainDb +1, highGainDb -1` when there is no narration, `midGainDb -2` when there is. Reverb 0.14 / 1.8 s.

## 5. Ambient focus (no drums)

- **Tempo / key:** 60-72 BPM, D major. One chord per two bars.
- **Progression:** Imaj9 - vi9 - IVmaj9 - Vsus4 → V: Dmaj9 - Bm9 - Gmaj9 - Asus4 → A.
- **Voicings:** Dmaj9 `54 57 61 64` · Bm9 `50 54 57 61` · Gmaj9 `54 57 59 62` · Asus4 `52 57 62 64` → A `52 57 61 64` (resolve on beat 3 of the second bar). Bass D2 38 · B1 35 · G1 31 · A1 33.
- **Instruments:** warm pad 89 (main, 0.85) · halo pad 94 (upper layer, an octave up, 0.55) · fretless bass 35 (one long root per chord) · kalimba 108 (2-3 notes every 8 bars, vel 40-48, delay quarter-note) · bowed glass 92 or atmosphere 99 for transitions.
- **Pulse (optional):** shaker 8ths at 26-38, never a kit.
- **Mix:** low-pass pads 2600-3400 Hz, reverb 0.3 / 3.2 s. Let notes overlap the chord change by a quarter beat for a seamless wash.

## 6. Documentary underscore

- **Tempo / key:** 70-84 BPM, D minor. Strings and piano pulse, no drums.
- **Progression:** i - VI - III - VII: Dm - Bb - F - C (or i - iv - VI - V: Dm - Gm - Bb - A for more gravity).
- **Voicings (strings):** Dm `50 57 62 65` · Bb `50 58 62 65` · F `48 57 60 65` · C `48 55 60 64`. Bass D2 38 · Bb1 34 · F2 41 · C2 36.
- **Instruments:** string ensemble 48 (sustains, vel 50-64) · grand piano 0 (8th-note pulse on two upper chord tones, vel 44-56, pan -0.3) · cello 42 or acoustic bass 32 (roots) · oboe 68 or clarinet 71 (a 2-bar line in the gaps only).
- **Piano pulse:** alternate the top two chord tones an octave up (Dm: 69/74, Bb: 70/74, F: 69/72, C: 67/72) every 8th.
- **Optional heartbeat:** kick 0 (78), 0.375 (58) every bar for tension sections only.

## 7. Cinematic build (trailer, keynote opener)

- **Tempo / key:** 84-100 BPM, D minor. Build over 8-16 bars into one hit.
- **Progression:** i - VI - III - VII, then i - iv - V for the final approach: Dm - Bb - F - C | Dm - Gm - A.
- **Voicings:** Dm `50 57 62 65` · Bb `50 58 62 65` · F `48 57 60 65` · C `48 55 60 64` · Gm `50 55 58 62` · A `49 57 61 64`. Bass / low brass roots D2 38 · Bb1 34 · F2 41 · C2 36 · G2 43 · A1 33.
- **Instruments:** tremolo strings 44 (swells via `automation.volume` 0.3 → 1.0 per 2 bars) · string ensemble 48 16th-note ostinato on D4 62 / A3 57 · cello 42 · brass section 61 or French horn 60 (stabs on hits) · choir aahs 52 (low, octave up, final 4 bars) · soundtrack FX 97 for the intro.
- **Drums:** low tom 45 and low-mid tom 47 on 0, 1.5, 2, 3, 3.5, crescendo velocity every bar (60 → 110) · crash 49 + kick 36 only on the hit and section downbeats.
- **Hit:** full Dm voicing doubled an octave up, brass, crash, kick, sub D1 26 on the bass track; then 1-2 bars of reverb tail.

## 8. Emotional piano (testimonial, mission)

- **Tempo / key:** 66-80 BPM, C major. Piano first, strings enter in the second half.
- **Progression:** I - V/7 - vi7 - IVmaj9: C - G/B - Am7 - Fmaj9 (end on IV → iv → I, see `ear-candy.md`).
- **Piano voicings (one track; left hand + right-hand arpeggio in 8ths):** C: LH `36 43`, RH `64 67 72 74` · G/B: LH `35 43`, RH `62 67 71 74` · Am7: LH `33 40`, RH `64 67 72 76` · Fmaj9: LH `29 36`, RH `64 67 69 72`. The low pairs are fifths and sixths, which stay clear even below C3.
- **Instruments:** grand piano 0 (vel 48-70, louder on beat 1) · string ensemble 48 (enters bar 5, pad voicing an octave below the RH) · cello 42 (slow counter-line in 2-beat notes, bars 9+).
- **Arpeggio order:** RH notes 1-2-3-4-3-2-3-4 across 8 eighths; vary the order every other bar.
- **Mix:** reverb 0.25 / 2.4 s on piano, pan piano -0.1, strings 0.15. No drums.

## 9. Playful (kids, comedy, quirky how-to)

- **Tempo / key:** 110-125 BPM, D major. Short, bouncy notes.
- **Progression:** I - vi - ii - V7: D - Bm - Em - A7.
- **Voicings (short, 0.25-0.4 beats):** D `54 57 62 66` · Bm `54 59 62 66` · Em `55 59 64 67` · A7 `55 61 64 69`. Bassoon / bass D2 38 · B1 35 · E2 40 · A1 33, staccato root on 0 and fifth on 1 and 3.
- **Instruments:** pizzicato strings 45 (chords on the offbeats 0.5, 1.5, 2.5, 3.5) · marimba 12 (melody) · clarinet 71 (answers) · bassoon 70 (bass) · glockenspiel-like crystal 98 for the punchline.
- **Groove:** claves 75 on 0, 0.75, 1.5, 2.5, 3 (40-56) · tambourine 1 and 3 (44) · kick 0 and 2 (80).
- **Comedy timing:** stop everything for one beat before the punchline, then a two-note cadence (A7 → D).

## 10. Synthwave (gaming, retro tech, night)

- **Tempo / key:** 96-110 BPM, A minor.
- **Progression:** i - VI - III - VII: Am - F - C - G.
- **Voicings:** Am `57 60 64 69` · F `57 60 65 69` · C `55 60 64 67` · G `55 59 62 67`. Synth bass in 8ths alternating root and octave: A1 33 / A2 45 · F1 29 / F2 41 · C2 36 / C3 48 · G1 31 / G2 43.
- **Instruments:** synth bass 38 · poly synth pad 90 (whole bars, low-pass 4000) · arpeggio on Muted guitar 28 or crystal 98 in 16ths over the chord tones · fifths lead 86 for a hook in music-only sections · saw lead 81 only if the brief is explicitly game-y, and never under speech.
- **Groove:** kick 0 (104), 2 (100) · snare 1 (88), 3 (90) with drums-track reverb 0.25 / 1.6 s · closed hat 8ths (40-56) · crash every 8 bars.

## 11. Acoustic folk (small business, travel, craft)

- **Tempo / key:** 92-108 BPM, G major.
- **Progression:** I - IV - vi - V: G - C - Em - D.
- **Guitar voicings (open chords; low thirds are idiomatic for guitar):** G `43 47 50 55 59 67` · C `48 52 55 60 64` · Em `40 47 52 55 59 64` · D `50 57 62 66`. Bass G2 43 · C2 36 · E2 40 · D2 38.
- **Strumming:** pattern D - D U - U D U at beats 0, 1, 1.5, 2.5, 3, 3.5. Downstrums offset notes 0.02 beats low → high; upstrums use only the top 3 notes, high → low, velocity 10-15 lower.
- **Instruments:** steel guitar 25 (strums) · nylon guitar 24 or banjo 105 (picked 8ths in the second half) · acoustic bass 32 · fiddle 110 or flute 73 for one phrase per section.
- **Groove:** kick 0 (88), 2 (82) · tambourine 1 and 3 (52) · shaker 8ths (28-42) · hand claps on 1 and 3 in the final section.

## 12. Tension (problem statement, security, mystery)

- **Tempo / key:** 72-90 BPM, D minor. Drone + pulse + chromatic motion.
- **Progression:** i - bVI - i - bII over a D pedal: Dm - Bb/D - Dm - Eb/D.
- **Voicings (tremolo strings):** Dm `50 57 62 65` · Bb/D `50 58 62 65` · Eb/D `51 55 58 63` (the semitone rub against the D pedal is the tension). Pedal: cello 42 on D2 38, sustained, re-struck every 2 bars.
- **Instruments:** tremolo strings 44 · cello 42 (pedal) · synth bass 38 pulsing 8ths on D2 38 at vel 54-70 · soundtrack FX 97 or bowed glass 92 for risers · grand piano 0 single high notes (D6 86, A5 81) with long reverb as "pings".
- **Pulse:** heartbeat kick 0 (92), 0.375 (66) each bar; add a closed hat 16th ticking at 24-34 to raise urgency.
- **Resolve or don't:** stop dead on a downbeat for the cut, or resolve to D major (`50 57 62 66`) only if the story turns to the solution.

---

## Swapping instruments by role

| Role    | Warm / organic                      | Clean / modern                              | Cinematic                   |
| ------- | ----------------------------------- | ------------------------------------------- | --------------------------- |
| Chords  | tine EP 4, nylon 24, grand 0        | soft EP 5, electric grand 2, bright piano 1 | string ensemble 48, horn 60 |
| Pad     | warm pad 89, drawbar organ 16 (low) | poly pad 90, new age 88                     | choir aahs 52, halo 94      |
| Bass    | upright 32, finger 33               | picked 34, synth 38                         | cello 42, bassoon 70        |
| Pulse   | kalimba 108, harp 46                | muted guitar 28, marimba 12                 | tremolo 44, pizzicato 45    |
| Melody  | vibraphone 11, clarinet 71          | flute 73, fifths lead 86                    | French horn 60, violin 40   |
| Sparkle | harp 46, kalimba 108                | crystal 98                                  | harp 46, soundtrack 97      |
