import { describe, expect, it } from 'vitest';

import { compileSong } from '@gxaditya/vamp-engine';

import {
  DISCOVERY_TOOL_NAMES,
  PACKAGE_NAME,
  SERVER_NAME,
  createVampMcpServer,
  parseMcpServerConfig,
  readSchemaGuide,
} from '../src/index.js';

describe('@gxaditya/vamp-mcp-server public surface', () => {
  it('exposes its package identity and server factory', () => {
    expect(PACKAGE_NAME).toBe('@gxaditya/vamp-mcp-server');
    expect(SERVER_NAME).toBe('vamp-mcp-server');
    expect(typeof createVampMcpServer).toBe('function');
    expect(typeof parseMcpServerConfig).toBe('function');
    expect(typeof readSchemaGuide).toBe('function');
    expect(DISCOVERY_TOOL_NAMES).toEqual([
      'health_check',
      'get_schema_guide',
      'list_instruments',
      'list_presets',
    ]);
  });

  it('resolves the shared engine package through its declared dependency', () => {
    expect(typeof compileSong).toBe('function');
  });
});
