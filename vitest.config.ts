import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/*/test/**/*.test.ts', 'test/**/*.test.ts'],
    // The CLI and MCP suites spawn real Node subprocesses (and the engine suite
    // spawns FluidSynth), so under parallel forks on a small host a child can be
    // starved and exceed the default 5s test timeout. Raise the floor and cap
    // worker concurrency so subprocess timing stays deterministic rather than
    // racing CPU oversubscription. This bounds flakiness, not performance.
    pool: 'forks',
    maxWorkers: 4,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
