/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Attach to Running Container workflow.
 *
 * Lists running containers, user selects one, installs the server, then
 * connects with attached-container authority. Persists attach configuration
 * to `~/.config/artizo/attachConfigs/<container-name>.json`
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { BRAND, BRAND_PREFIX } from "../utils/constants";
import type { WorkflowDependencies, WorkflowUI } from "./types";
import {
  buildAuthorityAndOpen,
  throwIfCancelled,
  CancelledError,
} from "./postLaunch";

/**
 * Information about a running container for selection.
 */
export interface RunningContainer {
  id: string;
  name: string;
  image: string;
  status: string;
}

/**
 * Persisted attach configuration for a container.
 */
export interface AttachConfig {
  containerName: string;
  containerId: string;
  workspaceFolder?: string;
  remoteUser?: string;
  extensions?: string[];
  settings?: Record<string, unknown>;
}

/**
 * Extended UI interface for the attach workflow.
 */
export interface AttachToContainerUI extends WorkflowUI {
  pickContainer(
    containers: RunningContainer[],
  ): Promise<RunningContainer | undefined>;
}

/**
 * Dependencies for listing containers (uses docker CLI directly).
 */
export interface DockerListDependency {
  listRunningContainers(): Promise<RunningContainer[]>;
}

export function getAttachConfigDir(): string {
  return path.join(os.homedir(), ".config", "artizo", "attachConfigs");
}

export function getAttachConfigPath(containerName: string): string {
  // Sanitize container name for use as filename
  const safeName = containerName.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(getAttachConfigDir(), `${safeName}.json`);
}

export function loadAttachConfig(containerName: string): AttachConfig | null {
  const configPath = getAttachConfigPath(containerName);
  try {
    const content = fs.readFileSync(configPath, "utf-8");
    return JSON.parse(content) as AttachConfig;
  } catch {
    return null;
  }
}

export function saveAttachConfig(config: AttachConfig): void {
  const configDir = getAttachConfigDir();
  fs.mkdirSync(configDir, { recursive: true });

  const configPath = getAttachConfigPath(config.containerName);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
}

/**
 * Parameters for the attach-to-container workflow.
 */
export interface AttachToContainerParams {
  /** Pre-selected container ID. If not provided, user picks from list. */
  containerId?: string;
  /** Open the container in a new window instead of reusing the current one. */
  forceNewWindow?: boolean;
}

/**
 * Attach to a running container: list, select, install server, connect,
 * and persist the attach configuration.
 */
export async function attachToContainer(
  deps: WorkflowDependencies,
  ui: AttachToContainerUI,
  docker: DockerListDependency,
  params: AttachToContainerParams,
): Promise<void> {
  const forceNewWindow = params.forceNewWindow ?? false;
  const { serverManager, gitConfigCopier } = deps;

  try {
    let selectedContainer: RunningContainer | undefined;

    if (params.containerId) {
      // Pre-selected: create a minimal container info
      selectedContainer = {
        id: params.containerId,
        name: params.containerId,
        image: "",
        status: "running",
      };
    } else {
      const containers = await docker.listRunningContainers();

      if (containers.length === 0) {
        await ui.showInfo(`${BRAND_PREFIX} No running containers found.`);
        return;
      }

      selectedContainer = await ui.pickContainer(containers);
      if (!selectedContainer) {
        return;
      }
    }

    const existingConfig = loadAttachConfig(selectedContainer.name);
    const workspaceFolder = existingConfig?.workspaceFolder ?? "/";

    // Captured from the progress callback so we can build the authority
    // with the server port + installPath + connectionToken afterwards.
    let serverPort = 0;
    let serverInstallPath = "";
    let serverConnectionToken: string | undefined;

    await ui.showProgress(
      `${BRAND}: Attaching to Container`,
      async (progress, token) => {
        progress.report({ message: "Installing server..." });

        await serverManager.ensureInstalled(selectedContainer!.id);

        // Install extensions declared in the attach config (if any).
        // Downloads on the host, then docker cp + unzip into the
        // server's extensions directory.
        if (
          existingConfig?.extensions &&
          existingConfig.extensions.length > 0
        ) {
          progress.report({ message: "Installing extensions..." });
          await deps.extensionInstaller.installExtensions(
            selectedContainer!.id,
            existingConfig.extensions,
          );
        }

        const serverInfo = await serverManager.start(selectedContainer!.id);
        serverPort = serverInfo.port;
        serverInstallPath = serverInfo.installPath;
        serverConnectionToken = serverInfo.connectionToken;

        await gitConfigCopier.copyGitConfig(selectedContainer!.id);
        throwIfCancelled(token);
      },
    );

    const attachConfig: AttachConfig = {
      containerName: selectedContainer.name,
      containerId: selectedContainer.id,
      workspaceFolder,
      ...(existingConfig?.extensions && {
        extensions: existingConfig.extensions,
      }),
      ...(existingConfig?.settings && { settings: existingConfig.settings }),
    };
    saveAttachConfig(attachConfig);

    // Build the container authority. In State 4 (workspace-side on SSH host),
    // this starts the relay daemon and encodes a proxy payload so the apex
    // host can reach the container through an ssh -L tunnel. In States 1-3
    // it emits a plain attached-container+<containerId> authority.
    await buildAuthorityAndOpen({
      deps,
      ui,
      scheme: "attached-container",
      id: selectedContainer.id,
      containerId: selectedContainer.id,
      containerPort: serverPort,
      installPath: serverInstallPath,
      connectionToken: serverConnectionToken,
      workspaceFolder,
      workspacePath: workspaceFolder,
      // URI path must start with / and use forward slashes
      uriPath: workspaceFolder.startsWith("/")
        ? workspaceFolder
        : "/" + workspaceFolder.replace(/\\/g, "/"),
      windowOptions: forceNewWindow
        ? { forceNewWindow: true }
        : { forceReuseWindow: true },
    });
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));

    if (error instanceof CancelledError) {
      return;
    }

    await ui.showError(
      `${BRAND_PREFIX} Failed to attach to container: ${error.message}`,
      "Retry",
      "Cancel",
    );

    throw error;
  }
}
