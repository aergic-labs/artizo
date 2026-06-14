/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Command handler registrations.
 *
 * Extracted from extension.ts. Each function registers all command
 * handlers that were previously inline in the activate() function.
 *
 * Uses the shared CommandSpec-based runner from commandRunner.ts to
 * reduce boilerplate in guard, logging, and error handling patterns.
 *
 * Each handler is exported as a standalone function so it can be
 * unit-tested with a mock CommandContext. The registration closures
 * are thin wrappers that call the exported functions.
 */

import * as vscode from "vscode";
import { getLogger } from "../utils/logger";
import { BRAND_PREFIX } from "../utils/constants";
import type { WorkflowDependencies } from "../workflows/types";
import type { VscodeWorkflowUI } from "../workflows/vscodeUI";
import type { LogOutputTerminal } from "../workflows/logOutputTerminal";
import type { ConfigManager } from "../config/configManager";
import type { ContainerLifecycle } from "../lifecycle/containerLifecycle";
import type { WorkflowOrchestrator } from "../workflows/orchestrator";
import { reopenInContainer } from "../workflows/reopenInContainer";
import { rebuildContainer } from "../workflows/rebuildContainer";
import { openFolderInContainer } from "../workflows/openFolder";
import { cloneInVolume } from "../workflows/cloneInVolume";
import { attachToContainer } from "../workflows/attachToContainer";
import type { SidebarProvider } from "../sidebar/provider";
import {
  guardLocalContext,
  checkDockerAvailable,
  getLocalWorkspaceFolder,
} from "./guards";
import { registerCommand, type CommandSpec } from "./commandRunner";
import { ProvisionFailedError } from "../devcontainer/provisionError";
import { reportProvisionFailure } from "./reportProvisionFailure";
import {
  buildOpenFolderUI,
  buildCloneInVolumeUI,
  buildAttachUI,
  buildDockerLister,
} from "./adapters";

export interface CommandContext {
  deps: WorkflowDependencies;
  ui: VscodeWorkflowUI;
  configManager: ConfigManager;
  containerLifecycle: ContainerLifecycle;
  orchestrator: WorkflowOrchestrator;
  buildLogTerminal: { show(preserveFocus?: boolean): void };
  buildLogPty: LogOutputTerminal;
  dockerPath: string;
  sidebarProvider: SidebarProvider;
  extensionUri: vscode.Uri;
}

function wrapError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Report a rebuild failure. Build/provision failures route to the shared
 * reportProvisionFailure (offering "Diagnose with AI"); anything else falls
 * back to the plain "Rebuild failed" notification.
 */
async function reportRebuildFailure(
  ctx: CommandContext,
  error: Error,
  workspaceFolder: string,
): Promise<void> {
  ctx.buildLogPty.writeLine(`${BRAND_PREFIX} ERROR: ${error.message}`);
  if (error instanceof ProvisionFailedError) {
    await reportProvisionFailure(
      error,
      {
        buildLogPty: ctx.buildLogPty,
        buildLogTerminal: ctx.buildLogTerminal,
        configManager: ctx.configManager,
        extensionUri: ctx.extensionUri,
      },
      workspaceFolder,
    );
    return;
  }
  ctx.buildLogTerminal.show(true);
  vscode.window
    .showErrorMessage(`Rebuild failed: ${error.message}`, "Show Log")
    .then((action) => {
      if (action === "Show Log") ctx.buildLogTerminal.show(true);
    });
}

export async function reopenInContainerHandler(
  ctx: CommandContext,
  workspaceFolder?: string,
): Promise<void> {
  await reopenInContainer(ctx.deps, ctx.ui, {
    workspaceFolder: workspaceFolder!,
  });
}

export async function rebuildAndReopenInContainerHandler(
  ctx: CommandContext,
  workspaceFolder?: string,
): Promise<void> {
  await rebuildContainer(ctx.deps, ctx.ui, {
    workspaceFolder: workspaceFolder!,
    noCache: false,
    reconnect: true,
  });
}

export async function cloneInVolumeHandler(ctx: CommandContext): Promise<void> {
  const repoUrl = await vscode.window.showInputBox({
    prompt: "Enter the repository URL to clone",
    placeHolder: "https://github.com/owner/repo.git",
  });
  if (!repoUrl) return;
  const cloneUI = buildCloneInVolumeUI(ctx.ui, repoUrl);
  await cloneInVolume(ctx.deps, cloneUI, { repoUrl });
}

export async function attachToRunningContainerHandler(
  ctx: CommandContext,
): Promise<void> {
  const attachUI = buildAttachUI(ctx.ui);
  const dockerList = buildDockerLister();
  await attachToContainer(ctx.deps, attachUI, dockerList, {});
}

export async function cleanUpContainersHandler(
  ctx: CommandContext,
): Promise<void> {
  const logger = getLogger();
  const shouldRemoveImages = await vscode.window.showQuickPick(
    [
      "Containers only",
      "Containers and images",
      "Containers, images, and volumes",
    ],
    { placeHolder: "What should be cleaned up?" },
  );
  if (!shouldRemoveImages) return;

  const removeImages = shouldRemoveImages !== "Containers only";
  const removeVolumes =
    shouldRemoveImages === "Containers, images, and volumes";

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Cleaning up dev containers...",
    },
    async () => {
      const result = await ctx.containerLifecycle.cleanUp({
        removeImages,
        removeVolumes,
      });
      const parts: string[] = [];
      if (result.containersRemoved > 0)
        parts.push(`${result.containersRemoved} container(s)`);
      if (result.imagesRemoved > 0)
        parts.push(`${result.imagesRemoved} image(s)`);
      if (result.volumesRemoved > 0)
        parts.push(`${result.volumesRemoved} volume(s)`);

      if (parts.length > 0) {
        vscode.window.showInformationMessage(
          `Cleanup complete: ${parts.join(", ")} removed.`,
        );
      } else {
        vscode.window.showInformationMessage("Nothing to clean up.");
      }

      if (result.errors.length > 0) {
        vscode.window.showWarningMessage(
          `Cleanup completed with ${result.errors.length} error(s). Check the log for details.`,
        );
        for (const err of result.errors) {
          logger.error(`Cleanup error: ${err}`);
        }
      }
    },
  );
}

export async function configureDevContainerHandler(
  ctx: CommandContext,
): Promise<void> {
  await vscode.commands.executeCommand(
    "workbench.view.extension.artizo-sidebar",
  );
  await ctx.sidebarProvider.loadConfig();
  const hasConfig = ctx.sidebarProvider.hasConfig();
  ctx.sidebarProvider.expandSection(hasConfig ? "config" : "wizard");
}

export async function addConfigurationHandler(
  ctx: CommandContext,
): Promise<void> {
  await vscode.commands.executeCommand(
    "workbench.view.extension.artizo-sidebar",
  );
  await ctx.sidebarProvider.loadConfig();
  const hasConfig = ctx.sidebarProvider.hasConfig();
  ctx.sidebarProvider.expandSection(hasConfig ? "config" : "wizard");
}

export async function openDevContainerFileHandler(
  ctx: CommandContext,
  workspaceFolder?: string,
): Promise<void> {
  const configPath = ctx.configManager.getConfigPath(workspaceFolder!);
  if (!configPath) {
    vscode.window.showErrorMessage("No devcontainer.json found in workspace.");
    return;
  }
  const doc = await vscode.workspace.openTextDocument(configPath);
  await vscode.window.showTextDocument(doc);
}

export async function openFolderInContainerHandler(
  ctx: CommandContext,
): Promise<void> {
  const openFolderUI = buildOpenFolderUI(ctx.ui);
  await openFolderInContainer(ctx.deps, openFolderUI, {});
}

export async function rebuildContainerMenuHandler(
  ctx: CommandContext,
): Promise<void> {
  const logger = getLogger();
  const inContainer = vscode.env.remoteName?.startsWith("artizo-container");
  const workspaceFolder = inContainer
    ? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    : getLocalWorkspaceFolder();
  if (!workspaceFolder) {
    vscode.window.showErrorMessage("No workspace folder open.");
    return;
  }

  if (inContainer) {
    const action = await vscode.window.showErrorMessage(
      `${BRAND_PREFIX} Rebuild must be run from a local window. You are currently connected to a dev container.`,
      "Reopen Folder Locally",
    );
    if (action === "Reopen Folder Locally") {
      vscode.commands.executeCommand("artizo.reopenLocally");
    }
    return;
  }

  const picked = await vscode.window.showQuickPick(
    [
      { label: "Rebuild", description: "Rebuild the container image" },
      { label: "Rebuild Without Cache", description: "Rebuild from scratch" },
      { label: "Rebuild and Reopen", description: "Rebuild and reconnect" },
    ],
    { placeHolder: "Rebuild Container" },
  );

  if (!picked) return;

  const noCache = picked.label === "Rebuild Without Cache";
  const reconnect = picked.label === "Rebuild and Reopen";

  try {
    logger.info(`=== ${picked.label} starting ===`);
    ctx.buildLogTerminal.show(true);
    ctx.buildLogPty.writeLine(`${BRAND_PREFIX} ${picked.label} starting...`);
    guardLocalContext();
    await checkDockerAvailable(ctx.dockerPath);
    guardLocalContext();
    ctx.buildLogPty.writeLine(`${BRAND_PREFIX} Workspace: ${workspaceFolder}`);
    await rebuildContainer(ctx.deps, ctx.ui, {
      workspaceFolder,
      noCache,
      reconnect,
    });
    logger.info(`=== ${picked.label} completed ===`);
  } catch (err: unknown) {
    const error = wrapError(err);
    logger.error(`Rebuild failed`, error);
    await reportRebuildFailure(ctx, error, workspaceFolder);
  }
}

export async function rebuildContainerHandler(
  ctx: CommandContext,
): Promise<void> {
  const logger = getLogger();
  const inContainer = vscode.env.remoteName?.startsWith("artizo-container");
  const workspaceFolder = inContainer
    ? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    : getLocalWorkspaceFolder();
  if (!workspaceFolder) {
    vscode.window.showErrorMessage("No workspace folder open.");
    return;
  }
  try {
    logger.info("=== Rebuild Container starting ===");
    ctx.buildLogTerminal.show(true);
    ctx.buildLogPty.writeLine(`${BRAND_PREFIX} Rebuild Container starting...`);

    if (inContainer) {
      const action = await vscode.window.showErrorMessage(
        `${BRAND_PREFIX} Rebuild must be run from a local window. You are currently connected to a dev container.`,
        "Reopen Folder Locally",
      );
      if (action === "Reopen Folder Locally") {
        vscode.commands.executeCommand("artizo.reopenLocally");
      }
      return;
    }

    guardLocalContext();
    await checkDockerAvailable(ctx.dockerPath);
    guardLocalContext();
    ctx.buildLogPty.writeLine(`${BRAND_PREFIX} Workspace: ${workspaceFolder}`);
    await rebuildContainer(ctx.deps, ctx.ui, {
      workspaceFolder,
      noCache: false,
      reconnect: false,
    });
    logger.info("=== Rebuild Container completed ===");
  } catch (err: unknown) {
    const error = wrapError(err);
    logger.error("Rebuild container failed", error);
    await reportRebuildFailure(ctx, error, workspaceFolder);
  }
}

export async function rebuildContainerNoCacheHandler(
  ctx: CommandContext,
): Promise<void> {
  const logger = getLogger();
  const inContainer = vscode.env.remoteName?.startsWith("artizo-container");
  const workspaceFolder = inContainer
    ? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    : getLocalWorkspaceFolder();
  if (!workspaceFolder) {
    vscode.window.showErrorMessage("No workspace folder open.");
    return;
  }
  try {
    logger.info("=== Rebuild Container (no cache) starting ===");
    ctx.buildLogTerminal.show(true);
    ctx.buildLogPty.writeLine(
      `${BRAND_PREFIX} Rebuild Without Cache starting...`,
    );

    if (inContainer) {
      const action = await vscode.window.showErrorMessage(
        `${BRAND_PREFIX} Rebuild must be run from a local window. You are currently connected to a dev container.`,
        "Reopen Folder Locally",
      );
      if (action === "Reopen Folder Locally") {
        vscode.commands.executeCommand("artizo.reopenLocally");
      }
      return;
    }

    guardLocalContext();
    await checkDockerAvailable(ctx.dockerPath);
    guardLocalContext();
    await rebuildContainer(ctx.deps, ctx.ui, {
      workspaceFolder,
      noCache: true,
      reconnect: false,
    });
    logger.info("=== Rebuild Container (no cache) completed ===");
  } catch (err: unknown) {
    const error = wrapError(err);
    logger.error("Rebuild container (no cache) failed", error);
    await reportRebuildFailure(ctx, error, workspaceFolder);
  }
}

export async function reopenLocallyHandler(ctx: CommandContext): Promise<void> {
  const inContainer = vscode.env.remoteName?.startsWith("artizo-container");
  if (inContainer) {
    const localPath = getLocalWorkspaceFolder();
    if (localPath) {
      await vscode.commands.executeCommand(
        "vscode.openFolder",
        vscode.Uri.file(localPath),
        { forceNewWindow: true },
      );
      await new Promise((r) => setTimeout(r, 2000));
    }
    await vscode.commands.executeCommand("workbench.action.closeWindow");
  } else if (ctx.orchestrator.state === "connected") {
    ctx.orchestrator.beginDisconnect();
    ctx.orchestrator.disconnectComplete();
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (workspaceFolder) {
      await vscode.commands.executeCommand(
        "vscode.openFolder",
        workspaceFolder,
      );
    }
  }
}

/** Register all core command handlers. */
export function registerCoreCommands(
  context: vscode.ExtensionContext,
  ctx: CommandContext,
): void {
  const specGuardedDocker: CommandSpec[] = [
    {
      id: "artizo.reopenInContainer",
      label: "Reopen in Container",
      guardLocal: true,
      guardDocker: true,
      workspaceRequired: true,
      handler: (ctxC, ws) => reopenInContainerHandler(ctxC, ws),
    },
    {
      id: "artizo.rebuildAndReopenInContainer",
      label: "Rebuild and Reopen in Container",
      guardLocal: true,
      guardDocker: true,
      workspaceRequired: true,
      handler: (ctxC, ws) => rebuildAndReopenInContainerHandler(ctxC, ws),
    },
  ];

  const specDockerOnly: CommandSpec[] = [
    {
      id: "artizo.cloneInVolume",
      label: "Clone in Volume",
      guardLocal: true,
      guardDocker: true,
      workspaceRequired: false,
      handler: (ctxC) => cloneInVolumeHandler(ctxC),
    },
    {
      id: "artizo.attachToRunningContainer",
      label: "Attach to Running Container",
      guardLocal: true,
      guardDocker: true,
      workspaceRequired: false,
      handler: (ctxC) => attachToRunningContainerHandler(ctxC),
    },
    {
      id: "artizo.cleanUpContainers",
      label: "Clean Up Containers",
      guardLocal: true,
      guardDocker: true,
      workspaceRequired: false,
      handler: (ctxC) => cleanUpContainersHandler(ctxC),
    },
  ];

  const specWorkspaceOnly: CommandSpec[] = [
    {
      id: "artizo.configureDevContainer",
      label: "Configure Dev Container",
      guardLocal: false,
      guardDocker: false,
      workspaceRequired: true,
      handler: (ctxC) => configureDevContainerHandler(ctxC),
    },
  ];

  const specWorkspaceAndLocal: CommandSpec[] = [
    {
      id: "artizo.addConfiguration",
      label: "Add Configuration",
      guardLocal: true,
      guardDocker: false,
      workspaceRequired: true,
      handler: (ctxC) => addConfigurationHandler(ctxC),
    },
  ];

  const specNoGuard: CommandSpec[] = [
    {
      id: "artizo.openDevContainerFile",
      label: "Open Container Configuration File",
      guardLocal: false,
      guardDocker: false,
      workspaceRequired: true,
      handler: (ctxC, ws) => openDevContainerFileHandler(ctxC, ws),
    },
    {
      id: "artizo.openFolderInContainer",
      label: "Open Folder in Container",
      guardLocal: false,
      guardDocker: false,
      workspaceRequired: false,
      handler: (ctxC) => openFolderInContainerHandler(ctxC),
    },
  ];

  for (const spec of [
    ...specGuardedDocker,
    ...specDockerOnly,
    ...specWorkspaceOnly,
    ...specWorkspaceAndLocal,
    ...specNoGuard,
  ]) {
    registerCommand(context, ctx, spec);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("artizo.rebuildContainerMenu", () =>
      rebuildContainerMenuHandler(ctx),
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("artizo.rebuildContainer", () =>
      rebuildContainerHandler(ctx),
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("artizo.rebuildContainerNoCache", () =>
      rebuildContainerNoCacheHandler(ctx),
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("artizo.reopenLocally", async () => {
      try {
        await reopenLocallyHandler(ctx);
      } catch (err: unknown) {
        const error = wrapError(err);
        getLogger().error("Reopen locally failed", error);
        vscode.window.showErrorMessage(
          `Failed to reopen locally: ${error.message}`,
        );
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("artizo.explorer.refresh", () => {
      ctx.sidebarProvider.expandSection("containers");
    }),
    vscode.commands.registerCommand("artizo.volumes.refresh", () => {
      ctx.sidebarProvider.expandSection("volumes");
    }),
  );
}
