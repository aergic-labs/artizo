/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Devcontainer API: direct programmatic access to the vendored CLI.
 *
 * The vendored CLI is loaded in-process via require(). Under
 * extensionKind ["workspace","ui"], the activating side always has Docker
 * locally, so there is no remote-dispatch path - the CLI runs wherever
 * the extension runs.
 */

import { ProvisionFailedError } from "./provisionError";

let _vendor: any;

function vendor() {
  if (!_vendor) {
    _vendor = require("../../vendor/devcontainers-cli/src/spec-node/devContainers");
  }
  return _vendor;
}

export async function launch(...args: any[]): Promise<any> {
  return vendor().launch(...args);
}

/**
 * Run a provision (`launch`) and normalize failures to ProvisionFailedError,
 * carrying the devcontainer.json path.
 */
export async function launchProvision(
  options: ProvisionOptions,
  configPath: string | null | undefined,
  failureMessage = "Build failed",
  idLabels?: string[],
): Promise<any> {
  try {
    return await launch(options, idLabels, []);
  } catch (err: unknown) {
    const containerErr = err as { description?: string };
    if (containerErr?.description) {
      throw new ProvisionFailedError(
        `${failureMessage}: ${containerErr.description}`,
        configPath ?? undefined,
      );
    }
    throw new ProvisionFailedError(
      `${failureMessage}: ${err instanceof Error ? err.message : String(err)}`,
      configPath ?? undefined,
    );
  }
}

// ---------------------------------------------------------------------------
// Options defaults
// ---------------------------------------------------------------------------

export interface ProvisionOptions {
  workspaceFolder: string;
  log: (text: string) => void;
  [key: string]: any;
}

const defaults: Record<string, any> = {
  dockerPath: "docker",
  logLevel: 1,
  logFormat: "json",
  defaultUserEnvProbe: "loginInteractiveShell",
  removeExistingContainer: false,
  buildNoCache: false,
  expectExistingContainer: false,
  postCreateEnabled: true,
  skipNonBlocking: false,
  prebuild: false,
  additionalMounts: [],
  updateRemoteUserUIDDefault: "never",
  remoteEnv: {},
  additionalCacheFroms: [],
  useBuildKit: "auto",
  buildxPush: false,
  additionalLabels: [],
  additionalFeatures: {},
  skipFeatureAutoMapping: false,
  skipPostAttach: false,
  skipPersistingCustomizationsFromFeatures: false,
  omitConfigRemotEnvFromMetadata: false,
  dotfiles: { targetPath: "~/dotfiles" },
  noLockfile: false,
  frozenLockfile: false,
  omitSyntaxDirective: false,
  includeConfig: false,
  includeMergedConfig: false,
  mountWorkspaceGitRoot: false,
  mountGitWorktreeCommonDir: false,
};

export function withDefaults(
  overrides: Partial<ProvisionOptions> & {
    workspaceFolder: string;
    log: ProvisionOptions["log"];
  },
): ProvisionOptions {
  return { ...defaults, ...overrides };
}
