/**
 * General MIDI percussion mapping used by the built-in `drums.kit` voice.
 *
 * SongSchemaV1 restricts drum-track pitches to the GM percussion range 35 to 81.
 * Every pitch in that range maps to exactly one deterministic synthesized voice
 * family. The built-in backend rejects pitches outside the range instead of
 * silently transposing or substituting a different key.
 */
export type BuiltinDrumFamily =
  | 'kick'
  | 'snare'
  | 'clap'
  | 'rim'
  | 'tom'
  | 'closed-hat'
  | 'open-hat'
  | 'crash'
  | 'ride'
  | 'bell'
  | 'shaker'
  | 'hand-drum'
  | 'whistle'
  | 'wood'
  | 'guiro'
  | 'metal';

export interface BuiltinDrumDefinition {
  readonly pitch: number;
  readonly name: string;
  readonly family: BuiltinDrumFamily;
}

/** GM percussion keys 35 through 81, as accepted by SongSchemaV1 drum tracks. */
export const BUILTIN_DRUM_MAP: readonly BuiltinDrumDefinition[] = Object.freeze([
  { pitch: 35, name: 'Acoustic Bass Drum', family: 'kick' },
  { pitch: 36, name: 'Bass Drum 1', family: 'kick' },
  { pitch: 37, name: 'Side Stick', family: 'rim' },
  { pitch: 38, name: 'Acoustic Snare', family: 'snare' },
  { pitch: 39, name: 'Hand Clap', family: 'clap' },
  { pitch: 40, name: 'Electric Snare', family: 'snare' },
  { pitch: 41, name: 'Low Floor Tom', family: 'tom' },
  { pitch: 42, name: 'Closed Hi-Hat', family: 'closed-hat' },
  { pitch: 43, name: 'High Floor Tom', family: 'tom' },
  { pitch: 44, name: 'Pedal Hi-Hat', family: 'closed-hat' },
  { pitch: 45, name: 'Low Tom', family: 'tom' },
  { pitch: 46, name: 'Open Hi-Hat', family: 'open-hat' },
  { pitch: 47, name: 'Low-Mid Tom', family: 'tom' },
  { pitch: 48, name: 'Hi-Mid Tom', family: 'tom' },
  { pitch: 49, name: 'Crash Cymbal 1', family: 'crash' },
  { pitch: 50, name: 'High Tom', family: 'tom' },
  { pitch: 51, name: 'Ride Cymbal 1', family: 'ride' },
  { pitch: 52, name: 'Chinese Cymbal', family: 'crash' },
  { pitch: 53, name: 'Ride Bell', family: 'bell' },
  { pitch: 54, name: 'Tambourine', family: 'shaker' },
  { pitch: 55, name: 'Splash Cymbal', family: 'crash' },
  { pitch: 56, name: 'Cowbell', family: 'metal' },
  { pitch: 57, name: 'Crash Cymbal 2', family: 'crash' },
  { pitch: 58, name: 'Vibraslap', family: 'guiro' },
  { pitch: 59, name: 'Ride Cymbal 2', family: 'ride' },
  { pitch: 60, name: 'Hi Bongo', family: 'hand-drum' },
  { pitch: 61, name: 'Low Bongo', family: 'hand-drum' },
  { pitch: 62, name: 'Mute Hi Conga', family: 'hand-drum' },
  { pitch: 63, name: 'Open Hi Conga', family: 'hand-drum' },
  { pitch: 64, name: 'Low Conga', family: 'hand-drum' },
  { pitch: 65, name: 'High Timbale', family: 'hand-drum' },
  { pitch: 66, name: 'Low Timbale', family: 'hand-drum' },
  { pitch: 67, name: 'High Agogo', family: 'bell' },
  { pitch: 68, name: 'Low Agogo', family: 'bell' },
  { pitch: 69, name: 'Cabasa', family: 'shaker' },
  { pitch: 70, name: 'Maracas', family: 'shaker' },
  { pitch: 71, name: 'Short Whistle', family: 'whistle' },
  { pitch: 72, name: 'Long Whistle', family: 'whistle' },
  { pitch: 73, name: 'Short Guiro', family: 'guiro' },
  { pitch: 74, name: 'Long Guiro', family: 'guiro' },
  { pitch: 75, name: 'Claves', family: 'wood' },
  { pitch: 76, name: 'Hi Wood Block', family: 'wood' },
  { pitch: 77, name: 'Low Wood Block', family: 'wood' },
  { pitch: 78, name: 'Mute Cuica', family: 'guiro' },
  { pitch: 79, name: 'Open Cuica', family: 'guiro' },
  { pitch: 80, name: 'Mute Triangle', family: 'metal' },
  { pitch: 81, name: 'Open Triangle', family: 'metal' },
]);

/** Minimum GM percussion key accepted by `drums.kit`. */
export const MIN_BUILTIN_DRUM_PITCH = 35;

/** Maximum GM percussion key accepted by `drums.kit`. */
export const MAX_BUILTIN_DRUM_PITCH = 81;

/** Internal synthesis parameters for one mapped percussion key. */
export interface BuiltinDrumVoiceSpec extends BuiltinDrumDefinition {
  readonly durationSeconds: number;
  readonly attackSeconds: number;
  readonly decayTauSeconds: number;
  readonly baseHz: number;
  readonly endHz: number;
  readonly pitchDropTauSeconds: number;
  readonly toneLevel: number;
  readonly noiseLevel: number;
  readonly noiseMode: 'lowpass' | 'highpass';
  readonly noiseCutoffHz: number;
  readonly metallicLevel: number;
  readonly metallicBaseHz: number;
  readonly clickLevel: number;
  readonly clapBursts: boolean;
  readonly gain: number;
}

interface DrumSpecOverrides {
  durationSeconds?: number;
  attackSeconds?: number;
  decayTauSeconds?: number;
  baseHz?: number;
  endHz?: number;
  pitchDropTauSeconds?: number;
  toneLevel?: number;
  noiseLevel?: number;
  noiseMode?: 'lowpass' | 'highpass';
  noiseCutoffHz?: number;
  metallicLevel?: number;
  metallicBaseHz?: number;
  clickLevel?: number;
  clapBursts?: boolean;
  gain?: number;
}

const TOM_FREQUENCIES: Readonly<Record<number, number>> = {
  41: 82,
  43: 98,
  45: 110,
  47: 131,
  48: 147,
  50: 165,
};

const HAND_DRUM_FREQUENCIES: Readonly<Record<number, number>> = {
  60: 392,
  61: 330,
  62: 330,
  63: 294,
  64: 220,
  65: 523,
  66: 392,
};

const WOOD_FREQUENCIES: Readonly<Record<number, number>> = {
  75: 1200,
  76: 1000,
  77: 760,
};

const GUIRO_FREQUENCIES: Readonly<Record<number, number>> = {
  58: 380,
  73: 650,
  74: 550,
  78: 320,
  79: 280,
};

const BELL_FREQUENCIES: Readonly<Record<number, number>> = {
  53: 1100,
  67: 820,
  68: 620,
};

const METAL_FREQUENCIES: Readonly<Record<number, number>> = {
  56: 540,
  80: 1900,
  81: 1700,
};

function define(
  definition: BuiltinDrumDefinition,
  overrides: DrumSpecOverrides,
): BuiltinDrumVoiceSpec {
  return {
    ...definition,
    durationSeconds: 0.4,
    attackSeconds: 0.001,
    decayTauSeconds: 0.09,
    baseHz: 200,
    endHz: 200,
    pitchDropTauSeconds: 0.04,
    toneLevel: 0,
    noiseLevel: 0,
    noiseMode: 'highpass',
    noiseCutoffHz: 2000,
    metallicLevel: 0,
    metallicBaseHz: 500,
    clickLevel: 0,
    clapBursts: false,
    gain: 0.4,
    ...overrides,
  };
}

function specFor(definition: BuiltinDrumDefinition): BuiltinDrumVoiceSpec {
  const pitch = definition.pitch;
  switch (definition.family) {
    case 'kick':
      return define(definition, {
        durationSeconds: 0.6,
        attackSeconds: 0.0015,
        decayTauSeconds: 0.105,
        baseHz: pitch === 35 ? 145 : 158,
        endHz: pitch === 35 ? 44 : 48,
        pitchDropTauSeconds: 0.035,
        toneLevel: 1,
        noiseLevel: 0.08,
        noiseMode: 'lowpass',
        noiseCutoffHz: 700,
        clickLevel: 0.12,
        gain: 0.7,
      });
    case 'snare':
      return define(definition, {
        durationSeconds: 0.35,
        attackSeconds: 0.001,
        decayTauSeconds: 0.07,
        baseHz: pitch === 38 ? 190 : 255,
        endHz: pitch === 38 ? 168 : 225,
        pitchDropTauSeconds: 0.05,
        toneLevel: 0.38,
        noiseLevel: 0.85,
        noiseMode: 'highpass',
        noiseCutoffHz: 1200,
        clickLevel: 0.02,
        gain: 0.5,
      });
    case 'clap':
      return define(definition, {
        durationSeconds: 0.36,
        attackSeconds: 0.001,
        decayTauSeconds: 0.1,
        noiseLevel: 1,
        noiseMode: 'highpass',
        noiseCutoffHz: 900,
        clapBursts: true,
        gain: 0.5,
      });
    case 'rim':
      return define(definition, {
        durationSeconds: 0.14,
        attackSeconds: 0.0005,
        decayTauSeconds: 0.022,
        baseHz: 320,
        endHz: 300,
        toneLevel: 0.45,
        noiseLevel: 0.4,
        noiseMode: 'highpass',
        noiseCutoffHz: 1600,
        metallicLevel: 0.1,
        metallicBaseHz: 1500,
        clickLevel: 0.35,
        gain: 0.4,
      });
    case 'tom': {
      const frequency = TOM_FREQUENCIES[pitch] ?? 110;
      return define(definition, {
        durationSeconds: 0.55,
        attackSeconds: 0.0015,
        decayTauSeconds: 0.1,
        baseHz: frequency,
        endHz: frequency * 0.75,
        pitchDropTauSeconds: 0.08,
        toneLevel: 1,
        noiseLevel: 0.04,
        noiseMode: 'lowpass',
        noiseCutoffHz: 2500,
        clickLevel: 0.04,
        gain: 0.52,
      });
    }
    case 'closed-hat':
      return define(definition, {
        durationSeconds: 0.14,
        attackSeconds: 0.0005,
        decayTauSeconds: 0.018,
        noiseLevel: 1,
        noiseMode: 'highpass',
        noiseCutoffHz: 6500,
        metallicLevel: 0.12,
        metallicBaseHz: 7200,
        gain: 0.3,
      });
    case 'open-hat':
      return define(definition, {
        durationSeconds: 0.9,
        attackSeconds: 0.0005,
        decayTauSeconds: 0.2,
        noiseLevel: 1,
        noiseMode: 'highpass',
        noiseCutoffHz: 6000,
        metallicLevel: 0.12,
        metallicBaseHz: 6800,
        gain: 0.26,
      });
    case 'crash':
      return define(definition, {
        durationSeconds: pitch === 55 ? 1.1 : 2.6,
        attackSeconds: 0.001,
        decayTauSeconds: pitch === 55 ? 0.28 : 0.62,
        noiseLevel: 0.8,
        noiseMode: 'highpass',
        noiseCutoffHz: pitch === 52 ? 1800 : 2500,
        metallicLevel: 0.5,
        metallicBaseHz: pitch === 52 ? 380 : 440,
        clickLevel: 0.04,
        gain: 0.32,
      });
    case 'ride':
      return define(definition, {
        durationSeconds: 1.8,
        attackSeconds: 0.0008,
        decayTauSeconds: 0.4,
        noiseLevel: 0.3,
        noiseMode: 'highpass',
        noiseCutoffHz: 3000,
        metallicLevel: 0.7,
        metallicBaseHz: pitch === 59 ? 560 : 520,
        gain: 0.3,
      });
    case 'bell': {
      const frequency = BELL_FREQUENCIES[pitch] ?? 800;
      return define(definition, {
        durationSeconds: 1.3,
        attackSeconds: 0.0008,
        decayTauSeconds: 0.32,
        baseHz: frequency,
        endHz: frequency,
        toneLevel: 0.18,
        metallicLevel: 1,
        metallicBaseHz: frequency,
        gain: 0.32,
      });
    }
    case 'shaker':
      return define(definition, {
        durationSeconds: pitch === 54 ? 0.35 : 0.22,
        attackSeconds: 0.0008,
        decayTauSeconds: pitch === 54 ? 0.08 : 0.045,
        noiseLevel: 1,
        noiseMode: 'highpass',
        noiseCutoffHz: pitch === 54 ? 4500 : 5200,
        metallicLevel: pitch === 54 ? 0.15 : 0,
        metallicBaseHz: 6500,
        gain: 0.24,
      });
    case 'hand-drum': {
      const frequency = HAND_DRUM_FREQUENCIES[pitch] ?? 300;
      return define(definition, {
        durationSeconds: 0.5,
        attackSeconds: 0.0012,
        decayTauSeconds: 0.095,
        baseHz: frequency,
        endHz: frequency * 0.82,
        pitchDropTauSeconds: 0.06,
        toneLevel: 1,
        noiseLevel: 0.05,
        noiseMode: 'lowpass',
        noiseCutoffHz: 3000,
        clickLevel: 0.03,
        gain: 0.48,
      });
    }
    case 'whistle':
      return define(definition, {
        durationSeconds: pitch === 71 ? 0.3 : 0.65,
        attackSeconds: 0.008,
        decayTauSeconds: pitch === 71 ? 0.2 : 0.5,
        baseHz: pitch === 71 ? 2300 : 2100,
        endHz: pitch === 71 ? 2250 : 2050,
        pitchDropTauSeconds: 0.3,
        toneLevel: 1,
        gain: 0.26,
      });
    case 'wood': {
      const frequency = WOOD_FREQUENCIES[pitch] ?? 900;
      return define(definition, {
        durationSeconds: 0.18,
        attackSeconds: 0.0005,
        decayTauSeconds: 0.03,
        baseHz: frequency,
        endHz: frequency,
        toneLevel: 0.65,
        noiseLevel: 0.15,
        noiseMode: 'highpass',
        noiseCutoffHz: 2000,
        metallicLevel: 0.2,
        metallicBaseHz: frequency * 2.1,
        clickLevel: 0.25,
        gain: 0.42,
      });
    }
    case 'guiro': {
      const frequency = GUIRO_FREQUENCIES[pitch] ?? 400;
      return define(definition, {
        durationSeconds: pitch === 58 || pitch === 79 ? 0.7 : pitch === 74 ? 0.4 : 0.28,
        attackSeconds: 0.0008,
        decayTauSeconds: pitch === 58 || pitch === 79 ? 0.18 : 0.07,
        baseHz: frequency,
        endHz: frequency * 1.15,
        pitchDropTauSeconds: 0.2,
        toneLevel: 0.12,
        noiseLevel: 0.85,
        noiseMode: 'highpass',
        noiseCutoffHz: 2500,
        gain: 0.28,
      });
    }
    case 'metal': {
      const frequency = METAL_FREQUENCIES[pitch] ?? 900;
      return define(definition, {
        durationSeconds: pitch === 80 ? 1.2 : pitch === 81 ? 1.8 : 0.4,
        attackSeconds: 0.0008,
        decayTauSeconds: pitch === 56 ? 0.09 : 0.35,
        baseHz: frequency,
        endHz: frequency,
        toneLevel: 0.2,
        noiseLevel: 0.05,
        metallicLevel: 0.9,
        metallicBaseHz: frequency,
        clickLevel: pitch === 56 ? 0.05 : 0.02,
        gain: 0.3,
      });
    }
  }
}

const specCache = new Map<number, BuiltinDrumVoiceSpec>();

/** Resolve a GM percussion key to its built-in synthesis parameters. */
export function getBuiltinDrumSpec(pitch: number): BuiltinDrumVoiceSpec | undefined {
  const definition = BUILTIN_DRUM_MAP[pitch - MIN_BUILTIN_DRUM_PITCH];
  if (
    definition === undefined ||
    definition.pitch !== pitch ||
    pitch < MIN_BUILTIN_DRUM_PITCH ||
    pitch > MAX_BUILTIN_DRUM_PITCH
  ) {
    return undefined;
  }

  let spec = specCache.get(pitch);
  if (spec === undefined) {
    spec = specFor(definition);
    specCache.set(pitch, spec);
  }
  return spec;
}
