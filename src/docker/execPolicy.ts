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
 * Runtime kind: artizo can drive either docker or wslc (WSL Containers CLI).
 * configureRuntimeKind() is set during activation and re-run on config change.
 * getDockerPath() reads the setting live on every call so toggling
 * useWslcIfInstalled or swapping docker for podman takes effect without
 * a reload. wslc's --format accepts json/table, not Go templates, so list
 * call sites ask listJsonFormat() for the right format string.
 */

import * as vscode from "vscode";
import { execFilePromise } from "../utils/dockerUtils.js";

export type RuntimeKind = "docker" | "wslc";

export interface ResolvedRuntime {
  path: string;
  kind: RuntimeKind;
}

let _runtimeKind: RuntimeKind = "docker";

/** Set during activation and on config change. Drives isWslcRuntime()/listJsonFormat(). */
export function configureRuntimeKind(kind: RuntimeKind): void {
  _runtimeKind = kind;
}

export function isWslcRuntime(): boolean {
  return _runtimeKind === "wslc";
}

/**
 * Format string for `ps`/`volume ls` JSON-per-line output. wslc accepts
 * `json`, docker accepts the Go template `{{json .}}`. Both produce one
 * JSON object per line; parseContainerList/JSON.parse handle either.
 */
export function listJsonFormat(): string {
  return _runtimeKind === "wslc" ? "json" : "{{json .}}";
}

/** Active runtime binary path. Reads live so setting changes take effect
 *  without a reload. Returns the wslc path when wslc is active, else the
 *  docker path. */
export function getDockerPath(): string {
  const config = vscode.workspace.getConfiguration("artizo");
  if (isWslcRuntime()) {
    return config.get<string>("wslcPath", "wslc");
  }
  return config.get<string>("dockerPath", "docker");
}

/**
 * Resolve the active Docker runtime. On Windows with useWslc opt-in, probe
 * `wslc version`; on success the runtime is wslc at wslcPath. Any gate
 * fails (non-Windows, opt-out, probe non-zero) falls through to docker.
 */
export async function resolveRuntime(opts: {
  platform: string;
  dockerPath: string;
  wslcPath: string;
  useWslc: boolean;
}): Promise<ResolvedRuntime> {
  if (opts.platform === "win32" && opts.useWslc) {
    try {
      const r = await execFilePromise(opts.wslcPath, ["version"]);
      if (r.exitCode === 0) {
        return { path: opts.wslcPath, kind: "wslc" };
      }
    } catch {
      // wslc not installed or not on PATH; fall through to docker.
    }
  }
  return { path: opts.dockerPath, kind: "docker" };
}

export async function dockerExecPolicy(
  args: string[],
): Promise<import("../utils/dockerUtils.js").ExecResult> {
  return execFilePromise(getDockerPath(), args);
}
