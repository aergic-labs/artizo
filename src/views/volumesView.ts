/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Volumes view. A tree view listing Docker volumes with support for
 * inspect, clone repository into, and remove actions.
 */

import * as vscode from "vscode";
import { dockerExecPolicy } from "../docker/execPolicy.js";
import { MANAGED_LABEL } from "../utils/constants";

/** Represents a Docker volume entry. */
export interface VolumeEntry {
  name: string;
  driver: string;
}

/** Tree item representing a Docker volume. */
export class VolumeViewItem extends vscode.TreeItem {
  constructor(public readonly volume: VolumeEntry) {
    super(volume.name, vscode.TreeItemCollapsibleState.None);

    this.description = volume.driver;
    this.tooltip = `Volume: ${volume.name}\nDriver: ${volume.driver}`;
    this.contextValue = "docker-volume";
    this.iconPath = new vscode.ThemeIcon("database");
  }
}

export class VolumesViewProvider implements vscode.TreeDataProvider<VolumeViewItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    VolumeViewItem | undefined | void
  >();
  readonly onDidChangeTreeData: vscode.Event<
    VolumeViewItem | undefined | void
  > = this._onDidChangeTreeData.event;

  /** Refresh the tree view. */
  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: VolumeViewItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: VolumeViewItem): Promise<VolumeViewItem[]> {
    if (element) {
      return [];
    }

    const volumes = await this.listVolumes();
    return volumes.map((v) => new VolumeViewItem(v));
  }

  /** List Docker volumes. */
  async listVolumes(): Promise<VolumeEntry[]> {
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
        const vol = JSON.parse(line);
        return {
          name: vol.Name || "unknown",
          driver: vol.Driver || "local",
        };
      });
    } catch {
      return [];
    }
  }

  /** Inspect a volume and show the result in an output channel. */
  async inspectVolume(volume: VolumeEntry): Promise<void> {
    try {
      const result = await dockerExecPolicy(["volume", "inspect", volume.name]);

      if (result.exitCode !== 0) {
        vscode.window.showErrorMessage(
          `Failed to inspect volume "${volume.name}": ${result.stderr}`,
        );
        return;
      }

      const doc = await vscode.workspace.openTextDocument({
        content: result.stdout,
        language: "json",
      });
      await vscode.window.showTextDocument(doc);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Failed to inspect volume: ${message}`);
    }
  }

  /** Remove a volume after user confirmation. */
  async removeVolume(volume: VolumeEntry): Promise<void> {
    const confirm = await vscode.window.showWarningMessage(
      `Remove volume "${volume.name}"? This cannot be undone.`,
      { modal: true },
      "Remove",
    );

    if (confirm !== "Remove") {
      return;
    }

    try {
      const result = await dockerExecPolicy(["volume", "rm", volume.name]);

      if (result.exitCode !== 0) {
        vscode.window.showErrorMessage(
          `Failed to remove volume "${volume.name}": ${result.stderr}`,
        );
        return;
      }

      vscode.window.showInformationMessage(`Volume "${volume.name}" removed.`);
      this.refresh();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Failed to remove volume: ${message}`);
    }
  }

  /** Register the volumes view and associated commands. */
  static register(context: vscode.ExtensionContext): VolumesViewProvider {
    const provider = new VolumesViewProvider();

    const treeView = vscode.window.createTreeView("artizo.volumesView", {
      treeDataProvider: provider,
      showCollapseAll: false,
    });

    context.subscriptions.push(treeView);

    // Register commands for volume actions
    context.subscriptions.push(
      vscode.commands.registerCommand("artizo.volumes.refresh", () =>
        provider.refresh(),
      ),
      vscode.commands.registerCommand(
        "artizo.volumes.inspect",
        (item: VolumeViewItem) => provider.inspectVolume(item.volume),
      ),
      vscode.commands.registerCommand(
        "artizo.volumes.remove",
        (item: VolumeViewItem) => provider.removeVolume(item.volume),
      ),
    );

    return provider;
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}
