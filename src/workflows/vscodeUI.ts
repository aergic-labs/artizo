/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as vscode from "vscode";
import type { WorkflowUI, ProgressReport, CancellationSignal } from "./types";
import { LogOutputTerminal } from "./logOutputTerminal";
import { getLogger } from "../utils/logger";
import {
  parseCliOutputLine,
  formatEventForTerminal,
  formatEventForChannel,
} from "../terminal/outputParser";

export class VscodeWorkflowUI implements WorkflowUI {
  private buildLogPty: LogOutputTerminal;

  constructor(buildLogPty: LogOutputTerminal) {
    this.buildLogPty = buildLogPty;
  }

  async showProgress(
    title: string,
    task: (
      report: ProgressReport,
      token?: CancellationSignal,
    ) => Promise<void>,
  ): Promise<void> {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title,
        cancellable: true,
      },
      async (progress, token) => {
        const report: ProgressReport = {
          report(value) {
            progress.report(value);
          },
        };
        await task(report, token);
      },
    );
  }

  async showError(
    message: string,
    ...actions: string[]
  ): Promise<string | undefined> {
    return vscode.window.showErrorMessage(message, ...actions);
  }

  async showInfo(
    message: string,
    ...actions: string[]
  ): Promise<string | undefined> {
    return vscode.window.showInformationMessage(message, ...actions);
  }

  async openWindow(
    uri: string,
    options?: { forceNewWindow?: boolean; forceReuseWindow?: boolean },
  ): Promise<void> {
    const parsedUri = vscode.Uri.parse(uri);
    await vscode.commands.executeCommand(
      "vscode.openFolder",
      vscode.Uri.from({
        scheme: parsedUri.scheme,
        authority: parsedUri.authority,
        path: parsedUri.path,
      }),
      options,
    );
  }

  async promptCreateConfig(): Promise<boolean> {
    const result = await vscode.window.showInformationMessage(
      "No devcontainer.json found. Would you like to create one?",
      "Create",
      "Cancel",
    );
    return result === "Create";
  }

  showBuildLog(content: string): void {
    const logger = getLogger();
    const lines = content.split("\n");
    for (const line of lines) {
      const event = parseCliOutputLine(line);
      if (event) {
        // Colored pty view (familiar docker build terminal)...
        this.buildLogPty.write(formatEventForTerminal(event));
        // ...and the authoritative record in the OutputChannel (plain).
        logger.append(formatEventForChannel(event));
      }
    }
  }

  dispose(): void {
    this.buildLogPty.dispose();
  }
}
