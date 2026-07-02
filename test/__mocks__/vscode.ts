/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// Global mock for the 'vscode' module.
// VS Code APIs are only available inside the extension host.
// Tests that transitively import vscode (e.g. via uriUtils.ts) need this.
import { vi } from "vitest";

const vscode = {
  window: {
    createOutputChannel: vi.fn(() => ({
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      append: vi.fn(),
      appendLine: vi.fn(),
      replace: vi.fn(),
      clear: vi.fn(),
      show: vi.fn(),
      hide: vi.fn(),
      dispose: vi.fn(),
    })),
    createTerminal: vi.fn(() => ({ show: vi.fn(), dispose: vi.fn() })),
    createStatusBarItem: vi.fn(),
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showOpenDialog: vi.fn(),
    showQuickPick: vi.fn(),
    showInputBox: vi.fn(),
    showTextDocument: vi.fn().mockResolvedValue(undefined),
    withProgress: vi.fn(),
    onDidChangeActiveTerminal: vi.fn(),
  },
  languages: {
    setTextDocumentLanguage: vi.fn().mockResolvedValue({}),
  },
  ViewColumn: { One: 1, Two: 2, Three: 3 },
  commands: {
    registerCommand: vi.fn(),
    executeCommand: vi.fn(),
  },
  workspace: {
    getConfiguration: vi.fn().mockReturnValue({
      get: vi.fn((_key: string, defaultValue: unknown) => defaultValue),
      update: vi.fn().mockResolvedValue(undefined),
    }),
    workspaceFolders: [],
    openTextDocument: vi.fn().mockResolvedValue({}),
    registerRemoteAuthorityResolver: vi.fn(),
    registerFileSystemProvider: vi.fn(),
    fs: {
      readDirectory: vi.fn().mockRejectedValue(new Error("ENOENT")),
      readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
      writeFile: vi.fn().mockResolvedValue(undefined),
      copy: vi.fn().mockResolvedValue(undefined),
      stat: vi.fn().mockRejectedValue(new Error("ENOENT")),
      createDirectory: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      rename: vi.fn().mockResolvedValue(undefined),
    },
  },
  env: {
    remoteName: undefined,
    remoteAuthority: undefined as string | undefined,
    appRoot: "/mock/app/root",
  },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ProgressLocation: { Notification: 15 },
  ExtensionKind: { UI: 1, Workspace: 2 },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  Uri: (() => {
    function makeUri(
      scheme: string,
      authority: string,
      path: string,
      query?: string,
    ): any {
      const fsPath =
        scheme === "vscode-remote"
          ? `vscode-remote://${authority}${path}`
          : path;
      return {
        fsPath,
        scheme,
        authority,
        path,
        query,
        with: (change: {
          path?: string;
          authority?: string;
          scheme?: string;
          query?: string;
        }) =>
          makeUri(
            change.scheme ?? scheme,
            change.authority ?? authority,
            change.path ?? path,
            change.query ?? query,
          ),
        toString: () => fsPath,
      };
    }
    return {
      file: (p: string) => makeUri("file", "", p),
      parse: (p: string) => {
        if (p.startsWith("vscode-remote://")) {
          const rest = p.replace("vscode-remote://", "");
          const slashIdx = rest.indexOf("/");
          const authority =
            slashIdx === -1 ? rest : rest.substring(0, slashIdx);
          const path = slashIdx === -1 ? "/" : rest.substring(slashIdx);
          return makeUri("vscode-remote", authority, path);
        }
        return makeUri("file", "", p);
      },
      joinPath: (base: any, ...segments: string[]) => {
        const basePath = base.path || "";
        const joined =
          basePath.replace(/\/+$/, "") +
          "/" +
          segments.map((s) => s.replace(/^\/+/, "")).join("/");
        return makeUri(base.scheme || "file", base.authority || "", joined);
      },
    };
  })(),
  EventEmitter: class {
    event = vi.fn();
    fire() {}
  },
  Disposable: {
    from() {
      return { dispose: vi.fn() };
    },
  },
};

export default vscode;
