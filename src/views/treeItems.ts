/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/** Shared tree item definitions and icons for the container explorer views. */

import * as vscode from "vscode";
import type { FolderDescriptor } from "../remote/folderHistory";

/** Represents a target in the container explorer tree. */
export interface ContainerTarget {
  type: "recent-folder" | "running-container" | "volume";
  label: string;
  containerId?: string;
  workspacePath?: string;
  volumeName?: string;
  status: "running" | "stopped" | "building";
}

/** Tree item representing a category header (Dev Containers, Recent Folders, Volumes). */
export class CategoryTreeItem extends vscode.TreeItem {
  constructor(
    label: string,
    public readonly category: "containers" | "recent-folders" | "volumes"
  ) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = `category-${category}`;
    this.iconPath = getCategoryIcon(category);
  }
}

/** Tree item representing a running dev container. */
export class ContainerTreeItem extends vscode.TreeItem {
  constructor(public readonly target: ContainerTarget) {
    super(target.label, vscode.TreeItemCollapsibleState.None);

    this.description = target.status;
    this.tooltip = buildContainerTooltip(target);
    this.contextValue = `container-${target.status}`;
    this.iconPath = getContainerIcon(target.status);
  }
}

/** Tree item representing a recent folder. */
export class RecentFolderTreeItem extends vscode.TreeItem {
  constructor(public readonly descriptor: FolderDescriptor) {
    const name =
      descriptor.folder.split("/").filter(Boolean).pop() ??
      descriptor.folder;
    super(name, vscode.TreeItemCollapsibleState.None);

    this.description = descriptor.folder;
    this.tooltip =
      `Forget this folder from the Recent list. ` +
      `The folder on disk and the container are not affected.\n` +
      `Path: ${descriptor.folder}`;
    this.contextValue = "recent-folder";
    this.iconPath = new vscode.ThemeIcon("folder");
    // Single-click opens in the current window (matches MS Remote-SSH and
    // the zygos tree). The context menu still offers open-new + forget.
    this.command = {
      command: "artizo.explorer.connectCurrentWindow",
      title: "Open in Current Window",
      arguments: [this],
    };
  }
}

/**
 * Collapsible group of recent folders under one container authority
 * (e.g. one `artizo-container+<hex>` or `attached-container+<hex>`).
 * `remote` is the full authority string used as the history key.
 */
export class RecentFolderGroupTreeItem extends vscode.TreeItem {
  constructor(readonly remote: string, label: string) {
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = "recent-folder-group";
    this.iconPath = new vscode.ThemeIcon("history");
    this.tooltip = `Recent folders: ${label}`;
  }
}

/** Tree item representing a Docker volume. */
export class VolumeTreeItem extends vscode.TreeItem {
  constructor(public readonly target: ContainerTarget) {
    super(target.label, vscode.TreeItemCollapsibleState.None);

    this.tooltip = `Volume: ${target.volumeName ?? target.label}`;
    this.contextValue = "volume";
    this.iconPath = new vscode.ThemeIcon("database");
  }
}

function getCategoryIcon(category: "containers" | "recent-folders" | "volumes"): vscode.ThemeIcon {
  switch (category) {
    case "containers":
      return new vscode.ThemeIcon("container");
    case "recent-folders":
      return new vscode.ThemeIcon("history");
    case "volumes":
      return new vscode.ThemeIcon("database");
  }
}

function getContainerIcon(status: string): vscode.ThemeIcon {
  switch (status) {
    case "running":
      return new vscode.ThemeIcon("vm-running");
    case "stopped":
      return new vscode.ThemeIcon("vm-outline");
    case "building":
      return new vscode.ThemeIcon("loading~spin");
    default:
      return new vscode.ThemeIcon("vm-outline");
  }
}

function buildContainerTooltip(target: ContainerTarget): string {
  const lines = [`Name: ${target.label}`, `Status: ${target.status}`];
  if (target.containerId) {
    lines.push(`ID: ${target.containerId}`);
  }
  if (target.workspacePath) {
    lines.push(`Workspace: ${target.workspacePath}`);
  }
  return lines.join("\n");
}