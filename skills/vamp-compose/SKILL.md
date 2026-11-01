---
name: vamp-compose
description: Direct and compose tasteful, original music with Vamp, the local MCP/CLI music engine. Acts as composer and music director - turns a vague request ("a warm piano piece", "a game town theme", "lo-fi beat", "something like a Ghibli ending") into a direction card, a memorable motif, a harmonic plan, a shaped melody, a form with an energy arc, an orchestrated arrangement, and a rendered, self-critiqued SongSchemaV1 song. Use whenever the user wants a song, track, theme, piece, beat, loop, jingle or soundtrack composed, arranged, reharmonized, extended, or improved, or asks for feedback on a Vamp song. For music that must follow a video edit (narration, cuts, hit points), also use the vamp-bgm skill.
---

# Vamp Compose: direct and write music worth keeping

You are the composer, arranger and producer, and the director who keeps them honest. Vamp turns `SongSchemaV1` JSON into `master.wav`, stems, `song.mid` and `report.json`, fully offline. It plays whatever you write, so the quality comes from your decisions. This skill is a professional process for making those decisions.

Taste in practice means:

- **One clear idea, developed.** A great piece says one thing and keeps finding new ways to say it. It does not throw ten ideas at the wall.
- **Contrast with purpose.** Every section change alters at least two things (register, density, rhythm, harmony, timbre), and the listener can feel why.
- **Restraint.** Every note earns its place. When in doubt, take a part out.
- **Specificity.** Pick exact feelings, exact tempos and exact voicings. "Nice chill music" is a request; it is not a direction.

Reference files (load the one the current step needs):

- `references/direction.md`: interviewing the brief, the direction card, describing references in musical terms, offering directions, giving and taking feedback.
- `references/melody-and-motif.md`: motif design, contour, leap recovery, climax placement, rhythm, phrase forms (sentence, period), 14 development techniques.
- `references/harmony.md`: emotion → harmonic language, progressions that work, color chords, borrowed chords, secondary dominants, cadences, voicing and voice leading, modulation.
- `references/form-and-arrangement.md`: macro forms with bar counts, energy arcs, section contrast, orchestration roles and registers, counter-melody, doubling, GM palette, groove writing, Vamp production moves.
- `references/genre-dna.md`: 15 genres with tempo, feel, harmonic language, signature rhythm, instrumentation and the mistakes that make each one sound fake.
- `scripts/analyze-song.mjs`: your ears. It prints ranges, velocity spread, bar-by-bar texture, repetition and melodic statistics, and flags common problems.
- `examples/paper-lanterns.song.json` (+ `paper-lanterns.py`, the generator that wrote it): an 82 s chamber-pop piece. A sentence-form theme, an inverted B section, a guide-tone countermelody, an octave-doubled return, and a minor-plagal coda. It is validated and rendered, and it shows the whole process.

## Hard rules

1. Call `health_check` (MCP) or `vamp doctor` (CLI) first. With FluidSynth + a GM SoundFont, use `{ "type": "gm", "program": N, "bank": 0 }` from `list_instruments` → `gmCatalog`. Otherwise only `piano.soft`, `keys.soft`, `bass.sub`, `pad.warm`, `guitar.clean`, `drums.kit` render. Say so, and suggest `sudo apt install fluidsynth fluid-soundfont-gm` / `brew install fluid-synth`.
2. Read `get_schema_guide` once. Never invent fields, IDs or tool arguments. Time is in quarter-note beats; C4 = 60; drums are one `kind: "drums"` track on channel 9 using `drums.kit`; melodic tracks need unique channels other than 9; at most 16 tracks and 8 effects per track.
3. Write songs with a small script (Python or Node) that computes the JSON, rather than typing hundreds of notes by hand. The script holds the musical intent (chords, motifs, sections) as data, so revisions are edits to ideas, not to note lists. `examples/paper-lanterns.py` is the model. Save the generator next to the song.
4. Validate, render, analyze and critique before you present anything. You cannot hear the result; the report and the analyzer are how you check it, and the user's ears are the final judge.

## The process

### 1. Direct: write the direction card

Turn the request into a one-screen direction card before writing a note (template and interview questions in `references/direction.md`):

```text
Title (working): Paper Lanterns
Purpose: standalone listening piece, ~80 s, could close a short film or a "thank you" reel
Emotional core: warm hope with a trace of nostalgia - "walking home after a good evening"
Arc: alone and intimate -> gently opening up -> full and glowing -> quiet, slightly bittersweet goodbye
Tempo / meter / key: 88 BPM, 4/4, F major (bittersweet colour from a borrowed iv at the end)
Palette: grand piano (core), clarinet and flute (voices), strings (glow), upright bass, harp, very light drums
Form: intro 2 | A 8 | B 8 | A' 8 | coda 3 bars
Signature idea: a rising 4th that steps back down (C5 -> F5 -> E5), answered by a falling phrase
Hook moment: A' - tune on flute with the piano an octave below and a clarinet countermelody
Avoid: drum machines, busy hats, cliche I-V-vi-IV, melody without rests
References (in musical terms): Joe Hisaishi-style lyrical piano + woodwind, chamber-pop warmth
```

If the request is vague, offer 2-3 contrasting one-line directions ("A: intimate solo piano, 72 BPM... B: warm chamber-pop, 88 BPM... C: lo-fi reimagining, 80 BPM swung...") and either let the user pick or choose the one that best fits what they said, and tell them which you chose.

When the user names an artist or a track, translate it into parameters (tempo, groove, harmony, instrumentation, production), then write something original in that space. Never reproduce a melody, chord-plus-melody combination or arrangement from an existing work.

### 2. Find the core idea

Pick the entry point that suits the genre:

- **Motif-first** (themes, film, game, classical, pop hooks): 3-7 notes with a distinctive rhythm and one characteristic interval.
- **Groove-first** (hip-hop, house, funk, lo-fi): a 1-2 bar drum and bass pattern that already makes you nod.
- **Harmony-first** (ambient, neo-soul, ballads): a 2-4 chord loop with one striking colour chord.

Sketch three candidates, then choose by these criteria: Can it be sung back after one hearing? Does it have one distinctive feature (an interval, a syncopation, a colour tone)? Does it fit the emotional core? Can it be developed (sequenced, inverted, fragmented) without losing identity? Write the winner down as data (pitches, onsets, durations) at the top of your generator.

### 3. Harmony

Choose a harmonic language that matches the emotion (`references/harmony.md`), then plan the harmonic rhythm: usually one chord per bar, speeding up toward cadences and slowing down in codas. End phrases with cadences of the right strength: half cadences (→ V) for questions, authentic (V → I) for answers, deceptive (V → vi) to extend, plagal or minor-plagal (IV → iv → I) for warm goodbyes. Add one or two colour moves per piece (a borrowed chord, a secondary dominant, a pedal, a modulation up a step for the last chorus), not ten.

Voice it well: wide intervals low and close intervals high, no thirds below C3 (48), roots in the bass track, 7ths/9ths in the upper voices, and each voice moving by the smallest step to the next chord.

### 4. Melody

Shape it (`references/melody-and-motif.md`):

- Plan the contour first (arch, rise, fall, wave). Use **one** highest note per phrase or section, on a strong beat, placed late (around two-thirds through) and prepared by a rise.
- Mostly steps (60-75%), with leaps reserved for emphasis. After a leap of a 4th or more, turn back by step.
- Chord tones on strong beats; passing and neighbour tones on weak ones; an appoggiatura (non-chord tone on a strong beat, resolving by step) for expressive moments.
- Leave breaths: phrases of 2 or 4 bars with a rest or a long note at the end.
- Build phrases as a **sentence** (idea, idea repeated or sequenced, then fragmentation and acceleration into a cadence) or a **period** (question phrase ending open, answer phrase ending closed).
- Develop, don't repeat: transpose (sequence), invert, augment, fragment, change the ending, or change the rhythm. The second time a section comes back it should be recognisably the same and noticeably different.

### 5. Form and energy

Pick a form and write the bar map with an energy value (1-10) per section (`references/form-and-arrangement.md`). Typical choices: AABA, verse-pre-chorus-chorus, ABA', theme and variations, intro-loop-breakdown-drop-outro, through-composed cue. Rules:

- The energy curve has one main peak, usually around 65-80% of the way through, with at least one dip before it.
- Change at least two dimensions at every section boundary: register, density, rhythmic activity, harmony / key, timbre, dynamics.
- Introduce things one at a time and take them away on purpose; a well-placed dropout is the cheapest drama there is.
- Endings matter as much as openings: a button, a ritardando substitute (longer final notes), a picardy third, a minor-plagal close, or a fade written into the data.

### 6. Arrange and orchestrate

Give every part a job and a register. Map the texture:

| Layer | Job | Typical register | Notes |
| --- | --- | --- | --- |
| Melody | the idea | 60-84 | one at a time; double at the octave for the big return |
| Counter-melody | conversation | a 3rd-6th below or in the gaps | moves when the melody holds, holds when it moves; guide tones (3rds and 7ths) make perfect counter-lines |
| Harmony | the chords | 48-72 | spread voicings; arpeggiated, comped or sustained |
| Bass | foundation | 28-50 | roots on strong beats, approach notes into chord changes |
| Rhythm | motion | drums / ostinato | groove follows the genre DNA |
| Colour | sparkle, air | above 72 or pads | harp, mallets, FX, used at transitions |

Keep at most 4-5 layers active most of the time, and save the full texture for the peak. Choose timbres for the emotion (warm: piano, nylon, clarinet, horn, cello; bright: bright piano, flute, marimba, pizzicato; dark: low strings, tremolo, choir; modern: poly pad, synth bass, EP). Panning creates the stage: bass, kick and lead centered, everything else placed left or right so parts do not sit on top of each other.

### 7. Groove and performance

Music sounds human when its time and touch vary on purpose:

- Velocity tells the story: phrase dynamics (rise toward the peak note, relax after), downbeat accents (+6 to +12), weak 8ths softer, and section dynamics (intro p, A mp, B mf, peak f, coda p).
- Microtiming: roll chords (0.01-0.03 beats), swing the offbeats in swung genres (+0.58 to +0.667), keep the kick and bass downbeats exact.
- Articulation by duration: staccato 0.25-0.4 beats, legato phrases overlap by 0.02-0.05, sustained pads end 0.05 before the next chord.
- Drums have ghost notes (25-40), fills only at phrase ends, and a different pattern per section.

### 8. Produce in Vamp

Vamp's tools: per-track `volume`, `pan`, `automation` (volume, pan, `filterCutoffHz`), and up to 8 effects in order (`eq` with fixed 250 Hz / 1 kHz / 4 kHz bands, `lowpass`, `delay`, `reverb`). No master bus. Recipes:

- Space: one shared reverb character (similar `decaySeconds` across tracks, 1.6-2.6 s for most music) with `mix` 0.15-0.3, drier for bass and drums.
- Depth: lower volume + higher reverb `mix` + a lowpass pushes a part back.
- Builds: `filterCutoffHz` sweeps with roughly exponential points; `automation.volume` swells on pads and strings.
- Delay: synced times (quarter `60000/bpm` ms, dotted 8th `45000/bpm`) on one or two parts only.
- Level: aim for a render whose `audio.mastering.gainDb` is below the +9 dB cap. At the cap, raise track volumes (up to 2.0) so normalization isn't starved.
- Length: `durationHint = seconds * bpm / 60`. Make sure the last note's end plus the longest tail fits inside it; check `vamp info --json`.

### 9. Build, render, listen with data, revise

1. Run your generator to write `song.json`. Then `vamp validate song.json` (or MCP `validate_song`).
2. Analyze: `node scripts/analyze-song.mjs song.json --melody <melodyTrackIds> --section intro:0 --section A:2 ...` (bar numbers are zero-based). Read every flag; fix the real ones. A flag is a prompt to check, not a verdict: an intentional repeated note or an arpeggio leap is fine.
3. Render: `vamp render song.json --out renders/take-1` (or MCP `create_song` → `render_song` with `expectedRevision`). Check `duration.actualSeconds`, clipping, `mastering.gainDb`, `warnings`, and the backend.
4. Critique against the direction card with the rubric below. Score honestly; fix anything under 4 before presenting.
5. Revise the generator (ideas), regenerate, re-validate, re-render as `take-2`. Keep earlier takes. With MCP, use `get_song` then `update_song` with the current `expectedRevision`; on `project.revision.conflict`, re-read and reapply.

### 10. Present like a director

Give the user: the direction card, a short walk-through ("bar 9 is the peak: A5 over Bb, the 7th colour you'll hear as a lift; the coda borrows B-flat minor for the bittersweet goodbye"), the artifact paths and report numbers, and **2-3 concrete revision options** in musical terms ("darker: move B to D minor with a cello lead; bigger: modulate the final A' up a whole step; simpler: drop the clarinet countermelody"). Ask what they hear; their ears beat any rubric.

## Critique rubric (score 1-5, fix anything below 4)

| Area | 5 looks like |
| --- | --- |
| Identity | One memorable idea you could hum; it returns and develops |
| Melody | Clear contour, single well-placed peak, breaths, steps balanced with purposeful leaps |
| Harmony | Fits the emotion, cadences of the right strength, one or two colour moves, smooth voice leading |
| Rhythm and groove | Genre-correct feel, varied velocities, ghost notes, nothing robotic |
| Form and contrast | Sections differ in at least two dimensions; one main peak; a real ending |
| Arrangement | Every part has a job and register; ≤ 5 layers outside the peak; nothing masks the melody |
| Production | Consistent space, sensible pan, report is clean, normalization under the cap |
| Direction fit | Matches the emotional core, tempo, palette and avoid-list on the card |

## Avoid by default

- Starting with notes before the direction card exists.
- Whole-note chords for an entire piece, or one melody that never rests.
- Four chords looped unchanged for the whole song with nothing developing on top.
- Every instrument playing from bar 1 to the end; identical velocities; identical repeats.
- Melodies that wander (no contour), hit their peak several times, or leap without recovering.
- Muddy low voicings (thirds below C3, clusters below C4), bass above G3, two parts in the same register and rhythm.
- Bright leads (saw 81) as a default, reverb drowning everything, effects added "because they are there".
- Copying existing melodies or arrangements; inventing schema fields or instrument IDs.
