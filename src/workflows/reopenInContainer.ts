/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as vscode from "vscode";
import { BRAND, BRAND_PREFIX } from "../utils/constants";
import type {
  LaunchOutcome,
  WorkflowDependencies,
  WorkflowUI,
} from "./types";
import { launchProvision, withDefaults } from "../devcontainer/api";
import { cliFileUri } from "../devcontainer/cliUri";
import { resolveConfigVars } from "../devcontainer/readResolvedConfig";
import { ProvisionFailedError } from "../devcontainer/provisionError";
import { getPlatformAdapter } from "../platform";
import { getLogger } from "../utils/logger";
import { getDockerPath } from "../docker/execPolicy.js";

import {
  connectToContainer,
  writeOverrideConfig,
  buildIdentityLabels,
  finishBackgroundTasks,
  buildAuthorityAndOpen,
  readLaunchConfig,
  throwIfCancelled,
  CancelledError,
} from "./postLaunch";
import type { ReadConfigResult } from "../config/configManager";
import {
  readConfigFileText,
  removeTempConfigFile,
} from "../config/configFileIO";

export interface ReopenInContainerParams {
  workspaceFolder: string;
  workspaceUri: vscode.Uri;
  forceNewWindow?: boolean;
}

export type ReopenCoreResult =
  | { kind: "ready"; outcome: LaunchOutcome }
  | { kind: "rebuild-requested" }
  | { kind: "cancelled" };


export async function reopenInContainer(
  deps: WorkflowDependencies,
  ui: WorkflowUI,
  params: ReopenInContainerParams,
): Promise<void> {
  const { workspaceFolder, forceNewWindow } = params;

  try {
    // Find-or-build here, on whichever side owns Docker (local, or the SSH
    // host through the ExecServer), then open the window.
    const result = await reopenInContainerCore(deps, ui, params);
    if (result.kind === "rebuild-requested") {
      await vscode.commands.executeCommand("artizo.rebuildAndReopenInContainer");
      return;
    }
    if (result.kind !== "ready") return;

    const { outcome } = result;
    const remotePath = outcome.remoteWorkspaceFolder || "/workspaces";
    await buildAuthorityAndOpen({
      deps,
      ui,
      scheme: "artizo-container",
      id: workspaceFolder,
      containerId: outcome.containerId,
      containerPort: outcome.containerPort,
      installPath: outcome.installPath,
      connectionToken: outcome.connectionToken,
      workspaceFolder,
      workspacePath: remotePath,
      uriPath: remotePath.startsWith("/") ? remotePath : "/" + remotePath,
      windowOptions: forceNewWindow
        ? { forceNewWindow: true }
        : { forceReuseWindow: true },
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

/**
 * Find-or-build the container and start the server, without opening a window.
 *
 * Used by the local wrapper above and by the resolver, which runs this
 * apex-side against the SSH-host ExecServer before returning connection info.
 */
export async function reopenInContainerCore(
  deps: WorkflowDependencies,
  ui: WorkflowUI,
  params: ReopenInContainerParams,
): Promise<ReopenCoreResult> {
  const { workspaceFolder, workspaceUri } = params;

  let result: ReopenCoreResult = { kind: "cancelled" };
  let configResult: ReadConfigResult | undefined;
  let perContainerDisable = false;

  try {
    await ui.showProgress(
      `${BRAND}: Reopen in Container`,
      async (progress, token) => {
        // Phase 1: Config
        progress.report({ message: "Reading devcontainer.json..." });
        configResult = await readLaunchConfig({
          deps,
          ui,
          workspaceUri,
          promptCreate: true,
        });
        if (!configResult?.config) {
          result = { kind: "cancelled" };
          return;
        }

        const config = configResult.config as Record<string, unknown>;
        perContainerDisable = !!config["disableCopyGitConfig"];

        // Resolve ${localEnv:...} and friends across the full config in one
        // place - workspaceFolder, remoteEnv, etc. - so the resolved config
        // flows to connectToContainer → start() without leaking literal
        // ${localEnv:...} strings into the server env (issue #12) or into the
        // remote window URI.
        const resolvedConfig = await resolveConfigVars(
          workspaceFolder,
          configResult.configPath,
          config,
        );

        // Phase 2: Build (skip if existing container found)
        progress.report({ message: "Checking for existing container..." });
        const { dockerExecPolicy } = await import("../docker/execPolicy.js");
        const configFilePath = configResult.configPath ?? "";
        const platformTarget = (
          await getPlatformAdapter()
        ).name.toLowerCase();
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
            for (const id of psResult.stdout
              .trim()
              .split("\n")
              .filter(Boolean)) {
              fallbackIds.add(id);
            }
          }
          existingContainerId = fallbackIds.values().next().value;
        }

        let containerId: string;
        let remoteUser: string;
        let remoteWorkspaceFolder: string;

        if (existingContainerId) {
          ui.showBuildLog(
            `${BRAND_PREFIX} Found existing container ${existingContainerId.slice(0, 12)}, reconnecting...`,
          );
          // Config drift check before reusing. The resolver (not this
          // function) decides what to do when a rebuild is requested.
          const { dockerInspect } = await import("../utils/dockerUtils.js");
          const { checkContainerConfig } = await import(
            "../remote/configCheck.js"
          );
          const existingInfo = await dockerInspect(existingContainerId, {
            dockerPath: getDockerPath(),
          });
          const checkResult = await checkContainerConfig(existingInfo, {
            executeRebuildCommand: false,
          });
          if (checkResult === "rebuild") {
            result = { kind: "rebuild-requested" };
            return;
          }
          // Reconnect via the CLI so lifecycle hooks run (postStartCommand,
          // postAttachCommand). One-time hooks (onCreateCommand,
          // updateContentCommand, postCreateCommand) are skipped by the
          // CLI's marker-file logic. This matches the official extension,
          // which calls `devcontainer up --expect-existing-container`.
          //
          // If the CLI can't find the container by labels (e.g. config file
          // moved, or container created by another tool), fall back to
          // manual `docker start` - hooks won't run, but the container is
          // reused rather than orphaned.
          const idLabels = await buildIdentityLabels({
            platformTarget,
            workspaceFolder,
            configPath: configResult.configPath,
            config,
          });
          const reconnectOptions = withDefaults({
            workspaceFolder,
            additionalLabels: idLabels,
            configFile: configResult.configPath
              ? cliFileUri(configResult.configPath)
              : undefined,
            expectExistingContainer: true,
            removeExistingContainer: false,
            log: (text: string) => ui.showBuildLog(text),
          });
          try {
            const provisionResult = await launchProvision(
              reconnectOptions,
              configResult.configPath,
              undefined,
              idLabels,
            );
            await finishBackgroundTasks(provisionResult);
            if (!provisionResult?.containerId) {
              throw new Error("CLI did not return a container ID");
            }
            containerId = provisionResult.containerId;
            remoteUser = provisionResult.remoteUser;
            remoteWorkspaceFolder = provisionResult.remoteWorkspaceFolder;
          } catch (err) {
            if (
              err instanceof Error &&
              err.message.includes("expected container does not exist")
            ) {
              getLogger().warn(
                `[reopen] CLI could not find container by labels; falling back to manual start`,
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
              const basename =
                workspaceFolder.split(/[\\/]/).filter(Boolean).pop() ?? "";
              // resolvedConfig was already substituted above (resolveConfigVars).
              const cfg = resolvedConfig as Record<string, unknown>;
              containerId = existingContainerId;
              remoteUser =
                typeof cfg.remoteUser === "string"
                  ? cfg.remoteUser
                  : typeof cfg.containerUser === "string"
                    ? cfg.containerUser
                    : "";
              remoteWorkspaceFolder =
                typeof cfg.workspaceFolder === "string"
                  ? cfg.workspaceFolder
                  : `/workspaces/${basename}`;
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
                  config,
                  extraRunArgs,
                )
              : undefined;

          try {
            if (overrideConfigPath) {
              const contents = await readConfigFileText(overrideConfigPath);
              ui.showBuildLog(
                `${BRAND_PREFIX} Override config at ${overrideConfigPath}:\n${contents}`,
              );
            }

            progress.report({ message: "Building container..." });
            const idLabels = await buildIdentityLabels({
              platformTarget,
              workspaceFolder,
              configPath: configResult.configPath,
              config,
            });
            const options = withDefaults({
              workspaceFolder,
              additionalLabels: idLabels,
              configFile: configResult.configPath
                ? cliFileUri(configResult.configPath)
                : undefined,
              overrideConfigFile: overrideConfigPath
                ? cliFileUri(overrideConfigPath)
                : undefined,
              log: (text: string) => ui.showBuildLog(text),
            });

            const provisionResult = await launchProvision(
              options,
              configResult.configPath,
              undefined,
              idLabels,
            );

            await finishBackgroundTasks(provisionResult);

            if (!provisionResult?.containerId) {
              throw new Error("CLI did not return a container ID");
            }

            containerId = provisionResult.containerId;
            remoteUser = provisionResult.remoteUser;
            remoteWorkspaceFolder = provisionResult.remoteWorkspaceFolder;
          } finally {
            if (overrideConfigPath) {
              await removeTempConfigFile(overrideConfigPath);
            }
          }
        }

        throwIfCancelled(token);
        const connectInfo = await connectToContainer(
          deps,
          ui,
          containerId,
          perContainerDisable,
          resolvedConfig,
          remoteUser,
          progress,
          token,
        );

        result = {
          kind: "ready",
          outcome: {
            containerId,
            remoteUser,
            remoteWorkspaceFolder,
            containerPort: connectInfo.port,
            installPath: connectInfo.installPath,
            connectionToken: connectInfo.connectionToken,
          },
        };
      },
    );
  } catch (err: unknown) {
    if (err instanceof CancelledError) {
      return { kind: "cancelled" };
    }
    throw err;
  }

  return result;
}