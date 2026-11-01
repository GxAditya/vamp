import { describe, expect, it } from 'vitest';

import type { Automation } from '../src/index.js';
import { validateSong, type ValidationFailure, type ValidationResult } from '../src/index.js';
import { validateSongSemantics } from '../src/semantic.js';
import {
  automationSong,
  cloneSong,
  drumsSong,
  instrumentsSong,
  minimalSong,
  patternsSong,
} from './test-helpers.js';

function requireFailure(result: ValidationResult): ValidationFailure {
  if (result.ok) {
    throw new Error('Expected validation to fail.');
  }
  return result;
}

function hasError(result: ValidationResult, code: string, path: string): boolean {
  return !result.ok && result.errors.some((issue) => issue.code === code && issue.path === path);
}

function hasWarning(result: ValidationResult, code: string, path: string): boolean {
  return result.warnings.some((issue) => issue.code === code && issue.path === path);
}

function ascendingPoints(count: number): Array<{ time: number; value: number }> {
  return Array.from({ length: count }, (_, index) => ({ time: index, value: 1 }));
}

describe('semantic identity and reference checks', () => {
  it('rejects duplicate track ids', () => {
    const song = minimalSong();
    const duplicate = structuredClone(song.tracks[0]!);
    duplicate.channel = 1;
    song.tracks.push(duplicate);

    const result = requireFailure(validateSong(song));
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      code: 'song.track.duplicate_id',
      path: '/tracks/1/id',
    });
  });

  it('rejects duplicate pattern ids', () => {
    const song = patternsSong();
    const duplicate = structuredClone(song.patterns![0]!);
    duplicate.name = 'Duplicate pulse';
    song.patterns!.push(duplicate);

    const result = requireFailure(validateSong(song));
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      code: 'song.pattern.duplicate_id',
      path: '/patterns/2/id',
    });
  });

  it('rejects duplicate melodic channels', () => {
    const song = minimalSong();
    const second = structuredClone(song.tracks[0]!);
    second.id = 'keys-two';
    second.channel = 0;
    song.tracks.push(second);

    const result = requireFailure(validateSong(song));
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      code: 'song.channel.duplicate',
      path: '/tracks/1/channel',
    });
  });

  it('enforces channel 9 rules defensively in the semantic layer', () => {
    const reserved = cloneSong(minimalSong());
    reserved.tracks[0]!.channel = 9;
    expect(
      validateSongSemantics(reserved).errors.map((issue) => [issue.code, issue.path]),
    ).toContainEqual(['song.channel.reserved', '/tracks/0/channel']);

    const drums = cloneSong(drumsSong());
    drums.tracks[0]!.channel = 0;
    expect(
      validateSongSemantics(drums).errors.map((issue) => [issue.code, issue.path]),
    ).toContainEqual(['song.channel.drums_invalid', '/tracks/0/channel']);

    const twoDrums = cloneSong(drumsSong());
    const secondDrums = structuredClone(twoDrums.tracks[0]!);
    secondDrums.id = 'drums-two';
    twoDrums.tracks.push(secondDrums);
    expect(
      validateSongSemantics(twoDrums).errors.map((issue) => [issue.code, issue.path]),
    ).toContainEqual(['song.track.multiple_drums', '/tracks/1/kind']);
  });

  it('rejects unresolved pattern placements', () => {
    const song = minimalSong();
    song.tracks[0]!.placements = [{ pattern: 'missing', start: 0 }];

    const result = requireFailure(validateSong(song));
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      code: 'song.pattern.unresolved',
      path: '/tracks/0/placements/0/pattern',
    });
  });
});

describe('semantic timing, pitch, and automation checks', () => {
  it('rejects pattern notes that exceed an explicit lengthBeats', () => {
    const song = patternsSong();
    song.patterns![0]!.lengthBeats = 1;

    const result = requireFailure(validateSong(song));
    expect(hasError(result, 'song.pattern.note_exceeds_length', '/patterns/0/notes/2')).toBe(true);
    expect(result.errors.every((issue) => issue.code === 'song.pattern.note_exceeds_length')).toBe(
      true,
    );
  });

  it('rejects note ends beyond 12000 beats for free and pattern notes', () => {
    const free = minimalSong();
    free.tracks[0]!.notes = [{ pitch: 60, start: 11999.5, duration: 1 }];
    expect(
      hasError(
        requireFailure(validateSong(free)),
        'song.note.end_exceeds_limit',
        '/tracks/0/notes/0',
      ),
    ).toBe(true);

    const pattern = patternsSong();
    pattern.patterns![0]!.notes[0] = { pitch: 60, start: 11999, duration: 2 };
    expect(
      hasError(
        requireFailure(validateSong(pattern)),
        'song.note.end_exceeds_limit',
        '/patterns/0/notes/0',
      ),
    ).toBe(true);
  });

  it('enforces the structural repeat bound as part of expansion limits', () => {
    const song = patternsSong();
    song.tracks[0]!.placements![0]!.repeat = 257;

    const result = requireFailure(validateSong(song));
    expect(hasError(result, 'schema.structure.out_of_range', '/tracks/0/placements/0/repeat')).toBe(
      true,
    );
  });

  it('rejects expanded placements that pass 12000 beats', () => {
    const song = patternsSong();
    song.tracks[0]!.placements = [{ pattern: 'pulse', start: 12000, repeat: 4 }];

    const result = requireFailure(validateSong(song));
    expect(hasError(result, 'song.placement.end_exceeds_limit', '/tracks/0/placements/0')).toBe(
      true,
    );
  });

  it('rejects drum pitches outside the General MIDI percussion range', () => {
    const free = drumsSong();
    free.tracks[0]!.notes![0]!.pitch = 34;
    expect(
      hasError(
        requireFailure(validateSong(free)),
        'song.drums.pitch_out_of_range',
        '/tracks/0/notes/0/pitch',
      ),
    ).toBe(true);

    const patterns = drumsSong();
    patterns.patterns = [
      {
        id: 'bad-drums',
        notes: [{ pitch: 30, start: 0, duration: 1 }],
      },
    ];
    patterns.tracks[0]!.placements = [{ pattern: 'bad-drums', start: 0 }];
    expect(
      hasError(
        requireFailure(validateSong(patterns)),
        'song.drums.pitch_out_of_range',
        '/patterns/0/notes/0/pitch',
      ),
    ).toBe(true);
  });

  it('requires strictly increasing automation times', () => {
    const song = automationSong();
    song.tracks[0]!.automation!.volume!.points = [
      { time: 8, value: 1 },
      { time: 8, value: 0.5 },
    ];

    const result = requireFailure(validateSong(song));
    expect(
      hasError(result, 'song.automation.time_order', '/tracks/0/automation/volume/points/1/time'),
    ).toBe(true);
  });

  it('requires filter automation to target exactly one static-free lowpass', () => {
    const missing = cloneSong(minimalSong());
    const filterAutomation: Automation = {
      filterCutoffHz: { points: [{ time: 0, value: 400 }] },
    };
    missing.tracks[0]!.automation = filterAutomation;
    missing.tracks[0]!.effects = [];
    expect(
      validateSongSemantics(missing).errors.map((issue) => [issue.code, issue.path]),
    ).toContainEqual(['song.automation.filter_target', '/tracks/0/automation/filterCutoffHz']);

    const multiple = cloneSong(minimalSong());
    multiple.tracks[0]!.automation = filterAutomation;
    multiple.tracks[0]!.effects = [{ type: 'lowpass' }, { type: 'lowpass' }];
    expect(
      validateSongSemantics(multiple).errors.map((issue) => [issue.code, issue.path]),
    ).toContainEqual(['song.automation.filter_target', '/tracks/0/automation/filterCutoffHz']);

    const staticConflict = cloneSong(minimalSong());
    staticConflict.tracks[0]!.automation = filterAutomation;
    staticConflict.tracks[0]!.effects = [{ type: 'lowpass', cutoffHz: 800 }];
    expect(
      validateSongSemantics(staticConflict).errors.map((issue) => [issue.code, issue.path]),
    ).toContainEqual(['song.automation.filter_target', '/tracks/0/effects/0/cutoffHz']);
  });

  it('enforces the automation points per track bound', () => {
    const song = cloneSong(minimalSong());
    song.tracks[0]!.automation = {
      volume: { points: ascendingPoints(513) },
      pan: { points: ascendingPoints(513).map((point) => ({ ...point, value: 0 })) },
      filterCutoffHz: {
        points: ascendingPoints(513).map((point) => ({ ...point, value: 400 })),
      },
    };

    const errors = validateSongSemantics(song).errors;
    expect(
      errors.some(
        (issue) =>
          issue.code === 'song.limit.automation_points' && issue.path === '/tracks/0/automation',
      ),
    ).toBe(true);
  });
});

describe('semantic resource bounds', () => {
  it('rejects more than 10000 authored notes', () => {
    const song = minimalSong();
    song.patterns = Array.from({ length: 40 }, (_, patternIndex) => ({
      id: `p${patternIndex}`,
      notes: Array.from({ length: 256 }, () => ({ pitch: 60, start: 0, duration: 0.25 })),
    }));

    const result = requireFailure(validateSong(song));
    expect(hasError(result, 'song.limit.authored_notes', '')).toBe(true);
  });

  it('rejects more than 20000 expanded note events and per-placement expansion', () => {
    const song = minimalSong();
    delete song.tracks[0]!.notes;
    song.patterns = [
      {
        id: 'big',
        notes: Array.from({ length: 256 }, () => ({
          pitch: 60,
          start: 0,
          duration: 0.25,
        })),
      },
    ];
    song.tracks[0]!.placements = [{ pattern: 'big', start: 0, repeat: 100 }];

    const result = requireFailure(validateSong(song));
    expect(hasError(result, 'song.limit.expanded_notes', '')).toBe(true);
    expect(
      hasError(result, 'song.placement.expansion_exceeds_limit', '/tracks/0/placements/0'),
    ).toBe(true);
  });

  it('rejects computed rendered durations above 600 seconds and allows exactly 600', () => {
    const tooLong = minimalSong();
    tooLong.meta.bpm = 300;
    tooLong.meta.durationHint = 12000;
    const failure = requireFailure(validateSong(tooLong));
    expect(hasError(failure, 'song.duration.exceeds_limit', '')).toBe(true);

    const exactly = minimalSong();
    exactly.meta.bpm = 300;
    exactly.meta.durationHint = 3000;
    const result = validateSong(exactly);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings.some((issue) => issue.code === 'song.duration.exceeds_limit')).toBe(
        false,
      );
    }
  });
});

describe('semantic instrument and capability checks', () => {
  it('rejects unknown builtin instrument ids', () => {
    const song = minimalSong();
    song.tracks[0]!.instrument = { type: 'builtin', id: 'keys.missing' };

    const result = requireFailure(validateSong(song));
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      code: 'song.instrument.unknown_builtin',
      path: '/tracks/0/instrument/id',
    });
  });

  it('accepts injected builtin registries and rejects ids missing from them', () => {
    const song = minimalSong();
    const accepted = validateSong(song, { builtinInstrumentIds: ['keys.soft'] });
    expect(accepted.ok).toBe(true);

    const rejected = validateSong(song, { builtinInstrumentIds: ['pad.warm'] });
    expect(rejected.ok).toBe(false);
  });

  it('checks a declared backend capability boundary', () => {
    const song = minimalSong();
    const unchecked = validateSong(song);
    expect(unchecked.ok && unchecked.capabilityCheck).toBe('not_checked');

    const unsupported = validateSong(song, {
      capabilities: { id: 'fake', supportedInstrumentTypes: ['gm'] },
    });
    expect(unsupported.ok).toBe(false);
    expect(
      hasError(unsupported, 'song.capability.instrument_unsupported', '/tracks/0/instrument'),
    ).toBe(true);

    const supported = validateSong(song, {
      capabilities: {
        id: 'fake',
        supportedInstrumentTypes: ['builtin'],
        supportedBuiltinIds: ['keys.soft'],
      },
    });
    expect(supported.ok && supported.capabilityCheck).toBe('checked');

    const missingBuiltin = validateSong(song, {
      capabilities: {
        id: 'fake',
        supportedInstrumentTypes: ['builtin'],
        supportedBuiltinIds: ['pad.warm'],
      },
    });
    expect(
      hasError(missingBuiltin, 'song.capability.instrument_unsupported', '/tracks/0/instrument/id'),
    ).toBe(true);

    const unsupportedAssets = validateSong(instrumentsSong(), {
      capabilities: {
        id: 'fake',
        supportedInstrumentTypes: ['gm', 'soundfont', 'sfz'],
        supportsAsset: () => false,
      },
    });
    expect(
      hasError(unsupportedAssets, 'song.capability.asset_unsupported', '/tracks/1/instrument/path'),
    ).toBe(true);
    expect(
      hasError(unsupportedAssets, 'song.capability.asset_unsupported', '/tracks/2/instrument/path'),
    ).toBe(true);
  });
});

describe('semantic warnings', () => {
  it('warns about unused patterns without failing validation', () => {
    const song = minimalSong();
    song.patterns = [{ id: 'unused', notes: [{ pitch: 60, start: 0, duration: 1 }] }];

    const result = validateSong(song);
    expect(result.ok).toBe(true);
    expect(hasWarning(result, 'song.warning.unused_pattern', '/patterns/0')).toBe(true);
  });

  it('warns about automation after the last content', () => {
    const result = validateSong(automationSong());
    expect(result.ok).toBe(true);
    expect(
      hasWarning(
        result,
        'song.warning.automation_after_content',
        '/tracks/0/automation/filterCutoffHz/points/3/time',
      ),
    ).toBe(true);
  });

  it('warns when durationHint leaves a long trailing silence', () => {
    const song = minimalSong();
    song.meta.durationHint = 100;

    const result = validateSong(song);
    expect(result.ok).toBe(true);
    const warning = result.warnings.find(
      (issue) => issue.code === 'song.warning.hint_exceeds_content',
    );
    expect(warning).toMatchObject({
      path: '/meta/durationHint',
      severity: 'warning',
    });
    expect(warning?.params?.trailingSilenceSeconds).toBeGreaterThan(8);
  });

  it('includes warnings on a failing result', () => {
    const song = automationSong();
    song.tracks[0]!.instrument = { type: 'builtin', id: 'missing.instrument' };

    const result = requireFailure(validateSong(song));
    expect(
      hasWarning(
        result,
        'song.warning.automation_after_content',
        '/tracks/0/automation/filterCutoffHz/points/3/time',
      ),
    ).toBe(true);
  });

  it('does not mutate the song during semantic checks', () => {
    const song = patternsSong();
    const before = JSON.stringify(song);
    validateSongSemantics(song);
    expect(JSON.stringify(song)).toBe(before);
  });
});
