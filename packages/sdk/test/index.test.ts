import { describe, expect, it } from 'vitest';

import { compileSong } from '@gxaditya/vamp-engine';
import { PACKAGE_NAME as SCHEMA_PACKAGE_NAME } from '@gxaditya/vamp-schema';

import { PACKAGE_NAME } from '../src/index.js';

describe('@gxaditya/vamp-sdk scaffold', () => {
  it('exposes its package identity', () => {
    expect(PACKAGE_NAME).toBe('@gxaditya/vamp-sdk');
  });

  it('resolves the shared schema and engine packages through declared dependencies', () => {
    expect(SCHEMA_PACKAGE_NAME).toBe('@gxaditya/vamp-schema');
    expect(typeof compileSong).toBe('function');
  });
});
