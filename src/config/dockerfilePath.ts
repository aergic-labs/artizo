/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as path from "node:path";

/** posix for remote targets, native for local. */
type PathModule = typeof path.posix;

/**
 * Resolve all docker-compose file paths referenced by a devcontainer.json,
 * relative to the config file's directory. Returns absolute paths.
 *
 * Returns an empty array for configs that don't use dockerComposeFile, or
 * that use the special `0` form (auto-discover). Callers that need to hash
 * compose files treat the empty array as "nothing to hash".
 *
 * Pure function - no filesystem access - so it is easy to unit test.
 */
export function resolveComposeFilePaths(
  config: Record<string, unknown>,
  configDir: string,
  pathModule: PathModule = path,
): string[] {
  const compose = config.dockerComposeFile;
  if (typeof compose === "string") {
    return [pathModule.resolve(configDir, compose)];
  }
  if (Array.isArray(compose)) {
    return compose
      .filter((f): f is string => typeof f === "string")
      .map((f) => pathModule.resolve(configDir, f));
  }
  return [];
}

/**
 * Resolve the Dockerfile or compose file referenced by a devcontainer.json,
 * relative to the config file's directory. Returns an absolute path, or
 * undefined for image-based configs that reference neither.
 *
 * Recognizes: `build.dockerfile`, `build.dockerFile`, top-level `dockerFile`
 * (legacy), and `dockerComposeFile` (string or string[]). For compose configs
 * returns the first compose file path.
 *
 * Pure function - no filesystem access - so it is easy to unit test.
 */
export function resolveDockerfilePath(
  config: Record<string, unknown>,
  configDir: string,
  pathModule: PathModule = path,
): string | undefined {
  const build = config.build as Record<string, unknown> | undefined;
  const dockerfile =
    (typeof build?.dockerfile === "string" && build.dockerfile) ||
    (typeof build?.dockerFile === "string" && build.dockerFile) ||
    (typeof config.dockerFile === "string" && config.dockerFile) ||
    undefined;
  if (dockerfile) {
    return pathModule.resolve(configDir, dockerfile);
  }

  const composePaths = resolveComposeFilePaths(config, configDir, pathModule);
  return composePaths.length > 0 ? composePaths[0] : undefined;
}
