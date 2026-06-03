/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("vscode", () => ({
  window: {
    createTerminal: vi
      .fn()
      .mockReturnValue({ show: vi.fn(), dispose: vi.fn() }),
    withProgress: vi.fn(),
  },
  commands: {
    executeCommand: vi.fn(),
  },
  EventEmitter: vi.fn().mockImplementation(() => ({
    event: vi.fn(),
    fire: vi.fn(),
    dispose: vi.fn(),
  })),
  ProgressLocation: { Notification: 15 },
  Uri: { parse: (s: string) => ({ toString: () => s }) },
}));

import {
  attachToContainer,
  getAttachConfigDir,
  getAttachConfigPath,
  loadAttachConfig,
  saveAttachConfig,
} from "../../src/workflows/attachToContainer";
import { WorkflowOrchestrator } from "../../src/workflows/orchestrator";
import type { WorkflowDependencies } from "../../src/workflows/types";
import type {
  AttachToContainerUI,
  DockerListDependency,
  RunningContainer,
} from "../../src/workflows/attachToContainer";
import type { IConfigManager } from "../../src/config/configManager";
import type { IServerManager } from "../../src/remote/serverManager";
import type { ICommunicationBridge } from "../../src/remote/communicationBridge";
import type { IGitConfigCopier } from "../../src/credentials/gitConfigCopier";
import { BRAND_PREFIX } from "../../src/utils/constants";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn().mockImplementation(() => {
    throw new Error("ENOENT");
  }),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock("node:os", () => ({
  homedir: vi.fn().mockReturnValue("/home/testuser"),
}));

function createMockConfigManager(): IConfigManager {
  return {
    readConfig: vi.fn().mockReturnValue({
      config: { image: "node:18" },
      configPath: "/workspace/.devcontainer/devcontainer.json",
      parseErrors: [],
    }),
    validateConfig: vi
      .fn()
      .mockReturnValue({ valid: true, errors: [], warnings: [] }),
    getConfigPath: vi.fn().mockReturnValue(null),
  };
}

function createMockServerManager(): IServerManager {
  return {
    ensureInstalled: vi.fn().mockResolvedValue({
      commit: "abc123",
      arch: "x64",
      installPath: "~/.kiro-server/abc123",
      port: 0,
    }),
    start: vi.fn().mockResolvedValue({
      commit: "abc123",
      arch: "x64",
      installPath: "~/.kiro-server/abc123",
      port: 15999,
      connectionToken: "test-token",
      pid: 1234,
    }),
    stop: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn().mockResolvedValue(null),
    getCompatibleVersion: vi.fn().mockReturnValue("1.96.0"),
  };
}

function createMockBridge(): ICommunicationBridge {
  return {
    connect: vi.fn().mockResolvedValue({
      send: vi.fn(),
      onData: vi.fn(),
      onClose: vi.fn(),
    }),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(false),
    onDidDisconnect: vi.fn(),
  };
}

function createMockUI(
  overrides?: Partial<AttachToContainerUI>,
): AttachToContainerUI {
  return {
    showProgress: vi.fn().mockImplementation(async (_title, task) => {
      await task({ report: vi.fn() });
    }),
    showError: vi.fn().mockResolvedValue(undefined),
    showInfo: vi.fn().mockResolvedValue(undefined),
    openWindow: vi.fn().mockResolvedValue(undefined),
    promptCreateConfig: vi.fn().mockResolvedValue(false),
    showBuildLog: vi.fn(),
    pickContainer: vi.fn().mockResolvedValue({
      id: "container-abc",
      name: "my-container",
      image: "node:18",
      status: "running",
    } satisfies RunningContainer),
    ...overrides,
  };
}

function createMockDocker(
  overrides?: Partial<DockerListDependency>,
): DockerListDependency {
  return {
    listRunningContainers: vi.fn().mockResolvedValue([
      {
        id: "container-abc",
        name: "my-container",
        image: "node:18",
        status: "running",
      },
      {
        id: "container-def",
        name: "other-container",
        image: "python:3",
        status: "running",
      },
    ]),
    ...overrides,
  };
}

describe("attachToContainer", () => {
  let orchestrator: WorkflowOrchestrator;
  let deps: WorkflowDependencies;
  let ui: AttachToContainerUI;
  let docker: DockerListDependency;

  function createMockGitConfigCopier(): IGitConfigCopier {
    return {
      copyGitConfig: vi.fn().mockResolvedValue(undefined),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    orchestrator = new WorkflowOrchestrator();
    deps = {
      configManager: createMockConfigManager(),
      serverManager: createMockServerManager(),
      bridge: createMockBridge(),
      orchestrator,
      gitConfigCopier: createMockGitConfigCopier(),
    };
    ui = createMockUI();
    docker = createMockDocker();
  });

  describe("getAttachConfigDir", () => {
    it("returns path under ~/.config/artizo/attachConfigs", () => {
      const dir = getAttachConfigDir();
      expect(dir).toContain(".config");
      expect(dir).toContain("artizo");
      expect(dir).toContain("attachConfigs");
    });
  });

  describe("getAttachConfigPath", () => {
    it("returns a JSON file path for the container name", () => {
      const configPath = getAttachConfigPath("my-container");
      expect(configPath).toContain("my-container.json");
    });

    it("sanitizes special characters in container name", () => {
      const configPath = getAttachConfigPath("my/container:latest");
      expect(configPath).toContain("my_container_latest.json");
      expect(configPath).not.toContain("/container");
    });
  });

  describe("loadAttachConfig", () => {
    it("returns null when config file does not exist", () => {
      const config = loadAttachConfig("nonexistent");
      expect(config).toBeNull();
    });
  });

  describe("workflow", () => {
    it("lists running containers and lets user pick", async () => {
      await attachToContainer(deps, ui, docker, {});

      expect(docker.listRunningContainers).toHaveBeenCalled();
      expect(ui.pickContainer).toHaveBeenCalled();
    });

    it("returns early when no running containers found", async () => {
      docker = createMockDocker({
        listRunningContainers: vi.fn().mockResolvedValue([]),
      });

      await attachToContainer(deps, ui, docker, {});

      expect(ui.showInfo).toHaveBeenCalledWith(
        `${BRAND_PREFIX} No running containers found.`,
      );
      expect(deps.serverManager.ensureInstalled).not.toHaveBeenCalled();
    });

    it("returns early when user cancels container selection", async () => {
      ui = createMockUI({
        pickContainer: vi.fn().mockResolvedValue(undefined),
      });

      await attachToContainer(deps, ui, docker, {});

      expect(deps.serverManager.ensureInstalled).not.toHaveBeenCalled();
    });

    it("skips container listing when containerId is provided", async () => {
      await attachToContainer(deps, ui, docker, {
        containerId: "pre-selected-123",
      });

      expect(docker.listRunningContainers).not.toHaveBeenCalled();
      expect(ui.pickContainer).not.toHaveBeenCalled();
      expect(deps.serverManager.ensureInstalled).toHaveBeenCalledWith(
        "pre-selected-123",
      );
    });

    it("completes the full workflow successfully", async () => {
      await attachToContainer(deps, ui, docker, {});

      expect(orchestrator.state).toBe("connected");
      expect(deps.serverManager.ensureInstalled).toHaveBeenCalledWith(
        "container-abc",
      );
      expect(deps.serverManager.start).toHaveBeenCalledWith("container-abc");
      expect(deps.bridge.connect).toHaveBeenCalledWith(
        "container-abc",
        15999,
        expect.any(String),
      );
      expect(ui.openWindow).toHaveBeenCalledWith(
        expect.stringContaining("vscode-remote://attached-container+"),
      );
    });

    it("transitions through correct states", async () => {
      const states: string[] = [];
      orchestrator.onDidChangeState((s) => states.push(s));

      await attachToContainer(deps, ui, docker, {});

      expect(states).toEqual(["installing-server", "connecting", "connected"]);
    });

    it("throws when server installation fails", async () => {
      deps.serverManager = {
        ...createMockServerManager(),
        ensureInstalled: vi.fn().mockRejectedValue(new Error("Install failed")),
      };

      await expect(attachToContainer(deps, ui, docker, {})).rejects.toThrow(
        "Install failed",
      );

      expect(orchestrator.state).toBe("error");
    });

    it("shows error notification on failure", async () => {
      deps.bridge = {
        ...createMockBridge(),
        connect: vi.fn().mockRejectedValue(new Error("Connection refused")),
      };

      await expect(attachToContainer(deps, ui, docker, {})).rejects.toThrow(
        "Connection refused",
      );

      expect(ui.showError).toHaveBeenCalledWith(
        expect.stringContaining("Failed to attach to container"),
        "Retry",
        "Cancel",
      );
    });
  });
});