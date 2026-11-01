# Generator for paper-lanterns.song.json: the musical intent (chords, motifs, sections)
# lives here as data; the script expands it into exact Vamp notes.
# Usage: python3 paper-lanterns.py paper-lanterns.song.json
import json, sys

BPM = 88
BAR = 4

# chord: (accomp voicing, bass root, bass second note)
CH = {
    "F": ([53, 57, 60, 65], 41, 48),
    "C/E": ([52, 55, 60, 64], 40, 43),
    "Dm7": ([53, 57, 60, 62], 38, 45),
    "Bbmaj7": ([53, 57, 62, 65], 34, 41),
    "Gm7": ([53, 58, 62, 65], 43, 38),
    "C7": ([52, 58, 60, 64], 36, 43),
    "Am7": ([52, 55, 60, 64], 45, 40),
    "Bb": ([53, 58, 62, 65], 34, 41),
    "Csus4": ([53, 55, 60, 65], 36, 43),
    "C": ([52, 55, 60, 64], 36, 43),
    "Dm": ([53, 57, 62, 65], 38, 45),
    "F/A": ([53, 57, 60, 65], 45, 48),
    "Bbm6": ([53, 55, 61, 65], 34, 41),
}

# (chord, start-in-bar, duration) per bar
A_CHORDS = [
    [("F", 0, 4)], [("C/E", 0, 4)], [("Dm7", 0, 4)], [("Bbmaj7", 0, 4)],
    [("Gm7", 0, 2), ("C7", 2, 2)], [("Am7", 0, 2), ("Dm7", 2, 2)],
    [("Bb", 0, 2), ("Csus4", 2, 1), ("C", 3, 1)], [("F", 0, 4)],
]
B_CHORDS = [
    [("Dm", 0, 4)], [("Bb", 0, 4)], [("F/A", 0, 4)], [("C", 0, 4)],
    [("Dm", 0, 4)], [("Gm7", 0, 4)], [("Bbmaj7", 0, 4)], [("Csus4", 0, 2), ("C7", 2, 2)],
]
INTRO_CHORDS = [[("F", 0, 4)], [("Bbmaj7", 0, 4)]]
CODA_CHORDS = [[("Bbmaj7", 0, 4)], [("Bbm6", 0, 4)]]

# Sections in bars: intro 0-1, A 2-9, B 10-17, A' 18-25, coda 26-28
INTRO, A, B, A2, CODA = 0, 2, 10, 18, 26
END_BEAT = 116  # last notated content must end here

# Motif: rising 4th into a step back (bar 1), falling answer (bar 2); sentence form.
A_MELODY = [
    (69, 0, 1.5), (72, 1.5, 0.5), (77, 2, 1.5), (76, 3.5, 0.5),
    (74, 4, 1), (72, 5, 1), (67, 6, 2),
    (65, 8, 1.5), (69, 9.5, 0.5), (74, 10, 1.5), (72, 11.5, 0.5),
    (70, 12, 1), (69, 13, 1), (65, 14, 2),
    (74, 16, 1), (72, 17, 0.5), (74, 17.5, 0.5), (76, 18, 1), (74, 19, 0.5), (76, 19.5, 0.5),
    (79, 20, 1), (77, 21, 0.5), (79, 21.5, 0.5), (77, 22, 1), (76, 23, 0.5), (77, 23.5, 0.5),
    (81, 24, 1.5), (79, 25.5, 0.5), (77, 26, 1), (76, 27, 1),
    (77, 28, 3),
]
# B: motif inverted (falling 3rd/4th, then gap-fill), lower register, clarinet.
B_MELODY = [
    (74, 0, 1.5), (72, 1.5, 0.5), (69, 2, 2),
    (70, 4, 1.5), (69, 5.5, 0.5), (65, 6, 2),
    (69, 8, 1.5), (67, 9.5, 0.5), (65, 10, 1), (67, 11, 1),
    (64, 12, 3),
    (65, 16, 1), (69, 17, 1), (74, 18, 1.5), (72, 19.5, 0.5),
    (70, 20, 1.5), (69, 21.5, 0.5), (67, 22, 2),
    (69, 24, 1), (70, 25, 1), (74, 26, 1), (77, 27, 1),
    (77, 28, 2), (76, 30, 0.5), (74, 30.5, 0.5), (72, 31, 1),
]
# A' countermelody: guide tones (3rds and 7ths) moving by step under the tune.
COUNTER = [
    (57, 0, 4), (55, 4, 4), (53, 8, 4), (57, 12, 4), (58, 16, 4), (60, 20, 4),
    (62, 24, 2), (65, 26, 1), (64, 27, 1), (65, 28, 3),
]
# Coda: motif head augmented, then the borrowed iv (Bbm6) colours the last approach.
CODA_MELODY = [(69, 0, 3), (72, 3, 1), (73, 4, 2), (72, 6, 2), (69, 8, 3.8)]


def n(p, s, d, v):
    return {"pitch": p, "start": round(s, 4), "duration": round(d, 4), "velocity": max(1, min(127, int(round(v))))}


def shaped(notes, offset, base, transpose=0):
    out = []
    for p, s, d in notes:
        accent = 6 if s % 4 == 0 else (2 if s % 2 == 0 else 0)
        out.append(n(p + transpose, offset + s, d, base + (p - 69) * 1.1 + accent + min(d, 2) * 2))
    return out


def segments(bars, first_bar):
    for i, bar in enumerate(bars):
        for chord, s, d in bar:
            yield chord, (first_bar + i) * BAR + s, d


accomp, lh, pad, bass = [], [], [], []
SECTIONS = [
    (INTRO_CHORDS, INTRO, 0, 0, False),
    (A_CHORDS, A, 0, 42, False),
    (B_CHORDS, B, 2, 50, True),
    (A_CHORDS, A2, 5, 58, True),
    (CODA_CHORDS, CODA, -4, 50, True),
]
for bars, first, lift, pad_vel, has_bass in SECTIONS:
    for chord, start, dur in segments(bars, first):
        v, root, second = CH[chord]
        order = [0, 2, 1, 2]
        for k in range(int(dur * 2)):
            vel = (58 if k % 4 == 0 else 46 + (k % 2) * 3) + lift
            accomp.append(n(v[order[k % 4]], start + k * 0.5, 0.5, vel))
        if not has_bass:
            lh.append(n(root, start, dur - 0.05, 60))
        if pad_vel:
            pad += [n(p, start, dur - 0.05, pad_vel - i * 2) for i, p in enumerate(v)]
        if has_bass:
            if dur == 4:
                bass += [n(root, start, 1.5, 84 + lift), n(root, start + 1.5, 0.5, 60), n(second, start + 2, 2, 72 + lift)]
            else:
                bass.append(n(root, start, dur, 80 + lift))

final = CODA + 2
fb = final * BAR
accomp += [n(p, fb, 3.8, 56 - i) for i, p in enumerate([41, 53, 57, 60, 65, 69])]
pad += [n(p, fb, 3.8, 48 - i * 2) for i, p in enumerate([53, 57, 60, 65])]
bass.append(n(29, fb, 3.8, 70))

melody_piano = shaped(A_MELODY, A * BAR, 74) + shaped(A_MELODY, A2 * BAR, 54, -12)
clarinet = shaped(B_MELODY, B * BAR, 70) + [n(p, A2 * BAR + s, d, 56 + (s % 4 == 0) * 4) for p, s, d in COUNTER]
flute = shaped(A_MELODY, A2 * BAR, 82) + shaped(CODA_MELODY, CODA * BAR, 64)

harp = [n(p, i * 0.5, 2, 40 + i * 4) for i, p in enumerate([65, 69, 72, 77])]
harp += [n(p, 70 + i * 0.25, min(1, 2 - i * 0.25), 40 + i * 3) for i, p in enumerate([72, 74, 77, 79, 81, 84, 86, 89])]

groove_b = [n(36, 0, 0.5, 78), n(36, 2.5, 0.5, 62), n(37, 1, 0.25, 52), n(37, 3, 0.25, 56)]
groove_b += [n(70, k * 0.5, 0.25, [34, 24, 30, 26][k % 4]) for k in range(8)]
groove_a2 = [n(36, 0, 0.5, 86), n(36, 1.75, 0.25, 56), n(36, 2.5, 0.5, 74), n(38, 1, 0.25, 58), n(38, 3, 0.25, 62)]
groove_a2 += [n(42, k * 0.5, 0.25, [44, 32, 40, 34][k % 4]) for k in range(8)]
drum_notes = []
fill = [(70, 50, 58), (70.5, 47, 62), (71, 47, 66), (71.5, 45, 72)]
drum_notes += [n(36, 68, 0.5, 78), n(37, 69, 0.25, 54)] + [n(p, b, 0.25, v) for b, p, v in fill]
drum_notes += [n(36, 72, 1, 92), n(49, 72, 2, 62), n(36, 100, 0.5, 84), n(51, 100, 1.5, 50)]

song = {
    "schemaVersion": "1.0.0",
    "meta": {
        "title": "Paper Lanterns",
        "bpm": BPM,
        "timeSignature": {"numerator": 4, "denominator": 4},
        "key": {"tonic": "F", "mode": "major"},
        "seed": 1188,
        "durationHint": 120,
        "mood": "warm, hopeful, gently nostalgic",
        "tags": ["chamber-pop", "motif-development", "sentence-form", "example"],
    },
    "patterns": [
        {"id": "groove-b", "name": "Brush-like groove", "lengthBeats": 4, "notes": groove_b},
        {"id": "groove-a2", "name": "Fuller groove", "lengthBeats": 4, "notes": groove_a2},
    ],
    "tracks": [
        {"id": "melody-piano", "name": "Piano melody", "kind": "midi", "channel": 0,
         "instrument": {"type": "gm", "program": 0, "bank": 0}, "volume": 0.9,
         "notes": melody_piano, "effects": [{"type": "reverb", "mix": 0.22, "decaySeconds": 2.2}]},
        {"id": "accomp", "name": "Piano accompaniment", "kind": "midi", "channel": 1,
         "instrument": {"type": "gm", "program": 0, "bank": 0}, "volume": 0.62, "pan": -0.15,
         "notes": accomp + lh, "effects": [{"type": "reverb", "mix": 0.22, "decaySeconds": 2.2}]},
        {"id": "clarinet", "name": "Clarinet", "kind": "midi", "channel": 2,
         "instrument": {"type": "gm", "program": 71, "bank": 0}, "volume": 0.72, "pan": -0.3,
         "notes": clarinet, "effects": [{"type": "reverb", "mix": 0.2, "decaySeconds": 2.0}]},
        {"id": "flute", "name": "Flute", "kind": "midi", "channel": 3,
         "instrument": {"type": "gm", "program": 73, "bank": 0}, "volume": 0.66, "pan": 0.2,
         "notes": flute, "effects": [{"type": "reverb", "mix": 0.22, "decaySeconds": 2.0}]},
        {"id": "strings", "name": "Strings", "kind": "midi", "channel": 4,
         "instrument": {"type": "gm", "program": 48, "bank": 0}, "volume": 0.45, "pan": 0.25,
         "notes": pad, "effects": [{"type": "lowpass", "cutoffHz": 7000}, {"type": "reverb", "mix": 0.28, "decaySeconds": 2.4}]},
        {"id": "bass", "name": "Upright bass", "kind": "midi", "channel": 5,
         "instrument": {"type": "gm", "program": 32, "bank": 0}, "volume": 0.8,
         "notes": bass, "effects": [{"type": "eq", "lowGainDb": -1}]},
        {"id": "harp", "name": "Harp", "kind": "midi", "channel": 6,
         "instrument": {"type": "gm", "program": 46, "bank": 0}, "volume": 0.5, "pan": 0.35,
         "notes": harp, "effects": [{"type": "reverb", "mix": 0.32, "decaySeconds": 2.4}]},
        {"id": "drums", "name": "Drums", "kind": "drums", "channel": 9,
         "instrument": {"type": "builtin", "id": "drums.kit"}, "volume": 0.5,
         "placements": [{"pattern": "groove-b", "start": B * BAR, "repeat": 7},
                        {"pattern": "groove-a2", "start": A2 * BAR, "repeat": 7}],
         "notes": drum_notes, "effects": [{"type": "reverb", "mix": 0.08, "decaySeconds": 1.0}]},
    ],
}
for t in song["tracks"]:
    t["volume"] = round(t["volume"] * 1.45, 2)
json.dump(song, open(sys.argv[1], "w"), indent=2)
