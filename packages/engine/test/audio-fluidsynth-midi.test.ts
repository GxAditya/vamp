import { readFileSync } from 'node:fs';

import { parseMidi, type MidiEvent } from 'midi-file';
import { describe, expect, it } from 'vitest';

import { validateSong, type SongSchemaV1 } from '@gxaditya/vamp-schema';

import {
  CURATED_INSTRUMENT_IDS,
  FLUIDR3_GM_ASSET,
  INSTRUMENT_REGISTRY,
  INSTRUMENT_REGISTRY_VALIDATION,
  MIDI_BANK_SELECT_LSB,
  MIDI_BANK_SELECT_MSB,
  MIDI_PAN_CONTROLLER,
  MIDI_VOLUME_CONTROLLER,
  MIDI_PPQ,
  buildFluidSynthArguments,
  describeInstrumentRegistry,
  exportMidi,
  getInstrumentRegistryEntry,
  prepareFluidSynthTrack,
  type AudioBackendTrackStats,
  type FluidSynthMidiSelection,
} from '../src/index.js';
import { baseSong, clipNote, clipTrack, compileOk } from './helpers.js';

interface TimedEvent {
  readonly tick: number;
  readonly event: MidiEvent;
}

function timed(track: MidiEvent[]): TimedEvent[] {
  let tick = 0;
  return track.map((event) => {
    tick += event.deltaTime;
    return { tick, event };
  });
}

function parse(bytes: Uint8Array) {
  const parsed = parseMidi(bytes);
  return parsed.tracks.map((track) => timed(track));
}

function requestFor(song: SongSchemaV1, maxVoices = 32) {
  const timeline = compileOk(song, { sampleRate: 48000 }).timeline;
  const track = timeline.tracks[0];
  if (track === undefined) {
    throw new Error('expected one track');
  }
  return {
    timeline,
    request: {
      track,
      events: timeline.events.filter((event) => event.trackIndex === 0),
      sampleRate: timeline.sampleRate,
      frameCount: timeline.renderedSamples,
      seed: timeline.meta.seed,
      maxVoices,
      bpm: timeline.meta.bpm,
    },
  };
}

function songForInstrument(instrument: SongSchemaV1['tracks'][number]['instrument']): SongSchemaV1 {
  const drums = instrument.type === 'builtin' && instrument.id === 'drums.kit';
  return baseSong({
    durationHint: 1,
    tracks: [
      clipTrack('track', [clipNote(drums ? 36 : 60, 0, drums ? 0.25 : 1, 100)], {
        kind: drums ? 'drums' : 'midi',
        channel: drums ? 9 : 0,
        instrument,
      }),
    ],
  });
}

function selectionFromRegistry(id: string): FluidSynthMidiSelection {
  const entry = getInstrumentRegistryEntry(id);
  if (entry === undefined) {
    throw new Error(`missing registry entry ${id}`);
  }
  return {
    instrumentType: entry.sampleBackend.instrumentType,
    program: entry.sampleBackend.program,
    bank: entry.sampleBackend.bank,
    channel: entry.kind === 'percussion' ? 9 : 0,
  };
}

function noteOns(events: readonly TimedEvent[]): TimedEvent[] {
  return events.filter((entry) => (entry.event as { type?: string }).type === 'noteOn');
}

describe('curated instrument registry', () => {
  it('has the six stable IDs in registry order and matches the schema seed set', () => {
    expect(CURATED_INSTRUMENT_IDS).toEqual([
      'piano.soft',
      'keys.soft',
      'bass.sub',
      'pad.warm',
      'guitar.clean',
      'drums.kit',
    ]);
    expect(new Set(CURATED_INSTRUMENT_IDS).size).toBe(CURATED_INSTRUMENT_IDS.length);
    expect(INSTRUMENT_REGISTRY_VALIDATION.builtinInstrumentIds).toEqual(CURATED_INSTRUMENT_IDS);
    expect(INSTRUMENT_REGISTRY.map((entry) => entry.id)).toEqual(CURATED_INSTRUMENT_IDS);
  });

  it('documents the curated GM mappings explicitly', () => {
    const byId = new Map(INSTRUMENT_REGISTRY.map((entry) => [entry.id, entry]));
    expect(byId.get('piano.soft')).toMatchObject({
      midiProgram: 0,
      midiBank: 0,
      sampleBackend: { program: 0, bank: 0, presetName: 'Acoustic Grand Piano' },
    });
    expect(byId.get('keys.soft')).toMatchObject({ midiProgram: 4, midiBank: 0 });
    expect(byId.get('bass.sub')).toMatchObject({ midiProgram: 38, midiBank: 0 });
    expect(byId.get('pad.warm')).toMatchObject({ midiProgram: 89, midiBank: 0 });
    expect(byId.get('guitar.clean')).toMatchObject({ midiProgram: 27, midiBank: 0 });
    expect(byId.get('drums.kit')).toMatchObject({
      midiProgram: 0,
      midiBank: 128,
      midiChannel: 9,
      kind: 'percussion',
      sampleBackend: {
        instrumentType: 'soundfont',
        program: 0,
        bank: 128,
        channel: 9,
      },
    });
  });

  it('pins FluidR3 GM provenance, MIT license, size, and checksum on every entry', () => {
    expect(FLUIDR3_GM_ASSET.checksum).toEqual({
      algorithm: 'sha256',
      value: '74594e8f4250680adf590507a306655a299935343583256f3b722c48a1bc1cb0',
    });
    expect(FLUIDR3_GM_ASSET.bytes).toBe(148_398_306);
    expect(FLUIDR3_GM_ASSET.license.spdx).toBe('MIT');
    expect(FLUIDR3_GM_ASSET.license.copyright).toContain('Frank Wen');
    expect(FLUIDR3_GM_ASSET.license.redistribution).toBe('not_bundled');
    expect(FLUIDR3_GM_ASSET.provenance.author).toBe('Frank Wen');
    for (const entry of INSTRUMENT_REGISTRY) {
      expect(entry.asset).toBe(FLUIDR3_GM_ASSET);
      expect(entry.license).toBe(FLUIDR3_GM_ASSET.license);
      expect(entry.provenance.mapping.length).toBeGreaterThan(10);
      expect(entry.sampleBackend.assetId).toBe(FLUIDR3_GM_ASSET.id);
    }
  });

  it('reconciles the schema validation allowlist through the exported override', () => {
    const song = baseSong({
      durationHint: 1,
      tracks: [
        clipTrack('keys', [clipNote(60, 0, 1, 100)], {
          instrument: { type: 'builtin', id: 'keys.soft' },
        }),
      ],
    });
    expect(validateSong(song).ok).toBe(true);
    expect(validateSong(song, INSTRUMENT_REGISTRY_VALIDATION).ok).toBe(true);
  });

  it('describes itself as JSON and excludes SFZ from the sample backend', () => {
    const described = describeInstrumentRegistry();
    expect(JSON.parse(JSON.stringify(described))).toEqual(described);
    expect(described.sampleBackendInstrumentTypes).toEqual(['builtin', 'gm', 'soundfont']);
    expect(described.sampleBackendInstrumentTypes).not.toContain('sfz');
  });
});

describe('neutral per-track MIDI for the sample backend', () => {
  it('emits each curated program and bank on the expected channel without mix controllers', () => {
    for (const id of CURATED_INSTRUMENT_IDS) {
      const entry = getInstrumentRegistryEntry(id);
      if (entry === undefined) {
        throw new Error(`missing ${id}`);
      }
      const drums = entry.kind === 'percussion';
      const { request } = requestFor(
        songForInstrument({ type: 'builtin', id: id as 'piano.soft' }),
      );
      const prepared = prepareFluidSynthTrack(request, selectionFromRegistry(id));
      expect(prepared.ok, id).toBe(true);
      if (!prepared.ok) {
        continue;
      }

      expect(prepared.prepared.report.includeMixControllers).toBe(false);
      const tracks = parse(prepared.prepared.midi);
      expect(tracks).toHaveLength(2);
      const events = tracks[1] ?? [];
      const channel = drums ? 9 : 0;

      const controls = events.filter((entry) => entry.event.type === 'controller');
      expect(
        controls.filter(
          (entry) =>
            entry.event.type === 'controller' &&
            (entry.event.controllerType === MIDI_VOLUME_CONTROLLER ||
              entry.event.controllerType === MIDI_PAN_CONTROLLER),
        ),
        `${id} must not emit CC7 or CC10`,
      ).toEqual([]);

      if (drums) {
        const bankMsb = events.find(
          (entry) =>
            entry.event.type === 'controller' &&
            entry.event.controllerType === MIDI_BANK_SELECT_MSB,
        );
        const bankLsb = events.find(
          (entry) =>
            entry.event.type === 'controller' &&
            entry.event.controllerType === MIDI_BANK_SELECT_LSB,
        );
        expect(bankMsb?.event).toMatchObject({ value: 1 });
        expect(bankLsb?.event).toMatchObject({ value: 0 });
      }

      const program = events.find((entry) => entry.event.type === 'programChange');
      expect(program?.event).toMatchObject({
        programNumber: entry.midiProgram,
        channel,
      });
      const firstNote = noteOns(events)[0];
      expect(firstNote?.event).toMatchObject({ noteNumber: drums ? 36 : 60, channel });
      expect(firstNote?.tick).toBe(0);
    }
  });

  it('maps explicit gm and soundfont instrument references', () => {
    const gmSong = songForInstrument({ type: 'gm', program: 40, bank: 3 });
    const gm = prepareFluidSynthTrack(requestFor(gmSong).request, {
      instrumentType: 'gm',
      program: 40,
      bank: 3,
      channel: 0,
    });
    expect(gm.ok).toBe(true);
    if (gm.ok) {
      const events = parse(gm.prepared.midi)[1] ?? [];
      expect(
        events.find(
          (entry) =>
            entry.event.type === 'controller' &&
            entry.event.controllerType === MIDI_BANK_SELECT_MSB,
        )?.event,
      ).toMatchObject({ value: 0 });
      expect(
        events.find(
          (entry) =>
            entry.event.type === 'controller' &&
            entry.event.controllerType === MIDI_BANK_SELECT_LSB,
        )?.event,
      ).toMatchObject({ value: 3 });
      expect(events.find((entry) => entry.event.type === 'programChange')?.event).toMatchObject({
        programNumber: 40,
      });
    }

    const sfSong = songForInstrument({
      type: 'soundfont',
      path: 'assets/piano.sf2',
      program: 12,
      bank: 5,
    });
    const sf = prepareFluidSynthTrack(requestFor(sfSong).request, {
      instrumentType: 'soundfont',
      program: 12,
      bank: 5,
      channel: 0,
    });
    expect(sf.ok).toBe(true);
    if (sf.ok) {
      const events = parse(sf.prepared.midi)[1] ?? [];
      expect(events.find((entry) => entry.event.type === 'programChange')?.event).toMatchObject({
        programNumber: 12,
      });
    }
  });

  it('quantizes event timing at the shared 960 PPQ without changing tempo', () => {
    const { request } = requestFor(
      baseSong({
        bpm: 90,
        durationHint: 2,
        tracks: [
          clipTrack('keys', [clipNote(60, 0.5, 0.5, 100)], {
            instrument: { type: 'builtin', id: 'keys.soft' },
          }),
        ],
      }),
    );
    const prepared = prepareFluidSynthTrack(request, selectionFromRegistry('keys.soft'));
    expect(prepared.ok).toBe(true);
    if (prepared.ok) {
      expect(prepared.prepared.report.tempo.microsecondsPerQuarter).toBe(666_667);
      expect(prepared.prepared.report.ppq).toBe(MIDI_PPQ);
      const events = parse(prepared.prepared.midi)[1] ?? [];
      const noteOn = noteOns(events)[0];
      // 0.5 quarter notes at 960 PPQ.
      expect(noteOn?.tick).toBe(480);
    }
  });

  it('drops newest note starts deterministically at the voice cap', () => {
    const notes = [60, 62, 64, 65, 67, 69, 71, 72].map((pitch) => clipNote(pitch, 0, 2, 100));
    const { request } = requestFor(
      baseSong({
        durationHint: 2,
        tracks: [clipTrack('chord', notes, { instrument: { type: 'builtin', id: 'keys.soft' } })],
      }),
      3,
    );
    const prepared = prepareFluidSynthTrack(request, selectionFromRegistry('keys.soft'));
    expect(prepared.ok).toBe(true);
    if (prepared.ok) {
      expect(prepared.prepared.stats).toEqual<AudioBackendTrackStats>({
        startedVoices: 3,
        droppedVoices: 5,
        stolenVoices: 0,
        peakActiveVoices: 3,
      });
      expect(noteOns(parse(prepared.prepared.midi)[1] ?? [])).toHaveLength(3);
    }
  });

  it('rejects SFZ honestly instead of substituting an instrument', async () => {
    const { request } = requestFor(songForInstrument({ type: 'sfz', path: 'assets/flute.sfz' }));
    const { createFluidSynthBackend } = await import('../src/index.js');
    const backend = createFluidSynthBackend();
    expect(backend.capabilities.instrumentTypes).toEqual(['builtin', 'gm', 'soundfont']);
    const result = await backend.renderTrack(request);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toMatchObject({
        code: 'audio.instrument.unsupported_variant',
        path: '/tracks/0/instrument',
        params: { variant: 'sfz' },
      });
      expect(result.errors[0]?.hint).toContain('SFZ');
    }
  });
});

describe('exportMidi omitMixControllers option', () => {
  it('omits static CC7 and CC10 but keeps note and program selection', () => {
    const timeline = compileOk(
      baseSong({
        durationHint: 1,
        tracks: [
          clipTrack('keys', [clipNote(60, 0, 1, 100)], {
            instrument: { type: 'gm', program: 0, bank: 0 },
            volume: 0.5,
            pan: -1,
          }),
        ],
      }),
      { sampleRate: 48000 },
    ).timeline;

    const withMix = exportMidi(timeline);
    const withoutMix = exportMidi(timeline, { omitMixControllers: true });
    expect(withMix.ok && withoutMix.ok).toBe(true);
    if (!withMix.ok || !withoutMix.ok) {
      return;
    }
    const mixTracks = parse(withMix.bytes);
    const neutralTracks = parse(withoutMix.bytes);
    const mixControllers = (mixTracks[1] ?? []).filter(
      (entry) => entry.event.type === 'controller',
    );
    const neutralControllers = (neutralTracks[1] ?? []).filter(
      (entry) => entry.event.type === 'controller',
    );
    expect(mixControllers.length).toBeGreaterThan(0);
    expect(neutralControllers).toEqual([]);
    expect(withMix.report.includeMixControllers).toBe(true);
    expect(withoutMix.report.includeMixControllers).toBe(false);
    expect(noteOns(neutralTracks[1] ?? [])).toHaveLength(1);
  });
});

describe('sample backend network independence', () => {
  it('contains no network import, fetch call, or render-time download', () => {
    const source = readFileSync(new URL('../src/audio/fluidsynth.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/node:(https?|net|dns|tls)/);
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/\bdownload\w*\s*\(/i);
    const assets = readFileSync(new URL('../src/audio/assets.ts', import.meta.url), 'utf8');
    expect(assets).not.toMatch(/node:(https?|net|dns|tls)/);
    expect(assets).not.toMatch(/\bfetch\s*\(/);
  });
});

describe('FluidSynth command line', () => {
  it('uses offline fast rendering with no shell, audio driver, reverb, or chorus', () => {
    const args = buildFluidSynthArguments({
      wavPath: '/tmp/out file.wav',
      sampleRate: 48000,
      maxVoices: 12,
      soundFontPath: '/sounds/FluidR3 GM.sf2',
      midiPath: '/tmp/track.mid',
    });
    expect(args).toContain('-ni');
    expect(args).toContain('-F');
    expect(args).toContain('/tmp/out file.wav');
    expect(args).toContain('-r');
    expect(args).toContain('48000');
    expect(args).toContain('-g');
    expect(args).toContain('1.0');
    expect(args).toContain('synth.reverb.active=0');
    expect(args).toContain('synth.chorus.active=0');
    expect(args).toContain('synth.polyphony=12');
    expect(args).not.toContain('-a');
    expect(args).not.toContain('--audio-driver');
    expect(args.slice(-2)).toEqual(['/sounds/FluidR3 GM.sf2', '/tmp/track.mid']);
    expect(args.every((entry) => typeof entry === 'string')).toBe(true);
  });
});
