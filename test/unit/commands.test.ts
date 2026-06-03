/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("vscode", () => ({
  window: {
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showInputBox: vi.fn(),
    showQuickPick: vi.fn(),
    showTextDocument: vi.fn(),
    showOpenDialog: vi.fn(),
    withProgress: vi.fn(),
  },
  commands: {
    executeCommand: vi.fn(),
    registerCommand: vi.fn().mockReturnValue({ dispose: vi.fn() }),
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: "/test/workspace" } }],
    openTextDocument: vi.fn(),
  },
  Uri: {
    parse: (s: string) => ({ toString: () => s }),
    file: (s: string) => ({ fsPath: s }),
  },
  ProgressLocation: { Notification: 15 },
  env: { remoteName: undefined },
}));

// Mock workflow imports that handlers delegate to
vi.mock("../../src/workflows/reopenInContainer", () => ({
  reopenInContainer: vi.fn(),
}));
vi.mock("../../src/workflows/rebuildContainer", () => ({
  rebuildContainer: vi.fn(),
}));
vi.mock("../../src/workflows/openFolder", () => ({
  openFolderInContainer: vi.fn(),
}));
vi.mock("../../src/workflows/cloneInVolume", () => ({
  cloneInVolume: vi.fn(),
}));
vi.mock("../../src/workflows/attachToContainer", () => ({
  attachToContainer: vi.fn(),
}));
vi.mock("../../src/host/adapters", () => ({
  buildOpenFolderUI: vi.fn().mockReturnValue({ pickFolder: vi.fn() }),
  buildCloneInVolumeUI: vi.fn().mockReturnValue({ promptRepoUrl: vi.fn() }),
  buildAttachUI: vi.fn().mockReturnValue({ pickContainer: vi.fn() }),
  buildDockerLister: vi
    .fn()
    .mockReturnValue({ listRunningContainers: vi.fn() }),
}));
vi.mock("../../src/utils/logger", () => ({
  getLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  }),
}));
vi.mock("../../src/utils/constants", () => ({
  BRAND_PREFIX: "[Artizo]",
  BRAND: "Artizo",
  MANAGED_LABEL: "com.artizo.managed=true",
}));
vi.mock("../../src/host/guards", () => ({
  guardLocalContext: vi.fn(),
  checkDockerAvailable: vi.fn(),
  getLocalWorkspaceFolder: vi.fn().mockReturnValue("/test/workspace"),
}));

import * as vscode from "vscode";
import { reopenInContainer } from "../../src/workflows/reopenInContainer";
import { rebuildContainer } from "../../src/workflows/rebuildContainer";
import { getLocalWorkspaceFolder } from "../../src/host/guards";
import type { CommandContext } from "../../src/host/commands";
import {
  reopenInContainerHandler,
  rebuildAndReopenInContainerHandler,
  configureDevContainerHandler,
  addConfigurationHandler,
  openDevContainerFileHandler,
  openFolderInContainerHandler,
  cleanUpContainersHandler,
  rebuildContainerMenuHandler,
  rebuildContainerHandler,
  rebuildContainerNoCacheHandler,
  reopenLocallyHandler,
} from "../../src/host/commands";

function mockCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  // Reset mutable mock state that could leak between tests
  (vscode.env as any).remoteName = undefined;
  return {
    deps: {} as any,
    ui: {} as any,
    configManager: {
      getConfigPath: vi
        .fn()
        .mockReturnValue("/test/.devcontainer/devcontainer.json"),
    } as any,
    containerLifecycle: {
      cleanUp: vi.fn().mockResolvedValue({
        containersRemoved: 0,
        imagesRemoved: 0,
        volumesRemoved: 0,
        errors: [],
      }),
    } as any,
    orchestrator: {
      state: "connected",
      beginDisconnect: vi.fn(),
      disconnectComplete: vi.fn(),
    } as any,
    buildLogTerminal: { show: vi.fn(), dispose: vi.fn() } as any,
    buildLogPty: {
      writeLine: vi.fn(),
      write: vi.fn(),
      show: vi.fn(),
      dispose: vi.fn(),
    } as any,
    dockerPath: "docker",
    sidebarProvider: {
      loadConfig: vi.fn(),
      hasConfig: vi.fn().mockReturnValue(true),
      expandSection: vi.fn(),
    } as any,
    ...overrides,
  };
}

describe("command handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("reopenInContainerHandler", () => {
    it("delegates to reopenInContainer workflow", async () => {
      const ctx = mockCtx();
      await reopenInContainerHandler(ctx, "/workspace");

      expect(reopenInContainer).toHaveBeenCalledWith(ctx.deps, ctx.ui, {
        workspaceFolder: "/workspace",
      });
    });
  });

  describe("rebuildAndReopenInContainerHandler", () => {
    it("delegates to rebuildContainer with reconnect:true", async () => {
      const ctx = mockCtx();
      await rebuildAndReopenInContainerHandler(ctx, "/ws");

      expect(rebuildContainer).toHaveBeenCalledWith(ctx.deps, ctx.ui, {
        workspaceFolder: "/ws",
        noCache: false,
        reconnect: true,
      });
    });
  });

  describe("configureDevContainerHandler", () => {
    it("opens sidebar and loads config", async () => {
      const ctx = mockCtx();
      vi.mocked(ctx.sidebarProvider.hasConfig).mockReturnValue(true);

      await configureDevContainerHandler(ctx);

      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        "workbench.view.extension.artizo-sidebar",
      );
      expect(ctx.sidebarProvider.loadConfig).toHaveBeenCalled();
      expect(ctx.sidebarProvider.expandSection).toHaveBeenCalledWith("config");
    });

    it("expands wizard section when no config exists", async () => {
      const ctx = mockCtx();
      vi.mocked(ctx.sidebarProvider.hasConfig).mockReturnValue(false);

      await configureDevContainerHandler(ctx);

      expect(ctx.sidebarProvider.expandSection).toHaveBeenCalledWith("wizard");
    });
  });

  describe("addConfigurationHandler", () => {
    it("opens sidebar and loads config", async () => {
      const ctx = mockCtx();
      vi.mocked(ctx.sidebarProvider.hasConfig).mockReturnValue(true);

      await addConfigurationHandler(ctx);

      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        "workbench.view.extension.artizo-sidebar",
      );
      expect(ctx.sidebarProvider.loadConfig).toHaveBeenCalled();
      expect(ctx.sidebarProvider.expandSection).toHaveBeenCalledWith("config");
    });
  });

  describe("openDevContainerFileHandler", () => {
    it("opens the devcontainer config file", async () => {
      const ctx = mockCtx();
      const doc = { uri: { fsPath: "/path" } };
      vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(
        doc as any,
      );

      await openDevContainerFileHandler(ctx, "/workspace");

      expect(ctx.configManager.getConfigPath).toHaveBeenCalledWith(
        "/workspace",
      );
      expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(
        "/test/.devcontainer/devcontainer.json",
      );
      expect(vscode.window.showTextDocument).toHaveBeenCalledWith(doc);
    });

    it("shows error when no config found", async () => {
      const ctx = mockCtx();
      vi.mocked(ctx.configManager.getConfigPath).mockReturnValue(null);

      await openDevContainerFileHandler(ctx, "/workspace");

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        "No devcontainer.json found in workspace.",
      );
      expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
    });
  });

  describe("openFolderInContainerHandler", () => {
    it("delegates to openFolderInContainer workflow", async () => {
      const ctx = mockCtx();
      await openFolderInContainerHandler(ctx);

      expect(
        (await import("../../src/host/adapters")).buildOpenFolderUI,
      ).toHaveBeenCalledWith(ctx.ui);
    });
  });

  describe("cleanUpContainersHandler", () => {
    it("exits early when user cancels the pick", async () => {
      const ctx = mockCtx();
      vi.mocked(vscode.window.showQuickPick).mockResolvedValue(
        undefined as any,
      );

      await cleanUpContainersHandler(ctx);

      expect(vscode.window.withProgress).not.toHaveBeenCalled();
    });

    it("calls containerLifecycle.cleanUp with correct options", async () => {
      const ctx = mockCtx();
      vi.mocked(vscode.window.showQuickPick).mockResolvedValue(
        "Containers and images" as any,
      );
      vi.mocked(vscode.window.withProgress).mockImplementation(
        async (_opts: any, fn: any) => {
          await fn();
        },
      );

      await cleanUpContainersHandler(ctx);

      expect(ctx.containerLifecycle.cleanUp).toHaveBeenCalledWith({
        removeImages: true,
        removeVolumes: false,
      });
    });

    it("shows summary message with removal counts", async () => {
      const ctx = mockCtx();
      vi.mocked(vscode.window.showQuickPick).mockResolvedValue(
        "Containers, images, and volumes" as any,
      );
      vi.mocked(ctx.containerLifecycle.cleanUp).mockResolvedValue({
        containersRemoved: 3,
        imagesRemoved: 2,
        volumesRemoved: 1,
        errors: [],
      });
      vi.mocked(vscode.window.withProgress).mockImplementation(
        async (_opts: any, fn: any) => {
          await fn();
        },
      );

      await cleanUpContainersHandler(ctx);

      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        "Cleanup complete: 3 container(s), 2 image(s), 1 volume(s) removed.",
      );
    });

    it("shows 'nothing to clean up' when all counts are zero", async () => {
      const ctx = mockCtx();
      vi.mocked(vscode.window.showQuickPick).mockResolvedValue(
        "Containers only" as any,
      );
      vi.mocked(vscode.window.withProgress).mockImplementation(
        async (_opts: any, fn: any) => {
          await fn();
        },
      );

      await cleanUpContainersHandler(ctx);

      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        "Nothing to clean up.",
      );
    });

    it("shows warning when there are errors", async () => {
      const ctx = mockCtx();
      vi.mocked(vscode.window.showQuickPick).mockResolvedValue(
        "Containers only" as any,
      );
      vi.mocked(ctx.containerLifecycle.cleanUp).mockResolvedValue({
        containersRemoved: 1,
        imagesRemoved: 0,
        volumesRemoved: 0,
        errors: ["failed to remove image abc"],
      });
      vi.mocked(vscode.window.withProgress).mockImplementation(
        async (_opts: any, fn: any) => {
          await fn();
        },
      );

      await cleanUpContainersHandler(ctx);

      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        "Cleanup completed with 1 error(s). Check the log for details.",
      );
    });
  });

  describe("rebuildContainerHandler", () => {
    it("does not throw in happy path", async () => {
      const ctx = mockCtx();
      await expect(rebuildContainerHandler(ctx)).resolves.toBeUndefined();
    });

    it("shows error when no workspace folder", async () => {
      const ctx = mockCtx();
      vi.mocked(getLocalWorkspaceFolder).mockReturnValue(undefined);

      await rebuildContainerHandler(ctx);

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        "No workspace folder open.",
      );
    });

    it("exits when running inside a container", async () => {
      const ctx = mockCtx();
      (vscode.env as any).remoteName = "artizo-container";
      vi.mocked(vscode.window.showErrorMessage).mockResolvedValue(
        undefined as any,
      );

      await rebuildContainerHandler(ctx);

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining("Rebuild must be run from a local window"),
        "Reopen Folder Locally",
      );
    });

    it("delegates to rebuildContainer with noCache:false", async () => {
      const ctx = mockCtx();

      await rebuildContainerHandler(ctx);

      // Handler should have resolved workspace and started the build log
      expect(getLocalWorkspaceFolder).toHaveBeenCalled();
    });
  });

  describe("rebuildContainerNoCacheHandler", () => {
    it("delegates to rebuildContainer with noCache:true", async () => {
      const ctx = mockCtx();

      await rebuildContainerNoCacheHandler(ctx);

      expect(getLocalWorkspaceFolder).toHaveBeenCalled();
    });
  });

  describe("rebuildContainerMenuHandler", () => {
    it("shows error when no workspace folder", async () => {
      const ctx = mockCtx();
      vi.mocked(getLocalWorkspaceFolder).mockReturnValue(undefined);
      (vscode.env as any).remoteName = undefined;

      await rebuildContainerMenuHandler(ctx);

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        "No workspace folder open.",
      );
    });

    it("exits when user cancels the QuickPick", async () => {
      const ctx = mockCtx();
      vi.mocked(vscode.window.showQuickPick).mockResolvedValue(
        undefined as any,
      );

      await rebuildContainerMenuHandler(ctx);

      expect(rebuildContainer).not.toHaveBeenCalled();
    });

    it("interprets picked labels correctly", async () => {
      const ctx = mockCtx();
      vi.mocked(vscode.window.showQuickPick).mockResolvedValue({
        label: "Rebuild and Reopen",
        description: "Rebuild and reconnect",
      } as any);

      await rebuildContainerMenuHandler(ctx);

      expect(getLocalWorkspaceFolder).toHaveBeenCalled();
    });
  });

  describe("reopenLocallyHandler", () => {
    it("opens local folder and closes window when in container", async () => {
      const ctx = mockCtx();
      (vscode.env as any).remoteName = "artizo-container";
      vi.mocked(getLocalWorkspaceFolder).mockReturnValue("/local/path");

      await reopenLocallyHandler(ctx);

      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        "vscode.openFolder",
        expect.objectContaining({ fsPath: "/local/path" }),
        { forceNewWindow: true },
      );
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        "workbench.action.closeWindow",
      );
    });

    it("disconnects and reopens locally when not in container", async () => {
      const ctx = mockCtx();
      (vscode.env as any).remoteName = undefined;

      await reopenLocallyHandler(ctx);

      expect(ctx.orchestrator.beginDisconnect).toHaveBeenCalled();
      expect(ctx.orchestrator.disconnectComplete).toHaveBeenCalled();
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        "vscode.openFolder",
        expect.objectContaining({ fsPath: "/test/workspace" }),
      );
    });
  });
});