import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { SongSchemaV1 } from '../src/index.js';

export const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const fixturesRoot = join(packageRoot, 'fixtures');

export function loadValidFixture(name: string): SongSchemaV1 {
  return JSON.parse(readFileSync(join(fixturesRoot, 'valid', name), 'utf8')) as SongSchemaV1;
}

export function loadInvalidFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(fixturesRoot, 'invalid', name), 'utf8')) as unknown;
}

export function cloneSong(song: SongSchemaV1): SongSchemaV1 {
  return structuredClone(song);
}

export function minimalSong(): SongSchemaV1 {
  return loadValidFixture('minimal.song.json');
}

export function patternsSong(): SongSchemaV1 {
  return loadValidFixture('patterns.song.json');
}

export function automationSong(): SongSchemaV1 {
  return loadValidFixture('automation.song.json');
}

export function drumsSong(): SongSchemaV1 {
  return loadValidFixture('drums.song.json');
}

export function instrumentsSong(): SongSchemaV1 {
  return loadValidFixture('instruments.song.json');
}
