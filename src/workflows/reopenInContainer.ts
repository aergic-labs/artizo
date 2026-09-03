/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as vscode from "vscode";
import { URI } from "vscode-uri";
import { BRAND, BRAND_PREFIX } from "../utils/constants";
import type { BuildResult, WorkflowDependencies, WorkflowUI } from "./types";
import { launchProvision, withDefaults } from "../devcontainer/api";
import { readResolvedConfig } from "../devcontainer/readResolvedConfig";
import { ProvisionFailedError } from "../devcontainer/provisionError";
import { getPlatformAdapter } from "../platform";
import { getLogger } from "../utils/logger";
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
  forceNewWindow?: boolean;
}

export async function reopenInContainer(
  deps: WorkflowDependencies,
  ui: WorkflowUI,
  params: ReopenInContainerParams,
): Promise<void> {
  const { configManager } = deps;
  const { workspaceFolder, workspaceUri, forceNewWindow } = params;

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
          "-a",
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
      let existingContainerId = ids.values().next().value;

      // Fallback: if the config file moved (e.g. .devcontainer.json ->
      // .devcontainer/devcontainer.json), the config_file filter would miss
      // the old container. Drop the config_file filter and match on
      // local_folder + target only, so we reconnect instead of building a
      // second container and orphaning the first.
      if (!existingContainerId) {
        const fallbackIds = new Set<string>();
        for (const label of [
          "artizo.local_folder",
          "devcontainer.local_folder",
        ]) {
          const psResult = await dockerExecPolicy([
            "ps",
            "-a",
            "-q",
            "--no-trunc",
            "--filter",
            `label=${label}=${workspaceFolder}`,
            "--filter",
            `label=artizo.target=${platformTarget}`,
          ]);
          for (const id of psResult.stdout.trim().split("\n").filter(Boolean)) {
            fallbackIds.add(id);
          }
        }
        existingContainerId = fallbackIds.values().next().value;
      }

      if (existingContainerId) {
        ui.showBuildLog(
          `${BRAND_PREFIX} Found existing container ${existingContainerId.slice(0, 12)}, reconnecting...`,
        );
        // Config drift check before reusing: this workflow runs on the side
        // that owns Docker (local host or the SSH host), so inspect is local.
        const { dockerInspect } = await import("../utils/dockerUtils.js");
        const { checkContainerConfig } = await import(
          "../remote/configCheck.js"
        );
        const existingInfo = await dockerInspect(existingContainerId);
        const checkResult = await checkContainerConfig(existingInfo);
        if (checkResult === "rebuild") {
          return; // rebuild command opens its own window
        }
        // Reconnect via the CLI so lifecycle hooks run (postStartCommand,
        // postAttachCommand). One-time hooks (onCreateCommand,
        // updateContentCommand, postCreateCommand) are skipped by the
        // CLI's marker-file logic. This matches the official extension,
        // which calls `devcontainer up --expect-existing-container`.
        //
        // If the CLI can't find the container by labels (e.g. config file
        // moved, or container created by another tool), fall back to
        // manual `docker start` — hooks won't run, but the container is
        // reused rather than orphaned.
        const idLabels = await buildIdentityLabels({
          platformTarget,
          workspaceFolder,
          configPath: configResult.configPath,
          config: configResult.config as Record<string, unknown> | undefined,
        });
        const reconnectOptions = withDefaults({
          workspaceFolder,
          additionalLabels: idLabels,
          configFile: configResult.configPath
            ? URI.file(configResult.configPath)
            : undefined,
          expectExistingContainer: true,
          removeExistingContainer: false,
          log: (text: string) => ui.showBuildLog(text),
        });
        try {
          const result = await launchProvision(
            reconnectOptions,
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
        } catch (err) {
          if (
            err instanceof Error &&
            err.message.includes("expected container does not exist")
          ) {
            getLogger().warn(
              `[reopen] CLI could not find container by labels; falling back to manual start`,
            );
            const { dockerExecPolicy } = await import(
              "../docker/execPolicy.js"
            );
            const startResult = await dockerExecPolicy([
              "start",
              existingContainerId,
            ]);
            if (startResult.exitCode !== 0) {
              throw new Error(
                `Failed to start existing container ${existingContainerId.slice(0, 12)}: ${startResult.stderr}`,
              );
            }
            const cfg = configResult.config as Record<string, unknown>;
            const basename =
              workspaceFolder.split(/[\\/]/).filter(Boolean).pop() ?? "";
            // Resolve ${localEnv:...} and friends in workspaceFolder via the
            // CLI's own substitution before it reaches the remote window URI;
            // the raw config value would leak the literal variable into a
            // path that doesn't exist in the container (issue #12).
            let resolvedWorkspaceFolder: string | undefined;
            try {
              resolvedWorkspaceFolder = (
                await readResolvedConfig(
                  workspaceFolder,
                  configResult.configPath!,
                )
              ).workspaceFolder;
            } catch {
              // best effort: fall through to the raw/default value below
            }
            buildResult = {
              containerId: existingContainerId,
              remoteUser:
                typeof cfg.remoteUser === "string"
                  ? cfg.remoteUser
                  : typeof cfg.containerUser === "string"
                    ? cfg.containerUser
                    : "",
              remoteWorkspaceFolder:
                resolvedWorkspaceFolder ??
                (typeof cfg.workspaceFolder === "string"
                  ? cfg.workspaceFolder
                  : `/workspaces/${basename}`),
            };
          } else {
            throw err;
          }
        }
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

        try {
          if (overrideConfigPath) {
            const fs = await import("node:fs/promises");
            const contents = await fs.readFile(overrideConfigPath, "utf-8");
            ui.showBuildLog(
              `${BRAND_PREFIX} Override config at ${overrideConfigPath}:\n${contents}`,
            );
          }

          progress.report({ message: "Building container..." });
          const idLabels = await buildIdentityLabels({
            platformTarget,
            workspaceFolder,
            configPath: configResult.configPath,
            config: configResult.config as Record<string, unknown> | undefined,
          });
          const options = withDefaults({
            workspaceFolder,
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
        } finally {
          if (overrideConfigPath) {
            try {
              const fs = await import("node:fs/promises");
              await fs.unlink(overrideConfigPath);
            } catch {
              // best effort
            }
          }
        }
      }

      if (!buildResult) return;

      throwIfCancelled(token);
      const connectInfo = await connectToContainer(
        deps,
        ui,
        buildResult.containerId,
        perContainerDisable,
        configResult!.config as Record<string, unknown> | undefined,
        buildResult.remoteUser,
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
        windowOptions: forceNewWindow
          ? { forceNewWindow: true }
          : { forceReuseWindow: true },
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
