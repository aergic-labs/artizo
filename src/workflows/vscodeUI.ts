/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as vscode from "vscode";
import type { WorkflowUI, ProgressReport } from "./types";
import { LogOutputTerminal } from "./logOutputTerminal";
import {
  parseCliOutputLine,
  formatEventForTerminal,
} from "../terminal/outputParser";

export class VscodeWorkflowUI implements WorkflowUI {
  private buildLogPty: LogOutputTerminal;

  constructor(buildLogPty: LogOutputTerminal) {
    this.buildLogPty = buildLogPty;
  }

  async showProgress(
    title: string,
    task: (report: ProgressReport) => Promise<void>,
  ): Promise<void> {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title,
        cancellable: false,
      },
      async (progress) => {
        const report: ProgressReport = {
          report(value) {
            progress.report(value);
          },
        };
        await task(report);
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
    options?: { forceNewWindow?: boolean },
  ): Promise<void> {
    const parsedUri = vscode.Uri.parse(uri);
    // forceNewWindow is a runtime property not in the TS type definitions.
    await vscode.commands.executeCommand(
      "vscode.openFolder",
      vscode.Uri.from({
        scheme: parsedUri.scheme,
        authority: parsedUri.authority,
        path: parsedUri.path,
        forceNewWindow: options?.forceNewWindow ?? false,
      } as any),
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
    const lines = content.split("\n");
    for (const line of lines) {
      const event = parseCliOutputLine(line);
      if (event) {
        this.buildLogPty.write(formatEventForTerminal(event));
      }
    }
  }

  dispose(): void {
    this.buildLogPty.dispose();
  }
}