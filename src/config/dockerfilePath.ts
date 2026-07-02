/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as path from "node:path";

/**
 * Resolve the Dockerfile or compose file referenced by a devcontainer.json,
 * relative to the config file's directory. Returns an absolute path, or
 * undefined for image-based configs that reference neither.
 *
 * Recognizes: `build.dockerfile`, `build.dockerFile`, top-level `dockerFile`
 * (legacy), and `dockerComposeFile` (string or string[]).
 *
 * Pure function - no filesystem access - so it is easy to unit test.
 */
export function resolveDockerfilePath(
  config: Record<string, unknown>,
  configDir: string,
): string | undefined {
  const build = config.build as Record<string, unknown> | undefined;
  const dockerfile =
    (typeof build?.dockerfile === "string" && build.dockerfile) ||
    (typeof build?.dockerFile === "string" && build.dockerFile) ||
    (typeof config.dockerFile === "string" && config.dockerFile) ||
    undefined;
  if (dockerfile) {
    return path.resolve(configDir, dockerfile);
  }

  const compose = config.dockerComposeFile;
  if (typeof compose === "string") {
    return path.resolve(configDir, compose);
  }
  if (Array.isArray(compose) && typeof compose[0] === "string") {
    return path.resolve(configDir, compose[0]);
  }

  return undefined;
}
