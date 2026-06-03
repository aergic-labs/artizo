/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Container Explorer tree view: shows dev container targets in the
 * Remote Explorer panel. Displays three categories:
 * - Dev Containers (running containers with devcontainer labels)
 * - Recent Folders (recently opened workspace folders)
 * - Volumes (Docker volumes associated with dev containers)
 */

import * as vscode from "vscode";
import { dockerExecPolicy } from "../docker/execPolicy.js";
import { MANAGED_LABEL } from "../utils/constants";
import {
  type ContainerTarget,
  CategoryTreeItem,
  ContainerTreeItem,
  RecentFolderTreeItem,
  VolumeTreeItem,
} from "./treeItems";
import {
  SCHEME_DEV_CONTAINER,
  SCHEME_ATTACHED_CONTAINER,
} from "../remote/authorityResolver";

const RECENT_FOLDERS_KEY = "artizo.recentFolders";

const LABEL_DEVCONTAINER = "devcontainer.local_folder";

type ExplorerTreeItem =
  | CategoryTreeItem
  | ContainerTreeItem
  | RecentFolderTreeItem
  | VolumeTreeItem;

export interface IContainerExplorerProvider extends vscode.TreeDataProvider<ExplorerTreeItem> {
  refresh(): void;
  getTargets(): Promise<ContainerTarget[]>;
}

export interface ContainerExplorerOptions {
  globalState: vscode.Memento;
}

/**
 * TreeDataProvider for the Dev Containers explorer in the Remote Explorer panel.
 */
export class ContainerExplorerProvider implements IContainerExplorerProvider {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    ExplorerTreeItem | undefined | void
  >();
  readonly onDidChangeTreeData: vscode.Event<
    ExplorerTreeItem | undefined | void
  > = this._onDidChangeTreeData.event;

  private readonly globalState: vscode.Memento;

  constructor(options: ContainerExplorerOptions) {
    this.globalState = options.globalState;
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  async getTargets(): Promise<ContainerTarget[]> {
    const [containers, recentFolders, volumes] = await Promise.all([
      this.getRunningContainers(),
      this.getRecentFolders(),
      this.getVolumes(),
    ]);
    return [...containers, ...recentFolders, ...volumes];
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
          return (await this.getRecentFolders()).map(
            (t) => new RecentFolderTreeItem(t),
          );
        case "volumes":
          return (await this.getVolumes()).map((t) => new VolumeTreeItem(t));
      }
    }

    return [];
  }

  private async getRunningContainers(): Promise<ContainerTarget[]> {
    try {
      const result = await dockerExecPolicy([
        "ps",
        "--filter",
        `label=${LABEL_DEVCONTAINER}`,
        "--format",
        "{{json .}}",
      ]);

      if (result.exitCode !== 0) {
        return [];
      }

      const lines = result.stdout.trim().split("\n").filter(Boolean);
      return lines.map((line) => {
        const container = JSON.parse(line);
        return {
          type: "running-container" as const,
          label: container.Names || container.ID?.substring(0, 12) || "unknown",
          containerId: container.ID,
          status:
            container.State === "running"
              ? ("running" as const)
              : ("stopped" as const),
        };
      });
    } catch {
      return [];
    }
  }

  private async getRecentFolders(): Promise<ContainerTarget[]> {
    const folders = this.globalState.get<string[]>(RECENT_FOLDERS_KEY, []);
    return folders.map((folder) => ({
      type: "recent-folder" as const,
      label: folder.split(/[\\/]/).pop() || folder,
      workspacePath: folder,
      status: "stopped" as const,
    }));
  }

  private async getVolumes(): Promise<ContainerTarget[]> {
    try {
      const result = await dockerExecPolicy([
        "volume",
        "ls",
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

  async addRecentFolder(folderPath: string): Promise<void> {
    const folders = this.globalState.get<string[]>(RECENT_FOLDERS_KEY, []);
    const updated = [
      folderPath,
      ...folders.filter((f) => f !== folderPath),
    ].slice(0, 20);
    await this.globalState.update(RECENT_FOLDERS_KEY, updated);
    this.refresh();
  }

  async removeRecentFolder(folderPath: string): Promise<void> {
    const folders = this.globalState.get<string[]>(RECENT_FOLDERS_KEY, []);
    const updated = folders.filter((f) => f !== folderPath);
    await this.globalState.update(RECENT_FOLDERS_KEY, updated);
    this.refresh();
  }

  /**
   * Register the container explorer tree view and associated commands.
   */
  static register(context: vscode.ExtensionContext): ContainerExplorerProvider {
    const provider = new ContainerExplorerProvider({
      globalState: context.globalState,
    });

    const treeView = vscode.window.createTreeView("artizo.explorer", {
      treeDataProvider: provider,
      showCollapseAll: true,
    });

    context.subscriptions.push(treeView);

    // Register commands for container actions
    context.subscriptions.push(
      vscode.commands.registerCommand("artizo.explorer.refresh", () =>
        provider.refresh(),
      ),
      vscode.commands.registerCommand(
        "artizo.explorer.connectCurrentWindow",
        (item: ContainerTreeItem | RecentFolderTreeItem) =>
          connectToTarget(item.target, false),
      ),
      vscode.commands.registerCommand(
        "artizo.explorer.connectNewWindow",
        (item: ContainerTreeItem | RecentFolderTreeItem) =>
          connectToTarget(item.target, true),
      ),
    );

    return provider;
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}

async function connectToTarget(
  target: ContainerTarget,
  newWindow: boolean,
): Promise<void> {
  if (target.type === "running-container" && target.containerId) {
    const uri = vscode.Uri.parse(
      `vscode-remote://${SCHEME_ATTACHED_CONTAINER}+${Buffer.from(target.containerId).toString("hex")}/`,
    );
    await vscode.commands.executeCommand("vscode.openFolder", uri, {
      forceNewWindow: newWindow,
    });
  } else if (target.type === "recent-folder" && target.workspacePath) {
    const uri = vscode.Uri.parse(
      `vscode-remote://${SCHEME_DEV_CONTAINER}+${Buffer.from(target.workspacePath).toString("hex")}/`,
    );
    await vscode.commands.executeCommand("vscode.openFolder", uri, {
      forceNewWindow: newWindow,
    });
  }
}