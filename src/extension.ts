/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Extension entry point. Activation wires services, registers commands,
 * sets up the status bar, and starts the devcontainer detector.
 */

import * as vscode from "vscode";
import { getLogger } from "./utils/logger";
import { BRAND } from "./utils/constants";
import { configureDockerPath } from "./docker/execPolicy";
import {
  initializeLogger,
  validatePlatformRuntime,
  ensureResolversAvailable,
  readSettings,
  registerResolverEarly,
  loadProductInfo,
  createServices,
  autoDetectDevcontainer,
} from "./host/services";
import { registerCoreCommands, type CommandContext } from "./host/commands";
import type { LogOutputTerminal } from "./workflows/logOutputTerminal";

/** Called when the extension is activated. */
export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  // 1. Init logger
  const { buildLogPty, buildLogTerminal } = initializeLogger(context);

  try {
    await activateInternal(context, buildLogPty, buildLogTerminal);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    // Try to log before the terminal gets disposed
    try {
      getLogger().error(`Activation failed: ${message}`);
      if (stack) {
        getLogger().error(stack);
      }
    } catch {
      // Logger may not work either
    }
    // Keep the terminal visible so the user can see the error
    buildLogTerminal.show();
    vscode.window.showErrorMessage(`Artizo failed to activate: ${message}`);
  }
}

async function activateInternal(
  context: vscode.ExtensionContext,
  buildLogPty: LogOutputTerminal,
  buildLogTerminal: { show(preserveFocus?: boolean): void },
): Promise<void> {
  // 2. Validate platform
  if (!(await validatePlatformRuntime(context))) {
    return;
  }

  // 3. Read settings, configure Docker path
  const settings = readSettings();
  configureDockerPath(settings.dockerPath);

  // Set initial context for menu when clauses
  vscode.commands.executeCommand(
    "setContext",
    "artizo.hasDevcontainerConfig",
    false,
  );

  // 4. Ensure resolvers available (may prompt restart)
  if (await ensureResolversAvailable()) {
    return; // restart needed
  }

  // 5. Register authority resolver early (before any async work)
  const resolver = registerResolverEarly(context, settings);

  // 6. Read product.json
  const productInfo = await loadProductInfo();

  // 7. Create services
  const services = createServices(
    context,
    settings,
    resolver,
    productInfo,
    buildLogPty,
  );

  // 8. Register commands
  const cmdCtx: CommandContext = {
    deps: services.deps,
    ui: services.ui,
    configManager: services.configManager,
    containerLifecycle: services.containerLifecycle,
    orchestrator: services.orchestrator,
    buildLogTerminal,
    buildLogPty,
    dockerPath: settings.dockerPath,
    sidebarProvider: services.sidebarProvider,
    extensionUri: context.extensionUri,
  };
  registerCoreCommands(context, cmdCtx);

  getLogger().info("All commands registered");

  // 10. Auto-detect devcontainer.json
  autoDetectDevcontainer(context, services.configManager);

  getLogger().info(`${BRAND} activated.`);
}

/** Called when the extension is deactivated. */
export function deactivate(): void {
  try {
    getLogger().info(`${BRAND} deactivating...`);
  } catch {
    // Logger may not be initialized if activation failed
  }
}
