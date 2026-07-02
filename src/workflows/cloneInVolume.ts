/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { URI } from "vscode-uri";
import { dockerVolumeCreate, dockerRun } from "../utils/dockerUtils";
import { BRAND, BRAND_PREFIX } from "../utils/constants";
import type { BuildResult, WorkflowDependencies, WorkflowUI } from "./types";
import { launchProvision, withDefaults } from "../devcontainer/api";
import { ProvisionFailedError } from "../devcontainer/provisionError";
import { getPlatformAdapter } from "../platform";
import {
  connectToContainer,
  finishBackgroundTasks,
  buildAuthorityAndOpen,
  throwIfCancelled,
  CancelledError,
} from "./postLaunch";

export interface CloneInVolumeUI extends WorkflowUI {
  promptRepoUrl(): Promise<string | undefined>;
  pickTemplate(templates: string[]): Promise<string | undefined>;
}

export interface CloneInVolumeParams {
  repoUrl?: string;
}

export interface CloneInVolumeResult {
  volumeName: string;
  containerId: string;
}

export function generateVolumeName(repoUrl: string): string {
  const cleaned = repoUrl.replace(/\.git$/, "");
  const parts = cleaned.split(/[/:]/).filter(Boolean);
  const repoName = parts[parts.length - 1] || "repo";
  let hash = 0;
  for (let i = 0; i < repoUrl.length; i++) {
    hash = ((hash << 5) - hash + repoUrl.charCodeAt(i)) | 0;
  }
  const shortHash = Math.abs(hash).toString(36).slice(0, 6);
  return `artizo-${repoName}-${shortHash}`;
}

export async function cloneInVolume(
  deps: WorkflowDependencies,
  ui: CloneInVolumeUI,
  params: CloneInVolumeParams,
): Promise<CloneInVolumeResult | undefined> {
  try {
    const repoUrl = params.repoUrl ?? (await ui.promptRepoUrl());
    if (!repoUrl) {
      return undefined;
    }

    const volumeName = generateVolumeName(repoUrl);

    let configFile: string | undefined;

    await ui.showProgress(
      `${BRAND}: Cloning Repository`,
      async (progress, token) => {
        progress.report({ message: `Cloning ${repoUrl}...` });

        const createResult = await dockerVolumeCreate(volumeName, {
          labels: { "com.artizo.managed": "true" },
        });
        if (createResult.exitCode !== 0) {
          throw new Error(`Failed to create volume: ${createResult.stderr}`);
        }

        progress.report({ message: "Cloning repository into volume..." });
        const cloneResult = await dockerRun({
          image: "alpine/git",
          command: ["clone", repoUrl, "/workspace"],
          volumes: [{ source: volumeName, target: "/workspace" }],
        });
        if (cloneResult.exitCode !== 0) {
          throw new Error(`Failed to clone repository: ${cloneResult.stderr}`);
        }
        throwIfCancelled(token);
      },
    );

    // Detect config
    const checkResult = await dockerRun({
      image: "alpine",
      command: ["test", "-f", "/workspace/.devcontainer/devcontainer.json"],
      volumes: [{ source: volumeName, target: "/workspace" }],
    });

    const hasConfig = checkResult.exitCode === 0;

    if (!hasConfig) {
      const checkAltResult = await dockerRun({
        image: "alpine",
        command: ["test", "-f", "/workspace/.devcontainer.json"],
        volumes: [{ source: volumeName, target: "/workspace" }],
      });

      if (checkAltResult.exitCode !== 0) {
        const template = await ui.pickTemplate([]);
        if (!template) {
          return undefined;
        }
        configFile = undefined;
      }
    }

    // Build phase
    let result:
      | {
          containerId: string;
          remoteUser: string;
          remoteWorkspaceFolder: string;
          finishBackgroundTasks?: () => Promise<void>;
        }
      | undefined;

    await ui.showProgress(
      `${BRAND}: Building Container`,
      async (progress, token) => {
        progress.report({ message: "Building container..." });

        const platformTarget = (await getPlatformAdapter()).name.toLowerCase();
        const idLabels = [
          `artizo.target=${platformTarget}`,
          `artizo.volume_name=${volumeName}`,
          `devcontainer.volume_name=${volumeName}`,
          `artizo.volume_folder=/workspace`,
          `devcontainer.volume_folder=/workspace`,
        ];
        const options = withDefaults({
          workspaceFolder: "/workspace",
          configFile: configFile ? URI.file(configFile) : undefined,
          additionalMounts: [
            `source=${volumeName},target=/workspace,type=volume`,
          ],
          additionalLabels: idLabels,
          log: (text: string) => ui.showBuildLog(text),
        });

        // Clone-in-volume always creates fresh, so no skip-filter.
        result = await launchProvision(options, undefined, undefined, idLabels);
        throwIfCancelled(token);
      },
    );

    await finishBackgroundTasks(result);

    if (!result?.containerId) {
      throw new Error("CLI did not return a container ID");
    }

    const buildResult: BuildResult = {
      containerId: result.containerId,
      remoteUser: result.remoteUser,
      remoteWorkspaceFolder: result.remoteWorkspaceFolder,
    };

    const connectInfo = await connectToContainer(
      deps,
      ui,
      buildResult.containerId,
    );

    ui.showInfo(`${BRAND_PREFIX} Container ready, opening workspace.`);

    await buildAuthorityAndOpen({
      deps,
      ui,
      scheme: "artizo-container",
      id: repoUrl,
      containerId: buildResult.containerId,
      containerPort: connectInfo.port,
      installPath: connectInfo.installPath,
      connectionToken: connectInfo.connectionToken,
      workspaceFolder: repoUrl,
      workspacePath: "/workspace",
      uriPath: "/workspace",
    });

    return { volumeName, containerId: buildResult.containerId };
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));

    if (error instanceof CancelledError) {
      return undefined;
    }

    if (error instanceof ProvisionFailedError) {
      throw error;
    }

    await ui.showError(
      `${BRAND_PREFIX} Failed to clone repository in volume: ${error.message}`,
      "Retry",
      "Cancel",
    );

    throw error;
  }
}
