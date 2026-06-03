/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Ports view panel, a TreeDataProvider that displays forwarded ports
 * in the VS Code tree view. Subscribes to the port forwarder's events
 * to auto-refresh when ports are added or removed.
 */

import * as vscode from "vscode";
import type { ForwardedPort } from "./portForwarder";

/**
 * Interface for the port forwarder as consumed by the view.
 * Extends the base IPortForwarder with event subscriptions needed for auto-refresh.
 */
export interface IPortForwarderView {
  forwardPort(
    containerPort: number,
    localPort?: number,
    label?: string,
  ): Promise<ForwardedPort>;
  unforwardPort(containerPort: number): Promise<void>;
  getForwardedPorts(): ForwardedPort[];
  onDidForwardPort(listener: (port: ForwardedPort) => void): void;
  onDidUnforwardPort(listener: (containerPort: number) => void): void;
}

/**
 * Tree item representing a single forwarded port in the Ports view.
 */
export class PortTreeItem extends vscode.TreeItem {
  constructor(public readonly port: ForwardedPort) {
    const label = port.label
      ? `${port.label} (${port.containerPort}→${port.localPort})`
      : `${port.containerPort}→${port.localPort}`;

    super(label, vscode.TreeItemCollapsibleState.None);

    this.description = `${port.protocol} · ${port.source}`;
    this.tooltip = buildTooltip(port);
    this.contextValue = "forwardedPort";
    this.iconPath = new vscode.ThemeIcon("plug");
  }
}

function buildTooltip(port: ForwardedPort): string {
  const lines = [
    `Container Port: ${port.containerPort}`,
    `Local Port: ${port.localPort}`,
    `Protocol: ${port.protocol}`,
    `Source: ${port.source}`,
  ];
  if (port.label) {
    lines.unshift(`Label: ${port.label}`);
  }
  return lines.join("\n");
}

/**
 * TreeDataProvider for the Ports view panel.
 *
 * Displays all currently forwarded ports and refreshes automatically
 * when the port forwarder emits add/remove events.
 */
export class PortViewProvider implements vscode.TreeDataProvider<ForwardedPort> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    ForwardedPort | undefined | void
  >();
  readonly onDidChangeTreeData: vscode.Event<ForwardedPort | undefined | void> =
    this._onDidChangeTreeData.event;

  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly portForwarder: IPortForwarderView) {
    // Subscribe to forwarder events for auto-refresh
    this.portForwarder.onDidForwardPort(() => this.refresh());
    this.portForwarder.onDidUnforwardPort(() => this.refresh());
  }

  /**
   * Refresh the tree view.
   */
  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: ForwardedPort): vscode.TreeItem {
    return new PortTreeItem(element);
  }

  getChildren(_element?: ForwardedPort): ForwardedPort[] {
    if (_element) {
      return [];
    }
    return this.portForwarder.getForwardedPorts();
  }

  /**
   * Register commands for add/remove/label actions and create the tree view.
   */
  static register(
    context: vscode.ExtensionContext,
    portForwarder: IPortForwarderView,
  ): PortViewProvider {
    const provider = new PortViewProvider(portForwarder);

    const treeView = vscode.window.createTreeView("artizo.portsView", {
      treeDataProvider: provider,
      showCollapseAll: false,
    });

    context.subscriptions.push(treeView);

    // Register commands for port actions
    context.subscriptions.push(
      vscode.commands.registerCommand("artizo.ports.add", () =>
        provider.addPort(),
      ),
      vscode.commands.registerCommand(
        "artizo.ports.remove",
        (port: ForwardedPort) => provider.removePort(port),
      ),
      vscode.commands.registerCommand(
        "artizo.ports.setLabel",
        (port: ForwardedPort) => provider.setLabel(port),
      ),
    );

    return provider;
  }

  /**
   * Prompt the user to add a new port forward.
   */
  async addPort(): Promise<void> {
    const input = await vscode.window.showInputBox({
      prompt: "Enter the container port to forward",
      placeHolder: "e.g. 3000",
      validateInput: (value) => {
        const num = parseInt(value, 10);
        if (isNaN(num) || num < 1 || num > 65535) {
          return "Enter a valid port number (1-65535)";
        }
        return undefined;
      },
    });

    if (!input) {
      return;
    }

    const containerPort = parseInt(input, 10);
    await this.portForwarder.forwardPort(containerPort);
  }

  /**
   * Remove a forwarded port.
   */
  async removePort(port: ForwardedPort): Promise<void> {
    await this.portForwarder.unforwardPort(port.containerPort);
  }

  /**
   * Set or update the label for a forwarded port.
   */
  async setLabel(port: ForwardedPort): Promise<void> {
    const label = await vscode.window.showInputBox({
      prompt: "Enter a label for this port",
      placeHolder: "e.g. Web Server",
      value: port.label ?? "",
    });

    if (label === undefined) {
      return; // User cancelled
    }

    // Update the label on the port object directly
    port.label = label || undefined;
    this.refresh();
  }

  /**
   * Dispose resources.
   */
  dispose(): void {
    this._onDidChangeTreeData.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}