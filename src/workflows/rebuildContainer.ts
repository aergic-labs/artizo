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
import { ProvisionFailedError } from "../devcontainer/provisionError";
import { getPlatformAdapter } from "../platform";
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
import { resolveConfigVars } from "../devcontainer/readResolvedConfig";
import { warnWslcUnsupportedConfig } from "../devcontainer/wslcDiagnostics";
import type { ReadConfigResult } from "../config/configManager";
import { removeTempConfigFile } from "../config/configFileIO";

export interface RebuildContainerParams {
  workspaceFolder: string;
  workspaceUri: vscode.Uri;
  noCache?: boolean;
  reconnect?: boolean;
}

export type RebuildCoreResult =
  | { kind: "ready"; outcome: LaunchOutcome }
  | { kind: "built" }
  | { kind: "cancelled" };

export async function rebuildContainer(
  deps: WorkflowDependencies,
  ui: WorkflowUI,
  params: RebuildContainerParams,
): Promise<void> {
  const { workspaceFolder } = params;

  try {
    // The build runs here, on whichever side owns Docker (local, or the SSH
    // host through the ExecServer). "Rebuild Container" stops after the
    // build; only "Rebuild and Reopen" opens a window, and only once the
    // container is ready.
    const result = await rebuildContainerCore(deps, ui, params);
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

    if (action === "Retry") {
      return rebuildContainer(deps, ui, params);
    }

    throw error;
  }
}

/**
 * Rebuild the container and start the server, without opening a window.
 *
 * Used by the local wrapper above and by the resolver.
 */
export async function rebuildContainerCore(
  deps: WorkflowDependencies,
  ui: WorkflowUI,
  params: RebuildContainerParams,
): Promise<RebuildCoreResult> {
  const { workspaceFolder, workspaceUri, noCache, reconnect } = params;

  let configResult: ReadConfigResult | undefined;
  let perContainerDisable = false;
  let result: RebuildCoreResult = { kind: "cancelled" };

  try {
    // Phase 1: Config
    configResult = await readLaunchConfig({
      deps,
      ui,
      workspaceUri,
      promptCreate: false,
    });
    if (!configResult?.config) return result;

    const config = configResult.config as Record<string, unknown>;
    perContainerDisable = !!config["disableCopyGitConfig"];

    // wslc has no Compose runtime and cannot bind-mount WSL host paths;
    // surface a toast before the build if the config needs one of those.
    warnWslcUnsupportedConfig(configResult.config);

    // Resolve ${localEnv:...} and friends across the full config in one
    // place - workspaceFolder, remoteEnv, etc. - so the resolved config
    // flows to connectToContainer → start() without leaking literal
    // ${localEnv:...} strings into the server env (issue #12).
    const resolvedConfig = await resolveConfigVars(
      workspaceFolder,
      configResult.configPath,
      config,
    );

    // Phase 2: Build
    let launchOutcome:
      | {
          containerId: string;
          remoteUser: string;
          remoteWorkspaceFolder: string;
        }
      | undefined;

    await ui.showProgress(
      `${BRAND}: Rebuilding Container`,
      async (progress, token) => {
        progress.report({
          message: noCache ? "Building without cache..." : "Building...",
        });

        const platformTarget = (
          await getPlatformAdapter()
        ).name.toLowerCase();
        const idLabels = await buildIdentityLabels({
          platformTarget,
          workspaceFolder,
          configPath: configResult!.configPath,
          config,
        });
        const options = withDefaults({
          workspaceFolder,
          configFile: configResult!.configPath
            ? cliFileUri(configResult!.configPath)
            : undefined,
          buildNoCache: noCache ?? false,
          removeExistingContainer: true,
          // Build/start only; user lifecycle hooks run on attach.
          postCreateEnabled: false,
          defaultUserEnvProbe: reconnect ? "loginInteractiveShell" : "none",
          additionalLabels: idLabels,
          log: (text: string) => ui.showBuildLog(text),
        });

        const provisionResult = await launchProvision(
          options,
          configResult!.configPath,
          undefined,
          idLabels,
        );
        throwIfCancelled(token);

        await finishBackgroundTasks(provisionResult);

        if (!provisionResult?.containerId) {
          throw new Error("CLI did not return a container ID");
        }
        launchOutcome = {
          containerId: provisionResult.containerId,
          remoteUser: provisionResult.remoteUser,
          remoteWorkspaceFolder: provisionResult.remoteWorkspaceFolder,
        };
      },
    );

    if (!launchOutcome) return result;

    if (!reconnect) {
      ui.showBuildLog(`${BRAND_PREFIX} Build complete.`);
      ui.showInfo(`${BRAND_PREFIX} Container image rebuilt successfully.`);
      result = { kind: "built" };
      return result;
    }

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

    let containerId = launchOutcome.containerId;
    let remoteWorkspaceFolder = launchOutcome.remoteWorkspaceFolder;
    let remoteUser = launchOutcome.remoteUser;

    if (overrideConfigPath) {
      let relaunchResult:
        | {
            containerId: string;
            remoteUser: string;
            remoteWorkspaceFolder: string;
            finishBackgroundTasks?: () => Promise<void>;
          }
        | undefined;

      try {
        await ui.showProgress(
          `${BRAND}: Starting Container`,
          async (progress, token) => {
            progress.report({ message: "Starting container..." });

            const relaunchPlatformTarget = (
              await getPlatformAdapter()
            ).name.toLowerCase();
            const relaunchIdLabels = await buildIdentityLabels({
              platformTarget: relaunchPlatformTarget,
              workspaceFolder,
              configPath: configResult!.configPath,
              config,
            });
            const upOptions = withDefaults({
              workspaceFolder,
              removeExistingContainer: true,
              additionalLabels: relaunchIdLabels,
              configFile: configResult!.configPath
                ? cliFileUri(configResult!.configPath)
                : undefined,
              overrideConfigFile: cliFileUri(overrideConfigPath),
              // No user lifecycle during up.
              postCreateEnabled: false,
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
        remoteUser = relaunchResult.remoteUser;
      } finally {
        // The override config is a temp file; clean it up so they don't
        // accumulate across reopens/rebuilds.
        await removeTempConfigFile(overrideConfigPath);
      }
    }

    const connectInfo = await connectToContainer(
      deps,
      ui,
      containerId,
      perContainerDisable,
      resolvedConfig,
      remoteUser,
    );

    ui.showInfo(
      `${BRAND_PREFIX} Container ready. Opening workspace in remote window.`,
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
    return result;
  } catch (err: unknown) {
    if (err instanceof CancelledError) {
      return { kind: "cancelled" };
    }
    throw err;
  }
}