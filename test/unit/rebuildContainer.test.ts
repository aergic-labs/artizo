/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

vi.mock("../../src/devcontainer/api", () => ({
  launch: vi.fn(),
  withDefaults: vi.fn().mockImplementation((o: Record<string, unknown>) => o),
  ContainerError: class extends Error {
    description = "mock error";
  },
}));

import { launch, withDefaults } from "../../src/devcontainer/api";
import { rebuildContainer } from "../../src/workflows/rebuildContainer";
import { WorkflowOrchestrator } from "../../src/workflows/orchestrator";
import type {
  WorkflowDependencies,
  WorkflowUI,
} from "../../src/workflows/types";
import { BRAND } from "../../src/utils/constants";
import type { IConfigManager } from "../../src/config/configManager";
import type { IServerManager } from "../../src/remote/serverManager";
import type { ICommunicationBridge } from "../../src/remote/communicationBridge";
import type { IGitConfigCopier } from "../../src/credentials/gitConfigCopier";

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

function createMockServerManager(
  overrides?: Partial<IServerManager>,
): IServerManager {
  return {
    ensureInstalled: vi.fn().mockResolvedValue({
      version: "1.96.0",
      arch: "x64",
      installPath: "~/.artizo-server",
      socketPath: "/tmp/artizo-server.sock",
    }),
    start: vi.fn().mockResolvedValue({
      version: "1.96.0",
      arch: "x64",
      installPath: "~/.artizo-server",
      socketPath: "/tmp/artizo-server.sock",
      pid: 1234,
    }),
    stop: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn().mockResolvedValue(null),
    getCompatibleVersion: vi.fn().mockReturnValue("1.96.0"),
    ...overrides,
  };
}

function createMockBridge(
  overrides?: Partial<ICommunicationBridge>,
): ICommunicationBridge {
  return {
    connect: vi
      .fn()
      .mockResolvedValue({ send: vi.fn(), onData: vi.fn(), onClose: vi.fn() }),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(false),
    onDidDisconnect: vi.fn(),
    ...overrides,
  };
}

function createMockUI(overrides?: Partial<WorkflowUI>): WorkflowUI {
  return {
    showProgress: vi.fn().mockImplementation(async (_title, task) => {
      await task({ report: vi.fn() });
    }),
    showError: vi.fn().mockResolvedValue(undefined),
    showInfo: vi.fn().mockResolvedValue(undefined),
    openWindow: vi.fn().mockResolvedValue(undefined),
    promptCreateConfig: vi.fn().mockResolvedValue(false),
    showBuildLog: vi.fn(),
    ...overrides,
  };
}

function createMockGitConfigCopier(): IGitConfigCopier {
  return { copyGitConfig: vi.fn().mockResolvedValue(undefined) };
}

describe("rebuildContainer", () => {
  let orchestrator: WorkflowOrchestrator;
  let deps: WorkflowDependencies;
  let ui: WorkflowUI;

  beforeEach(() => {
    vi.clearAllMocks();
    // Intercept setTimeout so the 2500ms waits in workflow code resolve
    // synchronously instead of blocking the test.
    vi.stubGlobal(
      "setTimeout",
      vi.fn((fn: any) => {
        if (typeof fn === "function") fn();
        return 0 as any;
      }),
    );
    (launch as ReturnType<typeof vi.fn>).mockResolvedValue({
      containerId: "abc123",
      remoteUser: "vscode",
      remoteWorkspaceFolder: "/workspaces/test-project",
    });
    orchestrator = new WorkflowOrchestrator();
    deps = {
      configManager: createMockConfigManager(),
      serverManager: createMockServerManager(),
      bridge: createMockBridge(),
      orchestrator,
      gitConfigCopier: createMockGitConfigCopier(),
    };
    ui = createMockUI();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("completes build-only workflow successfully", async () => {
    await rebuildContainer(deps, ui, {
      workspaceFolder: "/workspace",
      reconnect: false,
    });

    expect(orchestrator.state).toBe("idle");
    expect(launch).toHaveBeenCalledTimes(1);
    expect(ui.showInfo).toHaveBeenCalledWith(
      expect.stringContaining("rebuilt successfully"),
    );
    expect(deps.serverManager.ensureInstalled).not.toHaveBeenCalled();
  });

  it("transitions through correct states for build-only", async () => {
    const states: string[] = [];
    orchestrator.onDidChangeState((s) => states.push(s));

    await rebuildContainer(deps, ui, {
      workspaceFolder: "/workspace",
      reconnect: false,
    });

    expect(states).toEqual([
      "parsing-config",
      "building-container",
      "installing-server",
      "idle",
    ]);
  });

  it("completes the full rebuild+reconnect workflow", async () => {
    await rebuildContainer(deps, ui, {
      workspaceFolder: "/workspace",
      reconnect: true,
    });

    expect(orchestrator.state).toBe("connected");
    expect(launch).toHaveBeenCalled();
    expect(deps.serverManager.ensureInstalled).toHaveBeenCalledWith("abc123");
    expect(deps.bridge.connect).toHaveBeenCalled();
    expect(ui.openWindow).toHaveBeenCalled();
  });

  it("transitions through correct states for reconnect", async () => {
    const states: string[] = [];
    orchestrator.onDidChangeState((s) => states.push(s));

    await rebuildContainer(deps, ui, {
      workspaceFolder: "/workspace",
      reconnect: true,
    });

    expect(states).toEqual([
      "parsing-config",
      "building-container",
      "installing-server",
      "connecting",
      "connected",
    ]);
  });

  it("disconnects bridge if currently connected", async () => {
    deps.bridge = createMockBridge({
      isConnected: vi.fn().mockReturnValue(true),
    });

    await rebuildContainer(deps, ui, {
      workspaceFolder: "/workspace",
      reconnect: false,
    });

    expect(deps.bridge.disconnect).toHaveBeenCalled();
  });

  it("does not disconnect if bridge is not connected", async () => {
    await rebuildContainer(deps, ui, {
      workspaceFolder: "/workspace",
      reconnect: false,
    });

    expect(deps.bridge.disconnect).not.toHaveBeenCalled();
  });

  it("passes buildNoCache flag via withDefaults", async () => {
    await rebuildContainer(deps, ui, {
      workspaceFolder: "/workspace",
      noCache: true,
      reconnect: false,
    });

    expect(withDefaults).toHaveBeenCalledWith(
      expect.objectContaining({ buildNoCache: true }),
    );
  });

  it("defaults buildNoCache to false", async () => {
    await rebuildContainer(deps, ui, {
      workspaceFolder: "/workspace",
      reconnect: false,
    });

    expect(withDefaults).toHaveBeenCalledWith(
      expect.objectContaining({ buildNoCache: false }),
    );
  });

  it("throws when no devcontainer.json found", async () => {
    deps.configManager = createMockConfigManager({
      readConfig: vi
        .fn()
        .mockReturnValue({ config: null, configPath: null, parseErrors: [] }),
    });

    await expect(
      rebuildContainer(deps, ui, {
        workspaceFolder: "/workspace",
        reconnect: false,
      }),
    ).rejects.toThrow("No devcontainer.json found");

    expect(orchestrator.state).toBe("error");
  });

  it("throws on config parse errors", async () => {
    deps.configManager = createMockConfigManager({
      readConfig: vi.fn().mockReturnValue({
        config: { image: "node:18" },
        configPath: "/workspace/.devcontainer/devcontainer.json",
        parseErrors: [
          {
            message: "Unexpected comma",
            offset: 5,
            length: 1,
            line: 1,
            column: 6,
          },
        ],
      }),
    });

    await expect(
      rebuildContainer(deps, ui, {
        workspaceFolder: "/workspace",
        reconnect: false,
      }),
    ).rejects.toThrow("devcontainer.json has parse errors");

    expect(orchestrator.state).toBe("error");
  });

  it("offers recovery mode when launch fails", async () => {
    (launch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Build failed: Dockerfile error at line 5"),
    );
    ui = createMockUI({ showError: vi.fn().mockResolvedValue("Open Locally") });

    await rebuildContainer(deps, ui, {
      workspaceFolder: "/workspace",
      reconnect: false,
    });

    expect(orchestrator.state).toBe("error");
  });

  it("throws when launch fails and user retries", async () => {
    (launch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Build error"),
    );
    ui = createMockUI({ showError: vi.fn().mockResolvedValue("Retry") });

    await expect(
      rebuildContainer(deps, ui, {
        workspaceFolder: "/workspace",
        reconnect: false,
      }),
    ).rejects.toThrow("Build error");

    expect(orchestrator.state).toBe("error");
  });

  it("shows progress during rebuild", async () => {
    await rebuildContainer(deps, ui, {
      workspaceFolder: "/workspace",
      reconnect: false,
    });

    expect(ui.showProgress).toHaveBeenCalledWith(
      `${BRAND}: Rebuilding Container`,
      expect.any(Function),
    );
  });

  it("throws when launch returns no container ID", async () => {
    (launch as ReturnType<typeof vi.fn>).mockResolvedValue({
      containerId: undefined,
      remoteUser: "",
      remoteWorkspaceFolder: "",
    });

    await expect(
      rebuildContainer(deps, ui, {
        workspaceFolder: "/workspace",
        reconnect: true,
      }),
    ).rejects.toThrow("CLI did not return a container ID");

    expect(orchestrator.state).toBe("error");
  });

  it("shows build log messages during server setup", async () => {
    await rebuildContainer(deps, ui, {
      workspaceFolder: "/workspace",
      reconnect: true,
    });

    expect(ui.showBuildLog).toHaveBeenCalledWith(
      expect.stringContaining("Installing"),
    );
    expect(ui.showBuildLog).toHaveBeenCalledWith(
      expect.stringContaining("Starting"),
    );
    expect(ui.showBuildLog).toHaveBeenCalledWith(
      expect.stringContaining("Connecting to container"),
    );
  });
});