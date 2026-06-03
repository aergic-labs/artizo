/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("vscode", () => ({
  window: {
    showQuickPick: vi.fn(),
    showInputBox: vi.fn(),
    showInformationMessage: vi.fn(),
    showOpenDialog: vi.fn(),
  },
}));

import * as vscode from "vscode";
import type { VscodeWorkflowUI } from "../../src/workflows/vscodeUI";
import type {
  DevContainerTemplate,
  DevContainerFeature,
} from "../../src/workflows/configWizard";
import type { RunningContainer } from "../../src/workflows/attachToContainer";
import {
  buildOpenFolderUI,
  buildConfigWizardUI,
  buildCloneInVolumeUI,
  buildAttachUI,
} from "../../src/host/adapters";

/** Stub VscodeWorkflowUI. Only the methods that get `.bind()`-ed */
function stubUi(): VscodeWorkflowUI {
  return {
    showProgress: vi.fn() as any,
    showError: vi.fn() as any,
    showInfo: vi.fn() as any,
    openWindow: vi.fn() as any,
    promptCreateConfig: vi.fn() as any,
    showBuildLog: vi.fn() as any,
    dispose: vi.fn(),
  } as unknown as VscodeWorkflowUI;
}

function makeTemplate(name: string, description = ""): DevContainerTemplate {
  return { id: name.toLowerCase(), name, description };
}

function makeFeature(name: string, description = ""): DevContainerFeature {
  return { id: name.toLowerCase(), name, description };
}

function makeContainer(
  id: string,
  name: string,
  image: string,
  status: string,
): RunningContainer {
  return { id, name, image, status };
}

describe("adapters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("buildOpenFolderUI", () => {
    describe("pickFolder", () => {
      it("returns fsPath of selected folder", async () => {
        const ui = stubUi();
        const adapter = buildOpenFolderUI(ui);
        vi.mocked(vscode.window.showOpenDialog).mockResolvedValue([
          { fsPath: "/my/project" } as any,
        ]);

        const result = await adapter.pickFolder();

        expect(result).toBe("/my/project");
      });

      it("returns undefined when dialog cancelled", async () => {
        const ui = stubUi();
        const adapter = buildOpenFolderUI(ui);
        vi.mocked(vscode.window.showOpenDialog).mockResolvedValue(undefined);

        const result = await adapter.pickFolder();

        expect(result).toBeUndefined();
      });

      it("opens folder dialog with correct options", async () => {
        const ui = stubUi();
        const adapter = buildOpenFolderUI(ui);
        vi.mocked(vscode.window.showOpenDialog).mockResolvedValue(undefined);

        await adapter.pickFolder();

        expect(vscode.window.showOpenDialog).toHaveBeenCalledWith({
          canSelectFolders: true,
          canSelectFiles: false,
          canSelectMany: false,
          openLabel: "Open in Container",
        });
      });
    });

    describe("pickConfig", () => {
      it("returns the picked config name", async () => {
        const ui = stubUi();
        const adapter = buildOpenFolderUI(ui);
        vi.mocked(vscode.window.showQuickPick).mockResolvedValue(
          "ubuntu" as any,
        );

        const result = await adapter.pickConfig(["alpine", "ubuntu"]);

        expect(result).toBe("ubuntu");
      });

      it("passes configs to showQuickPick", async () => {
        const ui = stubUi();
        const adapter = buildOpenFolderUI(ui);
        vi.mocked(vscode.window.showQuickPick).mockResolvedValue(undefined);

        await adapter.pickConfig(["alpine", "ubuntu"]);

        expect(vscode.window.showQuickPick).toHaveBeenCalledWith(
          ["alpine", "ubuntu"],
          { placeHolder: "Select a devcontainer configuration" },
        );
      });
    });
  });

  describe("buildConfigWizardUI", () => {
    describe("pickTemplate", () => {
      it("builds items from template list with custom image option", async () => {
        const ui = stubUi();
        const adapter = buildConfigWizardUI(ui);
        const templates = [makeTemplate("Ubuntu"), makeTemplate("Python")];
        vi.mocked(vscode.window.showQuickPick).mockResolvedValue(undefined);

        await adapter.pickTemplate(templates);

        const items = vi.mocked(vscode.window.showQuickPick).mock
          .calls[0][0] as any[];
        expect(items).toHaveLength(3);
        expect(items[0].label).toBe("Ubuntu");
        expect(items[0].template).toEqual(templates[0]);
        expect(items[1].label).toBe("Python");
        expect(items[2].label).toBe("$(edit) Custom image...");
        expect(items[2].template).toBeUndefined();
      });

      it("returns the picked template", async () => {
        const ui = stubUi();
        const adapter = buildConfigWizardUI(ui);
        const templates = [makeTemplate("Ubuntu")];
        vi.mocked(vscode.window.showQuickPick).mockResolvedValue({
          label: "Ubuntu",
          description: "",
          template: templates[0],
        } as any);

        const result = await adapter.pickTemplate(templates);

        expect(result).toEqual(templates[0]);
      });

      it("returns Custom when custom image option picked", async () => {
        const ui = stubUi();
        const adapter = buildConfigWizardUI(ui);
        vi.mocked(vscode.window.showQuickPick).mockResolvedValue({
          label: "$(edit) Custom image...",
          template: undefined,
        } as any);

        const result = await adapter.pickTemplate([makeTemplate("Ubuntu")]);

        expect(result).toEqual({
          id: "__custom__",
          name: "Custom",
          description: "",
        });
      });

      it("returns undefined when QuickPick cancelled", async () => {
        const ui = stubUi();
        const adapter = buildConfigWizardUI(ui);
        vi.mocked(vscode.window.showQuickPick).mockResolvedValue(undefined);

        const result = await adapter.pickTemplate([makeTemplate("Ubuntu")]);

        expect(result).toBeUndefined();
      });
    });

    describe("pickCustomImage", () => {
      it("returns the entered image name", async () => {
        const ui = stubUi();
        const adapter = buildConfigWizardUI(ui);
        vi.mocked(vscode.window.showInputBox).mockResolvedValue(
          "alpine:latest",
        );

        const result = await adapter.pickCustomImage();

        expect(result).toBe("alpine:latest");
      });

      it("returns undefined when input cancelled", async () => {
        const ui = stubUi();
        const adapter = buildConfigWizardUI(ui);
        vi.mocked(vscode.window.showInputBox).mockResolvedValue(undefined);

        const result = await adapter.pickCustomImage();

        expect(result).toBeUndefined();
      });

      it("uses isValidImageRef as validator", async () => {
        const ui = stubUi();
        const adapter = buildConfigWizardUI(ui);
        vi.mocked(vscode.window.showInputBox).mockResolvedValue("alpine");

        await adapter.pickCustomImage();

        const opts = vi.mocked(vscode.window.showInputBox).mock
          .calls[0][0] as any;
        expect(opts.validateInput).toBeDefined();
      });
    });

    describe("pickFeatures", () => {
      it("builds items from feature list", async () => {
        const ui = stubUi();
        const adapter = buildConfigWizardUI(ui);
        const features = [makeFeature("Docker-in-Docker"), makeFeature("Git")];
        vi.mocked(vscode.window.showQuickPick).mockResolvedValue(undefined);

        await adapter.pickFeatures(features);

        const items = vi.mocked(vscode.window.showQuickPick).mock
          .calls[0][0] as any[];
        expect(items).toHaveLength(2);
        expect(items[0].label).toBe("Docker-in-Docker");
        expect(items[0].picked).toBe(false);
      });

      it("filters features to only picked ones", async () => {
        const ui = stubUi();
        const adapter = buildConfigWizardUI(ui);
        const features = [makeFeature("A"), makeFeature("B"), makeFeature("C")];
        vi.mocked(vscode.window.showQuickPick).mockResolvedValue([
          { label: "A" },
          { label: "C" },
        ] as any);

        const result = await adapter.pickFeatures(features);

        expect(result).toEqual([features[0], features[2]]);
      });

      it("returns empty array when nothing picked", async () => {
        const ui = stubUi();
        const adapter = buildConfigWizardUI(ui);
        vi.mocked(vscode.window.showQuickPick).mockResolvedValue(undefined);

        const result = await adapter.pickFeatures([makeFeature("A")]);

        expect(result).toEqual([]);
      });

      it("enables multi-select", async () => {
        const ui = stubUi();
        const adapter = buildConfigWizardUI(ui);
        vi.mocked(vscode.window.showQuickPick).mockResolvedValue(undefined);

        await adapter.pickFeatures([makeFeature("A")]);

        const opts = vi.mocked(vscode.window.showQuickPick).mock
          .calls[0][1] as any;
        expect(opts.canPickMany).toBe(true);
      });
    });

    describe("confirmAfterCreate", () => {
      it('returns "reopen" when user picks Reopen', async () => {
        const ui = stubUi();
        const adapter = buildConfigWizardUI(ui);
        vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(
          "Reopen in Container" as any,
        );

        const result = await adapter.confirmAfterCreate();

        expect(result).toBe("reopen");
      });

      it('returns "edit" when user picks Edit Config', async () => {
        const ui = stubUi();
        const adapter = buildConfigWizardUI(ui);
        vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(
          "Edit Config" as any,
        );

        const result = await adapter.confirmAfterCreate();

        expect(result).toBe("edit");
      });

      it('returns "done" when user picks Done or cancels', async () => {
        const ui = stubUi();
        const adapter = buildConfigWizardUI(ui);
        vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(
          undefined,
        );

        const result = await adapter.confirmAfterCreate();

        expect(result).toBe("done");
      });
    });
  });

  describe("buildCloneInVolumeUI", () => {
    describe("promptRepoUrl", () => {
      it("returns the pre-obtained repo URL", async () => {
        const ui = stubUi();
        const adapter = buildCloneInVolumeUI(ui, "https://github.com/foo/bar");

        const result = await adapter.promptRepoUrl();

        expect(result).toBe("https://github.com/foo/bar");
      });
    });

    describe("pickTemplate", () => {
      it("delegates to showQuickPick with templates", async () => {
        const ui = stubUi();
        const adapter = buildCloneInVolumeUI(ui, "https://example.com/repo");
        vi.mocked(vscode.window.showQuickPick).mockResolvedValue(
          "ubuntu" as any,
        );

        const result = await adapter.pickTemplate(["alpine", "ubuntu"]);

        expect(result).toBe("ubuntu");
        expect(vscode.window.showQuickPick).toHaveBeenCalledWith(
          ["alpine", "ubuntu"],
          { placeHolder: "Select a devcontainer template" },
        );
      });
    });
  });

  describe("buildAttachUI", () => {
    describe("pickContainer", () => {
      it("builds items from running containers", async () => {
        const ui = stubUi();
        const adapter = buildAttachUI(ui);
        const containers = [
          makeContainer("abc123", "my-dev", "ubuntu:22.04", "running"),
          makeContainer("def456", "web-app", "node:18", "exited"),
        ];
        vi.mocked(vscode.window.showQuickPick).mockResolvedValue(undefined);

        await adapter.pickContainer(containers);

        const items = vi.mocked(vscode.window.showQuickPick).mock
          .calls[0][0] as any[];
        expect(items).toHaveLength(2);
        expect(items[0].label).toBe("my-dev");
        expect(items[0].description).toBe("ubuntu:22.04 (running)");
        expect(items[0].detail).toBe("abc123");
        expect(items[1].label).toBe("web-app");
        expect(items[1].description).toBe("node:18 (exited)");
      });

      it("returns the picked container", async () => {
        const ui = stubUi();
        const adapter = buildAttachUI(ui);
        const containers = [
          makeContainer("abc", "c1", "img:1", "running"),
          makeContainer("def", "c2", "img:2", "running"),
        ];
        vi.mocked(vscode.window.showQuickPick).mockResolvedValue({
          label: "c1",
          description: "img:1 (running)",
          detail: "abc",
        } as any);

        const result = await adapter.pickContainer(containers);

        expect(result).toEqual(containers[0]);
      });

      it("returns undefined when nothing picked", async () => {
        const ui = stubUi();
        const adapter = buildAttachUI(ui);
        vi.mocked(vscode.window.showQuickPick).mockResolvedValue(undefined);

        const result = await adapter.pickContainer([
          makeContainer("abc", "c1", "img:1", "running"),
        ]);

        expect(result).toBeUndefined();
      });
    });
  });
});