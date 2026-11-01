# Harmony

Harmony sets the emotional weather; the melody moves through it. Choose a harmonic *language* that matches the direction card, then make two or three moves that a listener will remember.

## Emotion → harmonic language

| Feeling | Mode / colour | Progressions to start from |
| --- | --- | --- |
| Hopeful, open | major, add9, sus2, IV and vi | I - V/3 - vi7 - IVadd9 · IV - I/3 - ii7 - V |
| Warm, nostalgic | major with borrowed iv or bVII, maj7 chords | Imaj7 - vi7 - IVmaj7 - iv6 · I - iii7 - IV - iv |
| Bittersweet, tender | major ↔ relative minor, suspensions | vi - IV - I - V · I - V/7 - vi - iii - IV - I/3 - ii - V |
| Melancholy, reflective | natural minor, minor 7ths and 9ths | i9 - VImaj7 - IIImaj7 - VII · i - v7 - VI - VII |
| Dreamy, floating | Lydian (#4), maj7#11, planing | Imaj7 - II (Lydian II) loop · Imaj9 - IVmaj9 with a pedal |
| Mysterious, uneasy | Phrygian (b2), minor with chromatic bass | i - bII - i · i - bVI - bII - V |
| Heroic, defiant | Aeolian / minor with major bVI-bVII | i - bVI - bIII - bVII · bVI - bVII - i |
| Soulful, cool | Dorian (major IV in minor), extended chords | i9 - IV9 · ii9 - V13 - Imaj9 |
| Playful | major, chromatic passing chords, short notes | I - vi - ii - V7 · I - I+ - I6 - I7 |
| Tense, suspenseful | pedal + chromatic upper chords, diminished | i - bII/1 - i · i(add b9) cluster swells |

## Function and cadences

- **Tonic** (I, vi, iii) = home. **Predominant** (IV, ii) = away. **Dominant** (V, vii°) = pulling home.
- **Authentic** V(7) → I: closed, final. Strongest with the melody on the tonic.
- **Half** ... → V: open, a question. Ends antecedent phrases and B sections before a return.
- **Deceptive** V → vi: "not yet". Extends a phrase, sets up a final repeat.
- **Plagal** IV → I: gentle "amen". **Minor plagal** IV → iv → I: warm, cinematic, bittersweet, a favourite ending.
- **Backdoor** iv7 → bVII7 → I: smooth, jazzy and nostalgic.
- Match cadence strength to the form: weak cadences mid-section, the strongest one at the end.

## Colour moves (pick 1-3 per piece)

- **Borrowed chords (modal mixture)** from the parallel minor in a major key: iv (Fm in C), bVI (Ab), bVII (Bb), ii°. They darken without leaving the key. The picardy third (a major tonic ending a minor piece) works the other way.
- **Secondary dominants** (V/x): a dominant of a chord other than I, resolving to it. V/vi (E7 → Am), V/ii (A7 → Dm), V/IV (C7 → F). They add forward motion and a flash of chromatic colour.
- **Pedal point:** hold the bass (tonic or dominant) while chords change above it. It builds tension and suits intros, builds and drones.
- **Line clichés:** one inner voice moves chromatically over a static chord (Am - Am(maj7) - Am7 - Am6). It is cinematic and nostalgic.
- **Sus and add chords:** sus4 → 3 resolutions at cadences; add9 for openness.
- **Modulation:** up a whole step for the final chorus or the final A (pivot on V of the new key, or just cut on the downbeat for pop energy); to the relative minor/major for a B section; a chromatic mediant (I → bVI or I → III) for cinematic surprise.

## Harmonic rhythm

- One chord per bar is the default. Two per bar creates drive (continuations, pre-choruses). One per two bars feels spacious (ambient, intros, codas).
- Accelerate into cadences; decelerate in endings.
- Change chords on strong beats; anticipate by an 8th in pop and funk for push.

## Voicing

- **Spacing follows the harmonic series:** wide intervals in the bass, closer intervals higher. No 3rds below C3 (48); no seconds or clusters below C4 (60) on piano and keys; 5ths and octaves are fine low.
- **Roots live in the bass track.** Upper voicings can omit the root (rootless voicings), omit the 5th, and carry 7ths and extensions.
- **Extensions high:** 9ths, 11ths and 13ths go in the upper voices, not next to the bass.
- **Doubling:** double roots or 5ths, not 3rds (and never the leading tone) in thin textures.
- **Voice leading:** keep common tones, move other voices by the smallest step, prefer contrary motion between the bass and the top voice, and avoid parallel 5ths/octaves between the outer voices in exposed textures.
- **Register for the job:** comping voicings in 52-72; pads 45-67 low-passed; bright stabs 60-79.

## Copy-ready voicings (MIDI, C4 = 60)

Key of C, upper-structure voicings to put over a bass root:

| Chord | Voicing | Bass |
| --- | --- | --- |
| Cmaj9 | 52 55 59 62 (E G B D) | 36 |
| Dm9 | 53 57 60 64 (F A C E) | 38 |
| Em7 | 55 59 62 64 (G B D E) | 40 |
| Fmaj7 | 53 57 60 64 (F A C E) | 41 |
| Fm6 (borrowed iv) | 53 56 60 62 (F Ab C D) | 41 |
| G13 | 53 59 64 (F B E) | 43 |
| G7sus4 | 55 60 62 65 (G C D F) | 43 |
| Am9 | 55 60 64 71 (G C E B) | 45 |
| Bbmaj7 (bVII) | 53 57 62 65 (F A D F) | 46 |
| E7 (V/vi) | 56 62 64 68 (G# D E G#) | 40 |
| A7 (V/ii) | 55 61 64 67 (G C# E G) | 45 |

Transpose by adding the same number of semitones to every note. Re-check the low-interval rule after transposing down.

## Writing chords as data

```python
CHORDS = {
  "Cmaj9": ([52, 55, 59, 62], 36),
  "Am9":   ([55, 60, 64, 71], 45),
  "Fmaj7": ([53, 57, 60, 64], 41),
  "Fm6":   ([53, 56, 60, 62], 41),
}
PROGRESSION = [("Cmaj9", 4), ("Am9", 4), ("Fmaj7", 4), ("Fm6", 4)]  # (chord, beats)
```

Expand each entry into comping, arpeggios, pads and bass in the generator. `examples/paper-lanterns.py` shows the pattern, including two-chord bars and a sus4 → V cadence.
