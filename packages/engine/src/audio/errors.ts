import type { IssueParams } from '@gxaditya/vamp-schema';

/**
 * Stable audio issue codes.
 *
 * Expected audio failures are returned as values, never thrown. Errors cover
 * option and timeline guards, backend capability boundaries, malformed backend
 * output, and non-finite samples. Warnings report voice-policy and PCM events
 * that did not stop the render.
 */
export const AUDIO_ERROR_CODES = Object.freeze([
  'audio.options.invalid',
  'audio.timeline.invalid',
  'audio.sample_rate.mismatch',
  'audio.instrument.unsupported_variant',
  'audio.instrument.unknown_builtin',
  'audio.drums.pitch_unsupported',
  'audio.effects.invalid',
  'audio.automation.invalid',
  'audio.effects.unsupported',
  'audio.automation.unsupported',
  'audio.samples.non_finite',
  'audio.backend.failed',
  'audio.backend.invalid_output',
  'audio.backend.missing_dependency',
  'audio.backend.timeout',
  'audio.backend.process_failed',
  'audio.backend.output_invalid',
  'audio.config.invalid',
  'audio.asset.missing',
  'audio.asset.invalid',
  'audio.asset.confined',
  'audio.asset.checksum_mismatch',
  'audio.buffer.invalid',
  'audio.cancelled',
  'audio.artifacts.name_invalid',
  'audio.artifacts.name_collision',
  'audio.artifacts.limit',
  'audio.artifacts.output_invalid',
  'audio.artifacts.exists',
  'audio.artifacts.unwritable',
  'audio.artifacts.write_failed',
  'audio.artifacts.publish_failed',
  'audio.report.invalid',
] as const);

export type AudioErrorCode = (typeof AUDIO_ERROR_CODES)[number];

export const AUDIO_WARNING_CODES = Object.freeze([
  'audio.voice.dropped',
  'audio.voice.stolen',
  'audio.pcm.clipped',
  'audio.artifacts.cleanup_failed',
] as const);

export type AudioWarningCode = (typeof AUDIO_WARNING_CODES)[number];

export const AUDIO_ISSUE_CODES = Object.freeze([
  ...AUDIO_ERROR_CODES,
  ...AUDIO_WARNING_CODES,
] as const);

export type AudioIssueCode = AudioErrorCode | AudioWarningCode;

/**
 * An audio issue uses the same JSON-serializable shape as schema and compile
 * issues, so adapters can render one error envelope for every stage. `path` is
 * a JSON Pointer into the song/timeline shape where one exists; output-only
 * findings use a synthetic pointer such as `/audio` or `/tracks/0`.
 */
export interface AudioIssue {
  readonly code: AudioIssueCode;
  readonly severity: 'error' | 'warning';
  readonly path: string;
  readonly message: string;
  readonly hint: string;
  readonly params?: IssueParams;
}

const warningCodeSet: ReadonlySet<string> = new Set(AUDIO_WARNING_CODES);

export function createAudioIssue(
  code: AudioIssueCode,
  path: string,
  message: string,
  hint: string,
  params?: IssueParams,
): AudioIssue {
  return {
    code,
    severity: warningCodeSet.has(code) ? 'warning' : 'error',
    path,
    message,
    hint,
    ...(params === undefined ? {} : { params }),
  };
}

function compareStrings(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/** Deterministic issue order: JSON Pointer path, then code, then message. */
export function compareAudioIssues(left: AudioIssue, right: AudioIssue): number {
  return (
    compareStrings(left.path, right.path) ||
    compareStrings(left.code, right.code) ||
    compareStrings(left.message, right.message)
  );
}

/**
 * Sort issues deterministically and drop exact duplicates. Deduplicating by
 * code, path, and message keeps backend-provided warnings from multiplying
 * when a policy is reported twice.
 */
export function normalizeAudioIssues(issues: readonly AudioIssue[]): AudioIssue[] {
  const seen = new Set<string>();
  const unique: AudioIssue[] = [];
  for (const issue of issues) {
    const key = `${issue.code}\u0000${issue.path}\u0000${issue.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(issue);
    }
  }
  return unique.sort(compareAudioIssues);
}
