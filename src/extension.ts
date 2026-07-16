/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Extension entry point. Activation wires services, registers commands,
 * sets up the status bar, and starts the devcontainer detector.
 */

import * as vscode from "vscode";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getLogger, initLogger, LogLevel } from "./utils/logger";
import { BRAND } from "./utils/constants";
import { Host } from "./host/host";
import {
  validatePlatformRuntime,
  ensureResolversAvailable,
  readSettings,
  registerResolverEarly,
  loadProductInfo,
  createServices,
  createBuildLogTerminal,
  autoDetectDevcontainer,
} from "./host/services";
import { registerCoreCommands, type CommandContext } from "./host/commands";
import { bootstrapRemoteSideLoad } from "./remote/sideload";
import { clearAllCached } from "./ssh/askpassCache";

import type { LogOutputTerminal } from "./workflows/logOutputTerminal";
import {
  initTier,
  isDevContainerTier,
  isAttachedContainerWindow,
  ExecutionTier,
  canDriveDocker,
  type DetectedTier,
} from "./host/state";

/**
 * Called when the extension is activated.
 *
 * Activation guard: under extensionKind ["workspace","ui"], both sides may
 * activate. The workspace-side extension inside a devcontainer can't drive
 * Docker (it's trapped in the container) and would loop trying to do host
 * things - bail before any services are wired. UI-side handles devcontainer
 * states from the parent host, which is where Docker lives.
 */
export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  // Create the OutputChannel first so all subsequent steps can log to it.
  // This is the authoritative diagnostics sink - always available (no
  // renderer / early-activation gap), reliable, ordered. Docker build output
  // is mirrored to a separate pty terminal (see createBuildLogTerminal).
  const channel = vscode.window.createOutputChannel(BRAND, { log: true });
  context.subscriptions.push(channel);
  initLogger(channel);

  // Apply the configured log level (artizo.logLevel) to the logger.
  const logLevelConfig = vscode.workspace
    .getConfiguration("artizo")
    .get<string>("logLevel", "info");
  const logLevelMap: Record<string, LogLevel> = {
    info: LogLevel.Info,
    debug: LogLevel.Debug,
    trace: LogLevel.Trace,
  };
  getLogger().setLevel(logLevelMap[logLevelConfig] ?? LogLevel.Info);

  // Reveal the diagnostics output channel (sidebar "Show Log" button).
  context.subscriptions.push(
    vscode.commands.registerCommand("artizo.revealOutputLog", () => {
      getLogger().show();
    }),
  );

  getLogger().info(`${BRAND} activating...`);
  getLogger().info(`Extension path: ${context.extensionPath}`);
  getLogger().info(`Log file: ${path.join(context.logPath, "artizo.log")}`);

  // 0. Detect execution tier and cache it. Must happen before any code
  //    queries isInDevContainer()/canDriveDocker()/getTier().
  const detected = initTier(context.extension.extensionKind);
  getLogger().info(
    `activate enter tier=${detected.tier} ` +
      `owner=${detected.owner} ` +
      `remoteName=${detected.remoteName ?? "none"} ` +
      `kind=${detected.extensionKind ?? "none"} ` +
      `authority=${detected.remoteAuthority ?? "none"}`,
  );

  // Workspace-side inside a devcontainer: can't drive Docker, would loop.
  if (
    detected.extensionKind === vscode.ExtensionKind.Workspace &&
    isDevContainerTier(detected.tier)
  ) {
    getLogger().info(
      "skipping activation: workspace-side inside devcontainer",
    );
    return;
  }

  // Unsupported remotes (wsl/codespaces/tunnel): no-op on both sides.
  if (detected.tier === ExecutionTier.UnknownRemote) {
    getLogger().info(
      `skipping activation: unsupported remote ${detected.remoteName}`,
    );
    return;
  }

  // Bootstrap branch: UI-side on the apex in an SSH-remote window. The
  // vendor SSH extension didn't install us onto the remote, so we
  // side-load ourselves there (tar stream via ssh + extensions.json
  // mutation + reloadWindow). After reload, we activate workspace-side
  // on the SSH host with `owner === "workspace"` and skip this branch.
  // Must run before validatePlatformRuntime - we're about to reload into
  // the right context, and platform validation would bail on the UI side.
  // See plans/remaining-work.md (State 4 side-load).
  if (detected.tier === ExecutionTier.RemoteSSH && detected.owner === "none") {
    const status = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      0,
    );
    status.text = "$(loading~spin) Artizo: setting up on remote host...";
    status.tooltip =
      "Artizo is installing itself onto the SSH remote host. " +
      "The window will reload when done.";
    status.show();
    context.subscriptions.push(status);

    const progress = vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Artizo: setting up on remote host",
        cancellable: false,
      },
      (p) =>
        bootstrapRemoteSideLoad(context, detected, status, p).catch(async (err) => {
          const msg = err instanceof Error ? err.message : String(err);
          try {
            getLogger().error(
              `Remote side-load failed: ${msg}`,
              err instanceof Error ? err : new Error(msg),
            );
          } catch {
            // Logger is initialized; this only fails if activate threw
            // before initLogger, which can't happen now.
          }
          // Also write to the diag log so we see the failure even when the
          // logger isn't up yet.
          try {
            fs.appendFileSync(
              path.join(os.tmpdir(), "artizo-sideload.log"),
              `[${new Date().toISOString()}] CATCH in activate: ${msg}\n`,
            );
          } catch {
            // Ignore
          }
          status.text = "$(error) Artizo: setup failed - see log";
          status.tooltip = msg;
          const action = await vscode.window.showErrorMessage(
            "Artizo remote setup failed. Check the log for details.",
            "Retry",
          );
          if (action === "Retry") {
            await vscode.commands.executeCommand(
              "workbench.action.reloadWindow",
            );
          }
          throw err;
        }),
    );
    context.subscriptions.push({ dispose: () => void progress });
    return;
  }

  // 1. Validate platform first - before any commands are registered, so a
  //    mismatch can bail cleanly without duplicate-command collisions.
  if (!(await validatePlatformRuntime(context))) {
    return;
  }

  // 1b. Set context key for package.json when clauses (host vs managed).
  // Deferred to activateInternal after reading productInfo.

  // 2. Init build terminal/pty handle (logger is already up from activate).
  //    The pty terminal mirrors docker build / provision output in a colored
  //    terminal view; it is NOT the app logger.
  const { buildLogPty, buildLogTerminal } = createBuildLogTerminal(context);

  try {
    await activateInternal(context, buildLogPty, buildLogTerminal, detected);
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
    // Reveal the diagnostics channel (where the error was just logged) so
    // the user can see it. The build terminal would be empty here.
    getLogger().show();
    vscode.window.showErrorMessage(`Artizo failed to activate: ${message}`);
  }
}

async function activateInternal(
  context: vscode.ExtensionContext,
  buildLogPty: LogOutputTerminal,
  buildLogTerminal: { show(preserveFocus?: boolean): void },
  detected: DetectedTier,
): Promise<void> {
  // 2. Read settings, read productInfo, create Host
  const settings = readSettings();

  // 3. Read product.json for commit and platform info (used by ServerManager)
  const productInfo = await loadProductInfo();

  const host = Host.create({
    dockerPath: settings.dockerPath,
  });

  // Set context keys
  // artizo.hostContext: true when this host can drive Docker (states 1/3,
  // and UI-side in states 2/4). Drives command visibility in package.json.
  vscode.commands.executeCommand(
    "setContext",
    "artizo.hostContext",
    canDriveDocker(),
  );
  vscode.commands.executeCommand(
    "setContext",
    "artizo.hasDevcontainerConfig",
    false,
  );

  // artizo.inAttachedContainer: true when inside an attached-container
  // window (not our managed container). Gates "Return to Host" visibility -
  // attached containers have no host path to return to.
  vscode.commands.executeCommand(
    "setContext",
    "artizo.inAttachedContainer",
    isAttachedContainerWindow(),
  );

  // artizo.onRemote: true when this extension host is the workspace side
  // on an SSH-class remote (post-side-load, or a future auto-install).
  // Drives activity-bar visibility in package.json so the sidebar only
  // appears on the remote where it belongs, not on the UI-side Windows
  // host during the pre-reload bootstrap window.
  const onRemote =
    detected.extensionKind === vscode.ExtensionKind.Workspace &&
    (detected.tier === ExecutionTier.RemoteSSH ||
      detected.tier === ExecutionTier.RemoteSSHDevContainer);
  vscode.commands.executeCommand("setContext", "artizo.onRemote", onRemote);

  // State 4 housekeeping: when we're workspace-side on an SSH host, sweep
  // stale relay daemons left over from a crashed extension host. The relay
  // is detached (outlives us), so a crash leaves orphaned `artizo-relay-*.pid`
  // files + processes. Safe no-op if none exist.
  if (
    detected.extensionKind === vscode.ExtensionKind.Workspace &&
    detected.tier === ExecutionTier.RemoteSSH
  ) {
    try {
      const { sweepStaleRelays } = await import("./remote/containerProxy.js");
      sweepStaleRelays();
    } catch (err) {
      getLogger().info(
        `[artizo] stale relay sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // 4. Ensure resolvers available (may prompt restart)
  if (await ensureResolversAvailable()) {
    return; // restart needed
  }

  // 5. Register authority resolver early (before any async work)
  const resolver = registerResolverEarly(context, settings);

  // 6. Create services with Host
  const services = createServices(
    context,
    settings,
    resolver,
    productInfo,
    buildLogPty,
    host,
  );

  // 8. Register commands
  const cmdCtx: CommandContext = {
    deps: services.deps,
    ui: services.ui,
    configManager: services.configManager,
    containerLifecycle: services.containerLifecycle,
    buildLogTerminal,
    buildLogPty,
    dockerPath: settings.dockerPath,
    host,
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
  // Clear cached SSH passwords/passphrases.
  try {
    clearAllCached();
  } catch {
    // ignore
  }
}
