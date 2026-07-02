/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as vscode from "vscode";

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
  ExtensionKind: { UI: 1, Workspace: 2 },
  env: { remoteAuthority: undefined, remoteName: undefined },
  workspace: { workspaceFolders: [] },
  Uri: {
    parse: (s: string) => ({ toString: () => s }),
    file: (s: string) => ({ fsPath: s }),
  },
}));

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

import { launch, withDefaults } from "../../src/devcontainer/api";
import { rebuildContainer } from "../../src/workflows/rebuildContainer";
import type {
  WorkflowDependencies,
  WorkflowUI,
} from "../../src/workflows/types";
import { BRAND } from "../../src/utils/constants";
import type { IConfigManager } from "../../src/config/configManager";
import type { IServerManager } from "../../src/remote/serverManager";
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
    getExtensionsDir: vi.fn().mockResolvedValue("/tmp/test-extensions"),
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
    vi.unstubAllGlobals();
  });

  it("completes build-only workflow successfully", async () => {
    await rebuildContainer(deps, ui, {
      workspaceFolder: "/workspace",
      workspaceUri: vscode.Uri.file("/workspace"),
      reconnect: false,
    });

    expect(launch).toHaveBeenCalledTimes(1);
    expect(ui.showInfo).toHaveBeenCalledWith(
      expect.stringContaining("rebuilt successfully"),
    );
    expect(deps.serverManager.ensureInstalled).not.toHaveBeenCalled();
  });

  it("completes the full rebuild+reconnect workflow", async () => {
    await rebuildContainer(deps, ui, {
      workspaceFolder: "/workspace",
      workspaceUri: vscode.Uri.file("/workspace"),
      reconnect: true,
    });

    expect(launch).toHaveBeenCalled();
    expect(deps.serverManager.ensureInstalled).toHaveBeenCalledWith("abc123");
    expect(deps.serverManager.start).toHaveBeenCalledWith("abc123");
    expect(ui.openWindow).toHaveBeenCalled();
  });

  it("passes buildNoCache flag via withDefaults", async () => {
    await rebuildContainer(deps, ui, {
      workspaceFolder: "/workspace",
      workspaceUri: vscode.Uri.file("/workspace"),
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
      workspaceUri: vscode.Uri.file("/workspace"),
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
      workspaceUri: vscode.Uri.file("/workspace"),
        reconnect: false,
      }),
    ).rejects.toThrow("No devcontainer.json found");
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
      workspaceUri: vscode.Uri.file("/workspace"),
        reconnect: false,
      }),
    ).rejects.toThrow("devcontainer.json has parse errors");
  });

  it("propagates build failures without offering recovery (reported at command layer)", async () => {
    (launch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Build failed: Dockerfile error at line 5"),
    );
    const showErrorMock = vi.fn().mockResolvedValue("Open Locally");
    ui = createMockUI({ showError: showErrorMock });

    await expect(
      rebuildContainer(deps, ui, {
        workspaceFolder: "/workspace",
      workspaceUri: vscode.Uri.file("/workspace"),
        reconnect: false,
      }),
    ).rejects.toThrow("Dockerfile error at line 5");

    // Provision failures are reported at the command layer now, so the
    // workflow neither shows its own toast nor offers the recovery prompt.
    expect(showErrorMock).not.toHaveBeenCalled();
  });

  it("throws when launch fails and user retries", async () => {
    (launch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Build error"),
    );
    ui = createMockUI({ showError: vi.fn().mockResolvedValue("Retry") });

    await expect(
      rebuildContainer(deps, ui, {
        workspaceFolder: "/workspace",
      workspaceUri: vscode.Uri.file("/workspace"),
        reconnect: false,
      }),
    ).rejects.toThrow("Build error");
  });

  it("shows progress during rebuild", async () => {
    await rebuildContainer(deps, ui, {
      workspaceFolder: "/workspace",
      workspaceUri: vscode.Uri.file("/workspace"),
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
      workspaceUri: vscode.Uri.file("/workspace"),
        reconnect: true,
      }),
    ).rejects.toThrow("CLI did not return a container ID");
  });

  it("shows build log messages during server setup", async () => {
    await rebuildContainer(deps, ui, {
      workspaceFolder: "/workspace",
      workspaceUri: vscode.Uri.file("/workspace"),
      reconnect: true,
    });

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
});
