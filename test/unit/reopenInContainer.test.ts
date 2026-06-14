/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock execPolicy before the dynamic import happens, so the mock module
// is cached rather than the real module.
vi.mock("../../src/docker/execPolicy.js", () => ({
  configureDockerPath: vi.fn(),
  dockerExecPolicy: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
}));

vi.mock("vscode", () => {
  const getConfiguration = vi.fn().mockReturnValue({
    get: vi.fn((_key: string, defaultValue: unknown) => defaultValue),
  });
  return {
    window: {
      createTerminal: vi
        .fn()
        .mockReturnValue({ show: vi.fn(), dispose: vi.fn() }),
      withProgress: vi.fn(),
    },
    workspace: { getConfiguration },
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
  };
});

vi.mock("../../src/devcontainer/api", async () => {
  const { ProvisionFailedError } = await import(
    "../../src/devcontainer/provisionError"
  );
  const launch = vi.fn();
  const launchProvision = vi.fn(
    async (
      options: unknown,
      configPath: string | null | undefined,
      failureMessage = "Build failed",
    ) => {
      try {
        return await launch(options, undefined, []);
      } catch (err: unknown) {
        const desc = (err as { description?: string })?.description;
        const msg = desc ?? (err instanceof Error ? err.message : String(err));
        throw new ProvisionFailedError(
          `${failureMessage}: ${msg}`,
          configPath ?? undefined,
        );
      }
    },
  );
  return {
    launch,
    launchProvision,
    withDefaults: vi.fn().mockImplementation((o: Record<string, unknown>) => o),
    ContainerError: class extends Error {
      description = "mock error";
    },
  };
});

vi.mock("../../src/utils/dockerUtils.js", () => ({
  execFilePromise: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
}));

import { launch } from "../../src/devcontainer/api";
import { reopenInContainer } from "../../src/workflows/reopenInContainer";
import { WorkflowOrchestrator } from "../../src/workflows/orchestrator";
import type {
  WorkflowDependencies,
  WorkflowUI,
} from "../../src/workflows/types";
import type { IConfigManager } from "../../src/config/configManager";
import type { IServerManager } from "../../src/remote/serverManager";
import type { ICommunicationBridge } from "../../src/remote/communicationBridge";
import type { IGitConfigCopier } from "../../src/credentials/gitConfigCopier";
import { BRAND } from "../../src/utils/constants";

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

describe("reopenInContainer", () => {
  let orchestrator: WorkflowOrchestrator;
  let deps: WorkflowDependencies;
  let ui: WorkflowUI;

  beforeEach(() => {
    // Don't call vi.clearAllMocks(); it breaks vi.mock factory exports
    // for dynamic imports.
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
    // Only restore setTimeout, not vi.mock module mocks.
    // vi.restoreAllMocks() would revert the execPolicy mock module's
    // vi.fn() instances back to returning undefined.
    vi.unstubAllGlobals();
  });

  it("completes the full workflow successfully", async () => {
    await reopenInContainer(deps, ui, { workspaceFolder: "/workspace" });

    expect(orchestrator.state).toBe("connected");
    expect(launch).toHaveBeenCalled();
    expect(deps.serverManager.ensureInstalled).toHaveBeenCalledWith("abc123");
    expect(deps.bridge.connect).toHaveBeenCalled();
    expect(ui.openWindow).toHaveBeenCalled();
  });

  it("transitions through correct states", async () => {
    const states: string[] = [];
    orchestrator.onDidChangeState((s) => states.push(s));

    await reopenInContainer(deps, ui, { workspaceFolder: "/workspace" });

    expect(states).toEqual([
      "parsing-config",
      "building-container",
      "installing-server",
      "connecting",
      "connected",
    ]);
  });

  it("prompts to create config when none found", async () => {
    deps.configManager = createMockConfigManager({
      readConfig: vi
        .fn()
        .mockReturnValue({ config: null, configPath: null, parseErrors: [] }),
    });
    const promptMock = vi.fn().mockResolvedValue(false);
    ui = createMockUI({ promptCreateConfig: promptMock });

    await expect(
      reopenInContainer(deps, ui, { workspaceFolder: "/workspace" }),
    ).rejects.toThrow("No devcontainer.json. User cancelled");

    expect(promptMock).toHaveBeenCalled();
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
      reopenInContainer(deps, ui, { workspaceFolder: "/workspace" }),
    ).rejects.toThrow("devcontainer.json has parse errors");

    expect(orchestrator.state).toBe("error");
  });

  it("throws when launch fails", async () => {
    (launch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Build failed: Docker build error"),
    );

    await expect(
      reopenInContainer(deps, ui, { workspaceFolder: "/workspace" }),
    ).rejects.toThrow("Build failed: Docker build error");

    expect(orchestrator.state).toBe("error");
  });

  it("throws when launch returns no container ID", async () => {
    (launch as ReturnType<typeof vi.fn>).mockResolvedValue({
      containerId: undefined,
      remoteUser: "",
      remoteWorkspaceFolder: "",
    });

    await expect(
      reopenInContainer(deps, ui, { workspaceFolder: "/workspace" }),
    ).rejects.toThrow("CLI did not return a container ID");

    expect(orchestrator.state).toBe("error");
  });

  it("throws when server installation fails", async () => {
    deps.serverManager = createMockServerManager({
      ensureInstalled: vi.fn().mockRejectedValue(new Error("Disk full")),
    });

    await expect(
      reopenInContainer(deps, ui, { workspaceFolder: "/workspace" }),
    ).rejects.toThrow("Disk full");

    expect(orchestrator.state).toBe("error");
  });

  it("throws when bridge connection fails", async () => {
    deps.bridge = createMockBridge({
      connect: vi.fn().mockRejectedValue(new Error("Connection refused")),
    });

    await expect(
      reopenInContainer(deps, ui, { workspaceFolder: "/workspace" }),
    ).rejects.toThrow("Connection refused");

    expect(orchestrator.state).toBe("error");
  });

  it("shows progress during reopen", async () => {
    await reopenInContainer(deps, ui, { workspaceFolder: "/workspace" });

    expect(ui.showProgress).toHaveBeenCalledWith(
      `${BRAND}: Reopen in Container`,
      expect.any(Function),
    );
  });

  it("propagates build failures without its own toast (reported at command layer)", async () => {
    (launch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Build error"),
    );
    const showErrorMock = vi.fn().mockResolvedValue(undefined);
    ui = createMockUI({ showError: showErrorMock });

    await expect(
      reopenInContainer(deps, ui, { workspaceFolder: "/workspace" }),
    ).rejects.toThrow("Build error");

    // Build/provision failures are now reported once at the command layer
    // (with "Diagnose with AI"), so the workflow does not show its own toast.
    expect(showErrorMock).not.toHaveBeenCalled();
    expect(orchestrator.state).toBe("error");
  });

  it("shows build log messages during server setup", async () => {
    await reopenInContainer(deps, ui, { workspaceFolder: "/workspace" });

    expect(ui.showBuildLog).toHaveBeenCalledWith(
      expect.stringContaining("Installing"),
    );
    expect(ui.showBuildLog).toHaveBeenCalledWith(
      expect.stringContaining("Starting"),
    );
    expect(ui.showBuildLog).toHaveBeenCalledWith(
      expect.stringContaining("Connecting to container"),
    );
    expect(ui.showBuildLog).toHaveBeenCalledWith(
      expect.stringContaining("Connected."),
    );
  });
});