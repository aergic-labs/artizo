/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock vscode module
vi.mock("vscode", () => {
  const EventEmitter = vi.fn(function () {
    return {
      event: vi.fn(),
      fire: vi.fn(),
      dispose: vi.fn(),
    };
  });

  return {
    languages: {
      createDiagnosticCollection: vi.fn().mockReturnValue({
        set: vi.fn(),
        delete: vi.fn(),
        clear: vi.fn(),
        dispose: vi.fn(),
      }),
    },
    workspace: {
      createFileSystemWatcher: vi.fn().mockReturnValue({
        onDidChange: vi.fn().mockReturnValue({ dispose: vi.fn() }),
        onDidCreate: vi.fn().mockReturnValue({ dispose: vi.fn() }),
        onDidDelete: vi.fn().mockReturnValue({ dispose: vi.fn() }),
        dispose: vi.fn(),
      }),
      textDocuments: [],
      onDidOpenTextDocument: vi.fn().mockReturnValue({ dispose: vi.fn() }),
      onDidChangeTextDocument: vi.fn().mockReturnValue({ dispose: vi.fn() }),
      workspaceFolders: undefined,
    },
    window: {
      showInformationMessage: vi.fn().mockResolvedValue(undefined),
    },
    commands: {
      executeCommand: vi.fn().mockResolvedValue(undefined),
    },
    Uri: {
      parse: vi.fn().mockImplementation((str: string) => ({
        toString: () => str,
        fsPath: str,
        scheme: "file",
      })),
      file: vi.fn().mockImplementation((path: string) => ({
        toString: () => `file://${path}`,
        fsPath: path,
        scheme: "file",
      })),
    },
    Range: class {
      constructor(
        public startLine: number,
        public startCharacter: number,
        public endLine: number,
        public endCharacter: number,
      ) {}
    },
    Position: class {
      constructor(
        public line: number,
        public character: number,
      ) {
        this.line = line;
        this.character = character;
      }
      translate(lineDelta: number, charDelta: number) {
        return new (this.constructor as any)(
          this.line + lineDelta,
          this.character + charDelta,
        );
      }
    },
    Diagnostic: class {
      source?: string;
      constructor(
        public range: any,
        public message: string,
        public severity: number,
      ) {}
    },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    EventEmitter,
  };
});

import * as vscode from "vscode";
import {
  ConfigWatcher,
  type ConfigWatcherOptions,
} from "../../src/config/configWatcher";
import { ConfigManager } from "../../src/config/configManager";

function createMockConfigManager(): ConfigManager {
  const manager = new ConfigManager();
  return manager;
}

function createMockDocument(content: string, uri?: any): vscode.TextDocument {
  const lines = content.split("\n");
  return {
    uri: uri || {
      toString: () => "file:///workspace/devcontainer.json",
      fsPath: "/workspace/devcontainer.json",
      scheme: "file",
    },
    getText: () => content,
    lineCount: lines.length,
    lineAt: (line: number) => ({
      text: lines[Math.min(line, lines.length - 1)] || "",
      range: new (vscode as any).Range(
        line,
        0,
        line,
        (lines[Math.min(line, lines.length - 1)] || "").length,
      ),
    }),
    positionAt: (offset: number) => {
      let line = 0;
      let col = 0;
      for (let i = 0; i < offset && i < content.length; i++) {
        if (content[i] === "\n") {
          line++;
          col = 0;
        } else {
          col++;
        }
      }
      return new (vscode as any).Position(line, col);
    },
  } as unknown as vscode.TextDocument;
}

function createMockContext(): vscode.ExtensionContext {
  return {
    subscriptions: [],
  } as unknown as vscode.ExtensionContext;
}

describe("ConfigWatcher", () => {
  let configManager: ConfigManager;
  let watcher: ConfigWatcher;
  let options: ConfigWatcherOptions;

  beforeEach(() => {
    vi.clearAllMocks();
    configManager = createMockConfigManager();
    options = { configManager };
    // Reset workspace.textDocuments to empty
    (vscode.workspace as any).textDocuments = [];
  });

  describe("constructor", () => {
    it("creates a diagnostic collection", () => {
      watcher = new ConfigWatcher(options);
      expect(vscode.languages.createDiagnosticCollection).toHaveBeenCalledWith(
        "devcontainer",
      );
      watcher.dispose();
    });

    it("creates a file system watcher for devcontainer.json", () => {
      watcher = new ConfigWatcher(options);
      expect(vscode.workspace.createFileSystemWatcher).toHaveBeenCalledWith(
        "**/devcontainer.json",
      );
      watcher.dispose();
    });

    it("registers document event listeners", () => {
      watcher = new ConfigWatcher(options);
      expect(vscode.workspace.onDidOpenTextDocument).toHaveBeenCalled();
      expect(vscode.workspace.onDidChangeTextDocument).toHaveBeenCalled();
      watcher.dispose();
    });

    it("validates already-open devcontainer.json documents", () => {
      const doc = createMockDocument('{"image": "node:18"}');
      (vscode.workspace as any).textDocuments = [doc];

      watcher = new ConfigWatcher(options);

      const diagnosticCollection = vi.mocked(
        vscode.languages.createDiagnosticCollection,
      ).mock.results[0].value;
      expect(diagnosticCollection.set).toHaveBeenCalled();
      watcher.dispose();
    });
  });

  describe("register", () => {
    it("creates watcher and adds to context subscriptions", () => {
      const context = createMockContext();
      const registered = ConfigWatcher.register(context, options);
      expect(context.subscriptions).toContain(registered);
      registered.dispose();
    });
  });

  describe("validateDocument", () => {
    it("reports no diagnostics for valid config", () => {
      watcher = new ConfigWatcher(options);
      const doc = createMockDocument('{"image": "node:18"}');

      watcher.validateDocument(doc);

      const diagnosticCollection = vi.mocked(
        vscode.languages.createDiagnosticCollection,
      ).mock.results[0].value;
      const setCall =
        diagnosticCollection.set.mock.calls[
          diagnosticCollection.set.mock.calls.length - 1
        ];
      const diagnostics = setCall[1] as any[];
      // Valid config should have no errors (may have warnings about missing image/dockerfile)
      const errors = diagnostics.filter((d: any) => d.severity === 0);
      expect(errors).toHaveLength(0);
      watcher.dispose();
    });

    it("reports parse errors for invalid JSONC", () => {
      watcher = new ConfigWatcher(options);
      const doc = createMockDocument("{invalid json}");

      watcher.validateDocument(doc);

      const diagnosticCollection = vi.mocked(
        vscode.languages.createDiagnosticCollection,
      ).mock.results[0].value;
      const setCall =
        diagnosticCollection.set.mock.calls[
          diagnosticCollection.set.mock.calls.length - 1
        ];
      const diagnostics = setCall[1] as any[];
      const errors = diagnostics.filter((d: any) => d.severity === 0);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].message).toContain("JSONC parse error");
      expect(errors[0].source).toBe("devcontainer");
      watcher.dispose();
    });

    it("reports schema validation errors for invalid types", () => {
      watcher = new ConfigWatcher(options);
      // forwardPorts should be an array, not a string
      const doc = createMockDocument('{"forwardPorts": "not-an-array"}');

      watcher.validateDocument(doc);

      const diagnosticCollection = vi.mocked(
        vscode.languages.createDiagnosticCollection,
      ).mock.results[0].value;
      const setCall =
        diagnosticCollection.set.mock.calls[
          diagnosticCollection.set.mock.calls.length - 1
        ];
      const diagnostics = setCall[1] as any[];
      const errors = diagnostics.filter((d: any) => d.severity === 0);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].message).toContain("Schema validation");
      watcher.dispose();
    });

    it("reports warnings for missing image/dockerfile/build", () => {
      watcher = new ConfigWatcher(options);
      const doc = createMockDocument('{"name": "test"}');

      watcher.validateDocument(doc);

      const diagnosticCollection = vi.mocked(
        vscode.languages.createDiagnosticCollection,
      ).mock.results[0].value;
      const setCall =
        diagnosticCollection.set.mock.calls[
          diagnosticCollection.set.mock.calls.length - 1
        ];
      const diagnostics = setCall[1] as any[];
      const warnings = diagnostics.filter((d: any) => d.severity === 1);
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings[0].message).toContain("image");
      watcher.dispose();
    });

    it("handles JSONC with comments correctly", () => {
      watcher = new ConfigWatcher(options);
      const doc = createMockDocument(`{
  // This is a comment
  "image": "node:18"
}`);

      watcher.validateDocument(doc);

      const diagnosticCollection = vi.mocked(
        vscode.languages.createDiagnosticCollection,
      ).mock.results[0].value;
      const setCall =
        diagnosticCollection.set.mock.calls[
          diagnosticCollection.set.mock.calls.length - 1
        ];
      const diagnostics = setCall[1] as any[];
      const errors = diagnostics.filter((d: any) => d.severity === 0);
      expect(errors).toHaveLength(0);
      watcher.dispose();
    });

    it("handles JSONC with trailing commas", () => {
      watcher = new ConfigWatcher(options);
      const doc = createMockDocument('{"image": "node:18",}');

      watcher.validateDocument(doc);

      const diagnosticCollection = vi.mocked(
        vscode.languages.createDiagnosticCollection,
      ).mock.results[0].value;
      const setCall =
        diagnosticCollection.set.mock.calls[
          diagnosticCollection.set.mock.calls.length - 1
        ];
      const diagnostics = setCall[1] as any[];
      const errors = diagnostics.filter((d: any) => d.severity === 0);
      expect(errors).toHaveLength(0);
      watcher.dispose();
    });
  });

  describe("file watcher events", () => {
    it("fires onDidConfigChange when file changes", () => {
      watcher = new ConfigWatcher(options);

      // Get the onDidChange handler registered with the file watcher
      const fileWatcher = vi.mocked(vscode.workspace.createFileSystemWatcher)
        .mock.results[0].value;
      const onDidChangeHandler = fileWatcher.onDidChange.mock.calls[0][0];

      const listener = vi.fn();
      // The EventEmitter mock's event is a vi.fn(), so we need to access the fire method
      const emitter = (watcher as any)._onDidConfigChange;

      const uri = {
        toString: () => "file:///workspace/devcontainer.json",
        fsPath: "/workspace/devcontainer.json",
        scheme: "file",
      };

      // Call the handler
      onDidChangeHandler(uri);

      // Verify the emitter's fire was called
      expect(emitter.fire).toHaveBeenCalledWith(uri);
      watcher.dispose();
    });

    it("clears diagnostics when file is deleted", () => {
      watcher = new ConfigWatcher(options);

      const fileWatcher = vi.mocked(vscode.workspace.createFileSystemWatcher)
        .mock.results[0].value;
      const onDidDeleteHandler = fileWatcher.onDidDelete.mock.calls[0][0];

      const uri = {
        toString: () => "file:///workspace/devcontainer.json",
        fsPath: "/workspace/devcontainer.json",
        scheme: "file",
      };
      onDidDeleteHandler(uri);

      const diagnosticCollection = vi.mocked(
        vscode.languages.createDiagnosticCollection,
      ).mock.results[0].value;
      expect(diagnosticCollection.delete).toHaveBeenCalledWith(uri);
      watcher.dispose();
    });
  });

  describe("offerRebuild", () => {
    it("does not offer rebuild when no workspace folders", () => {
      (vscode.workspace as any).workspaceFolders = undefined;
      watcher = new ConfigWatcher(options);

      const fileWatcher = vi.mocked(vscode.workspace.createFileSystemWatcher)
        .mock.results[0].value;
      const onDidChangeHandler = fileWatcher.onDidChange.mock.calls[0][0];

      const uri = {
        toString: () => "file:///workspace/devcontainer.json",
        fsPath: "/workspace/devcontainer.json",
        scheme: "file",
      };
      onDidChangeHandler(uri);

      expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
      watcher.dispose();
    });

    it("does not offer rebuild when workspace is local (not remote)", () => {
      (vscode.workspace as any).workspaceFolders = [
        { uri: { scheme: "file", fsPath: "/workspace" } },
      ];
      watcher = new ConfigWatcher(options);

      const fileWatcher = vi.mocked(vscode.workspace.createFileSystemWatcher)
        .mock.results[0].value;
      const onDidChangeHandler = fileWatcher.onDidChange.mock.calls[0][0];

      const uri = {
        toString: () => "file:///workspace/devcontainer.json",
        fsPath: "/workspace/devcontainer.json",
        scheme: "file",
      };
      onDidChangeHandler(uri);

      expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
      watcher.dispose();
    });

    it("offers rebuild when workspace is remote and config changes", async () => {
      (vscode.workspace as any).workspaceFolders = [
        { uri: { scheme: "vscode-remote", fsPath: "/workspace" } },
      ];
      watcher = new ConfigWatcher(options);

      const fileWatcher = vi.mocked(vscode.workspace.createFileSystemWatcher)
        .mock.results[0].value;
      const onDidChangeHandler = fileWatcher.onDidChange.mock.calls[0][0];

      const uri = {
        toString: () => "file:///workspace/devcontainer.json",
        fsPath: "/workspace/devcontainer.json",
        scheme: "file",
      };
      onDidChangeHandler(uri);

      // Wait for the async offerRebuild to complete
      await vi.waitFor(() => {
        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
          "Dev container configuration has changed. Rebuild the container to apply changes?",
          "Rebuild",
          "Later",
        );
      });
      watcher.dispose();
    });

    it("executes rebuild command when user selects Rebuild", async () => {
      (vscode.workspace as any).workspaceFolders = [
        { uri: { scheme: "vscode-remote", fsPath: "/workspace" } },
      ];
      vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(
        "Rebuild" as any,
      );

      watcher = new ConfigWatcher(options);

      const fileWatcher = vi.mocked(vscode.workspace.createFileSystemWatcher)
        .mock.results[0].value;
      const onDidChangeHandler = fileWatcher.onDidChange.mock.calls[0][0];

      const uri = {
        toString: () => "file:///workspace/devcontainer.json",
        fsPath: "/workspace/devcontainer.json",
        scheme: "file",
      };
      onDidChangeHandler(uri);

      await vi.waitFor(() => {
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
          "artizo.rebuildContainer",
        );
      });
      watcher.dispose();
    });

    it("does not rebuild when user selects Later", async () => {
      (vscode.workspace as any).workspaceFolders = [
        { uri: { scheme: "vscode-remote", fsPath: "/workspace" } },
      ];
      vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(
        "Later" as any,
      );

      watcher = new ConfigWatcher(options);

      const fileWatcher = vi.mocked(vscode.workspace.createFileSystemWatcher)
        .mock.results[0].value;
      const onDidChangeHandler = fileWatcher.onDidChange.mock.calls[0][0];

      const uri = {
        toString: () => "file:///workspace/devcontainer.json",
        fsPath: "/workspace/devcontainer.json",
        scheme: "file",
      };
      onDidChangeHandler(uri);

      // Give async operations time to complete
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith(
        "artizo.rebuildContainer",
      );
      watcher.dispose();
    });
  });

  describe("dispose", () => {
    it("disposes all resources", () => {
      watcher = new ConfigWatcher(options);
      watcher.dispose();

      const diagnosticCollection = vi.mocked(
        vscode.languages.createDiagnosticCollection,
      ).mock.results[0].value;
      expect(diagnosticCollection.dispose).toHaveBeenCalled();
    });
  });
});
