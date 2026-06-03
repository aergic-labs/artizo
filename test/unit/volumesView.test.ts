/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock vscode module
vi.mock("vscode", () => {
  const EventEmitter = vi.fn().mockImplementation(() => ({
    event: vi.fn(),
    fire: vi.fn(),
    dispose: vi.fn(),
  }));

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
      showErrorMessage: vi.fn().mockResolvedValue(undefined),
      showWarningMessage: vi.fn().mockResolvedValue(undefined),
      showInformationMessage: vi.fn().mockResolvedValue(undefined),
      showTextDocument: vi.fn().mockResolvedValue(undefined),
    },
    workspace: {
      openTextDocument: vi.fn().mockResolvedValue({ uri: "mock-doc" }),
    },
    commands: {
      registerCommand: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    },
  };
});

// Mock node:child_process
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

// Mock execPolicy; delegates to the mocked execFile
vi.mock("../../src/docker/execPolicy.js", () => ({
  configureDockerPath: vi.fn(),
  dockerExecPolicy: vi.fn(),
}));

import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { dockerExecPolicy } from "../../src/docker/execPolicy.js";
import {
  VolumesViewProvider,
  VolumeViewItem,
} from "../../src/views/volumesView";

function mockExecFileSuccess(stdout: string) {
  vi.mocked(dockerExecPolicy).mockResolvedValue({
    exitCode: 0,
    stdout,
    stderr: "",
  });
}

function mockExecFileError(exitCode: number, stderr: string) {
  vi.mocked(dockerExecPolicy).mockResolvedValue({
    exitCode: exitCode,
    stdout: "",
    stderr,
  });
}

describe("VolumesViewProvider", () => {
  let provider: VolumesViewProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new VolumesViewProvider();
  });

  describe("getChildren", () => {
    it("returns volume items from docker volume ls", async () => {
      const dockerOutput = [
        JSON.stringify({ Name: "my-volume", Driver: "local" }),
        JSON.stringify({ Name: "data-vol", Driver: "local" }),
      ].join("\n");

      mockExecFileSuccess(dockerOutput);

      const children = await provider.getChildren();

      expect(children).toHaveLength(2);
      expect(children[0]).toBeInstanceOf(VolumeViewItem);
      expect(children[0].volume.name).toBe("my-volume");
      expect(children[0].volume.driver).toBe("local");
      expect(children[1].volume.name).toBe("data-vol");
    });

    it("returns empty array when docker volume ls fails", async () => {
      mockExecFileError(1, "docker not found");

      const children = await provider.getChildren();

      expect(children).toHaveLength(0);
    });

    it("returns empty array when no volumes exist", async () => {
      mockExecFileSuccess("");

      const children = await provider.getChildren();

      expect(children).toHaveLength(0);
    });

    it("returns empty array for child elements (flat list)", async () => {
      const item = new VolumeViewItem({ name: "test-vol", driver: "local" });
      const children = await provider.getChildren(item);

      expect(children).toHaveLength(0);
    });
  });

  describe("listVolumes", () => {
    it("parses volume JSON output correctly", async () => {
      const dockerOutput = JSON.stringify({
        Name: "project-vol",
        Driver: "overlay2",
      });
      mockExecFileSuccess(dockerOutput);

      const volumes = await provider.listVolumes();

      expect(volumes).toHaveLength(1);
      expect(volumes[0].name).toBe("project-vol");
      expect(volumes[0].driver).toBe("overlay2");
    });

    it("defaults driver to local when not specified", async () => {
      const dockerOutput = JSON.stringify({ Name: "vol1" });
      mockExecFileSuccess(dockerOutput);

      const volumes = await provider.listVolumes();

      expect(volumes[0].driver).toBe("local");
    });

    it("defaults name to unknown when not specified", async () => {
      const dockerOutput = JSON.stringify({ Driver: "local" });
      mockExecFileSuccess(dockerOutput);

      const volumes = await provider.listVolumes();

      expect(volumes[0].name).toBe("unknown");
    });
  });

  describe("inspectVolume", () => {
    it("opens a text document with inspect output on success", async () => {
      const inspectOutput = JSON.stringify(
        [{ Name: "vol1", Driver: "local" }],
        null,
        2,
      );
      mockExecFileSuccess(inspectOutput);

      await provider.inspectVolume({ name: "vol1", driver: "local" });

      expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith({
        content: inspectOutput,
        language: "json",
      });
      expect(vscode.window.showTextDocument).toHaveBeenCalled();
    });

    it("shows error message when inspect fails", async () => {
      mockExecFileError(1, "volume not found");

      await provider.inspectVolume({ name: "missing-vol", driver: "local" });

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('Failed to inspect volume "missing-vol"'),
      );
    });
  });

  describe("removeVolume", () => {
    it("removes volume after user confirms", async () => {
      vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(
        "Remove" as any,
      );
      mockExecFileSuccess("");

      await provider.removeVolume({ name: "old-vol", driver: "local" });

      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('Remove volume "old-vol"'),
        { modal: true },
        "Remove",
      );
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'Volume "old-vol" removed.',
      );
    });

    it("does nothing when user cancels", async () => {
      vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(
        undefined as any,
      );

      await provider.removeVolume({ name: "keep-vol", driver: "local" });

      // execFile should not be called for removal
      expect(execFile).not.toHaveBeenCalled();
    });

    it("shows error message when removal fails", async () => {
      vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(
        "Remove" as any,
      );
      mockExecFileError(1, "volume is in use");

      await provider.removeVolume({ name: "busy-vol", driver: "local" });

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('Failed to remove volume "busy-vol"'),
      );
    });
  });

  describe("refresh", () => {
    it("fires onDidChangeTreeData event", () => {
      const emitter = (provider as any)._onDidChangeTreeData;
      provider.refresh();
      expect(emitter.fire).toHaveBeenCalled();
    });
  });

  describe("VolumeViewItem", () => {
    it("sets correct properties", () => {
      const item = new VolumeViewItem({ name: "test-vol", driver: "local" });

      expect(item.label).toBe("test-vol");
      expect(item.description).toBe("local");
      expect(item.contextValue).toBe("docker-volume");
      expect(item.tooltip).toBe("Volume: test-vol\nDriver: local");
    });
  });

  describe("register", () => {
    it("creates a tree view with the correct id", () => {
      const context = {
        subscriptions: [] as vscode.Disposable[],
      } as unknown as vscode.ExtensionContext;

      VolumesViewProvider.register(context);

      expect(vscode.window.createTreeView).toHaveBeenCalledWith(
        "artizo.volumesView",
        {
          treeDataProvider: expect.any(VolumesViewProvider),
          showCollapseAll: false,
        },
      );
    });

    it("registers refresh, inspect, and remove commands", () => {
      const context = {
        subscriptions: [] as vscode.Disposable[],
      } as unknown as vscode.ExtensionContext;

      VolumesViewProvider.register(context);

      const registeredCommands = vi
        .mocked(vscode.commands.registerCommand)
        .mock.calls.map((call) => call[0]);
      expect(registeredCommands).toContain("artizo.volumes.refresh");
      expect(registeredCommands).toContain("artizo.volumes.inspect");
      expect(registeredCommands).toContain("artizo.volumes.remove");
    });

    it("pushes disposables to context subscriptions", () => {
      const context = {
        subscriptions: [] as vscode.Disposable[],
      } as unknown as vscode.ExtensionContext;

      VolumesViewProvider.register(context);

      expect(context.subscriptions.length).toBeGreaterThanOrEqual(4);
    });
  });
});