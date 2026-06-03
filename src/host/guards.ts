/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Guard functions for command preconditions.
 *
 * Extracted from extension.ts to centralize local-context and
 * Docker-availability checks used by command handlers.
 */

import * as vscode from "vscode";
import { getLocalWorkspaceFolder as getLocalWsFolder } from "../utils/uriUtils";

/** Dev container build/launch commands must run from a local window. */
export function guardLocalContext(): void {
  if (vscode.env.remoteName) {
    throw new Error(
      "Dev container commands must run from a local window. " +
        "You are currently connected via " +
        vscode.env.remoteName +
        ". " +
        "Reopen the workspace locally first.",
    );
  }
}

export async function checkDockerAvailable(dockerPath: string): Promise<void> {
  const { execFilePromise } = await import("../utils/dockerUtils.js");
  const result = await execFilePromise(dockerPath, ["version"]);
  if (result.exitCode !== 0) {
    throw new Error(
      "Docker is not available. Install Docker Desktop or ensure the Docker daemon is running.",
    );
  }
}

export function getLocalWorkspaceFolder(): string | undefined {
  return getLocalWsFolder();
}