/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Config edit service for the Artizo sidebar.
 *
 * Owns all reads and writes of devcontainer.json: loading and parsing config,
 * applying jsonc edits to the editor buffer, and the option/port/extension/
 * mount/runArg toggle operations driven by the webview. Extracted from
 * SidebarProvider so the config-editing logic can be tested without the
 * webview shell.
 *
 * This module never imports the webview. It talks to the outside world through
 * an injected `post` callback (to send HostMessages) and a `refreshCommands`
 * callback, keeping the dependency-injection seam clean.
 */

import * as vscode from "vscode";
import * as os from "node:os";
import * as path from "node:path";
import { printParseErrorCode } from "jsonc-parser";
import { getLogger } from "../utils/logger";
import type { HostMessage, MountEntry, ConfigParseError } from "./messages";
import {
  extractToggles,
  extractSoftware,
  computeRunArgsToggle,
  computeMountsToggle,
  optionPaths,
} from "./configToggles";
import { isAiAvailable } from "./aiAvailability";
import { normalizeFsPath } from "../utils/uriUtils";
import { isInDevContainerWindow } from "../host/state";
import type { Host } from "../host/host";

export interface ConfigEditServiceDeps {
  configManager: {
    getConfigPath(wsPath: vscode.Uri): Promise<vscode.Uri | null>;
  };
  host: Host;
  post: (msg: HostMessage) => void;
  refreshCommands: () => void | Promise<void>;
}

export class ConfigEditService {
  private readonly configManager: ConfigEditServiceDeps["configManager"];
  private readonly post: (msg: HostMessage) => void;
  private readonly refreshCommands: () => void | Promise<void>;

  constructor(deps: ConfigEditServiceDeps) {
    this.configManager = deps.configManager;
    this.post = deps.post;
    this.refreshCommands = deps.refreshCommands;
  }

  /** Load config from the current workspace, open it in editor, and send to webview.
   * @param checkErrors If true, parse errors are sent to the webview banner.
   *                     Only pass true for initial load, explicit opens, and saves. */
  async loadConfig(checkErrors = false): Promise<void> {
    getLogger().info(
      `loadConfig: inDevContainer=${isInDevContainerWindow()}, hasWorkspace=${!!vscode.workspace.workspaceFolders?.[0]}`,
    );
    if (isInDevContainerWindow()) {
      this.post({
        type: "configMissing",
        managed: true,
        aiAvailable: await isAiAvailable(),
      });
      return;
    }
    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    if (!wsFolder) {
      this.post({
        type: "configMissing",
        noWorkspace: true,
        aiAvailable: await isAiAvailable(),
      });
      return;
    }

    getLogger().info(
      `loadConfig: checking configPath for wsFolder=${normalizeFsPath(wsFolder.uri)}`,
    );
    const configPath = await this.configManager.getConfigPath(wsFolder.uri);
    getLogger().info(`loadConfig: configPath=${configPath?.fsPath ?? null}`);
    if (!configPath) {
      this.post({
        type: "configMissing",
        aiAvailable: await isAiAvailable(),
      });
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
    this.post({
      type: "configLoaded",
      path: configPath.fsPath,
      toggles,
      software: extractSoftware(raw),
      errors: parseErrors,
      aiAvailable: await isAiAvailable(),
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
          !/^aergic\.(artizo|zygos)-/.test(e.id),
      )
      .map((e) => ({
        id: e.id,
        label: e.packageJSON.displayName || e.id,
        enabled: configExts.includes(e.id),
      }))
      .sort((a, b) => a.label.localeCompare(b.label));

    this.post({ type: "setInstalledExtensions", extensions: installed });
  }

  // Config file helpers
  async getConfigPath(): Promise<vscode.Uri | undefined> {
    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    if (!wsFolder) {
      return undefined;
    }
    return (await this.configManager.getConfigPath(wsFolder.uri)) ?? undefined;
  }

  /**
   * Open devcontainer.json in the editor if it's not already the active tab.
   * Triggered by the webview on config-accordion expand and on mouse-enter
   * inside the config widget area, so the raw file is visible alongside
   * the sidebar UI without the user having to click a separate command.
   */
  async openConfigFileInEditor(): Promise<void> {
    const configUri = await this.getConfigPath();
    if (!configUri) return;
    const active = vscode.window.activeTextEditor;
    if (active && active.document.uri.fsPath === configUri.fsPath) return;
    try {
      const doc = await vscode.workspace.openTextDocument(configUri);
      await vscode.window.showTextDocument(doc, {
        viewColumn: vscode.ViewColumn.One,
        preview: false,
        preserveFocus: true,
      });
    } catch {
      // ignore - file may be briefly locked or unreadable
    }
  }

  /** Get the editor document for devcontainer.json, opening if needed. */
  private async getEditorDoc(): Promise<vscode.TextDocument | undefined> {
    const configUri = await this.getConfigPath();
    if (!configUri) {
      return undefined;
    }
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.fsPath === configUri.fsPath && !doc.isClosed) {
        return doc;
      }
    }
    try {
      return await vscode.workspace.openTextDocument(configUri);
    } catch {
      return undefined;
    }
  }

  /** Apply jsonc edits to the document buffer and save to disk. */
  private async applyAndSave(
    content: string,
    edits: ReturnType<typeof import("jsonc-parser").modify>,
  ): Promise<string> {
    const { applyEdits } = await import("jsonc-parser");
    const patched = applyEdits(content, edits);

    const doc = await this.getEditorDoc();
    if (!doc) {
      // Fallback: write directly if no document available
      const configPath = await this.getConfigPath();
      if (configPath) {
        await vscode.workspace.fs.writeFile(
          configPath,
          Buffer.from(patched, "utf-8"),
        );
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
    const configUri = await this.getConfigPath();
    const configPath = configUri?.fsPath ?? "";
    getLogger().info(
      `loadConfig: sending mountHome=${toggles.mountHome} sshAgent=${toggles.sshAgent}`,
    );
    this.post({
      type: "configLoaded",
      path: configPath,
      toggles,
      software: extractSoftware(raw),
      aiAvailable: await isAiAvailable(),
    });
    this.sendInstalledExtensions(raw);
    this.refreshCommands();
  }

  async toggleSoftware(featureRef: string, enabled: boolean): Promise<void> {
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

  async toggleOption(
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

    getLogger().debug(
      `toggleOption: feature=${feature} enabled=${enabled} mountPath=${mountPath} homePath=${homePath}`,
    );

    const paths = optionPaths(homePath);

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
      getLogger().debug(
        `toggleOption: current runArgs=${JSON.stringify(runArgs)} patchPath1=${patchPath[1]} patchPath2=${patchPath[2]}`,
      );
      const updated = computeRunArgsToggle(runArgs, patchPath, enabled);
      getLogger().debug(
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
        artizoManaged?: string;
      }>;
      getLogger().debug(
        `toggleOption: current mounts=${JSON.stringify(mounts)}`,
      );
      const updated = computeMountsToggle(
        mounts,
        patchPath,
        enabled,
        entry.managed,
      );
      getLogger().debug(
        `toggleOption: updated mounts=${JSON.stringify(updated)}`,
      );
      const edits = modify(content, ["mounts"], updated, {
        formattingOptions: { eol: "\n", insertSpaces: true, tabSize: 2 },
      });
      const patched = await this.applyAndSave(content, edits);
      getLogger().debug(
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

  async addPort(port: number, label: string): Promise<void> {
    const ports =
      (await this.getConfigValue<unknown[]>("forwardPorts".split("."))) || [];
    await this.patchConfig(
      ["forwardPorts"],
      [...ports, label ? { port, label } : port],
    );
  }

  async removePort(index: number): Promise<void> {
    const ports =
      (await this.getConfigValue<unknown[]>("forwardPorts".split("."))) || [];
    await this.patchConfig(
      ["forwardPorts"],
      ports.filter((_, i) => i !== index),
    );
  }

  async addExtension(extensionId: string): Promise<void> {
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

  async removeExtension(index: number): Promise<void> {
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

  async toggleExtension(extensionId: string, enabled: boolean): Promise<void> {
    if (enabled) {
      await this.addExtension(extensionId);
    } else {
      const exts =
        (await this.getConfigValue<string[]>([
          "customizations",
          "vscode",
          "extensions",
        ])) || [];
      const index = exts.indexOf(extensionId);
      if (index >= 0) {
        await this.removeExtension(index);
      }
    }
  }

  async addMount(source: string, target: string): Promise<void> {
    const mounts =
      (await this.getConfigValue<MountEntry[]>("mounts".split("."))) || [];
    if (!mounts.some((m) => m.source === source && m.target === target)) {
      await this.patchConfig(["mounts"], [...mounts, { source, target }]);
    }
  }

  async removeMount(index: number): Promise<void> {
    const mounts =
      (await this.getConfigValue<MountEntry[]>("mounts".split("."))) || [];
    await this.patchConfig(
      ["mounts"],
      mounts.filter((_, i) => i !== index),
    );
  }

  async addRunArg(arg: string): Promise<void> {
    const args =
      (await this.getConfigValue<string[]>("runArgs".split("."))) || [];
    if (!args.includes(arg)) {
      await this.patchConfig(["runArgs"], [...args, arg]);
    }
  }

  async removeRunArg(index: number): Promise<void> {
    const args =
      (await this.getConfigValue<string[]>("runArgs".split("."))) || [];
    await this.patchConfig(
      ["runArgs"],
      args.filter((_, i) => i !== index),
    );
  }

  async setRemoteUser(user: string): Promise<void> {
    await this.patchConfig(["remoteUser"], user || undefined);
  }

  /** Repair a corrupted devcontainer.json. */
  async repairConfig(): Promise<void> {
    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    if (!wsFolder) return;

    const configUri = await this.configManager.getConfigPath(wsFolder.uri);
    if (!configUri) return;
    const configPath = configUri.fsPath;

    // Save backup: devcontainer.json.bak1, .bak2, ...
    let bakPath: string;
    let n = 1;
    for (;;) {
      bakPath = configPath + ".bak" + n;
      n++;
      try {
        await vscode.workspace.fs.stat(
          vscode.Uri.from({ scheme: "file", path: bakPath }),
        );
      } catch {
        break;
      }
    }

    const { repairDevcontainerJson } = await import("./jsonRepair.js");

    // Read from editor buffer if available (preserves unsaved fixes),
    // fall back to disk content
    const doc = await this.getEditorDoc();
    const content = doc
      ? doc.getText()
      : new TextDecoder().decode(
          await vscode.workspace.fs.readFile(
            vscode.Uri.from({ scheme: "file", path: configPath }),
          ),
        );

    // Always save backup before attempting repair
    await vscode.workspace.fs.writeFile(
      vscode.Uri.from({ scheme: "file", path: bakPath }),
      Buffer.from(content, "utf-8"),
    );
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
          // Format not available - repaired content is still valid
        }
      } else {
        await vscode.workspace.fs.writeFile(
          vscode.Uri.from({ scheme: "file", path: configPath }),
          Buffer.from(repaired, "utf-8"),
        );
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
            vscode.window.showTextDocument(
              vscode.Uri.from({ scheme: "file", path: bakPath }),
            );
          }
        });
    }
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
    return printParseErrorCode(code);
  }
}
