#!/usr/bin/env node
/**
 * Verify a provisioned FluidR3 GM SoundFont without network access.
 *
 * Usage: node scripts/verify-soundfont.mjs <path-to-FluidR3_GM.sf2>
 *
 * The pinned values match the asset used by the Task 07 native tests. This is a
 * setup check, not part of any render path. It never downloads the asset.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';

export const PINNED_FLUIDR3_GM = Object.freeze({
  fileName: 'FluidR3_GM.sf2',
  bytes: 148_398_306,
  sha256: '74594e8f4250680adf590507a306655a299935343583256f3b722c48a1bc1cb0',
  license: 'MIT (Frank Wen)',
  source: 'Debian/Ubuntu fluid-soundfont-gm 3.1-5.3',
});

function usage() {
  process.stderr.write('Usage: node scripts/verify-soundfont.mjs <path-to-FluidR3_GM.sf2>\n');
}

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function main() {
  const argument = process.argv[2];
  if (argument === undefined || argument.startsWith('-')) {
    usage();
    process.exitCode = 2;
    return;
  }

  const path = resolve(argument);
  let info;
  try {
    info = await stat(path);
  } catch {
    process.stderr.write(`Missing SoundFont: ${path}\n`);
    process.exitCode = 1;
    return;
  }
  if (!info.isFile()) {
    process.stderr.write(`Not a regular file: ${path}\n`);
    process.exitCode = 1;
    return;
  }
  if (info.size !== PINNED_FLUIDR3_GM.bytes) {
    process.stderr.write(
      `Wrong size: expected ${PINNED_FLUIDR3_GM.bytes} bytes, received ${info.size}.\n`,
    );
    process.exitCode = 1;
    return;
  }

  const digest = await sha256File(path);
  if (digest !== PINNED_FLUIDR3_GM.sha256) {
    process.stderr.write(
      `Wrong SHA-256: expected ${PINNED_FLUIDR3_GM.sha256}, received ${digest}.\n`,
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `OK ${path}\n${PINNED_FLUIDR3_GM.bytes} bytes, sha256 ${digest}\nLicense: ${PINNED_FLUIDR3_GM.license}; source: ${PINNED_FLUIDR3_GM.source}\n`,
  );
}

await main();
