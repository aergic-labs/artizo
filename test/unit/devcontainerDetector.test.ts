/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";
import { DevcontainerDetector } from "../../src/workflows/devcontainerDetector";
import type { IConfigManager } from "../../src/config/configManager";

// Mock vscode module
vi.mock("vscode", () => {
  return {
    env: {
      remoteName: undefined,
    },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: "/workspace" } }],
    },
    window: {
      showInformationMessage: vi.fn().mockResolvedValue(undefined),
    },
    commands: {
      executeCommand: vi.fn().mockResolvedValue(undefined),
    },
  };
});

function createMockConfigManager(
  overrides?: Partial<IConfigManager>,
): IConfigManager {
  return {
    readConfig: vi.fn().mockReturnValue({
      config: { image: "node:18" },
      configPath: "/workspace/.devcontainer/devcontainer.json",
      parseErrors: [],
    }),
    validateConfig: vi
      .fn()
      .mockReturnValue({ valid: true, errors: [], warnings: [] }),
    getConfigPath: vi
      .fn()
      .mockReturnValue("/workspace/.devcontainer/devcontainer.json"),
    ...overrides,
  };
}

function createMockContext(): vscode.ExtensionContext {
  const workspaceState = new Map<string, unknown>();
  return {
    workspaceState: {
      get: vi.fn(
        (key: string, defaultValue?: unknown) =>
          workspaceState.get(key) ?? defaultValue,
      ),
      update: vi.fn((key: string, value: unknown) => {
        workspaceState.set(key, value);
        return Promise.resolve();
      }),
      keys: vi.fn(() => [...workspaceState.keys()]),
    },
    subscriptions: [],
  } as unknown as vscode.ExtensionContext;
}

describe("DevcontainerDetector", () => {
  let configManager: IConfigManager;
  let context: vscode.ExtensionContext;
  let detector: DevcontainerDetector;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset vscode.env.remoteName to undefined (local)
    (vscode.env as any).remoteName = undefined;
    // Reset workspace folders
    (vscode.workspace as any).workspaceFolders = [
      { uri: { fsPath: "/workspace" } },
    ];

    configManager = createMockConfigManager();
    context = createMockContext();
    detector = new DevcontainerDetector(configManager);
  });

  it("shows notification when devcontainer.json exists and not connected to remote", async () => {
    await detector.checkAndPrompt(context);

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      "Folder contains a Dev Container configuration file. Reopen folder to develop in a container.",
      "Reopen in Container",
      "Don't Show Again",
    );
  });

  it("skips notification when already connected to a remote", async () => {
    (vscode.env as any).remoteName = "dev-container";

    await detector.checkAndPrompt(context);

    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('skips notification when "don\'t show again" flag is set', async () => {
    // Set the "don't show again" flag
    await context.workspaceState.update(
      "artizo.devcontainerDetector.dontShowAgain",
      true,
    );

    await detector.checkAndPrompt(context);

    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it("skips notification when no workspace folder is open", async () => {
    (vscode.workspace as any).workspaceFolders = undefined;

    await detector.checkAndPrompt(context);

    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it("skips notification when no devcontainer.json is found", async () => {
    configManager = createMockConfigManager({
      getConfigPath: vi.fn().mockReturnValue(null),
    });
    detector = new DevcontainerDetector(configManager);

    await detector.checkAndPrompt(context);

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "setContext",
      "artizo.hasDevcontainerConfig",
      false,
    );
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('executes reopenInContainer command when user clicks "Reopen in Container"', async () => {
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(
      "Reopen in Container" as any,
    );

    await detector.checkAndPrompt(context);

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "artizo.reopenInContainer",
    );
  });

  it('persists "don\'t show again" flag when user clicks "Don\'t Show Again"', async () => {
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(
      "Don't Show Again" as any,
    );

    await detector.checkAndPrompt(context);

    expect(context.workspaceState.update).toHaveBeenCalledWith(
      "artizo.devcontainerDetector.dontShowAgain",
      true,
    );
  });

  it("does nothing when user dismisses the notification", async () => {
    vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(
      undefined as any,
    );

    await detector.checkAndPrompt(context);

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "setContext",
      "artizo.hasDevcontainerConfig",
      true,
    );
    // But no other commands should be called
    expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith(
      "artizo.reopenInContainer",
    );
    // workspaceState.update should not be called for the dontShowAgain key after the notification
    const updateCalls = vi.mocked(context.workspaceState.update).mock.calls;
    const dontShowCalls = updateCalls.filter(
      (call) => call[0] === "artizo.devcontainerDetector.dontShowAgain",
    );
    expect(dontShowCalls).toHaveLength(0);
  });

  it("uses ConfigManager.getConfigPath to find devcontainer.json", async () => {
    await detector.checkAndPrompt(context);

    expect(configManager.getConfigPath).toHaveBeenCalledWith("/workspace");
  });
});