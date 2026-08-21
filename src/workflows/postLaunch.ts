/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Shared post-launch connection sequence.
 *
 * Every workflow that builds a container repeats ensureInstalled, start,
 * and copyGitConfig. This module centralizes that sequence and the
 * duplicated writeOverrideConfig helper. Workflows still own window
 * management, pre-build setup, and the existing-container fast path.
 */

import { BRAND_PREFIX } from "../utils/constants";
import * as vscode from "vscode";
import { getPlatformAdapter } from "../platform";
import { getLogger } from "../utils/logger";
import { getTier, ExecutionTier } from "../host/state";
import { buildContainerAuthority } from "../remote/state4Authority";
import { FolderDescriptor } from "../remote/folderHistory";
import {
  computeConfigHashes,
  serializeConfigHashes,
} from "../config/configHash";
import type {
  ProgressReport,
  WorkflowDependencies,
  WorkflowUI,
  CancellationSignal,
} from "./types";

/** Thrown when the user cancels a workflow via the progress notification. */
export class CancelledError extends Error {
  constructor() {
    super("Operation cancelled by user");
    this.name = "CancelledError";
  }
}

/** Throw a CancelledError if the cancellation token has been signalled. */
export function throwIfCancelled(token?: CancellationSignal): void {
  if (token?.isCancellationRequested) {
    throw new CancelledError();
  }
}

/**
 * Shared post-build connection sequence.
 *
 * @param config - The parsed devcontainer.json (used for extension installation).
 */
export async function connectToContainer(
  deps: WorkflowDependencies,
  ui: WorkflowUI,
  containerId: string,
  perContainerDisable?: boolean,
  config?: Record<string, unknown>,
  remoteUser?: string,
  progress?: ProgressReport,
  token?: CancellationSignal,
): Promise<{
  port: number;
  installPath: string;
  connectionToken: string | undefined;
}> {
  const { serverManager, gitConfigCopier, extensionInstaller } = deps;

  const report = (message: string) => {
    progress?.report({ message });
    ui.showBuildLog(`${BRAND_PREFIX} ${message}`);
  };

  try {
    const serverName = (await getPlatformAdapter()).serverApplicationName;

    throwIfCancelled(token);
    report(`Ensuring server is installed...`);
    await serverManager.ensureInstalled(containerId, remoteUser);

    // Resolve remoteUser via preflight (cached). Falls back to undefined
    // if the user doesn't exist in the image, so extension install and
    // server start get the correct resolved value.
    const resolvedUser =
      await serverManager.preflightRemoteUser(containerId, remoteUser);

    if (config) {
      throwIfCancelled(token);
      report("Installing extensions...");
      const results = await extensionInstaller.installFromConfig(
        containerId,
        config,
        resolvedUser,
      );
      const failed = results.filter((r) => !r.success);
      if (failed.length > 0) {
        getLogger().warn(
          `[extensions] ${failed.length} extension(s) failed to install: ` +
            failed.map((r) => r.id).join(", "),
        );
        for (const f of failed) {
          getLogger().warn(`[extensions]   ${f.id}: ${f.error ?? "unknown error"}`);
        }
      }
    }

    throwIfCancelled(token);
    report(`Starting ${serverName}...`);
    const startedServer = await serverManager.start(containerId, resolvedUser);

    throwIfCancelled(token);
    report("Copying Git config...");
    await gitConfigCopier.copyGitConfig(containerId, perContainerDisable, resolvedUser);

    return {
      port: startedServer.port,
      installPath: startedServer.installPath,
      connectionToken: startedServer.connectionToken,
    };
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    throw error;
  }
}

/**
 * Write a temporary devcontainer.json with platform-specific runArgs merged in.
 *
 * Dynamic imports avoid bundling node:fs, node:path, node:os, and
 * jsonc-parser into every consumer.
 */
export async function writeOverrideConfig(
  originalPath: string,
  config: Record<string, unknown>,
  extraRunArgs: string[],
): Promise<string> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const os = await import("node:os");
  const { modify, applyEdits } = await import("jsonc-parser");
  const content = await fs.readFile(originalPath, "utf-8");
  const existing = (config.runArgs as string[]) || [];
  const value = [...extraRunArgs, ...existing];
  const edits = modify(content, ["runArgs"], value, {
    formattingOptions: { eol: "\n", insertSpaces: true, tabSize: 4 },
  });
  const patched = applyEdits(content, edits);
  const tmpPath = path.join(os.tmpdir(), `artizo-override-${Date.now()}.json`);
  await fs.writeFile(tmpPath, patched);
  return tmpPath;
}

/**
 * Docker labels that bind a container to a workspace folder (and config file).
 * Shared by the folder-based workflows (reopen, rebuild, open-folder) for both
 * the build filter and lookup. Clone-in-volume uses a different label set.
 *
 * When config + configPath are provided, also computes config file hashes
 * (devcontainer.json + referenced Dockerfile/compose files) and emits the
 * artizo.config_hash label so reconnects can detect config drift. Hashing
 * failures are logged and skipped - a missing hash label prompts the user
 * to rebuild, which is the safe fallback.
 */
export async function buildIdentityLabels(params: {
  platformTarget: string;
  workspaceFolder: string;
  configPath?: string | null;
  config?: Record<string, unknown>;
}): Promise<string[]> {
  const { platformTarget, workspaceFolder, configPath, config } = params;
  const labels = [
    `artizo.target=${platformTarget}`,
    `artizo.local_folder=${workspaceFolder}`,
    `devcontainer.local_folder=${workspaceFolder}`,
    ...(configPath
      ? [
          `artizo.config_file=${configPath}`,
          `devcontainer.config_file=${configPath}`,
        ]
      : []),
  ];

  // Preserve remoteUser as a label so the resolver can recover it on
  // re-attach without re-reading devcontainer.json (which may be gone).
  // containerUser is already recoverable from Config.User via docker
  // inspect; no label needed for it.
  const remoteUser =
    typeof config?.remoteUser === "string" ? config.remoteUser : undefined;
  if (remoteUser) {
    labels.push(`artizo.remote_user=${remoteUser}`);
  }

  if (config && configPath) {
    try {
      const path = await import("node:path");
      const hashes = await computeConfigHashes(
        config,
        path.dirname(configPath),
        configPath,
      );
      labels.push(`artizo.config_hash=${serializeConfigHashes(hashes)}`);
      getLogger().info(
        `[config-hash] label written: ${Object.keys(hashes).length} file(s) hashed: ${Object.keys(hashes).join(", ")}`,
      );
    } catch (err) {
      getLogger().warn(
        `config hash computation failed: ${(err as Error).message}`,
      );
    }
  }

  return labels;
}

/**
 * Run the CLI's deferred background tasks. Best-effort: a failure here is
 * logged and swallowed rather than aborting the launch.
 */
export async function finishBackgroundTasks(
  result: { finishBackgroundTasks?: () => Promise<void> } | undefined,
): Promise<void> {
  try {
    await result?.finishBackgroundTasks?.();
  } catch (err) {
    getLogger().warn(`finishBackgroundTasks failed: ${(err as Error).message}`);
  }
}

/**
 * Build the container remote authority for the current execution tier and open
 * the window. Centralizes the tier lookup + buildContainerAuthority assembly +
 * openWindow tail shared by every launch workflow. Callers compute `uriPath`
 * (path normalization differs) and any window options.
 */
export async function buildAuthorityAndOpen(params: {
  deps: WorkflowDependencies;
  ui: WorkflowUI;
  scheme: "artizo-container" | "attached-container";
  id: string;
  containerId: string;
  containerPort: number;
  installPath: string;
  connectionToken: string | undefined;
  workspaceFolder: string;
  workspacePath: string;
  uriPath: string;
  windowOptions?: { forceNewWindow?: boolean; forceReuseWindow?: boolean };
}): Promise<void> {
  const tier = getTier();
  const authority = await buildContainerAuthority({
    scheme: params.scheme,
    id: params.id,
    tier: tier.tier,
    owner: tier.owner,
    remoteAuthority: tier.remoteAuthority,
    containerId: params.containerId,
    containerPort: params.containerPort,
    installPath: params.installPath,
    connectionToken: params.connectionToken,
    workspaceFolder: params.workspaceFolder,
    workspacePath: params.workspacePath,
    dockerPath: params.deps.dockerPath,
    ui: params.ui,
  });
  const url = `vscode-remote://${authority}${params.uriPath}`;
  if (params.windowOptions) {
    await params.ui.openWindow(url, params.windowOptions);
  } else {
    await params.ui.openWindow(url);
  }

  // Capture the folder we just opened for the Recent Folders list. Skip
  // State 4 (tier RemoteSSH + owner "workspace"): the authority built
  // there is the opaque `{ proxy: true, ... }` relay payload (ephemeral
  // relay port), not a stable reopenable key. The shared module's keyPrefix
  // keeps this history separate from zygos's SSH history.
  const isState4 =
    tier.tier === ExecutionTier.RemoteSSH && tier.owner === "workspace";
  if (!isState4) {
    try {
      const d = FolderDescriptor.fromUri(vscode.Uri.parse(url));
      if (d) await params.deps.folderHistory.addFolders([d]);
    } catch (err) {
      getLogger().info(
        `[history] capture failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
