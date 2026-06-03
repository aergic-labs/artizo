/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Policy layer for Docker execution.
 *
 * Thin wrapper around src/utils/dockerUtils.ts. All runtime Docker
 * calls go through this module rather than calling execFilePromise directly.
 *
 * Call configureDockerPath() once during activation. Falls back to
 * artizo.dockerPath from VS Code settings (default: docker).
 */

import * as vscode from "vscode";
import { execFilePromise } from "../utils/dockerUtils.js";

let _dockerPath: string | undefined;

/** Set once during activation. After this, dockerExecPolicy stops reading settings. */
export function configureDockerPath(dockerPath: string): void {
  _dockerPath = dockerPath;
}

export async function dockerExecPolicy(
  args: string[],
): Promise<import("../utils/dockerUtils.js").ExecResult> {
  if (!_dockerPath) {
    _dockerPath = vscode.workspace
      .getConfiguration("artizo")
      .get<string>("dockerPath", "docker");
  }
  return execFilePromise(_dockerPath, args);
}