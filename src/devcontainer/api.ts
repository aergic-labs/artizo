/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Devcontainer API: direct programmatic access to the vendored CLI.
 *
 * All vendor access is lazy-loaded. require() only happens when
 * a function is actually called, not at module load time. This
 * prevents the bundled vendor code's unresolvable requires (tar,
 * shell-quote, etc.) from crashing the extension at startup.
 */

let _vendor: any;

import { ProvisionFailedError } from "./provisionError";

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
 * carrying the devcontainer.json path. Centralizes the try/catch that every
 * building workflow previously duplicated, and is the single throw point for
 * the "Diagnose with AI on build failure" flow.
 */
export async function launchProvision(
  options: ProvisionOptions,
  configPath: string | null | undefined,
  failureMessage = "Build failed",
): Promise<any> {
  try {
    return await launch(options, undefined, []);
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