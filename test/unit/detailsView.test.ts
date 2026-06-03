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
    window: {
      createTreeView: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    },
  };
});

import * as vscode from "vscode";
import {
  DetailsViewProvider,
  DetailCategoryItem,
  DetailValueItem,
} from "../../src/views/detailsView";
import type { ContainerInfo } from "../../src/utils/dockerUtils";

function createContainerInfo(
  overrides: Partial<ContainerInfo> = {},
): ContainerInfo {
  return {
    id: "abc123def456789012345678",
    name: "my-devcontainer",
    state: {
      status: "running",
      running: true,
      pid: 1234,
    },
    config: {
      image: "node:18",
      labels: { "devcontainer.local_folder": "/home/user/project" },
      env: ["NODE_ENV=development", "PATH=/usr/bin"],
      workingDir: "/workspace",
    },
    mounts: [
      {
        type: "bind",
        source: "/home/user/project",
        destination: "/workspace",
        mode: "rw",
      },
    ],
    networkSettings: {
      ports: {
        "3000/tcp": [{ hostIp: "0.0.0.0", hostPort: "3000" }],
        "5432/tcp": null,
      },
    },
    ...overrides,
  };
}

describe("DetailsViewProvider", () => {
  let provider: DetailsViewProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new DetailsViewProvider();
  });

  describe("getChildren (no container info)", () => {
    it("returns empty array when no container info is set", () => {
      const children = provider.getChildren();
      expect(children).toHaveLength(0);
    });
  });

  describe("getChildren (with container info)", () => {
    it("returns root entries with image, container ID, status, mounts, ports, env, labels", () => {
      provider.setContainerInfo(createContainerInfo());

      const children = provider.getChildren();

      // Image, Container ID, Status, Mounts, Ports, Environment, Labels
      expect(children.length).toBeGreaterThanOrEqual(5);
    });

    it("shows image as a value item", () => {
      provider.setContainerInfo(
        createContainerInfo({
          config: {
            image: "ubuntu:22.04",
            labels: {},
            env: [],
            workingDir: "/",
          },
        }),
      );

      const children = provider.getChildren();
      const imageItem = children.find((c) => c.label === "Image");

      expect(imageItem).toBeDefined();
      expect(imageItem).toBeInstanceOf(DetailValueItem);
      expect(imageItem!.description).toBe("ubuntu:22.04");
    });

    it("shows container ID (truncated to 12 chars)", () => {
      provider.setContainerInfo(
        createContainerInfo({ id: "abcdef123456789full" }),
      );

      const children = provider.getChildren();
      const idItem = children.find((c) => c.label === "Container ID");

      expect(idItem).toBeDefined();
      expect(idItem!.description).toBe("abcdef123456");
    });

    it("shows status with running icon", () => {
      provider.setContainerInfo(createContainerInfo());

      const children = provider.getChildren();
      const statusItem = children.find((c) => c.label === "Status");

      expect(statusItem).toBeDefined();
      expect(statusItem!.description).toBe("running");
    });

    it("shows mounts as a category with children", () => {
      provider.setContainerInfo(createContainerInfo());

      const children = provider.getChildren();
      const mountsItem = children.find((c) => c.label === "Mounts");

      expect(mountsItem).toBeDefined();
      expect(mountsItem).toBeInstanceOf(DetailCategoryItem);

      // Get mount children
      const mountChildren = provider.getChildren(mountsItem as any);
      expect(mountChildren).toHaveLength(1);
      expect(mountChildren[0].label).toBe("/home/user/project → /workspace");
    });

    it("shows ports as a category with children", () => {
      provider.setContainerInfo(createContainerInfo());

      const children = provider.getChildren();
      const portsItem = children.find((c) => c.label === "Ports");

      expect(portsItem).toBeDefined();
      expect(portsItem).toBeInstanceOf(DetailCategoryItem);

      const portChildren = provider.getChildren(portsItem as any);
      // One bound port + one unbound port
      expect(portChildren).toHaveLength(2);
    });

    it("shows environment variables as a category", () => {
      provider.setContainerInfo(createContainerInfo());

      const children = provider.getChildren();
      const envItem = children.find((c) => c.label === "Environment");

      expect(envItem).toBeDefined();
      expect(envItem).toBeInstanceOf(DetailCategoryItem);

      const envChildren = provider.getChildren(envItem as any);
      expect(envChildren).toHaveLength(2);
      expect(envChildren[0].label).toBe("NODE_ENV");
      expect(envChildren[0].description).toBe("development");
    });

    it("shows labels as a category", () => {
      provider.setContainerInfo(createContainerInfo());

      const children = provider.getChildren();
      const labelsItem = children.find((c) => c.label === "Labels");

      expect(labelsItem).toBeDefined();
      expect(labelsItem).toBeInstanceOf(DetailCategoryItem);

      const labelChildren = provider.getChildren(labelsItem as any);
      expect(labelChildren).toHaveLength(1);
      expect(labelChildren[0].label).toBe("devcontainer.local_folder");
      expect(labelChildren[0].description).toBe("/home/user/project");
    });

    it("omits mounts category when no mounts", () => {
      provider.setContainerInfo(createContainerInfo({ mounts: [] }));

      const children = provider.getChildren();
      const mountsItem = children.find((c) => c.label === "Mounts");

      expect(mountsItem).toBeUndefined();
    });

    it("omits environment category when no env vars", () => {
      provider.setContainerInfo(
        createContainerInfo({
          config: { image: "node:18", labels: {}, env: [], workingDir: "/" },
        }),
      );

      const children = provider.getChildren();
      const envItem = children.find((c) => c.label === "Environment");

      expect(envItem).toBeUndefined();
    });

    it("omits labels category when no labels", () => {
      provider.setContainerInfo(
        createContainerInfo({
          config: {
            image: "node:18",
            labels: {},
            env: ["A=1"],
            workingDir: "/",
          },
        }),
      );

      const children = provider.getChildren();
      const labelsItem = children.find((c) => c.label === "Labels");

      expect(labelsItem).toBeUndefined();
    });
  });

  describe("setContainerInfo", () => {
    it("fires onDidChangeTreeData when container info is set", () => {
      const emitter = (provider as any)._onDidChangeTreeData;

      provider.setContainerInfo(createContainerInfo());

      expect(emitter.fire).toHaveBeenCalled();
    });

    it("fires onDidChangeTreeData when container info is cleared", () => {
      provider.setContainerInfo(createContainerInfo());
      const emitter = (provider as any)._onDidChangeTreeData;

      provider.setContainerInfo(null);

      expect(emitter.fire).toHaveBeenCalledTimes(2);
    });
  });

  describe("refresh", () => {
    it("fires onDidChangeTreeData event", () => {
      const emitter = (provider as any)._onDidChangeTreeData;
      provider.refresh();
      expect(emitter.fire).toHaveBeenCalled();
    });
  });

  describe("register", () => {
    it("creates a tree view with the correct id", () => {
      const context = {
        subscriptions: [] as vscode.Disposable[],
      } as unknown as vscode.ExtensionContext;

      DetailsViewProvider.register(context);

      expect(vscode.window.createTreeView).toHaveBeenCalledWith(
        "artizo.detailsView",
        {
          treeDataProvider: expect.any(DetailsViewProvider),
          showCollapseAll: true,
        },
      );
    });

    it("pushes tree view disposable to context subscriptions", () => {
      const context = {
        subscriptions: [] as vscode.Disposable[],
      } as unknown as vscode.ExtensionContext;

      DetailsViewProvider.register(context);

      expect(context.subscriptions.length).toBeGreaterThanOrEqual(1);
    });
  });
});
