/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Details view. A read-only tree view that shows properties of the
 * currently connected container: image, container ID, mounts, ports,
 * environment variables, and labels.
 */

import * as vscode from "vscode";
import type { ContainerInfo } from "../utils/dockerUtils";

/** A detail entry shown in the details tree. */
export interface DetailEntry {
  label: string;
  value?: string;
  children?: DetailEntry[];
  icon?: string;
}

type DetailsTreeItem = DetailCategoryItem | DetailValueItem;

/** Tree item for a category (e.g., "Mounts", "Ports"). */
export class DetailCategoryItem extends vscode.TreeItem {
  constructor(public readonly entry: DetailEntry) {
    super(
      entry.label,
      entry.children && entry.children.length > 0
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None,
    );
    this.contextValue = "detail-category";
    if (entry.icon) {
      this.iconPath = new vscode.ThemeIcon(entry.icon);
    }
    if (entry.value) {
      this.description = entry.value;
    }
  }
}

/** Tree item for a single detail value (leaf node). */
export class DetailValueItem extends vscode.TreeItem {
  constructor(public readonly entry: DetailEntry) {
    super(entry.label, vscode.TreeItemCollapsibleState.None);
    this.description = entry.value;
    this.contextValue = "detail-value";
    if (entry.icon) {
      this.iconPath = new vscode.ThemeIcon(entry.icon);
    }
  }
}

/**
 * TreeDataProvider for the container details view.
 * Shows properties of the currently connected container.
 */
export class DetailsViewProvider implements vscode.TreeDataProvider<DetailsTreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    DetailsTreeItem | undefined | void
  >();
  readonly onDidChangeTreeData: vscode.Event<
    DetailsTreeItem | undefined | void
  > = this._onDidChangeTreeData.event;

  private containerInfo: ContainerInfo | null = null;

  /** Update the view with new container info. */
  setContainerInfo(info: ContainerInfo | null): void {
    this.containerInfo = info;
    this._onDidChangeTreeData.fire();
  }

  /** Refresh the tree view. */
  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: DetailsTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: DetailsTreeItem): DetailsTreeItem[] {
    if (!this.containerInfo) {
      return [];
    }

    if (!element) {
      return this.buildRootEntries();
    }

    if (element instanceof DetailCategoryItem && element.entry.children) {
      return element.entry.children.map((child) => new DetailValueItem(child));
    }

    return [];
  }

  private buildRootEntries(): DetailsTreeItem[] {
    const info = this.containerInfo!;
    const entries: DetailEntry[] = [];

    entries.push({
      label: "Image",
      value: info.config.image,
      icon: "package",
    });

    entries.push({
      label: "Container ID",
      value: info.id.substring(0, 12),
      icon: "key",
    });

    entries.push({
      label: "Status",
      value: info.state.status,
      icon: info.state.running ? "pass" : "circle-slash",
    });

    if (info.mounts.length > 0) {
      entries.push({
        label: "Mounts",
        icon: "folder-opened",
        children: info.mounts.map((m) => ({
          label: `${m.source} → ${m.destination}`,
          value: m.type,
          icon: "arrow-right",
        })),
      });
    }

    const portEntries = buildPortEntries(info.networkSettings.ports);
    if (portEntries.length > 0) {
      entries.push({
        label: "Ports",
        icon: "plug",
        children: portEntries,
      });
    }

    if (info.config.env.length > 0) {
      entries.push({
        label: "Environment",
        icon: "symbol-variable",
        children: info.config.env.map((envStr) => {
          const eqIdx = envStr.indexOf("=");
          const key = eqIdx >= 0 ? envStr.substring(0, eqIdx) : envStr;
          const val = eqIdx >= 0 ? envStr.substring(eqIdx + 1) : "";
          return { label: key, value: val };
        }),
      });
    }

    const labelEntries = Object.entries(info.config.labels);
    if (labelEntries.length > 0) {
      entries.push({
        label: "Labels",
        icon: "tag",
        children: labelEntries.map(([key, val]) => ({
          label: key,
          value: val,
        })),
      });
    }

    return entries.map((entry) =>
      entry.children
        ? new DetailCategoryItem(entry)
        : new DetailValueItem(entry),
    );
  }

  /** Register the details view. */
  static register(context: vscode.ExtensionContext): DetailsViewProvider {
    const provider = new DetailsViewProvider();

    const treeView = vscode.window.createTreeView("artizo.detailsView", {
      treeDataProvider: provider,
      showCollapseAll: true,
    });

    context.subscriptions.push(treeView);

    return provider;
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}

/** Build port detail entries from Docker network settings. */
function buildPortEntries(
  ports: Record<string, Array<{ hostIp: string; hostPort: string }> | null>,
): DetailEntry[] {
  const entries: DetailEntry[] = [];
  for (const [containerPort, bindings] of Object.entries(ports)) {
    if (bindings && bindings.length > 0) {
      for (const binding of bindings) {
        entries.push({
          label: `${binding.hostPort} → ${containerPort}`,
          value: binding.hostIp || "0.0.0.0",
          icon: "plug",
        });
      }
    } else {
      entries.push({
        label: containerPort,
        value: "not bound",
        icon: "circle-outline",
      });
    }
  }
  return entries;
}