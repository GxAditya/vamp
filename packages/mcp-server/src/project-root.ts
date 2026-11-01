/**
 * Configured project-root resolution shared by discovery and future project
 * tools.
 *
 * The server never creates or rewrites a project root. It delegates validation
 * to `@gxaditya/vamp-project`, so health reports the same root codes and hints that
 * project operations will return. A missing or invalid root does not prevent
 * the server from starting.
 */

import { INSTRUMENT_REGISTRY_VALIDATION } from '@gxaditya/vamp-engine';
import { ProjectStore } from '@gxaditya/vamp-project';

import type { McpServerConfig, ProjectRootConfiguration } from './config.js';
import { PROJECT_ROOT_ENV } from './config.js';

export type ProjectRootStatus = 'valid' | 'not_configured' | 'missing' | 'invalid' | 'error';

export interface ProjectRootReport {
  readonly configured: boolean;
  readonly source: ProjectRootConfiguration['source'];
  readonly path: string | null;
  readonly status: ProjectRootStatus;
  readonly projectCount: number | null;
  /** Stable @gxaditya/vamp-project error code when the configured root is unusable. */
  readonly code: string | null;
  readonly message: string;
  readonly hint: string | null;
}

/**
 * Create a project store for the configured root, or null when no root is
 * configured. Reuse this store for all project operations so validation and
 * instrumentation options stay consistent.
 */
export function createConfiguredProjectStore(config: McpServerConfig): ProjectStore | null {
  const root = config.projectRoot.path;
  if (root === null) {
    return null;
  }
  return new ProjectStore({
    root,
    validation: INSTRUMENT_REGISTRY_VALIDATION,
  });
}

function statusForCode(code: string): ProjectRootStatus {
  if (code === 'project.root.not_found') {
    return 'missing';
  }
  if (code === 'project.root.invalid' || code === 'project.root.not_directory') {
    return 'invalid';
  }
  return 'error';
}

/** Probe the configured root through ProjectStore. Never throws. */
export async function describeProjectRoot(config: McpServerConfig): Promise<ProjectRootReport> {
  const configuredRoot = config.projectRoot;
  if (configuredRoot.path === null) {
    return {
      configured: false,
      source: 'none',
      path: null,
      status: 'not_configured',
      projectCount: null,
      code: null,
      message: 'No project root is configured.',
      hint: `Pass --project-root <absolute existing directory> or set ${PROJECT_ROOT_ENV} before starting the server. Discovery tools work without a project root.`,
    };
  }

  const store = createConfiguredProjectStore(config);
  if (store === null) {
    return {
      configured: true,
      source: configuredRoot.source,
      path: configuredRoot.path,
      status: 'error',
      projectCount: null,
      code: 'mcp.project_root.unavailable',
      message: 'The project root could not be configured.',
      hint: 'Restart the server with an absolute, existing directory.',
    };
  }

  const listed = await store.list();
  if (listed.ok) {
    return {
      configured: true,
      source: configuredRoot.source,
      path: configuredRoot.path,
      status: 'valid',
      projectCount: listed.value.length,
      code: null,
      message:
        listed.value.length === 0
          ? 'The project root is usable and contains no projects.'
          : `The project root is usable and contains ${listed.value.length} project${listed.value.length === 1 ? '' : 's'}.`,
      hint: null,
    };
  }

  return {
    configured: true,
    source: configuredRoot.source,
    path: configuredRoot.path,
    status: statusForCode(listed.code),
    projectCount: null,
    code: listed.code,
    message: listed.message,
    hint: listed.hint,
  };
}
