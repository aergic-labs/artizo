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

export interface ReopenInContainerParams {
  workspaceFolder: string;
}

export async function reopenInContainer(
  deps: WorkflowDependencies,
  ui: WorkflowUI,
  params: ReopenInContainerParams,
): Promise<void> {
  const { configManager, orchestrator } = deps;
  const { workspaceFolder } = params;

  let configResult: ReadConfigResult;
  let perContainerDisable = false;

  try {
    const buildResult = await orchestrator.run({
      name: "Reopen in Container",

      config: async () => {
        configResult = configManager.readConfig(workspaceFolder);

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
      },

      build: {
        label: `${BRAND}: Reopen in Container`,

        skip: async () => {
          const { dockerExecPolicy } = await import("../docker/execPolicy.js");
          const configFilePath = configResult.configPath ?? "";
          const psResult = await dockerExecPolicy([
            "ps",
            "-q",
            "--filter",
            `label=devcontainer.local_folder=${workspaceFolder}`,
            ...(configFilePath
              ? ["--filter", `label=devcontainer.config_file=${configFilePath}`]
              : []),
          ]);
          const existingContainerId = psResult.stdout.trim();

          if (existingContainerId) {
            // Check if container was built for the current platform variant
            const inspectResult = await dockerExecPolicy([
              "inspect",
              existingContainerId,
              "--format",
              "{{json .Config.Labels}}",
            ]);
            const labels: Record<string, string> =
              inspectResult.exitCode === 0
                ? JSON.parse(inspectResult.stdout.trim() || "{}")
                : {};
            if (
              labels["artizo.target"] !==
              (await getPlatformAdapter()).name.toLowerCase()
            ) {
              ui.showBuildLog(
                `${BRAND_PREFIX} Container was built for ${labels["artizo.target"] || "unknown"} platform, rebuilding for ${(await getPlatformAdapter()).name}.`,
              );
              return null;
            }
          }

          if (!existingContainerId) return null;

          ui.showBuildLog(
            `${BRAND_PREFIX} Found existing container ${existingContainerId.slice(0, 12)}, reconnecting...`,
          );
          return {
            containerId: existingContainerId,
            remoteUser: "vscode",
            remoteWorkspaceFolder: "/workspaces",
          };
        },

        run: async (_progress) => {
          // Write override config with platform-specific runArgs
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

          let result:
            | {
                containerId: string;
                remoteUser: string;
                remoteWorkspaceFolder: string;
              }
            | undefined;

          await ui.showProgress(
            `${BRAND}: Reopen in Container`,
            async (progress) => {
              progress.report({ message: "Building container..." });

              const options = withDefaults({
                workspaceFolder,
                removeExistingContainer: true,
                additionalLabels: [
                  `artizo.target=${(await getPlatformAdapter()).name.toLowerCase()}`,
                ],
                configFile: configResult.configPath
                  ? URI.file(configResult.configPath)
                  : undefined,
                overrideConfigFile: overrideConfigPath
                  ? URI.file(overrideConfigPath)
                  : undefined,
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

          try {
            await (result as any)?.finishBackgroundTasks?.();
          } catch (err) {
            getLogger().warn(
              `finishBackgroundTasks failed: ${(err as Error).message}`,
            );
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

    // buildResult is non-null because this workflow always has a build phase
    // (either real or skipped via existing-container detection)
    if (!buildResult) return;

    await connectToContainer(
      deps,
      ui,
      buildResult.containerId,
      perContainerDisable,
    );

    ui.showInfo(
      `${BRAND_PREFIX} Container ready. Opening workspace in remote window.`,
    );

    const authority = encodeAuthority("artizo-container", workspaceFolder);
    const remotePath = buildResult.remoteWorkspaceFolder || "/workspaces";
    const uriPath = remotePath.startsWith("/") ? remotePath : "/" + remotePath;
    await ui.openWindow(`vscode-remote://${authority}${uriPath}`, {
      forceNewWindow: true,
    });
    await new Promise((r) => setTimeout(r, 2500));
    await vscode.commands.executeCommand("workbench.action.closeWindow");
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));

    // Suppress user-facing error for user-cancelled paths
    if (
      error.message.includes("user cancelled") ||
      error.message.includes("awaiting creation")
    ) {
      orchestrator.reset();
      return;
    }

    orchestrator.fail(error);

    await ui.showError(
      `${BRAND_PREFIX} Failed to reopen in container: ${error.message}`,
      "Retry",
      "Open Locally",
    );

    throw error;
  }
}