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
  ensureResolversAvailable,
  readSettings,
  registerResolverEarly,
  loadProductInfo,
  createServices,
  createBuildLogTerminal,
  autoDetectDevcontainer,
} from "./host/services";
import { registerCoreCommands, type CommandContext } from "./host/commands";
import { initVscodiumFeed } from "./remote/vscodiumFeed";
import { initVscodiumBundledVersion } from "./platform/vscodiumBundledVersion";
import { configureDownloadCache, maybePruneCache } from "./remote/download";
import { setActiveExecServer } from "./remote/execServerCache";
import { setAgentExtensionPath } from "./remote/agentClient";
import type { ExecServer } from "./remote/execServerBridge";
import { registerServerDownloadPanel } from "./webviews/serverDownloadPanel";
import { FORK_TEMPLATES } from "./platform/forkTemplates";

import type { LogOutputTerminal } from "./workflows/logOutputTerminal";
import {
  initTier,
  isDevContainerTier,
  isInDevContainerWindow,
  isAttachedContainerWindow,
  ExecutionTier,
  canDriveDocker,
  type DetectedTier,
} from "./host/state";
import {
  configureRuntimeKind,
  resolveRuntime,
} from "./docker/execPolicy";

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

  // Locate the remote CLI agent (tools/artifact-agent) when a workflow needs it.
  setAgentExtensionPath(context.extensionPath);

  // Initialize the VSCodium release feed used by the code-oss fork
  // (nearest-version lookup for VSCodium REH tarballs). The bundled
  // fallback (newest version in versions.json) is artizo-local - zygos
  // never consumes it, so it lives in ./platform not the shared file.
  const bundledVscodiumPath = path.join(
    context.extensionPath,
    "tools",
    "vscodium",
    "versions.json",
  );
  initVscodiumFeed({
    bundledPath: bundledVscodiumPath,
    cachePath: path.join(os.homedir(), ".artizo", "vscodium-versions.json"),
  });
  initVscodiumBundledVersion({ bundledPath: bundledVscodiumPath });

  // Register the server-download config panel (available in all builds).
  registerServerDownloadPanel(context, {
    configNamespace: "artizo",
    commandId: "artizo.configureServerDownload",
    panelTitle: "Artizo Server Download",
    productName: "Artizo",
    webviewSubdir: "resources/serverDownload",
    logger: getLogger(),
    getDownloadInfo: async () => {
      const { getProductInfo } = await import("./remote/productInfo.js");
      const { getPlatformAdapter } = await import("./platform/index.js");
      const adapter = await getPlatformAdapter();
      const info = await getProductInfo(vscode.env.appRoot);
      return { adapter, info };
    },
    readProductJson: async () => {
      const { readProductJson } = await import("./remote/productInfo.js");
      return readProductJson(vscode.env.appRoot);
    },
    forkTemplates: FORK_TEMPLATES,
  });

  // 0. Detect execution tier and cache it. Must happen before any code
  //    queries isInDevContainer()/canDriveDocker()/getTier().
  const detected = initTier(context.extension.extensionKind);
  getLogger().info(
    `activate enter tier=${detected.tier} ` +
      `owner=${detected.owner} ` +
      `remoteName=${detected.remoteName ?? "none"} ` +
      `kind=${detected.extensionKind ?? "none"}`,
  );

  // Set artizo.hostContext as early as possible so the sidebar icon renders
  // without waiting for the resolver gate below. Tradeoff: command palette
  // items gated on this key become visible before registration completes
  // (subsecond gap in the normal path).
  vscode.commands.executeCommand(
    "setContext",
    "artizo.hostContext",
    canDriveDocker(),
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

  // Cache the remote ExecServer so apex-side Docker ops run on the SSH host.
  await cacheExecServer(detected);

  // 1. Set context key for package.json when clauses (host vs managed).
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

/**
 * Platform of the machine that runs Docker. The apex for local windows; the
 * SSH host for SSH-class tiers (Linux-class, so wslc never applies there).
 */
function dockerHostPlatform(detected: DetectedTier): NodeJS.Platform {
  return detected.tier === ExecutionTier.RemoteSSH ||
    detected.tier === ExecutionTier.RemoteSSHDevContainer
    ? "linux"
    : process.platform;
}

/**
 * Cache the remote ExecServer for UI-side SSH-class windows so Docker ops run
 * on the SSH host. For a chained container window, resolve the parent SSH
 * authority. No-op for local windows.
 */
async function cacheExecServer(detected: DetectedTier): Promise<void> {
  const isSshTier =
    detected.tier === ExecutionTier.RemoteSSH ||
    detected.tier === ExecutionTier.RemoteSSHDevContainer;
  if (!isSshTier) return;

  let authority = detected.remoteAuthority;
  if (!authority) return;
  const at = authority.indexOf("@");
  if (at !== -1) authority = authority.substring(at + 1);
  if (!authority.startsWith("ssh-remote")) return;

  const get = (
    vscode.workspace as unknown as {
      getRemoteExecServer?: (a: string) => Promise<ExecServer | undefined>;
    }
  ).getRemoteExecServer;
  if (typeof get !== "function") {
    getLogger().info("[execServer] getRemoteExecServer unavailable");
    return;
  }
  try {
    const execServer = await get.call(vscode.workspace, authority);
    setActiveExecServer(execServer);
    getLogger().info(
      `[execServer] cached for ${authority}: ${execServer ? "yes" : "no"}`,
    );
  } catch (err: unknown) {
    getLogger().warn(
      `[execServer] getRemoteExecServer failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function activateInternal(
  context: vscode.ExtensionContext,
  buildLogPty: LogOutputTerminal,
  buildLogTerminal: { show(preserveFocus?: boolean): void },
  detected: DetectedTier,
): Promise<void> {
  // 2. Read settings, resolve the Docker runtime (docker or wslc), create Host.
  const rawSettings = readSettings();
  const runtime = await resolveRuntime({
    platform: dockerHostPlatform(detected),
    dockerPath: rawSettings.dockerPath,
    wslcPath: rawSettings.wslcPath,
    useWslc: rawSettings.useWslcIfInstalled,
  });
  configureRuntimeKind(runtime.kind);
  getLogger().info(
    `[activate] runtime=${runtime.kind} path=${runtime.path}`,
  );
  // Opted in but wslc didn't win on Windows: wslc not installed / not on PATH.
  if (
    rawSettings.useWslcIfInstalled &&
    dockerHostPlatform(detected) === "win32" &&
    runtime.kind === "docker"
  ) {
    void vscode.window
      .showErrorMessage(
        "wslc not found. Install with `wsl --update` (WSL 2.9.3+) and reload.",
        "Open WSL install docs",
      )
      .then((choice) => {
        if (choice === "Open WSL install docs") {
          vscode.env.openExternal(
            vscode.Uri.parse(
              "https://learn.microsoft.com/en-us/windows/wsl/wsl-container",
            ),
          );
        }
      });
  }
  // Re-resolve the runtime when the user toggles useWslcIfInstalled or
  // changes dockerPath/wslcPath. getDockerPath() reads live, but the
  // runtime kind (docker vs wslc) needs a wslc version probe, so it's
  // cached and invalidated here.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("artizo")) return;
      void (async () => {
        const s = readSettings();
        const r = await resolveRuntime({
          platform: dockerHostPlatform(detected),
          dockerPath: s.dockerPath,
          wslcPath: s.wslcPath,
          useWslc: s.useWslcIfInstalled,
        });
        configureRuntimeKind(r.kind);
        getLogger().info(
          `[config] runtime=${r.kind} path=${r.path}`,
        );
      })();
    }),
  );
  // settings.dockerPath is no longer captured downstream: every consumer
  // reads getDockerPath() live, so toggling wslc or swapping docker for
  // podman takes effect without a reload. Only the runtime kind (docker vs
  // wslc) is cached because it needs a `wslc version` probe.

  // 3. Read product.json for commit and platform info (used by ServerManager)
  const productInfo = await loadProductInfo();

  // Initialize on-disk caches. UI-side only: the workspace-side host doesn't
  // download REH tarballs.
  if (detected.extensionKind !== vscode.ExtensionKind.Workspace) {
    const storageDir = context.globalStorageUri.fsPath;
    try {
      fs.mkdirSync(storageDir, { recursive: true });
    } catch (err) {
      getLogger().warn(
        `[activate] storage dir init failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // On-disk HTTP cache for REH tarball downloads. Keyed by URL (which
    // encodes commit+arch+binaryName); 304-revalidated when stale. Prune
    // asynchronously on activation if over 2GB.
    const rehCacheDir = path.join(storageDir, "reh-cache");
    try {
      fs.mkdirSync(rehCacheDir, { recursive: true });
      configureDownloadCache(rehCacheDir, {
        onCacheStatus: (status, u) =>
          getLogger().info(`[download] cache=${status} url=${u}`),
        onRetry: (cause, u) =>
          getLogger().info(
            `[download] retrying ${u}: ${cause instanceof Error ? cause.message : String(cause)}`,
          ),
      });
      void maybePruneCache();
    } catch (err) {
      getLogger().warn(
        `[activate] REH cache init failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const host = Host.create({});

  // Set context keys
  // artizo.hasDevContainerConfig: false until a config is detected.
  vscode.commands.executeCommand(
    "setContext",
    "artizo.hasDevContainerConfig",
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

  // artizo.onRemote: true when this extension host is attached to an
  // SSH-class remote (the SSH window or a container window chained to it).
  // Drives activity-bar visibility in package.json.
  const onRemote =
    detected.tier === ExecutionTier.RemoteSSH ||
    detected.tier === ExecutionTier.RemoteSSHDevContainer;
  vscode.commands.executeCommand("setContext", "artizo.onRemote", onRemote);

  // 4. Ensure resolvers available (may prompt restart)
  if (await ensureResolversAvailable()) {
    return; // restart needed
  }

  // 5. Register authority resolver early (before any async work)
  const resolver = registerResolverEarly(context);

  // 6. Create services with Host
  const services = createServices(
    context,
    resolver,
    productInfo,
    buildLogPty,
    host,
  );

  // 7. Wire the Ports view in a connected window. The resolver's own wiring
  //    only runs in the host window that opens the container; this window is a
  //    separate extension host, and without this the palette has no handlers.
  if (isInDevContainerWindow()) {
    void resolver.ensurePortsForAttachedWindow().catch((err: unknown) => {
      getLogger().warn(
        `Ports view wiring failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  // 8. Register commands
  const cmdCtx: CommandContext = {
    deps: services.deps,
    ui: services.ui,
    configManager: services.configManager,
    containerLifecycle: services.containerLifecycle,
    buildLogTerminal,
    buildLogPty,
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
export async function deactivate(): Promise<void> {
  try {
    getLogger().info(`${BRAND} deactivating...`);
  } catch {
    // Logger may not be initialized if activation failed
  }
}
