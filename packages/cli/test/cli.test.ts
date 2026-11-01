import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const cliBin = fileURLToPath(new URL('../bin/vamp.js', import.meta.url));
const cliEntry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as {
  version: string;
  bin: Record<string, string>;
};

const temporaryDirectories: string[] = [];

function tempDirectory(prefix = 'vamp-cli-'): string {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  temporaryDirectories.push(directory);
  return directory;
}

function runCli(args: readonly string[], options: { readonly cwd?: string } = {}) {
  return spawnSync(process.execPath, [cliBin, ...args], {
    cwd: options.cwd ?? repoRoot,
    encoding: 'utf8',
    timeout: 30_000,
  });
}

function parseEnvelope(result: ReturnType<typeof runCli>): Record<string, unknown> {
  expect(result.stderr).toBe('');
  const envelope = JSON.parse(result.stdout) as Record<string, unknown>;
  expect(typeof envelope).toBe('object');
  return envelope;
}

function writeFile(directory: string, name: string, content: string): string {
  const path = join(directory, name);
  writeFileSync(path, content, 'utf8');
  return path;
}

function writeJson(directory: string, name: string, value: unknown): string {
  return writeFile(directory, name, JSON.stringify(value, null, 2));
}

function minimalSong(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: '1.0.0',
    meta: {
      title: 'CLI Test Song',
      bpm: 90,
      timeSignature: { numerator: 4, denominator: 4 },
      key: { tonic: 'C', mode: 'major' },
      seed: 1,
      durationHint: 8,
    },
    tracks: [
      {
        id: 'keys',
        name: 'Keys',
        kind: 'midi',
        channel: 0,
        instrument: { type: 'builtin', id: 'keys.soft' },
        notes: [{ pitch: 60, start: 0, duration: 4 }],
      },
    ],
    ...overrides,
  };
}

afterAll(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('vamp CLI help and version', () => {
  it('prints command help and exits 0 for --help', () => {
    const result = runCli(['--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: vamp <command> [options]');
    expect(result.stdout).toContain('init');
    expect(result.stdout).toContain('validate');
    expect(result.stdout).toContain('info');
    expect(result.stdout).toContain('render');
    expect(result.stdout).toContain('schema');
    expect(result.stdout).toContain('MP3 export and play are not implemented');
    expect(result.stdout).toContain('Exit codes:');
    expect(result.stderr).toBe('');
  });

  it('prints help and exits 0 when invoked without arguments', () => {
    const result = runCli([]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: vamp');
    expect(result.stderr).toBe('');
  });

  it('prints command-specific help', () => {
    for (const command of ['init', 'validate', 'info', 'render', 'schema']) {
      const result = runCli([command, '--help']);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`Usage: vamp ${command}`);
      expect(result.stderr).toBe('');
    }

    const helpResult = runCli(['help', 'validate']);
    expect(helpResult.status).toBe(0);
    expect(helpResult.stdout).toContain('Usage: vamp validate');

    const shortHelp = runCli(['validate', '-h']);
    expect(shortHelp.status).toBe(0);
    expect(shortHelp.stdout).toContain('Usage: vamp validate');
  });

  it('prints the package version and exits 0 for --version', () => {
    const result = runCli(['--version']);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`vamp ${packageJson.version}\n`);
    expect(result.stderr).toBe('');
  });

  it.each([
    ['-h', 'Usage: vamp'],
    ['-v', `vamp ${packageJson.version}`],
    ['help', 'Usage: vamp'],
    ['version', `vamp ${packageJson.version}`],
  ])('supports the %s alias', (argument, expected) => {
    const result = runCli([argument]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(expected);
    expect(result.stderr).toBe('');
  });

  it('rejects unknown commands with exit code 2', () => {
    const result = runCli(['compose']);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('unknown command');
    expect(result.stderr).toContain('vamp --help');
  });

  it('rejects unexpected arguments with a usage error', () => {
    const result = runCli(['--help', 'extra']);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('unexpected argument');
  });

  it('rejects missing positional arguments with exit code 2 and a JSON envelope', () => {
    const result = runCli(['validate', '--json']);
    const envelope = parseEnvelope(result);

    expect(result.status).toBe(2);
    expect(envelope).toMatchObject({
      command: 'validate',
      ok: false,
      error: { code: 'cli.usage.missing_argument' },
    });
  });

  it('works through the built entrypoint directly', () => {
    const result = spawnSync(process.execPath, [cliEntry, '--version'], { encoding: 'utf8' });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`vamp ${packageJson.version}\n`);
  });

  it('is directly executable through its shebang on Unix-like systems', () => {
    if (process.platform === 'win32') {
      return;
    }

    const result = spawnSync(cliBin, ['--version'], { encoding: 'utf8' });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`vamp ${packageJson.version}\n`);
  });

  it('wires the vamp bin to an executable launcher that runs the build output', () => {
    expect(packageJson.bin).toEqual({ vamp: './bin/vamp.js' });

    expect(readFileSync(cliBin, 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true);
    expect(readFileSync(cliEntry, 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true);
    expect(readFileSync(cliBin, 'utf8')).toContain('../dist/index.js');

    if (process.platform !== 'win32') {
      expect(statSync(cliBin).mode & 0o111).not.toBe(0);
      expect(statSync(cliEntry).mode & 0o111).not.toBe(0);
    }
  });
});

describe('vamp init, validate, and info workflow', () => {
  it('creates a project, validates its song, and inspects it with JSON envelopes', () => {
    const workspace = tempDirectory();
    const projectsRoot = join(workspace, 'projects');

    const init = runCli(['init', 'demo', '--root', projectsRoot, '--json'], { cwd: workspace });
    const initEnvelope = parseEnvelope(init);

    expect(init.status).toBe(0);
    expect(initEnvelope).toMatchObject({
      command: 'init',
      ok: true,
      warnings: [],
      data: {
        projectId: 'demo',
        revision: 1,
        title: 'Vamp Demo',
        overwritten: false,
      },
    });

    const data = initEnvelope.data as Record<string, unknown>;
    const projectDirectory = String(data.projectDirectory);
    expect(projectDirectory).toBe(join(projectsRoot, 'demo'));
    expect(data.nextCommands).toContain('vamp schema --guide');
    expect(existsSync(join(projectDirectory, 'song.json'))).toBe(true);
    expect(existsSync(join(projectDirectory, 'assets'))).toBe(true);
    expect(existsSync(join(projectDirectory, 'renders'))).toBe(true);
    expect(existsSync(join(projectDirectory, '.vamp-project.json'))).toBe(true);

    const relativeSong = 'projects/demo/song.json';
    const validate = runCli(['validate', relativeSong, '--json'], { cwd: workspace });
    const validateEnvelope = parseEnvelope(validate);
    expect(validate.status).toBe(0);
    expect(validateEnvelope).toMatchObject({
      command: 'validate',
      ok: true,
      warnings: [],
      data: {
        file: relativeSong,
        schemaVersion: '1.0.0',
        capabilityCheck: 'not_checked',
        counts: { tracks: 3, midiTracks: 2, drumTracks: 1 },
      },
    });

    const info = runCli(['info', relativeSong, '--json'], { cwd: workspace });
    const infoEnvelope = parseEnvelope(info);
    expect(info.status).toBe(0);
    expect(infoEnvelope).toMatchObject({
      command: 'info',
      ok: true,
      warnings: [],
      data: {
        title: 'Vamp Demo',
        bpm: 90,
        schemaVersion: '1.0.0',
        seed: 11,
        timeSignature: { numerator: 4, denominator: 4 },
        key: { tonic: 'C', mode: 'major' },
      },
    });

    const infoData = infoEnvelope.data as Record<string, unknown>;
    const counts = infoData.counts as Record<string, number>;
    expect(counts.tracks).toBe(3);
    expect(counts.freeNotes).toBeGreaterThan(0);
    expect(counts.expandedEvents).toBe(counts.freeNotes);
    expect(infoData.tracks).toHaveLength(3);
    expect(infoData.instruments).toHaveLength(3);

    const human = runCli(['info', relativeSong], { cwd: workspace });
    expect(human.status).toBe(0);
    expect(human.stdout).toContain('Song information');
    expect(human.stdout).toContain('Title: Vamp Demo');
    expect(human.stdout).toContain('Tempo: 90 BPM');
    expect(human.stderr).toBe('');

    const humanInit = runCli(['init', 'human-demo', '--root', join(workspace, 'human-projects')], {
      cwd: workspace,
    });
    expect(humanInit.status).toBe(0);
    expect(humanInit.stdout).toContain('Created project "human-demo"');
    expect(humanInit.stdout).toContain('Project directory:');
    expect(humanInit.stdout).toContain('Song file:');
    expect(humanInit.stdout).toContain('vamp validate');
    expect(humanInit.stderr).toBe('');
  });

  it('uses ./vamp-projects and the demo id by default', () => {
    const workspace = tempDirectory();
    const result = runCli(['init', '--json'], { cwd: workspace });
    const envelope = parseEnvelope(result);

    expect(result.status).toBe(0);
    const data = envelope.data as Record<string, unknown>;
    expect(data.root).toBe(join(workspace, 'vamp-projects'));
    expect(data.projectId).toBe('demo');
    expect(existsSync(join(workspace, 'vamp-projects', 'demo', 'song.json'))).toBe(true);
  });

  it('accepts a custom title', () => {
    const workspace = tempDirectory();
    const result = runCli(['init', 'custom', '--title', 'Custom BGM', '--json'], {
      cwd: workspace,
    });
    const envelope = parseEnvelope(result);

    expect(result.status).toBe(0);
    expect(envelope).toMatchObject({ ok: true, data: { title: 'Custom BGM' } });

    const info = runCli(['info', 'vamp-projects/custom/song.json', '--json'], { cwd: workspace });
    expect(parseEnvelope(info)).toMatchObject({ ok: true, data: { title: 'Custom BGM' } });
  });
});

describe('vamp init collisions and overwrite refusal', () => {
  it('refuses to replace an existing project without --force', () => {
    const workspace = tempDirectory();
    const first = runCli(['init', 'demo', '--json'], { cwd: workspace });
    expect(first.status).toBe(0);
    const songPath = join(workspace, 'vamp-projects', 'demo', 'song.json');
    const before = readFileSync(songPath, 'utf8');

    const second = runCli(['init', 'demo', '--json'], { cwd: workspace });
    const envelope = parseEnvelope(second);

    expect(second.status).toBe(1);
    expect(envelope).toMatchObject({
      command: 'init',
      ok: false,
      error: { code: 'project.exists' },
    });
    expect(readFileSync(songPath, 'utf8')).toBe(before);

    const human = runCli(['init', 'demo'], { cwd: workspace });
    expect(human.status).toBe(1);
    expect(human.stdout).toBe('');
    expect(human.stderr).toContain('already exists');
  });

  it('replaces only the song of an existing Vamp project with --force', () => {
    const workspace = tempDirectory();
    runCli(['init', 'demo', '--json'], { cwd: workspace });
    const projectDirectory = join(workspace, 'vamp-projects', 'demo');
    writeFileSync(join(projectDirectory, 'assets', 'note.txt'), 'keep me', 'utf8');

    const forced = runCli(['init', 'demo', '--force', '--title', 'Reset Demo', '--json'], {
      cwd: workspace,
    });
    const envelope = parseEnvelope(forced);

    expect(forced.status).toBe(0);
    expect(envelope).toMatchObject({
      ok: true,
      data: {
        projectId: 'demo',
        revision: 2,
        previousRevision: 1,
        overwritten: true,
        title: 'Reset Demo',
      },
    });
    expect(readFileSync(join(projectDirectory, 'assets', 'note.txt'), 'utf8')).toBe('keep me');
  });

  it('never overwrites a directory that is not a readable Vamp project', () => {
    const workspace = tempDirectory();
    const root = join(workspace, 'projects');
    const foreign = join(root, 'demo');
    mkdirSync(foreign, { recursive: true });
    const sentinel = writeFile(foreign, 'keep.txt', 'do not delete');

    const result = runCli(['init', 'demo', '--root', root, '--force', '--json'], {
      cwd: workspace,
    });
    const envelope = parseEnvelope(result);

    expect(result.status).toBe(1);
    expect(envelope).toMatchObject({
      ok: false,
      error: { code: 'cli.init.overwrite_refused' },
    });
    expect(readFileSync(sentinel, 'utf8')).toBe('do not delete');
  });
});

describe('vamp validate errors', () => {
  it('reports a missing file with exit code 1 and a structured error', () => {
    const workspace = tempDirectory();
    const result = runCli(['validate', 'missing.json', '--json'], { cwd: workspace });
    const envelope = parseEnvelope(result);

    expect(result.status).toBe(1);
    expect(envelope).toMatchObject({
      command: 'validate',
      ok: false,
      error: { code: 'cli.file.missing', path: 'missing.json' },
    });

    const human = runCli(['validate', 'missing.json'], { cwd: workspace });
    expect(human.status).toBe(1);
    expect(human.stdout).toBe('');
    expect(human.stderr).toContain('does not exist');
  });

  it('reports malformed JSON without rewriting the file', () => {
    const workspace = tempDirectory();
    const path = writeFile(workspace, 'bad.json', '{ "schemaVersion": "1.0.0",');
    const before = readFileSync(path, 'utf8');
    const result = runCli(['validate', 'bad.json', '--json'], { cwd: workspace });
    const envelope = parseEnvelope(result);

    expect(result.status).toBe(1);
    expect(envelope).toMatchObject({
      ok: false,
      error: { code: 'cli.file.malformed_json' },
    });
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('reports structural validation issues with JSON Pointer paths', () => {
    const workspace = tempDirectory();
    writeJson(workspace, 'invalid.json', minimalSong({ tracks: [] }));

    const result = runCli(['validate', 'invalid.json', '--json'], { cwd: workspace });
    const envelope = parseEnvelope(result);
    const error = envelope.error as {
      code: string;
      issues: Array<{ code: string; path: string; hint: string }>;
    };

    expect(result.status).toBe(1);
    expect(error.code).toBe('cli.validation.invalid');
    expect(error.issues[0]).toMatchObject({
      code: 'schema.structure.item_count_out_of_range',
      path: '/tracks',
    });
    expect(error.issues[0]?.hint.length).toBeGreaterThan(0);

    const human = runCli(['validate', 'invalid.json'], { cwd: workspace });
    expect(human.status).toBe(1);
    expect(human.stdout).toBe('');
    expect(human.stderr).toContain('[schema.structure.item_count_out_of_range]');
    expect(human.stderr).toContain('/tracks');
  });

  it('reports an unsupported schema version distinctly', () => {
    const workspace = tempDirectory();
    writeJson(workspace, 'v2.json', { schemaVersion: '2.0.0' });

    const result = runCli(['validate', 'v2.json', '--json'], { cwd: workspace });
    const envelope = parseEnvelope(result);
    const error = envelope.error as {
      code: string;
      issues: Array<{ code: string; path: string }>;
    };

    expect(result.status).toBe(1);
    expect(error.code).toBe('cli.validation.unsupported_version');
    expect(error.issues[0]).toMatchObject({
      code: 'schema.version.unsupported',
      path: '/schemaVersion',
    });
  });

  it('reports a missing schema version distinctly', () => {
    const workspace = tempDirectory();
    const withoutVersion = minimalSong();
    delete withoutVersion.schemaVersion;
    writeJson(workspace, 'no-version.json', withoutVersion);

    const result = runCli(['validate', 'no-version.json', '--json'], { cwd: workspace });
    const envelope = parseEnvelope(result);
    const error = envelope.error as {
      code: string;
      issues: Array<{ code: string; path: string }>;
    };

    expect(result.status).toBe(1);
    expect(error.code).toBe('cli.validation.unsupported_version');
    expect(error.issues[0]).toMatchObject({
      code: 'schema.version.missing',
      path: '/schemaVersion',
    });
  });

  it('reports semantic validation issues with stable codes and paths', () => {
    const workspace = tempDirectory();
    const duplicateChannel = minimalSong();
    const baseTracks = duplicateChannel.tracks as Array<Record<string, unknown>>;
    const baseTrack = baseTracks[0] ?? {};
    duplicateChannel.tracks = [
      baseTrack,
      {
        ...baseTrack,
        id: 'keys-two',
        name: 'Keys Two',
      },
    ];
    writeJson(workspace, 'semantic.json', duplicateChannel);

    const result = runCli(['validate', 'semantic.json', '--json'], { cwd: workspace });
    const envelope = parseEnvelope(result);
    const error = envelope.error as {
      code: string;
      issues: Array<{ code: string; path: string; hint: string }>;
    };

    expect(result.status).toBe(1);
    expect(error.code).toBe('cli.validation.invalid');
    const duplicate = error.issues.find((issue) => issue.code === 'song.channel.duplicate');
    expect(duplicate).toBeDefined();
    expect(duplicate?.path).toMatch(/^\/tracks\/\d+\/channel$/);
    expect(duplicate?.hint.length).toBeGreaterThan(0);
  });

  it('rejects directories, symlinks, and oversized files', () => {
    const workspace = tempDirectory();
    mkdirSync(join(workspace, 'a-directory'));
    const directory = runCli(['validate', 'a-directory', '--json'], { cwd: workspace });
    expect(parseEnvelope(directory)).toMatchObject({
      ok: false,
      error: { code: 'cli.file.not_file' },
    });

    writeJson(workspace, 'song.json', minimalSong());
    if (process.platform !== 'win32') {
      symlinkSync(join(workspace, 'song.json'), join(workspace, 'link.json'));
      const symlink = runCli(['validate', 'link.json', '--json'], { cwd: workspace });
      expect(parseEnvelope(symlink)).toMatchObject({
        ok: false,
        error: { code: 'cli.file.symlink' },
      });
    }

    const oversizedPath = join(workspace, 'oversized.json');
    writeFileSync(oversizedPath, Buffer.alloc(8 * 1024 * 1024 + 1, 0x20));
    const oversized = runCli(['validate', 'oversized.json', '--json'], { cwd: workspace });
    expect(oversized.status).toBe(1);
    expect(parseEnvelope(oversized)).toMatchObject({
      ok: false,
      error: { code: 'cli.file.too_large' },
    });
  });

  it('reports warnings on a valid song without failing', () => {
    const workspace = tempDirectory();
    const warned = minimalSong({
      patterns: [
        {
          id: 'unused',
          notes: [{ pitch: 62, start: 0, duration: 1 }],
        },
      ],
    });
    writeJson(workspace, 'warned.json', warned);

    const result = runCli(['validate', 'warned.json', '--json'], { cwd: workspace });
    const envelope = parseEnvelope(result);
    const warnings = envelope.warnings as Array<{ code: string; path: string }>;

    expect(result.status).toBe(0);
    expect(envelope.ok).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      code: 'song.warning.unused_pattern',
      path: '/patterns/0',
    });

    const info = runCli(['info', 'warned.json', '--json'], { cwd: workspace });
    const infoEnvelope = parseEnvelope(info);
    expect(info.status).toBe(0);
    expect(infoEnvelope.warnings).toHaveLength(1);
    expect((infoEnvelope.data as Record<string, unknown>).counts).toMatchObject({
      warnings: 1,
      patterns: 1,
    });
  });

  it('rejects an invalid song in info as well', () => {
    const workspace = tempDirectory();
    writeJson(workspace, 'invalid.json', minimalSong({ tracks: [] }));

    const result = runCli(['info', 'invalid.json', '--json'], { cwd: workspace });
    const envelope = parseEnvelope(result);

    expect(result.status).toBe(1);
    expect(envelope).toMatchObject({
      command: 'info',
      ok: false,
      error: { code: 'cli.validation.invalid' },
    });
  });
});

describe('vamp schema', () => {
  it('prints the canonical JSON Schema as raw JSON', () => {
    const result = runCli(['schema']);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const schema = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(schema.$id).toBe('urn:vamp:schema:song:1.0.0');
    expect((schema.properties as Record<string, unknown>).schemaVersion).toMatchObject({
      const: '1.0.0',
    });
  });

  it('prints the schema in a JSON envelope with --json', () => {
    const result = runCli(['schema', '--json']);
    const envelope = parseEnvelope(result);

    expect(result.status).toBe(0);
    expect(envelope).toMatchObject({
      command: 'schema',
      ok: true,
      warnings: [],
      data: {
        schemaVersion: '1.0.0',
        schemaId: 'urn:vamp:schema:song:1.0.0',
      },
    });
    const data = envelope.data as { schema: Record<string, unknown> };
    expect(data.schema.$id).toBe('urn:vamp:schema:song:1.0.0');
  });

  it('prints and wraps the agent-oriented schema guide', () => {
    const raw = runCli(['schema', '--guide']);
    expect(raw.status).toBe(0);
    expect(raw.stdout).toContain('# Vamp Song Schema guide');
    expect(raw.stdout).toContain('Core conventions');
    expect(raw.stderr).toBe('');

    const wrapped = runCli(['schema', '--guide', '--json']);
    const envelope = parseEnvelope(wrapped);
    expect(wrapped.status).toBe(0);
    expect(envelope).toMatchObject({
      command: 'schema',
      ok: true,
      data: { format: 'markdown', schemaVersion: '1.0.0' },
    });
    expect(String((envelope.data as Record<string, unknown>).guide)).toContain('Core conventions');
  });

  it('copies the guide into the built CLI package output', () => {
    const guide = fileURLToPath(new URL('../dist/schema-guide.md', import.meta.url));
    expect(lstatSync(guide).isFile()).toBe(true);
    expect(readFileSync(guide, 'utf8')).toContain('# Vamp Song Schema guide');
  });
});

describe('JSON stdout purity', () => {
  it('writes exactly one JSON document to stdout for success and failure', () => {
    const workspace = tempDirectory();

    const success = runCli(['init', 'purity', '--json'], { cwd: workspace });
    expect(success.stderr).toBe('');
    expect(() => JSON.parse(success.stdout)).not.toThrow();

    const failure = runCli(['validate', 'missing.json', '--json'], { cwd: workspace });
    expect(failure.stderr).toBe('');
    expect(() => JSON.parse(failure.stdout)).not.toThrow();

    const usage = runCli(['info', '--json'], { cwd: workspace });
    expect(usage.stderr).toBe('');
    expect(() => JSON.parse(usage.stdout)).not.toThrow();
  });

  it('accepts --json before the command', () => {
    const workspace = tempDirectory();
    writeJson(workspace, 'song.json', minimalSong());

    const result = runCli(['--json', 'validate', 'song.json'], { cwd: workspace });
    const envelope = parseEnvelope(result);

    expect(result.status).toBe(0);
    expect(envelope).toMatchObject({ command: 'validate', ok: true });
  });
});

describe('vamp presets and doctor', () => {
  it('lists preset packs and creates a complete preset project', () => {
    const root = tempDirectory('vamp-cli-preset-');
    const presets = runCli(['presets', '--json']);
    expect(presets.status).toBe(0);
    const presetData = parseEnvelope(presets).data as {
      presets: Array<{ id: string; name: string }>;
    };
    expect(presetData.presets.map((preset) => preset.id)).toEqual([
      'lofi',
      'tutorial_upbeat',
      'ambient_focus',
      'corporate_clean',
      'stinger',
    ]);

    const created = runCli(
      [
        'init',
        'lofi-test',
        '--preset',
        'lofi',
        '--duration',
        '12',
        '--bpm',
        '88',
        '--root',
        root,
        '--json',
      ],
      { cwd: repoRoot },
    );
    expect(created.status).toBe(0);
    const data = parseEnvelope(created).data as {
      preset: string;
      bpm: number;
      durationSeconds: number;
      songFile: string;
    };
    expect(data).toMatchObject({ preset: 'lofi', bpm: 88, durationSeconds: 12 });
    const song = JSON.parse(readFileSync(data.songFile, 'utf8')) as {
      meta: { bpm: number; durationHint: number; tags: string[] };
      tracks: Array<{ id: string; instrument: Record<string, unknown>; notes?: unknown[] }>;
    };
    expect(song.meta.bpm).toBe(88);
    expect(song.meta.durationHint).toBeCloseTo(17.6, 5);
    expect(song.meta.tags).toContain('12s');
    expect(song.tracks.map((track) => track.id)).toEqual([
      'chords',
      'pad',
      'bass',
      'melody',
      'drums',
    ]);
    expect(song.tracks[0]?.instrument).toMatchObject({ type: 'gm', program: 4 });
    expect(song.tracks.every((track) => (track.notes?.length ?? 0) > 0)).toBe(true);

    const validated = runCli(['validate', data.songFile, '--json']);
    expect(validated.status).toBe(0);
  });

  it('reports the default backend and soundfont discovery through doctor', () => {
    const result = runCli(['doctor', '--no-smoke', '--json']);
    expect(result.status).toBe(0);
    const data = parseEnvelope(result).data as {
      defaultBackend: string;
      sampleBackend: {
        executable: { path: string; available: boolean };
        soundFont: { path: string | null; available: boolean };
        smoke: { attempted: boolean };
      };
    };
    expect(['builtin', 'fluidsynth']).toContain(data.defaultBackend);
    expect(typeof data.sampleBackend.executable.path).toBe('string');
    expect(data.sampleBackend.smoke.attempted).toBe(false);
  });
});
