import { defineConfig } from 'vitest/config';

import base from './vitest.config.js';

/**
 * Native and pinned suite: the FluidSynth integration renders and the
 * byte-exact golden fixtures recorded on the named repository environment.
 * These are the suites Task 19 should gate separately in CI (provisioning
 * FluidSynth 2.3.4 and the pinned FluidR3_GM SoundFont), and they never make
 * cross-platform byte-identity claims. Run it with `pnpm test:native`.
 *
 * CLI and MCP subprocess suites stay in the fast/default run; where they
 * touch FluidSynth they skip cleanly when the binary is absent.
 */
export default defineConfig({
  test: {
    ...base.test,
    include: [
      'packages/*/test/**/*.pinned.test.ts',
      'packages/*/test/**/*.native.test.ts',
      'packages/*/test/**/*-native.test.ts',
    ],
  },
});
