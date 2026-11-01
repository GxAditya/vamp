/**
 * Task 19 adversarial security suite for the v1 execution path.
 *
 * These tests run on every supported platform unless a case genuinely needs
 * POSIX process semantics. They cover the audit list from Task 19:
 *
 * - Shell-injection safety: the native backend spawns with argument arrays
 *   and `shell: false`; song-authored asset paths containing shell
 *   metacharacters, spaces, and Unicode arrive verbatim as single argv
 *   entries and never execute.
 * - Environment leakage: children receive only the minimal sanitized
 *   environment plus explicit configuration overrides. Parent secrets are
 *   never inherited.
 * - Subprocess timeout and cleanup: a hung child is killed inside its bounded
 *   lifetime and the per-render temporary directory is removed.
 * - Offline guarantee: a static scan of every shipped `src` tree rejects
 *   network APIs and shell execution outright.
 * - Windows resolver semantics (`PATHEXT`) are exercised through a pure
 *   helper so the behavior is testable on any host. macOS/Windows path
 *   semantics that cannot be faked run in
 *   `packages/project/test/security-platform.test.ts` behind platform gates.
 *
 * The lexical path confinement matrix lives next to the store itself in
 * `packages/project/test/security-adversarial.test.ts`.
 */

import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import {
  buildFluidSynthArguments,
  createFluidSynthBackend,
  fluidSynthExecutableCandidates,
  renderSongAudio,
  type SongSchemaV1,
} from '@gxaditya/vamp-sdk';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const posixOnly = process.platform !== 'win32';
const secretToken = `vamp-secret-${randomBytes(8).toString('hex')}`;

const temporaryRoots: string[] = [];

afterAll(() => {
  for (const root of temporaryRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(prefix = 'vamp-security-'): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temporaryRoots.push(root);
  return root;
}

function writeFakeSoundFont(path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  const buffer = Buffer.alloc(24);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(16, 4);
  buffer.write('sfbk', 8, 'ascii');
  buffer.write('LIST', 12, 'ascii');
  writeFileSync(path, buffer);
  return path;
}

function writeScript(path: string, body: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

/**
 * A 44-byte zero-frame 16-bit stereo 48 kHz WAV header written with POSIX
 * printf octal escapes. The fake backend uses it to complete a successful
 * render without a real FluidSynth install.
 */
const FAKE_WAV_PRINTF =
  "printf 'RIFF\\044\\000\\000\\000WAVEfmt \\020\\000\\000\\000\\001\\000\\002\\000\\200\\273\\000\\000\\240\\356\\002\\000\\004\\000\\020\\000data\\000\\000\\000\\000'";

function soundfontSong(instrumentPath: string, title: string): SongSchemaV1 {
  return {
    schemaVersion: '1.0.0',
    meta: {
      title,
      bpm: 120,
      timeSignature: { numerator: 4, denominator: 4 },
      key: { tonic: 'C', mode: 'major' },
      seed: 7,
      durationHint: 1,
    },
    tracks: [
      {
        id: 'font-track',
        name: 'font track; $(id) `whoami` 背景',
        kind: 'midi',
        channel: 0,
        instrument: { type: 'soundfont', path: instrumentPath, program: 0, bank: 0 },
        notes: [{ pitch: 60, start: 0, duration: 0.5, velocity: 90 }],
      },
    ],
  };
}

async function waitForProcessExit(pid: number, limitMs: number): Promise<boolean> {
  const deadline = Date.now() + limitMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (Date.now() > deadline) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('native subprocess shell-injection and environment safety (POSIX)', () => {
  it.skipIf(!posixOnly)(
    'song-authored metacharacter asset paths reach the child as single argv entries, the environment is sanitized, and the temporary directory is cleaned up',
    async () => {
      const root = tempRoot();
      const capture = join(root, 'capture');
      mkdirSync(capture);

      // Names that would be executed as shell commands if any caller ever
      // interpolated song paths into a shell string. The `touch` targets sit
      // in the persistent capture directory so the test can prove they were
      // never created.
      const dollarName = `assets/$(touch ${join(capture, 'injected-dollar')}).sf2`;
      const plainName = 'assets/soft; pad 背景.sf2';
      writeFakeSoundFont(join(root, dollarName));
      writeFakeSoundFont(join(root, plainName));

      // The fake executable records argv, env, cwd, and its pid, then emits a
      // minimal valid WAV so the render completes on the success path.
      const fake = writeScript(
        join(root, 'bin', 'fake fluidsynth'),
        [
          'env > "$VAMP_CAPTURE_DIR/env.txt"',
          ': > "$VAMP_CAPTURE_DIR/argv.txt"',
          'for a in "$@"; do printf \'%s\\n\' "$a" >> "$VAMP_CAPTURE_DIR/argv.txt"; done',
          'pwd > "$VAMP_CAPTURE_DIR/cwd.txt"',
          'echo $$ > "$VAMP_CAPTURE_DIR/pid.txt"',
          `${FAKE_WAV_PRINTF} > "$4"`,
          'exit 0',
        ].join('\n'),
      );

      // A parent-environment secret must never be inherited by the child.
      process.env.VAMP_SECURITY_PARENT_SECRET = secretToken;
      try {
        const backend = createFluidSynthBackend({
          binaryPath: fake,
          projectRoot: root,
          environment: { VAMP_CAPTURE_DIR: capture, VAMP_TEST_OVERRIDE: 'child-visible' },
        });
        const rendered = await renderSongAudio(soundfontSong(dollarName, 'Injection probe'), {
          sampleRate: 48000,
          backend,
        });
        expect(rendered.ok, JSON.stringify(rendered.ok ? {} : rendered.errors)).toBe(true);

        const argv = readFileSync(join(capture, 'argv.txt'), 'utf8').trimEnd().split('\n');
        // The pinned offline command line arrives as separate argv entries.
        // The SoundFont path is a single element even though it contains
        // `$()`, spaces, and Unicode, and it is second-to-last as the pinned
        // argument array specifies.
        const expectedLength = buildFluidSynthArguments({
          wavPath: 'w.wav',
          sampleRate: 48000,
          maxVoices: 32,
          soundFontPath: 'f.sf2',
          midiPath: 't.mid',
        }).length;
        expect(argv.length).toBe(expectedLength);
        expect(argv.slice(0, 2)).toEqual(['-ni', '-q']);
        expect(argv).toContain(join(root, dollarName));
        expect(String(argv[argv.length - 1])).toMatch(/track\.mid$/);
        const flagIndex = argv.indexOf('-F');
        expect(flagIndex).toBeGreaterThan(-1);
        expect(String(argv[flagIndex + 1])).toMatch(/track\.wav$/);
        // No argument was word-split by a shell: no element starts a command.
        for (const entry of argv) {
          expect(/^\s*(touch|rm|id|whoami)$/.test(entry)).toBe(false);
        }

        // Nothing was executed: no marker file exists in the capture dir.
        expect(existsSync(join(capture, 'injected-dollar'))).toBe(false);

        const envDump = readFileSync(join(capture, 'env.txt'), 'utf8');
        expect(envDump).not.toContain('VAMP_SECURITY_PARENT_SECRET');
        expect(envDump).not.toContain(secretToken);
        expect(envDump).toContain('VAMP_TEST_OVERRIDE=child-visible');
        expect(envDump).toContain('LC_ALL=C');
        const childHome = /^HOME=(.*)$/m.exec(envDump)?.[1] ?? '';
        const childTmp = /^TMPDIR=(.*)$/m.exec(envDump)?.[1] ?? '';
        // HOME, TMPDIR, and the process cwd all point at the per-render
        // temporary jail (realpath differences aside on platforms that mount
        // /tmp through a symlink).
        expect(childHome).toMatch(/vamp-fluid-/);
        expect(childTmp).toBe(childHome);
        const cwd = readFileSync(join(capture, 'cwd.txt'), 'utf8').trim();
        expect(cwd).toMatch(/vamp-fluid-/);

        // The child process exited and its temporary directory was removed.
        const pid = Number(readFileSync(join(capture, 'pid.txt'), 'utf8').trim());
        expect(await waitForProcessExit(pid, 2_000)).toBe(true);
        expect(existsSync(cwd)).toBe(false);
      } finally {
        delete process.env.VAMP_SECURITY_PARENT_SECRET;
      }
    },
    30_000,
  );

  it.skipIf(!posixOnly)(
    'backtick asset variants also survive as inert file names',
    async () => {
      const root = tempRoot();
      const capture = join(root, 'capture');
      mkdirSync(capture);
      const backtickName = 'assets/`touch ' + join(capture, 'injected-backtick') + '`.sf2';
      writeFakeSoundFont(join(root, backtickName));
      const fake = writeScript(
        join(root, 'bin', 'fake fluidsynth'),
        [
          ': > "$VAMP_CAPTURE_DIR/argv.txt"',
          'for a in "$@"; do printf \'%s\\n\' "$a" >> "$VAMP_CAPTURE_DIR/argv.txt"; done',
          'exit 1',
        ].join('\n'),
      );
      const backend = createFluidSynthBackend({
        binaryPath: fake,
        projectRoot: root,
        environment: { VAMP_CAPTURE_DIR: capture },
      });
      const rendered = await renderSongAudio(soundfontSong(backtickName, 'Backtick probe'), {
        sampleRate: 48000,
        backend,
      });
      expect(rendered.ok).toBe(false);
      if (!rendered.ok) {
        expect(rendered.errors[0]?.code).toBe('audio.backend.process_failed');
      }
      const argv = readFileSync(join(capture, 'argv.txt'), 'utf8').trimEnd().split('\n');
      expect(argv).toContain(join(root, backtickName));
      expect(existsSync(join(capture, 'injected-backtick'))).toBe(false);
    },
    30_000,
  );

  it.skipIf(!posixOnly)(
    'a hung child is killed at the bounded timeout and its temporary directory is removed',
    async () => {
      const root = tempRoot();
      const capture = join(root, 'capture');
      mkdirSync(capture);
      const assetName = 'assets/hung; probe 背景.sf2';
      writeFakeSoundFont(join(root, assetName));
      const fake = writeScript(
        join(root, 'bin', 'fake fluidsynth'),
        [
          'pwd > "$VAMP_CAPTURE_DIR/cwd.txt"',
          'echo $$ > "$VAMP_CAPTURE_DIR/pid.txt"',
          'sleep 30',
        ].join('\n'),
      );
      const backend = createFluidSynthBackend({
        binaryPath: fake,
        projectRoot: root,
        timeoutMs: 300,
        environment: { VAMP_CAPTURE_DIR: capture },
      });
      const started = Date.now();
      const rendered = await renderSongAudio(soundfontSong(assetName, 'Timeout probe'), {
        sampleRate: 48000,
        backend,
      });
      expect(rendered.ok).toBe(false);
      if (!rendered.ok) {
        expect(rendered.errors[0]?.code).toBe('audio.backend.timeout');
      }
      expect(Date.now() - started).toBeLessThan(10_000);

      const cwd = readFileSync(join(capture, 'cwd.txt'), 'utf8').trim();
      const pid = Number(readFileSync(join(capture, 'pid.txt'), 'utf8').trim());
      // The whole detached process group is SIGKILLed at the deadline, and
      // the per-render temporary directory is cleaned in the finally block.
      expect(await waitForProcessExit(pid, 3_000)).toBe(true);
      expect(existsSync(cwd)).toBe(false);
    },
    30_000,
  );

  it.skipIf(!posixOnly)(
    'the version probe runs the argument array with a sanitized environment',
    async () => {
      const root = tempRoot();
      const capture = join(root, 'capture');
      mkdirSync(capture);
      const fake = writeScript(
        join(root, 'bin', 'fake fluidsynth'),
        [
          'env > "$VAMP_CAPTURE_DIR/env.txt"',
          ': > "$VAMP_CAPTURE_DIR/argv.txt"',
          'for a in "$@"; do printf \'%s\\n\' "$a" >> "$VAMP_CAPTURE_DIR/argv.txt"; done',
          'echo "FluidSynth runtime version 9.9.9"',
        ].join('\n'),
      );
      process.env.VAMP_SECURITY_PARENT_SECRET = secretToken;
      try {
        // Exercise the same sanitized base environment through the probe.
        const backend = createFluidSynthBackend({
          binaryPath: fake,
          environment: { VAMP_CAPTURE_DIR: capture },
        });
        const version = await backend.probeVersion?.();
        expect(version).toBe('9.9.9');
        const argv = readFileSync(join(capture, 'argv.txt'), 'utf8').trim().split('\n');
        expect(argv).toEqual(['--version']);
        const envDump = readFileSync(join(capture, 'env.txt'), 'utf8');
        expect(envDump).not.toContain('VAMP_SECURITY_PARENT_SECRET');
        expect(envDump).not.toContain(secretToken);
        expect(envDump).toContain('LC_ALL=C');
      } finally {
        delete process.env.VAMP_SECURITY_PARENT_SECRET;
      }
    },
    30_000,
  );
});

describe('Windows PATH resolution semantics (pure helper, runs anywhere)', () => {
  it('expands bare names through PATHEXT so a health check sees fluidsynth.exe', () => {
    const candidates = fluidSynthExecutableCandidates('fluidsynth', 'win32', '.EXE;.CMD');
    expect(candidates).toEqual(['fluidsynth', 'fluidsynth.EXE', 'fluidsynth.CMD']);
  });

  it('keeps a name that already carries a known extension', () => {
    expect(fluidSynthExecutableCandidates('C:\\tools\\fluidsynth.exe', 'win32', '.EXE')).toEqual([
      'C:\\tools\\fluidsynth.exe',
    ]);
  });

  it('uses documented defaults when PATHEXT is absent', () => {
    const candidates = fluidSynthExecutableCandidates('fluidsynth', 'win32', undefined);
    // Windows compares names case-insensitively; the helper canonicalizes
    // PATHEXT suffixes to their documented uppercase spelling.
    expect(candidates).toContain('fluidsynth.EXE');
    expect(candidates.length).toBeGreaterThan(1);
  });

  it('is the bare name verbatim on POSIX platforms', () => {
    expect(fluidSynthExecutableCandidates('fluidsynth', 'linux', '.EXE')).toEqual(['fluidsynth']);
    expect(fluidSynthExecutableCandidates('fluidsynth', 'darwin', '.EXE')).toEqual(['fluidsynth']);
  });
});

describe('offline guarantee static scan', () => {
  interface SourceFile {
    readonly path: string;
    readonly text: string;
  }

  function collectSources(): SourceFile[] {
    const files: SourceFile[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          walk(path);
        } else if (entry.isFile() && /\.(ts|js|mjs)$/.test(entry.name)) {
          files.push({ path, text: readFileSync(path, 'utf8') });
        }
      }
    };
    for (const packageName of ['schema', 'engine', 'project', 'cli', 'mcp-server', 'sdk']) {
      const src = join(repoRoot, 'packages', packageName, 'src');
      if (existsSync(src) && statSync(src).isDirectory()) {
        walk(src);
      }
    }
    return files;
  }

  const networkPatterns: readonly RegExp[] = [
    /from ['"]node:https?['"]/,
    /from ['"]node:(?:net|dns|tls|dgram|http2)['"]/,
    /(?<![\w.$])fetch\s*\(/,
    /\bXMLHttpRequest\b/,
    /\bWebSocket\b/,
    /\bEventSource\b/,
    /\bsendBeacon\b/,
    /\baxios\b/,
  ];

  const shellPatterns: readonly RegExp[] = [
    /shell:\s*true/,
    /(?<![\w.$])exec\s*\(/,
    /(?<![\w.$])execSync\s*\(/,
    /(?<![\w.$])spawnSync\s*\(/,
    /(?<![\w.$])eval\s*\(/,
    /\bnew Function\s*\(/,
  ];

  it('scans a non-trivial source surface', () => {
    // Fail loudly if the walk silently found nothing (refactor guard).
    expect(collectSources().length).toBeGreaterThan(40);
  });

  it('ships no network API usage anywhere in package sources', () => {
    for (const file of collectSources()) {
      for (const pattern of networkPatterns) {
        expect(pattern.test(file.text), `${file.path} matches ${String(pattern)}`).toBe(false);
      }
    }
  });

  it('ships no shell execution or dynamic code evaluation anywhere in package sources', () => {
    for (const file of collectSources()) {
      for (const pattern of shellPatterns) {
        expect(pattern.test(file.text), `${file.path} matches ${String(pattern)}`).toBe(false);
      }
    }
  });

  it('restricts child_process to the FluidSynth backend, which always uses shell:false', () => {
    const childProcessUsers = collectSources()
      .filter((file) => /from ['"]node:child_process['"]/.test(file.text))
      .map((file) => file.path.slice(repoRoot.length));
    expect(childProcessUsers).toEqual([
      join('packages', 'engine', 'src', 'audio', 'fluidsynth.ts'),
    ]);
    const fluidsynth = readFileSync(
      join(repoRoot, 'packages', 'engine', 'src', 'audio', 'fluidsynth.ts'),
      'utf8',
    );
    expect(fluidsynth).toContain('shell: false');
    // Every spawn call site passes an argument array, never a command string.
    expect(/spawn\(\s*binaryPath,\s*\[\.\.\.args\]/.test(fluidsynth)).toBe(true);
  });
});
