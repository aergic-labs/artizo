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

import { launch } from "../../src/devcontainer/api";
import {
  openFolderInContainer,
  type OpenFolderUI,
} from "../../src/workflows/openFolder";
import type { WorkflowDependencies } from "../../src/workflows/types";
import { BRAND } from "../../src/utils/constants";
import type { IConfigManager } from "../../src/config/configManager";
import type { IServerManager } from "../../src/remote/serverManager";
import type { IGitConfigCopier } from "../../src/credentials/gitConfigCopier";

function createMockConfigManager(
  overrides?: Partial<IConfigManager>,
): IConfigManager {
  return {
    readConfig: vi.fn().mockResolvedValue({
      config: { image: "node:18" },
      configPath: "/project/.devcontainer/devcontainer.json",
      parseErrors: [],
    }),
    validateConfig: vi
      .fn()
      .mockReturnValue({ valid: true, errors: [], warnings: [] }),
    getConfigPath: vi.fn().mockResolvedValue({
      fsPath: "/project/.devcontainer/devcontainer.json",
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

function createMockUI(overrides?: Partial<OpenFolderUI>): OpenFolderUI {
  return {
    showProgress: vi.fn().mockImplementation(async (_title, task) => {
      await task({ report: vi.fn() });
    }),
    showError: vi.fn().mockResolvedValue(undefined),
    showInfo: vi.fn().mockResolvedValue(undefined),
    openWindow: vi.fn().mockResolvedValue(undefined),
    promptCreateConfig: vi.fn().mockResolvedValue(false),
    showBuildLog: vi.fn(),
    pickFolder: vi.fn().mockResolvedValue("/project"),
    pickConfig: vi
      .fn()
      .mockResolvedValue("/project/.devcontainer/devcontainer.json"),
    ...overrides,
  };
}

function createMockGitConfigCopier(): IGitConfigCopier {
  return { copyGitConfig: vi.fn().mockResolvedValue(undefined) };
}

describe("openFolderInContainer", () => {
  let deps: WorkflowDependencies;
  let ui: OpenFolderUI;

  beforeEach(() => {
    vi.clearAllMocks();
    (launch as ReturnType<typeof vi.fn>).mockResolvedValue({
      containerId: "abc123",
      remoteUser: "vscode",
      remoteWorkspaceFolder: "/workspaces/project",
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

  it("completes the full workflow with pre-selected folder", async () => {
    await openFolderInContainer(deps, ui, { folder: "/project" });

    expect(deps.configManager.getConfigPath).toHaveBeenCalledWith({
      fsPath: "/project",
    });
    expect(launch).toHaveBeenCalled();
    expect(deps.serverManager.ensureInstalled).toHaveBeenCalledWith("abc123");
    expect(deps.serverManager.start).toHaveBeenCalledWith("abc123");
    expect(ui.openWindow).toHaveBeenCalled();
  });

  it("uses folder picker when no pre-selected folder", async () => {
    const pickFolderMock = vi.fn().mockResolvedValue("/picked-folder");
    ui = createMockUI({ pickFolder: pickFolderMock });

    await openFolderInContainer(deps, ui, {});

    expect(pickFolderMock).toHaveBeenCalled();
    expect(deps.configManager.getConfigPath).toHaveBeenCalledWith({
      fsPath: "/picked-folder",
    });
    expect(launch).toHaveBeenCalled();
  });

  it("returns without error when user cancels folder picker", async () => {
    ui = createMockUI({ pickFolder: vi.fn().mockResolvedValue(undefined) });

    await openFolderInContainer(deps, ui, {});

    expect(launch).not.toHaveBeenCalled();
  });

  it("detects existing config and uses it", async () => {
    deps.configManager = createMockConfigManager({
      getConfigPath: vi.fn().mockResolvedValue({
        fsPath: "/project/.devcontainer/devcontainer.json",
      }),
    });

    await openFolderInContainer(deps, ui, { folder: "/project" });

    expect(deps.configManager.getConfigPath).toHaveBeenCalledWith({
      fsPath: "/project",
    });
    expect(launch).toHaveBeenCalled();
  });

  it("prompts to create config when none found", async () => {
    deps.configManager = createMockConfigManager({
      getConfigPath: vi.fn().mockResolvedValue(undefined),
    });
    const promptMock = vi.fn().mockResolvedValue(false);
    ui = createMockUI({
      promptCreateConfig: promptMock,
      pickFolder: vi.fn().mockResolvedValue("/project"),
    });

    await openFolderInContainer(deps, ui, {});

    expect(promptMock).toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it("throws on config parse errors", async () => {
    deps.configManager = createMockConfigManager({
      readConfig: vi.fn().mockResolvedValue({
        config: { image: "node:18" },
        configPath: "/project/.devcontainer/devcontainer.json",
        parseErrors: [
          { message: "Bad JSON", offset: 1, length: 1, line: 1, column: 2 },
        ],
      }),
    });

    await expect(
      openFolderInContainer(deps, ui, { folder: "/project" }),
    ).rejects.toThrow("devcontainer.json has parse errors");
  });

  it("shows progress during build", async () => {
    await openFolderInContainer(deps, ui, { folder: "/project" });

    expect(ui.showProgress).toHaveBeenCalledWith(
      `${BRAND}: Open Folder in Container`,
      expect.any(Function),
    );
  });

  it("shows build log messages during server setup", async () => {
    await openFolderInContainer(deps, ui, { folder: "/project" });

    expect(ui.showBuildLog).toHaveBeenCalledWith(
      expect.stringContaining("Installing"),
    );
    expect(ui.showBuildLog).toHaveBeenCalledWith(
      expect.stringContaining("Copying Git config"),
    );
  });

  it("throws when launch fails", async () => {
    (launch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Build failed"),
    );

    await expect(
      openFolderInContainer(deps, ui, { folder: "/project" }),
    ).rejects.toThrow("Build failed");
  });

  it("completes workflow when user provides configFile directly", async () => {
    await openFolderInContainer(deps, ui, {
      folder: "/project",
      configFile: "/custom/config.json",
    });

    expect(deps.configManager.getConfigPath).not.toHaveBeenCalled();
    expect(launch).toHaveBeenCalled();
  });
});
