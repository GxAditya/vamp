/**
 * `vamp render <file> --out <directory>`: render one validated JSON song into
 * a complete offline artifact set.
 *
 * This is a thin adapter over `renderSongArtifacts` in `@gxaditya/vamp-engine`. It maps
 * CLI options to the shared artifact operation, selects the built-in or
 * explicitly configured FluidSynth backend, translates engine issues into the
 * CLI error envelope, and routes cancellation through the engine AbortSignal.
 * It does not contain a validator, compiler, mixer, DSP chain, artifact writer,
 * or report generator.
 */

import { dirname, isAbsolute, resolve } from 'node:path';

import {
  INSTRUMENT_REGISTRY_VALIDATION,
  createFluidSynthBackend,
  isFluidSynthBinaryAvailable,
  renderSongArtifacts,
  selectAutomaticBackend,
  type AudioBackend,
  type AudioIssue,
  type RenderArtifactReport,
  type RenderReport,
  type RenderSongArtifactsResult,
  type SampleRate,
} from '@gxaditya/vamp-engine';
import type { ValidationIssue } from '@gxaditya/vamp-schema';

import {
  getStringOption,
  hasFlag,
  parseArgs,
  type CliOptionSpec,
  type ParsedArgs,
} from '../args.js';
import { readSongDocument } from '../files.js';
import { commandHelp } from '../help.js';
import {
  failure,
  formatError,
  success,
  usageFailure,
  writeStderr,
  type CliError,
  type CommandFailure,
  type CommandOutcome,
  type StructuredValue,
} from '../output.js';

const OPTIONS: readonly CliOptionSpec[] = Object.freeze([
  { name: 'out', kind: 'string' },
  { name: 'format', kind: 'string' },
  { name: 'sample-rate', kind: 'string' },
  { name: 'backend', kind: 'string' },
  { name: 'stems', kind: 'boolean' },
  { name: 'no-stems', kind: 'boolean' },
  { name: 'midi', kind: 'boolean' },
  { name: 'no-midi', kind: 'boolean' },
  { name: 'report', kind: 'boolean' },
  { name: 'no-report', kind: 'boolean' },
  { name: 'normalize', kind: 'boolean' },
  { name: 'no-normalize', kind: 'boolean' },
  { name: 'overwrite', kind: 'boolean' },
  { name: 'fluidsynth-path', kind: 'string' },
  { name: 'soundfont', kind: 'string' },
  { name: 'project-root', kind: 'string' },
  { name: 'verify-soundfont', kind: 'boolean' },
]);

const DEFAULT_SAMPLE_RATE: SampleRate = 48_000;
const DEFAULT_FORMAT = 'wav';
const AUTO_BACKEND = 'auto';
const FLUIDSYNTH_BACKEND = 'fluidsynth';
const BUILTIN_BACKEND = 'builtin';
const MP3_DEFERRED_HINT =
  'MP3 export is deferred because no tested, legally appropriate offline encoder is bundled. Use --format wav; WAV is the only supported render format.';

type RenderBackendChoice = 'builtin' | 'fluidsynth';
type RenderBackendRequest = 'auto' | RenderBackendChoice;

export interface RenderArtifactData extends RenderArtifactReport {
  /** Absolute path to the published artifact. */
  readonly absolutePath: string;
}

export interface RenderFileReference {
  readonly path: string;
  readonly absolutePath: string;
}

export interface RenderSummary {
  readonly title: string;
  readonly durationSeconds: number;
  readonly sampleRate: SampleRate;
  readonly backend: string;
  readonly artifactCount: number;
  readonly stemCount: number;
  readonly midi: boolean;
  readonly report: boolean;
  readonly peakDbfs: number | null;
  readonly integratedLufs: number | null;
}

export interface RenderWarnings {
  readonly validation: readonly ValidationIssue[];
  readonly audio: readonly AudioIssue[];
}

export interface RenderData {
  /** Song path exactly as supplied. */
  readonly file: string;
  /** Absolute song path that was read. */
  readonly resolvedPath: string;
  /** Absolute output directory that was published. */
  readonly outputDir: string;
  readonly format: 'wav';
  readonly sampleRate: SampleRate;
  readonly backend: RenderBackendChoice;
  readonly backendSelection: {
    readonly requested: RenderBackendRequest;
    readonly selected: RenderBackendChoice;
    readonly note: string;
  };
  readonly artifacts: readonly RenderArtifactData[];
  /** Present only when the report file was written. */
  readonly reportFile: RenderFileReference | null;
  /** Relative artifact names from the engine report. */
  readonly outputs: RenderReport['outputs'];
  readonly report: RenderReport;
  readonly warnings: RenderWarnings;
  readonly summary: RenderSummary;
}

function usage(command: string, code: string, message: string, hint: string): CommandFailure {
  return usageFailure(command, { code, message, hint });
}

function conflictingBooleans(
  parsed: ParsedArgs,
  positive: string,
  negative: string,
): CommandFailure | null {
  if (!hasFlag(parsed, positive) || !hasFlag(parsed, negative)) {
    return null;
  }
  return usage(
    'render',
    'cli.usage.conflicting_options',
    `options "--${positive}" and "--${negative}" cannot be combined`,
    `Pass only one of --${positive} or --${negative}.`,
  );
}

function optionFromEnvironment(
  name: 'VAMP_FLUIDSYNTH_PATH' | 'VAMP_SOUNDFONT_PATH',
): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? undefined : value;
}

function absoluteFrom(base: string, value: string): string {
  return isAbsolute(value) ? value : resolve(base, value);
}

function addCliBackendHint(code: string, engineHint: string): string {
  switch (code) {
    case 'audio.instrument.unsupported_variant':
      return `${engineHint} In the CLI, pass --backend fluidsynth with --soundfont <absolute .sf2 path>. Add --project-root when the song references project .sf2 assets.`;
    case 'audio.backend.missing_dependency':
      return 'Install FluidSynth 2.x, or pass --fluidsynth-path <absolute path or PATH name> with --backend fluidsynth. The built-in backend needs no external executable.';
    case 'audio.asset.missing':
    case 'audio.asset.invalid':
    case 'audio.asset.confined':
    case 'audio.asset.checksum_mismatch':
      return `${engineHint} The trusted GM SoundFont is selected with --soundfont (or VAMP_SOUNDFONT_PATH); project .sf2 assets are confined to --project-root, which defaults to the song file directory.`;
    case 'audio.artifacts.exists':
      return 'Pass --overwrite to replace existing render artifacts, or choose a different --out directory. No files were changed.';
    case 'audio.config.invalid':
      return `${engineHint} Check --backend, --fluidsynth-path, --soundfont, --project-root, and --verify-soundfont.`;
    default:
      return engineHint;
  }
}

function firstAudioIssue(
  result: Extract<RenderSongArtifactsResult, { ok: false }>,
): AudioIssue | null {
  if (result.stage === 'validation' || result.stage === 'compile') {
    return null;
  }
  return result.errors[0] ?? null;
}

function renderFailure(
  result: Extract<RenderSongArtifactsResult, { ok: false }>,
  interruptionSignal: string | null,
  sourceFile: string,
): CommandFailure {
  if (result.stage === 'validation') {
    const versionProblem = result.errors.some(
      (issue) =>
        issue.code === 'schema.version.missing' || issue.code === 'schema.version.unsupported',
    );
    const error: CliError = {
      code: versionProblem ? 'cli.validation.unsupported_version' : 'cli.validation.invalid',
      message: versionProblem
        ? `Song file "${sourceFile}" uses a missing or unsupported schemaVersion.`
        : `Song file "${sourceFile}" failed SongSchemaV1 validation.`,
      hint: versionProblem
        ? 'Use schemaVersion "1.0.0" or migrate the file explicitly. Vamp never rewrites a saved file automatically.'
        : 'Fix every reported issue. Paths are JSON Pointers into the song document.',
      path: sourceFile,
      issues: result.errors,
    };
    return failure(error, formatError('render', error), { warnings: result.warnings });
  }

  if (result.stage === 'compile') {
    const first = result.errors[0];
    const details: Record<string, StructuredValue> = { stage: 'compile' };
    if (first !== undefined) {
      details.issueCode = first.code;
      details.issuePath = first.path;
      details.issueMessage = first.message;
    }
    const error: CliError = {
      code: 'cli.render.compile_failed',
      message: `Song file "${sourceFile}" could not be compiled into a render timeline.`,
      hint: first?.hint ?? 'Run "vamp validate" and retry. Compile limits may have been tightened.',
      path: sourceFile,
      details,
    };
    return failure(error, formatError('render', error), {
      warnings: result.warnings,
    });
  }

  if (result.stage === 'cancelled') {
    const first = result.errors[0];
    const error: CliError = {
      code: 'cli.render.cancelled',
      message: 'The render was cancelled before any artifacts were published.',
      hint: 'No partial artifacts were left behind. Run the render again when ready. An in-flight native backend call is not interrupted; cleanup happens at the next safe boundary.',
      ...(first === undefined ? {} : { details: { abortedAt: 'artifact-boundary' } }),
    };
    return failure(error, formatError('render', error), {
      warnings: [],
    });
  }

  const issue = firstAudioIssue(result);
  const code = issue?.code ?? 'cli.render.failed';
  const details: Record<string, StructuredValue> = { stage: result.stage };
  if (issue !== null) {
    details.issuePath = issue.path;
    details.issueCount = result.errors.length;
    if (typeof issue.params?.trackId === 'string') {
      details.trackId = issue.params.trackId;
    }
    if (typeof issue.params?.binaryPath === 'string') {
      details.binaryPath = issue.params.binaryPath;
    }
  }
  if (interruptionSignal !== null) {
    details.interruptionSignal = interruptionSignal;
  }
  const error: CliError = {
    code,
    message: issue?.message ?? 'The render failed before any artifacts were published.',
    hint: addCliBackendHint(code, issue?.hint ?? 'Inspect the render options and retry.'),
    ...(issue === null ? {} : { path: issue.path }),
    details,
  };
  return failure(error, formatError('render', error), { warnings: [] });
}

function formatNumber(value: number, digits = 2): string {
  if (!Number.isFinite(value)) {
    return 'unknown';
  }
  if (Number.isInteger(value)) {
    return String(value);
  }
  return value.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '');
}

function formatLevel(value: number | null, unit: string): string {
  if (value === null || !Number.isFinite(value)) {
    return 'silent or below gate';
  }
  return `${formatNumber(value, 2)} ${unit}`;
}

function artifactLines(data: RenderData): string[] {
  const lines: string[] = [];
  for (const artifact of data.artifacts) {
    lines.push(
      `  ${artifact.role.padEnd(6)} ${artifact.absolutePath} (${artifact.bytes} bytes, sha256 ${artifact.sha256.slice(0, 12)})`,
    );
  }
  if (data.reportFile !== null) {
    lines.push(`  report ${data.reportFile.absolutePath}`);
  } else {
    lines.push('  report disabled');
  }
  return lines;
}

function warningLines(warnings: RenderWarnings): string[] {
  const all = [
    ...warnings.validation.map((issue) => `[${issue.code}] ${issue.path}: ${issue.message}`),
    ...warnings.audio.map((issue) => `[${issue.code}] ${issue.path}: ${issue.message}`),
  ];
  if (all.length === 0) {
    return ['Warnings: none'];
  }
  return [`Warnings (${all.length}):`, ...all.map((line) => `  - ${line}`)];
}

function humanResult(data: RenderData): string {
  const report = data.report;
  return [
    `Rendered "${report.title}"`,
    `Source: ${data.resolvedPath}`,
    `Output: ${data.outputDir}`,
    `Format: ${data.format} at ${data.sampleRate} Hz`,
    `Backend: ${report.backend.id}${report.backend.version === null ? '' : ` (${report.backend.version})`} [${data.backendSelection.requested}]`,
    `Backend note: ${data.backendSelection.note}`,
    `Duration: ${formatNumber(report.duration.actualSeconds, 3)} s (${report.duration.actualFrames} frames)`,
    `Stems: ${report.stems.length}`,
    `Peak: ${formatLevel(report.audio.peakDbfs, 'dBFS')}`,
    report.audio.mastering.applied
      ? `Mastering: normalized ${report.audio.mastering.gainDb >= 0 ? '+' : ''}${formatNumber(report.audio.mastering.gainDb, 2)} dB to ${formatLevel(report.audio.mastering.targetDbfs, 'dBFS')}`
      : 'Mastering: off',
    `Integrated loudness: ${formatLevel(report.audio.loudness.integratedLufs, 'LUFS')}`,
    `Clipped samples: ${report.audio.clipping.clippedSampleCount}`,
    'Artifacts:',
    ...artifactLines(data),
    ...warningLines(data.warnings),
  ].join('\n');
}

interface BackendSelection {
  readonly requested: RenderBackendRequest;
  readonly backend: RenderBackendChoice;
  readonly audioBackend: AudioBackend | undefined;
  readonly binaryPath: string | null;
  readonly soundFont: string | null;
  readonly projectRoot: string | null;
  readonly note: string;
  readonly missingDependencies: readonly string[];
}

function usesSampleInstruments(document: unknown): boolean {
  if (typeof document !== 'object' || document === null) {
    return false;
  }
  const tracks = (document as { readonly tracks?: unknown }).tracks;
  if (!Array.isArray(tracks)) {
    return false;
  }
  return tracks.some((track) => {
    if (typeof track !== 'object' || track === null) {
      return false;
    }
    const instrument = (track as { readonly instrument?: unknown }).instrument;
    if (typeof instrument !== 'object' || instrument === null) {
      return false;
    }
    const type = (instrument as { readonly type?: unknown }).type;
    return type === 'gm' || type === 'soundfont' || type === 'sfz';
  });
}

async function selectBackend(
  parsed: ParsedArgs,
  resolvedSongPath: string,
  cwd: string,
): Promise<
  | { readonly ok: true; readonly value: BackendSelection }
  | { readonly ok: false; readonly failure: CommandFailure }
> {
  const requested = (getStringOption(parsed, 'backend') ?? AUTO_BACKEND).trim().toLowerCase();
  const fluidsynthPath = getStringOption(parsed, 'fluidsynth-path');
  const soundFontOption = getStringOption(parsed, 'soundfont');
  const projectRootOption = getStringOption(parsed, 'project-root');
  const verify = hasFlag(parsed, 'verify-soundfont');

  if (
    requested !== AUTO_BACKEND &&
    requested !== BUILTIN_BACKEND &&
    requested !== FLUIDSYNTH_BACKEND
  ) {
    return {
      ok: false,
      failure: usage(
        'render',
        'cli.usage.invalid_option_value',
        `unsupported backend "${requested}"`,
        'Use --backend auto (default), --backend builtin, or --backend fluidsynth.',
      ),
    };
  }

  if (requested === BUILTIN_BACKEND) {
    if (
      fluidsynthPath !== undefined ||
      soundFontOption !== undefined ||
      projectRootOption !== undefined ||
      verify
    ) {
      return {
        ok: false,
        failure: usage(
          'render',
          'cli.usage.invalid_option_combination',
          'FluidSynth options require --backend fluidsynth',
          'Pass --backend fluidsynth together with --fluidsynth-path, --soundfont, --project-root, or --verify-soundfont. The built-in backend ignores none of them silently.',
        ),
      };
    }
    return {
      ok: true,
      value: {
        requested,
        backend: 'builtin',
        audioBackend: undefined,
        binaryPath: null,
        soundFont: null,
        projectRoot: null,
        note: 'Builtin backend selected explicitly. Timbres are synthesized and no SoundFont is used.',
        missingDependencies: [],
      },
    };
  }

  if (requested === AUTO_BACKEND) {
    const configuredBinary =
      fluidsynthPath ?? optionFromEnvironment('VAMP_FLUIDSYNTH_PATH') ?? 'fluidsynth';
    const binaryPath =
      configuredBinary.includes('/') || configuredBinary.includes('\\')
        ? absoluteFrom(cwd, configuredBinary)
        : configuredBinary;
    const soundFontRaw = soundFontOption ?? optionFromEnvironment('VAMP_SOUNDFONT_PATH');
    if (soundFontRaw !== undefined && soundFontRaw.trim() === '') {
      return {
        ok: false,
        failure: usage(
          'render',
          'cli.usage.missing_option_value',
          '--soundfont requires a non-empty value',
          'Pass an absolute path to a trusted General MIDI SoundFont, or omit it to auto-detect a local font.',
        ),
      };
    }
    const explicitSoundFont =
      soundFontRaw === undefined ? null : absoluteFrom(cwd, soundFontRaw.trim());
    const projectRoot =
      projectRootOption === undefined
        ? dirname(resolvedSongPath)
        : absoluteFrom(cwd, projectRootOption);
    const selection = await selectAutomaticBackend({
      binaryPath,
      ...(explicitSoundFont === null ? {} : { soundFontPath: explicitSoundFont }),
      projectRoot,
      fluidSynth: { verifyGmSoundFontChecksum: verify },
    });

    if (selection.id === 'fluidsynth') {
      return {
        ok: true,
        value: {
          requested,
          backend: 'fluidsynth',
          audioBackend: selection.backend,
          binaryPath,
          soundFont: selection.soundFont.path,
          projectRoot,
          note: selection.note,
          missingDependencies: [],
        },
      };
    }

    if (fluidsynthPath !== undefined && !selection.executable.available) {
      const error: CliError = {
        code: 'audio.backend.missing_dependency',
        message: `The FluidSynth executable "${binaryPath}" was not found.`,
        hint: addCliBackendHint(
          'audio.backend.missing_dependency',
          'Install FluidSynth 2.x or point --fluidsynth-path at an absolute path or PATH name.',
        ),
        path: binaryPath,
        details: { backend: 'auto', binaryPath },
      };
      return { ok: false, failure: failure(error, formatError('render', error)) };
    }
    if (soundFontOption !== undefined && !selection.soundFont.available) {
      const error: CliError = {
        code: 'audio.asset.missing',
        message: `The configured SoundFont "${explicitSoundFont ?? ''}" is missing or not a usable .sf2/.sf3 file.`,
        hint: 'Point --soundfont or VAMP_SOUNDFONT_PATH at a provisioned General MIDI SoundFont, or omit it to auto-detect one.',
        ...(explicitSoundFont === null ? {} : { path: explicitSoundFont }),
        details: { backend: 'auto' },
      };
      return { ok: false, failure: failure(error, formatError('render', error)) };
    }

    if (!parsed.json) {
      writeStderr(`Backend auto-selection: ${selection.note}`);
    }
    return {
      ok: true,
      value: {
        requested,
        backend: 'builtin',
        audioBackend: undefined,
        binaryPath: selection.executable.path,
        soundFont: selection.soundFont.path,
        projectRoot,
        note: selection.note,
        missingDependencies: selection.missingDependencies,
      },
    };
  }

  const configuredBinary =
    fluidsynthPath ?? optionFromEnvironment('VAMP_FLUIDSYNTH_PATH') ?? 'fluidsynth';
  const binaryPath =
    configuredBinary.includes('/') || configuredBinary.includes('\\')
      ? absoluteFrom(cwd, configuredBinary)
      : configuredBinary;
  if (binaryPath.trim() === '') {
    return {
      ok: false,
      failure: usage(
        'render',
        'cli.usage.missing_option_value',
        '--fluidsynth-path requires a non-empty value',
        'Pass an absolute FluidSynth path or an executable name available on PATH.',
      ),
    };
  }
  const soundFontRaw = soundFontOption ?? optionFromEnvironment('VAMP_SOUNDFONT_PATH');
  if (soundFontRaw !== undefined && soundFontRaw.trim() === '') {
    return {
      ok: false,
      failure: usage(
        'render',
        'cli.usage.missing_option_value',
        '--soundfont requires a non-empty value',
        'Pass an absolute path to a trusted General MIDI SoundFont.',
      ),
    };
  }
  if (projectRootOption !== undefined && projectRootOption.trim() === '') {
    return {
      ok: false,
      failure: usage(
        'render',
        'cli.usage.missing_option_value',
        '--project-root requires a non-empty value',
        'Pass the project directory that contains song assets, or omit it to use the song file directory.',
      ),
    };
  }

  if (!(await isFluidSynthBinaryAvailable(binaryPath))) {
    const error: CliError = {
      code: 'audio.backend.missing_dependency',
      message: `The FluidSynth executable "${binaryPath}" was not found.`,
      hint: addCliBackendHint(
        'audio.backend.missing_dependency',
        'Install FluidSynth 2.x or point --fluidsynth-path at an absolute path or PATH name.',
      ),
      path: binaryPath,
      details: { backend: 'fluidsynth', binaryPath },
    };
    return { ok: false, failure: failure(error, formatError('render', error)) };
  }

  const soundFont = soundFontRaw === undefined ? null : absoluteFrom(cwd, soundFontRaw.trim());
  const projectRoot =
    projectRootOption === undefined
      ? dirname(resolvedSongPath)
      : absoluteFrom(cwd, projectRootOption);

  return {
    ok: true,
    value: {
      requested,
      backend: 'fluidsynth',
      audioBackend: createFluidSynthBackend({
        binaryPath,
        ...(soundFont === null ? {} : { gmSoundFont: soundFont }),
        projectRoot,
        verifyGmSoundFontChecksum: verify,
      }),
      binaryPath,
      soundFont,
      projectRoot,
      note:
        soundFont === null
          ? 'FluidSynth selected explicitly without a configured GM SoundFont; gm and curated instruments will fail until a SoundFont is provisioned.'
          : `FluidSynth selected explicitly with ${soundFont}.`,
      missingDependencies: [],
    },
  };
}

export async function runRender(args: readonly string[]): Promise<CommandOutcome<RenderData>> {
  const parsed = parseArgs('render', args, OPTIONS);
  if (!parsed.ok) {
    return usageFailure('render', {
      code: parsed.error.code,
      message: parsed.error.message,
      hint: parsed.error.hint,
    });
  }
  if (parsed.value.help) {
    return { kind: 'text', text: commandHelp('render') ?? '' };
  }

  if (parsed.value.positionals.length === 0) {
    return usage(
      'render',
      'cli.usage.missing_argument',
      'missing required argument <file>',
      'Pass one JSON song file. Run "vamp render --help" for details.',
    );
  }
  if (parsed.value.positionals.length > 1) {
    return usage(
      'render',
      'cli.usage.unexpected_argument',
      `unexpected argument "${parsed.value.positionals[1] ?? ''}"`,
      'Pass exactly one song file. Run "vamp render --help" for details.',
    );
  }

  const formatOption = getStringOption(parsed.value, 'format') ?? DEFAULT_FORMAT;
  const format = formatOption.trim().toLowerCase();
  if (format !== 'wav') {
    if (format === 'mp3') {
      return usage(
        'render',
        'cli.usage.unsupported_format',
        'MP3 output is not supported',
        MP3_DEFERRED_HINT,
      );
    }
    return usage(
      'render',
      'cli.usage.unsupported_format',
      `unsupported format "${formatOption}"`,
      'Use --format wav. WAV is the only supported render format; MP3 export is deferred.',
    );
  }

  for (const [positive, negative] of [
    ['stems', 'no-stems'],
    ['midi', 'no-midi'],
    ['report', 'no-report'],
    ['normalize', 'no-normalize'],
  ] as const) {
    const conflict = conflictingBooleans(parsed.value, positive, negative);
    if (conflict !== null) {
      return conflict;
    }
  }

  const sampleRateOption = getStringOption(parsed.value, 'sample-rate');
  let sampleRate: SampleRate = DEFAULT_SAMPLE_RATE;
  if (sampleRateOption !== undefined) {
    if (sampleRateOption === '44100') {
      sampleRate = 44_100;
    } else if (sampleRateOption === '48000') {
      sampleRate = 48_000;
    } else {
      return usage(
        'render',
        'cli.usage.invalid_option_value',
        `unsupported sample rate "${sampleRateOption}"`,
        'Use --sample-rate 44100 or --sample-rate 48000. Audio is never resampled.',
      );
    }
  }

  const outOption = getStringOption(parsed.value, 'out');
  if (outOption === undefined || outOption.trim() === '') {
    return usage(
      'render',
      'cli.usage.missing_option',
      'missing required option --out <directory>',
      'Pass an output directory such as --out out. A new directory is published atomically; its parent must exist.',
    );
  }

  const file = parsed.value.positionals[0] ?? '';
  const read = await readSongDocument(file);
  if (!read.ok) {
    return failure(read.error, formatError('render', read.error), {
      warnings: read.warnings,
    });
  }

  const cwd = process.cwd();
  const selection = await selectBackend(parsed.value, read.value.resolvedPath, cwd);
  if (!selection.ok) {
    return selection.failure;
  }

  if (
    selection.value.requested === 'auto' &&
    selection.value.backend === 'builtin' &&
    usesSampleInstruments(read.value.document)
  ) {
    const missing =
      selection.value.missingDependencies.length === 0
        ? 'FluidSynth and a GM SoundFont'
        : selection.value.missingDependencies
            .map((dependency) =>
              dependency === 'executable' ? 'the FluidSynth executable' : 'a GM SoundFont',
            )
            .join(' and ');
    const error: CliError = {
      code: 'audio.backend.missing_dependency',
      message: `This song uses gm, soundfont, or sfz instruments, but auto selection could only use the builtin synth because ${missing} was not found.`,
      hint: `Run "vamp doctor" to check setup. Install FluidSynth 2.x and a GM SoundFont (Debian/Ubuntu: sudo apt install fluidsynth fluid-soundfont-gm), set VAMP_SOUNDFONT_PATH, or render a song that uses only the six curated builtin IDs. The builtin synth cannot play GM instruments.`,
      details: {
        backend: 'auto',
        selected: 'builtin',
        missingDependencies: selection.value.missingDependencies.join(', '),
        note: selection.value.note,
      },
    };
    return failure(error, formatError('render', error));
  }

  const stems = hasFlag(parsed.value, 'no-stems')
    ? false
    : hasFlag(parsed.value, 'stems')
      ? true
      : undefined;
  const midi = hasFlag(parsed.value, 'no-midi')
    ? false
    : hasFlag(parsed.value, 'midi')
      ? true
      : undefined;
  const report = hasFlag(parsed.value, 'no-report')
    ? false
    : hasFlag(parsed.value, 'report')
      ? true
      : undefined;
  const overwrite = hasFlag(parsed.value, 'overwrite');
  const normalize = hasFlag(parsed.value, 'no-normalize')
    ? false
    : hasFlag(parsed.value, 'normalize')
      ? true
      : true;
  const outputDir = absoluteFrom(cwd, outOption);

  const controller = new AbortController();
  let interruptionSignal: string | null = null;
  const interrupt = (signal: string): void => {
    if (!controller.signal.aborted) {
      interruptionSignal = signal;
      controller.abort();
      if (!parsed.value.json) {
        writeStderr(`Interrupted by ${signal}; cleaning up render output...`);
      }
    }
  };
  const onSigint = (): void => interrupt('SIGINT');
  const onSigterm = (): void => interrupt('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);

  try {
    if (!parsed.value.json) {
      writeStderr(
        `Rendering "${read.value.file}" to ${outputDir} at ${sampleRate} Hz with the ${selection.value.backend} backend...`,
      );
    }

    const result = await renderSongArtifacts(read.value.document, {
      outputDir,
      sampleRate,
      ...(selection.value.audioBackend === undefined
        ? {}
        : { backend: selection.value.audioBackend }),
      ...(stems === undefined ? {} : { stems }),
      ...(midi === undefined ? {} : { midi }),
      ...(report === undefined ? {} : { report }),
      overwrite,
      mastering: { normalize },
      validation: INSTRUMENT_REGISTRY_VALIDATION,
      signal: controller.signal,
    });

    if (!result.ok) {
      return renderFailure(result, interruptionSignal, read.value.file);
    }

    const artifacts: RenderArtifactData[] = result.artifacts.map((artifact) => ({
      ...artifact,
      absolutePath: resolve(result.outputDir, artifact.path),
    }));
    const reportName = result.report.outputs.report;
    const reportFile: RenderFileReference | null =
      reportName === null
        ? null
        : { path: reportName, absolutePath: resolve(result.outputDir, reportName) };
    const warnings: RenderWarnings = {
      validation: result.validationWarnings,
      audio: result.warnings,
    };
    const data: RenderData = {
      file: read.value.file,
      resolvedPath: read.value.resolvedPath,
      outputDir: result.outputDir,
      format: 'wav',
      sampleRate,
      backend: selection.value.backend,
      backendSelection: {
        requested: selection.value.requested,
        selected: selection.value.backend,
        note: selection.value.note,
      },
      artifacts,
      reportFile,
      outputs: result.report.outputs,
      report: result.report,
      warnings,
      summary: {
        title: result.report.title,
        durationSeconds: result.report.duration.actualSeconds,
        sampleRate,
        backend: result.report.backend.id,
        artifactCount: artifacts.length + (reportFile === null ? 0 : 1),
        stemCount: result.report.stems.length,
        midi: result.report.outputs.midi !== null,
        report: reportFile !== null,
        peakDbfs: result.report.audio.peakDbfs,
        integratedLufs: result.report.audio.loudness.integratedLufs,
      },
    };

    return success(data, result.validationWarnings, humanResult(data));
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  }
}
