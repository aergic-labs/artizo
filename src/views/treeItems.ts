/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/** Shared tree item definitions and icons for the container explorer views. */

import * as vscode from "vscode";

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
  constructor(public readonly target: ContainerTarget) {
    super(target.label, vscode.TreeItemCollapsibleState.None);

    this.description = target.workspacePath;
    this.tooltip = target.workspacePath ?? target.label;
    this.contextValue = "recent-folder";
    this.iconPath = new vscode.ThemeIcon("folder");
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