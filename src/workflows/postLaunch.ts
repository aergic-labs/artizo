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
import { getPlatformAdapter } from "../platform";
import { getLogger } from "../utils/logger";
import { getTier } from "../host/state";
import { buildContainerAuthority } from "../remote/state4Authority";
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
    report(`Installing ${serverName} into container...`);
    await serverManager.ensureInstalled(containerId);

    if (config) {
      throwIfCancelled(token);
      report("Installing extensions...");
      const results = await extensionInstaller.installFromConfig(
        containerId,
        config,
      );
      const failed = results.filter((r) => !r.success);
      if (failed.length > 0) {
        getLogger().warn(
          `[extensions] ${failed.length} extension(s) failed to install: ` +
            failed.map((r) => r.id).join(", "),
        );
      }
    }

    throwIfCancelled(token);
    report(`Starting ${serverName}...`);
    const startedServer = await serverManager.start(containerId);

    throwIfCancelled(token);
    report("Copying Git config...");
    await gitConfigCopier.copyGitConfig(containerId, perContainerDisable);

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
 */
export function buildIdentityLabels(params: {
  platformTarget: string;
  workspaceFolder: string;
  configPath?: string | null;
}): string[] {
  const { platformTarget, workspaceFolder, configPath } = params;
  return [
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
}
