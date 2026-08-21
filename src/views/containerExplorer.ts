/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/** Container Explorer tree view for the Remote Explorer panel. */

import * as vscode from "vscode";
import { dockerExecPolicy } from "../docker/execPolicy.js";
import { MANAGED_LABEL } from "../utils/constants";
import { parseContainerList, isDevContainer } from "../devcontainer/labels";
import {
  type ContainerTarget,
  CategoryTreeItem,
  ContainerTreeItem,
  RecentFolderGroupTreeItem,
  RecentFolderTreeItem,
  VolumeTreeItem,
} from "./treeItems";
import { buildRemoteAuthority, decodeAuthority } from "../utils/uriUtils";
import {
  SCHEME_ATTACHED_CONTAINER,
} from "../remote/authorityResolver";
import {
  FolderDescriptor,
  type FolderHistoryManager,
} from "../remote/folderHistory";

type ExplorerTreeItem =
  | CategoryTreeItem
  | ContainerTreeItem
  | RecentFolderGroupTreeItem
  | RecentFolderTreeItem
  | VolumeTreeItem;

export interface IContainerExplorerProvider extends vscode.TreeDataProvider<ExplorerTreeItem> {
  refresh(): void;
  getTargets(): Promise<ContainerTarget[]>;
}

export interface ContainerExplorerOptions {
  history: FolderHistoryManager;
}

/**
 * TreeDataProvider for the Dev Containers explorer in the Remote Explorer panel.
 *
 * "Recent Folders" is backed by the shared `FolderHistoryManager` and grouped
 * by container authority (`artizo-container+<hex>` / `attached-container+<hex>`),
 * so folders opened against the same container show together. The old flat
 * `artizo.recentFolders` string[] store was never populated (dead code) and
 * is dropped — no migration needed.
 */
export class ContainerExplorerProvider implements IContainerExplorerProvider {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    ExplorerTreeItem | undefined | void
  >();
  readonly onDidChangeTreeData: vscode.Event<
    ExplorerTreeItem | undefined | void
  > = this._onDidChangeTreeData.event;

  private readonly history: FolderHistoryManager;

  constructor(options: ContainerExplorerOptions) {
    this.history = options.history;
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  async getTargets(): Promise<ContainerTarget[]> {
    const [containers, volumes] = await Promise.all([
      this.getRunningContainers(),
      this.getVolumes(),
    ]);
    return [...containers, ...volumes];
  }

  getTreeItem(element: ExplorerTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: ExplorerTreeItem): Promise<ExplorerTreeItem[]> {
    if (!element) {
      return [
        new CategoryTreeItem("Dev Containers", "containers"),
        new CategoryTreeItem("Recent Folders", "recent-folders"),
        new CategoryTreeItem("Volumes", "volumes"),
      ];
    }

    if (element instanceof CategoryTreeItem) {
      switch (element.category) {
        case "containers":
          return (await this.getRunningContainers()).map(
            (t) => new ContainerTreeItem(t),
          );
        case "recent-folders":
          // One collapsible group per container authority that has folders.
          return this.history
            .getRemotes()
            .map((remote) => new RecentFolderGroupTreeItem(remote, groupLabel(remote)));
        case "volumes":
          return (await this.getVolumes()).map((t) => new VolumeTreeItem(t));
      }
    }

    if (element instanceof RecentFolderGroupTreeItem) {
      return this.history
        .getFolders(element.remote)
        .map((d) => new RecentFolderTreeItem(d));
    }

    return [];
  }

  private async getRunningContainers(): Promise<ContainerTarget[]> {
    try {
      const result = await dockerExecPolicy([
        "ps",
        "-a",
        "--no-trunc",
        "--format",
        "{{json .}}",
      ]);

      if (result.exitCode !== 0) {
        return [];
      }

      const summaries = parseContainerList(result.stdout);
      return summaries
        .filter((s) => isDevContainer(s.labels))
        .map((s) => ({
          type: "running-container" as const,
          label: s.name || s.id.substring(0, 12) || "unknown",
          containerId: s.id,
          status: s.state === "running" ? "running" : "stopped",
        }));
    } catch {
      return [];
    }
  }

  private async getVolumes(): Promise<ContainerTarget[]> {
    try {
      const result = await dockerExecPolicy([
        "volume",
        "ls",
        "--no-trunc",
        "--filter",
        `label=${MANAGED_LABEL}`,
        "--format",
        "{{json .}}",
      ]);

      if (result.exitCode !== 0) {
        return [];
      }

      const lines = result.stdout.trim().split("\n").filter(Boolean);
      return lines.map((line) => {
        const volume = JSON.parse(line);
        return {
          type: "volume" as const,
          label: volume.Name || "unknown",
          volumeName: volume.Name,
          status: "stopped" as const,
        };
      });
    } catch {
      return [];
    }
  }

  /** Register the tree view and commands. Called from services.ts. */
  static register(
    context: vscode.ExtensionContext,
    history: FolderHistoryManager,
  ): ContainerExplorerProvider {
    const provider = new ContainerExplorerProvider({ history });

    // Auto-refresh when the history changes (addFolders after connecting,
    // removeFolder after forgetting).
    context.subscriptions.push(
      history.onDidChange(() => provider.refresh()),
    );

    const treeView = vscode.window.createTreeView("artizo.explorer", {
      treeDataProvider: provider,
      showCollapseAll: true,
    });

    context.subscriptions.push(treeView);

    context.subscriptions.push(
      // View title + refresh
      vscode.commands.registerCommand("artizo.explorer.refresh", () =>
        provider.refresh(),
      ),

      // Connect (containers + recent folders). Dispatch on item type:
      // containers reuse the existing connectToTarget path (now also
      // captures so an attached container shows up in Recent Folders);
      // recent folders reopen via the folder descriptor's vscode-remote
      // URI and re-capture (bumps to front, most-recent-first).
      vscode.commands.registerCommand(
        "artizo.explorer.connectCurrentWindow",
        (item: ContainerTreeItem | RecentFolderTreeItem) => {
          if (item instanceof RecentFolderTreeItem) {
            return openRecentFolder(item.descriptor, false, history, provider);
          }
          return connectToTarget(item.target, false, history, provider);
        },
      ),
      vscode.commands.registerCommand(
        "artizo.explorer.connectNewWindow",
        (item: ContainerTreeItem | RecentFolderTreeItem) => {
          if (item instanceof RecentFolderTreeItem) {
            return openRecentFolder(item.descriptor, true, history, provider);
          }
          return connectToTarget(item.target, true, history, provider);
        },
      ),

      // Container lifecycle
      vscode.commands.registerCommand(
        "artizo.explorer.stopContainer",
        (item: ContainerTreeItem) => stopContainer(item.target),
      ),
      vscode.commands.registerCommand(
        "artizo.explorer.startContainer",
        (item: ContainerTreeItem) => startContainer(item.target),
      ),
      vscode.commands.registerCommand(
        "artizo.explorer.removeContainer",
        (item: ContainerTreeItem) => removeContainer(item.target),
      ),
      vscode.commands.registerCommand(
        "artizo.explorer.showLogs",
        (item: ContainerTreeItem) => showContainerLogs(item.target),
      ),

      // Forget a recent folder: remove the visual link only. The folder on
      // disk and the container are not touched. No confirmation dialog -
      // the label + tooltip make the scope clear (matches MS Remote-SSH).
      vscode.commands.registerCommand(
        "artizo.explorer.forgetFolder",
        async (item: RecentFolderTreeItem) => {
          if (!item) return;
          const descriptor: FolderDescriptor = item.descriptor;
          await history.removeFolder(descriptor);
          provider.refresh();
        },
      ),

      // Volumes
      vscode.commands.registerCommand(
        "artizo.explorer.inspectVolume",
        (item: VolumeTreeItem) => inspectVolume(item.target),
      ),
      vscode.commands.registerCommand(
        "artizo.explorer.removeVolume",
        (item: VolumeTreeItem) => removeVolume(item.target),
      ),
      vscode.commands.registerCommand("artizo.explorer.cloneInVolume", () =>
        vscode.commands.executeCommand("artizo.cloneInVolume"),
      ),
    );

    return provider;
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}

/** Human-readable label for a recent-folder group authority. */
function groupLabel(remote: string): string {
  try {
    const { scheme, id } = decodeAuthority(remote);
    if (scheme === "attached-container") {
      // id is the container id; show a short prefix.
      return `Container ${id.substring(0, 12)}`;
    }
    // artizo-container: id is the host-side workspace folder path.
    // Show just the basename (e.g. "aergic" from
    // "C:\Users\kerry\github\aergic" or "/home/user/project").
    const basename = id.split(/[\\/]/).filter(Boolean).pop();
    return basename || id;
  } catch {
    return remote;
  }
}

/** Reopen a recent folder. Re-captures so the entry moves to the front. */
async function openRecentFolder(
  descriptor: FolderDescriptor,
  newWindow: boolean,
  history: FolderHistoryManager,
  provider: ContainerExplorerProvider,
): Promise<void> {
  try {
    await history.addFolders([descriptor]);
  } catch {
    // best effort — never block the open
  }
  await vscode.commands.executeCommand("vscode.openFolder", descriptor.toUri(), {
    forceNewWindow: newWindow,
  });
  provider.refresh();
}

async function connectToTarget(
  target: ContainerTarget,
  newWindow: boolean,
  history: FolderHistoryManager,
  provider: ContainerExplorerProvider,
): Promise<void> {
  if (target.type === "running-container" && target.containerId) {
    const authority = buildRemoteAuthority(
      SCHEME_ATTACHED_CONTAINER,
      target.containerId,
    );
    const uri = vscode.Uri.parse(`vscode-remote://${authority}/`);
    // Capture so an attached container also shows up in Recent Folders
    // for one-click reopen next time. Same skip rule as buildAuthorityAndOpen:
    // at State 4 (RemoteSSH + owner workspace) the authority is the opaque
    // relay payload and isn't a stable reopenable key. Here we're always on
    // the apex (the explorer only renders where artizo.hostContext is set),
    // so State 4 doesn't apply — but the try/catch keeps it fire-and-forget.
    try {
      const d = FolderDescriptor.fromUri(uri);
      if (d) await history.addFolders([d]);
    } catch {
      // best effort
    }
    await vscode.commands.executeCommand("vscode.openFolder", uri, {
      forceNewWindow: newWindow,
    });
    provider.refresh();
  }
}

async function stopContainer(target: ContainerTarget): Promise<void> {
  if (!target.containerId) return;
  const result = await dockerExecPolicy(["stop", target.containerId]);
  if (result.exitCode !== 0) {
    vscode.window.showErrorMessage(
      `Failed to stop container: ${result.stderr}`,
    );
    return;
  }
  vscode.commands.executeCommand("artizo.explorer.refresh");
}

async function startContainer(target: ContainerTarget): Promise<void> {
  if (!target.containerId) return;
  const result = await dockerExecPolicy(["start", target.containerId]);
  if (result.exitCode !== 0) {
    vscode.window.showErrorMessage(
      `Failed to start container: ${result.stderr}`,
    );
    return;
  }
  vscode.commands.executeCommand("artizo.explorer.refresh");
}

async function removeContainer(target: ContainerTarget): Promise<void> {
  if (!target.containerId) return;
  const confirm = await vscode.window.showWarningMessage(
    `Remove container "${target.label}"? This cannot be undone.`,
    { modal: true },
    "Remove",
  );
  if (confirm !== "Remove") return;
  const result = await dockerExecPolicy(["rm", "-f", target.containerId]);
  if (result.exitCode !== 0) {
    vscode.window.showErrorMessage(
      `Failed to remove container: ${result.stderr}`,
    );
    return;
  }
  vscode.commands.executeCommand("artizo.explorer.refresh");
}

async function showContainerLogs(target: ContainerTarget): Promise<void> {
  if (!target.containerId) return;
  const terminal = vscode.window.createTerminal(`logs: ${target.label}`);
  terminal.show(true);
  // Allow the shell to initialize.
  await new Promise((resolve) => setTimeout(resolve, 200));
  terminal.sendText(`docker logs -f ${target.containerId}`);
}

async function inspectVolume(target: ContainerTarget): Promise<void> {
  if (!target.volumeName) return;
  const result = await dockerExecPolicy([
    "volume",
    "inspect",
    target.volumeName,
  ]);
  if (result.exitCode !== 0) {
    vscode.window.showErrorMessage(
      `Failed to inspect volume "${target.volumeName}": ${result.stderr}`,
    );
    return;
  }
  const doc = await vscode.workspace.openTextDocument({
    content: result.stdout,
    language: "json",
  });
  await vscode.window.showTextDocument(doc);
}

async function removeVolume(target: ContainerTarget): Promise<void> {
  if (!target.volumeName) return;
  const confirm = await vscode.window.showWarningMessage(
    `Remove volume "${target.volumeName}"? This cannot be undone.`,
    { modal: true },
    "Remove",
  );
  if (confirm !== "Remove") return;
  const result = await dockerExecPolicy(["volume", "rm", target.volumeName]);
  if (result.exitCode !== 0) {
    vscode.window.showErrorMessage(
      `Failed to remove volume "${target.volumeName}": ${result.stderr}`,
    );
    return;
  }
  vscode.window.showInformationMessage(
    `Volume "${target.volumeName}" removed.`,
  );
  vscode.commands.executeCommand("artizo.explorer.refresh");
}
