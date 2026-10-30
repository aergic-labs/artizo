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
 * Call configureDockerPath()/configureRuntimeKind() once during activation.
 * Falls back to artizo.dockerPath from VS Code settings (default: docker).
 *
 * Runtime kind: artizo can drive either docker or wslc (WSL Containers CLI).
 * wslc's --format accepts json/table, not Go templates, so list call sites
 * ask listJsonFormat() for the right format string. configureRuntimeKind()
 * is the single source of truth for the active kind.
 */

import * as vscode from "vscode";
import { execFilePromise } from "../utils/dockerUtils.js";

export type RuntimeKind = "docker" | "wslc";

export interface ResolvedRuntime {
  path: string;
  kind: RuntimeKind;
}

let _dockerPath: string | undefined;
let _runtimeKind: RuntimeKind = "docker";

/** Set once during activation. After this, dockerExecPolicy stops reading settings. */
export function configureDockerPath(dockerPath: string): void {
  _dockerPath = dockerPath;
}

/** Set once during activation. Drives isWslcRuntime()/listJsonFormat(). */
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

/** Resolved docker binary path. Lazy-reads the setting on first use. */
export function getDockerPath(): string {
  if (!_dockerPath) {
    _dockerPath = vscode.workspace
      .getConfiguration("artizo")
      .get<string>("dockerPath", "docker");
  }
  return _dockerPath;
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
