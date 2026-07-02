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
    TreeItem: class {
      label: string;
      collapsibleState: number;
      description?: string;
      tooltip?: string;
      contextValue?: string;
      iconPath?: unknown;
      constructor(label: string, collapsibleState: number) {
        this.label = label;
        this.collapsibleState = collapsibleState;
      }
    },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ThemeIcon: class {
      id: string;
      constructor(id: string) {
        this.id = id;
      }
    },
    EventEmitter,
    Uri: {
      parse: vi.fn().mockImplementation((str: string) => ({
        toString: () => str,
        fsPath: str,
      })),
    },
    window: {
      createTreeView: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    },
    commands: {
      registerCommand: vi.fn().mockReturnValue({ dispose: vi.fn() }),
      executeCommand: vi.fn().mockResolvedValue(undefined),
    },
  };
});

// Mock node:child_process
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

// Mock execPolicy
vi.mock("../../src/docker/execPolicy.js", () => ({
  configureDockerPath: vi.fn(),
  dockerExecPolicy: vi.fn(),
}));

import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { dockerExecPolicy } from "../../src/docker/execPolicy.js";
import { ContainerExplorerProvider } from "../../src/views/containerExplorer";
import {
  CategoryTreeItem,
  ContainerTreeItem,
  RecentFolderTreeItem,
  VolumeTreeItem,
} from "../../src/views/treeItems";

function createMockGlobalState(
  data: Record<string, unknown> = {},
): vscode.Memento {
  const store = { ...data };
  return {
    get<T>(key: string, defaultValue?: T): T {
      return (store[key] as T) ?? (defaultValue as T);
    },
    update: vi.fn().mockImplementation((key: string, value: unknown) => {
      (store as any)[key] = value;
      return Promise.resolve();
    }),
    keys: () => Object.keys(store),
    setKeysForSync: vi.fn(),
  } as unknown as vscode.Memento;
}

function mockExecFileSuccess(stdout: string) {
  vi.mocked(dockerExecPolicy).mockResolvedValue({
    exitCode: 0,
    stdout,
    stderr: "",
  });
}

function mockExecFileError(exitCode: number, stderr: string) {
  vi.mocked(dockerExecPolicy).mockResolvedValue({
    exitCode,
    stdout: "",
    stderr,
  });
}

describe("ContainerExplorerProvider", () => {
  let provider: ContainerExplorerProvider;
  let globalState: vscode.Memento;

  beforeEach(() => {
    vi.clearAllMocks();
    globalState = createMockGlobalState();
    provider = new ContainerExplorerProvider({
      globalState,
    });
  });

  describe("getChildren (root)", () => {
    it("returns three category items at root level", async () => {
      const children = await provider.getChildren();

      expect(children).toHaveLength(3);
      expect(children[0]).toBeInstanceOf(CategoryTreeItem);
      expect(children[1]).toBeInstanceOf(CategoryTreeItem);
      expect(children[2]).toBeInstanceOf(CategoryTreeItem);
    });

    it("returns categories in correct order: containers, recent-folders, volumes", async () => {
      const children = (await provider.getChildren()) as CategoryTreeItem[];

      expect(children[0].category).toBe("containers");
      expect(children[1].category).toBe("recent-folders");
      expect(children[2].category).toBe("volumes");
    });
  });

  describe("getChildren (containers category)", () => {
    it("returns running containers from docker ps", async () => {
      const dockerOutput = [
        JSON.stringify({
          ID: "abc123def456",
          Names: "my-devcontainer",
          State: "running",
          Labels: "devcontainer.local_folder=/home/user/project",
        }),
        JSON.stringify({
          ID: "xyz789",
          Names: "another-container",
          State: "running",
          Labels: "artizo.local_folder=/other/path",
        }),
      ].join("\n");

      mockExecFileSuccess(dockerOutput);

      const category = new CategoryTreeItem("Dev Containers", "containers");
      const children = await provider.getChildren(category);

      expect(children).toHaveLength(2);
      expect(children[0]).toBeInstanceOf(ContainerTreeItem);
      expect((children[0] as ContainerTreeItem).target.label).toBe(
        "my-devcontainer",
      );
      expect((children[0] as ContainerTreeItem).target.containerId).toBe(
        "abc123def456",
      );
      expect((children[0] as ContainerTreeItem).target.status).toBe("running");
    });

    it("returns empty array when docker ps fails", async () => {
      mockExecFileError(1, "docker not found");

      const category = new CategoryTreeItem("Dev Containers", "containers");
      const children = await provider.getChildren(category);

      expect(children).toHaveLength(0);
    });

    it("returns empty array when no containers match", async () => {
      mockExecFileSuccess("");

      const category = new CategoryTreeItem("Dev Containers", "containers");
      const children = await provider.getChildren(category);

      expect(children).toHaveLength(0);
    });
  });

  describe("getChildren (recent-folders category)", () => {
    it("returns recent folders from globalState", async () => {
      globalState = createMockGlobalState({
        "artizo.recentFolders": ["/home/user/project1", "/home/user/project2"],
      });
      provider = new ContainerExplorerProvider({
        globalState,
      });

      mockExecFileSuccess("");

      const category = new CategoryTreeItem("Recent Folders", "recent-folders");
      const children = await provider.getChildren(category);

      expect(children).toHaveLength(2);
      expect(children[0]).toBeInstanceOf(RecentFolderTreeItem);
      expect((children[0] as RecentFolderTreeItem).target.label).toBe(
        "project1",
      );
      expect((children[0] as RecentFolderTreeItem).target.workspacePath).toBe(
        "/home/user/project1",
      );
    });

    it("returns empty array when no recent folders", async () => {
      const category = new CategoryTreeItem("Recent Folders", "recent-folders");
      const children = await provider.getChildren(category);

      expect(children).toHaveLength(0);
    });
  });

  describe("getChildren (volumes category)", () => {
    it("returns volumes from docker volume ls", async () => {
      const dockerOutput = [
        JSON.stringify({ Name: "my-volume", Driver: "local" }),
        JSON.stringify({ Name: "data-vol", Driver: "local" }),
      ].join("\n");

      mockExecFileSuccess(dockerOutput);

      const category = new CategoryTreeItem("Volumes", "volumes");
      const children = await provider.getChildren(category);

      expect(children).toHaveLength(2);
      expect(children[0]).toBeInstanceOf(VolumeTreeItem);
      expect((children[0] as VolumeTreeItem).target.label).toBe("my-volume");
      expect((children[0] as VolumeTreeItem).target.volumeName).toBe(
        "my-volume",
      );
    });

    it("returns empty array when docker volume ls fails", async () => {
      mockExecFileError(1, "error");

      const category = new CategoryTreeItem("Volumes", "volumes");
      const children = await provider.getChildren(category);

      expect(children).toHaveLength(0);
    });
  });

  describe("getChildren (leaf items)", () => {
    it("returns empty array for ContainerTreeItem", async () => {
      const item = new ContainerTreeItem({
        type: "running-container",
        label: "test",
        containerId: "abc",
        status: "running",
      });
      const children = await provider.getChildren(item as any);

      expect(children).toHaveLength(0);
    });
  });

  describe("refresh", () => {
    it("fires onDidChangeTreeData event", () => {
      const emitter = (provider as any)._onDidChangeTreeData;
      provider.refresh();
      expect(emitter.fire).toHaveBeenCalled();
    });
  });

  describe("addRecentFolder", () => {
    it("adds folder to the front of the list", async () => {
      globalState = createMockGlobalState({
        "artizo.recentFolders": ["/existing/folder"],
      });
      provider = new ContainerExplorerProvider({
        globalState,
      });

      await provider.addRecentFolder("/new/folder");

      expect(globalState.update).toHaveBeenCalledWith("artizo.recentFolders", [
        "/new/folder",
        "/existing/folder",
      ]);
    });

    it("deduplicates existing folder by moving it to front", async () => {
      globalState = createMockGlobalState({
        "artizo.recentFolders": ["/first", "/second", "/third"],
      });
      provider = new ContainerExplorerProvider({
        globalState,
      });

      await provider.addRecentFolder("/second");

      expect(globalState.update).toHaveBeenCalledWith("artizo.recentFolders", [
        "/second",
        "/first",
        "/third",
      ]);
    });

    it("limits list to 20 entries", async () => {
      const folders = Array.from({ length: 20 }, (_, i) => `/folder${i}`);
      globalState = createMockGlobalState({
        "artizo.recentFolders": folders,
      });
      provider = new ContainerExplorerProvider({
        globalState,
      });

      await provider.addRecentFolder("/new-folder");

      const updateCall = vi.mocked(globalState.update).mock.calls[0];
      expect((updateCall[1] as string[]).length).toBe(20);
      expect((updateCall[1] as string[])[0]).toBe("/new-folder");
    });
  });

  describe("removeRecentFolder", () => {
    it("removes folder from the list", async () => {
      globalState = createMockGlobalState({
        "artizo.recentFolders": ["/first", "/second", "/third"],
      });
      provider = new ContainerExplorerProvider({
        globalState,
      });

      await provider.removeRecentFolder("/second");

      expect(globalState.update).toHaveBeenCalledWith("artizo.recentFolders", [
        "/first",
        "/third",
      ]);
    });
  });

  describe("getTargets", () => {
    it("returns combined targets from all categories", async () => {
      const dockerOutput = JSON.stringify({
        ID: "abc123",
        Names: "container1",
        State: "running",
        Labels: "devcontainer.local_folder=/home/user/project",
      });
      // First call is for containers (docker ps), second for volumes (docker volume ls)
      let callCount = 0;
      vi.mocked(execFile).mockImplementation(
        (_cmd: any, args: any, callback: any) => {
          callCount++;
          if (Array.isArray(args) && args.includes("volume")) {
            callback(
              null,
              JSON.stringify({ Name: "vol1", Driver: "local" }),
              "",
            );
          } else {
            callback(null, dockerOutput, "");
          }
          return {} as any;
        },
      );

      globalState = createMockGlobalState({
        "artizo.recentFolders": ["/home/user/project"],
      });
      provider = new ContainerExplorerProvider({
        globalState,
      });

      const targets = await provider.getTargets();

      expect(targets.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("register", () => {
    it("creates a tree view with the correct id", () => {
      const context = {
        subscriptions: [] as vscode.Disposable[],
        globalState: createMockGlobalState(),
      } as unknown as vscode.ExtensionContext;

      ContainerExplorerProvider.register(context);

      expect(vscode.window.createTreeView).toHaveBeenCalledWith(
        "artizo.explorer",
        {
          treeDataProvider: expect.any(ContainerExplorerProvider),
          showCollapseAll: true,
        },
      );
    });

    it("registers refresh, connectCurrentWindow, and connectNewWindow commands", () => {
      const context = {
        subscriptions: [] as vscode.Disposable[],
        globalState: createMockGlobalState(),
      } as unknown as vscode.ExtensionContext;

      ContainerExplorerProvider.register(context);

      const registeredCommands = vi
        .mocked(vscode.commands.registerCommand)
        .mock.calls.map((call) => call[0]);
      expect(registeredCommands).toContain("artizo.explorer.refresh");
      expect(registeredCommands).toContain(
        "artizo.explorer.connectCurrentWindow",
      );
      expect(registeredCommands).toContain("artizo.explorer.connectNewWindow");
    });

    it("pushes disposables to context subscriptions", () => {
      const context = {
        subscriptions: [] as vscode.Disposable[],
        globalState: createMockGlobalState(),
      } as unknown as vscode.ExtensionContext;

      ContainerExplorerProvider.register(context);

      expect(context.subscriptions.length).toBeGreaterThanOrEqual(4);
    });
  });
});
