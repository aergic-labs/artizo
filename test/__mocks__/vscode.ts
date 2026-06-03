/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// Global mock for the 'vscode' module.
// VS Code APIs are only available inside the extension host.
// Tests that transitively import vscode (e.g. via uriUtils.ts) need this.
import { vi } from 'vitest';

const vscode = {
  window: {
    createOutputChannel: vi.fn(),
    createTerminal: vi.fn(),
    createStatusBarItem: vi.fn(),
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showOpenDialog: vi.fn(),
    showQuickPick: vi.fn(),
    showInputBox: vi.fn(),
    withProgress: vi.fn(),
    onDidChangeActiveTerminal: vi.fn(),
  },
  commands: {
    registerCommand: vi.fn(),
    executeCommand: vi.fn(),
  },
  workspace: {
    getConfiguration: vi.fn(),
    workspaceFolders: [],
    registerRemoteAuthorityResolver: vi.fn(),
    registerFileSystemProvider: vi.fn(),
  },
  env: {
    remoteName: undefined,
    appRoot: '/mock/app/root',
  },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ProgressLocation: { Notification: 15 },
  Uri: {
    file: (p: string) => ({ fsPath: p, scheme: 'file', authority: '', path: p }),
    parse: (p: string) => ({ fsPath: p, scheme: 'file', authority: '', path: p }),
  },
  EventEmitter: class {
    event = vi.fn();
    fire() {}
  },
  Disposable: { from() { return { dispose: vi.fn() }; } },
};

export default vscode;