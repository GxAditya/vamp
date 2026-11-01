#!/usr/bin/env node
/**
 * Task 22 v1 exit rehearsal over the real MCP stdio server.
 *
 * Runs the agent scenario end to end against `packages/mcp-server/dist/main.js`
 * with a temporary project root, driven by the official MCP SDK client over
 * real stdio, fully offline:
 *
 *   tools/list -> health_check -> get_schema_guide -> list_instruments ->
 *   validate_song -> create_song (revision 1) -> render_song (take-1) ->
 *   report inspection (inline, zero extra calls) -> update_song (keys
 *   volume/pan against revision 1 -> revision 2) -> render_song (take-2) ->
 *   stale-revision conflict demo (diagnostic).
 *
 * The authored song is
 * `packages/engine/test/fixtures/compat/tutorial-45s-90bpm.song.json`: a
 * hand-authored, valid 45-second 90-BPM tutorial BGM. It is the fixture an
 * agent would author; brief interpretation is supplied here as authored data
 * and this rehearsal does NOT prove any model's creative performance.
 *
 * Usage (from the repository root, after `pnpm build`):
 *
 *   node packages/mcp-server/scripts/v1-exit-rehearsal.mjs [options]
 *
 * Options:
 *   --backend builtin|fluidsynth  Render backend for both passes (default
 *                                 builtin; fluidsynth uses
 *                                 VAMP_FLUIDSYNTH_PATH and VAMP_SOUNDFONT_PATH
 *                                 from the environment).
 *   --root <dir>                  Project root to use (default: a fresh mkdtemp).
 *   --summary <path>              Write the JSON run summary to this file.
 *   --keep                        Do not delete the temporary project root.
 *
 * The script prints one JSON object to stdout (also written to --summary when
 * given) with the tool-call ledger, round-trip counts, artifact digests, and
 * the key report numbers. Diagnostics go to stderr only. Exit code 0 means
 * every rehearsal assertion passed; any failed assertion exits 1.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(scriptDir, '..');
const serverEntry = join(packageDir, 'dist', 'main.js');
const songPath = resolve(
  packageDir,
  '..',
  'engine',
  'test',
  'fixtures',
  'compat',
  'tutorial-45s-90bpm.song.json',
);
const projectId = 'exit-rehearsal-tutorial-45s';

function log(message) {
  process.stderr.write(`[rehearsal] ${message}\n`);
}

function fail(message) {
  process.stderr.write(`[rehearsal] FAIL: ${message}\n`);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

const argv = process.argv.slice(2);
function optionValue(name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}
const backend = optionValue('--backend') ?? 'builtin';
if (backend !== 'builtin' && backend !== 'fluidsynth') {
  fail(`unknown --backend ${backend}`);
}
const summaryPath = optionValue('--summary');
const keepRoot = argv.includes('--keep');
const temporaryRoot = mkdtempSync(join(tmpdir(), 'vamp-exit-rehearsal-'));
const customRoot = optionValue('--root');
const projectRoot = customRoot ?? join(temporaryRoot, 'projects');
if (customRoot !== undefined) {
  assert(existsSync(projectRoot), `--root does not exist: ${projectRoot}`);
} else {
  // The server never creates the project root; the client provisions it first.
  mkdirSync(projectRoot, { recursive: true });
}
const expectedMasterFrames = 2160000; // 45 s at 48 kHz stereo

const serverArgs = ['--project-root', projectRoot];
if (backend === 'fluidsynth') {
  const binary = process.env.VAMP_FLUIDSYNTH_PATH ?? '/usr/bin/fluidsynth';
  const soundFont = process.env.VAMP_SOUNDFONT_PATH ?? '/usr/share/sounds/sf2/FluidR3_GM.sf2';
  assert(existsSync(binary), `FluidSynth binary missing: ${binary}`);
  assert(existsSync(soundFont), `SoundFont missing: ${soundFont}`);
  serverArgs.push('--fluidsynth-path', binary, '--soundfont', soundFont);
}

const song = JSON.parse(readFileSync(songPath, 'utf8'));
assert(
  song.meta.bpm === 90 && song.meta.durationHint === 67.5,
  'tutorial fixture is no longer 90 BPM / 67.5 beats',
);

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sha256File = (path) => sha256(readFileSync(path));

// ---------------------------------------------------------------- client ----

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry, ...serverArgs],
  cwd: temporaryRoot,
  env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
  stderr: 'pipe',
});
const stderrChunks = [];
transport.stderr?.on('data', (chunk) => {
  stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
});

const client = new Client({ name: 'vamp-exit-rehearsal-client', version: '1.0.0' });

const calls = [];
let roundTrips = 0;

async function callTool(name, args = {}) {
  const started = Date.now();
  const result = await client.callTool({ name, arguments: args });
  const ms = Date.now() - started;
  calls.push({ name, isError: result.isError === true, ms });
  roundTrips += 1;
  log(`${name} -> ${result.isError ? 'isError' : 'ok'} (${ms} ms)`);
  return result;
}

function structured(result) {
  assert(result.isError !== true, 'unexpected tool error');
  assert(result.structuredContent !== undefined, 'missing structuredContent');
  return result.structuredContent;
}

function errorPayload(result) {
  assert(result.isError === true, 'expected an isError result');
  assert(result.structuredContent === undefined, 'errors must not fill structuredContent');
  const item = result.content.find(
    (entry) => entry.type === 'text' && entry.text.trimStart().startsWith('{'),
  );
  assert(item !== undefined, 'error result missing JSON text item');
  return JSON.parse(item.text).error;
}

// ---------------------------------------------------------------- scenario --

await client.connect(transport);
roundTrips += 1; // initialize
log(`connected; server ${String(client.getServerVersion()?.name)}`);

const tools = await client.listTools();
roundTrips += 1;
const toolNames = tools.tools.map((tool) => tool.name);
assert(toolNames.length === 14, `expected 14 tools, got ${toolNames.length}`);

const health = structured(await callTool('health_check'));
assert(health.status === 'ok', `health_check degraded: ${JSON.stringify(health)}`);
assert(
  health.projectRoot.status === 'valid',
  `project root not valid: ${JSON.stringify(health.projectRoot)}`,
);
if (backend === 'fluidsynth') {
  assert(
    health.sampleBackend.status === 'available',
    `sample backend unavailable: ${JSON.stringify(health.sampleBackend)}`,
  );
}

const guide = structured(await callTool('get_schema_guide'));
assert(typeof guide.markdown === 'string' && guide.markdown.length > 1000, 'guide missing');

const instruments = structured(await callTool('list_instruments'));
assert(Array.isArray(instruments.instruments), 'instrument list missing');

const validated = structured(await callTool('validate_song', { song }));
assert(validated.valid === true, `song invalid: ${JSON.stringify(validated.errors)}`);
assert(validated.warningCount === 0, `unexpected warnings: ${JSON.stringify(validated.warnings)}`);

const created = structured(await callTool('create_song', { projectId, song }));
assert(created.project.revision === 1, 'create_song did not return revision 1');

const render1 = structured(
  await callTool('render_song', {
    projectId,
    expectedRevision: 1,
    renderName: 'take-1',
    backend,
    sampleRate: 48000,
  }),
);
assert(render1.revision === 1 && render1.renderName === 'take-1', 'take-1 identity wrong');

const updated = structured(
  await callTool('update_song', {
    projectId,
    expectedRevision: 1,
    song: {
      ...song,
      tracks: song.tracks.map((track) =>
        track.id === 'keys' ? { ...track, volume: 0.6, pan: 0.35 } : track,
      ),
    },
  }),
);
assert(
  updated.revision === 2 && updated.previousRevision === 1,
  `revision-safe edit did not move 1 -> 2: ${JSON.stringify(updated).slice(0, 200)}`,
);

const render2 = structured(
  await callTool('render_song', {
    projectId,
    expectedRevision: 2,
    renderName: 'take-2',
    backend,
    sampleRate: 48000,
  }),
);
assert(render2.revision === 2 && render2.renderName === 'take-2', 'take-2 identity wrong');

// Diagnostic (not part of the minimum path): a stale render request must be
// refused with a repairable conflict and must not write anything.
const stale = await callTool('render_song', {
  projectId,
  expectedRevision: 1,
  renderName: 'take-1',
});
const staleError = errorPayload(stale);
assert(
  staleError.code === 'project.revision.conflict',
  `stale demo returned code ${String(staleError.code)}`,
);

await client.close();
const stderrText = Buffer.concat(stderrChunks).toString('utf8');
assert(stderrText.length > 0, 'server produced no stderr diagnostics');

// ------------------------------------- independent artifact verification ----
// WAV, MIDI, and report.json are parsed here without the engine.

function verifyRender(render) {
  const dir = render.outputDirectory;
  const masterPath = join(dir, 'master.wav');
  const midiPath = join(dir, 'song.mid');
  const reportPath = join(dir, 'report.json');
  for (const path of [masterPath, midiPath, reportPath]) {
    assert(existsSync(path), `missing artifact ${path}`);
  }

  const wav = readFileSync(masterPath);
  assert(wav.subarray(0, 4).toString('ascii') === 'RIFF', 'not a RIFF file');
  assert(wav.subarray(8, 12).toString('ascii') === 'WAVE', 'not a WAVE file');
  const channels = wav.readUInt16LE(22);
  const rate = wav.readUInt32LE(24);
  const bits = wav.readUInt16LE(34);
  assert(channels === 2 && rate === 48000 && bits === 16, 'unexpected WAV format');
  let offset = 12;
  let dataSize = 0;
  while (offset + 8 <= wav.length) {
    const id = wav.subarray(offset, offset + 4).toString('ascii');
    const size = wav.readUInt32LE(offset + 4);
    if (id === 'data') dataSize = size;
    offset += 8 + size + (size % 2);
  }
  const frames = dataSize / (channels * (bits / 8));
  assert(
    frames === expectedMasterFrames,
    `expected ${expectedMasterFrames} frames (45 s), got ${frames}`,
  );

  const midi = readFileSync(midiPath);
  assert(midi.subarray(0, 4).toString('ascii') === 'MThd', 'not a MIDI header');
  assert(
    midi.readUInt32BE(4) === 6 && midi.readUInt16BE(8) === 1,
    'not a Type 1 SMF with a 6-byte header',
  );

  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  assert(report.format === 'vamp.render-report', `report format ${String(report.format)}`);
  assert(
    report.duration.actualSeconds === 45 && report.duration.actualFrames === expectedMasterFrames,
    `report duration ${JSON.stringify(report.duration)}`,
  );
  assert(report.audio.clipping.clippedSampleCount === 0, 'clipped samples present in take master');
  assert(
    report.backend.id === (backend === 'builtin' ? 'builtin-synth-v1' : 'fluidsynth-sf2-v1'),
    `unexpected report backend id ${String(report.backend.id)}`,
  );

  for (const artifact of render.artifacts) {
    assert(existsSync(artifact.absolutePath), `missing listed artifact ${artifact.absolutePath}`);
    assert(
      sha256File(artifact.absolutePath) === artifact.sha256,
      `listed sha mismatch ${artifact.absolutePath}`,
    );
  }
  const stemCount = render.artifacts.filter((a) => a.role === 'stem').length;
  assert(
    render.artifacts.some((a) => a.role === 'master'),
    'no master artifact listed',
  );
  assert(stemCount === 4, `expected 4 stems, got ${stemCount}`);
  assert(
    render.artifacts.some((a) => a.role === 'midi'),
    'no midi artifact listed',
  );
  assert(
    render.warnings.validation.length === 0 && render.warnings.audio.length === 0,
    `render warnings: ${JSON.stringify(render.warnings)}`,
  );

  return {
    directory: dir,
    masterSha256: sha256File(masterPath),
    midiSha256: sha256File(midiPath),
    frames,
    stemCount,
    peakDbfs: report.audio.peakDbfs,
    integratedLufs: report.audio.loudness.integratedLufs,
    loudnessMethod: report.audio.loudness.method,
    clippedSampleCount: report.audio.clipping.clippedSampleCount,
    backend: report.backend,
    duration: report.duration,
    artifactShas: render.artifacts.map((a) => ({ role: a.role, name: a.path, sha256: a.sha256 })),
  };
}

const take1 = verifyRender(render1);
const take2 = verifyRender(render2);
assert(
  take1.masterSha256 !== take2.masterSha256,
  're-render did not change the master despite the volume/pan edit',
);

// The earlier render must remain byte-for-byte intact after the edit + re-render.
const take1After = verifyRender(render1);
assert(take1After.masterSha256 === take1.masterSha256, 'take-1 was disturbed by take-2');

// ------------------------------------------------------------- summary ------

const toolCalls = calls.length;
const minimumScenarioCalls = 8; // guide, instruments, validate, create, render, update, render + health_check baseline
const diagnosticCalls = toolCalls - minimumScenarioCalls;

const summary = {
  format: 'vamp.exit-rehearsal',
  formatVersion: 1,
  backend,
  projectRoot,
  song: songPath,
  briefNote:
    'The song is a hand-authored fixture standing in for the agent response to ' +
    '"upbeat lo-fi for a 45-second coding tutorial, 90 BPM, no vocals". This ' +
    'rehearsal exercises the tools and the iteration loop; it is not a test of, ' +
    "and makes no claim about, any model's creative interpretation of a brief.",
  protocolRoundTrips: roundTrips,
  toolCalls,
  minimumScenarioCalls,
  diagnosticCalls,
  unnecessaryRoundTrips: 0,
  unnecessaryRoundTripsNote:
    'Report inspection reused the inline render result (no extra call), and the ' +
    'edit reused the revision returned by create_song (no get_song re-read). ' +
    'health_check and the stale-revision demo are deliberate diagnostics, not round-trip waste.',
  callLedger: calls,
  toolsListed: toolNames,
  guide: { characters: guide.markdown.length, schemaVersion: guide.schemaVersion },
  instrumentIds: instruments.instruments.map((instrument) => instrument.id),
  revisionFlow: [1, 2],
  take1,
  take2,
  staleConflict: staleError,
  serverStderrBytes: Buffer.byteLength(stderrText),
};

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
if (summaryPath) {
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  log(`summary written to ${summaryPath}`);
}

if (!keepRoot) {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
log('rehearsal complete');
