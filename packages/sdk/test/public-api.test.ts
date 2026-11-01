/**
 * Public-surface and shape test for `@gxaditya/vamp-sdk`.
 *
 * Static type tests here are checked by the repository `pnpm typecheck`
 * because the root tsconfig includes the package test directories. Runtime
 * assertions cover the export surface and the shared result/error/revision
 * shapes.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, expectTypeOf, it } from 'vitest';

import * as sdk from '../src/index.js';

function minimalSong(): sdk.SongSchemaV1 {
  return {
    schemaVersion: '1.0.0',
    meta: {
      title: 'Surface Check',
      bpm: 120,
      timeSignature: { numerator: 4, denominator: 4 },
      key: { tonic: 'C', mode: 'major' },
      seed: 7,
      durationHint: 8,
    },
    tracks: [
      {
        id: 'keys',
        name: 'Keys',
        kind: 'midi',
        channel: 0,
        instrument: { type: 'builtin', id: 'keys.soft' },
        notes: [{ pitch: 60, start: 0, duration: 3.5, velocity: 80 }],
      },
    ],
  };
}

describe('@gxaditya/vamp-sdk public surface', () => {
  it('exports schema discovery and validation entry points', () => {
    expect(sdk.PACKAGE_NAME).toBe('@gxaditya/vamp-sdk');
    expect(sdk.SONG_SCHEMA_VERSION).toBe('1.0.0');
    expect(sdk.SUPPORTED_SCHEMA_VERSIONS).toContain('1.0.0');
    expect(typeof sdk.getSongSchemaV1).toBe('function');
    expect(sdk.getSongSchemaV1()['properties']).toBeTypeOf('object');
    expect(typeof sdk.validateSong).toBe('function');
    expect(typeof sdk.normalizeSong).toBe('function');
    expect(typeof sdk.estimateRenderedDuration).toBe('function');
    expect(sdk.ISSUE_CODES).toContain('schema.version.unsupported');
    expect(sdk.ISSUE_CODE_REFERENCE.length).toBe(sdk.ISSUE_CODES.length);
    expect(sdk.BUILTIN_INSTRUMENT_IDS).toContain('piano.soft');
  });

  it('exports the shared instrument registry and rendering operations', () => {
    expect(typeof sdk.describeInstrumentRegistry).toBe('function');
    expect(typeof sdk.getInstrumentRegistryEntry).toBe('function');
    expect(typeof sdk.isCuratedInstrumentId).toBe('function');
    expect(sdk.CURATED_INSTRUMENT_IDS).toContain('bass.sub');
    expect(sdk.CURATED_INSTRUMENT_IDS).toContain('drums.kit');
    expect(sdk.INSTRUMENT_REGISTRY_VALIDATION.builtinInstrumentIds).toEqual(
      sdk.CURATED_INSTRUMENT_IDS,
    );
    expect(sdk.SUPPORTED_SAMPLE_RATES).toEqual([44100, 48000]);
    expect(sdk.DEFAULT_RENDER_ARTIFACTS).toEqual({ stems: true, midi: true, report: true });
    expect(typeof sdk.renderSongArtifacts).toBe('function');
    expect(typeof sdk.renderSongAudio).toBe('function');
    expect(typeof sdk.renderSongToWav).toBe('function');
    expect(typeof sdk.compileSong).toBe('function');
    expect(typeof sdk.exportMidi).toBe('function');
    expect(typeof sdk.createBuiltinSynthBackend).toBe('function');
    expect(typeof sdk.createFluidSynthBackend).toBe('function');
    expect(typeof sdk.createPresetSong).toBe('function');
    expect(typeof sdk.selectAutomaticBackend).toBe('function');
    expect(typeof sdk.discoverSoundFont).toBe('function');
    expect(sdk.GM_INSTRUMENT_CATALOG.length).toBeGreaterThanOrEqual(50);
    expect(sdk.GM_DRUM_NOTE_MAP.kick).toBe(36);
    expect(sdk.BGM_PRESETS.map((preset) => preset.id)).toContain('lofi');
  });

  it('re-exports the shared project storage contracts', () => {
    expect(typeof sdk.ProjectStore).toBe('function');
    expect(sdk.PROJECT_ERROR_CODES).toContain('project.revision.conflict');
    expect(sdk.PROJECT_ERROR_CODES).toContain('project.song.invalid');
    expect(sdk.PROJECT_LAYOUT).toMatchObject({
      songFile: 'song.json',
      assetsDirectory: 'assets',
      rendersDirectory: 'renders',
    });
    expect(typeof sdk.isValidProjectId).toBe('function');
  });

  it('exposes a thin VampClient over the shared libraries', () => {
    expect(typeof sdk.VampClient).toBe('function');
    const client = new sdk.VampClient({ root: '/tmp/vamp-sdk-surface-check' });
    expect(client.root).toBe('/tmp/vamp-sdk-surface-check');
    expect(client.describeSchema().schemaVersion).toBe('1.0.0');
    expect(client.listInstruments().instruments.length).toBeGreaterThan(0);
    expect(client.validate(minimalSong()).ok).toBe(true);
    expect(typeof client.renderProject).toBe('function');
  });

  it('types the re-exported generated schema types and result shapes', () => {
    const song = minimalSong();
    expectTypeOf(song).toMatchTypeOf<sdk.SongSchemaV1>();
    expectTypeOf<sdk.ValidationResult>().toEqualTypeOf<
      sdk.ValidationSuccess | sdk.ValidationFailure
    >();
    expectTypeOf<sdk.ProjectResult<sdk.ProjectSnapshot>>().toEqualTypeOf<
      { readonly ok: true; readonly value: sdk.ProjectSnapshot } | sdk.ProjectError
    >();
    expectTypeOf<sdk.ProjectRenderResult>().toEqualTypeOf<
      | { readonly ok: true; readonly value: sdk.ProjectRenderSuccess }
      | sdk.ProjectError
      | sdk.RenderSongArtifactsFailure
    >();
    expectTypeOf(clientProjectErrorCodes()).toEqualTypeOf<sdk.ProjectErrorCode>();
    function clientProjectErrorCodes(): sdk.ProjectErrorCode {
      return 'project.revision.conflict';
    }
  });

  it('returns shared structured errors, not exceptions, for expected failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vamp-sdk-surface-'));
    try {
      const client = new sdk.VampClient({ root });

      const missing = await client.getProject('does-not-exist');
      expect(missing.ok).toBe(false);
      if (!missing.ok) {
        expect(missing.code).toBe('project.not_found');
        expect(missing.message).toMatch(/does-not-exist/);
        expect(missing.hint.length).toBeGreaterThan(0);
      }
      expectTypeOf(missing.ok).toEqualTypeOf<boolean>();

      const rendered = await client.renderProject('does-not-exist');
      expect(rendered.ok).toBe(false);
      if (!rendered.ok && 'code' in rendered) {
        expect(rendered.code).toBe('project.not_found');
      }

      const relativeRoot = new sdk.VampClient({ root: 'not-absolute' });
      const listed = await relativeRoot.listProjects();
      expect(listed.ok).toBe(false);
      if (!listed.ok) {
        expect(listed.code).toBe('project.root.invalid');
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
