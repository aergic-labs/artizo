/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * PARKED: Docker Compose arg builders for future compose support.
 *
 * Not currently used. Kept because devcontainer.json Docker Compose
 * support requires these argument formatting functions.
 * Test: test/unit/dockerCompose.test.ts (also parked).
 */

export interface ComposeOptions {
  dockerComposeFile?: string | string[];
  service?: string;
  runServices?: string[];
}

export interface UpOptions {
  workspaceFolder: string;
  configFile?: string;
  dockerPath?: string;
  dockerComposePath?: string;
  logFormat?: "text" | "json";
  removeExistingContainer?: boolean;
  additionalMounts?: string[];
  overrideConfigPath?: string;
}

export interface BuildOptions {
  workspaceFolder: string;
  configFile?: string;
  dockerPath?: string;
  dockerComposePath?: string;
  logFormat?: "text" | "json";
  noCache?: boolean;
  overrideConfigPath?: string;
}

function appendComposeFlags(args: string[], options: ComposeOptions): void {
  if (options.dockerComposeFile) {
    const files = Array.isArray(options.dockerComposeFile)
      ? options.dockerComposeFile
      : [options.dockerComposeFile];
    args.push(
      "--override-config",
      JSON.stringify({ dockerComposeFile: files }),
    );
  }
  if (options.service) {
    args.push(
      "--override-config",
      JSON.stringify({ service: options.service }),
    );
  }
  if (options.runServices && options.runServices.length > 0) {
    args.push(
      "--override-config",
      JSON.stringify({ runServices: options.runServices }),
    );
  }
}

function appendBaseFlags(
  args: string[],
  options: UpOptions | BuildOptions,
): void {
  args.push("--workspace-folder", options.workspaceFolder);
  if (options.configFile) args.push("--config", options.configFile);
  if (options.dockerPath) args.push("--docker-path", options.dockerPath);
  if (options.dockerComposePath)
    args.push("--docker-compose-path", options.dockerComposePath);
  if (options.logFormat) args.push("--log-format", options.logFormat);
}

export function buildUpArgs(options: UpOptions & ComposeOptions): string[] {
  const args: string[] = ["up"];
  appendBaseFlags(args, options);
  appendComposeFlags(args, options);
  if (options.removeExistingContainer) args.push("--remove-existing-container");
  if (options.additionalMounts) {
    for (const mount of options.additionalMounts) args.push("--mount", mount);
  }
  if (options.overrideConfigPath)
    args.push("--override-config", options.overrideConfigPath);
  return args;
}

export function buildBuildArgs(
  options: BuildOptions & ComposeOptions,
): string[] {
  const args: string[] = ["build"];
  appendBaseFlags(args, options);
  appendComposeFlags(args, options);
  if (options.noCache) args.push("--no-cache");
  if (options.overrideConfigPath)
    args.push("--override-config", options.overrideConfigPath);
  return args;
}