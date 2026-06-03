/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Config file watcher and editor diagnostics provider.
 *
 * Watches devcontainer.json for changes, validates, and reports errors
 * as editor diagnostics. Offers to rebuild when config changes while connected.
 */

import * as vscode from "vscode";
import { ConfigManager, type ConfigParseError } from "./configManager";
import type { ValidationError, ValidationWarning } from "./schemaValidator";

export interface ConfigWatcherOptions {
  configManager: ConfigManager;
}

export class ConfigWatcher implements vscode.Disposable {
  private readonly configManager: ConfigManager;
  private readonly diagnosticCollection: vscode.DiagnosticCollection;
  private readonly fileWatcher: vscode.FileSystemWatcher;
  private readonly disposables: vscode.Disposable[] = [];

  private readonly _onDidConfigChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidConfigChange: vscode.Event<vscode.Uri> =
    this._onDidConfigChange.event;

  constructor(options: ConfigWatcherOptions) {
    this.configManager = options.configManager;

    this.diagnosticCollection =
      vscode.languages.createDiagnosticCollection("devcontainer");
    this.disposables.push(this.diagnosticCollection);

    this.fileWatcher = vscode.workspace.createFileSystemWatcher(
      "**/devcontainer.json",
    );

    this.fileWatcher.onDidChange(
      (uri) => this.handleFileChange(uri),
      this,
      this.disposables,
    );
    this.fileWatcher.onDidCreate(
      (uri) => this.handleFileChange(uri),
      this,
      this.disposables,
    );
    this.fileWatcher.onDidDelete(
      (uri) => this.handleFileDelete(uri),
      this,
      this.disposables,
    );

    this.disposables.push(this.fileWatcher);
    this.disposables.push(this._onDidConfigChange);

    for (const doc of vscode.workspace.textDocuments) {
      if (this.isDevcontainerConfig(doc.uri)) {
        this.validateDocument(doc);
      }
    }

    // Validate on document open and edit
    vscode.workspace.onDidOpenTextDocument(
      (doc) => {
        if (this.isDevcontainerConfig(doc.uri)) {
          this.validateDocument(doc);
        }
      },
      this,
      this.disposables,
    );

    vscode.workspace.onDidChangeTextDocument(
      (event) => {
        if (this.isDevcontainerConfig(event.document.uri)) {
          this.validateDocument(event.document);
        }
      },
      this,
      this.disposables,
    );
  }

  static register(
    context: vscode.ExtensionContext,
    options: ConfigWatcherOptions,
  ): ConfigWatcher {
    const watcher = new ConfigWatcher(options);
    context.subscriptions.push(watcher);
    return watcher;
  }

  private isDevcontainerConfig(uri: vscode.Uri): boolean {
    return uri.fsPath.endsWith("devcontainer.json");
  }

  private handleFileChange(uri: vscode.Uri): void {
    this._onDidConfigChange.fire(uri);
    vscode.commands.executeCommand(
      "setContext",
      "artizo.hasDevcontainerConfig",
      true,
    );
    this.offerRebuild(uri);

    // If the document is open, validate it
    const doc = vscode.workspace.textDocuments.find(
      (d) => d.uri.toString() === uri.toString(),
    );
    if (doc) {
      this.validateDocument(doc);
    }
  }

  private handleFileDelete(uri: vscode.Uri): void {
    this.diagnosticCollection.delete(uri);
    this._onDidConfigChange.fire(uri);
    // Check if any config still exists after deletion
    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    const hasConfig = wsFolder
      ? !!this.configManager.getConfigPath(wsFolder.uri.fsPath)
      : false;
    vscode.commands.executeCommand(
      "setContext",
      "artizo.hasDevcontainerConfig",
      hasConfig,
    );
  }

  validateDocument(document: vscode.TextDocument): void {
    const content = document.getText();
    const diagnostics: vscode.Diagnostic[] = [];

    // Parse the JSONC content and collect parse errors
    const parseResult = this.configManager.parseContent(
      content,
      document.uri.fsPath,
    );

    // Add parse error diagnostics
    for (const parseError of parseResult.parseErrors) {
      const range = this.parseErrorToRange(parseError, document);
      const diagnostic = new vscode.Diagnostic(
        range,
        `JSONC parse error: ${parseError.message}`,
        vscode.DiagnosticSeverity.Error,
      );
      diagnostic.source = "devcontainer";
      diagnostics.push(diagnostic);
    }

    // If parsing succeeded, validate against schema
    if (parseResult.config !== null) {
      const validationResult = this.configManager.validateConfig(
        parseResult.config,
      );

      for (const error of validationResult.errors) {
        const range = this.schemaErrorToRange(error, document);
        const diagnostic = new vscode.Diagnostic(
          range,
          `Schema validation: ${error.message}`,
          vscode.DiagnosticSeverity.Error,
        );
        diagnostic.source = "devcontainer";
        diagnostics.push(diagnostic);
      }

      for (const warning of validationResult.warnings) {
        const range = this.schemaWarningToRange(warning, document);
        const diagnostic = new vscode.Diagnostic(
          range,
          warning.message,
          vscode.DiagnosticSeverity.Warning,
        );
        diagnostic.source = "devcontainer";
        diagnostics.push(diagnostic);
      }
    }

    this.diagnosticCollection.set(document.uri, diagnostics);
  }

  private parseErrorToRange(
    error: ConfigParseError,
    document: vscode.TextDocument,
  ): vscode.Range {
    // ConfigParseError is 1-based line/column
    const startLine = Math.max(0, error.line - 1);
    const startCol = Math.max(0, error.column - 1);
    const endCol = startCol + Math.max(1, error.length);

    const lineLength = document.lineAt(
      Math.min(startLine, document.lineCount - 1),
    ).text.length;
    return new vscode.Range(
      startLine,
      Math.min(startCol, lineLength),
      startLine,
      Math.min(endCol, lineLength),
    );
  }

  // Schema errors use JSON paths (e.g. "/forwardPorts/0").  Fallback at
  // line 0 because precise path-to-position mapping needs full AST traversal.
  private schemaErrorToRange(
    error: ValidationError,
    document: vscode.TextDocument,
  ): vscode.Range {
    // Try to find the property in the document text for better positioning
    const propertyName = this.extractPropertyName(error.path);
    if (propertyName) {
      const text = document.getText();
      const pattern = new RegExp(`"${propertyName}"\\s*:`);
      const match = pattern.exec(text);
      if (match) {
        const pos = document.positionAt(match.index);
        return new vscode.Range(pos, pos.translate(0, match[0].length));
      }
    }
    // Fallback: first line
    return new vscode.Range(0, 0, 0, 1);
  }

  private schemaWarningToRange(
    warning: ValidationWarning,
    document: vscode.TextDocument,
  ): vscode.Range {
    // Warnings typically apply to the whole document.
    if (warning.path === "/") {
      return new vscode.Range(0, 0, 0, 1);
    }
    return this.schemaErrorToRange(warning, document);
  }

  private extractPropertyName(jsonPath: string): string | null {
    const segments = jsonPath.split("/").filter(Boolean);
    for (let i = segments.length - 1; i >= 0; i--) {
      if (!/^\d+$/.test(segments[i])) {
        return segments[i];
      }
    }
    return null;
  }

  private async offerRebuild(_uri: vscode.Uri): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return;
    }

    // Check if the workspace is a remote workspace (connected to a container)
    const workspaceUri = workspaceFolders[0].uri;
    if (workspaceUri.scheme !== "vscode-remote") {
      return;
    }

    const selection = await vscode.window.showInformationMessage(
      "Dev container configuration has changed. Rebuild the container to apply changes?",
      "Rebuild",
      "Later",
    );

    if (selection === "Rebuild") {
      await vscode.commands.executeCommand("artizo.rebuildContainer");
    }
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}