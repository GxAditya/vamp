/**
 * Authoritative v1 instrument registry.
 *
 * This is the single machine-readable source for curated instrument IDs,
 * sample-backend mappings, asset requirements, provenance, licenses, and
 * checksums. CLI, MCP, SDK, and documentation must read this registry instead
 * of copying instrument lists. The schema package still carries a small seed
 * allowlist for standalone validation; pass `INSTRUMENT_REGISTRY_VALIDATION`
 * (or `CURATED_INSTRUMENT_IDS`) through `ValidateSongOptions` to reconcile it
 * with this registry.
 *
 * The six curated IDs can be rendered by two backends:
 *
 * - `builtin-synth-v1` synthesizes them deterministically with no assets.
 * - `fluidsynth-sf2-v1` plays an explicit curated General MIDI mapping from a
 *   provisioned SoundFont. These mappings are documented, not silent
 *   substitutions: each entry names its GM program and bank.
 *
 * SFZ assets are not supported by the v1 sample backend. The registry exposes
 * that honestly instead of pretending a mapping exists.
 */

import type { InstrumentVariantType } from '@gxaditya/vamp-schema';

import { BUILTIN_DRUM_MAP } from './audio/drums.js';

/** Stable sample-backend identifier implemented in `audio/fluidsynth.ts`. */
export const FLUIDSYNTH_BACKEND_ID = 'fluidsynth-sf2-v1' as const;

/** Registry payload version. Independent of package and schema versions. */
export const INSTRUMENT_REGISTRY_VERSION = 1 as const;

/** Instrument variants the v1 sample backend can render. SFZ is absent by design. */
export const SAMPLE_BACKEND_INSTRUMENT_TYPES = Object.freeze([
  'builtin',
  'gm',
  'soundfont',
] as const satisfies readonly InstrumentVariantType[]);

export interface RegistryLicense {
  /** SPDX identifier of the asset license, or `NOASSERTION` when unknown. */
  readonly spdx: 'MIT' | 'NOASSERTION';
  readonly name: string;
  readonly copyright: string;
  /** Where the license statement can be verified. */
  readonly evidence: string;
  /** Whether Vamp may redistribute the asset in this repository. */
  readonly redistribution: 'not_bundled' | 'bundled';
}

export interface RegistryProvenance {
  readonly author: string;
  readonly upstream: string;
  readonly source: string;
  readonly sourceUrl?: string;
  /** How Vamp selected this preset for the curated ID. */
  readonly mapping: string;
}

export interface RegistryAsset {
  readonly id: string;
  readonly fileName: string;
  readonly format: 'sf2';
  readonly bytes: number;
  readonly checksum: {
    readonly algorithm: 'sha256';
    readonly value: string;
  };
  readonly license: RegistryLicense;
  readonly provenance: RegistryProvenance;
  /** Default size ceiling for project-referenced assets, not the asset size. */
  readonly maxProjectAssetBytes: number;
}

/** Curated mapping used by the FluidSynth sample backend. */
export interface SampleBackendMapping {
  readonly backendId: typeof FLUIDSYNTH_BACKEND_ID;
  /**
   * Song instrument variant this curated ID is rendered as inside the backend's
   * neutral per-track MIDI. `gm` selects a program from the configured GM
   * SoundFont; `soundfont` selects a bank and program from the referenced
   * project asset. Drums always use bank 128 on MIDI channel 9.
   */
  readonly instrumentType: 'gm' | 'soundfont';
  readonly assetId: string;
  readonly program: number;
  readonly bank: number;
  /** MIDI channel used for the neutral per-track render. */
  readonly channel: number;
  /** General MIDI preset name for documentation and diagnostics. */
  readonly presetName: string;
}

export interface InstrumentCapabilities {
  /** True when `builtin-synth-v1` has a dedicated synthesized voice. */
  readonly builtinSynth: boolean;
  /** True when `fluidsynth-sf2-v1` can render this curated ID. */
  readonly fluidSynth: boolean;
  /** True for percussion one-shots on MIDI channel 9. */
  readonly percussion: boolean;
  /** Instrument variants a song may use to request this curated ID. */
  readonly songVariants: readonly ('builtin' | 'gm' | 'soundfont')[];
}

export interface InstrumentRegistryEntry {
  /** Stable registry ID used by `{ "type": "builtin", "id": ... }`. */
  readonly id: string;
  readonly name: string;
  readonly category: 'piano' | 'keys' | 'bass' | 'pad' | 'guitar' | 'drums';
  readonly kind: 'melodic' | 'percussion';
  readonly description: string;
  readonly midiProgram: number;
  readonly midiBank: number;
  readonly midiChannel: number;
  readonly capabilities: InstrumentCapabilities;
  readonly sampleBackend: SampleBackendMapping;
  readonly asset: RegistryAsset;
  readonly license: RegistryLicense;
  readonly provenance: RegistryProvenance;
}

/** FluidR3 GM 3.1 (Debian 3.1-5.3), released under the MIT license by Frank Wen. */
export const FLUIDR3_GM_ASSET: RegistryAsset = Object.freeze({
  id: 'fluidr3-gm',
  fileName: 'FluidR3_GM.sf2',
  format: 'sf2',
  bytes: 148_398_306,
  checksum: Object.freeze({
    algorithm: 'sha256',
    value: '74594e8f4250680adf590507a306655a299935343583256f3b722c48a1bc1cb0',
  }),
  license: Object.freeze({
    spdx: 'MIT',
    name: 'MIT License',
    copyright: 'Copyright (c) 2000-2002, 2008 Frank Wen',
    evidence:
      'Upstream Fluid README and the Debian fluid-soundfont-gm copyright file at /usr/share/doc/fluid-soundfont-gm/copyright.',
    redistribution: 'not_bundled',
  }),
  provenance: Object.freeze({
    author: 'Frank Wen',
    upstream: 'Fluid (R3) General MIDI SoundFont, version 3.1',
    source: 'Debian/Ubuntu package fluid-soundfont-gm 3.1-5.3',
    sourceUrl: 'http://www.musescore.org/download/fluid-soundfont.tar.gz',
    mapping:
      'Vamp does not bundle the SoundFont. Provision it locally and point the sample backend at it; the pinned SHA-256 is checked on request.',
  }),
  maxProjectAssetBytes: 536_870_912,
});

export const REGISTRY_ASSETS: Readonly<Record<string, RegistryAsset>> = Object.freeze({
  [FLUIDR3_GM_ASSET.id]: FLUIDR3_GM_ASSET,
});

function entry(
  input: Omit<InstrumentRegistryEntry, 'asset' | 'license' | 'provenance'> & {
    readonly mappingNote: string;
  },
): InstrumentRegistryEntry {
  const { mappingNote, ...rest } = input;
  const asset = FLUIDR3_GM_ASSET;
  return Object.freeze({
    ...rest,
    asset,
    license: asset.license,
    provenance: Object.freeze({
      ...asset.provenance,
      mapping: mappingNote,
    }),
  });
}

/** The six curated v1 instrument IDs, in stable registry order. */
export const INSTRUMENT_REGISTRY: readonly InstrumentRegistryEntry[] = Object.freeze([
  entry({
    id: 'piano.soft',
    name: 'Soft Piano',
    category: 'piano',
    kind: 'melodic',
    description:
      'Acoustic grand piano with a soft, sustained character for sparse beds and simple melodies.',
    midiProgram: 0,
    midiBank: 0,
    midiChannel: 0,
    capabilities: {
      builtinSynth: true,
      fluidSynth: true,
      percussion: false,
      songVariants: ['builtin', 'gm', 'soundfont'],
    },
    sampleBackend: {
      backendId: FLUIDSYNTH_BACKEND_ID,
      instrumentType: 'gm',
      assetId: FLUIDR3_GM_ASSET.id,
      program: 0,
      bank: 0,
      channel: 0,
      presetName: 'Acoustic Grand Piano',
    },
    mappingNote: 'Curated mapping to GM program 0 (Acoustic Grand Piano), bank 0.',
  }),
  entry({
    id: 'keys.soft',
    name: 'Soft Electric Keys',
    category: 'keys',
    kind: 'melodic',
    description:
      'Electric piano with a gentle attack, useful for lo-fi chords and clean tutorial underscoring.',
    midiProgram: 4,
    midiBank: 0,
    midiChannel: 0,
    capabilities: {
      builtinSynth: true,
      fluidSynth: true,
      percussion: false,
      songVariants: ['builtin', 'gm', 'soundfont'],
    },
    sampleBackend: {
      backendId: FLUIDSYNTH_BACKEND_ID,
      instrumentType: 'gm',
      assetId: FLUIDR3_GM_ASSET.id,
      program: 4,
      bank: 0,
      channel: 0,
      presetName: 'Electric Piano 1',
    },
    mappingNote: 'Curated mapping to GM program 4 (Electric Piano 1), bank 0.',
  }),
  entry({
    id: 'bass.sub',
    name: 'Synth Sub Bass',
    category: 'bass',
    kind: 'melodic',
    description: 'Round synth bass with a solid low fundamental for simple root motion.',
    midiProgram: 38,
    midiBank: 0,
    midiChannel: 0,
    capabilities: {
      builtinSynth: true,
      fluidSynth: true,
      percussion: false,
      songVariants: ['builtin', 'gm', 'soundfont'],
    },
    sampleBackend: {
      backendId: FLUIDSYNTH_BACKEND_ID,
      instrumentType: 'gm',
      assetId: FLUIDR3_GM_ASSET.id,
      program: 38,
      bank: 0,
      channel: 0,
      presetName: 'Synth Bass 1',
    },
    mappingNote: 'Curated mapping to GM program 38 (Synth Bass 1), bank 0.',
  }),
  entry({
    id: 'pad.warm',
    name: 'Warm Pad',
    category: 'pad',
    kind: 'melodic',
    description: 'Soft sustained pad for ambient and focus beds behind narration.',
    midiProgram: 89,
    midiBank: 0,
    midiChannel: 0,
    capabilities: {
      builtinSynth: true,
      fluidSynth: true,
      percussion: false,
      songVariants: ['builtin', 'gm', 'soundfont'],
    },
    sampleBackend: {
      backendId: FLUIDSYNTH_BACKEND_ID,
      instrumentType: 'gm',
      assetId: FLUIDR3_GM_ASSET.id,
      program: 89,
      bank: 0,
      channel: 0,
      presetName: 'Pad 2 (warm)',
    },
    mappingNote: 'Curated mapping to GM program 89 (Pad 2, warm), bank 0.',
  }),
  entry({
    id: 'guitar.clean',
    name: 'Clean Electric Guitar',
    category: 'guitar',
    kind: 'melodic',
    description: 'Clean electric guitar for light rhythmic patterns and simple riffs.',
    midiProgram: 27,
    midiBank: 0,
    midiChannel: 0,
    capabilities: {
      builtinSynth: true,
      fluidSynth: true,
      percussion: false,
      songVariants: ['builtin', 'gm', 'soundfont'],
    },
    sampleBackend: {
      backendId: FLUIDSYNTH_BACKEND_ID,
      instrumentType: 'gm',
      assetId: FLUIDR3_GM_ASSET.id,
      program: 27,
      bank: 0,
      channel: 0,
      presetName: 'Electric Guitar (clean)',
    },
    mappingNote: 'Curated mapping to GM program 27 (Electric Guitar, clean), bank 0.',
  }),
  entry({
    id: 'drums.kit',
    name: 'Studio Drums',
    category: 'drums',
    kind: 'percussion',
    description: 'General MIDI percussion kit played as one-shots on the reserved drum channel.',
    midiProgram: 0,
    midiBank: 128,
    midiChannel: 9,
    capabilities: {
      builtinSynth: true,
      fluidSynth: true,
      percussion: true,
      songVariants: ['builtin', 'soundfont'],
    },
    sampleBackend: {
      backendId: FLUIDSYNTH_BACKEND_ID,
      instrumentType: 'soundfont',
      assetId: FLUIDR3_GM_ASSET.id,
      program: 0,
      bank: 128,
      channel: 9,
      presetName: 'Standard Kit (percussion bank 128)',
    },
    mappingNote: 'Curated mapping to the GM percussion bank 128, program 0, on MIDI channel 9.',
  }),
]);

/** IDs in registry order. Pass to `ValidateSongOptions.builtinInstrumentIds`. */
export const CURATED_INSTRUMENT_IDS: readonly string[] = Object.freeze(
  INSTRUMENT_REGISTRY.map((definition) => definition.id),
);

/** Validation options that reconcile the schema seed allowlist with this registry. */
export const INSTRUMENT_REGISTRY_VALIDATION = Object.freeze({
  builtinInstrumentIds: CURATED_INSTRUMENT_IDS,
});

const registryById: ReadonlyMap<string, InstrumentRegistryEntry> = new Map(
  INSTRUMENT_REGISTRY.map((definition) => [definition.id, definition]),
);

export function getInstrumentRegistryEntry(id: string): InstrumentRegistryEntry | undefined {
  return registryById.get(id);
}

export function isCuratedInstrumentId(id: string): boolean {
  return registryById.has(id);
}

export function getRegistryAsset(id: string): RegistryAsset | undefined {
  return REGISTRY_ASSETS[id];
}

/**
 * Named General MIDI presets exposed to agents alongside the six curated IDs.
 *
 * These are recommendations, not a second schema: each entry carries the exact
 * `{ "type": "gm", "program", "bank" }` object to copy into a song. Any GM
 * program from 0 to 127 validates, but this catalog covers the categories that
 * matter for background music and deliberately omits novelty SFX.
 */
export type GmPresetCategory =
  | 'piano'
  | 'keys'
  | 'organ'
  | 'bass'
  | 'guitar'
  | 'strings'
  | 'pad'
  | 'choir'
  | 'brass'
  | 'woodwind'
  | 'sax'
  | 'mallet'
  | 'lead'
  | 'pluck'
  | 'fx';

export interface GmPreset {
  /** Stable catalog ID for discovery, not a `builtin` song instrument ID. */
  readonly id: string;
  readonly name: string;
  readonly category: GmPresetCategory;
  readonly program: number;
  readonly bank: 0;
  readonly description: string;
  /** Arrangement roles this preset usually serves. */
  readonly roles: readonly ('chords' | 'bass' | 'melody' | 'pad' | 'texture')[];
  /** Exact SongSchemaV1 instrument object. Copy it verbatim. */
  readonly songInstrument: {
    readonly type: 'gm';
    readonly program: number;
    readonly bank: 0;
  };
}

interface GmPresetInput {
  readonly id: string;
  readonly name: string;
  readonly category: GmPresetCategory;
  readonly program: number;
  readonly description: string;
  readonly roles: GmPreset['roles'];
}

function gmPreset(input: GmPresetInput): GmPreset {
  return Object.freeze({
    ...input,
    bank: 0,
    songInstrument: Object.freeze({ type: 'gm', program: input.program, bank: 0 }),
  });
}

export const GM_INSTRUMENT_CATALOG: readonly GmPreset[] = Object.freeze([
  gmPreset({
    id: 'gm.piano.grand',
    name: 'Acoustic Grand Piano',
    category: 'piano',
    program: 0,
    description: 'Full concert grand. The safest BGM harmonic bed and solo piano timbre.',
    roles: ['chords', 'melody'],
  }),
  gmPreset({
    id: 'gm.piano.bright',
    name: 'Bright Acoustic Piano',
    category: 'piano',
    program: 1,
    description: 'Brighter grand. Cuts through a denser tutorial mix without becoming a lead.',
    roles: ['chords', 'melody'],
  }),
  gmPreset({
    id: 'gm.piano.electric-grand',
    name: 'Electric Grand Piano',
    category: 'piano',
    program: 2,
    description: 'Mid-forward electric grand for corporate and explainer beds.',
    roles: ['chords', 'melody'],
  }),
  gmPreset({
    id: 'gm.keys.ep-tine',
    name: 'Tine Electric Piano',
    category: 'keys',
    program: 4,
    description: 'Classic tine e-piano. The default lo-fi and coding-tutorial harmonic voice.',
    roles: ['chords', 'melody'],
  }),
  gmPreset({
    id: 'gm.keys.ep-soft',
    name: 'Soft Electric Piano',
    category: 'keys',
    program: 5,
    description: 'Softer FM-style e-piano with a rounded attack, good under narration.',
    roles: ['chords', 'melody'],
  }),
  gmPreset({
    id: 'gm.keys.clavinet',
    name: 'Clavinet',
    category: 'keys',
    program: 7,
    description: 'Percussive funk keyboard for rhythmic stabs, not sustained beds.',
    roles: ['chords'],
  }),
  gmPreset({
    id: 'gm.keys.harpsichord',
    name: 'Harpsichord',
    category: 'keys',
    program: 6,
    description: 'Plucked keyboard color for baroque or quirky explainer accents.',
    roles: ['chords', 'melody'],
  }),
  gmPreset({
    id: 'gm.organ.drawbar',
    name: 'Drawbar Organ',
    category: 'organ',
    program: 16,
    description: 'Warm drawbar organ for gospel, soul, and soft corporate beds.',
    roles: ['chords', 'pad'],
  }),
  gmPreset({
    id: 'gm.organ.rock',
    name: 'Rock Organ',
    category: 'organ',
    program: 18,
    description: 'Bright organ for energetic explainers and game-release cues.',
    roles: ['chords', 'pad'],
  }),
  gmPreset({
    id: 'gm.organ.church',
    name: 'Church Organ',
    category: 'organ',
    program: 19,
    description: 'Large pipe organ for cinematic or dramatic sections.',
    roles: ['pad', 'chords'],
  }),
  gmPreset({
    id: 'gm.bass.acoustic',
    name: 'Acoustic Bass',
    category: 'bass',
    program: 32,
    description: 'Upright bass for jazz, lo-fi, and organic tutorial beds.',
    roles: ['bass'],
  }),
  gmPreset({
    id: 'gm.bass.finger',
    name: 'Finger Electric Bass',
    category: 'bass',
    program: 33,
    description: 'Round fingerstyle electric bass. A strong default for lo-fi and pop.',
    roles: ['bass'],
  }),
  gmPreset({
    id: 'gm.bass.picked',
    name: 'Picked Electric Bass',
    category: 'bass',
    program: 34,
    description: 'Brighter picked bass for upbeat explainers and corporate cues.',
    roles: ['bass'],
  }),
  gmPreset({
    id: 'gm.bass.fretless',
    name: 'Fretless Bass',
    category: 'bass',
    program: 35,
    description: 'Smooth fretless bass for ambient and neo-soul textures.',
    roles: ['bass'],
  }),
  gmPreset({
    id: 'gm.bass.synth',
    name: 'Synth Bass',
    category: 'bass',
    program: 38,
    description: 'Deep synth sub bass for electronic and lo-fi beds.',
    roles: ['bass'],
  }),
  gmPreset({
    id: 'gm.guitar.nylon',
    name: 'Nylon Guitar',
    category: 'guitar',
    program: 24,
    description: 'Soft classical guitar for warm, acoustic tutorial underscoring.',
    roles: ['chords', 'melody'],
  }),
  gmPreset({
    id: 'gm.guitar.steel',
    name: 'Steel Guitar',
    category: 'guitar',
    program: 25,
    description: 'Acoustic steel-string guitar for folk and upbeat explainers.',
    roles: ['chords', 'melody'],
  }),
  gmPreset({
    id: 'gm.guitar.jazz',
    name: 'Jazz Electric Guitar',
    category: 'guitar',
    program: 26,
    description: 'Mellow hollow-body guitar for lo-fi and jazzy beds.',
    roles: ['chords', 'melody'],
  }),
  gmPreset({
    id: 'gm.guitar.muted',
    name: 'Muted Electric Guitar',
    category: 'guitar',
    program: 28,
    description: 'Tight muted guitar for rhythmic chucks under a clean mix.',
    roles: ['chords'],
  }),
  gmPreset({
    id: 'gm.guitar.overdrive',
    name: 'Overdriven Guitar',
    category: 'guitar',
    program: 29,
    description: 'Light overdrive for game trailers and energetic sections. Use sparingly.',
    roles: ['chords', 'melody'],
  }),
  gmPreset({
    id: 'gm.strings.violin',
    name: 'Violin',
    category: 'strings',
    program: 40,
    description: 'Solo violin for emotional lines, not dense beds.',
    roles: ['melody'],
  }),
  gmPreset({
    id: 'gm.strings.cello',
    name: 'Cello',
    category: 'strings',
    program: 42,
    description: 'Low solo strings for cinematic tension and warm bass-register melody.',
    roles: ['melody', 'texture'],
  }),
  gmPreset({
    id: 'gm.strings.ensemble',
    name: 'String Ensemble',
    category: 'strings',
    program: 48,
    description: 'Full string section. A reliable pad for corporate and documentary beds.',
    roles: ['pad', 'chords'],
  }),
  gmPreset({
    id: 'gm.strings.tremolo',
    name: 'Tremolo Strings',
    category: 'strings',
    program: 44,
    description: 'Tremolo strings for suspense and tension stingers.',
    roles: ['texture'],
  }),
  gmPreset({
    id: 'gm.strings.pizzicato',
    name: 'Pizzicato Strings',
    category: 'strings',
    program: 45,
    description: 'Plucked strings for playful, curious explainer passages.',
    roles: ['melody', 'texture'],
  }),
  gmPreset({
    id: 'gm.strings.harp',
    name: 'Harp',
    category: 'strings',
    program: 46,
    description: 'Harp arpeggios for transitions, intro sparkle, and gentle endings.',
    roles: ['melody', 'texture'],
  }),
  gmPreset({
    id: 'gm.pad.new-age',
    name: 'New Age Pad',
    category: 'pad',
    program: 88,
    description: 'Smooth evolving pad for ambient focus and calm explainers.',
    roles: ['pad'],
  }),
  gmPreset({
    id: 'gm.pad.polysynth',
    name: 'Poly Synth Pad',
    category: 'pad',
    program: 90,
    description: 'Classic poly pad for lo-fi and electronic beds. Low-pass it.',
    roles: ['pad', 'chords'],
  }),
  gmPreset({
    id: 'gm.pad.choir',
    name: 'Synth Choir Pad',
    category: 'pad',
    program: 91,
    description: 'Vocal-like pad for cinematic and ambient cues. Softer than a real choir.',
    roles: ['pad'],
  }),
  gmPreset({
    id: 'gm.choir.aahs',
    name: 'Choir Aahs',
    category: 'choir',
    program: 52,
    description: 'Human choir for uplifting or cinematic sections. Use low in the mix.',
    roles: ['pad', 'texture'],
  }),
  gmPreset({
    id: 'gm.pad.halo',
    name: 'Halo Pad',
    category: 'pad',
    program: 94,
    description: 'Airy halo pad for ambient and focus beds.',
    roles: ['pad'],
  }),
  gmPreset({
    id: 'gm.pad.atmosphere',
    name: 'Atmosphere',
    category: 'pad',
    program: 99,
    description: 'Slow atmospheric texture for intros and transitions, not full beds.',
    roles: ['texture'],
  }),
  gmPreset({
    id: 'gm.brass.trumpet',
    name: 'Trumpet',
    category: 'brass',
    program: 56,
    description: 'Solo trumpet for confident accents and short stabs.',
    roles: ['melody'],
  }),
  gmPreset({
    id: 'gm.brass.horn',
    name: 'French Horn',
    category: 'brass',
    program: 60,
    description: 'Warm horn for cinematic swells and soft fanfares.',
    roles: ['melody', 'pad'],
  }),
  gmPreset({
    id: 'gm.brass.section',
    name: 'Brass Section',
    category: 'brass',
    program: 61,
    description: 'Full brass section for emphatic transitions and stingers.',
    roles: ['chords', 'pad'],
  }),
  gmPreset({
    id: 'gm.woodwind.flute',
    name: 'Flute',
    category: 'woodwind',
    program: 73,
    description: 'Clean flute for light, optimistic melodies.',
    roles: ['melody'],
  }),
  gmPreset({
    id: 'gm.woodwind.clarinet',
    name: 'Clarinet',
    category: 'woodwind',
    program: 71,
    description: 'Warm clarinet for playful or thoughtful melodies.',
    roles: ['melody'],
  }),
  gmPreset({
    id: 'gm.woodwind.oboe',
    name: 'Oboe',
    category: 'woodwind',
    program: 68,
    description: 'Reedy oboe for pastoral and documentary color.',
    roles: ['melody'],
  }),
  gmPreset({
    id: 'gm.woodwind.bassoon',
    name: 'Bassoon',
    category: 'woodwind',
    program: 70,
    description: 'Low reedy bassoon for playful or mysterious bass lines.',
    roles: ['melody', 'bass'],
  }),
  gmPreset({
    id: 'gm.sax.alto',
    name: 'Alto Sax',
    category: 'sax',
    program: 65,
    description: 'Smooth alto sax for jazz and lo-fi accents.',
    roles: ['melody'],
  }),
  gmPreset({
    id: 'gm.sax.tenor',
    name: 'Tenor Sax',
    category: 'sax',
    program: 66,
    description: 'Breathy tenor sax for mature, warm underscore.',
    roles: ['melody'],
  }),
  gmPreset({
    id: 'gm.mallet.vibraphone',
    name: 'Vibraphone',
    category: 'mallet',
    program: 11,
    description: 'Soft mallets for lo-fi melodies and dreamy chords.',
    roles: ['melody', 'chords'],
  }),
  gmPreset({
    id: 'gm.mallet.marimba',
    name: 'Marimba',
    category: 'mallet',
    program: 12,
    description: 'Woody mallets for friendly explainer melodies.',
    roles: ['melody', 'chords'],
  }),
  gmPreset({
    id: 'gm.mallet.kalimba',
    name: 'Kalimba',
    category: 'mallet',
    program: 108,
    description: 'Tiny thumb piano for intimate, minimal tutorial beds.',
    roles: ['melody'],
  }),
  gmPreset({
    id: 'gm.mallet.steel-drums',
    name: 'Steel Drums',
    category: 'mallet',
    program: 114,
    description: 'Bright steel drums for playful island-flavored cues.',
    roles: ['melody'],
  }),
  gmPreset({
    id: 'gm.lead.saw',
    name: 'Saw Lead',
    category: 'lead',
    program: 81,
    description: 'Classic saw lead. Reserve for game and electronic accents, never default BGM.',
    roles: ['melody'],
  }),
  gmPreset({
    id: 'gm.lead.voice',
    name: 'Voice Lead',
    category: 'lead',
    program: 85,
    description: 'Soft vocal-formant lead for ambient and electronic hooks.',
    roles: ['melody'],
  }),
  gmPreset({
    id: 'gm.lead.fifths',
    name: 'Fifths Lead',
    category: 'lead',
    program: 86,
    description: 'Stacked fifth lead for wide, confident game and trailer lines.',
    roles: ['melody'],
  }),
  gmPreset({
    id: 'gm.pluck.sitar',
    name: 'Sitar',
    category: 'pluck',
    program: 104,
    description: 'Buzzy plucked color for travel and culture segments.',
    roles: ['melody'],
  }),
  gmPreset({
    id: 'gm.pluck.koto',
    name: 'Koto',
    category: 'pluck',
    program: 107,
    description: 'Delicate plucked string for calm, precise accents.',
    roles: ['melody'],
  }),
  gmPreset({
    id: 'gm.pluck.banjo',
    name: 'Banjo',
    category: 'pluck',
    program: 105,
    description: 'Bright banjo for upbeat, folksy explainer moments.',
    roles: ['melody', 'chords'],
  }),
  gmPreset({
    id: 'gm.pluck.fiddle',
    name: 'Fiddle',
    category: 'pluck',
    program: 110,
    description: 'Folk fiddle for lively, rustic cues.',
    roles: ['melody'],
  }),
  gmPreset({
    id: 'gm.fx.rain',
    name: 'Rain',
    category: 'fx',
    program: 96,
    description: 'Rain texture for lo-fi and focus beds. Keep it quiet and sparse.',
    roles: ['texture'],
  }),
  gmPreset({
    id: 'gm.fx.soundtrack',
    name: 'Soundtrack',
    category: 'fx',
    program: 97,
    description: 'Suspense texture for transitions and dramatic reveals.',
    roles: ['texture'],
  }),
  gmPreset({
    id: 'gm.fx.crystal',
    name: 'Crystal',
    category: 'fx',
    program: 98,
    description: 'Glassy bell texture for magical or product-reveal moments.',
    roles: ['texture', 'melody'],
  }),
  gmPreset({
    id: 'gm.fx.bowed',
    name: 'Bowed Glass',
    category: 'fx',
    program: 92,
    description: 'Bowed glass texture for ambient tension and slow builds.',
    roles: ['texture'],
  }),
]);

const gmPresetById: ReadonlyMap<string, GmPreset> = new Map(
  GM_INSTRUMENT_CATALOG.map((preset) => [preset.id, preset]),
);

export function getGmPreset(id: string): GmPreset | undefined {
  return gmPresetById.get(id);
}

export function findGmPresetByProgram(program: number): GmPreset | undefined {
  return GM_INSTRUMENT_CATALOG.find((preset) => preset.program === program);
}

/** Common GM percussion keys with readable aliases for agent-authored grooves. */
export const GM_DRUM_NOTE_MAP = Object.freeze({
  kick: 36,
  kickSoft: 35,
  sideStick: 37,
  snare: 38,
  clap: 39,
  snareElectric: 40,
  tomFloorLow: 41,
  tomFloorHigh: 43,
  tomLow: 45,
  tomLowMid: 47,
  tomHiMid: 48,
  tomHigh: 50,
  hatClosed: 42,
  hatPedal: 44,
  hatOpen: 46,
  crash: 49,
  crash2: 57,
  splash: 55,
  ride: 51,
  rideBell: 53,
  tambourine: 54,
  cowbell: 56,
  cabasa: 69,
  shaker: 70,
  claves: 75,
  woodblockHigh: 76,
  woodblockLow: 77,
  bongoHigh: 60,
  bongoLow: 61,
  congaMute: 62,
  congaOpen: 63,
  congaLow: 64,
  triangleOpen: 81,
} as const);

export type GmDrumAlias = keyof typeof GM_DRUM_NOTE_MAP;

/** The standard GM percussion kit, playable through the curated `drums.kit` ID. */
export const GM_STANDARD_DRUM_KIT = Object.freeze({
  id: 'drums.kit',
  name: 'GM Standard Kit',
  program: 0,
  bank: 128,
  channel: 9,
  songInstrument: Object.freeze({ type: 'builtin', id: 'drums.kit' }),
  noteMap: GM_DRUM_NOTE_MAP,
  notes: BUILTIN_DRUM_MAP,
});

export type GmStandardDrumKit = typeof GM_STANDARD_DRUM_KIT;

/** JSON-serializable registry description for `list_instruments` and docs. */
export interface InstrumentRegistryDescription {
  readonly registryVersion: typeof INSTRUMENT_REGISTRY_VERSION;
  readonly sampleBackendId: typeof FLUIDSYNTH_BACKEND_ID;
  readonly sampleBackendInstrumentTypes: readonly InstrumentVariantType[];
  readonly assets: readonly RegistryAsset[];
  readonly instruments: readonly InstrumentRegistryEntry[];
}

export function describeInstrumentRegistry(): InstrumentRegistryDescription {
  return {
    registryVersion: INSTRUMENT_REGISTRY_VERSION,
    sampleBackendId: FLUIDSYNTH_BACKEND_ID,
    sampleBackendInstrumentTypes: SAMPLE_BACKEND_INSTRUMENT_TYPES,
    assets: Object.values(REGISTRY_ASSETS),
    instruments: INSTRUMENT_REGISTRY,
  };
}
