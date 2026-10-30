/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * wslc config-support diagnostics.
 *
 * wslc has no Compose runtime and cannot bind-mount WSL host paths
 * (microsoft/WSL #40957), so docker-in-docker and unix-socket bind
 * mounts are not supported. Surface a toast at build time when the
 * active runtime is wslc and the devcontainer.json uses one of these.
 * No-op when the runtime is docker.
 */

import * as vscode from "vscode";
import { isWslcRuntime } from "../docker/execPolicy.js";

const WSL_SOCK_ISSUE = "https://github.com/microsoft/WSL/issues/40957";

type Unsupported = "compose" | "dind";

function usesCompose(config: unknown): boolean {
  if (!config || typeof config !== "object") return false;
  const c = config as Record<string, unknown>;
  const compose = c.dockerComposeFile;
  if (typeof compose === "string") return compose.length > 0 && compose !== "none";
  if (Array.isArray(compose)) return compose.length > 0;
  if (Array.isArray(c.runServices) && c.runServices.length > 0) return true;
  return false;
}

function usesDockerInDockerOrSock(config: unknown): boolean {
  if (!config || typeof config !== "object") return false;
  const c = config as Record<string, unknown>;
  const features = c.features;
  if (features && typeof features === "object") {
    for (const k of Object.keys(features as Record<string, unknown>)) {
      if (k.toLowerCase().includes("docker-in-docker")) return true;
    }
  }
  const mounts = c.mounts;
  if (Array.isArray(mounts)) {
    for (const m of mounts) {
      if (typeof m === "string" && m.includes("/var/run/docker.sock")) return true;
    }
  }
  return false;
}

/**
 * Surface toasts for wslc-unsupported config. Returns the features surfaced.
 * Call at the build/open/rebuild paths before provisioning.
 */
export function warnWslcUnsupportedConfig(config: unknown): Unsupported[] {
  if (!isWslcRuntime()) return [];
  const out: Unsupported[] = [];
  if (usesCompose(config)) {
    out.push("compose");
    void vscode.window
      .showErrorMessage(
        "wslc has no Compose runtime. For Compose projects, uncheck artizo.useWslcIfInstalled and install Docker.",
        "Open settings",
      )
      .then((choice) => {
        if (choice === "Open settings") {
          vscode.commands.executeCommand(
            "workbench.action.openSettings",
            "artizo.useWslcIfInstalled",
          );
        }
      });
  }
  if (usesDockerInDockerOrSock(config)) {
    out.push("dind");
    void vscode.window
      .showErrorMessage(
        "wslc cannot bind-mount WSL host paths: the docker-in-docker feature and unix-socket bind mounts are not supported (microsoft/WSL #40957).",
        "Open issue",
      )
      .then((choice) => {
        if (choice === "Open issue") {
          vscode.env.openExternal(vscode.Uri.parse(WSL_SOCK_ISSUE));
        }
      });
  }
  return out;
}
