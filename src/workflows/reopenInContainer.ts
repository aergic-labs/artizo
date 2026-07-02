/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as vscode from "vscode";
import { URI } from "vscode-uri";
import { BRAND, BRAND_PREFIX } from "../utils/constants";
import type { BuildResult, WorkflowDependencies, WorkflowUI } from "./types";
import { launchProvision, withDefaults } from "../devcontainer/api";
import { ProvisionFailedError } from "../devcontainer/provisionError";
import { getPlatformAdapter } from "../platform";
import {
  connectToContainer,
  writeOverrideConfig,
  buildIdentityLabels,
  finishBackgroundTasks,
  buildAuthorityAndOpen,
  throwIfCancelled,
  CancelledError,
} from "./postLaunch";
import type { ReadConfigResult } from "../config/configManager";

export interface ReopenInContainerParams {
  workspaceFolder: string;
  workspaceUri: vscode.Uri;
}

export async function reopenInContainer(
  deps: WorkflowDependencies,
  ui: WorkflowUI,
  params: ReopenInContainerParams,
): Promise<void> {
  const { configManager } = deps;
  const { workspaceFolder, workspaceUri } = params;

  let configResult: ReadConfigResult;
  let perContainerDisable = false;

  let buildResult: BuildResult | null = null;

  try {
    await ui.showProgress(
      `${BRAND}: Reopen in Container`,
      async (progress, token) => {
      // Phase 1: Config
      progress.report({ message: "Reading devcontainer.json..." });
      configResult = await configManager.readConfig(workspaceUri);

      if (!configResult.config) {
        const shouldCreate = await ui.promptCreateConfig();
        if (!shouldCreate) {
          throw new Error("No devcontainer.json. User cancelled");
        }
        throw new Error("No devcontainer.json. Awaiting creation");
      }

      if (configResult.parseErrors.length > 0) {
        const errorMessages = configResult.parseErrors
          .map((e) => `Line ${e.line}: ${e.message}`)
          .join("\n");
        throw new Error(
          `devcontainer.json has parse errors:\n${errorMessages}`,
        );
      }

      perContainerDisable = !!(
        configResult.config as Record<string, unknown> | undefined
      )?.["disableCopyGitConfig"];

      // Phase 2: Build (skip if existing container found)
      progress.report({ message: "Checking for existing container..." });
      const { dockerExecPolicy } = await import("../docker/execPolicy.js");
      const configFilePath = configResult.configPath ?? "";
      const platformTarget = (await getPlatformAdapter()).name.toLowerCase();
      const ids = new Set<string>();
      for (const label of [
        "artizo.local_folder",
        "devcontainer.local_folder",
      ]) {
        const psResult = await dockerExecPolicy([
          "ps",
          "-q",
          "--no-trunc",
          "--filter",
          `label=${label}=${workspaceFolder}`,
          ...(configFilePath
            ? ["--filter", `label=artizo.config_file=${configFilePath}`]
            : []),
          "--filter",
          `label=artizo.target=${platformTarget}`,
        ]);
        for (const id of psResult.stdout.trim().split("\n").filter(Boolean)) {
          ids.add(id);
        }
      }
      const existingContainerId = ids.values().next().value;

      if (existingContainerId) {
        ui.showBuildLog(
          `${BRAND_PREFIX} Found existing container ${existingContainerId.slice(0, 12)}, reconnecting...`,
        );
        // Derive identity from devcontainer.json. workspaceFolder is
        // authoritative from config (or the CLI default /workspaces/<basename>);
        // remoteUser is NOT derivable from config when the image sets USER in
        // its Dockerfile, so leave it empty when unspecified rather than guess.
        // (remoteUser is not consumed by the reopen path; only the workspace
        // path is. Inspect the container's user if a consumer ever needs it.)
        const cfg = configResult.config as Record<string, unknown>;
        const basename =
          workspaceFolder.split(/[\\/]/).filter(Boolean).pop() ?? "";
        buildResult = {
          containerId: existingContainerId,
          remoteUser:
            typeof cfg.remoteUser === "string"
              ? cfg.remoteUser
              : typeof cfg.containerUser === "string"
                ? cfg.containerUser
                : "",
          remoteWorkspaceFolder:
            typeof cfg.workspaceFolder === "string"
              ? cfg.workspaceFolder
              : `/workspaces/${basename}`,
        };
      } else {
        const extraRunArgs = (
          await getPlatformAdapter()
        ).getAdditionalDockerRunArgs();
        const overrideConfigPath =
          extraRunArgs.length > 0 && configResult.configPath
            ? await writeOverrideConfig(
                configResult.configPath,
                configResult.config as Record<string, unknown>,
                extraRunArgs,
              )
            : undefined;

        if (overrideConfigPath) {
          const fs = await import("node:fs/promises");
          const contents = await fs.readFile(overrideConfigPath, "utf-8");
          ui.showBuildLog(
            `${BRAND_PREFIX} Override config at ${overrideConfigPath}:\n${contents}`,
          );
        }

        progress.report({ message: "Building container..." });
        const idLabels = buildIdentityLabels({
          platformTarget,
          workspaceFolder,
          configPath: configResult.configPath,
        });
        const options = withDefaults({
          workspaceFolder,
          removeExistingContainer: true,
          additionalLabels: idLabels,
          configFile: configResult.configPath
            ? URI.file(configResult.configPath)
            : undefined,
          overrideConfigFile: overrideConfigPath
            ? URI.file(overrideConfigPath)
            : undefined,
          log: (text: string) => ui.showBuildLog(text),
        });

        const result = await launchProvision(
          options,
          configResult.configPath,
          undefined,
          idLabels,
        );

        await finishBackgroundTasks(result);

        if (!result?.containerId) {
          throw new Error("CLI did not return a container ID");
        }

        buildResult = {
          containerId: result.containerId,
          remoteUser: result.remoteUser,
          remoteWorkspaceFolder: result.remoteWorkspaceFolder,
        };
      }

      if (!buildResult) return;

      throwIfCancelled(token);
      const connectInfo = await connectToContainer(
        deps,
        ui,
        buildResult.containerId,
        perContainerDisable,
        configResult!.config as Record<string, unknown> | undefined,
        progress,
        token,
      );

      progress.report({ message: "Opening remote window..." });

      const remotePath = buildResult.remoteWorkspaceFolder || "/workspaces";
      await buildAuthorityAndOpen({
        deps,
        ui,
        scheme: "artizo-container",
        id: workspaceFolder,
        containerId: buildResult.containerId,
        containerPort: connectInfo.port,
        installPath: connectInfo.installPath,
        connectionToken: connectInfo.connectionToken,
        workspaceFolder,
        workspacePath: remotePath,
        uriPath: remotePath.startsWith("/") ? remotePath : "/" + remotePath,
        windowOptions: { forceReuseWindow: true },
      });
    });

    ui.showInfo(
      `${BRAND_PREFIX} Container ready. Opening workspace in remote window.`,
    );
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));

    if (error instanceof CancelledError) {
      return;
    }

    if (
      error.message.includes("user cancelled") ||
      error.message.includes("awaiting creation")
    ) {
      return;
    }

    if (error instanceof ProvisionFailedError) {
      throw error;
    }

    await ui.showError(
      `${BRAND_PREFIX} Failed to reopen in container: ${error.message}`,
      "Retry",
      "Open Locally",
    );

    throw error;
  }
}
