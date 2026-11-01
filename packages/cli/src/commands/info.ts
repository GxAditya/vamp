/**
 * `vamp info <file>`: inspect a JSON song file. This command never renders or
 * inspects audio. It reports validated metadata, duration hints, counts, and a
 * track and instrument summary.
 */

import { compileValidatedSong, getBeatsPerBar } from '@gxaditya/vamp-engine';
import { estimateRenderedDuration, type Instrument, type Track } from '@gxaditya/vamp-schema';

import { parseArgs } from '../args.js';
import { countSong, loadSongFile, type SongCounts } from '../files.js';
import { commandHelp } from '../help.js';
import {
  failure,
  formatError,
  formatWarnings,
  success,
  usageFailure,
  type CliError,
  type CommandOutcome,
  type StructuredValue,
} from '../output.js';

export interface InstrumentSummary {
  readonly type: 'builtin' | 'gm' | 'soundfont' | 'sfz';
  readonly label: string;
  readonly id?: string;
  readonly program?: number;
  readonly bank?: number;
  readonly path?: string;
}

export interface InstrumentGroup extends InstrumentSummary {
  readonly trackIds: readonly string[];
}

export interface InfoTrack {
  readonly id: string;
  readonly name: string;
  readonly kind: 'midi' | 'drums';
  readonly channel: number;
  readonly instrument: InstrumentSummary;
  readonly volume: number;
  readonly pan: number;
  readonly mute: boolean;
  readonly solo: boolean;
  readonly freeNotes: number;
  readonly placements: number;
  readonly effects: number;
}

export interface InfoCounts extends SongCounts {
  readonly expandedEvents: number;
  readonly warnings: number;
}

export interface InfoData {
  readonly file: string;
  readonly resolvedPath: string;
  readonly schemaVersion: string;
  readonly title: string;
  readonly bpm: number;
  readonly timeSignature: {
    readonly numerator: number;
    readonly denominator: number;
  };
  readonly key: {
    readonly tonic: string;
    readonly mode: string;
  };
  readonly seed: number;
  readonly durationHint: {
    readonly beats: number;
    readonly bars: number;
    readonly seconds: number;
  };
  readonly duration: {
    readonly hintSeconds: number;
    readonly lastSoundSeconds: number;
    readonly estimatedRenderedSeconds: number;
  };
  readonly counts: InfoCounts;
  readonly tracks: readonly InfoTrack[];
  readonly instruments: readonly InstrumentGroup[];
}

function instrumentSummary(instrument: Instrument): InstrumentSummary {
  switch (instrument.type) {
    case 'builtin':
      return { type: 'builtin', id: instrument.id, label: `builtin:${instrument.id}` };
    case 'gm': {
      const bank = instrument.bank ?? 0;
      return {
        type: 'gm',
        program: instrument.program,
        bank,
        label: `gm:${instrument.program}/${bank}`,
      };
    }
    case 'soundfont': {
      const bank = instrument.bank ?? 0;
      return {
        type: 'soundfont',
        path: instrument.path,
        program: instrument.program,
        bank,
        label: `soundfont:${instrument.path}#${instrument.program}/${bank}`,
      };
    }
    case 'sfz':
      return { type: 'sfz', path: instrument.path, label: `sfz:${instrument.path}` };
    default:
      return { type: 'builtin', label: 'builtin:unknown' };
  }
}

function trackInfo(track: Track): InfoTrack {
  return {
    id: track.id,
    name: track.name,
    kind: track.kind,
    channel: track.channel,
    instrument: instrumentSummary(track.instrument),
    volume: track.volume ?? 1,
    pan: track.pan ?? 0,
    mute: track.mute ?? false,
    solo: track.solo ?? false,
    freeNotes: track.notes?.length ?? 0,
    placements: track.placements?.length ?? 0,
    effects: track.effects?.length ?? 0,
  };
}

function groupInstruments(tracks: readonly Track[]): InstrumentGroup[] {
  const groups = new Map<string, InstrumentGroup>();
  for (const track of tracks) {
    const summary = instrumentSummary(track.instrument);
    const key = JSON.stringify(track.instrument);
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, { ...summary, trackIds: [track.id] });
    } else {
      groups.set(key, { ...existing, trackIds: [...existing.trackIds, track.id] });
    }
  }
  return [...groups.values()];
}

function formatNumber(value: number, digits = 3): string {
  if (Number.isInteger(value)) {
    return String(value);
  }
  return value.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '');
}

function humanResult(data: InfoData, warningsText: string): string {
  const tracks = data.tracks.map((track) => {
    return `  - ${track.id} "${track.name}" (${track.kind}, channel ${track.channel}): ${track.instrument.label}; notes free=${track.freeNotes} placements=${track.placements} effects=${track.effects}; volume=${formatNumber(track.volume)} pan=${formatNumber(track.pan)} mute=${String(track.mute)} solo=${String(track.solo)}`;
  });
  const instruments = data.instruments.map((group) => {
    return `  - ${group.label}: ${group.trackIds.join(', ')}`;
  });
  return [
    'Song information',
    `File: ${data.resolvedPath}`,
    `Title: ${data.title}`,
    `Schema version: ${data.schemaVersion}`,
    `Tempo: ${data.bpm} BPM`,
    `Time signature: ${data.timeSignature.numerator}/${data.timeSignature.denominator}`,
    `Key: ${data.key.tonic} ${data.key.mode}`,
    `Seed: ${data.seed}`,
    `Duration hint: ${formatNumber(data.durationHint.beats)} beats (${formatNumber(data.durationHint.bars)} bars, ${formatNumber(data.durationHint.seconds)} s)`,
    `Estimated render duration: ${formatNumber(data.duration.estimatedRenderedSeconds)} s`,
    `Counts: ${data.counts.tracks} tracks, ${data.counts.patterns} patterns, ${data.counts.placements} placements, ${data.counts.freeNotes} free notes, ${data.counts.patternNotes} pattern notes, ${data.counts.authoredNotes} authored notes, ${data.counts.expandedEvents} expanded events, ${data.counts.warnings} warnings`,
    'Tracks:',
    ...tracks,
    'Instruments:',
    ...instruments,
    warningsText,
  ].join('\n');
}

export async function runInfo(args: readonly string[]): Promise<CommandOutcome<InfoData>> {
  const parsed = parseArgs('info', args);
  if (!parsed.ok) {
    return usageFailure('info', {
      code: parsed.error.code,
      message: parsed.error.message,
      hint: parsed.error.hint,
    });
  }
  if (parsed.value.help) {
    return { kind: 'text', text: commandHelp('info') ?? '' };
  }
  if (parsed.value.positionals.length === 0) {
    return usageFailure('info', {
      code: 'cli.usage.missing_argument',
      message: 'missing required argument <file>',
      hint: 'Pass one JSON song file. Run "vamp info --help" for details.',
    });
  }
  if (parsed.value.positionals.length > 1) {
    return usageFailure('info', {
      code: 'cli.usage.unexpected_argument',
      message: `unexpected argument "${parsed.value.positionals[1] ?? ''}"`,
      hint: 'Pass exactly one file. Run "vamp info --help" for details.',
    });
  }

  const file = parsed.value.positionals[0] ?? '';
  const loaded = await loadSongFile(file);
  if (!loaded.ok) {
    return failure(loaded.error, formatError('info', loaded.error), {
      warnings: loaded.warnings,
    });
  }

  const validation = loaded.value.validation;
  const song = validation.song;
  const compiled = compileValidatedSong(validation, { sampleRate: 48_000 });
  if (!compiled.ok) {
    const first = compiled.errors[0];
    const details: Record<string, StructuredValue> = { stage: compiled.stage };
    if (first !== undefined) {
      details.issueCode = first.code;
      details.issuePath = first.path;
      details.issueMessage = first.message;
    }
    const structured: CliError = {
      code: 'cli.info.compile_failed',
      message: `The validated song could not be compiled for event counts.`,
      hint: 'This usually means a shared compile limit was tightened. Run "vamp validate" and retry.',
      path: file,
      details,
    };
    return failure(structured, formatError('info', structured), {
      warnings: validation.warnings,
    });
  }

  const baseCounts = countSong(validation);
  const estimate = estimateRenderedDuration(song);
  const beatsPerBar = getBeatsPerBar(song.meta.timeSignature);
  const counts: InfoCounts = {
    ...baseCounts,
    expandedEvents: compiled.timeline.events.length,
    warnings: validation.warnings.length,
  };
  const data: InfoData = {
    file: loaded.value.file,
    resolvedPath: loaded.value.resolvedPath,
    schemaVersion: validation.schemaVersion,
    title: song.meta.title,
    bpm: song.meta.bpm,
    timeSignature: {
      numerator: song.meta.timeSignature.numerator,
      denominator: song.meta.timeSignature.denominator,
    },
    key: { tonic: song.meta.key.tonic, mode: song.meta.key.mode },
    seed: song.meta.seed,
    durationHint: {
      beats: song.meta.durationHint,
      bars: song.meta.durationHint / beatsPerBar,
      seconds: estimate.hintSeconds,
    },
    duration: {
      hintSeconds: estimate.hintSeconds,
      lastSoundSeconds: estimate.lastSoundSeconds,
      estimatedRenderedSeconds: estimate.renderedSeconds,
    },
    counts,
    tracks: song.tracks.map(trackInfo),
    instruments: groupInstruments(song.tracks),
  };

  return success(data, validation.warnings, humanResult(data, formatWarnings(validation.warnings)));
}
