/**
 * Curated BGM preset packs and a deterministic song generator.
 *
 * Presets are composition recipes, not audio presets: each one names the
 * instruments, chord loop, groove, arrangement, and mix that fit a common
 * code-to-video brief. `createPresetSong` turns a recipe into a complete,
 * valid SongSchemaV1 object so an agent can start from a musically credible
 * 30 or 45 second bed instead of a single whole-note chord.
 *
 * All generation is deterministic from the preset, seed, key, tempo, and
 * requested duration. No clock, network, or random source is used.
 */

import type { Effect, GmInstrument, Note, SongKey, SongSchemaV1, Track } from '@gxaditya/vamp-schema';

import { GM_DRUM_NOTE_MAP, type GmDrumAlias } from './instruments.js';

export type BgmPresetId =
  'lofi' | 'tutorial_upbeat' | 'ambient_focus' | 'corporate_clean' | 'stinger';

export type PresetRole = 'chords' | 'pad' | 'bass' | 'melody' | 'drums';

export interface PresetInstrumentRecipe {
  readonly role: PresetRole;
  readonly label: string;
  readonly program: number | null;
  readonly description: string;
}

export interface BgmPresetDefinition {
  readonly id: BgmPresetId;
  readonly name: string;
  readonly summary: string;
  readonly defaultSeconds: number;
  readonly defaultBpm: number;
  readonly defaultKey: SongKey;
  readonly mood: string;
  readonly tags: readonly string[];
  /** Roman-numeral chord loop for humans; `progression` is machine-readable. */
  readonly romanNumerals: readonly string[];
  /** Zero-based scale degrees for the generated seventh-chord loop. */
  readonly progression: readonly number[];
  readonly instruments: readonly PresetInstrumentRecipe[];
  readonly groove: string;
  readonly arrangement: string;
  readonly mix: string;
  readonly avoid: readonly string[];
  /** Seconds of release tail reserved before the requested end. */
  readonly tailSeconds: number;
}

const LOFI: BgmPresetDefinition = {
  id: 'lofi',
  name: 'Lo-fi coding bed',
  summary:
    'Warm tine e-piano chords, finger bass, soft boom-bap drums, and a sparse vibraphone answer. Built for narration-heavy coding and tutorial footage.',
  defaultSeconds: 45,
  defaultBpm: 90,
  defaultKey: { tonic: 'A', mode: 'minor' },
  mood: 'warm, low-distraction, late-night focus',
  tags: ['lofi', 'coding', 'bgm', 'narration-safe', '45s'],
  romanNumerals: ['i7', 'VI7', 'III7', 'VII7'],
  progression: [0, 5, 2, 6],
  instruments: [
    {
      role: 'chords',
      label: 'Tine Electric Piano',
      program: 4,
      description: 'Low-passed rhythmic comping at low velocity.',
    },
    {
      role: 'pad',
      label: 'Warm Pad',
      program: 89,
      description: 'Quiet wash that glues the chords without filling the midrange.',
    },
    {
      role: 'bass',
      label: 'Finger Electric Bass',
      program: 33,
      description: 'Root-fifth pulse with rests and octave pickups.',
    },
    {
      role: 'melody',
      label: 'Vibraphone',
      program: 11,
      description: 'Sparse answer phrase every four bars, panned right.',
    },
    {
      role: 'drums',
      label: 'GM Standard Kit',
      program: null,
      description: 'Boom-bap kick and snare with quiet, varied hats.',
    },
  ],
  groove:
    'Kick on beat 1 and the and-of-3; snare on 2 and 4; closed hats on eighth notes at velocity 38-54; occasional ghost snare and open hat.',
  arrangement:
    'Three bars of e-piano and pad, bass enters, drums enter, vibraphone answers from bar 6, drums drop out for the final two bars, final chord rings into the cut.',
  mix: 'E-piano and pad low-passed, bass centered, drums quiet, melody panned right, short room reverb. Leave 2-4 kHz space for speech.',
  avoid: [
    'Do not add a continuous lead melody.',
    'Do not use square or saw leads.',
    'Do not raise hat velocity above 60 or the bed will fight narration.',
  ],
  tailSeconds: 3.2,
};

const TUTORIAL_UPBEAT: BgmPresetDefinition = {
  id: 'tutorial_upbeat',
  name: 'Upbeat explainer',
  summary:
    'Steady e-piano chords, picked bass, light four-on-the-floor drums, and a friendly marimba hook. Bright enough to keep attention without overpowering a voiceover.',
  defaultSeconds: 30,
  defaultBpm: 112,
  defaultKey: { tonic: 'G', mode: 'major' },
  mood: 'optimistic, clear, energetic but controlled',
  tags: ['tutorial', 'explainer', 'upbeat', 'narration-safe', '30s'],
  romanNumerals: ['I6', 'V', 'vi7', 'IV'],
  progression: [0, 4, 5, 3],
  instruments: [
    {
      role: 'chords',
      label: 'Soft Electric Piano',
      program: 5,
      description: 'Quarter-note comping with accent variation.',
    },
    {
      role: 'pad',
      label: 'String Ensemble',
      program: 48,
      description: 'Light sustained top layer for polish.',
    },
    {
      role: 'bass',
      label: 'Picked Electric Bass',
      program: 34,
      description: 'Eighth-note pulse with octave lift at the end of each bar.',
    },
    {
      role: 'melody',
      label: 'Marimba',
      program: 12,
      description: 'Short call-and-response hook every two bars.',
    },
    {
      role: 'drums',
      label: 'GM Standard Kit',
      program: null,
      description: 'Four-on-the-floor kick, clap on 2 and 4, offbeat hats.',
    },
  ],
  groove:
    'Kick on every beat, clap on 2 and 4, closed hats on offbeats, open hat at the end of every fourth bar.',
  arrangement:
    'Two-bar chord intro, bass and drums by bar 3, marimba hook from bar 5, one-bar drum break before the final chord.',
  mix: 'Piano-forward, strings low, bass short and mono, marimba right of center, no long reverb. Target a clean -16 to -18 LUFS bed.',
  avoid: [
    'Do not stack a second melody on the hook.',
    'Do not use distortion or aggressive synth leads.',
    'Do not let the four-on-the-floor kick mask speech transients.',
  ],
  tailSeconds: 2.2,
};

const AMBIENT_FOCUS: BgmPresetDefinition = {
  id: 'ambient_focus',
  name: 'Ambient focus bed',
  summary:
    'Slow evolving pads, fretless bass, and sparse kalimba notes with no drum groove. For study, meditation, product walkthroughs, and quiet explainers.',
  defaultSeconds: 60,
  defaultBpm: 60,
  defaultKey: { tonic: 'D', mode: 'major' },
  mood: 'calm, spacious, non-distracting',
  tags: ['ambient', 'focus', 'study', 'no-drums', '60s'],
  romanNumerals: ['Imaj7', 'vi7', 'IVmaj7', 'V'],
  progression: [0, 5, 3, 4],
  instruments: [
    {
      role: 'pad',
      label: 'Warm Pad',
      program: 89,
      description: 'Two-bar evolving chord wash, low-passed.',
    },
    {
      role: 'chords',
      label: 'Halo Pad',
      program: 94,
      description: 'Slow upper chord layer that enters after the intro.',
    },
    {
      role: 'bass',
      label: 'Fretless Bass',
      program: 35,
      description: 'One root note per chord, long release.',
    },
    {
      role: 'melody',
      label: 'Kalimba',
      program: 108,
      description: 'Two or three quiet notes every eight bars.',
    },
  ],
  groove:
    'No drums. Optional quiet shaker or ride only if a pulse is needed; the default generator leaves percussion out.',
  arrangement:
    'Four-bar pad intro, chord layer enters, bass enters after eight bars, kalimba appears every eight bars, everything decays before the requested end.',
  mix: 'Low-pass pads around 2.5-4 kHz, long reverb, no transient-heavy instruments, bass subtle. Leave the full midrange open for speech.',
  avoid: [
    'Do not add drums by default.',
    'Do not use bright plucks or bells in the speech band.',
    'Do not write a busy melody.',
  ],
  tailSeconds: 4.0,
};

const CORPORATE_CLEAN: BgmPresetDefinition = {
  id: 'corporate_clean',
  name: 'Soft corporate bed',
  summary:
    'Clean electric grand, finger bass, string pad, and a light kit. Confident and optimistic for product demos, training, and client-facing explainers.',
  defaultSeconds: 30,
  defaultBpm: 108,
  defaultKey: { tonic: 'C', mode: 'major' },
  mood: 'professional, optimistic, clean',
  tags: ['corporate', 'product', 'training', 'clean', '30s'],
  romanNumerals: ['Imaj7', 'V', 'vi7', 'IVmaj7'],
  progression: [0, 4, 5, 3],
  instruments: [
    {
      role: 'chords',
      label: 'Electric Grand Piano',
      program: 2,
      description: 'Half-note comping with gentle syncopation.',
    },
    {
      role: 'pad',
      label: 'String Ensemble',
      program: 48,
      description: 'Low sustained strings for a polished bed.',
    },
    {
      role: 'bass',
      label: 'Finger Electric Bass',
      program: 33,
      description: 'Root-fifth half notes, no flashy fills.',
    },
    {
      role: 'melody',
      label: 'Flute',
      program: 73,
      description: 'Short optimistic phrase every four bars.',
    },
    {
      role: 'drums',
      label: 'GM Standard Kit',
      program: null,
      description: 'Light kick, clap, and tambourine.',
    },
  ],
  groove:
    'Kick on 1 and 3, clap on 2 and 4, quiet eighth hats, tambourine accents on the offbeats.',
  arrangement:
    'Two-bar intro, bass and percussion enter, strings widen the chorus, flute marks every fourth bar, drums drop before the final chord.',
  mix: 'Balanced and mid-forward, short reverb, controlled highs. Aim for a clean bed that can sit under a confident voice.',
  avoid: [
    'Do not use overdrive guitars or aggressive synth leads.',
    'Do not crowd the 1-4 kHz speech range with bells.',
    'Do not write busy drum fills.',
  ],
  tailSeconds: 2.6,
};

const STINGER: BgmPresetDefinition = {
  id: 'stinger',
  name: 'Short tension stinger',
  summary:
    'A six-second dramatic cue: low strings, brass hit, timpani-like kick, and a resolving final chord. For reveals, chapter cards, and game trailers.',
  defaultSeconds: 6,
  defaultBpm: 110,
  defaultKey: { tonic: 'D', mode: 'minor' },
  mood: 'dramatic, tense, cinematic',
  tags: ['stinger', 'reveal', 'trailer', 'short', '6s'],
  romanNumerals: ['i', 'iv', 'V', 'i'],
  progression: [0, 3, 4, 0],
  instruments: [
    {
      role: 'chords',
      label: 'Tremolo Strings',
      program: 44,
      description: 'Tense sustained upper strings.',
    },
    {
      role: 'pad',
      label: 'Brass Section',
      program: 61,
      description: 'Short brass swell into the final hit.',
    },
    {
      role: 'bass',
      label: 'Cello',
      program: 42,
      description: 'Low root movement under the tension.',
    },
    {
      role: 'drums',
      label: 'GM Standard Kit',
      program: null,
      description: 'Crash, low kick, and one tom fill.',
    },
  ],
  groove: 'Crash on the downbeat, kick on 1 and 3, snare on 3, tom fill into the last hit.',
  arrangement:
    'Two-beat string swell, brass enters, kick and crash mark the reveal, final tonic chord rings out.',
  mix: 'Wide strings, brass slightly behind, kick and crash forward, long reverb. This is the one preset where dramatic level is appropriate.',
  avoid: [
    'Do not use this for long backgrounds; it is a six-second accent.',
    'Do not add a melodic hook after the hit.',
  ],
  tailSeconds: 2.4,
};

export const BGM_PRESETS: readonly BgmPresetDefinition[] = Object.freeze([
  LOFI,
  TUTORIAL_UPBEAT,
  AMBIENT_FOCUS,
  CORPORATE_CLEAN,
  STINGER,
]);

const PRESET_BY_ID: ReadonlyMap<string, BgmPresetDefinition> = new Map(
  BGM_PRESETS.map((preset) => [preset.id, preset]),
);

export function getBgmPreset(id: string): BgmPresetDefinition | undefined {
  return PRESET_BY_ID.get(id);
}

const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11] as const;
const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10] as const;

const TONIC_PITCH_CLASS: Readonly<Record<SongKey['tonic'], number>> = Object.freeze({
  C: 0,
  'C#': 1,
  D: 2,
  'D#': 3,
  E: 4,
  F: 5,
  'F#': 6,
  G: 7,
  'G#': 8,
  A: 9,
  'A#': 10,
  B: 11,
});

function scaleFor(key: SongKey): readonly number[] {
  return key.mode === 'major' ? MAJOR_SCALE : MINOR_SCALE;
}

function scaleSemitone(degree: number, scale: readonly number[]): number {
  const octave = Math.floor(degree / 7);
  const index = ((degree % 7) + 7) % 7;
  return scale[index]! + octave * 12;
}

function pitchClass(degree: number, key: SongKey): number {
  const tonic = TONIC_PITCH_CLASS[key.tonic];
  return (tonic + scaleSemitone(degree, scaleFor(key))) % 12;
}

function midiInRange(pc: number, low: number, high: number): number {
  let pitch = low + ((pc - (low % 12) + 12) % 12);
  while (pitch < low) {
    pitch += 12;
  }
  while (pitch > high) {
    pitch -= 12;
  }
  return pitch;
}

/**
 * Build a smooth four-note seventh-chord voicing near `center`.
 *
 * Diatonic chord tones are scale degrees `degree` through `degree + 6`. Every
 * inversion and nearby octave placement is scored against the previous voicing
 * so common-tone motion wins over root-position leaps.
 */
function voiceChord(
  degree: number,
  key: SongKey,
  previous: readonly number[] | null,
  center = 62,
): number[] {
  const pcs = [0, 2, 4, 6].map((offset) => pitchClass(degree + offset, key));
  let best: number[] | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let base = center - 14; base <= center + 7; base += 1) {
    for (let rotation = 0; rotation < pcs.length; rotation += 1) {
      const ordered = [...pcs.slice(rotation), ...pcs.slice(0, rotation)];
      const notes: number[] = [];
      let last = base - 1;
      for (const pc of ordered) {
        let pitch = base + ((pc - (base % 12) + 12) % 12);
        while (pitch <= last) {
          pitch += 12;
        }
        notes.push(pitch);
        last = pitch;
      }
      if (notes[0]! < center - 16 || notes[notes.length - 1]! > center + 16) {
        continue;
      }
      const target = previous ?? [center - 4, center, center + 3, center + 7];
      let score = 0;
      for (let index = 0; index < 4; index += 1) {
        score += Math.abs(notes[index]! - (target[index] ?? target[target.length - 1]!));
      }
      score += Math.abs(notes[0]! - target[0]!) * 0.25;
      if (score < bestScore) {
        bestScore = score;
        best = notes;
      }
    }
  }
  return best ?? pcs.map((pc) => midiInRange(pc, center - 4, center + 10));
}

interface Hit {
  readonly at: number;
  readonly duration: number;
  readonly velocity: number;
  readonly degreeOffset?: number;
  readonly semitoneOffset?: number;
}

const CHORD_HITS: Readonly<Record<BgmPresetId, readonly Hit[]>> = {
  lofi: [
    { at: 0, duration: 2.55, velocity: 82 },
    { at: 1.75, duration: 0.7, velocity: 66 },
    { at: 2.5, duration: 1.35, velocity: 76 },
  ],
  tutorial_upbeat: [
    { at: 0, duration: 0.82, velocity: 86 },
    { at: 1, duration: 0.82, velocity: 76 },
    { at: 2, duration: 0.82, velocity: 84 },
    { at: 3, duration: 0.82, velocity: 74 },
  ],
  ambient_focus: [{ at: 0, duration: 3.92, velocity: 68 }],
  corporate_clean: [
    { at: 0, duration: 1.85, velocity: 80 },
    { at: 2, duration: 1.85, velocity: 72 },
  ],
  stinger: [
    { at: 0, duration: 1.9, velocity: 102 },
    { at: 2, duration: 1.9, velocity: 94 },
  ],
};

const BASS_HITS: Readonly<Record<BgmPresetId, readonly Hit[]>> = {
  lofi: [
    { at: 0, duration: 1.35, velocity: 94 },
    { at: 1.5, duration: 0.35, velocity: 78 },
    { at: 2, duration: 0.85, velocity: 88 },
    { at: 3.5, duration: 0.35, velocity: 74, semitoneOffset: 7 },
  ],
  tutorial_upbeat: [
    { at: 0, duration: 0.38, velocity: 96 },
    { at: 1, duration: 0.38, velocity: 82 },
    { at: 2, duration: 0.38, velocity: 92, semitoneOffset: 7 },
    { at: 3, duration: 0.38, velocity: 80 },
    { at: 3.5, duration: 0.3, velocity: 76, semitoneOffset: 12 },
  ],
  ambient_focus: [{ at: 0, duration: 3.85, velocity: 64 }],
  corporate_clean: [
    { at: 0, duration: 1.8, velocity: 88 },
    { at: 2, duration: 1.8, velocity: 76, semitoneOffset: 7 },
  ],
  stinger: [
    { at: 0, duration: 1.8, velocity: 104 },
    { at: 2, duration: 1.8, velocity: 96, semitoneOffset: 7 },
  ],
};

interface DrumHit {
  readonly beat: number;
  readonly key: GmDrumAlias;
  readonly velocity: number;
  readonly duration?: number;
}

function drumPattern(preset: BgmPresetId, bar: number, bars: number): DrumHit[] {
  const hits: DrumHit[] = [];
  const accent = (base: number, barIndex: number, step: number): number =>
    Math.max(1, Math.min(127, base + ((barIndex * 5 + step * 3) % 7) - 3));
  const fill = bar === bars - 1;

  if (preset === 'lofi') {
    hits.push(
      { beat: 0, key: 'kick', velocity: accent(106, bar, 0) },
      { beat: 2.5, key: 'kick', velocity: accent(96, bar, 1) },
      { beat: 1, key: 'snare', velocity: accent(74, bar, 2) },
      { beat: 3, key: 'snare', velocity: accent(78, bar, 3) },
    );
    if (bar % 2 === 1) {
      hits.push({ beat: 1.75, key: 'snare', velocity: 34, duration: 0.2 });
    }
    for (let step = 0; step < 8; step += 1) {
      hits.push({
        beat: step * 0.5,
        key: bar % 4 === 3 && step === 7 ? 'hatOpen' : 'hatClosed',
        velocity: accent(step % 2 === 0 ? 48 : 36, bar, step),
        duration: 0.18,
      });
    }
    if (fill) {
      hits.push(
        { beat: 3.25, key: 'tomLow', velocity: 70, duration: 0.2 },
        { beat: 3.5, key: 'tomHigh', velocity: 66, duration: 0.2 },
      );
    }
  } else if (preset === 'tutorial_upbeat') {
    for (let beat = 0; beat < 4; beat += 1) {
      hits.push({ beat, key: 'kick', velocity: accent(100, bar, beat) });
    }
    hits.push(
      { beat: 1, key: 'clap', velocity: accent(78, bar, 4) },
      { beat: 3, key: 'clap', velocity: accent(82, bar, 5) },
    );
    for (let step = 0; step < 4; step += 1) {
      hits.push({
        beat: step + 0.5,
        key: 'hatClosed',
        velocity: accent(42, bar, step),
        duration: 0.18,
      });
    }
    if (bar % 4 === 3) {
      hits.push({ beat: 3.75, key: 'hatOpen', velocity: 54, duration: 0.24 });
    }
    if (fill) {
      hits.push(
        { beat: 2.75, key: 'tomLow', velocity: 66, duration: 0.2 },
        { beat: 3, key: 'tomHigh', velocity: 70, duration: 0.2 },
        { beat: 3.25, key: 'snare', velocity: 62, duration: 0.2 },
      );
    }
  } else if (preset === 'corporate_clean') {
    hits.push(
      { beat: 0, key: 'kick', velocity: accent(90, bar, 0) },
      { beat: 2, key: 'kick', velocity: accent(82, bar, 1) },
      { beat: 1, key: 'clap', velocity: accent(66, bar, 2) },
      { beat: 3, key: 'clap', velocity: accent(68, bar, 3) },
      { beat: 1.5, key: 'tambourine', velocity: accent(50, bar, 4), duration: 0.2 },
      { beat: 3.5, key: 'tambourine', velocity: accent(46, bar, 5), duration: 0.2 },
    );
    for (let step = 0; step < 8; step += 1) {
      hits.push({
        beat: step * 0.5,
        key: 'hatClosed',
        velocity: accent(32, bar, step),
        duration: 0.16,
      });
    }
    if (fill) {
      hits.push({ beat: 3.5, key: 'snare', velocity: 60, duration: 0.2 });
    }
  } else if (preset === 'stinger') {
    hits.push(
      { beat: 0, key: 'crash', velocity: 104, duration: 0.5 },
      { beat: 0, key: 'kick', velocity: 110 },
      { beat: 2, key: 'kick', velocity: 96 },
      { beat: 2, key: 'snare', velocity: 88 },
      { beat: 3.5, key: 'tomLow', velocity: 92, duration: 0.3 },
      { beat: 3.75, key: 'tomHigh', velocity: 96, duration: 0.3 },
    );
  }

  return hits;
}

interface MelodyCell {
  readonly barOffset: number;
  readonly notes: readonly {
    readonly degree: number;
    readonly at: number;
    readonly duration: number;
    readonly velocity: number;
  }[];
}

const MELODY_CELLS: Readonly<Record<BgmPresetId, readonly MelodyCell[]>> = {
  lofi: [
    {
      barOffset: 0,
      notes: [
        { degree: 9, at: 1.5, duration: 0.45, velocity: 62 },
        { degree: 7, at: 2.25, duration: 0.5, velocity: 56 },
        { degree: 6, at: 3, duration: 0.9, velocity: 58 },
      ],
    },
    {
      barOffset: 2,
      notes: [
        { degree: 11, at: 1.75, duration: 0.4, velocity: 60 },
        { degree: 9, at: 2.5, duration: 0.75, velocity: 54 },
      ],
    },
  ],
  tutorial_upbeat: [
    {
      barOffset: 0,
      notes: [
        { degree: 9, at: 0.5, duration: 0.35, velocity: 72 },
        { degree: 11, at: 1, duration: 0.35, velocity: 68 },
        { degree: 12, at: 1.5, duration: 0.7, velocity: 76 },
      ],
    },
    {
      barOffset: 1,
      notes: [
        { degree: 9, at: 2, duration: 0.35, velocity: 66 },
        { degree: 7, at: 2.5, duration: 0.35, velocity: 62 },
        { degree: 6, at: 3, duration: 0.8, velocity: 64 },
      ],
    },
  ],
  ambient_focus: [
    {
      barOffset: 0,
      notes: [
        { degree: 9, at: 2, duration: 1.2, velocity: 46 },
        { degree: 12, at: 4, duration: 2.4, velocity: 42 },
      ],
    },
    {
      barOffset: 4,
      notes: [{ degree: 11, at: 3, duration: 3.2, velocity: 40 }],
    },
  ],
  corporate_clean: [
    {
      barOffset: 0,
      notes: [
        { degree: 9, at: 0.5, duration: 0.7, velocity: 62 },
        { degree: 11, at: 1.5, duration: 0.7, velocity: 58 },
        { degree: 12, at: 2.5, duration: 1.1, velocity: 64 },
      ],
    },
  ],
  stinger: [
    {
      barOffset: 0,
      notes: [
        { degree: 7, at: 0.5, duration: 0.4, velocity: 92 },
        { degree: 9, at: 1, duration: 0.4, velocity: 96 },
        { degree: 12, at: 1.5, duration: 1.5, velocity: 104 },
      ],
    },
  ],
};

function effectsFor(preset: BgmPresetId, role: PresetRole): Effect[] {
  if (role === 'bass' || role === 'drums') {
    return [];
  }
  if (preset === 'lofi') {
    if (role === 'chords') {
      return [
        { type: 'lowpass', cutoffHz: 5600, q: 0.7 },
        { type: 'reverb', mix: 0.18, decaySeconds: 2.4 },
      ];
    }
    if (role === 'pad') {
      return [
        { type: 'lowpass', cutoffHz: 3200, q: 0.8 },
        { type: 'reverb', mix: 0.24, decaySeconds: 2.8 },
      ];
    }
    return [
      { type: 'delay', timeMs: 500, feedback: 0.3, mix: 0.18 },
      { type: 'reverb', mix: 0.14, decaySeconds: 1.8 },
    ];
  }
  if (preset === 'tutorial_upbeat') {
    if (role === 'chords') {
      return [
        { type: 'lowpass', cutoffHz: 9000, q: 0.7 },
        { type: 'reverb', mix: 0.1, decaySeconds: 1.4 },
      ];
    }
    if (role === 'pad') {
      return [{ type: 'reverb', mix: 0.12, decaySeconds: 1.6 }];
    }
    return [{ type: 'delay', timeMs: 375, feedback: 0.22, mix: 0.12 }];
  }
  if (preset === 'ambient_focus') {
    if (role === 'melody') {
      return [
        { type: 'lowpass', cutoffHz: 5000, q: 0.7 },
        { type: 'delay', timeMs: 750, feedback: 0.35, mix: 0.24 },
        { type: 'reverb', mix: 0.3, decaySeconds: 3.2 },
      ];
    }
    return [
      { type: 'lowpass', cutoffHz: role === 'pad' ? 2600 : 3400, q: 0.8 },
      { type: 'reverb', mix: 0.3, decaySeconds: 3.2 },
    ];
  }
  if (preset === 'corporate_clean') {
    if (role === 'chords') {
      return [
        { type: 'eq', lowGainDb: -1, midGainDb: 1, highGainDb: -1 },
        { type: 'reverb', mix: 0.14, decaySeconds: 1.8 },
      ];
    }
    if (role === 'pad') {
      return [{ type: 'reverb', mix: 0.16, decaySeconds: 2.0 }];
    }
    return [
      { type: 'delay', timeMs: 333, feedback: 0.2, mix: 0.1 },
      { type: 'reverb', mix: 0.16, decaySeconds: 1.8 },
    ];
  }
  if (role === 'chords') {
    return [{ type: 'reverb', mix: 0.28, decaySeconds: 2.2 }];
  }
  if (role === 'pad') {
    return [{ type: 'reverb', mix: 0.24, decaySeconds: 2.0 }];
  }
  return [{ type: 'reverb', mix: 0.2, decaySeconds: 1.8 }];
}

function instrumentForProgram(program: number): GmInstrument {
  return { type: 'gm', program, bank: 0 };
}

function chordTrack(
  preset: BgmPresetDefinition,
  key: SongKey,
  fullBars: number,
  finalStart: number,
  finalDuration: number,
): Track {
  const notes: Note[] = [];
  const hits = CHORD_HITS[preset.id];
  let previous: number[] | null = null;
  for (let bar = 0; bar < fullBars; bar += 1) {
    const degree = preset.progression[bar % preset.progression.length]!;
    const voicing = voiceChord(degree, key, previous, 63);
    previous = voicing;
    for (const [hitIndex, hit] of hits.entries()) {
      const velocity = Math.max(
        1,
        Math.min(127, hit.velocity + ((bar * 3 + hitIndex * 5) % 9) - 4),
      );
      for (const pitch of voicing) {
        notes.push({
          pitch,
          start: bar * 4 + hit.at,
          duration: hit.duration,
          velocity,
        });
      }
    }
  }
  const finalDegree = preset.progression[0]!;
  const finalVoicing = voiceChord(finalDegree, key, previous, 63);
  for (const pitch of finalVoicing) {
    notes.push({
      pitch,
      start: finalStart,
      duration: finalDuration,
      velocity: 70,
    });
  }
  const recipe = preset.instruments.find((entry) => entry.role === 'chords');
  const program = recipe?.program ?? 0;
  return {
    id: 'chords',
    name: recipe?.label ?? 'Chords',
    kind: 'midi',
    channel: 0,
    instrument: instrumentForProgram(program),
    volume: preset.id === 'stinger' ? 0.72 : 0.8,
    pan: preset.id === 'ambient_focus' ? 0.08 : -0.2,
    notes,
    effects: effectsFor(preset.id, 'chords'),
  };
}

function padTrack(
  preset: BgmPresetDefinition,
  key: SongKey,
  fullBars: number,
  finalStart: number,
  finalDuration: number,
): Track {
  const notes: Note[] = [];
  let previous: number[] | null = null;
  for (let bar = 0; bar < fullBars; bar += 1) {
    const degree = preset.progression[bar % preset.progression.length]!;
    const voicing = voiceChord(degree, key, previous, 58);
    previous = voicing;
    const velocity = 52 + ((bar * 2) % 9);
    for (const pitch of voicing.slice(0, 3)) {
      notes.push({ pitch, start: bar * 4, duration: 3.92, velocity });
    }
  }
  const finalVoicing = voiceChord(preset.progression[0]!, key, previous, 58);
  for (const pitch of finalVoicing.slice(0, 3)) {
    notes.push({ pitch, start: finalStart, duration: finalDuration, velocity: 54 });
  }
  const recipe = preset.instruments.find((entry) => entry.role === 'pad');
  const program = recipe?.program ?? 89;
  return {
    id: 'pad',
    name: recipe?.label ?? 'Pad',
    kind: 'midi',
    channel: 1,
    instrument: instrumentForProgram(program),
    volume: preset.id === 'ambient_focus' ? 0.88 : 0.62,
    pan: 0.28,
    notes,
    effects: effectsFor(preset.id, 'pad'),
  };
}

function bassTrack(
  preset: BgmPresetDefinition,
  key: SongKey,
  fullBars: number,
  startBar: number,
  finalStart: number,
  finalDuration: number,
): Track {
  const notes: Note[] = [];
  const hits = BASS_HITS[preset.id];
  for (let bar = startBar; bar < fullBars; bar += 1) {
    const degree = preset.progression[bar % preset.progression.length]!;
    const rootPc = pitchClass(degree, key);
    const root = midiInRange(rootPc, 33, 43);
    for (const [hitIndex, hit] of hits.entries()) {
      const offset = hit.semitoneOffset ?? 0;
      let pitch = root + offset;
      if (pitch > 45) {
        pitch -= 12;
      }
      const velocity = Math.max(
        1,
        Math.min(127, hit.velocity + ((bar * 4 + hitIndex * 3) % 7) - 3),
      );
      notes.push({
        pitch,
        start: bar * 4 + hit.at,
        duration: hit.duration,
        velocity,
      });
    }
  }
  const root = midiInRange(pitchClass(preset.progression[0]!, key), 33, 43);
  notes.push({ pitch: root, start: finalStart, duration: finalDuration, velocity: 82 });
  const recipe = preset.instruments.find((entry) => entry.role === 'bass');
  const program = recipe?.program ?? 33;
  return {
    id: 'bass',
    name: recipe?.label ?? 'Bass',
    kind: 'midi',
    channel: 2,
    instrument: instrumentForProgram(program),
    volume: 0.9,
    pan: 0,
    notes,
    effects: [],
  };
}

function melodyTrack(
  preset: BgmPresetDefinition,
  key: SongKey,
  fullBars: number,
  startBar: number,
): Track {
  const notes: Note[] = [];
  const cells = MELODY_CELLS[preset.id];
  const cellSpan = preset.id === 'ambient_focus' ? 8 : preset.id === 'tutorial_upbeat' ? 2 : 4;
  for (let bar = startBar; bar < fullBars; bar += cellSpan) {
    const degree = preset.progression[bar % preset.progression.length]!;
    const cell = cells[Math.floor((bar - startBar) / cellSpan) % cells.length]!;
    for (const note of cell.notes) {
      const absoluteDegree = degree + note.degree;
      const pc = pitchClass(absoluteDegree, key);
      const pitch = midiInRange(pc, 67, 84);
      notes.push({
        pitch,
        start: bar * 4 + note.at,
        duration: note.duration,
        velocity: note.velocity,
      });
    }
  }
  if (notes.length === 0) {
    notes.push({ pitch: 72, start: startBar * 4, duration: 1, velocity: 50 });
  }
  const recipe = preset.instruments.find((entry) => entry.role === 'melody');
  const program = recipe?.program ?? 11;
  return {
    id: 'melody',
    name: recipe?.label ?? 'Melody',
    kind: 'midi',
    channel: 3,
    instrument: instrumentForProgram(program),
    volume: preset.id === 'stinger' ? 0.8 : 0.52,
    pan: 0.32,
    notes,
    effects: effectsFor(preset.id, 'melody'),
  };
}

function drumsTrack(preset: BgmPresetDefinition, startBar: number, endBar: number): Track {
  const notes: Note[] = [];
  for (let bar = startBar; bar < endBar; bar += 1) {
    for (const hit of drumPattern(preset.id, bar - startBar, Math.max(1, endBar - startBar))) {
      notes.push({
        pitch: GM_DRUM_NOTE_MAP[hit.key],
        start: bar * 4 + hit.beat,
        duration: hit.duration ?? 0.25,
        velocity: hit.velocity,
      });
    }
  }
  if (notes.length === 0) {
    notes.push({ pitch: 36, start: 0, duration: 0.25, velocity: 80 });
  }
  return {
    id: 'drums',
    name: 'Drums',
    kind: 'drums',
    channel: 9,
    instrument: { type: 'builtin', id: 'drums.kit' },
    volume: preset.id === 'stinger' ? 0.78 : preset.id === 'ambient_focus' ? 0.4 : 0.6,
    pan: 0,
    notes,
    effects: [],
  };
}

export interface PresetSongOptions {
  readonly title?: string;
  readonly bpm?: number;
  readonly durationSeconds?: number;
  readonly key?: SongKey;
  readonly seed?: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

/**
 * Build a complete BGM cue from a named preset.
 *
 * The requested duration is the render length, not the last note: the generator
 * reserves the preset's reverb and delay tail inside `durationHint` so the last
 * release finishes at or before the video cut.
 */
export function createPresetSong(
  presetId: BgmPresetId | string,
  options: PresetSongOptions = {},
): SongSchemaV1 {
  const preset = getBgmPreset(presetId);
  if (preset === undefined) {
    throw new Error(
      `Unknown BGM preset "${presetId}". Use one of: ${BGM_PRESETS.map((entry) => entry.id).join(', ')}.`,
    );
  }
  const bpm = clamp(Math.round(options.bpm ?? preset.defaultBpm), 20, 300);
  const seconds = clamp(options.durationSeconds ?? preset.defaultSeconds, 2, 600);
  const key = options.key ?? preset.defaultKey;
  const hintBeats = (seconds * bpm) / 60;
  const durationTag = `${Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(1)}s`;
  const tags = [...preset.tags.filter((tag) => !/^[0-9.]+s$/.test(tag)), durationTag];
  const tailBeats = (preset.tailSeconds * bpm) / 60;
  const contentEnd = Math.max(1, hintBeats - tailBeats);
  const fullBars = Math.max(0, Math.floor(contentEnd / 4));
  const finalStart = fullBars * 4;
  const finalDuration = Math.max(0.5, contentEnd - finalStart);

  const introBars = Math.min(fullBars, Math.max(1, Math.round(fullBars * 0.22)));
  const drumStart =
    preset.id === 'stinger' ? 0 : Math.min(Math.max(0, fullBars - 1), introBars + 1);
  const drumEnd =
    preset.id === 'stinger'
      ? Math.max(1, fullBars)
      : fullBars < 6
        ? fullBars
        : Math.max(drumStart, fullBars - 2);
  const melodyStart = Math.min(Math.max(0, fullBars - 1), introBars + 2);

  const bassStart = Math.min(fullBars, introBars);
  const tracks: Track[] = [
    chordTrack(preset, key, fullBars, finalStart, finalDuration),
    padTrack(preset, key, fullBars, finalStart, finalDuration),
    bassTrack(preset, key, fullBars, bassStart, finalStart, finalDuration),
  ];
  if (preset.instruments.some((entry) => entry.role === 'melody') && melodyStart < fullBars) {
    tracks.push(melodyTrack(preset, key, fullBars, melodyStart));
  }
  if (preset.instruments.some((entry) => entry.role === 'drums') && drumStart < drumEnd) {
    tracks.push(drumsTrack(preset, drumStart, drumEnd));
  }

  return {
    schemaVersion: '1.0.0',
    meta: {
      title: options.title ?? preset.name,
      bpm,
      timeSignature: { numerator: 4, denominator: 4 },
      key,
      seed: options.seed ?? 20261031,
      durationHint: hintBeats,
      mood: preset.mood,
      tags,
    },
    tracks,
  };
}

/** Compact recipe summary for CLI and MCP discovery output. */
export interface BgmPresetDescription {
  readonly id: BgmPresetId;
  readonly name: string;
  readonly summary: string;
  readonly defaultSeconds: number;
  readonly defaultBpm: number;
  readonly defaultKey: SongKey;
  readonly mood: string;
  readonly tags: readonly string[];
  readonly romanNumerals: readonly string[];
  readonly instruments: readonly PresetInstrumentRecipe[];
  readonly groove: string;
  readonly arrangement: string;
  readonly mix: string;
  readonly avoid: readonly string[];
}

export function describeBgmPresets(): readonly BgmPresetDescription[] {
  return BGM_PRESETS.map((preset) => ({
    id: preset.id,
    name: preset.name,
    summary: preset.summary,
    defaultSeconds: preset.defaultSeconds,
    defaultBpm: preset.defaultBpm,
    defaultKey: preset.defaultKey,
    mood: preset.mood,
    tags: preset.tags,
    romanNumerals: preset.romanNumerals,
    instruments: preset.instruments,
    groove: preset.groove,
    arrangement: preset.arrangement,
    mix: preset.mix,
    avoid: preset.avoid,
  }));
}
