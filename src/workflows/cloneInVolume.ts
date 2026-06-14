/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { URI } from "vscode-uri";
import { encodeAuthority } from "../utils/uriUtils";
import { dockerVolumeCreate, dockerRun } from "../utils/dockerUtils";
import { BRAND, BRAND_PREFIX } from "../utils/constants";
import type { WorkflowDependencies, WorkflowUI } from "./types";
import { launchProvision, withDefaults } from "../devcontainer/api";
import { ProvisionFailedError } from "../devcontainer/provisionError";
import { connectToContainer } from "./postLaunch";

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
  const { orchestrator } = deps;

  try {
    const repoUrl = params.repoUrl ?? (await ui.promptRepoUrl());
    if (!repoUrl) {
      return undefined;
    }

    const volumeName = generateVolumeName(repoUrl);

    let configFile: string | undefined;

    await ui.showProgress(`${BRAND}: Cloning Repository`, async (progress) => {
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
    });

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

    const buildResult = await orchestrator.run({
      name: "Clone Repository in Volume",

      config: async () => {
        // Volumes have no local config; no-op.
      },

      build: {
        label: `${BRAND}: Building Container`,

        run: async (_progress) => {
          let result:
            | {
                containerId: string;
                remoteUser: string;
                remoteWorkspaceFolder: string;
              }
            | undefined;

          await ui.showProgress(
            `${BRAND}: Building Container`,
            async (progress) => {
              progress.report({ message: "Building container..." });

              const options = withDefaults({
                workspaceFolder: "/workspace",
                configFile: configFile ? URI.file(configFile) : undefined,
                additionalMounts: [
                  `source=${volumeName},target=/workspace,type=volume`,
                ],
                log: (text: string) => ui.showBuildLog(text),
              });

              result = await launchProvision(options, undefined);
            },
          );

          await (result as any)?.finishBackgroundTasks?.();

          if (!result?.containerId) {
            throw new Error("CLI did not return a container ID");
          }

          return {
            containerId: result.containerId,
            remoteUser: result.remoteUser,
            remoteWorkspaceFolder: result.remoteWorkspaceFolder,
          };
        },
      },
    });

    if (!buildResult) return undefined;

    await connectToContainer(deps, ui, buildResult.containerId);

    ui.showInfo(`${BRAND_PREFIX} Container ready, opening workspace.`);

    const authority = encodeAuthority("artizo-container", repoUrl);
    await ui.openWindow(`vscode-remote://${authority}/workspace`);

    return { volumeName, containerId: buildResult.containerId };
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    orchestrator.fail(error);

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