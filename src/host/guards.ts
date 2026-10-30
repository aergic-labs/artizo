/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Guard functions for command preconditions.
 *
 * Extracted from extension.ts to centralize host-context and
 * Docker-availability checks used by command handlers.
 */

import { isInDevContainerWindow } from "./state";
import { getHostWorkspaceFolder as getHostWsFolder } from "../utils/uriUtils";
import { getDockerPath } from "../docker/execPolicy.js";

/** Dev container build/launch commands must not run from inside a managed container. */
export function guardHostContext(): void {
  if (isInDevContainerWindow()) {
    throw new Error(
      "Dev container commands must run from a host window. " +
        "You are currently connected to a managed container. " +
        "Reopen the workspace in the host first.",
    );
  }
}

/** Probe the active Docker runtime (docker or wslc) so a missing runtime fails
 *  fast with a clear message instead of a confusing build error. Reads the
 *  path live so toggling wslc / swapping docker for podman is honored. */
export async function checkDockerAvailable(): Promise<void> {
  const { execFilePromise } = await import("../utils/dockerUtils.js");
  const result = await execFilePromise(getDockerPath(), ["version"]);
  if (result.exitCode !== 0) {
    throw new Error(
      "Docker is not available. Install Docker Desktop or ensure the Docker daemon is running.",
    );
  }
}

export function getHostWorkspaceFolder(): string | undefined {
  return getHostWsFolder();
}
