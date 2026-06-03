/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as vscode from "vscode";
import type { VscodeWorkflowUI } from "../workflows/vscodeUI";
import type { OpenFolderUI } from "../workflows/openFolder";
import type {
  ConfigWizardUI,
  DevContainerTemplate,
  DevContainerFeature,
} from "../workflows/configWizard";
import { isValidImageRef } from "../workflows/configWizard";
import type { CloneInVolumeUI } from "../workflows/cloneInVolume";
import type { RunningContainer } from "../workflows/attachToContainer";

/** Build an OpenFolderUI adapter. */
export function buildOpenFolderUI(ui: VscodeWorkflowUI): OpenFolderUI {
  return {
    showProgress: ui.showProgress.bind(ui),
    showError: ui.showError.bind(ui),
    showInfo: ui.showInfo.bind(ui),
    openWindow: ui.openWindow.bind(ui),
    promptCreateConfig: ui.promptCreateConfig.bind(ui),
    showBuildLog: ui.showBuildLog.bind(ui),
    async pickFolder() {
      const result = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        openLabel: "Open in Container",
      });
      return result?.[0]?.fsPath;
    },
    async pickConfig(configs: string[]) {
      const picked = await vscode.window.showQuickPick(configs, {
        placeHolder: "Select a devcontainer configuration",
      });
      return picked;
    },
  };
}

/** Build a ConfigWizardUI adapter. */
export function buildConfigWizardUI(ui: VscodeWorkflowUI): ConfigWizardUI {
  return {
    showProgress: ui.showProgress.bind(ui),
    showError: ui.showError.bind(ui),
    showInfo: ui.showInfo.bind(ui),
    openWindow: ui.openWindow.bind(ui),
    promptCreateConfig: ui.promptCreateConfig.bind(ui),
    showBuildLog: ui.showBuildLog.bind(ui),
    async pickTemplate(templates: DevContainerTemplate[]) {
      const items: (vscode.QuickPickItem & {
        template?: DevContainerTemplate;
      })[] = [
        ...templates.map((t) => ({
          label: t.name,
          description: t.description,
          template: t,
        })),
        {
          label: "$(edit) Custom image...",
          description: "Enter a Docker image reference directly",
          template: undefined,
        },
      ];
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: "Select a dev container template",
      });
      if (!picked) {
        return undefined;
      }
      if (picked.template) {
        return picked.template;
      }
      return { id: "__custom__", name: "Custom", description: "" };
    },
    async pickCustomImage() {
      const image = await vscode.window.showInputBox({
        prompt:
          "Enter a Docker image reference (e.g. alpine, ubuntu:22.04, ghcr.io/owner/image:tag)",
        placeHolder: "alpine",
        validateInput: (value) => isValidImageRef(value),
      });
      return image || undefined;
    },
    async pickFeatures(features: DevContainerFeature[]) {
      const items = features.map((f) => ({
        label: f.name,
        description: f.description,
        picked: false,
      }));
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: "Select features to include (ESC to skip)",
        canPickMany: true,
      });
      return features.filter((f) => picked?.some((p) => p.label === f.name));
    },
    async confirmAfterCreate() {
      const choice = await vscode.window.showInformationMessage(
        "Configuration created. What would you like to do?",
        "Reopen in Container",
        "Edit Config",
        "Done",
      );
      if (choice === "Reopen in Container") {
        return "reopen";
      }
      if (choice === "Edit Config") {
        return "edit";
      }
      return "done";
    },
  };
}

/** Build a CloneInVolumeUI adapter with a pre-obtained repo URL. */
export function buildCloneInVolumeUI(
  ui: VscodeWorkflowUI,
  repoUrl: string,
): CloneInVolumeUI {
  return {
    showProgress: ui.showProgress.bind(ui),
    showError: ui.showError.bind(ui),
    showInfo: ui.showInfo.bind(ui),
    openWindow: ui.openWindow.bind(ui),
    promptCreateConfig: ui.promptCreateConfig.bind(ui),
    showBuildLog: ui.showBuildLog.bind(ui),
    async promptRepoUrl() {
      return repoUrl;
    },
    async pickTemplate(templates: string[]) {
      const picked = await vscode.window.showQuickPick(templates, {
        placeHolder: "Select a devcontainer template",
      });
      return picked;
    },
  };
}

/** Build an AttachToContainer UI adapter. */
export function buildAttachUI(ui: VscodeWorkflowUI) {
  return {
    showProgress: ui.showProgress.bind(ui),
    showError: ui.showError.bind(ui),
    showInfo: ui.showInfo.bind(ui),
    openWindow: ui.openWindow.bind(ui),
    promptCreateConfig: ui.promptCreateConfig.bind(ui),
    showBuildLog: ui.showBuildLog.bind(ui),
    async pickContainer(containers: RunningContainer[]) {
      const items = containers.map((c) => ({
        label: c.name,
        description: `${c.image} (${c.status})`,
        detail: c.id,
      }));
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: "Select a container to attach to",
      });
      return containers.find(
        (c) => items.find((i) => i.label === picked?.label)?.detail === c.id,
      );
    },
  };
}

/** Build the Docker list dependency for attachToContainer. */
export function buildDockerLister() {
  return {
    async listRunningContainers() {
      const { dockerExecPolicy } = await import("../docker/execPolicy.js");
      const result = await dockerExecPolicy([
        "ps",
        "--format",
        "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}",
      ]);
      if (result.exitCode !== 0)
        throw new Error(`docker ps failed: ${result.stderr}`);
      const lines = result.stdout.trim().split("\n").filter(Boolean);
      return lines.map((line) => {
        const [id, name, image, status] = line.split("\t");
        return { id, name, image, status };
      });
    },
  };
}