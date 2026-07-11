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
  buildIdentityLabels,
  finishBackgroundTasks,
  buildAuthorityAndOpen,
  throwIfCancelled,
  CancelledError,
} from "./postLaunch";
import type { ReadConfigResult } from "../config/configManager";

export interface OpenFolderUI extends WorkflowUI {
  pickFolder(): Promise<string | undefined>;
  pickConfig(configs: string[]): Promise<string | undefined>;
}

export interface OpenFolderParams {
  folder?: string;
  folderUri?: vscode.Uri;
  configFile?: string;
  forceNewWindow?: boolean;
}

export async function openFolderInContainer(
  deps: WorkflowDependencies,
  ui: OpenFolderUI,
  params: OpenFolderParams,
): Promise<void> {
  const { configManager } = deps;

  let configResult: ReadConfigResult;
  let perContainerDisable: boolean;

  try {
    const folder = params.folder ?? (await ui.pickFolder());
    if (!folder) {
      return;
    }
    const folderUri = params.folderUri ?? vscode.Uri.file(folder);

    // Resolve config file before the build phase (UI dependency).
    let configFile = params.configFile;
    if (!configFile) {
      const existingConfigPath = await configManager.getConfigPath(folderUri);
      if (existingConfigPath) {
        configFile = existingConfigPath.fsPath;
      } else {
        const shouldCreate = await ui.promptCreateConfig();
        if (!shouldCreate) {
          return;
        }
        const newConfigPath = await configManager.getConfigPath(folderUri);
        if (!newConfigPath) {
          return;
        }
        configFile = newConfigPath.fsPath;
      }
    }

    // Config phase
    configResult = await configManager.readConfig(folderUri);
    if (configResult.config && configResult.parseErrors.length > 0) {
      const errorMessages = configResult.parseErrors
        .map((e) => `Line ${e.line}: ${e.message}`)
        .join("\n");
      throw new Error(`devcontainer.json has parse errors:\n${errorMessages}`);
    }
    perContainerDisable = !!(
      configResult.config as Record<string, unknown> | undefined
    )?.["disableCopyGitConfig"];

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
      `${BRAND}: Open Folder in Container`,
      async (progress, token) => {
        progress.report({ message: "Building container..." });

        const platformTarget = (await getPlatformAdapter()).name.toLowerCase();
        const idLabels = buildIdentityLabels({
          platformTarget,
          workspaceFolder: folder,
          configPath: configFile,
        });
        const options = withDefaults({
          workspaceFolder: folder,
          configFile: configFile ? URI.file(configFile) : undefined,
          additionalLabels: idLabels,
          log: (text: string) => ui.showBuildLog(text),
        });

        result = await launchProvision(
          options,
          configResult.configPath,
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

    const connectInfo = await connectToContainer(
      deps,
      ui,
      buildResult.containerId,
      perContainerDisable,
      configResult!.config as Record<string, unknown> | undefined,
    );

    ui.showInfo(
      `${BRAND_PREFIX} Container ready. Opening workspace in a new window.`,
    );

    await buildAuthorityAndOpen({
      deps,
      ui,
      scheme: "artizo-container",
      id: folder,
      containerId: buildResult.containerId,
      containerPort: connectInfo.port,
      installPath: connectInfo.installPath,
      connectionToken: connectInfo.connectionToken,
      workspaceFolder: folder,
      workspacePath: folder,
      uriPath: folder.startsWith("/")
        ? folder
        : "/" + folder.replace(/\\/g, "/"),
      windowOptions: params.forceNewWindow
        ? { forceNewWindow: true }
        : { forceReuseWindow: true },
    });
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));

    if (error instanceof CancelledError) {
      return;
    }

    if (error instanceof ProvisionFailedError) {
      throw error;
    }

    await ui.showError(
      `${BRAND_PREFIX} Failed to open folder in container: ${error.message}`,
      "Retry",
      "Cancel",
    );

    throw error;
  }
}
