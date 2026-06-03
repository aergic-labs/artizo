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
import { encodeAuthority } from "../utils/uriUtils";
import { BRAND, BRAND_PREFIX } from "../utils/constants";
import type { WorkflowDependencies, WorkflowUI } from "./types";

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
  const { serverManager, bridge, orchestrator, gitConfigCopier } = deps;

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

    orchestrator.beginAttachPhase();

    await ui.showProgress(
      `${BRAND}: Attaching to Container`,
      async (progress) => {
        progress.report({ message: "Installing server..." });

        await serverManager.ensureInstalled(selectedContainer!.id);
        const serverInfo = await serverManager.start(selectedContainer!.id);

        await gitConfigCopier.copyGitConfig(selectedContainer!.id);

        orchestrator.beginConnectionPhase();
        progress.report({ message: "Connecting..." });
        await bridge.connect(
          selectedContainer!.id,
          serverInfo.port,
          serverInfo.installPath,
        );
      },
    );

    orchestrator.connectionEstablished();

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

    // Open window with attached-container authority
    const authority = encodeAuthority(
      "attached-container",
      selectedContainer.id,
    );
    // URI path must start with / and use forward slashes
    const uriPath = workspaceFolder.startsWith("/")
      ? workspaceFolder
      : "/" + workspaceFolder.replace(/\\/g, "/");
    await ui.openWindow(`vscode-remote://${authority}${uriPath}`);
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));

    if (orchestrator.state !== "error") {
      orchestrator.fail(error);
    }

    await ui.showError(
      `${BRAND_PREFIX} Failed to attach to container: ${error.message}`,
      "Retry",
      "Cancel",
    );

    throw error;
  }
}