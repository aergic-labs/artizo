/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Sidebar webview provider for the Artizo sidebar.
 *
 * Provides a WebviewView that hosts the config editor, container list,
 * volume manager, and log panels. Communicates with the webview
 * via a typed postMessage protocol defined in messages.ts.
 */

import * as vscode from "vscode";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getLogger } from "../utils/logger";
import type {
  WebviewMessage,
  HostMessage,
  MountEntry,
  ConfigParseError,
} from "./messages";
import { computeCommands } from "./commandRegistry";
import { ContainerService } from "./containerService";
import { VolumeService } from "./volumeService";
import {
  extractToggles,
  computeRunArgsToggle,
  computeMountsToggle,
} from "./configToggles";
import { extractSoftware } from "./configToggles";
import { getAiAssist, type AiAssist } from "../ai";

declare const HAS_KIRO_ADAPTER: boolean;

export class SidebarProvider
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  private _view?: vscode.WebviewView;
  private _pendingMessages: HostMessage[] = [];
  private _disposables: vscode.Disposable[] = [];
  private readonly containerService: ContainerService;
  private readonly volumeService: VolumeService;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly configManager: {
      getConfigPath(wsPath: string): string | null;
    },
    dockerPath: string,
  ) {
    this.containerService = new ContainerService(dockerPath);
    this.volumeService = new VolumeService(dockerPath);
    vscode.workspace.registerTextDocumentContentProvider("artizo-inspect", {
      provideTextDocumentContent(uri: vscode.Uri): string {
        return Buffer.from(uri.query, "base64").toString("utf-8");
      },
    });
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, "src", "webview"),
        vscode.Uri.joinPath(this.extensionUri, "resources"),
      ],
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((message: WebviewMessage) =>
      this.handleMessage(message),
    );

    // Flush any messages queued before the webview was ready
    for (const msg of this._pendingMessages) {
      this._view.webview.postMessage(msg);
    }
    this._pendingMessages = [];

    this.loadConfig(true);
    this.refreshContainers();
    this.refreshVolumes();
    this.refreshCommands();

    // Reload config whenever devcontainer.json is saved to disk.
    // Catches manual user edits, AI writes, and git changes — not just
    // the explicit loadConfig() calls after our own edits.
    this._disposables.push(
      vscode.workspace.onDidSaveTextDocument((doc) => {
        const wsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
        const configPath = this.configManager.getConfigPath(wsPath);
        if (configPath && doc.uri.fsPath === configPath) {
          this.loadConfig(true);
        }
      }),
    );
  }

  /** Push a message to the webview. */
  postMessage(message: HostMessage): void {
    if (this._view) {
      this._view.webview.postMessage(message);
    } else {
      this._pendingMessages.push(message);
    }
  }

  /** Check if a devcontainer.json exists for the current workspace. */
  hasConfig(): boolean {
    return !!this.getConfigPath();
  }

  dispose(): void {
    this._pendingMessages = [];
    this._view = undefined;
    for (const d of this._disposables) d.dispose();
    this._disposables = [];
  }

  // ── Public refresh (called by commands.ts) ──────────────────

  /** Compute contextually available commands and send to webview. */
  refreshCommands(): void {
    const commands = computeCommands(
      vscode.env.remoteName,
      !!vscode.workspace.workspaceFolders?.[0],
      !!this.getConfigPath(),
    );
    this.postMessage({ type: "updateCommands", commands });
  }

  /** Expand a sidebar section and optionally refresh its data. */
  expandSection(section: string): void {
    getLogger().info(`expandSection: ${section}`);
    this.postMessage({ type: "expandSection", section });
    if (section === "containers") {
      this.refreshContainers();
    } else if (section === "volumes") {
      this.refreshVolumes();
    }
  }

  async refreshContainers(): Promise<void> {
    try {
      const containers = await this.containerService.refreshContainers();
      this.postMessage({ type: "updateContainers", containers });
    } catch (err: unknown) {
      console.error("refreshContainers failed:", err);
      this.postMessage({ type: "updateContainers", containers: [] });
    }
  }

  async refreshVolumes(): Promise<void> {
    try {
      const volumes = await this.volumeService.refreshVolumes();
      this.postMessage({ type: "updateVolumes", volumes });
    } catch {
      this.postMessage({ type: "updateVolumes", volumes: [] });
    }
  }

  /** Load config from the current workspace, open it in editor, and send to webview.
   * @param checkErrors If true, parse errors are sent to the webview banner.
   *                     Only pass true for initial load, explicit opens, and saves. */
  async loadConfig(checkErrors = false): Promise<void> {
    if (vscode.env.remoteName) {
      this.postMessage({ type: "configMissing", remote: true });
      return;
    }
    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    if (!wsFolder) {
      this.postMessage({ type: "configMissing", noWorkspace: true });
      return;
    }

    const configPath = this.configManager.getConfigPath(wsFolder.uri.fsPath);
    if (!configPath) {
      this.postMessage({ type: "configMissing" });
      return;
    }

    // Read from editor buffer (includes unsaved changes)
    const doc = await this.getEditorDoc();
    if (!doc) {
      return;
    }

    // Show editor if not already visible
    if (!vscode.window.visibleTextEditors.some((e) => e.document === doc)) {
      await vscode.window.showTextDocument(doc, {
        viewColumn: vscode.ViewColumn.One,
        preview: false,
      });
    }

    const content = doc.getText();
    const { parse } = await import("jsonc-parser");
    const errors: import("jsonc-parser").ParseError[] = [];
    const raw = parse(content, errors, {
      allowTrailingComma: true,
    }) as Record<string, unknown> | undefined;

    if (!raw) {
      getLogger().error("loadConfig: unparseable JSONC");
      return;
    }

    let parseErrors: ConfigParseError[] | undefined;
    if (checkErrors) {
      parseErrors = [];
      if (errors.length > 0) {
        parseErrors = errors.map((err) => {
          const { line, column } = this.getLineColumn(content, err.offset);
          return {
            message: this.friendlyError(err.error),
            offset: err.offset,
            length: err.length,
            line,
            column,
          };
        });
        getLogger().warn(
          `loadConfig: ${errors.length} parse error(s) in devcontainer.json`,
        );
      }
    }

    getLogger().info(
      `loadConfig: parsed runArgs=${JSON.stringify(raw.runArgs || [])}`,
    );

    const toggles = extractToggles(raw);
    getLogger().info(
      `loadConfig: sending mountHome=${toggles.mountHome} sshAgent=${toggles.sshAgent}`,
    );
    this.postMessage({
      type: "configLoaded",
      path: configPath,
      toggles,
      software: extractSoftware(raw),
      errors: parseErrors,
      aiAvailable: await this.isAiAvailable(),
    });
    this.sendInstalledExtensions(raw);
    this.refreshCommands();
  }

  /** Send the list of locally installed extensions with enabled state. */
  private sendInstalledExtensions(raw: Record<string, unknown>): void {
    const configExts: string[] =
      ((
        (raw.customizations as Record<string, unknown>)?.vscode as Record<
          string,
          unknown
        >
      )?.extensions as string[]) || [];

    const installed = vscode.extensions.all
      .filter(
        (e) =>
          !e.id.startsWith("vscode.") &&
          !e.extensionPath.startsWith(vscode.env.appRoot) &&
          !/^aergic\.artizo-/.test(e.id),
      )
      .map((e) => ({
        id: e.id,
        label: e.packageJSON.displayName || e.id,
        enabled: configExts.includes(e.id),
      }))
      .sort((a, b) => a.label.localeCompare(b.label));

    this.postMessage({ type: "setInstalledExtensions", extensions: installed });
  }

  // ── Message handlers ──────────────────────────────────────────

  private async handleMessage(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case "ready":
        this.loadConfig();
        this.refreshContainers();
        this.refreshVolumes();
        this.refreshCommands();
        break;
      case "toggleSoftware":
        await this.toggleSoftware(message.featureRef, message.enabled);
        break;
      case "toggleOption":
        await this.toggleOption(
          message.feature,
          message.enabled,
          message.mountPath,
        );
        break;
      case "addPort":
        await this.addPort(message.port, message.label);
        break;
      case "removePort":
        await this.removePort(message.index);
        break;
      case "addExtension":
        await this.addExtension(message.extensionId);
        break;
      case "removeExtension":
        await this.removeExtension(message.index);
        break;
      case "addMount":
        await this.addMount(message.source, message.target);
        break;
      case "removeMount":
        await this.removeMount(message.index);
        break;
      case "addRunArg":
        await this.addRunArg(message.arg);
        break;
      case "removeRunArg":
        await this.removeRunArg(message.index);
        break;
      case "setRemoteUser":
        await this.setRemoteUser(message.user);
        break;
      case "action":
        vscode.commands.executeCommand(message.command);
        break;
      case "containerAction":
        await this.handleContainerAction(
          message.action,
          message.containerId,
          message.containerName,
        );
        break;
      case "volumeAction":
        await this.handleVolumeAction(message.action, message.volumeName);
        break;
      case "refreshSection":
        if (message.section === "containers") {
          this.refreshContainers();
        } else {
          this.refreshVolumes();
        }
        break;
      case "runCommand":
        vscode.commands.executeCommand(message.command);
        break;
      case "generateConfig":
        this.generateConfig(message.image);
        break;
      case "aiGenerateConfig":
        this.aiGenerateConfig();
        break;
      case "aiUpdateConfig":
        this.aiUpdateConfig();
        break;
      case "aiFixConfig":
        this.aiFixConfig();
        break;
      case "openConfigFile":
        this.loadConfig(true);
        break;
      case "repairConfig":
        this.repairConfig();
        break;
    }
  }

  // ── AI prompt dispatch ─────────────────────────────────────

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
    this.postMessage({ type: "aiStatus", status: "generating", target });

    const ai = await getAiAssist();
    try {
      await ai.submit(prompt, { files, title });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.postMessage({
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
      this.postMessage({ type: "aiStatus", status: "submitted", target });
    }
  }

  // ── Extension picker ────────────────────────────────────────

  private async generateConfig(image: string): Promise<void> {
    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    if (!wsFolder) {
      return;
    }

    const configDir = vscode.Uri.joinPath(wsFolder.uri, ".devcontainer");
    const configFile = vscode.Uri.joinPath(configDir, "devcontainer.json");

    const config = {
      name: "Dev Container",
      image,
      forwardPorts: [] as number[],
      customizations: {
        vscode: {
          extensions: [] as string[],
        },
      },
    };

    try {
      await vscode.workspace.fs.createDirectory(configDir);
      await vscode.workspace.fs.writeFile(
        configFile,
        Buffer.from(JSON.stringify(config, null, 2), "utf-8"),
      );
      await this.loadConfig();
      this.postMessage({ type: "expandSection", section: "config" });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.postMessage({ type: "configMissing" });
      vscode.window.showErrorMessage(`Failed to create config: ${msg}`);
    }
  }

  private async aiGenerateConfig(): Promise<void> {
    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    if (!wsFolder) {
      vscode.window.showErrorMessage(
        "No workspace folder open. Open a folder first.",
      );
      return;
    }

    const files: string[] = [];
    const makefilePath = vscode.Uri.joinPath(wsFolder.uri, "Makefile");
    const configPath = this.configManager.getConfigPath(wsFolder.uri.fsPath);

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

  private async aiUpdateConfig(): Promise<void> {
    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    if (!wsFolder) {
      vscode.window.showErrorMessage("No workspace folder open.");
      return;
    }

    const configPath = this.configManager.getConfigPath(wsFolder.uri.fsPath);
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
  private async aiFixConfig(): Promise<void> {
    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    if (!wsFolder) {
      vscode.window.showErrorMessage("No workspace folder open.");
      return;
    }

    const configPath = this.configManager.getConfigPath(wsFolder.uri.fsPath);
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

  /** Repair a corrupted devcontainer.json. */
  private async repairConfig(): Promise<void> {
    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    if (!wsFolder) return;

    const configPath = this.configManager.getConfigPath(wsFolder.uri.fsPath);
    if (!configPath) return;

    // Save backup: devcontainer.json.bak1, .bak2, ...
    let bakPath: string;
    let n = 1;
    do {
      bakPath = configPath + ".bak" + n;
      n++;
    } while (fs.existsSync(bakPath));

    const { repairDevcontainerJson } = await import("./jsonRepair.js");

    // Read from editor buffer if available (preserves unsaved fixes),
    // fall back to disk content
    const doc = await this.getEditorDoc();
    const content = doc ? doc.getText() : fs.readFileSync(configPath, "utf-8");

    // Always save backup before attempting repair
    fs.writeFileSync(bakPath, content, "utf-8");
    getLogger().info(`repairConfig: saved backup to ${path.basename(bakPath)}`);

    try {
      const repaired = repairDevcontainerJson(content);

      // Write repaired content via editor or direct file write
      if (doc) {
        const fullRange = new vscode.Range(
          doc.positionAt(0),
          doc.positionAt(content.length),
        );
        const wsEdit = new vscode.WorkspaceEdit();
        wsEdit.replace(doc.uri, fullRange, repaired);
        await vscode.workspace.applyEdit(wsEdit);
        await doc.save();

        // Trigger built-in JSON formatting
        try {
          await vscode.commands.executeCommand("editor.action.formatDocument");
          await doc.save();
        } catch {
          // Format not available — repaired content is still valid
        }
      } else {
        fs.writeFileSync(configPath, repaired, "utf-8");
      }

      vscode.window.showInformationMessage(
        `devcontainer.json repaired. Backup saved to ${path.basename(bakPath)}.`,
      );
      this.loadConfig(true);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window
        .showErrorMessage(
          `Could not auto-repair. Original saved to ${path.basename(bakPath)}. ${msg}`,
          "Open Backup",
        )
        .then((choice) => {
          if (choice === "Open Backup") {
            vscode.window.showTextDocument(vscode.Uri.file(bakPath));
          }
        });
    }
  }

  private async watchAiProgress(target: string, ai: AiAssist): Promise<void> {
    const maxPolls = 120; // 2 minutes at 1s intervals
    for (let i = 0; i < maxPolls; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));

      try {
        const pending = (await ai.pollPendingQuestions?.()) ?? 0;
        if (pending > 0) {
          this.postMessage({
            type: "aiStatus",
            target,
            status: "questions",
            message: `${pending} question${pending > 1 ? "s" : ""} pending — check the AI chat panel.`,
          });
          return; // Stop polling; user needs to interact
        }
      } catch {
        // Command may not be available yet, keep polling
      }

      // Check if config was created/modified
      const wsFolder = vscode.workspace.workspaceFolders?.[0];
      if (wsFolder) {
        const configPath = this.configManager.getConfigPath(
          wsFolder.uri.fsPath,
        );
        if (configPath) {
          try {
            await vscode.workspace.fs.stat(vscode.Uri.file(configPath));
            this.postMessage({ type: "aiStatus", target, status: "done" });
            await this.loadConfig();
            this.postMessage({ type: "expandSection", section: "config" });
            // Switch to manual tab so user sees the updated fields
            if (target === "config") {
              this.postMessage({ type: "switchTab", tab: "config-manual" });
            }
            return;
          } catch {
            // Config doesn't exist yet
          }
        }
      }
    }

    // Timed out
    this.postMessage({
      type: "aiStatus",
      target,
      status: "timeout",
      message: "Still waiting. Check the AI chat panel.",
    });
  }

  // ── Container actions ────────────────────────────────────────

  private async handleContainerAction(
    action:
      | "start"
      | "stop"
      | "remove"
      | "connectCurrentWindow"
      | "connectNewWindow"
      | "showLog"
      | "inspect",
    containerId: string,
    containerName?: string,
  ): Promise<void> {
    await this.containerService.handleContainerAction(
      action,
      containerId,
      containerName,
    );
    if (action === "start" || action === "stop" || action === "remove") {
      this.refreshContainers();
    }
  }

  // ── Volume actions ───────────────────────────────────────────

  private async handleVolumeAction(
    action: "inspect" | "remove",
    volumeName: string,
  ): Promise<void> {
    await this.volumeService.handleVolumeAction(action, volumeName);
    if (action === "remove") {
      this.refreshVolumes();
    }
  }

  // ── Config file helpers ──────────────────────────────────────

  private getConfigPath(): string | undefined {
    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    if (!wsFolder) {
      return undefined;
    }
    return this.configManager.getConfigPath(wsFolder.uri.fsPath) ?? undefined;
  }

  /** Get the editor document for devcontainer.json, opening if needed. */
  private async getEditorDoc(): Promise<vscode.TextDocument | undefined> {
    const configPath = this.getConfigPath();
    if (!configPath) {
      return undefined;
    }
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.fsPath === configPath && !doc.isClosed) {
        return doc;
      }
    }
    try {
      return await vscode.workspace.openTextDocument(
        vscode.Uri.file(configPath),
      );
    } catch {
      return undefined;
    }
  }

  /** Apply jsonc edits to the document buffer and save to disk. */
  private async applyAndSave(
    content: string,
    edits: ReturnType<typeof import("jsonc-parser").modify>,
  ): Promise<string> {
    const { applyEdits } = require("jsonc-parser");
    const patched = applyEdits(content, edits);

    const doc = await this.getEditorDoc();
    if (!doc) {
      // Fallback: write directly if no document available
      const configPath = this.getConfigPath();
      if (configPath) {
        fs.writeFileSync(configPath, patched, "utf-8");
      }
      return patched;
    }

    const fullRange = new vscode.Range(
      doc.positionAt(0),
      doc.positionAt(doc.getText().length),
    );
    const wsEdit = new vscode.WorkspaceEdit();
    wsEdit.replace(doc.uri, fullRange, patched);

    await vscode.workspace.applyEdit(wsEdit);
    await doc.save();

    return patched;
  }

  private async patchConfig(jsonPath: string[], value: unknown): Promise<void> {
    const { modify } = await import("jsonc-parser");
    const doc = await this.getEditorDoc();
    if (!doc) {
      return;
    }
    const content = doc.getText();

    const edits = modify(content, jsonPath, value, {
      formattingOptions: { eol: "\n", insertSpaces: true, tabSize: 2 },
    });
    const patched = await this.applyAndSave(content, edits);
    getLogger().info(`Patched devcontainer.json: ${jsonPath.join(".")}`);
    this.reloadFromContent(patched);
  }

  private async getConfigValue<T>(jsonPath: string[]): Promise<T | undefined> {
    const doc = await this.getEditorDoc();
    if (!doc) {
      return undefined;
    }
    const { parse } = await import("jsonc-parser");
    const content = doc.getText();
    const parsed = parse(content) as Record<string, unknown>;

    let current: unknown = parsed;
    for (const key of jsonPath) {
      if (
        current &&
        typeof current === "object" &&
        key in (current as Record<string, unknown>)
      ) {
        current = (current as Record<string, unknown>)[key];
      } else {
        return undefined;
      }
    }
    return current as T;
  }

  /** Parse JSONC string and send toggles to webview without touching the editor. */
  private async reloadFromContent(content: string): Promise<void> {
    const { parse } = await import("jsonc-parser");
    const raw = parse(content) as Record<string, unknown>;
    const toggles = extractToggles(raw);
    const configPath = this.getConfigPath() || "";
    getLogger().info(
      `loadConfig: sending mountHome=${toggles.mountHome} sshAgent=${toggles.sshAgent}`,
    );
    this.postMessage({
      type: "configLoaded",
      path: configPath,
      toggles,
      software: extractSoftware(raw),
      aiAvailable: await this.isAiAvailable(),
    });
    this.sendInstalledExtensions(raw);
    this.refreshCommands();
  }

  /** Whether AI assist can be offered in the current runtime. */
  private async isAiAvailable(): Promise<boolean> {
    return (await getAiAssist()).isAvailable();
  }

  private async toggleSoftware(
    featureRef: string,
    enabled: boolean,
  ): Promise<void> {
    const doc = await this.getEditorDoc();
    if (!doc) return;
    const { parse, modify } = await import("jsonc-parser");
    const content = doc.getText();
    const parsed = parse(content) as Record<string, unknown>;
    const features = (parsed.features || {}) as Record<string, unknown>;
    const updated = { ...features };
    if (enabled) {
      updated[featureRef] = {};
    } else {
      delete updated[featureRef];
    }
    const edits = modify(content, ["features"], updated, {
      formattingOptions: { eol: "\n", insertSpaces: true, tabSize: 2 },
    });
    const patched = await this.applyAndSave(content, edits);
    await this.reloadFromContent(patched);
  }

  private async toggleOption(
    feature: string,
    enabled: boolean,
    mountPath?: string,
  ): Promise<void> {
    // Compute host home path for mountHome feature
    let homePath = os.homedir();
    const isWin = os.platform() === "win32";
    if (isWin) {
      homePath = homePath.replace(/\\/g, "/");
      homePath = homePath.replace(/,/g, "\\,");
      homePath = homePath.replace(/ /g, "\\ ");
    } else {
      homePath = homePath.replace(/,/g, "\\,");
    }

    getLogger().info(
      `toggleOption: feature=${feature} enabled=${enabled} mountPath=${mountPath} homePath=${homePath}`,
    );

    const paths: Record<string, { path: string[]; managed: string }> = {
      gpu: { path: ["runArgs", "--gpus", "all"], managed: "gpu" },
      waylandSocket: {
        path: [
          "mounts",
          "source=${localEnv:WAYLAND_DISPLAY}",
          "target=/tmp/.X11-unix",
        ],
        managed: "waylandSocket",
      },
      mountHome: {
        path: [
          "mounts",
          `source=${homePath}`,
          "target=/host-home",
          "type=bind",
        ],
        managed: "home",
      },
      privileged: { path: ["runArgs", "--privileged"], managed: "privileged" },
      sshAgent: {
        path: [
          "mounts",
          "source=${localEnv:SSH_AUTH_SOCK}",
          "target=/tmp/ssh-auth-sock",
        ],
        managed: "sshAgent",
      },
      copyGitConfig: {
        path: ["disableCopyGitConfig"],
        managed: "copyGitConfig",
      },
    };

    const entry = paths[feature];
    if (!entry || entry.path.length === 0) {
      return;
    }
    const patchPath = [...entry.path];

    // Override target path for mountHome if user specified one
    if (feature === "mountHome" && mountPath) {
      patchPath[2] = `target=${mountPath}`;
    }

    const doc = await this.getEditorDoc();
    if (!doc) {
      return;
    }

    const { parse, modify } = await import("jsonc-parser");
    const content = doc.getText();
    const parsed = parse(content) as Record<string, unknown>;

    if (patchPath[0] === "runArgs") {
      const runArgs = (parsed.runArgs as string[]) || [];
      getLogger().info(
        `toggleOption: current runArgs=${JSON.stringify(runArgs)} patchPath1=${patchPath[1]} patchPath2=${patchPath[2]}`,
      );
      const updated = computeRunArgsToggle(runArgs, patchPath, enabled);
      getLogger().info(
        `toggleOption: updated runArgs=${JSON.stringify(updated)}`,
      );
      const edits = modify(content, ["runArgs"], updated, {
        formattingOptions: { eol: "\n", insertSpaces: true, tabSize: 2 },
      });
      const patched = await this.applyAndSave(content, edits);
      await this.reloadFromContent(patched);
      return;
    } else if (patchPath[0] === "mounts") {
      const mounts = (parsed.mounts || []) as Array<{
        source: string;
        target: string;
        type?: string;
      }>;
      getLogger().info(
        `toggleOption: current mounts=${JSON.stringify(mounts)}`,
      );
      const updated = computeMountsToggle(
        mounts as any,
        patchPath,
        enabled,
        entry.managed,
      );
      getLogger().info(
        `toggleOption: updated mounts=${JSON.stringify(updated)}`,
      );
      const edits = modify(content, ["mounts"], updated, {
        formattingOptions: { eol: "\n", insertSpaces: true, tabSize: 2 },
      });
      const patched = await this.applyAndSave(content, edits);
      getLogger().info(
        `toggleOption: updated mounts=${JSON.stringify(updated)}`,
      );
      await this.reloadFromContent(patched);
      return;
    }

    // Boolean flag (disableCopyGitConfig)
    if (patchPath[0] === "disableCopyGitConfig") {
      const edits = modify(
        content,
        ["disableCopyGitConfig"],
        enabled ? undefined : true,
        {
          formattingOptions: { eol: "\n", insertSpaces: true, tabSize: 2 },
        },
      );
      const patched = await this.applyAndSave(content, edits);
      await this.reloadFromContent(patched);
      return;
    }

    this.loadConfig();
  }

  private async addPort(port: number, label: string): Promise<void> {
    const ports =
      (await this.getConfigValue<unknown[]>("forwardPorts".split("."))) || [];
    await this.patchConfig(
      ["forwardPorts"],
      [...ports, label ? { port, label } : port],
    );
  }

  private async removePort(index: number): Promise<void> {
    const ports =
      (await this.getConfigValue<unknown[]>("forwardPorts".split("."))) || [];
    await this.patchConfig(
      ["forwardPorts"],
      ports.filter((_, i) => i !== index),
    );
  }

  private async addExtension(extensionId: string): Promise<void> {
    const exts =
      (await this.getConfigValue<string[]>([
        "customizations",
        "vscode",
        "extensions",
      ])) || [];
    if (!exts.includes(extensionId)) {
      await this.patchConfig(
        ["customizations", "vscode", "extensions"],
        [...exts, extensionId],
      );
    }
  }

  private async removeExtension(index: number): Promise<void> {
    const exts =
      (await this.getConfigValue<string[]>([
        "customizations",
        "vscode",
        "extensions",
      ])) || [];
    await this.patchConfig(
      ["customizations", "vscode", "extensions"],
      exts.filter((_, i) => i !== index),
    );
  }

  private async addMount(source: string, target: string): Promise<void> {
    const mounts =
      (await this.getConfigValue<MountEntry[]>("mounts".split("."))) || [];
    if (!mounts.some((m) => m.source === source && m.target === target)) {
      await this.patchConfig(["mounts"], [...mounts, { source, target }]);
    }
  }

  private async removeMount(index: number): Promise<void> {
    const mounts =
      (await this.getConfigValue<MountEntry[]>("mounts".split("."))) || [];
    await this.patchConfig(
      ["mounts"],
      mounts.filter((_, i) => i !== index),
    );
  }

  private async addRunArg(arg: string): Promise<void> {
    const args =
      (await this.getConfigValue<string[]>("runArgs".split("."))) || [];
    if (!args.includes(arg)) {
      await this.patchConfig(["runArgs"], [...args, arg]);
    }
  }

  private async removeRunArg(index: number): Promise<void> {
    const args =
      (await this.getConfigValue<string[]>("runArgs".split("."))) || [];
    await this.patchConfig(
      ["runArgs"],
      args.filter((_, i) => i !== index),
    );
  }

  private async setRemoteUser(user: string): Promise<void> {
    await this.patchConfig(["remoteUser"], user || undefined);
  }

  // ── HTML ─────────────────────────────────────────────────────

  private getHtml(webview: vscode.Webview): string {
    const appUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "src", "webview", "app.js"),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "src", "webview", "styles.css"),
    );

    const htmlPath = vscode.Uri.joinPath(
      this.extensionUri,
      "src",
      "webview",
      "index.html",
    );
    let html = fs.readFileSync(htmlPath.fsPath, "utf-8");

    // Substitute URIs
    html = html.replace("${SCRIPT_URI}", appUri.toString());
    html = html.replace("${STYLE_URI}", styleUri.toString());

    // Remove the AI-assist markers, keeping their content. AI availability is
    // gated at runtime via aiAvailable (ai.isAvailable()), not at build time.
    html = html.replace(/\$\{AI_ASSIST:(start|end)\}\n?/g, "");

    // Platform-specific UI adjustments (AI-native tab layout)
    if (HAS_KIRO_ADAPTER) {
      html = html.replace(
        '<div id="wizard-section">',
        '<div id="wizard-section" class="hidden">',
      );
      html = html.replace(
        '<div id="config-manual-content">',
        '<div id="config-manual-content" class="hidden">',
      );
      html = html.replace(
        '<div id="config-no-ai">',
        '<div id="config-no-ai" class="hidden">',
      );
    }

    return html;
  }

  /** Compute line and column from an offset in a string. */
  private getLineColumn(
    text: string,
    offset: number,
  ): { line: number; column: number } {
    let line = 1;
    let column = 1;
    for (let i = 0; i < offset && i < text.length; i++) {
      if (text[i] === "\n") {
        line++;
        column = 1;
      } else {
        column++;
      }
    }
    return { line, column };
  }

  /** Convert a jsonc-parser error code to a human-readable message. */
  private friendlyError(code: number): string {
    const { printParseErrorCode } =
      require("jsonc-parser") as typeof import("jsonc-parser");
    return printParseErrorCode(code);
  }
}
