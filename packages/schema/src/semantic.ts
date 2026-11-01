import type { Pattern, SongSchemaV1 } from './generated/song-v1.js';
import { BUILTIN_INSTRUMENT_IDS } from './builtin-instruments.js';
import { validateBackendCapabilities, type BackendCapabilities } from './capabilities.js';
import {
  estimateRenderedDuration,
  MAX_RENDER_SECONDS,
  type RenderedDurationEstimate,
} from './duration.js';
import { createIssue, normalizeIssues, type ValidationIssue } from './issues.js';
import { getPatternEffectiveLengthBeats } from './patterns.js';

export const MAX_BEATS = 12000;
export const MAX_AUTHORED_NOTES = 10000;
export const MAX_EXPANDED_NOTES = 20000;
export const MAX_AUTOMATION_POINTS_PER_TRACK = 1536;
export const GM_DRUM_PITCH_MIN = 35;
export const GM_DRUM_PITCH_MAX = 81;
export const HINT_TRAILING_SILENCE_WARNING_SECONDS = 8;
export const DURATION_EPSILON_SECONDS = 1e-9;
export const BEAT_EPSILON = 1e-9;

const AUTOMATION_TARGETS = ['volume', 'pan', 'filterCutoffHz'] as const;

export interface SemanticValidationOptions {
  readonly builtinInstrumentIds?: readonly string[];
  readonly capabilities?: BackendCapabilities;
}

export interface SemanticValidationResult {
  readonly errors: ValidationIssue[];
  readonly warnings: ValidationIssue[];
}

function buildPatternIndex(patterns: readonly Pattern[]): Map<string, Pattern> {
  const index = new Map<string, Pattern>();
  for (const pattern of patterns) {
    if (!index.has(pattern.id)) {
      index.set(pattern.id, pattern);
    }
  }
  return index;
}

function checkUniqueIds(
  items: readonly { id: string }[],
  pathPrefix: string,
  code: 'song.track.duplicate_id' | 'song.pattern.duplicate_id',
  noun: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const firstIndexes = new Map<string, number>();

  items.forEach((item, index) => {
    const firstIndex = firstIndexes.get(item.id);
    if (firstIndex === undefined) {
      firstIndexes.set(item.id, index);
      return;
    }
    issues.push(
      createIssue(
        code,
        `${pathPrefix}/${index}/id`,
        `Duplicate ${noun} id "${item.id}"; the first definition is at ${pathPrefix}/${firstIndex}/id.`,
        `Rename this ${noun} to a unique lowercase identifier.`,
        { id: item.id, firstIndex },
      ),
    );
  });

  return issues;
}

function checkTracksAndChannels(song: SongSchemaV1): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const firstMelodicChannel = new Map<number, number>();
  let drumsTrackIndex: number | undefined;

  song.tracks.forEach((track, trackIndex) => {
    if (track.kind === 'drums') {
      if (drumsTrackIndex !== undefined) {
        issues.push(
          createIssue(
            'song.track.multiple_drums',
            `/tracks/${trackIndex}/kind`,
            `Only one drums track is allowed; the first is at /tracks/${drumsTrackIndex}/kind.`,
            'Merge the percussion parts into a single drums track.',
            { firstIndex: drumsTrackIndex },
          ),
        );
      } else {
        drumsTrackIndex = trackIndex;
      }

      if (track.channel !== 9) {
        issues.push(
          createIssue(
            'song.channel.drums_invalid',
            `/tracks/${trackIndex}/channel`,
            `Drums track "${track.id}" uses channel ${track.channel}; drums tracks must use channel 9.`,
            'Set channel to 9 (MIDI channel 10 in one-based notation).',
            { channel: track.channel },
          ),
        );
      }
      return;
    }

    if (track.channel === 9) {
      issues.push(
        createIssue(
          'song.channel.reserved',
          `/tracks/${trackIndex}/channel`,
          `MIDI track "${track.id}" uses reserved channel 9.`,
          'Use a melodic channel from 0 to 8 or 10 to 15. Channel 9 belongs to drums.',
          { channel: 9 },
        ),
      );
      return;
    }

    const firstIndex = firstMelodicChannel.get(track.channel);
    if (firstIndex === undefined) {
      firstMelodicChannel.set(track.channel, trackIndex);
    } else {
      issues.push(
        createIssue(
          'song.channel.duplicate',
          `/tracks/${trackIndex}/channel`,
          `Melodic channel ${track.channel} is already used by track at /tracks/${firstIndex}.`,
          'Give each melodic track a distinct MIDI channel.',
          { channel: track.channel, firstIndex },
        ),
      );
    }
  });

  return issues;
}

function checkPatterns(
  song: SongSchemaV1,
  patternsById: ReadonlyMap<string, Pattern>,
  initialIssues: ValidationIssue[],
): {
  issues: ValidationIssue[];
  expandedNotes: number;
  freeNotes: number;
  authoredNotes: number;
  unresolvedPatternTracks: Set<number>;
  renderedDuration: RenderedDurationEstimate;
} {
  const issues = [...initialIssues];
  const unresolvedPatternTracks = new Set<number>();
  let freeNotes = 0;

  for (const [trackIndex, track] of song.tracks.entries()) {
    for (const [noteIndex, note] of (track.notes ?? []).entries()) {
      freeNotes += 1;
      if (note.start + note.duration > MAX_BEATS + BEAT_EPSILON) {
        issues.push(
          createIssue(
            'song.note.end_exceeds_limit',
            `/tracks/${trackIndex}/notes/${noteIndex}`,
            `Note ends at beat ${note.start + note.duration}, beyond the ${MAX_BEATS} beat limit.`,
            'Move the note earlier or shorten its duration.',
            { endBeats: note.start + note.duration, limit: MAX_BEATS },
          ),
        );
      }
    }
  }

  let patternNotes = 0;
  song.patterns?.forEach((pattern, patternIndex) => {
    patternNotes += pattern.notes.length;
    const explicitLength = pattern.lengthBeats;
    if (explicitLength !== undefined) {
      pattern.notes.forEach((note, noteIndex) => {
        const end = note.start + note.duration;
        if (end > explicitLength + BEAT_EPSILON) {
          issues.push(
            createIssue(
              'song.pattern.note_exceeds_length',
              `/patterns/${patternIndex}/notes/${noteIndex}`,
              `Pattern note ends at beat ${end}, beyond lengthBeats ${explicitLength}.`,
              'Shorten or move the note, or increase lengthBeats.',
              { patternId: pattern.id, endBeats: end, lengthBeats: explicitLength },
            ),
          );
        }
        if (end > MAX_BEATS + BEAT_EPSILON) {
          issues.push(
            createIssue(
              'song.note.end_exceeds_limit',
              `/patterns/${patternIndex}/notes/${noteIndex}`,
              `Pattern note ends at beat ${end}, beyond the ${MAX_BEATS} beat limit.`,
              'Move the note earlier or shorten its duration.',
              { endBeats: end, limit: MAX_BEATS },
            ),
          );
        }
      });
    } else {
      pattern.notes.forEach((note, noteIndex) => {
        const end = note.start + note.duration;
        if (end > MAX_BEATS + BEAT_EPSILON) {
          issues.push(
            createIssue(
              'song.note.end_exceeds_limit',
              `/patterns/${patternIndex}/notes/${noteIndex}`,
              `Pattern note ends at beat ${end}, beyond the ${MAX_BEATS} beat limit.`,
              'Move the note earlier or shorten its duration.',
              { endBeats: end, limit: MAX_BEATS },
            ),
          );
        }
      });
    }
  });

  let expandedNotes = freeNotes;

  song.tracks.forEach((track, trackIndex) => {
    for (const [placementIndex, placement] of (track.placements ?? []).entries()) {
      const pattern = patternsById.get(placement.pattern);
      if (!pattern) {
        unresolvedPatternTracks.add(trackIndex);
        issues.push(
          createIssue(
            'song.pattern.unresolved',
            `/tracks/${trackIndex}/placements/${placementIndex}/pattern`,
            `Placement references unknown pattern "${placement.pattern}".`,
            'Add the pattern to the root patterns array or correct the pattern id.',
            { patternId: placement.pattern },
          ),
        );
        continue;
      }

      const repeat = placement.repeat ?? 1;
      const expandedForPlacement = repeat * pattern.notes.length;
      expandedNotes += expandedForPlacement;

      if (expandedForPlacement > MAX_EXPANDED_NOTES) {
        issues.push(
          createIssue(
            'song.placement.expansion_exceeds_limit',
            `/tracks/${trackIndex}/placements/${placementIndex}`,
            `This placement expands to ${expandedForPlacement} note events, beyond the ${MAX_EXPANDED_NOTES} event limit.`,
            'Reduce repeat, shorten the pattern, or split the arrangement into fewer expanded events.',
            { expandedNotes: expandedForPlacement, limit: MAX_EXPANDED_NOTES },
          ),
        );
      }

      const effectiveLength = getPatternEffectiveLengthBeats(pattern);
      const expandedEnd = placement.start + repeat * effectiveLength;
      if (expandedEnd > MAX_BEATS + BEAT_EPSILON) {
        issues.push(
          createIssue(
            'song.placement.end_exceeds_limit',
            `/tracks/${trackIndex}/placements/${placementIndex}`,
            `Expanded placement ends at beat ${expandedEnd}, beyond the ${MAX_BEATS} beat limit.`,
            'Move the placement earlier, reduce repeat, or shorten the pattern.',
            { endBeats: expandedEnd, limit: MAX_BEATS },
          ),
        );
      }
    }
  });

  const authoredNotes = freeNotes + patternNotes;
  if (authoredNotes > MAX_AUTHORED_NOTES) {
    issues.push(
      createIssue(
        'song.limit.authored_notes',
        '',
        `Song defines ${authoredNotes} authored notes, beyond the ${MAX_AUTHORED_NOTES} note limit.`,
        'Remove unused patterns or notes, or split the project.',
        { authoredNotes, limit: MAX_AUTHORED_NOTES },
      ),
    );
  }

  if (expandedNotes > MAX_EXPANDED_NOTES) {
    issues.push(
      createIssue(
        'song.limit.expanded_notes',
        '',
        `Song expands to ${expandedNotes} note events, beyond the ${MAX_EXPANDED_NOTES} event limit.`,
        'Reduce repeat counts or pattern density, or split the project.',
        { expandedNotes, limit: MAX_EXPANDED_NOTES },
      ),
    );
  }

  const renderedDuration = estimateRenderedDuration(song);
  if (renderedDuration.renderedSeconds > MAX_RENDER_SECONDS + DURATION_EPSILON_SECONDS) {
    issues.push(
      createIssue(
        'song.duration.exceeds_limit',
        '',
        `Computed rendered duration ${Number(renderedDuration.renderedSeconds.toFixed(3))}s exceeds the ${MAX_RENDER_SECONDS}s limit.`,
        'Shorten durationHint, end content earlier, reduce effect tails, or raise the tempo.',
        {
          renderedSeconds: renderedDuration.renderedSeconds,
          hintSeconds: renderedDuration.hintSeconds,
          lastSoundSeconds: renderedDuration.lastSoundSeconds,
          limitSeconds: MAX_RENDER_SECONDS,
        },
      ),
    );
  }

  return {
    issues,
    expandedNotes,
    freeNotes,
    authoredNotes,
    unresolvedPatternTracks,
    renderedDuration,
  };
}

function checkDrumPitches(
  song: SongSchemaV1,
  patternsById: ReadonlyMap<string, Pattern>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const reportedPatternPitches = new Set<string>();

  song.tracks.forEach((track, trackIndex) => {
    if (track.kind !== 'drums') {
      return;
    }

    (track.notes ?? []).forEach((note, noteIndex) => {
      if (note.pitch < GM_DRUM_PITCH_MIN || note.pitch > GM_DRUM_PITCH_MAX) {
        issues.push(
          createIssue(
            'song.drums.pitch_out_of_range',
            `/tracks/${trackIndex}/notes/${noteIndex}/pitch`,
            `Drum pitch ${note.pitch} is outside the General MIDI percussion range ${GM_DRUM_PITCH_MIN} to ${GM_DRUM_PITCH_MAX}.`,
            'Use a General MIDI percussion key such as 36 for bass drum or 38 for snare.',
            { pitch: note.pitch, minimum: GM_DRUM_PITCH_MIN, maximum: GM_DRUM_PITCH_MAX },
          ),
        );
      }
    });

    for (const placement of track.placements ?? []) {
      const pattern = patternsById.get(placement.pattern);
      if (!pattern) {
        continue;
      }
      const patternIndex = song.patterns?.indexOf(pattern) ?? -1;
      pattern.notes.forEach((note, noteIndex) => {
        if (note.pitch < GM_DRUM_PITCH_MIN || note.pitch > GM_DRUM_PITCH_MAX) {
          const path =
            patternIndex >= 0
              ? `/patterns/${patternIndex}/notes/${noteIndex}/pitch`
              : `/tracks/${trackIndex}/notes/${noteIndex}/pitch`;
          if (reportedPatternPitches.has(path)) {
            return;
          }
          reportedPatternPitches.add(path);
          issues.push(
            createIssue(
              'song.drums.pitch_out_of_range',
              path,
              `Drum pitch ${note.pitch} is outside the General MIDI percussion range ${GM_DRUM_PITCH_MIN} to ${GM_DRUM_PITCH_MAX}.`,
              'Use a General MIDI percussion key such as 36 for bass drum or 38 for snare.',
              {
                pitch: note.pitch,
                patternId: pattern.id,
                trackId: track.id,
                minimum: GM_DRUM_PITCH_MIN,
                maximum: GM_DRUM_PITCH_MAX,
              },
            ),
          );
        }
      });
    }
  });

  return issues;
}

function checkAutomation(song: SongSchemaV1): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  song.tracks.forEach((track, trackIndex) => {
    const automation = track.automation;
    if (!automation) {
      return;
    }

    let totalPoints = 0;
    for (const target of AUTOMATION_TARGETS) {
      const curve = automation[target];
      if (!curve) {
        continue;
      }
      totalPoints += curve.points.length;
      for (let pointIndex = 1; pointIndex < curve.points.length; pointIndex += 1) {
        const previous = curve.points[pointIndex - 1];
        const current = curve.points[pointIndex];
        if (previous && current && current.time <= previous.time) {
          issues.push(
            createIssue(
              'song.automation.time_order',
              `/tracks/${trackIndex}/automation/${target}/points/${pointIndex}/time`,
              `Automation time ${current.time} is not greater than the previous time ${previous.time}.`,
              'Sort each automation target by strictly increasing time.',
              {
                target,
                time: current.time,
                previousTime: previous.time,
                pointIndex,
              },
            ),
          );
        }
      }
    }

    if (totalPoints > MAX_AUTOMATION_POINTS_PER_TRACK) {
      issues.push(
        createIssue(
          'song.limit.automation_points',
          `/tracks/${trackIndex}/automation`,
          `Track defines ${totalPoints} automation points, beyond the ${MAX_AUTOMATION_POINTS_PER_TRACK} point limit.`,
          'Remove redundant keyframes or split the automation across simpler curves.',
          { totalPoints, limit: MAX_AUTOMATION_POINTS_PER_TRACK },
        ),
      );
    }

    if (automation.filterCutoffHz !== undefined) {
      const lowpassEffects = (track.effects ?? []).filter((effect) => effect.type === 'lowpass');
      if (lowpassEffects.length !== 1) {
        issues.push(
          createIssue(
            'song.automation.filter_target',
            `/tracks/${trackIndex}/automation/filterCutoffHz`,
            `Cutoff automation requires exactly one lowpass effect, found ${lowpassEffects.length}.`,
            'Add exactly one lowpass effect to this track or remove cutoff automation.',
            { lowpassCount: lowpassEffects.length },
          ),
        );
      } else {
        lowpassEffects.forEach((effect, effectIndex) => {
          if (effect.type === 'lowpass' && effect.cutoffHz !== undefined) {
            issues.push(
              createIssue(
                'song.automation.filter_target',
                `/tracks/${trackIndex}/effects/${effectIndex}/cutoffHz`,
                'A lowpass with cutoff automation must omit static cutoffHz.',
                'Remove cutoffHz from the lowpass effect; the automation supplies the value.',
                { lowpassCount: 1 },
              ),
            );
          }
        });
      }
    }
  });

  return issues;
}

function checkBuiltinInstruments(
  song: SongSchemaV1,
  builtinInstrumentIds: ReadonlySet<string>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  song.tracks.forEach((track, trackIndex) => {
    const instrument = track.instrument;
    if (instrument.type === 'builtin' && !builtinInstrumentIds.has(instrument.id)) {
      issues.push(
        createIssue(
          'song.instrument.unknown_builtin',
          `/tracks/${trackIndex}/instrument/id`,
          `Unknown builtin instrument id "${instrument.id}".`,
          `Use a known builtin id: ${[...builtinInstrumentIds].join(', ')}.`,
          {
            instrumentId: instrument.id,
            supportedIds: [...builtinInstrumentIds],
          },
        ),
      );
    }
  });

  return issues;
}

function buildWarnings(
  song: SongSchemaV1,
  renderedDuration: RenderedDurationEstimate,
  unresolvedPatternTracks: ReadonlySet<number>,
): ValidationIssue[] {
  const warnings: ValidationIssue[] = [];

  const referencedPatterns = new Set<string>();
  for (const track of song.tracks) {
    for (const placement of track.placements ?? []) {
      referencedPatterns.add(placement.pattern);
    }
  }

  song.patterns?.forEach((pattern, patternIndex) => {
    if (!referencedPatterns.has(pattern.id)) {
      warnings.push(
        createIssue(
          'song.warning.unused_pattern',
          `/patterns/${patternIndex}`,
          `Pattern "${pattern.id}" is defined but never placed.`,
          'Remove the unused pattern or reference it from a track placement.',
          { patternId: pattern.id },
        ),
      );
    }
  });

  song.tracks.forEach((track, trackIndex) => {
    if (unresolvedPatternTracks.has(trackIndex) || !track.automation) {
      return;
    }
    const contribution = renderedDuration.tracks[trackIndex];
    const contentEndBeats = contribution?.contentEndBeats ?? 0;

    for (const target of AUTOMATION_TARGETS) {
      const curve = track.automation[target];
      if (!curve) {
        continue;
      }
      for (const [pointIndex, point] of curve.points.entries()) {
        if (point.time > contentEndBeats + BEAT_EPSILON) {
          warnings.push(
            createIssue(
              'song.warning.automation_after_content',
              `/tracks/${trackIndex}/automation/${target}/points/${pointIndex}/time`,
              `Automation point at beat ${point.time} lies after the last note end at beat ${contentEndBeats} on this track.`,
              'Remove the point or extend content if the automation should be audible.',
              {
                target,
                time: point.time,
                contentEndBeats,
                pointIndex,
              },
            ),
          );
          break;
        }
      }
    }
  });

  const trailingSilenceSeconds = renderedDuration.hintSeconds - renderedDuration.lastSoundSeconds;
  if (trailingSilenceSeconds > HINT_TRAILING_SILENCE_WARNING_SECONDS) {
    warnings.push(
      createIssue(
        'song.warning.hint_exceeds_content',
        '/meta/durationHint',
        `durationHint leaves ${Number(trailingSilenceSeconds.toFixed(3))}s of trailing silence after all audible content.`,
        'Reduce durationHint or add content if the silence is unintended.',
        {
          hintSeconds: renderedDuration.hintSeconds,
          lastSoundSeconds: renderedDuration.lastSoundSeconds,
          trailingSilenceSeconds,
          thresholdSeconds: HINT_TRAILING_SILENCE_WARNING_SECONDS,
        },
      ),
    );
  }

  return warnings;
}

/**
 * Run all Task 03 cross-item semantic checks. Input must have passed structural
 * validation; callers should use `validateSong` rather than this function.
 * The song is never mutated.
 */
export function validateSongSemantics(
  song: SongSchemaV1,
  options: SemanticValidationOptions = {},
): SemanticValidationResult {
  const patternsById = buildPatternIndex(song.patterns ?? []);
  const builtinIds = new Set(options.builtinInstrumentIds ?? BUILTIN_INSTRUMENT_IDS);

  const identityIssues = [
    ...checkUniqueIds(song.tracks, '/tracks', 'song.track.duplicate_id', 'track'),
    ...checkUniqueIds(song.patterns ?? [], '/patterns', 'song.pattern.duplicate_id', 'pattern'),
    ...checkTracksAndChannels(song),
  ];

  const patternResult = checkPatterns(song, patternsById, identityIssues);
  const issues = [
    ...patternResult.issues,
    ...checkDrumPitches(song, patternsById),
    ...checkAutomation(song),
    ...checkBuiltinInstruments(song, builtinIds),
    ...(options.capabilities === undefined
      ? []
      : validateBackendCapabilities(song, options.capabilities)),
  ];

  const warnings = buildWarnings(
    song,
    patternResult.renderedDuration,
    patternResult.unresolvedPatternTracks,
  );

  return {
    errors: normalizeIssues(issues),
    warnings: normalizeIssues(warnings),
  };
}
