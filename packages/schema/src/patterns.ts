import type { Pattern } from './generated/song-v1.js';

/**
 * Effective pattern length in quarter-note beats.
 *
 * An explicit lengthBeats is authoritative. When it is omitted, the effective
 * length is the maximum note end, which is always greater than zero for a
 * structurally valid pattern. The value is never written back into the song.
 */
export function getPatternEffectiveLengthBeats(pattern: Pattern): number {
  if (pattern.lengthBeats !== undefined) {
    return pattern.lengthBeats;
  }

  let maximumEnd = 0;
  for (const note of pattern.notes) {
    maximumEnd = Math.max(maximumEnd, note.start + note.duration);
  }
  return maximumEnd;
}
