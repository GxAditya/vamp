# Melody and motif

A melody is a shape before it is a set of notes. Decide the direction of travel, where it peaks and where it breathes; then choose pitches that fit the harmony.

## The motif

3-7 notes combining **a rhythm you can tap** and **one characteristic interval** (a rising 4th, a falling minor 3rd, a leap of a 6th, a chromatic neighbour). Test it:

- Tap the rhythm on one pitch. Is it recognisable already? Good motifs often are.
- Sing it back after one hearing. If you cannot, it is too long or too irregular.
- Does it imply a harmony, or does it fit at least two different chords? Flexible motifs develop better.

Store it as data: `[(pitch, onsetBeats, durationBeats), ...]`, then derive every variant from it in your generator.

## Contour

| Shape | Effect | Use |
| --- | --- | --- |
| Arch (rise, peak, fall) | complete, satisfying | the default for themes and choruses |
| Rising | building, hopeful, questioning | pre-chorus, builds, antecedent phrases |
| Falling | release, resolution, sadness | endings, consequent phrases, laments |
| Wave | conversational | verses, accompaniment-like melodies |
| Level / static | rhythmic focus, chant, tension | rap-like hooks, minimalist pulses, suspense |

Rules of thumb (defaults, not laws):

- **One peak.** The highest note appears once per phrase (or once per section for the main climax), on a strong beat, about two-thirds of the way through, prepared by a rise.
- **Steps with purposeful leaps.** 60-75% stepwise motion. Use leaps to reach important notes.
- **Gap fill.** After a leap of a 4th or more, move back by step in the opposite direction. Arpeggios (consecutive chord-tone leaps) are the exception.
- **Range.** An octave to a 10th for a singable tune, an octave and a 5th maximum for instrumental themes.
- **No aimless repetition.** More than 3-4 repeated pitches in a row reads as static unless it is a rhythmic hook.
- **Tendency tones.** The leading tone (7th degree) wants to rise to the tonic; the 4th degree wants to fall to the 3rd. Honour them at cadences.

## Notes against chords

- **Strong beats** (1 and 3 in 4/4, and the onsets of long notes): chord tones by default.
- **Weak beats and short notes:** passing tones (step between two chord tones) and neighbour tones (step away and back).
- **Expressive moments:** an appoggiatura, a non-chord tone on a strong beat that resolves by step (the 9th falling to the root, the 4th to the 3rd). Use it on the peak or the cadence for emotion.
- **Colour tones:** sustaining the 9th, 6th or maj7 over a chord sounds modern and warm. Avoid sustaining the 4th over a major chord (it clashes with the 3rd) unless the chord is a sus4.
- **Avoid:** the melody doubling the bass's 3rd on a strong beat in thin textures; parallel octaves between melody and bass on consecutive strong beats.

## Rhythm

- Give the melody its own rhythm, distinct from the accompaniment's. When the accompaniment is busy, the melody sustains; when it holds, the melody moves.
- Syncopation (anticipating the beat by an 8th) adds drive in pop and jazz; keep downbeat landings at cadences.
- **Phrase lengths of 2, 4 and 8 bars**, with a breath (rest or long note) at the end. An occasional 3-bar or 5-bar phrase, or a 1-bar extension, adds surprise.
- Let important notes be long. The ear weights long notes as structural.

## Phrase forms

**Sentence (8 bars)**: presentation (basic idea 2 bars + its repetition or sequence 2 bars), then continuation (fragments of 1 bar or shorter, faster rhythm, faster harmonic rhythm, sequence) into a cadence. It reads as an idea that develops and drives forward. Example (Paper Lanterns A): bars 1-2 motif over F, C/E; bars 3-4 the motif sequenced down a 3rd over Dm7, Bbmaj7; bars 5-6 half-bar fragments climbing over two chords per bar; bar 7 the single peak A5 over Bb, sus4 → V; bar 8 tonic.

**Period (8 bars)**: antecedent (basic idea + contrasting idea, ending on a half cadence, V) and consequent (the same basic idea + a different ending on an authentic cadence, V → I). It reads as question and answer. It is great for game themes, folk and lullabies.

**Hybrid:** antecedent + continuation, or a compound sentence for 16 bars.

## Development techniques

Use these to make returns fresh while keeping identity:

| Technique | What changes | Example from C-D-G (quarter, quarter, half) |
| --- | --- | --- |
| Repetition | nothing (use sparingly) | C-D-G |
| Sequence | pitch level, diatonically | D-E-A, E-F-B |
| Interval change | one interval (often the last) | C-D-A (the leap grows) |
| Rhythm change | durations, not pitches | dotted: C. D G |
| Fragmentation | only part of it | C-D, C-D, C-D-E |
| Extension | adds notes at the end | C-D-G-F-E |
| Expansion | inserts notes inside | C-D-E-F-G |
| Compression | removes inner notes | C-G |
| Inversion | directions flip | C-B-F |
| Retrograde | order reverses | G-D-C |
| Augmentation | durations doubled | C (half), D (half), G (whole) |
| Diminution | durations halved | C-D-G in 8ths |
| Ornamentation | adds neighbour/passing notes | C-D-E-D-G |
| Thinning | keeps only the strong notes | C . G |
| Re-harmonisation | same tune, new chords underneath | C-D-G over Am7 instead of C |
| Re-orchestration | same tune, new timbre/register | piano → flute an octave up |

A strong piece usually uses 3-5 of these: sequence and fragmentation inside phrases, inversion or re-harmonisation for a B section, augmentation or re-orchestration for the ending.

## Counter-melody

- Contrary or oblique motion against the melody: when the tune rises, the counter-line falls or holds.
- Rhythmic complement: it moves when the melody holds and holds when the melody moves.
- Guide tones make ideal counter-lines: the 3rds and 7ths of successive chords connect by step (the 7th of one chord falls a step to the 3rd of the next). In ii7-V7-I in C: C (7th of Dm7) → B (3rd of G7) → C (root of C), or the other strand F (3rd of Dm7) → F (7th of G7) → E (3rd of C). Paper Lanterns' A' counter-line is built this way: Bb3 is the 3rd of Gm7 and the 7th of C7, and C4 is the 3rd of Am7 and the 7th of Dm7.
- Keep it a 3rd-6th below the melody or in a clearly different register and timbre.

## Melody checklist

1. Can you describe the contour in one word?
2. Is there exactly one peak per section, prepared and on a strong beat?
3. Do leaps recover? Are strong beats chord tones (or deliberate appoggiaturas)?
4. Are there breaths every 2-4 bars?
5. When it returns, has something changed (register, ending, harmony, rhythm, timbre)?
6. Run `scripts/analyze-song.mjs --melody <id>` and read the steps / leaps / peak line.
