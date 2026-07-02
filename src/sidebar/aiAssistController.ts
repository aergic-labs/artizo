/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * AI assist controller for the Artizo sidebar.
 *
 * Owns the AI-assisted devcontainer.json flows: generating a new config,
 * updating an existing one, and fixing syntax errors. Builds the prompts from
 * the bundled prompt files, dispatches them to the platform's AI assist, and
 * polls for completion or pending questions. Extracted from SidebarProvider so
 * the AI dispatch logic can be tested without the webview shell.
 *
 * This module never imports the webview. It talks to the outside world through
 * an injected `post` callback (to send HostMessages), a `configManager` for
 * resolving the config path, and a `reloadConfig` callback used when the AI
 * flow finishes writing config to disk.
 */

import * as vscode from "vscode";
import * as fs from "node:fs";
import { getAiAssist, type AiAssist } from "../ai";
import type { HostMessage } from "./messages";

export interface AiAssistControllerDeps {
  post: (msg: HostMessage) => void;
  extensionUri: vscode.Uri;
  configManager: {
    getConfigPath(wsPath: vscode.Uri): Promise<vscode.Uri | null>;
  };
  reloadConfig: () => Promise<void>;
}

export class AiAssistController {
  private readonly post: (msg: HostMessage) => void;
  private readonly extensionUri: vscode.Uri;
  private readonly configManager: AiAssistControllerDeps["configManager"];
  private readonly reloadConfig: () => Promise<void>;

  constructor(deps: AiAssistControllerDeps) {
    this.post = deps.post;
    this.extensionUri = deps.extensionUri;
    this.configManager = deps.configManager;
    this.reloadConfig = deps.reloadConfig;
  }

  // AI prompt dispatch
  /**
   * Hand a prompt to the platform's AI assist and report status to the webview.
   * When the platform supports progress tracking, polls for completion or
   * pending questions; otherwise reports that the prompt was submitted.
   *
   * Prompt-building stays at the call site; this method only dispatches.
   */
  private async dispatchAi(
    prompt: string,
    files: string[],
    title: string,
    target: string,
  ): Promise<void> {
    this.post({ type: "aiStatus", status: "generating", target });

    const ai = await getAiAssist();
    try {
      await ai.submit(prompt, { files, title });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.post({
        type: "aiStatus",
        status: "error",
        target,
        message: msg,
      });
      return;
    }

    if (ai.pollPendingQuestions) {
      this.watchAiProgress(target, ai);
    } else {
      this.post({ type: "aiStatus", status: "submitted", target });
    }
  }

  async aiGenerateConfig(): Promise<void> {
    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    if (!wsFolder) {
      vscode.window.showErrorMessage(
        "No workspace folder open. Open a folder first.",
      );
      return;
    }

    const files: string[] = [];
    const makefilePath = vscode.Uri.joinPath(wsFolder.uri, "Makefile");
    const configPath = await this.configManager.getConfigPath(wsFolder.uri);

    try {
      await vscode.workspace.fs.stat(makefilePath);
      files.push("Makefile");
    } catch {
      // Makefile doesn't exist, skip
    }

    if (configPath) {
      files.push(".devcontainer/devcontainer.json");
    }

    // Build the prompt with installed extensions context
    const installedExts = vscode.extensions.all
      .filter(
        (e) =>
          !e.id.startsWith("vscode.") &&
          !e.extensionPath.startsWith(vscode.env.appRoot) &&
          !/^aergic\.artizo-/.test(e.id),
      )
      .map((e) => e.id)
      .join(", ");

    const promptPath = vscode.Uri.joinPath(
      this.extensionUri,
      "src",
      "ai",
      "prompts",
      "devcontainer",
      "generate.md",
    );
    const basePrompt = fs.readFileSync(promptPath.fsPath, "utf-8");
    const prompt = `${basePrompt}\n\nINSTALLED EXTENSIONS: ${installedExts}\n\nWhen adding extensions to customizations.vscode.extensions, prefer ones from this list if relevant to the project. Add ones not in the list only if the project clearly needs them.`;

    await this.dispatchAi(prompt, files, "Set up Dev Container", "wizard");
  }

  async aiUpdateConfig(): Promise<void> {
    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    if (!wsFolder) {
      vscode.window.showErrorMessage("No workspace folder open.");
      return;
    }

    const configPath = await this.configManager.getConfigPath(wsFolder.uri);
    if (!configPath) {
      vscode.window.showErrorMessage("No devcontainer.json found.");
      return;
    }

    const files: string[] = [".devcontainer/devcontainer.json"];
    const makefilePath = vscode.Uri.joinPath(wsFolder.uri, "Makefile");
    try {
      await vscode.workspace.fs.stat(makefilePath);
      files.push("Makefile");
    } catch {
      // Makefile doesn't exist, skip
    }

    const promptPath = vscode.Uri.joinPath(
      this.extensionUri,
      "src",
      "ai",
      "prompts",
      "devcontainer",
      "update.md",
    );
    const prompt = fs.readFileSync(promptPath.fsPath, "utf-8");

    await this.dispatchAi(
      prompt,
      files,
      "Review Dev Container Config",
      "config",
    );
  }

  /** AI-assisted syntax error fix for a broken devcontainer.json. */
  async aiFixConfig(): Promise<void> {
    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    if (!wsFolder) {
      vscode.window.showErrorMessage("No workspace folder open.");
      return;
    }

    const configPath = await this.configManager.getConfigPath(wsFolder.uri);
    if (!configPath) {
      vscode.window.showErrorMessage("No devcontainer.json found.");
      return;
    }

    const promptPath = vscode.Uri.joinPath(
      this.extensionUri,
      "src",
      "ai",
      "prompts",
      "devcontainer",
      "fix.md",
    );
    const prompt = fs.readFileSync(promptPath.fsPath, "utf-8");

    await this.dispatchAi(
      prompt,
      [".devcontainer/devcontainer.json"],
      "Fix Dev Container Syntax",
      "config",
    );
  }

  private async watchAiProgress(target: string, ai: AiAssist): Promise<void> {
    const maxPolls = 120; // 2 minutes at 1s intervals
    for (let i = 0; i < maxPolls; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));

      try {
        const pending = (await ai.pollPendingQuestions?.()) ?? 0;
        if (pending > 0) {
          this.post({
            type: "aiStatus",
            target,
            status: "questions",
            message: `${pending} question${pending > 1 ? "s" : ""} pending - check the AI chat panel.`,
          });
          return; // Stop polling; user needs to interact
        }
      } catch {
        // Command may not be available yet, keep polling
      }

      // Check if config was created/modified
      const wsFolder = vscode.workspace.workspaceFolders?.[0];
      if (wsFolder) {
        const configPath = await this.configManager.getConfigPath(wsFolder.uri);
        if (configPath) {
          try {
            await vscode.workspace.fs.stat(configPath);
            this.post({ type: "aiStatus", target, status: "done" });
            await this.reloadConfig();
            this.post({ type: "expandSection", section: "config" });
            // Switch to manual tab so user sees the updated fields
            if (target === "config") {
              this.post({ type: "switchTab", tab: "config-manual" });
            }
            return;
          } catch {
            // Config doesn't exist yet
          }
        }
      }
    }

    // Timed out
    this.post({
      type: "aiStatus",
      target,
      status: "timeout",
      message: "Still waiting. Check the AI chat panel.",
    });
  }
}
