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
    // ExtensionKind.Workspace so detectTier reports LocalHost/workspace owner,
    // taking the States 1-3 authority path (no relay daemon).
    ExtensionKind: { UI: 1, Workspace: 2 },
    env: { remoteAuthority: undefined, remoteName: undefined },
    Uri: {
      parse: (s: string) => ({ toString: () => s }),
      file: (s: string) => ({ fsPath: s }),
    },
  };
});

vi.mock("../../src/devcontainer/api", async () => {
  const { ProvisionFailedError } =
    await import("../../src/devcontainer/provisionError");
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

// Mock containerProxy so the State 4 path doesn't spawn a real relay daemon.
const { mockStartRelayDaemon, mockDecodeSshAuthority } = vi.hoisted(() => ({
  mockStartRelayDaemon: vi.fn(),
  mockDecodeSshAuthority: vi.fn(),
}));
vi.mock("../../src/remote/containerProxy", () => ({
  startRelayDaemon: mockStartRelayDaemon,
  decodeSshAuthority: mockDecodeSshAuthority,
}));

import { launch } from "../../src/devcontainer/api";
import { reopenInContainer } from "../../src/workflows/reopenInContainer";
import { initTier } from "../../src/host/state";
import * as vscode from "vscode";
import type {
  WorkflowDependencies,
  WorkflowUI,
} from "../../src/workflows/types";
import type { IConfigManager } from "../../src/config/configManager";
import type { IServerManager } from "../../src/remote/serverManager";
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
    getConfigPath: vi.fn().mockReturnValue({
      fsPath: "/workspace/.devcontainer/devcontainer.json",
    }),
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
    getUserExtensionsDir: vi.fn().mockResolvedValue("/tmp/test-extensions"),
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
  let deps: WorkflowDependencies;
  let ui: WorkflowUI;

  beforeEach(() => {
    // Don't call vi.clearAllMocks(); it breaks vi.mock factory exports
    // for dynamic imports.
    mockStartRelayDaemon.mockReset();
    mockDecodeSshAuthority.mockReset();
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
    deps = {
      configManager: createMockConfigManager(),
      serverManager: createMockServerManager(),
      gitConfigCopier: createMockGitConfigCopier(),
      dockerPath: "docker",
      extensionInstaller: {
        installFromConfig: vi.fn().mockResolvedValue([]),
        installExtensions: vi.fn().mockResolvedValue([]),
      } as any,
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
    await reopenInContainer(deps, ui, { workspaceFolder: "/workspace", workspaceUri: vscode.Uri.file("/workspace") });

    expect(launch).toHaveBeenCalled();
    expect(deps.serverManager.ensureInstalled).toHaveBeenCalledWith("abc123");
    expect(deps.serverManager.start).toHaveBeenCalledWith("abc123");
    expect(ui.openWindow).toHaveBeenCalled();
  });

  it("aborts silently when cancelled during the progress task", async () => {
    ui = createMockUI({
      showProgress: vi.fn(async (_title: string, task: any) => {
        await task({ report: vi.fn() }, { isCancellationRequested: true });
      }),
    });

    await reopenInContainer(deps, ui, {
      workspaceFolder: "/workspace",
      workspaceUri: vscode.Uri.file("/workspace"),
    });

    expect(ui.openWindow).not.toHaveBeenCalled();
    expect(ui.showError).not.toHaveBeenCalled();
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
      reopenInContainer(deps, ui, { workspaceFolder: "/workspace", workspaceUri: vscode.Uri.file("/workspace") }),
    ).rejects.toThrow("No devcontainer.json. User cancelled");

    expect(promptMock).toHaveBeenCalled();
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
      reopenInContainer(deps, ui, { workspaceFolder: "/workspace", workspaceUri: vscode.Uri.file("/workspace") }),
    ).rejects.toThrow("devcontainer.json has parse errors");
  });

  it("throws when launch fails", async () => {
    (launch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Build failed: Docker build error"),
    );

    await expect(
      reopenInContainer(deps, ui, { workspaceFolder: "/workspace", workspaceUri: vscode.Uri.file("/workspace") }),
    ).rejects.toThrow("Build failed: Docker build error");
  });

  it("throws when launch returns no container ID", async () => {
    (launch as ReturnType<typeof vi.fn>).mockResolvedValue({
      containerId: undefined,
      remoteUser: "",
      remoteWorkspaceFolder: "",
    });

    await expect(
      reopenInContainer(deps, ui, { workspaceFolder: "/workspace", workspaceUri: vscode.Uri.file("/workspace") }),
    ).rejects.toThrow("CLI did not return a container ID");
  });

  it("throws when server installation fails", async () => {
    deps.serverManager = createMockServerManager({
      ensureInstalled: vi.fn().mockRejectedValue(new Error("Disk full")),
    });

    await expect(
      reopenInContainer(deps, ui, { workspaceFolder: "/workspace", workspaceUri: vscode.Uri.file("/workspace") }),
    ).rejects.toThrow("Disk full");
  });

  it("shows progress during reopen", async () => {
    await reopenInContainer(deps, ui, { workspaceFolder: "/workspace", workspaceUri: vscode.Uri.file("/workspace") });

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
      reopenInContainer(deps, ui, { workspaceFolder: "/workspace", workspaceUri: vscode.Uri.file("/workspace") }),
    ).rejects.toThrow("Build error");

    // Build/provision failures are now reported once at the command layer
    // (with "Diagnose with AI"), so the workflow does not show its own toast.
    expect(showErrorMock).not.toHaveBeenCalled();
  });

  it("shows build log messages during server setup", async () => {
    await reopenInContainer(deps, ui, { workspaceFolder: "/workspace", workspaceUri: vscode.Uri.file("/workspace") });

    expect(ui.showBuildLog).toHaveBeenCalledWith(
      expect.stringContaining("Installing"),
    );
    expect(ui.showBuildLog).toHaveBeenCalledWith(
      expect.stringContaining("Starting"),
    );
    expect(ui.showBuildLog).toHaveBeenCalledWith(
      expect.stringContaining("Copying Git config"),
    );
  });

  it("State 4: starts relay daemon and encodes proxy payload in authority", async () => {
    // Force the State 4 tier: workspace-side on an SSH remote.
    (vscode.env as any).remoteName = "ssh-remote";
    initTier(vscode.ExtensionKind.Workspace);

    // Server returns a port + token + installPath (for nodePath).
    deps.serverManager = createMockServerManager({
      start: vi.fn().mockResolvedValue({
        commit: "abc",
        arch: "x64",
        installPath: "/tmp/.trae-server",
        port: 38517,
        connectionToken: "token-xyz",
      }),
    });
    mockDecodeSshAuthority.mockReturnValue({
      sshHost: "34.136.190.14",
      sshUser: "dev",
    });
    mockStartRelayDaemon.mockResolvedValue({
      relayPort: 9888,
      pidFile: "/tmp/artizo-relay.pid",
      pid: 12345,
    });

    try {
      await reopenInContainer(deps, ui, { workspaceFolder: "/workspace", workspaceUri: vscode.Uri.file("/workspace") });

      // Relay daemon was started with container + port + node path.
      expect(mockStartRelayDaemon).toHaveBeenCalledWith({
        containerId: "abc123",
        containerPort: 38517,
        nodePath: "/tmp/.trae-server/node",
        dockerPath: "docker",
      });

      // openWindow was called with a proxy-payload authority.
      expect(ui.openWindow).toHaveBeenCalledTimes(1);
      const url = (ui.openWindow as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as string;
      expect(url).toContain("artizo-container+");
      // Decode the hex payload and confirm it carries proxy + SSH info.
      const hex = url.split("artizo-container+")[1].split("/")[0];
      const json = JSON.parse(
        Buffer.from(hex, "hex").toString("utf-8"),
      ) as Record<string, unknown>;
      expect(json.proxy).toBe(true);
      expect(json.sshHost).toBe("34.136.190.14");
      expect(json.sshUser).toBe("dev");
      expect(json.relayPort).toBe(9888);
      expect(json.connectionToken).toBe("token-xyz");
      expect(json.workspacePath).toBe("/workspaces/test-project");
    } finally {
      // Reset tier back to local for subsequent tests.
      (vscode.env as any).remoteName = undefined;
      initTier(vscode.ExtensionKind.Workspace);
    }
  });

  it("State 4: throws when SSH authority can't be decoded", async () => {
    (vscode.env as any).remoteName = "ssh-remote";
    initTier(vscode.ExtensionKind.Workspace);

    deps.serverManager = createMockServerManager({
      start: vi.fn().mockResolvedValue({
        commit: "abc",
        arch: "x64",
        installPath: "/tmp/.trae-server",
        port: 38517,
        connectionToken: "token-xyz",
      }),
    });
    mockDecodeSshAuthority.mockReturnValue(undefined);

    try {
      await expect(
        reopenInContainer(deps, ui, { workspaceFolder: "/workspace", workspaceUri: vscode.Uri.file("/workspace") }),
      ).rejects.toThrow("could not decode SSH authority");
      expect(mockStartRelayDaemon).not.toHaveBeenCalled();
    } finally {
      (vscode.env as any).remoteName = undefined;
      initTier(vscode.ExtensionKind.Workspace);
    }
  });
});
