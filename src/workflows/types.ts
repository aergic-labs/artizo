/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Shared types and interfaces for workflow modules.
 *
 * Defines the dependency injection interfaces that allow workflows
 * to be tested without real vscode APIs or Docker.
 */

import type { IConfigManager } from "../config/configManager";
import type { IServerManager } from "../remote/serverManager";
import type { IGitConfigCopier } from "../credentials/gitConfigCopier";
import type { ExtensionInstaller } from "../extensions/extensionInstaller";

/**
 * Result of a container build/provision step.
 */
export interface BuildResult {
  containerId: string;
  remoteUser: string;
  remoteWorkspaceFolder: string;
}

/**
 * Dependencies injected into workflow functions.
 */
export interface WorkflowDependencies {
  configManager: IConfigManager;
  serverManager: IServerManager;
  gitConfigCopier: IGitConfigCopier;
  /**
   * Installs devcontainer.json-declared extensions into the container.
   * Downloads VSIXs on the host (airgap-safe), resolves dependencies,
   * and unzips into the server's extensions directory.
   */
  extensionInstaller: ExtensionInstaller;
  /**
   * Docker binary path (from `artizo.dockerPath` setting). Used by the
   * State 4 workspace-side relay daemon to spawn `docker exec`.
   */
  dockerPath: string;
}

/**
 * UI abstraction for workflow interactions.
 * Allows mocking vscode UI in tests.
 */
export interface WorkflowUI {
  showProgress(
    title: string,
    task: (
      report: ProgressReport,
      token?: CancellationSignal,
    ) => Promise<void>,
  ): Promise<void>;
  showError(message: string, ...actions: string[]): Promise<string | undefined>;
  showInfo(message: string, ...actions: string[]): Promise<string | undefined>;
  openWindow(
    uri: string,
    options?: { forceNewWindow?: boolean; forceReuseWindow?: boolean },
  ): Promise<void>;
  promptCreateConfig(): Promise<boolean>;
  showBuildLog(content: string): void;
}

/**
 * Minimal cancellation signal (structurally satisfied by
 * vscode.CancellationToken) so the workflow layer stays vscode-free.
 */
export interface CancellationSignal {
  readonly isCancellationRequested: boolean;
}

/**
 * Progress reporting callback.
 */
export interface ProgressReport {
  report(value: { message?: string; increment?: number }): void;
}
