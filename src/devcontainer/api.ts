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
let _vendorError: Error | undefined;

function vendor(): any {
  if (!_vendor) {
    // Intentional dynamic require: the vendored CLI is a large in-process
    // module loaded lazily on first use (not at import time), and is not an
    // ES module. A static import would eagerly pull it into activation.
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      _vendor = require("../../vendor/devcontainers-cli/src/spec-node/devContainers");
      _vendorError = undefined;
    } catch (err: unknown) {
      // Reset so a later call can retry (e.g. after the user installs a
      // missing native dep). Without this, the first failure poisons the
      // lazy-load cache forever and surfaces raw loader errors on every call.
      _vendor = undefined;
      _vendorError = err instanceof Error ? err : new Error(String(err));
      throw new Error(
        `Vendored devcontainers CLI failed to load: ${_vendorError.message}`,
      );
    }
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
  [key: string]: unknown;
}

const defaults: Record<string, unknown> = {
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
  updateRemoteUserUIDDefault: "on",
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

/**
 * Read dotfiles config from VS Code settings. Returns an object suitable
 * for spreading into `withDefaults` overrides. When no repository is set,
 * returns an empty object — the CLI's built-in default (targetPath
 * "~/dotfiles") is used, and no dotfiles install runs.
 *
 * Decouples the settings read from the pure defaults logic so callers
 * that already import vscode can pass the config in without forcing
 * api.ts to depend on the vscode API.
 */
export function dotfilesFromConfig(
  config: { get<T>(section: string): T | undefined },
): Partial<Pick<ProvisionOptions, "dotfiles">> {
  const repository = config.get<string>("artizo.dotfiles.repository");
  if (!repository) return {};
  const installCommand = config.get<string>("artizo.dotfiles.installCommand");
  const targetPath = config.get<string>("artizo.dotfiles.targetPath");
  return {
    dotfiles: {
      repository,
      ...(installCommand ? { installCommand } : {}),
      targetPath: targetPath || "~/dotfiles",
    },
  };
}
