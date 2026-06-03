/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { URI } from "vscode-uri";
import { encodeAuthority } from "../utils/uriUtils";
import { BRAND, BRAND_PREFIX } from "../utils/constants";
import type { WorkflowDependencies, WorkflowUI } from "./types";
import { launch, withDefaults, ContainerError } from "../devcontainer/api";
import { connectToContainer } from "./postLaunch";
import type { ReadConfigResult } from "../config/configManager";

export interface OpenFolderUI extends WorkflowUI {
  pickFolder(): Promise<string | undefined>;
  pickConfig(configs: string[]): Promise<string | undefined>;
}

export interface OpenFolderParams {
  folder?: string;
  configFile?: string;
  forceNewWindow?: boolean;
}

export async function openFolderInContainer(
  deps: WorkflowDependencies,
  ui: OpenFolderUI,
  params: OpenFolderParams,
): Promise<void> {
  const { configManager, orchestrator } = deps;

  let configResult: ReadConfigResult;
  let perContainerDisable = false;

  try {
    const folder = params.folder ?? (await ui.pickFolder());
    if (!folder) {
      return;
    }

    // Resolve config file before the orchestrator phase (UI dependency).
    let configFile = params.configFile;
    if (!configFile) {
      const existingConfigPath = configManager.getConfigPath(folder);
      if (existingConfigPath) {
        configFile = existingConfigPath;
      } else {
        const shouldCreate = await ui.promptCreateConfig();
        if (!shouldCreate) {
          orchestrator.reset();
          return;
        }
        const newConfigPath = configManager.getConfigPath(folder);
        if (!newConfigPath) {
          orchestrator.reset();
          return;
        }
        configFile = newConfigPath;
      }
    }

    const buildResult = await orchestrator.run({
      name: "Open Folder in Container",

      config: async () => {
        configResult = configManager.readConfig(folder);
        if (configResult.config && configResult.parseErrors.length > 0) {
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
      },

      build: {
        label: `${BRAND}: Open Folder in Container`,

        run: async (_progress) => {
          let result:
            | {
                containerId: string;
                remoteUser: string;
                remoteWorkspaceFolder: string;
              }
            | undefined;

          await ui.showProgress(
            `${BRAND}: Open Folder in Container`,
            async (progress) => {
              progress.report({ message: "Building container..." });

              const options = withDefaults({
                workspaceFolder: folder,
                configFile: configFile ? URI.file(configFile) : undefined,
                log: (text: string) => ui.showBuildLog(text),
              });

              try {
                result = await launch(options, undefined, []);
              } catch (err: unknown) {
                const containerErr = err as InstanceType<typeof ContainerError>;
                if (containerErr?.description) {
                  throw new Error(`Build failed: ${containerErr.description}`);
                }
                throw err;
              }
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

    if (!buildResult) return;

    await connectToContainer(
      deps,
      ui,
      buildResult.containerId,
      perContainerDisable,
    );

    ui.showInfo(
      `${BRAND_PREFIX} Container ready. Opening workspace in a new window.`,
    );

    const authority = encodeAuthority("artizo-container", folder);
    const uriPath = folder.startsWith("/")
      ? folder
      : "/" + folder.replace(/\\/g, "/");
    await ui.openWindow(`vscode-remote://${authority}${uriPath}`, {
      forceNewWindow: true,
    });
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    orchestrator.fail(error);

    await ui.showError(
      `${BRAND_PREFIX} Failed to open folder in container: ${error.message}`,
      "Retry",
      "Cancel",
    );

    throw error;
  }
}