/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/devcontainer/templates", () => ({
  templates: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" }),
  features: vi.fn().mockResolvedValue({
    exitCode: 0,
    stdout: JSON.stringify([
      {
        id: "ghcr.io/devcontainers/features/git:1",
        name: "Git",
        description: "Git VCS",
      },
      {
        id: "ghcr.io/devcontainers/features/node:1",
        name: "Node.js",
        description: "Node runtime",
      },
    ]),
    stderr: "",
  }),
}));

import { templates, features } from "../../src/devcontainer/templates";
import {
  configWizard,
  parseTemplateList,
  parseFeatureList,
} from "../../src/workflows/configWizard";
import { WorkflowOrchestrator } from "../../src/workflows/orchestrator";
import type { WorkflowDependencies } from "../../src/workflows/types";
import type { ConfigWizardUI } from "../../src/workflows/configWizard";
import type { IConfigManager } from "../../src/config/configManager";
import type { IServerManager } from "../../src/remote/serverManager";
import type { ICommunicationBridge } from "../../src/remote/communicationBridge";
import type { IGitConfigCopier } from "../../src/credentials/gitConfigCopier";

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
    getConfigPath: vi
      .fn()
      .mockReturnValue("/workspace/.devcontainer/devcontainer.json"),
  };
}

function createMockServerManager(): IServerManager {
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
  };
}

function createMockBridge(): ICommunicationBridge {
  return {
    connect: vi
      .fn()
      .mockResolvedValue({ send: vi.fn(), onData: vi.fn(), onClose: vi.fn() }),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(false),
    onDidDisconnect: vi.fn(),
  };
}

function createMockGitConfigCopier(): IGitConfigCopier {
  return { copyGitConfig: vi.fn().mockResolvedValue(undefined) };
}

describe("configWizard", () => {
  let deps: WorkflowDependencies;
  let ui: ConfigWizardUI;

  beforeEach(() => {
    vi.clearAllMocks();
    (templates as ReturnType<typeof vi.fn>).mockResolvedValue({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    (features as ReturnType<typeof vi.fn>).mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify([
        {
          id: "ghcr.io/devcontainers/features/git:1",
          name: "Git",
          description: "Git VCS",
        },
        {
          id: "ghcr.io/devcontainers/features/node:1",
          name: "Node.js",
          description: "Node runtime",
        },
      ]),
      stderr: "",
    });
    deps = {
      configManager: createMockConfigManager(),
      serverManager: createMockServerManager(),
      bridge: createMockBridge(),
      orchestrator: new WorkflowOrchestrator(),
      gitConfigCopier: createMockGitConfigCopier(),
    };
    ui = {
      showProgress: vi.fn().mockImplementation(async (_t, task) => {
        await task({ report: vi.fn() });
      }),
      showError: vi.fn().mockResolvedValue(undefined),
      showInfo: vi.fn().mockResolvedValue(undefined),
      openWindow: vi.fn().mockResolvedValue(undefined),
      promptCreateConfig: vi.fn().mockResolvedValue(false),
      showBuildLog: vi.fn(),
      pickTemplate: vi.fn().mockResolvedValue({
        id: "template-1",
        name: "Node.js",
        description: "Node",
      }),
      pickFeatures: vi.fn().mockResolvedValue([]),
      pickCustomImage: vi.fn().mockResolvedValue(undefined),
      confirmAfterCreate: vi.fn().mockResolvedValue("done"),
    };
  });

  it("completes wizard flow successfully", async () => {
    const result = await configWizard(deps, ui, {
      workspaceFolder: "/workspace",
    });

    expect(result).toBeDefined();
    expect(result!.templateId).toBe("template-1");
    expect(features).toHaveBeenCalledWith({ list: true });
    expect(templates).toHaveBeenCalled();
  });

  it("returns undefined when user cancels template selection", async () => {
    ui.pickTemplate = vi.fn().mockResolvedValue(undefined);

    const result = await configWizard(deps, ui, {
      workspaceFolder: "/workspace",
    });

    expect(result).toBeUndefined();
    expect(templates).not.toHaveBeenCalled();
  });

  it("throws when template generation fails", async () => {
    (templates as ReturnType<typeof vi.fn>).mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: "Generation failed",
    });

    await expect(
      configWizard(deps, ui, { workspaceFolder: "/workspace" }),
    ).rejects.toThrow("Failed to generate configuration");
  });

  it("shows features picker when features are available", async () => {
    const pickFeaturesMock = vi.fn().mockResolvedValue([
      {
        id: "ghcr.io/devcontainers/features/git:1",
        name: "Git",
        description: "Git VCS",
      },
    ]);
    ui.pickFeatures = pickFeaturesMock;

    await configWizard(deps, ui, { workspaceFolder: "/workspace" });

    expect(pickFeaturesMock).toHaveBeenCalled();
    expect(templates).toHaveBeenCalledWith(
      expect.objectContaining({
        features: ["ghcr.io/devcontainers/features/git:1"],
      }),
    );
  });

  it("offers to reopen in container", async () => {
    const confirmMock = vi.fn().mockResolvedValue("reopen");
    ui.confirmAfterCreate = confirmMock;

    await configWizard(deps, ui, { workspaceFolder: "/workspace" });

    expect(confirmMock).toHaveBeenCalled();
  });

  it("handles features parse errors gracefully", async () => {
    (features as ReturnType<typeof vi.fn>).mockResolvedValue({
      exitCode: 0,
      stdout: "invalid json {{{",
      stderr: "",
    });

    await configWizard(deps, ui, { workspaceFolder: "/workspace" });

    // Should not throw; parse errors produce empty feature list
    expect(templates).toHaveBeenCalled();
  });
});

describe("parseTemplateList", () => {
  it("parses valid template JSON", () => {
    const stdout = JSON.stringify([
      { id: "t1", name: "Node", description: "Node.js template" },
    ]);
    const result = parseTemplateList(stdout);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("t1");
  });

  it("returns empty array for invalid JSON", () => {
    expect(parseTemplateList("not json")).toEqual([]);
  });
});

describe("parseFeatureList", () => {
  it("parses feature array", () => {
    const stdout = JSON.stringify([
      { id: "f1", name: "Git", description: "Git feature" },
    ]);
    const result = parseFeatureList(stdout);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("f1");
  });

  it("parses nested features object", () => {
    const stdout = JSON.stringify({
      features: [{ id: "f1", name: "Git", description: "Git" }],
    });
    const result = parseFeatureList(stdout);
    expect(result).toHaveLength(1);
  });

  it("returns empty array for invalid input", () => {
    expect(parseFeatureList("")).toEqual([]);
    expect(parseFeatureList("not json")).toEqual([]);
  });
});