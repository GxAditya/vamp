#!/usr/bin/env node
/**
 * Task 18 render performance benchmark (explicitly invoked, never a default
 * test assertion).
 *
 * Usage:
 *
 *   pnpm benchmark                        # builtin backend, 48 kHz, 30/45/90 s
 *   pnpm benchmark --rates 48000,44100    # one flag, comma-separated list
 *   pnpm benchmark --backend fluidsynth   # native path, same-machine only
 *   pnpm benchmark --check-budgets        # fail (exit 1) over the pinned budgets
 *   pnpm benchmark --json                 # machine-readable results only
 *
 * The benchmark renders three representative cues through the built engine
 * (`compileSong` -> `renderTimelineAudio` -> `encodeWav`), each in a fresh
 * child Node process so peak memory is a real process measurement:
 *
 * - 30 s: `examples/songs/explainer-upbeat.song.json`
 * - 45 s: `examples/songs/lofi-coding-bed.song.json`
 * - 90 s: the explainer cue with every pattern placement repeated and the
 *   duration hint scaled 3x in memory (representative dense 90 s content;
 *   not a committed fixture)
 *
 * Each case is also rendered twice in the child to confirm byte identity on
 * this machine, and the WAV SHA-256 is reported for reproducibility.
 *
 * Budgets live in `scripts/perf-budgets.json` and were recorded on the
 * environment named in that file and in `PROGRESS.md`. They are regression
 * budgets for the pinned machine only: run `--check-budgets` there, never as
 * a universal CI speed gate on heterogeneous runners (this is why the default
 * `pnpm test` never measures or asserts wall time).
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { release, cpus, hostname, platform, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const budgetsPath = join(repoRoot, 'scripts', 'perf-budgets.json');

const CASES = [
  { id: 'explainer-30s', song: 'examples/songs/explainer-upbeat.song.json', scale: 1 },
  { id: 'lofi-45s', song: 'examples/songs/lofi-coding-bed.song.json', scale: 1 },
  { id: 'explainer-90s', song: 'examples/songs/explainer-upbeat.song.json', scale: 3 },
];

function parseArgs(argv) {
  const options = {
    backend: 'builtin',
    rates: [48000],
    checkBudgets: false,
    json: false,
    child: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--backend') {
      options.backend = argv[(index += 1)];
      if (options.backend !== 'builtin' && options.backend !== 'fluidsynth') {
        throw new Error('--backend must be builtin or fluidsynth');
      }
    } else if (argument === '--rates') {
      options.rates = String(argv[(index += 1)])
        .split(',')
        .map((value) => Number.parseInt(value, 10))
        .filter((value) => value === 44100 || value === 48000);
      if (options.rates.length === 0) {
        throw new Error('--rates must list 44100 and/or 48000');
      }
    } else if (argument === '--check-budgets') {
      options.checkBudgets = true;
    } else if (argument === '--json') {
      options.json = true;
    } else if (argument === '--child') {
      options.child = {
        song: argv[(index += 1)],
        scale: Number(argv[(index += 1)]),
        rate: Number(argv[(index += 1)]),
        backend: argv[(index += 1)],
      };
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function peakRssKib() {
  try {
    const status = readFileSync('/proc/self/status', 'utf8');
    const match = /VmHWM:\s+(\d+) kB/.exec(status);
    if (match?.[1] !== undefined) {
      return Number.parseInt(match[1], 10);
    }
  } catch {
    // Non-Linux: fall through to the live RSS sample.
  }
  return Math.round(process.memoryUsage().rss / 1024);
}

async function runChild(childOptions) {
  const engine = await import(join(repoRoot, 'packages/engine/dist/index.js'));
  const { renderSongAudio, encodeWav } = engine;
  const song = JSON.parse(readFileSync(childOptions.song, 'utf8'));
  if (childOptions.scale > 1) {
    song.meta.durationHint *= childOptions.scale;
    for (const track of song.tracks) {
      for (const placement of track.placements ?? []) {
        placement.repeat = (placement.repeat ?? 1) * childOptions.scale;
      }
    }
  }

  const backend =
    childOptions.backend === 'fluidsynth'
      ? engine.createFluidSynthBackend({
          binaryPath: process.env.VAMP_FLUIDSYNTH_PATH ?? '/usr/bin/fluidsynth',
          gmSoundFont: process.env.VAMP_SOUNDFONT_PATH ?? '/usr/share/sounds/sf2/FluidR3_GM.sf2',
        })
      : undefined;

  const startedAt = performance.now();
  const first = await renderSongAudio(song, {
    sampleRate: childOptions.rate,
    ...(backend === undefined ? {} : { backend }),
  });
  const compileRenderMs = performance.now() - startedAt;
  if (!first.ok) {
    console.error(JSON.stringify(first));
    process.exit(1);
  }
  const encoded = encodeWav(first.audio);
  if (!encoded.ok) {
    console.error(JSON.stringify(encoded));
    process.exit(1);
  }
  const renderPlusEncodeMs = performance.now() - startedAt;

  const repeatStarted = performance.now();
  const second = await renderSongAudio(song, {
    sampleRate: childOptions.rate,
    ...(backend === undefined ? {} : { backend }),
  });
  const repeatMs = performance.now() - repeatStarted;
  if (!second.ok) {
    console.error(JSON.stringify(second));
    process.exit(1);
  }
  const secondEncoded = encodeWav(second.audio);
  if (!secondEncoded.ok) {
    console.error(JSON.stringify(secondEncoded));
    process.exit(1);
  }

  console.log(
    JSON.stringify({
      frames: first.audio.frameCount,
      seconds: first.timeline.renderedSeconds,
      compileAndRenderMs: Number(compileRenderMs.toFixed(1)),
      renderPlusEncodeMs: Number(renderPlusEncodeMs.toFixed(1)),
      repeatMs: Number(repeatMs.toFixed(1)),
      identicalRepeat: sha256(encoded.bytes) === sha256(secondEncoded.bytes),
      wavBytes: encoded.bytes.byteLength,
      sha256: sha256(encoded.bytes).slice(0, 16),
      peakRssKib: peakRssKib(),
    }),
  );
}

function environment() {
  return {
    hostname: hostname(),
    platform: platform(),
    osRelease: release(),
    cpuModel: cpus()[0]?.model ?? 'unknown',
    cpuCount: cpus().length,
    totalMemoryBytes: totalmem(),
    node: process.version,
  };
}

function runCase(childCase, rate, backend) {
  const songPath = join(repoRoot, childCase.song);
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(import.meta.url),
      '--child',
      songPath,
      String(childCase.scale),
      String(rate),
      backend,
    ],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(`benchmark child failed: ${result.stderr}`);
  }
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.child !== null) {
    await runChild(options.child);
    return;
  }

  const environmentInfo = environment();
  const rows = [];
  for (const childCase of CASES) {
    for (const rate of options.rates) {
      const measured = runCase(childCase, rate, options.backend);
      rows.push({ case: childCase.id, rate, backend: options.backend, ...measured });
    }
  }

  if (options.json) {
    console.log(JSON.stringify({ environment: environmentInfo, results: rows }, null, 2));
  } else {
    console.log('Vamp render benchmark (explicit script, never a default test gate)');
    console.log(
      `  host: ${environmentInfo.hostname}  os: ${environmentInfo.platform} ${environmentInfo.osRelease}`,
    );
    console.log(`  cpu: ${environmentInfo.cpuModel} (${environmentInfo.cpuCount} cores)`);
    console.log(`  node: ${environmentInfo.node}  backend: ${options.backend}`);
    console.log('');
    for (const row of rows) {
      console.log(
        `  ${row.case.padEnd(15)} @ ${row.rate} Hz: ` +
          `render+encode ${String(row.renderPlusEncodeMs).padStart(7)} ms ` +
          `(repeat ${String(row.repeatMs).padStart(7)} ms), ` +
          `peak RSS ${String(row.peakRssKib).padStart(7)} KiB, ` +
          `wav ${row.wavBytes} B, sha ${row.sha256}..., identical repeat: ${row.identicalRepeat}`,
      );
      if (!row.identicalRepeat) {
        console.error('  WARNING: repeat render was not byte-identical on this machine.');
      }
    }
  }

  if (options.checkBudgets) {
    const budgets = JSON.parse(readFileSync(budgetsPath, 'utf8'));
    let violations = 0;
    for (const row of rows) {
      const budget = budgets.budgets[`${row.case}@${row.rate}/${row.backend}`];
      if (budget === undefined) {
        console.error(`no budget recorded for ${row.case}@${row.rate}/${row.backend}`);
        violations += 1;
        continue;
      }
      if (
        row.renderPlusEncodeMs > budget.renderPlusEncodeMsBudget ||
        row.peakRssKib > budget.peakRssKiBBudget
      ) {
        console.error(
          `BUDGET EXCEEDED for ${row.case}@${row.rate}/${row.backend}: ` +
            `${row.renderPlusEncodeMs} ms vs ${budget.renderPlusEncodeMsBudget} ms, ` +
            `${row.peakRssKib} KiB vs ${budget.peakRssKiBBudget} KiB`,
        );
        violations += 1;
      }
    }
    if (violations > 0) {
      process.exitCode = 1;
    } else {
      console.log('\nAll recorded budgets satisfied on this machine.');
    }
  }
}

await main();
