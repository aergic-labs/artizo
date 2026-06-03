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
import { getLogger } from "../utils/logger";
import type { WebviewMessage, HostMessage, MountEntry } from "./messages";
import { computeCommands } from "./commandRegistry";
import { ContainerService } from "./containerService";
import { VolumeService } from "./volumeService";
import {
  extractToggles,
  computeRunArgsToggle,
  computeMountsToggle,
} from "./configToggles";
import { extractSoftware } from "./configToggles";

export class SidebarProvider
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  private _view?: vscode.WebviewView;
  private _pendingMessages: HostMessage[] = [];
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

    this.loadConfig();
    this.refreshContainers();
    this.refreshVolumes();
    this.refreshCommands();
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

  /** Load config from the current workspace, open it in editor, and send to webview. */
  async loadConfig(): Promise<void> {
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

    let raw: Record<string, unknown> = {};
    try {
      const { parse } = await import("jsonc-parser");
      raw = parse(doc.getText()) as Record<string, unknown>;
      getLogger().info(
        `loadConfig: parsed runArgs=${JSON.stringify(raw.runArgs || [])}`,
      );
    } catch {
      getLogger().error("loadConfig: JSON.parse failed");
      return;
    }

    const toggles = extractToggles(raw);
    getLogger().info(
      `loadConfig: sending mountHome=${toggles.mountHome} sshAgent=${toggles.sshAgent}`,
    );
    this.postMessage({
      type: "configLoaded",
      path: configPath,
      toggles,
      software: extractSoftware(raw),
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
      return await vscode.workspace.openTextDocument(configPath);
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
    });
    this.sendInstalledExtensions(raw);
    this.refreshCommands();
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

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <title>Artizo</title>
</head>
<body>
  <div id="root">
    <div class="panel active" id="panel-config">
      <div id="status-bar"></div>
      <div class="section">
        <h3>Commands</h3>
        <div id="command-list"></div>
      </div>
      <div class="section">
        <div class="accordion-header">
          <span class="chevron"></span>
          <h3>Containers</h3>
          <button class="refresh-btn" data-section="containers">&#x21bb;</button>
        </div>
        <div class="accordion-body">
          <div id="container-list"></div>
          <p id="container-empty" class="empty-state hidden">No dev containers found.</p>
        </div>
      </div>
      <div class="section">
        <div class="accordion-header">
          <span class="chevron"></span>
          <h3>Volumes</h3>
          <button class="refresh-btn" data-section="volumes">&#x21bb;</button>
        </div>
        <div class="accordion-body">
          <div id="volume-list"></div>
          <p id="volume-empty" class="empty-state hidden">No managed volumes found.</p>
        </div>
      </div>
      <div id="config-section" class="section hidden">
        <div class="accordion-header" data-section="config">
          <span class="chevron"></span>
          <h3>devcontainer.json</h3>
        </div>
        <div class="accordion-body">
          <p class="empty-state">
            <button id="open-config-btn" class="btn">Open File</button>
          </p>
          <div class="section">
            <div class="list-row command-parent" onclick="this.nextElementSibling.classList.toggle('hidden');this.querySelector('.chevron-btn').textContent=this.nextElementSibling.classList.contains('hidden')?'▶':'▼'">
              <span>Options</span>
              <button class="btn small chevron-btn">▶</button>
            </div>
            <div class="command-children hidden">
              <div id="toggle-list"></div>
            </div>
          </div>
          <div class="section">
            <div class="list-row command-parent" onclick="this.nextElementSibling.classList.toggle('hidden');this.querySelector('.chevron-btn').textContent=this.nextElementSibling.classList.contains('hidden')?'▶':'▼'">
              <span>Software</span>
              <button class="btn small chevron-btn">▶</button>
            </div>
            <div class="command-children hidden">
              <div id="software-list"></div>
              <div class="freeform-row">
                <input type="text" id="software-input" placeholder="ghcr.io/devcontainers/features/terraform:1">
                <button id="add-software-btn" class="btn small">Add</button>
              </div>
              <small><a href="https://containers.dev/features" target="_blank">Browse catalog</a></small>
            </div>
          </div>
          <div class="section">
            <div class="list-row command-parent" onclick="this.nextElementSibling.classList.toggle('hidden');this.querySelector('.chevron-btn').textContent=this.nextElementSibling.classList.contains('hidden')?'▶':'▼'">
              <span>Ports</span>
              <button class="btn small chevron-btn">▶</button>
            </div>
            <div class="command-children hidden">
              <div id="port-list"></div>
              <div class="add-row">
                <input type="number" id="port-input" placeholder="Port" min="1" max="65535">
                <input type="text" id="port-label-input" placeholder="Label">
                <button id="add-port-btn" class="btn">Add</button>
              </div>
            </div>
          </div>
          <div class="section">
            <div class="list-row command-parent" onclick="this.nextElementSibling.classList.toggle('hidden');this.querySelector('.chevron-btn').textContent=this.nextElementSibling.classList.contains('hidden')?'▶':'▼'">
              <span>VS Code Extensions</span>
              <button class="btn small chevron-btn">▶</button>
            </div>
            <div class="command-children hidden">
              <input type="text" id="extension-filter" placeholder="Filter or type a publisher.extension to add">
              <div id="extension-checklist"></div>
              <div id="extension-list"></div>
            </div>
          </div>
        </div>
      </div>
      <div id="empty-config" class="section hidden">
        <div class="accordion-header" data-section="wizard">
          <span class="chevron"></span>
          <h3>New devcontainer.json</h3>
        </div>
        <div class="accordion-body">
          <p id="empty-config-msg" class="empty-state">No devcontainer.json found in this workspace. Create one below:</p>
          <div id="wizard-section">
            <div class="section">
              <h4>Common Images</h4>
              <div id="wizard-images"></div>
            </div>
            <div class="section">
              <h4>Custom Image</h4>
              <div class="add-row">
                <input type="text" id="wizard-image-input" placeholder="e.g. alpine, ubuntu:22.04">
                <button id="wizard-generate-btn" class="btn primary">Generate</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
  <script src="${appUri}"></script>
</body>
</html>`;
  }
}