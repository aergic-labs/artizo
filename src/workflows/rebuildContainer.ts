/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as vscode from "vscode";
import { URI } from "vscode-uri";
import { encodeAuthority } from "../utils/uriUtils";
import { BRAND, BRAND_PREFIX } from "../utils/constants";
import { getLogger } from "../utils/logger";
import type { WorkflowDependencies, WorkflowUI } from "./types";
import { launch, withDefaults, ContainerError } from "../devcontainer/api";
import { getPlatformAdapter } from "../platform";
import { connectToContainer, writeOverrideConfig } from "./postLaunch";
import type { ReadConfigResult } from "../config/configManager";

export interface RebuildContainerParams {
  workspaceFolder: string;
  noCache?: boolean;
  reconnect?: boolean;
}

export async function rebuildContainer(
  deps: WorkflowDependencies,
  ui: WorkflowUI,
  params: RebuildContainerParams,
): Promise<void> {
  const { configManager, bridge, orchestrator } = deps;
  const { workspaceFolder, noCache, reconnect } = params;

  let configResult: ReadConfigResult | undefined;
  let perContainerDisable = false;

  try {
    if (bridge.isConnected()) {
      await bridge.disconnect();
    }

    const buildResult = await orchestrator.run({
      name: "Rebuild Container",

      config: async () => {
        configResult = configManager.readConfig(workspaceFolder);

        if (!configResult.config) {
          throw new Error("No devcontainer.json found in workspace");
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
      },

      build: {
        label: `${BRAND}: Rebuilding Container`,

        run: async (_progress) => {
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
            async (progress) => {
              progress.report({
                message: noCache ? "Building without cache..." : "Building...",
              });

              const options = withDefaults({
                workspaceFolder,
                configFile: configResult!.configPath
                  ? URI.file(configResult!.configPath)
                  : undefined,
                buildNoCache: noCache ?? false,
                defaultUserEnvProbe: reconnect
                  ? "loginInteractiveShell"
                  : "none",
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

          if (result?.finishBackgroundTasks) {
            try {
              await result.finishBackgroundTasks();
            } catch (err) {
              getLogger().warn(
                `finishBackgroundTasks failed: ${(err as Error).message}`,
              );
            }
          }

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

    if (!reconnect) {
      orchestrator.reset();
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
        async (progress) => {
          progress.report({ message: "Starting container..." });

          const upOptions = withDefaults({
            workspaceFolder,
            removeExistingContainer: true,
            additionalLabels: [
              `artizo.target=${(await getPlatformAdapter()).name.toLowerCase()}`,
            ],
            configFile: configResult!.configPath
              ? URI.file(configResult!.configPath)
              : undefined,
            overrideConfigFile: URI.file(overrideConfigPath),
            log: (text: string) => ui.showBuildLog(text),
          });

          try {
            relaunchResult = await launch(upOptions, undefined, []);
          } catch (err: unknown) {
            const containerErr = err as InstanceType<typeof ContainerError>;
            if (containerErr?.description) {
              throw new Error(
                `Container start failed: ${containerErr.description}`,
              );
            }
            throw err;
          }
        },
      );

      if (relaunchResult?.finishBackgroundTasks) {
        try {
          await relaunchResult.finishBackgroundTasks();
        } catch (err) {
          getLogger().warn(
            `relaunch finishBackgroundTasks failed: ${(err as Error).message}`,
          );
        }
      }

      if (!relaunchResult?.containerId) {
        throw new Error("CLI did not return a container ID on restart");
      }

      containerId = relaunchResult.containerId;
      remoteWorkspaceFolder = relaunchResult.remoteWorkspaceFolder;
    }

    await connectToContainer(deps, ui, containerId, perContainerDisable);

    ui.showInfo(
      `${BRAND_PREFIX} Container ready. Opening workspace in remote window.`,
    );

    const authority = encodeAuthority("artizo-container", workspaceFolder);
    const remotePath = remoteWorkspaceFolder || "/workspaces";
    const uriPath = remotePath.startsWith("/") ? remotePath : "/" + remotePath;
    await ui.openWindow(`vscode-remote://${authority}${uriPath}`, {
      forceNewWindow: true,
    });
    await new Promise((r) => setTimeout(r, 2500));
    await vscode.commands.executeCommand("workbench.action.closeWindow");
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    orchestrator.fail(error);

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