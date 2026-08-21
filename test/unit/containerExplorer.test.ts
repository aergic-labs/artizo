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
import { dockerExecPolicy } from "../../src/docker/execPolicy.js";
import { ContainerExplorerProvider } from "../../src/views/containerExplorer";
import {
  CategoryTreeItem,
  ContainerTreeItem,
  RecentFolderGroupTreeItem,
  RecentFolderTreeItem,
  VolumeTreeItem,
} from "../../src/views/treeItems";
import {
  FolderDescriptor,
  FolderHistoryManager,
} from "../../src/remote/folderHistory";

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
  let history: FolderHistoryManager;

  function makeHistory(data: Record<string, string[]> = {}): FolderHistoryManager {
    const globalState = createMockGlobalState({
      "artizo.folderHistory.v1": data,
    });
    return new FolderHistoryManager({ state: globalState, keyPrefix: "artizo" });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    history = makeHistory();
    provider = new ContainerExplorerProvider({ history });
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
    it("returns one group per container authority", async () => {
      history = makeHistory({
        "artizo-container+2f686f6d652f757365722f70726f6a65637431": ["/home/user/project1"],
        "attached-container+616263": ["/app"],
      });
      provider = new ContainerExplorerProvider({ history });

      mockExecFileSuccess("");

      const category = new CategoryTreeItem("Recent Folders", "recent-folders");
      const children = await provider.getChildren(category);

      expect(children).toHaveLength(2);
      expect(children[0]).toBeInstanceOf(RecentFolderGroupTreeItem);
      expect(children[1]).toBeInstanceOf(RecentFolderGroupTreeItem);
    });

    it("returns empty array when no recent folders", async () => {
      const category = new CategoryTreeItem("Recent Folders", "recent-folders");
      const children = await provider.getChildren(category);

      expect(children).toHaveLength(0);
    });

    it("lists folders under a group", async () => {
      const remote = "artizo-container+2f686f6d652f757365722f70726f6a65637431";
      history = makeHistory({
        [remote]: ["/home/user/project1", "/home/user/project2"],
      });
      provider = new ContainerExplorerProvider({ history });

      const group = new RecentFolderGroupTreeItem(remote, "label");
      const children = await provider.getChildren(group);

      expect(children).toHaveLength(2);
      expect(children[0]).toBeInstanceOf(RecentFolderTreeItem);
      const folder = children[0] as RecentFolderTreeItem;
      expect(folder.descriptor.remote).toBe(remote);
      expect(folder.descriptor.folder).toBe("/home/user/project1");
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

  describe("forgetFolder (via history.removeFolder)", () => {
    it("removes a folder from the history", async () => {
      const remote = "artizo-container+2f686f6d652f757365722f70726f6a65637431";
      history = makeHistory({
        [remote]: ["/first", "/second", "/third"],
      });
      provider = new ContainerExplorerProvider({ history });

      await history.removeFolder(new FolderDescriptor(remote, "/second"));

      expect(history.getFolders(remote).map((f) => f.folder)).toEqual([
        "/first",
        "/third",
      ]);
    });

    it("prunes a remote when its last folder is forgotten", async () => {
      const remote = "artizo-container+2f686f6d652f757365722f70726f6a65637431";
      history = makeHistory({ [remote]: ["/only"] });
      provider = new ContainerExplorerProvider({ history });

      await history.removeFolder(new FolderDescriptor(remote, "/only"));

      expect(history.getRemotes()).toEqual([]);
    });
  });

  describe("getTargets", () => {
    it("returns combined targets from containers + volumes", async () => {
      const dockerOutput = JSON.stringify({
        ID: "abc123",
        Names: "container1",
        State: "running",
        Labels: "devcontainer.local_folder=/home/user/project",
      });
      const volumeOutput = JSON.stringify({
        Name: "vol1", Driver: "local" });
      vi.mocked(dockerExecPolicy).mockImplementation((_args: any) => {
        if (Array.isArray(_args) && _args.includes("volume")) {
          return Promise.resolve({ exitCode: 0, stdout: volumeOutput, stderr: "" });
        }
        return Promise.resolve({ exitCode: 0, stdout: dockerOutput, stderr: "" });
      });

      history = makeHistory();
      provider = new ContainerExplorerProvider({ history });

      const targets = await provider.getTargets();

      expect(targets.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("register", () => {
    let history: FolderHistoryManager;
    beforeEach(() => {
      history = makeHistory();
    });

    it("creates a tree view with the correct id", () => {
      const context = {
        subscriptions: [] as vscode.Disposable[],
        globalState: createMockGlobalState(),
      } as unknown as vscode.ExtensionContext;

      ContainerExplorerProvider.register(context, history);

      expect(vscode.window.createTreeView).toHaveBeenCalledWith(
        "artizo.explorer",
        {
          treeDataProvider: expect.any(ContainerExplorerProvider),
          showCollapseAll: true,
        },
      );
    });

    it("registers refresh, connectCurrentWindow, connectNewWindow, and forgetFolder commands", () => {
      const context = {
        subscriptions: [] as vscode.Disposable[],
        globalState: createMockGlobalState(),
      } as unknown as vscode.ExtensionContext;

      ContainerExplorerProvider.register(context, history);

      const registeredCommands = vi
        .mocked(vscode.commands.registerCommand)
        .mock.calls.map((call) => call[0]);
      expect(registeredCommands).toContain("artizo.explorer.refresh");
      expect(registeredCommands).toContain(
        "artizo.explorer.connectCurrentWindow",
      );
      expect(registeredCommands).toContain("artizo.explorer.connectNewWindow");
      expect(registeredCommands).toContain("artizo.explorer.forgetFolder");
    });

    it("pushes disposables to context subscriptions", () => {
      const context = {
        subscriptions: [] as vscode.Disposable[],
        globalState: createMockGlobalState(),
      } as unknown as vscode.ExtensionContext;

      ContainerExplorerProvider.register(context, history);

      expect(context.subscriptions.length).toBeGreaterThanOrEqual(4);
    });
  });
});
