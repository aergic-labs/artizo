/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as vscode from "vscode";
import { normalizeFsPath } from "../utils/uriUtils";
import type { VscodeWorkflowUI } from "../workflows/vscodeUI";
import type { OpenFolderUI } from "../workflows/openFolder";
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
      return result?.[0] ? normalizeFsPath(result[0]) : undefined;
    },
    async pickConfig(configs: string[]) {
      const picked = await vscode.window.showQuickPick(configs, {
        placeHolder: "Select a devcontainer configuration",
      });
      return picked;
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
        "--no-trunc",
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
