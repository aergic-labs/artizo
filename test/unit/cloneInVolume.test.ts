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
  Uri: { parse: (s: string) => ({ toString: () => s }) },
}));

vi.mock("../../src/utils/dockerUtils", () => ({
  dockerVolumeCreate: vi
    .fn()
    .mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" }),
  dockerRun: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" }),
  dockerExec: vi
    .fn()
    .mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" }),
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
  cloneInVolume,
  generateVolumeName,
} from "../../src/workflows/cloneInVolume";
import type { WorkflowDependencies } from "../../src/workflows/types";
import type { CloneInVolumeUI } from "../../src/workflows/cloneInVolume";
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
    getExtensionsDir: vi.fn().mockResolvedValue("/tmp/test-extensions"),
    ...overrides,
  };
}

function createMockUI(overrides?: Partial<CloneInVolumeUI>): CloneInVolumeUI {
  return {
    showProgress: vi.fn().mockImplementation(async (_title, task) => {
      await task({ report: vi.fn() });
    }),
    showError: vi.fn().mockResolvedValue(undefined),
    showInfo: vi.fn().mockResolvedValue(undefined),
    openWindow: vi.fn().mockResolvedValue(undefined),
    promptCreateConfig: vi.fn().mockResolvedValue(false),
    showBuildLog: vi.fn(),
    promptRepoUrl: vi
      .fn()
      .mockResolvedValue("https://github.com/user/repo.git"),
    pickTemplate: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createMockGitConfigCopier(): IGitConfigCopier {
  return { copyGitConfig: vi.fn().mockResolvedValue(undefined) };
}

describe("cloneInVolume", () => {
  let deps: WorkflowDependencies;
  let ui: CloneInVolumeUI;

  beforeEach(() => {
    vi.clearAllMocks();
    (launch as ReturnType<typeof vi.fn>).mockResolvedValue({
      containerId: "abc123",
      remoteUser: "vscode",
      remoteWorkspaceFolder: "/workspace",
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

  it("generates deterministic volume names", () => {
    const name = generateVolumeName("https://github.com/owner/repo.git");
    expect(name).toMatch(/^artizo-repo-/);
  });

  it("generates unique names for different repos", () => {
    const name1 = generateVolumeName("https://github.com/owner/repo1.git");
    const name2 = generateVolumeName("https://github.com/owner/repo2.git");
    expect(name1).not.toBe(name2);
  });

  it("completes the full workflow", async () => {
    const result = await cloneInVolume(deps, ui, {
      repoUrl: "https://github.com/user/repo.git",
    });

    expect(result).toBeDefined();
    expect(result!.containerId).toBe("abc123");
    expect(launch).toHaveBeenCalled();
    expect(deps.serverManager.ensureInstalled).toHaveBeenCalledWith("abc123");
    expect(deps.serverManager.start).toHaveBeenCalledWith("abc123");
    expect(ui.openWindow).toHaveBeenCalled();
  });

  it("returns undefined when user cancels repo prompt", async () => {
    ui = createMockUI({ promptRepoUrl: vi.fn().mockResolvedValue(undefined) });

    const result = await cloneInVolume(deps, ui, {});

    expect(result).toBeUndefined();
    expect(launch).not.toHaveBeenCalled();
  });

  it("throws when volume creation fails", async () => {
    const { dockerVolumeCreate } = await import("../../src/utils/dockerUtils");
    (dockerVolumeCreate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      exitCode: 1,
      stdout: "",
      stderr: "No space left on device",
    });

    await expect(
      cloneInVolume(deps, ui, { repoUrl: "https://github.com/user/repo.git" }),
    ).rejects.toThrow("Failed to create volume");
  });

  it("throws when clone fails", async () => {
    const { dockerRun } = await import("../../src/utils/dockerUtils");
    (dockerRun as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      exitCode: 1,
      stdout: "",
      stderr: "Repository not found",
    });

    await expect(
      cloneInVolume(deps, ui, { repoUrl: "https://github.com/user/repo.git" }),
    ).rejects.toThrow("Failed to clone repository");
  });

  it("throws when launch fails", async () => {
    (launch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Build failed"),
    );

    await expect(
      cloneInVolume(deps, ui, { repoUrl: "https://github.com/user/repo.git" }),
    ).rejects.toThrow("Build failed");
  });

  it("shows progress during clone and build", async () => {
    await cloneInVolume(deps, ui, {
      repoUrl: "https://github.com/user/repo.git",
    });

    expect(ui.showProgress).toHaveBeenCalledWith(
      `${BRAND}: Cloning Repository`,
      expect.any(Function),
    );
    expect(ui.showProgress).toHaveBeenCalledWith(
      `${BRAND}: Building Container`,
      expect.any(Function),
    );
  });

  it("shows build log messages during server setup", async () => {
    await cloneInVolume(deps, ui, {
      repoUrl: "https://github.com/user/repo.git",
    });

    expect(ui.showBuildLog).toHaveBeenCalledWith(
      expect.stringContaining("Installing"),
    );
    expect(ui.showBuildLog).toHaveBeenCalledWith(
      expect.stringContaining("Copying Git config"),
    );
  });

  it("passes additionalMounts via options", async () => {
    const { withDefaults } = await import("../../src/devcontainer/api");

    await cloneInVolume(deps, ui, {
      repoUrl: "https://github.com/user/repo.git",
    });

    expect(withDefaults).toHaveBeenCalledWith(
      expect.objectContaining({
        additionalMounts: expect.arrayContaining([
          expect.stringContaining("type=volume"),
        ]),
      }),
    );
  });
});
