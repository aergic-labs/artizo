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
 *
 * Config reads and writes (devcontainer.json loading and the manual edit
 * operations) live in ConfigEditService; this class owns the webview shell,
 * container/volume glue, and AI dispatch, and delegates config edits to the
 * service.
 */

import * as vscode from "vscode";
import * as fs from "node:fs";
import { getLogger } from "../utils/logger";
import type { WebviewMessage, HostMessage } from "./messages";
import { computeCommands } from "./commandRegistry";
import { ContainerService } from "./containerService";
import { VolumeService } from "./volumeService";
import { ConfigEditService } from "./configEditService";
import { AiAssistController } from "./aiAssistController";
import { getHostWorkspaceFolder } from "../utils/uriUtils";
import type { Host } from "../host/host";
import { detectPlatformName } from "../platform/index.js";
import { getDeprecationState } from "../lifecycle/deprecation";

/**
 * Allowlist of commands the sidebar webview may invoke via action/runCommand
 * messages. The webview is enableScripts:true and its HTML is built from a
 * template; without an allowlist, any compromise of the webview content
 * could invoke arbitrary registered commands.
 */
const ALLOWED_WEBVIEW_COMMANDS = new Set<string>([
  "artizo.reopenInContainer",
  "artizo.reopenInContainerNewWindow",
  "artizo.rebuildContainer",
  "artizo.rebuildContainerNoCache",
  "artizo.rebuildAndReopenInContainer",
  "artizo.cloneInVolume",
  "artizo.createVolume",
  "artizo.attachToRunningContainer",
  "artizo.cleanUpContainers",
  "artizo.openDevContainerFile",
  "artizo.openFolderInContainer",
  "artizo.openFolderInContainerNewWindow",
  "artizo.addConfiguration",
  "artizo.configureDevContainer",
  "artizo.reopenInHost",
  "artizo.closeRemoteConnection",
  "artizo.configureServerDownload",
  "artizo.revealOutputLog",
  "workbench.action.remote.showMenu",
  "workbench.extensions.action.showExtensionsWithIds",
  "workbench.extensions.uninstallExtension",
  "workbench.action.reloadWindow",
]);

function isAllowedWebviewCommand(command: string): boolean {
  return ALLOWED_WEBVIEW_COMMANDS.has(command);
}

export class SidebarProvider
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  private _view?: vscode.WebviewView;
  private _pendingMessages: HostMessage[] = [];
  private _disposables: vscode.Disposable[] = [];
  private readonly containerService: ContainerService;
  private readonly volumeService: VolumeService;
  private readonly configEdit: ConfigEditService;
  private readonly ai: AiAssistController;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly configManager: {
      getConfigPath(wsPath: vscode.Uri): Promise<vscode.Uri | null>;
    },
    private readonly host: Host,
  ) {
    this.containerService = new ContainerService(this.host);
    this.volumeService = new VolumeService(this.host);
    this.configEdit = new ConfigEditService({
      configManager,
      host,
      post: (m) => this.postMessage(m),
      refreshCommands: () => this.refreshCommands(),
    });
    this.ai = new AiAssistController({
      post: (m) => this.postMessage(m),
      extensionUri,
      configManager,
      reloadConfig: () => this.configEdit.loadConfig(),
    });
    this._disposables.push(
      vscode.workspace.registerTextDocumentContentProvider("artizo-inspect", {
        provideTextDocumentContent(uri: vscode.Uri): string {
          return Buffer.from(uri.query, "base64").toString("utf-8");
        },
      }),
    );
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, "resources", "sidebar"),
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

    // Per-view disposables: resolveWebviewView can fire multiple times (view
    // closed/reopened/moved). Pushing into the shared `_disposables` would
    // accumulate N handlers that re-fire loadConfig per save. Track per-view
    // and dispose them when this view goes away.
    const viewDisposables: vscode.Disposable[] = [];

    // Lazy load: data is fetched when the webview becomes visible.
    // The ready message fires when JS loads (even if hidden), gated on
    // visibility there. If hidden at ready, onDidChangeVisibility picks up.
    viewDisposables.push(
      webviewView.onDidChangeVisibility(() => {
        if (this._view?.visible) {
          this.loadData();
        }
      }),
    );


    // Reload config whenever devcontainer.json is saved to disk.
    // Catches manual user edits, AI writes, and git changes - not just
    // the explicit loadConfig() calls after our own edits.
    viewDisposables.push(
      vscode.workspace.onDidSaveTextDocument(async (doc) => {
        const wsPath = getHostWorkspaceFolder() ?? "";
        const configPath = await this.configManager.getConfigPath(
          vscode.Uri.file(wsPath),
        );
        if (configPath && doc.uri.fsPath === configPath.fsPath) {
          this.configEdit.loadConfig(true);
        }
      }),
    );

    webviewView.onDidDispose(() => {
      for (const d of viewDisposables) d.dispose();
    });
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
  async hasConfig(): Promise<boolean> {
    return !!(await this.configEdit.getConfigPath());
  }

  /**
   * Reload devcontainer.json and push its state to the webview.
   *
   * Thin delegator to ConfigEditService kept on the provider because external
   * callers (commands.ts, services.ts) drive reloads through the provider.
   */
  loadConfig(checkErrors = false): Promise<void> {
    return this.configEdit.loadConfig(checkErrors);
  }

  /** Load config, containers, volumes, and commands. Called on first visibility. */
  private loadData(): void {
    this.configEdit.loadConfig();
    this.refreshContainers();
    this.refreshVolumes();
    void this.refreshCommands();
  }

  dispose(): void {
    this._pendingMessages = [];
    this._view = undefined;
    for (const d of this._disposables) d.dispose();
    this._disposables = [];
  }

  // Public refresh (called by commands.ts)
  /** Compute contextually available commands and send to webview. */
  async refreshCommands(): Promise<void> {
    const commands = computeCommands(
      !!vscode.workspace.workspaceFolders?.[0],
      !!(await this.configEdit.getConfigPath()),
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
    getLogger().info("refreshContainers: called");
    try {
      const containers = await this.containerService.refreshContainers();
      getLogger().info(
        `refreshContainers: found ${containers.length} containers`,
      );
      this.postMessage({ type: "updateContainers", containers });
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      getLogger().error(`refreshContainers failed: ${error.message}`);
      this.postMessage({ type: "updateContainers", containers: [] });
    }
  }

  async refreshVolumes(): Promise<void> {
    try {
      const volumes = await this.volumeService.refreshVolumes();
      this.postMessage({ type: "updateVolumes", volumes });
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      getLogger().error(`refreshVolumes failed: ${error.message}`);
      this.postMessage({ type: "updateVolumes", volumes: [] });
    }
  }

  // Message handlers
  //
  // Typed dispatch table: each entry receives its narrowed message variant.
  // Partial<> mirrors the old switch's no-default behavior - message types
  // without an entry are ignored.
  private readonly messageHandlers: Partial<{
    [K in WebviewMessage["type"]]: (
      message: Extract<WebviewMessage, { type: K }>,
    ) => void | Promise<void>;
  }> = {
    ready: () => {
      if (this._view?.visible) {
        this.loadData();
      }
    },
    toggleSoftware: (m) =>
      this.configEdit.toggleSoftware(m.featureRef, m.enabled),
    toggleOption: (m) =>
      this.configEdit.toggleOption(m.feature, m.enabled, m.mountPath),
    addPort: (m) => this.configEdit.addPort(m.port, m.label),
    removePort: (m) => this.configEdit.removePort(m.index),
    addExtension: (m) => this.configEdit.addExtension(m.extensionId),
    removeExtension: (m) => this.configEdit.removeExtension(m.index),
    toggleExtension: (m) =>
      this.configEdit.toggleExtension(m.extensionId, m.enabled),
    addMount: (m) => this.configEdit.addMount(m.source, m.target),
    removeMount: (m) => this.configEdit.removeMount(m.index),
    addRunArg: (m) => this.configEdit.addRunArg(m.arg),
    removeRunArg: (m) => this.configEdit.removeRunArg(m.index),
    setRemoteUser: (m) => this.configEdit.setRemoteUser(m.user),
    action: (m) => {
      if (isAllowedWebviewCommand(m.command)) {
        vscode.commands.executeCommand(m.command);
      } else {
        getLogger().warn(`[sidebar] rejected webview command: ${m.command}`);
      }
    },
    containerAction: (m) =>
      this.handleContainerAction(m.action, m.containerId, m.containerName),
    volumeAction: (m) => this.handleVolumeAction(m.action, m.volumeName),
    cloneInVolume: () => this.handleCloneInVolume(),
    createVolume: () => this.handleCreateVolume(),
    refreshSection: (m) => {
      if (m.section === "containers") {
        this.refreshContainers();
      } else {
        this.refreshVolumes();
      }
    },
    runCommand: (m) => {
      if (isAllowedWebviewCommand(m.command)) {
        vscode.commands.executeCommand(m.command);
      } else {
        getLogger().warn(`[sidebar] rejected webview command: ${m.command}`);
      }
    },
    generateConfig: (m) => this.generateConfig(m.image),
    aiGenerateConfig: () => this.ai.aiGenerateConfig(),
    aiUpdateConfig: () => this.ai.aiUpdateConfig(),
    aiFixConfig: () => this.ai.aiFixConfig(),
    openConfigFile: () => this.configEdit.openConfigFileInEditor(),
    repairConfig: () => this.configEdit.repairConfig(),
    deprecationAction: (m) => this.handleDeprecationAction(m),
  };

  private async handleMessage(message: WebviewMessage): Promise<void> {
    const handler = this.messageHandlers[message.type] as
      | ((m: WebviewMessage) => void | Promise<void>)
      | undefined;
    await handler?.(message);
  }

  // Extension picker
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
      await this.configEdit.loadConfig();
      this.postMessage({ type: "expandSection", section: "config" });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.postMessage({ type: "configMissing" });
      vscode.window.showErrorMessage(`Failed to create config: ${msg}`);
    }
  }

  // Container actions
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

  // Volume actions
  private async handleVolumeAction(
    action: "inspect" | "remove",
    volumeName: string,
  ): Promise<void> {
    await this.volumeService.handleVolumeAction(action, volumeName);
    if (action === "remove") {
      this.refreshVolumes();
    }
  }

  // Deprecation banner action (install replacement / uninstall this build)
  private async handleDeprecationAction(
    m: Extract<WebviewMessage, { type: "deprecationAction" }>,
  ): Promise<void> {
    if (m.action === "install" && m.recommendedId) {
      await vscode.commands.executeCommand(
        "workbench.extensions.action.showExtensionsWithIds",
        [m.recommendedId],
      );
      return;
    }
    if (m.action === "uninstall" && m.selfId) {
      try {
        await vscode.commands.executeCommand(
          "workbench.extensions.uninstallExtension",
          m.selfId,
        );
        const reload = await vscode.window.showInformationMessage(
          `Artizo: uninstalled ${m.selfId}. Reload to finish.`,
          "Reload Now",
        );
        if (reload === "Reload Now") {
          await vscode.commands.executeCommand("workbench.action.reloadWindow");
        }
      } catch {
        await vscode.commands.executeCommand(
          "workbench.extensions.action.showExtensionsWithIds",
          [m.selfId],
        );
      }
    }
  }

  // Clone in Volume
  private async handleCloneInVolume(): Promise<void> {
    await vscode.commands.executeCommand("artizo.cloneInVolume");
    this.refreshVolumes();
  }

  // Create Volume
  private async handleCreateVolume(): Promise<void> {
    await vscode.commands.executeCommand("artizo.createVolume");
    this.refreshVolumes();
  }

  // HTML
  private getHtml(webview: vscode.Webview): string {
    const appUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "resources", "sidebar", "app.js"),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "resources", "sidebar", "styles.css"),
    );
    const codiconCssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "resources", "sidebar", "codicon.css"),
    );

    const htmlPath = vscode.Uri.joinPath(
      this.extensionUri,
      "resources",
      "sidebar",
      "index.html",
    );
    let html = fs.readFileSync(htmlPath.fsPath, "utf-8");

    // Substitute URIs
    html = html.replace("${SCRIPT_URI}", appUri.toString());
    html = html.replace("${STYLE_URI}", styleUri.toString());
    html = html.replace("${CODICON_CSS_URI}", codiconCssUri.toString());

    // Remove the AI-assist markers, keeping their content. AI availability is
    // gated at runtime via aiAvailable (ai.isAvailable()), not at build time.
    html = html.replace(/\$\{AI_ASSIST:(start|end)\}\n?/g, "");

    // Platform-specific UI adjustments (AI-native tab layout)
    if (detectPlatformName() === "Kiro") {
      html = html.replace(
        '<div id="config-manual-content">',
        '<div id="config-manual-content" class="hidden">',
      );
      html = html.replace(
        '<div id="config-no-ai">',
        '<div id="config-no-ai" class="hidden">',
      );
    }

    // Deprecation banner for trae/devin builds. Unremovable, always visible
    // for the deprecated build (independent of the toast dismiss flag).
    const deprecation = getDeprecationState();
    if (deprecation?.deprecated) {
      const banner = buildDeprecationBanner(deprecation);
      html = html.replace('<div id="root">', `<div id="root">${banner}`);
    }

    return html;
  }
}

/**
 * Build the unremovable deprecation banner HTML. Two variants:
 *  - replacementInstalled: "uninstall this deprecated build" button
 *  - no replacement: "install replacement" button (recommended build).
 *
 * The buttons postMessage `deprecationAction` to the host; the host then
 * runs the actual command (showExtensionsWithIds or uninstallExtension). The
 * webview itself can't run vscode.commands directly and the allowlist above
 * gates which commands the host will accept from the webview.
 */
function buildDeprecationBanner(state: {
  selfId: string;
  recommendedReplacementId: string | null;
  replacementInstalled: boolean;
}): string {
  if (state.replacementInstalled) {
    const data = encodeURIComponent(
      JSON.stringify({ action: "uninstall", selfId: state.selfId }),
    );
    return (
      `<div class="deprecation-banner" role="alert">` +
      `<div class="deprecation-banner-text">` +
      `<strong>Artizo:</strong> this deprecated ${state.selfId} build ` +
      `is no longer updated. A supported Artizo build is installed; ` +
      `uninstall this one to avoid conflicts.` +
      `</div>` +
      `<button class="deprecation-banner-btn" ` +
      `data-action="deprecationAction" data-payload="${data}">` +
      `Uninstall this deprecated build` +
      `</button>` +
      `</div>`
    );
  }
  const recommended = state.recommendedReplacementId ?? "";
  const platform = detectPlatformName();
  const recommendLabel =
    platform === "Kiro" ? "Kiro Artizo" : "VSCodium Artizo";
  const data = encodeURIComponent(
    JSON.stringify({ action: "install", recommendedId: recommended }),
  );
  return (
    `<div class="deprecation-banner" role="alert">` +
    `<div class="deprecation-banner-text">` +
    `<strong>Artizo:</strong> this deprecated build is no longer updated. ` +
    `Install ${recommendLabel} (${recommended}) to keep getting updates.` +
    `</div>` +
    `<button class="deprecation-banner-btn" ` +
    `data-action="deprecationAction" data-payload="${data}">` +
    `Install replacement` +
    `</button>` +
    `</div>`
  );
}
