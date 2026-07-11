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

export interface RebuildContainerParams {
  workspaceFolder: string;
  workspaceUri: vscode.Uri;
  noCache?: boolean;
  reconnect?: boolean;
}

export async function rebuildContainer(
  deps: WorkflowDependencies,
  ui: WorkflowUI,
  params: RebuildContainerParams,
): Promise<void> {
  const { configManager } = deps;
  const { workspaceFolder, workspaceUri, noCache, reconnect } = params;

  let configResult: ReadConfigResult | undefined;
  let perContainerDisable: boolean;

  try {
    // Phase 1: Config
    configResult = await configManager.readConfig(workspaceUri);

    if (!configResult.config) {
      throw new Error("No devcontainer.json found in workspace");
    }

    if (configResult.parseErrors.length > 0) {
      const errorMessages = configResult.parseErrors
        .map((e) => `Line ${e.line}: ${e.message}`)
        .join("\n");
      throw new Error(`devcontainer.json has parse errors:\n${errorMessages}`);
    }

    perContainerDisable = !!(
      configResult.config as Record<string, unknown> | undefined
    )?.["disableCopyGitConfig"];

    // Phase 2: Build
    let result:
      | {
          containerId: string;
          remoteUser: string;
          remoteWorkspaceFolder: string;
          finishBackgroundTasks?: () => Promise<void>;
        }
      | undefined;

    await ui.showProgress(
      `${BRAND}: Rebuilding Container`,
      async (progress, token) => {
        progress.report({
          message: noCache ? "Building without cache..." : "Building...",
        });

        const platformTarget = (await getPlatformAdapter()).name.toLowerCase();
        const idLabels = buildIdentityLabels({
          platformTarget,
          workspaceFolder,
          configPath: configResult!.configPath,
        });
        const options = withDefaults({
          workspaceFolder,
          configFile: configResult!.configPath
            ? URI.file(configResult!.configPath)
            : undefined,
          buildNoCache: noCache ?? false,
          removeExistingContainer: true,
          defaultUserEnvProbe: reconnect ? "loginInteractiveShell" : "none",
          additionalLabels: idLabels,
          log: (text: string) => ui.showBuildLog(text),
        });

        result = await launchProvision(
          options,
          configResult!.configPath,
          undefined,
          idLabels,
        );
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

    if (!reconnect) {
      ui.showBuildLog(`${BRAND_PREFIX} Build complete.`);
      ui.showInfo(`${BRAND_PREFIX} Container image rebuilt successfully.`);
      return;
    }

    if (!buildResult) return;

    const extraRunArgs = (
      await getPlatformAdapter()
    ).getAdditionalDockerRunArgs();
    const overrideConfigPath =
      extraRunArgs.length > 0 && configResult!.configPath
        ? await writeOverrideConfig(
            configResult!.configPath,
            configResult!.config as Record<string, unknown>,
            extraRunArgs,
          )
        : undefined;

    let containerId = buildResult.containerId;
    let remoteWorkspaceFolder = buildResult.remoteWorkspaceFolder;

    if (overrideConfigPath) {
      let relaunchResult:
        | {
            containerId: string;
            remoteUser: string;
            remoteWorkspaceFolder: string;
            finishBackgroundTasks?: () => Promise<void>;
          }
        | undefined;

      await ui.showProgress(
        `${BRAND}: Starting Container`,
        async (progress, token) => {
          progress.report({ message: "Starting container..." });

          const relaunchPlatformTarget = (
            await getPlatformAdapter()
          ).name.toLowerCase();
          const relaunchIdLabels = buildIdentityLabels({
            platformTarget: relaunchPlatformTarget,
            workspaceFolder,
            configPath: configResult!.configPath,
          });
          const upOptions = withDefaults({
            workspaceFolder,
            removeExistingContainer: true,
            additionalLabels: relaunchIdLabels,
            configFile: configResult!.configPath
              ? URI.file(configResult!.configPath)
              : undefined,
            overrideConfigFile: URI.file(overrideConfigPath),
            log: (text: string) => ui.showBuildLog(text),
          });

          relaunchResult = await launchProvision(
            upOptions,
            configResult!.configPath,
            "Container start failed",
            relaunchIdLabels,
          );
          throwIfCancelled(token);
        },
      );

      await finishBackgroundTasks(relaunchResult);

      if (!relaunchResult?.containerId) {
        throw new Error("CLI did not return a container ID on restart");
      }

      containerId = relaunchResult.containerId;
      remoteWorkspaceFolder = relaunchResult.remoteWorkspaceFolder;
    }

    const connectInfo = await connectToContainer(
      deps,
      ui,
      containerId,
      perContainerDisable,
      configResult!.config as Record<string, unknown> | undefined,
    );

    ui.showInfo(
      `${BRAND_PREFIX} Container ready. Opening workspace in remote window.`,
    );

    const remotePath = remoteWorkspaceFolder || "/workspaces";
    await buildAuthorityAndOpen({
      deps,
      ui,
      scheme: "artizo-container",
      id: workspaceFolder,
      containerId,
      containerPort: connectInfo.port,
      installPath: connectInfo.installPath,
      connectionToken: connectInfo.connectionToken,
      workspaceFolder,
      workspacePath: remotePath,
      uriPath: remotePath.startsWith("/") ? remotePath : "/" + remotePath,
      windowOptions: { forceReuseWindow: true },
    });
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));

    if (error instanceof CancelledError) {
      return;
    }

    if (error instanceof ProvisionFailedError) {
      throw error;
    }

    const action = await ui.showError(
      `${BRAND_PREFIX} Container rebuild failed: ${error.message}`,
      "Open Locally",
      "Retry",
    );

    if (action === "Open Locally") {
      return;
    }

    throw error;
  }
}
