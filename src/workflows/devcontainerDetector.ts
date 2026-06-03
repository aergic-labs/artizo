/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as vscode from "vscode";
import type { IConfigManager } from "../config/configManager";

/**
 * Detects devcontainer.json in the workspace and prompts the user
 * to reopen in a container. Only prompts when running locally,
 * user has not dismissed with Don't Show Again, and the workspace
 * contains .devcontainer/devcontainer.json or .devcontainer.json.
 */
export class DevcontainerDetector {
  private static readonly DONT_SHOW_KEY =
    "artizo.devcontainerDetector.dontShowAgain";

  private readonly configManager: IConfigManager;

  constructor(configManager: IConfigManager) {
    this.configManager = configManager;
  }

  async checkAndPrompt(context: vscode.ExtensionContext): Promise<void> {
    if (vscode.env.remoteName) {
      return;
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceFolder) {
      return;
    }

    const dontShow = context.workspaceState.get<boolean>(
      DevcontainerDetector.DONT_SHOW_KEY,
      false,
    );
    if (dontShow) {
      return;
    }

    const configPath = this.configManager.getConfigPath(workspaceFolder);
    await vscode.commands.executeCommand(
      "setContext",
      "artizo.hasDevcontainerConfig",
      !!configPath,
    );
    if (!configPath) {
      return;
    }

    const selection = await vscode.window.showInformationMessage(
      "Folder contains a Dev Container configuration file. Reopen folder to develop in a container.",
      "Reopen in Container",
      "Don't Show Again",
    );

    if (selection === "Reopen in Container") {
      await vscode.commands.executeCommand("artizo.reopenInContainer");
    } else if (selection === "Don't Show Again") {
      await context.workspaceState.update(
        DevcontainerDetector.DONT_SHOW_KEY,
        true,
      );
    }
  }
}