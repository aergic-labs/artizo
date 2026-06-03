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
import type { ICommunicationBridge } from "../remote/communicationBridge";
import type { WorkflowOrchestrator } from "./orchestrator";
import type { IGitConfigCopier } from "../credentials/gitConfigCopier";

/**
 * Dependencies injected into workflow functions.
 */
export interface WorkflowDependencies {
  configManager: IConfigManager;
  serverManager: IServerManager;
  bridge: ICommunicationBridge;
  orchestrator: WorkflowOrchestrator;
  gitConfigCopier: IGitConfigCopier;
}

/**
 * UI abstraction for workflow interactions.
 * Allows mocking vscode UI in tests.
 */
export interface WorkflowUI {
  showProgress(
    title: string,
    task: (report: ProgressReport) => Promise<void>,
  ): Promise<void>;
  showError(message: string, ...actions: string[]): Promise<string | undefined>;
  showInfo(message: string, ...actions: string[]): Promise<string | undefined>;
  openWindow(
    uri: string,
    options?: { forceNewWindow?: boolean },
  ): Promise<void>;
  promptCreateConfig(): Promise<boolean>;
  showBuildLog(content: string): void;
}

/**
 * Progress reporting callback.
 */
export interface ProgressReport {
  report(value: { message?: string; increment?: number }): void;
}