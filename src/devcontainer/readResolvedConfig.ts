/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * In-process devcontainer.json reader with variable substitution.
 *
 * Mirrors the core path of the CLI's `read-configuration` command
 * (readConfiguration in devContainersSpecCLI.ts): getCLIHost ->
 * workspaceFromPath -> readDevContainerConfigFile. readDevContainerConfigFile
 * performs ${localEnv:...}, ${localWorkspaceFolder...}, and
 * ${containerWorkspaceFolder...} substitution and returns both the
 * substituted config and the resolved workspaceConfig.workspaceFolder.
 *
 * Unlike the CLI command, this runs in-process (no fork, no process.exit)
 * and skips the docker-dependent steps (findContainerAndIdLabels and
 * ${containerEnv:...} substitution), which only apply when a container
 * already exists.
 */

import { URI } from "vscode-uri";

/**
 * Result of reading a devcontainer.json with variables substituted.
 */
export interface ResolvedDevContainerConfig {
  /** The substituted devcontainer.json object. */
  config: Record<string, unknown>;
  /** The substituted workspaceFolder (or the computed default). */
  workspaceFolder: string;
}

/**
 * The vendored CLI functions readResolvedConfig needs. Injectable so tests
 * can pass the real modules via static imports (the src-side require() is
 * not loadable under vitest; same situation as api.ts, whose vendor path no
 * test exercises either).
 */
export interface VendorConfigReader {
  getCLIHost: (
    cwd: string,
    loadNativeModule: <T>(moduleName: string) => Promise<T | undefined>,
    allowInheritTTY: boolean,
  ) => Promise<any>;
  loadNativeModule: <T>(moduleName: string) => Promise<T | undefined>;
  workspaceFromPath: (pathLib: any, folder: string) => any;
  nullLog: any;
  readDevContainerConfigFile: (
    cliHost: any,
    workspace: any,
    configFile: any,
    mountWorkspaceGitRoot: boolean,
    mountGitWorktreeCommonDir: boolean,
    output: any,
  ) => Promise<any>;
}

// Lazy require, same pattern as api.ts: the vendored CLI is a large in-process
// module loaded on first use, outside tsconfig's include set (untyped by
// design), and inlined into the esbuild bundle.
let _vendor: VendorConfigReader | undefined;

/** Vendor accessor, overridable by tests. */
export function vendorConfigReader(): VendorConfigReader {
  if (!_vendor) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cliHost = require("../../vendor/devcontainers-cli/src/spec-common/cliHost");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const commonUtils = require("../../vendor/devcontainers-cli/src/spec-common/commonUtils");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const workspaces = require("../../vendor/devcontainers-cli/src/spec-utils/workspaces");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const log = require("../../vendor/devcontainers-cli/src/spec-utils/log");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const configContainer = require("../../vendor/devcontainers-cli/src/spec-node/configContainer");
    _vendor = {
      getCLIHost: cliHost.getCLIHost,
      loadNativeModule: commonUtils.loadNativeModule,
      workspaceFromPath: workspaces.workspaceFromPath,
      nullLog: log.nullLog,
      readDevContainerConfigFile: configContainer.readDevContainerConfigFile,
    };
  }
  return _vendor;
}

/** Test hook: inject the real (or fake) vendor modules. */
export function setVendorConfigReader(v: VendorConfigReader | undefined): void {
  _vendor = v;
}

/**
 * Read a devcontainer.json and resolve devcontainer variable substitutions
 * (${localEnv:...}, ${localWorkspaceFolder...}, ${containerWorkspaceFolder...}).
 *
 * @param workspaceFolder - Absolute path to the workspace folder (the local
 *   folder containing the devcontainer.json)
 * @param configPath - Absolute path to the devcontainer.json file
 */
export async function readResolvedConfig(
  workspaceFolder: string,
  configPath: string,
): Promise<ResolvedDevContainerConfig> {
  const v = vendorConfigReader();
  const cliHost = await v.getCLIHost(
    workspaceFolder,
    v.loadNativeModule,
    false,
  );
  const workspace = v.workspaceFromPath(cliHost.path, workspaceFolder);
  const configs = await v.readDevContainerConfigFile(
    cliHost,
    workspace,
    URI.file(configPath),
    /* mountWorkspaceGitRoot */ false,
    /* mountGitWorktreeCommonDir */ false,
    v.nullLog,
  );
  if (!configs) {
    throw new Error(`Dev container config not found: ${configPath}`);
  }
  return {
    config: configs.config.config as Record<string, unknown>,
    workspaceFolder: configs.workspaceConfig.workspaceFolder as string,
  };
}
