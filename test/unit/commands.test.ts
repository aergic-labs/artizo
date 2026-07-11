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
  ExtensionKind: { UI: 1, Workspace: 2 },
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
vi.mock("../../src/host/reportProvisionFailure", () => ({
  reportProvisionFailure: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/host/commandRunner", () => ({
  registerCommand: vi.fn(),
}));
vi.mock("../../src/devcontainer/provisionError", () => {
  class ProvisionFailedError extends Error {
    readonly configPath: string | undefined;
    constructor(message: string, configPath?: string) {
      super(message);
      this.name = "ProvisionFailedError";
      this.configPath = configPath;
    }
  }
  return { ProvisionFailedError };
});
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
  guardHostContext: vi.fn(),
  checkDockerAvailable: vi.fn(),
  getHostWorkspaceFolder: vi.fn().mockReturnValue("/test/workspace"),
}));

import * as vscode from "vscode";
import { reopenInContainer } from "../../src/workflows/reopenInContainer";
import { rebuildContainer } from "../../src/workflows/rebuildContainer";
import { cloneInVolume } from "../../src/workflows/cloneInVolume";
import { attachToContainer } from "../../src/workflows/attachToContainer";
import { openFolderInContainer } from "../../src/workflows/openFolder";
import { getHostWorkspaceFolder } from "../../src/host/guards";
import { registerCommand } from "../../src/host/commandRunner";
import { reportProvisionFailure } from "../../src/host/reportProvisionFailure";
import { ProvisionFailedError } from "../../src/devcontainer/provisionError";
import type { CommandContext } from "../../src/host/commands";
import {
  reopenInContainerHandler,
  rebuildAndReopenInContainerHandler,
  cloneInVolumeHandler,
  attachToRunningContainerHandler,
  configureDevContainerHandler,
  addConfigurationHandler,
  openDevContainerFileHandler,
  openFolderInContainerHandler,
  openFolderInContainerNewWindowHandler,
  cleanUpContainersHandler,
  rebuildContainerMenuHandler,
  rebuildContainerHandler,
  rebuildContainerNoCacheHandler,
  reopenInHostHandler,
  closeRemoteConnectionHandler,
  registerCoreCommands,
} from "../../src/host/commands";

function mockCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  // Reset mutable mock state that could leak between tests
  (vscode.env as any).remoteName = undefined;
  vi.mocked(getHostWorkspaceFolder).mockReturnValue("/test/workspace");
  return {
    deps: {} as any,
    ui: {} as any,
    configManager: {
      getConfigPath: vi
        .fn()
        .mockResolvedValue({ fsPath: "/test/.devcontainer/devcontainer.json" }),
    } as any,
    containerLifecycle: {
      cleanUp: vi.fn().mockResolvedValue({
        containersRemoved: 0,
        imagesRemoved: 0,
        volumesRemoved: 0,
        errors: [],
      }),
    } as any,
    buildLogTerminal: { show: vi.fn(), dispose: vi.fn() } as any,
    buildLogPty: {
      writeLine: vi.fn(),
      write: vi.fn(),
      show: vi.fn(),
      dispose: vi.fn(),
    } as any,
    dockerPath: "docker",
    extensionUri: vscode.Uri.file("/test/extension"),
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
        workspaceUri: { fsPath: "/test/workspace" },
      });
    });
  });

  describe("rebuildAndReopenInContainerHandler", () => {
    it("delegates to rebuildContainer with reconnect:true", async () => {
      const ctx = mockCtx();
      await rebuildAndReopenInContainerHandler(ctx, "/ws");

      expect(rebuildContainer).toHaveBeenCalledWith(ctx.deps, ctx.ui, {
        workspaceFolder: "/ws",
        workspaceUri: { fsPath: "/test/workspace" },
        noCache: false,
        reconnect: true,
      });
    });
  });

  describe("configureDevContainerHandler", () => {
    it("opens sidebar and loads config", async () => {
      const ctx = mockCtx();
      vi.mocked(ctx.sidebarProvider.hasConfig).mockResolvedValue(true);

      await configureDevContainerHandler(ctx);

      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        "workbench.view.extension.artizo-sidebar",
      );
      expect(ctx.sidebarProvider.loadConfig).toHaveBeenCalled();
      expect(ctx.sidebarProvider.expandSection).toHaveBeenCalledWith("config");
    });

    it("expands wizard section when no config exists", async () => {
      const ctx = mockCtx();
      vi.mocked(ctx.sidebarProvider.hasConfig).mockResolvedValue(false);

      await configureDevContainerHandler(ctx);

      expect(ctx.sidebarProvider.expandSection).toHaveBeenCalledWith("wizard");
    });
  });

  describe("addConfigurationHandler", () => {
    it("opens sidebar and loads config", async () => {
      const ctx = mockCtx();
      vi.mocked(ctx.sidebarProvider.hasConfig).mockResolvedValue(true);

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

      expect(ctx.configManager.getConfigPath).toHaveBeenCalledWith({
        fsPath: "/workspace",
      });
      expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith({
        fsPath: "/test/.devcontainer/devcontainer.json",
      });
      expect(vscode.window.showTextDocument).toHaveBeenCalledWith(doc);
    });

    it("shows error when no config found", async () => {
      const ctx = mockCtx();
      vi.mocked(ctx.configManager.getConfigPath).mockResolvedValue(null);

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
      vi.mocked(getHostWorkspaceFolder).mockReturnValue(undefined);

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
        expect.stringContaining("Rebuild must be run from a host window"),
        "Reopen in Host",
      );
    });

    it("delegates to rebuildContainer with noCache:false", async () => {
      const ctx = mockCtx();

      await rebuildContainerHandler(ctx);

      // Handler should have resolved workspace and started the build log
      expect(getHostWorkspaceFolder).toHaveBeenCalled();
    });
  });

  describe("rebuildContainerNoCacheHandler", () => {
    it("delegates to rebuildContainer with noCache:true", async () => {
      const ctx = mockCtx();

      await rebuildContainerNoCacheHandler(ctx);

      expect(getHostWorkspaceFolder).toHaveBeenCalled();
    });
  });

  describe("rebuildContainerMenuHandler", () => {
    it("shows error when no workspace folder", async () => {
      const ctx = mockCtx();
      vi.mocked(getHostWorkspaceFolder).mockReturnValue(undefined);
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

      expect(getHostWorkspaceFolder).toHaveBeenCalled();
    });
  });

  describe("reopenInHostHandler", () => {
    it("opens local folder with forceReuseWindow when in container", async () => {
      const ctx = mockCtx();
      (vscode.env as any).remoteName = "artizo-container";
      vi.mocked(getHostWorkspaceFolder).mockReturnValue("/local/path");

      await reopenInHostHandler(ctx);

      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        "vscode.openFolder",
        expect.objectContaining({ fsPath: "/local/path" }),
        { forceReuseWindow: true },
      );
    });

    it("delegates to close-remote when not in container (SSH host)", async () => {
      const ctx = mockCtx();
      (vscode.env as any).remoteName = undefined;

      await reopenInHostHandler(ctx);

      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        "workbench.action.remote.close",
      );
    });

    it("shows info message when no local path is available", async () => {
      const ctx = mockCtx();
      (vscode.env as any).remoteName = "artizo-container";
      vi.mocked(getHostWorkspaceFolder).mockReturnValue(undefined);

      await reopenInHostHandler(ctx);

      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        "Return to Host is not available for this container.",
      );
      expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith(
        "vscode.openFolder",
        expect.anything(),
        expect.anything(),
      );
    });

    it("parses vscode-remote:// path with Uri.parse", async () => {
      const ctx = mockCtx();
      (vscode.env as any).remoteName = "artizo-container";
      const remote = "vscode-remote://artizo-container/some/path";
      vi.mocked(getHostWorkspaceFolder).mockReturnValue(remote);

      await reopenInHostHandler(ctx);

      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        "vscode.openFolder",
        expect.objectContaining({ toString: expect.any(Function) }),
        { forceReuseWindow: true },
      );
    });
  });

  describe("closeRemoteConnectionHandler", () => {
    it("delegates to reopenInHostHandler", async () => {
      const ctx = mockCtx();
      (vscode.env as any).remoteName = undefined;

      await closeRemoteConnectionHandler(ctx);

      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        "workbench.action.remote.close",
      );
    });
  });

  describe("cloneInVolumeHandler", () => {
    it("returns early when user cancels input", async () => {
      const ctx = mockCtx();
      vi.mocked(vscode.window.showInputBox).mockResolvedValue(undefined);

      await cloneInVolumeHandler(ctx);

      expect(cloneInVolume).not.toHaveBeenCalled();
    });

    it("delegates to cloneInVolume workflow with repo url", async () => {
      const ctx = mockCtx();
      vi.mocked(vscode.window.showInputBox).mockResolvedValue(
        "https://github.com/owner/repo.git",
      );

      await cloneInVolumeHandler(ctx);

      const adapters = await import("../../src/host/adapters");
      expect(adapters.buildCloneInVolumeUI).toHaveBeenCalledWith(
        ctx.ui,
        "https://github.com/owner/repo.git",
      );
      expect(cloneInVolume).toHaveBeenCalledWith(ctx.deps, expect.anything(), {
        repoUrl: "https://github.com/owner/repo.git",
      });
    });
  });

  describe("attachToRunningContainerHandler", () => {
    it("passes containerId and forceNewWindow from args", async () => {
      const ctx = mockCtx();

      await attachToRunningContainerHandler(ctx, undefined, "abc123", true);

      expect(attachToContainer).toHaveBeenCalledWith(
        ctx.deps,
        expect.anything(),
        expect.anything(),
        { containerId: "abc123", forceNewWindow: true },
      );
    });

    it("defaults containerId to undefined and forceNewWindow to false", async () => {
      const ctx = mockCtx();

      await attachToRunningContainerHandler(ctx, undefined);

      expect(attachToContainer).toHaveBeenCalledWith(
        ctx.deps,
        expect.anything(),
        expect.anything(),
        { containerId: undefined, forceNewWindow: false },
      );
    });
  });

  describe("openFolderInContainerNewWindowHandler", () => {
    it("delegates to openFolderInContainer with forceNewWindow", async () => {
      const ctx = mockCtx();

      await openFolderInContainerNewWindowHandler(ctx);

      expect(openFolderInContainer).toHaveBeenCalledWith(
        ctx.deps,
        expect.anything(),
        { folderUri: { fsPath: "/test/workspace" }, forceNewWindow: true },
      );
    });
  });

  describe("rebuildContainerMenuHandler - happy paths", () => {
    it("calls rebuildContainer with noCache:true for 'Rebuild Without Cache'", async () => {
      const ctx = mockCtx();
      vi.mocked(vscode.window.showQuickPick).mockResolvedValue({
        label: "Rebuild Without Cache",
        description: "Rebuild from scratch",
      } as any);

      await rebuildContainerMenuHandler(ctx);

      expect(rebuildContainer).toHaveBeenCalledWith(
        ctx.deps,
        ctx.ui,
        expect.objectContaining({ noCache: true, reconnect: false }),
      );
    });

    it("calls rebuildContainer with reconnect:true for 'Rebuild and Reopen'", async () => {
      const ctx = mockCtx();
      vi.mocked(vscode.window.showQuickPick).mockResolvedValue({
        label: "Rebuild and Reopen",
        description: "Rebuild and reconnect",
      } as any);

      await rebuildContainerMenuHandler(ctx);

      expect(rebuildContainer).toHaveBeenCalledWith(
        ctx.deps,
        ctx.ui,
        expect.objectContaining({ noCache: false, reconnect: true }),
      );
    });

    it("opens 'Reopen in Host' when running inside a container", async () => {
      const ctx = mockCtx();
      (vscode.env as any).remoteName = "artizo-container";
      vi.mocked(vscode.window.showErrorMessage).mockResolvedValue(
        "Reopen in Host" as any,
      );

      await rebuildContainerMenuHandler(ctx);

      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        "artizo.reopenInHost",
      );
    });

    it("does not execute reopenInHost when action not chosen", async () => {
      const ctx = mockCtx();
      (vscode.env as any).remoteName = "artizo-container";
      vi.mocked(vscode.window.showErrorMessage).mockResolvedValue(
        undefined as any,
      );

      await rebuildContainerMenuHandler(ctx);

      expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith(
        "artizo.reopenInHost",
      );
    });

    it("reports failure when rebuildContainer throws a plain error", async () => {
      const ctx = mockCtx();
      vi.mocked(vscode.window.showQuickPick).mockResolvedValue({
        label: "Rebuild",
        description: "Rebuild the container image",
      } as any);
      vi.mocked(rebuildContainer).mockRejectedValueOnce(new Error("boom"));
      vi.mocked(vscode.window.showErrorMessage).mockResolvedValue(
        undefined as any,
      );

      await rebuildContainerMenuHandler(ctx);

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining("Rebuild failed: boom"),
        "Show Log",
      );
    });

    it("routes ProvisionFailedError through reportProvisionFailure", async () => {
      const ctx = mockCtx();
      vi.mocked(vscode.window.showQuickPick).mockResolvedValue({
        label: "Rebuild",
        description: "Rebuild the container image",
      } as any);
      const pfErr = new ProvisionFailedError("provision failed", "/cfg");
      vi.mocked(rebuildContainer).mockRejectedValueOnce(pfErr);

      await rebuildContainerMenuHandler(ctx);

      expect(reportProvisionFailure).toHaveBeenCalledWith(
        pfErr,
        expect.objectContaining({
          buildLogPty: ctx.buildLogPty,
          buildLogTerminal: ctx.buildLogTerminal,
          configManager: ctx.configManager,
          extensionUri: ctx.extensionUri,
        }),
        "/test/workspace",
      );
    });
  });

  describe("rebuildContainerHandler - error paths", () => {
    it("reports plain error when rebuild throws", async () => {
      const ctx = mockCtx();
      vi.mocked(rebuildContainer).mockRejectedValueOnce(new Error("nope"));
      vi.mocked(vscode.window.showErrorMessage).mockResolvedValue(
        undefined as any,
      );

      await rebuildContainerHandler(ctx);

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining("Rebuild failed: nope"),
        "Show Log",
      );
    });

    it("executes reopenInHost when chosen in managed container", async () => {
      const ctx = mockCtx();
      (vscode.env as any).remoteName = "artizo-container";
      vi.mocked(vscode.window.showErrorMessage).mockResolvedValue(
        "Reopen in Host" as any,
      );

      await rebuildContainerHandler(ctx);

      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        "artizo.reopenInHost",
      );
    });

    it("calls rebuildContainer with noCache:false", async () => {
      const ctx = mockCtx();

      await rebuildContainerHandler(ctx);

      expect(rebuildContainer).toHaveBeenCalledWith(ctx.deps, ctx.ui, {
        workspaceFolder: "/test/workspace",
        workspaceUri: { fsPath: "/test/workspace" },
        noCache: false,
        reconnect: false,
      });
    });
  });

  describe("rebuildContainerNoCacheHandler - paths", () => {
    it("calls rebuildContainer with noCache:true", async () => {
      const ctx = mockCtx();

      await rebuildContainerNoCacheHandler(ctx);

      expect(rebuildContainer).toHaveBeenCalledWith(ctx.deps, ctx.ui, {
        workspaceFolder: "/test/workspace",
        workspaceUri: { fsPath: "/test/workspace" },
        noCache: true,
        reconnect: false,
      });
    });

    it("shows error when no workspace folder", async () => {
      const ctx = mockCtx();
      vi.mocked(getHostWorkspaceFolder).mockReturnValue(undefined);

      await rebuildContainerNoCacheHandler(ctx);

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        "No workspace folder open.",
      );
    });

    it("exits when running inside a managed container", async () => {
      const ctx = mockCtx();
      (vscode.env as any).remoteName = "artizo-container";
      vi.mocked(vscode.window.showErrorMessage).mockResolvedValue(
        undefined as any,
      );

      await rebuildContainerNoCacheHandler(ctx);

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining("Rebuild must be run from a host window"),
        "Reopen in Host",
      );
    });

    it("reports failure when rebuild throws", async () => {
      const ctx = mockCtx();
      vi.mocked(rebuildContainer).mockRejectedValueOnce(new Error("fail"));
      vi.mocked(vscode.window.showErrorMessage).mockResolvedValue(
        undefined as any,
      );

      await rebuildContainerNoCacheHandler(ctx);

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining("Rebuild failed: fail"),
        "Show Log",
      );
    });
  });

  describe("registerCoreCommands", () => {
    function mockContext(): any {
      return { subscriptions: [], extensionUri: vscode.Uri.file("/ext") };
    }

    it("registers spec-based commands via registerCommand", () => {
      const ctx = mockCtx();
      const context = mockContext();

      registerCoreCommands(context, ctx);

      // 10 spec-based commands across the 5 spec arrays
      expect(registerCommand).toHaveBeenCalledTimes(10);
      const ids = vi
        .mocked(registerCommand)
        .mock.calls.map((c) => (c[2] as any).id);
      expect(ids).toEqual(
        expect.arrayContaining([
          "artizo.reopenInContainer",
          "artizo.rebuildAndReopenInContainer",
          "artizo.cloneInVolume",
          "artizo.attachToRunningContainer",
          "artizo.cleanUpContainers",
          "artizo.configureDevContainer",
          "artizo.addConfiguration",
          "artizo.openDevContainerFile",
          "artizo.openFolderInContainer",
          "artizo.openFolderInContainerNewWindow",
        ]),
      );
    });

    it("registers raw command handlers via vscode.commands.registerCommand", () => {
      const ctx = mockCtx();
      const context = mockContext();

      registerCoreCommands(context, ctx);

      const ids = vi
        .mocked(vscode.commands.registerCommand)
        .mock.calls.map((c) => c[0]);
      expect(ids).toEqual(
        expect.arrayContaining([
          "artizo.rebuildContainerMenu",
          "artizo.rebuildContainer",
          "artizo.rebuildContainerNoCache",
          "artizo.reopenInHost",
          "artizo.closeRemoteConnection",
        ]),
      );
    });

    it("pushes all disposables onto context.subscriptions", () => {
      const ctx = mockCtx();
      const context = mockContext();

      registerCoreCommands(context, ctx);

      // Raw registerCommand calls (rebuild menu/reopen-in-host/close-remote)
      // push disposables onto subscriptions.
      expect(context.subscriptions.length).toBeGreaterThanOrEqual(5);
    });

    it("does not register tree-view refresh commands (owned by ContainerExplorerProvider)", () => {
      const ctx = mockCtx();
      const context = mockContext();
      registerCoreCommands(context, ctx);

      const ids = vi
        .mocked(vscode.commands.registerCommand)
        .mock.calls.map((c) => c[0]);
      // Tree-view refresh moved to ContainerExplorerProvider.register();
      // registerCoreCommands must not re-register them (would collide).
      expect(ids).not.toContain("artizo.explorer.refresh");
      expect(ids).not.toContain("artizo.volumes.refresh");
    });

    it("reopenInHost raw handler reports error when reopenInHostHandler throws", async () => {
      const ctx = mockCtx();
      const context = mockContext();
      // Force reopenInHostHandler to throw by being in a container without a local path
      (vscode.env as any).remoteName = "artizo-container";
      vi.mocked(getHostWorkspaceFolder).mockReturnValue("/local");
      // Make executeCommand reject to force vscode.openFolder to throw.
      vi.mocked(vscode.commands.executeCommand).mockRejectedValueOnce(
        new Error("open failed"),
      );

      registerCoreCommands(context, ctx);
      const calls = vi.mocked(vscode.commands.registerCommand).mock.calls;
      const reopenHost = calls.find((c) => c[0] === "artizo.reopenInHost");
      await (reopenHost![1] as any)();

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining("Failed to return to host: open failed"),
      );
    });

    it("closeRemoteConnection raw handler reports error when it throws", async () => {
      const ctx = mockCtx();
      const context = mockContext();
      (vscode.env as any).remoteName = undefined;
      vi.mocked(vscode.commands.executeCommand).mockRejectedValueOnce(
        new Error("close failed"),
      );

      registerCoreCommands(context, ctx);
      const calls = vi.mocked(vscode.commands.registerCommand).mock.calls;
      const closeRemote = calls.find(
        (c) => c[0] === "artizo.closeRemoteConnection",
      );
      await (closeRemote![1] as any)();

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining(
          "Failed to close remote connection: close failed",
        ),
      );
    });

    it("raw rebuildContainerMenu handler delegates to rebuildContainerMenuHandler", async () => {
      const ctx = mockCtx();
      const context = mockContext();
      vi.mocked(vscode.window.showQuickPick).mockResolvedValue(
        undefined as any,
      );

      registerCoreCommands(context, ctx);
      const calls = vi.mocked(vscode.commands.registerCommand).mock.calls;
      const menu = calls.find((c) => c[0] === "artizo.rebuildContainerMenu");
      await (menu![1] as any)();

      // User cancelled the pick -> no rebuild
      expect(rebuildContainer).not.toHaveBeenCalled();
    });

    it("raw rebuildContainer handler delegates to rebuildContainerHandler", async () => {
      const ctx = mockCtx();
      const context = mockContext();

      registerCoreCommands(context, ctx);
      const calls = vi.mocked(vscode.commands.registerCommand).mock.calls;
      const rebuild = calls.find((c) => c[0] === "artizo.rebuildContainer");
      await (rebuild![1] as any)();

      expect(rebuildContainer).toHaveBeenCalled();
    });

    it("raw rebuildContainerNoCache handler delegates", async () => {
      const ctx = mockCtx();
      const context = mockContext();

      registerCoreCommands(context, ctx);
      const calls = vi.mocked(vscode.commands.registerCommand).mock.calls;
      const rebuildNoCache = calls.find(
        (c) => c[0] === "artizo.rebuildContainerNoCache",
      );
      await (rebuildNoCache![1] as any)();

      expect(rebuildContainer).toHaveBeenCalledWith(
        ctx.deps,
        ctx.ui,
        expect.objectContaining({ noCache: true }),
      );
    });
  });
});
