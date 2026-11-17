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
import { getProductInfo, type ProductInfo } from "../remote/productInfo";
import { readConfigFileText, writeTempConfigFile } from "../config/configFileIO";
import type { ExecServer } from "../remote/execServerBridge";
import { getDockerPath } from "../docker/execPolicy.js";
import { FolderDescriptor } from "../remote/folderHistory";

import { assertForwardPortsValid } from "../devcontainer/forwardPortsValidation";
import type { ReadConfigResult } from "../config/configManager";
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
      // Dual-write: install lines go to the build log (where the user is
      // watching the launch) in addition to the diagnostic log file.
      const onLog = (text: string) =>
        ui.showBuildLog(`${BRAND_PREFIX} ${text}`);
      const results = await extensionInstaller.installFromConfig(
        containerId,
        config,
        resolvedUser,
        onLog,
      );
      const failed = results.filter((r) => !r.success);
      if (failed.length > 0) {
        getLogger().warn(
          `[extensions] ${failed.length} extension(s) failed to install: ` +
            failed.map((r) => r.id).join(", "),
        );
        ui.showBuildLog(
          `${BRAND_PREFIX} [extensions] ${failed.length} extension(s) failed to install: ` +
            failed.map((r) => r.id).join(", "),
        );
        for (const f of failed) {
          getLogger().warn(`[extensions]   ${f.id}: ${f.error ?? "unknown error"}`);
          ui.showBuildLog(
            `${BRAND_PREFIX} [extensions]   ${f.id}: ${f.error ?? "unknown error"}`,
          );
        }
      }
    } else {
      getLogger().info(
        "[extensions] no devcontainer config passed to connect; skipping extension install",
      );
      ui.showBuildLog(
        `${BRAND_PREFIX} [extensions] no devcontainer config passed to connect; skipping extension install`,
      );
    }

    throwIfCancelled(token);
    report(`Starting ${serverName}...`);
    const startedServer = await serverManager.start(containerId, resolvedUser, config);

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
  const { modify, applyEdits } = await import("jsonc-parser");
  // Read the original and write the patched copy on the target (remote) side
  // when an ExecServer is active, so the CLI can read it via RemoteCliHost.
  const content = await readConfigFileText(originalPath);
  const existing = (config.runArgs as string[]) || [];
  const value = [...extraRunArgs, ...existing];
  const edits = modify(content, ["runArgs"], value, {
    formattingOptions: { eol: "\n", insertSpaces: true, tabSize: 4 },
  });
  const patched = applyEdits(content, edits);
  return writeTempConfigFile(`artizo-override-${Date.now()}.json`, patched);
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
 * Get the parent SSH resolver's ExecServer via the proposed API. Returns
 * undefined when the API is unavailable or the resolver doesn't implement it.
 */
async function getRemoteExecServer(
  authority: string | undefined,
): Promise<ExecServer | undefined> {
  if (!authority) return undefined;
  const get = (
    vscode.workspace as unknown as {
      getRemoteExecServer?: (a: string) => Promise<ExecServer | undefined>;
    }
  ).getRemoteExecServer;
  if (typeof get !== "function") return undefined;
  try {
    return await get.call(vscode.workspace, authority);
  } catch (err: unknown) {
    getLogger().warn(
      `getRemoteExecServer failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

/**
 * Read and validate the workspace's devcontainer.json before a launch.
 * Returns undefined when the user declined to create a missing config.
 */
export async function readLaunchConfig(params: {
  deps: WorkflowDependencies;
  ui: WorkflowUI;
  workspaceUri: vscode.Uri;
  promptCreate?: boolean;
}): Promise<ReadConfigResult | undefined> {
  const { deps, ui, workspaceUri, promptCreate } = params;
  const configResult = await deps.configManager.readConfig(workspaceUri);

  if (!configResult.config) {
    if (!promptCreate) {
      throw new Error("No devcontainer.json found in workspace");
    }
    const shouldCreate = await ui.promptCreateConfig();
    if (!shouldCreate) {
      throw new Error("No devcontainer.json. User cancelled");
    }
    throw new Error("No devcontainer.json. Awaiting creation");
  }

  if (configResult.parseErrors.length > 0) {
    const errorMessages = configResult.parseErrors
      .map((e) => `Line ${e.line}: ${e.message}`)
      .join("\n");
    throw new Error(`devcontainer.json has parse errors:\n${errorMessages}`);
  }
  assertForwardPortsValid(configResult.config, configResult.configPath);
  return configResult;
}

/**
 * The container-side workspace folder for a config, computed without running
 * the CLI. Must match what the CLI resolves, because it is baked into the
 * window URI before the resolver runs.
 *
 * Mirrors `getWorkspaceConfiguration` (spec-node/utils.ts):
 * - `config.workspaceFolder` wins.
 * - compose configs use `getRemoteWorkspaceFolder` = `workspaceFolder || '/'`.
 * - otherwise `/workspaces/<basename>`. `mountWorkspaceGitRoot` is always
 *   false here (see `api.ts`), so the host mount folder is the workspace
 *   folder itself and there is no relative suffix. `workspaceFromPath` treats
 *   a `.code-workspace` path as its directory, so do the same.
 */
export function containerWorkspacePath(
  config: Record<string, unknown> | undefined,
  hostWorkspaceFolder: string,
): string {
  const configured = config?.["workspaceFolder"];
  if (typeof configured === "string" && configured.trim()) {
    return configured.startsWith("/") ? configured : `/${configured}`;
  }
  if (config && "dockerComposeFile" in config) {
    return "/";
  }
  const hostFolder = hostWorkspaceFolder.endsWith(".code-workspace")
    ? hostWorkspaceFolder.replace(/[\\/][^\\/]*$/, "")
    : hostWorkspaceFolder;
  const basename = hostFolder.split(/[\\/]/).filter(Boolean).pop() ?? "workspace";
  return `/workspaces/${basename}`;
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
  containerId?: string;
  containerPort?: number;
  installPath?: string;
  connectionToken: string | undefined;
  workspaceFolder: string;
  workspacePath: string;
  uriPath: string;
  windowOptions?: { forceNewWindow?: boolean; forceReuseWindow?: boolean };
}): Promise<void> {
  const tier = getTier();
  const isRemoteSsh =
    tier.tier === ExecutionTier.RemoteSSH && tier.owner === "ui";

  // Reveal the output channel: the build is done and the window is about to
  // open, which is the wait where live output matters.
  getLogger().show();

  // Remote SSH: the relay is spawned through the parent's ExecServer, and the
  // SSH host's node path comes from product.json. Both are apex-side.
  let execServer: ExecServer | undefined;
  let productInfo: ProductInfo | undefined;
  if (isRemoteSsh) {
    execServer = await getRemoteExecServer(tier.remoteAuthority);
    productInfo = await getProductInfo(vscode.env.appRoot);
  }

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
    dockerPath: getDockerPath(),
    ui: params.ui,
    execServer,
    productInfo,
  });
  const url = `vscode-remote://${authority}${params.uriPath}`;
  if (params.windowOptions) {
    await params.ui.openWindow(url, params.windowOptions);
  } else {
    await params.ui.openWindow(url);
  }
  getLogger().info(`[postLaunch] openWindow returned: ${url}`);

  // Capture the folder we just opened for the Recent Folders list. Skip
  // Remote SSH: the authority built there is the opaque `{ proxy: true, ... }`
  // relay payload, not a stable reopenable key. The shared module's keyPrefix
  // keeps this history separate from zygos's SSH history.
  if (!isRemoteSsh) {
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
