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
let _errors: any;

function vendor() {
  if (!_vendor) {
    _vendor = require("../../vendor/devcontainers-cli/src/spec-node/devContainers");
  }
  return _vendor;
}

function errors() {
  if (!_errors) {
    _errors = require("../../vendor/devcontainers-cli/src/spec-common/errors");
  }
  return _errors;
}

export async function launch(...args: any[]): Promise<any> {
  return vendor().launch(...args);
}

export const ContainerError: any = {
  get description() {
    return "";
  },
};
// Override with real class when first used
Object.defineProperty(exports, "ContainerError", {
  get() {
    return errors().ContainerError;
  },
  enumerable: true,
  configurable: true,
});

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