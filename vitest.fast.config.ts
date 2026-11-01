import { defineConfig } from 'vitest/config';

import base from './vitest.config.js';

/**
 * Fast regression suite: deterministic pure-TypeScript checks plus the
 * tolerance-based audio behaviors that must hold on every supported platform.
 * It excludes the pinned byte-golden fixtures and the FluidSynth native
 * suite, so it is the safe default gate for heterogeneous CI machines.
 * Run it with `pnpm test:fast`.
 */
export default defineConfig({
  test: {
    ...base.test,
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.pinned.test.ts',
      '**/*.native.test.ts',
      '**/*-native.test.ts',
    ],
  },
});
