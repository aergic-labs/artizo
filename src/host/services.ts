/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Host-level service creation and activation bootstrap.
 *
 * Extracted from extension.ts to keep the entry point focused on
 * wiring components together rather than constructing them.
 */

import * as vscode from "vscode";
import * as nodeFs from "node:fs";
import * as nodePath from "node:path";
import { getLogger } from "../utils/logger";
import { BRAND } from "../utils/constants";
import { ConfigManager } from "../config/configManager";
import { ServerManager } from "../remote/serverManager";
import {
  RemoteAuthorityResolver,
  registerAuthorityResolver,
} from "../remote/authorityResolver";
import { VscodeWorkflowUI } from "../workflows/vscodeUI";
import { DevcontainerDetector } from "../workflows/devcontainerDetector";
import { LogOutputTerminal } from "../workflows/logOutputTerminal";
import { getProductInfo, type ProductInfo } from "../remote/productInfo";
import type { WorkflowDependencies } from "../workflows/types";
import { GitConfigCopier } from "../credentials/gitConfigCopier";
import { ExtensionInstaller } from "../extensions/extensionInstaller";
import { getPlatformAdapter } from "../platform";
import { isInDevContainerWindow, getTier } from "./state";
import { ExecutionTier } from "./state";
import { patchArgvContent } from "./argvPatch";
import type { Host } from "./host";

// VSCodium is the default (else) branch in getArgvExtensionId, so its flag
// isn't referenced here.
declare const HAS_TRAE_ADAPTER: boolean;
declare const HAS_KIRO_ADAPTER: boolean;
declare const HAS_DEVIN_ADAPTER: boolean;
import { ConfigWatcher } from "../config/configWatcher";
import { ContainerLifecycle } from "../lifecycle/containerLifecycle";
import { SidebarProvider } from "../sidebar/provider";
import { ContainerExplorerProvider } from "../views/containerExplorer";

/**
 * Extension settings read from workspace configuration.
 */
export interface ExtensionSettings {
  dockerPath: string;
}

/**
 * Read extension settings from workspace configuration.
 */
export function readSettings(): ExtensionSettings {
  const config = vscode.workspace.getConfiguration("artizo");
  return {
    dockerPath: config.get<string>("dockerPath", "docker"),
  };
}

/**
 * Ensure the extension is listed in argv.json's enable-proposed-api array.
 * Returns true if the file was modified, false if already set.
 *
 * Probes candidate data folder names from the adapter; the first existing
 * argv.json wins. If none exist, the first candidate is created.
 */

/** Resolve the extension ID for argv.json from build-time adapter flags. */
export function getArgvExtensionId(): string {
  return HAS_KIRO_ADAPTER
    ? "aergic.artizo-kiro"
    : HAS_TRAE_ADAPTER
      ? "aergic.artizo-trae"
      : HAS_DEVIN_ADAPTER
        ? "aergic.artizo-devin"
        : "aergic.artizo-vscodium";
}

async function ensureArgvProposedApi(
  _context: vscode.ExtensionContext,
): Promise<boolean> {
  const logger = getLogger();
  const fs = await import("node:fs/promises");
  const path = await import("node:path");

  const adapter = await getPlatformAdapter();

  if (!adapter.needsArgvPatch()) {
    logger.info("ensureArgvProposedApi: needsArgvPatch=false, skipping");
    return false;
  }
  const extensionId = getArgvExtensionId();

  // Build candidate argv.json paths from the adapter's data folder names.
  const home = (await import("node:os")).homedir();
  const candidates = adapter
    .getArgvDataFolderNames()
    .map((name) => path.join(home, name, "argv.json"));
  logger.info(
    `ensureArgvProposedApi: candidates=${JSON.stringify(candidates)}`,
  );

  // Find the first candidate that exists.
  let argvPath = candidates[0];
  let found = false;
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      argvPath = candidate;
      found = true;
      logger.info(`ensureArgvProposedApi: found existing ${candidate}`);
      break;
    } catch {
      // Not found, try next.
    }
  }
  if (!found) {
    logger.info(
      `ensureArgvProposedApi: no existing argv.json, using ${argvPath}`,
    );
  }

  let content: string;
  try {
    content = await fs.readFile(argvPath, "utf-8");
  } catch {
    logger.info(`ensureArgvProposedApi: creating new argv.json at ${argvPath}`);
    const newContent = JSON.stringify(
      { "enable-proposed-api": [extensionId] },
      null,
      "\t",
    );
    await fs.mkdir(path.dirname(argvPath), { recursive: true });
    await fs.writeFile(argvPath, newContent, "utf-8");
    return true;
  }

  const result = patchArgvContent(content, extensionId);
  if (!result) {
    logger.info("ensureArgvProposedApi: already patched, no change");
    return false;
  }

  logger.info("ensureArgvProposedApi: patching argv.json");
  await fs.writeFile(argvPath, result.patched, "utf-8");
  return true;
}

/**
 * Create the docker build output terminal - a pseudo-terminal that mirrors
 * `docker build` / provision output in a familiar colored terminal view.
 * This is NOT the app logger; diagnostics go through getLogger() to a
 * LogOutputChannel (initialized in activate). This terminal is a
 * build-output mirror only.
 */
export function createBuildLogTerminal(context: vscode.ExtensionContext): {
  buildLogPty: LogOutputTerminal;
  buildLogTerminal: { show(preserveFocus?: boolean): void };
} {
  const logFilePath = nodePath.join(context.logPath, "artizo.log");

  // Docker build output is mirrored to a pty terminal for the familiar
  // colored build view. The logger no longer writes here.
  const buildLogPty = new LogOutputTerminal(logFilePath);

  // Terminal created lazily on first show() so the pty's open() fires
  // before any write() calls. Creating eagerly at activation leaves
  // opened=false until the renderer gets around to displaying it, which
  // causes buffered output to be lost on the first build.
  const handle: {
    pty: LogOutputTerminal;
    terminal: vscode.Terminal | undefined;
    show(preserveFocus?: boolean): void;
  } = {
    pty: buildLogPty,
    terminal: undefined,
    show(preserveFocus?: boolean) {
      if (!this.terminal) {
        this.terminal = vscode.window.createTerminal({
          name: `Dev Containers (${BRAND})`,
          pty: this.pty,
        });
        // Write a header so the pty has content to flush when open()
        // fires. This ensures opened=true before build output arrives.
        this.pty.writeLine(`${BRAND} Dev Containers`);
      }
      try {
        this.terminal.show(preserveFocus);
      } catch {
        this.pty = new LogOutputTerminal(logFilePath);
        this.terminal = vscode.window.createTerminal({
          name: `Dev Containers (${BRAND})`,
          pty: this.pty,
        });
        this.pty.writeLine(`${BRAND} Dev Containers`);
        this.terminal.show(preserveFocus);
      }
    },
  };

  // Terminal disposed on extension deactivate (if created).
  context.subscriptions.push({ dispose: () => handle.terminal?.dispose() });

  // Reveal the build terminal (build output with colors).
  context.subscriptions.push(
    vscode.commands.registerCommand("artizo.revealLogTerminal", () => {
      handle.show();
    }),
  );

  return {
    get buildLogPty() {
      return handle.pty;
    },
    buildLogTerminal: handle,
  };
}

/**
 * Validate the platform runtime and register stub handlers if mismatched.
 * Returns false if the extension should abort activation.
 */
export async function validatePlatformRuntime(
  context: vscode.ExtensionContext,
): Promise<boolean> {
  const platformAdapter = await getPlatformAdapter();
  if (platformAdapter.isValidRuntime()) {
    return true;
  }

  const expected = platformAdapter.name;
  const logger = getLogger();
  let actual = "unknown";
  let actualDisplay = "";
  try {
    const productPath = nodePath.join(vscode.env.appRoot, "product.json");
    const product = JSON.parse(nodeFs.readFileSync(productPath, "utf-8"));
    actual = product?.applicationName ?? "unknown";
    actualDisplay = product?.nameShort ?? product?.nameLong ?? "";
  } catch {
    /* ignore */
  }

  const actualLabel = actualDisplay ? `${actualDisplay} (${actual})` : actual;

  const message = `${BRAND}: This extension is built for ${expected}. It cannot run on ${actualLabel}. Please install the correct extension for your editor.`;
  logger.error(message);
  vscode.window.showErrorMessage(message);

  // Replace the sidebar with a persistent explanation so the user sees
  // the problem every time they open the Artizo panel.
  const sidebarHtml =
    "<!DOCTYPE html>" +
    '<html lang="en"><head><meta charset="UTF-8">' +
    "<style>" +
    "body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 24px; margin: 0; }" +
    "h2 { color: var(--vscode-errorForeground); }" +
    "p { line-height: 1.5; }" +
    "</style></head><body>" +
    "<h2>Wrong Extension</h2>" +
    "<p>You installed <strong>Artizo for " +
    expected +
    "</strong>, but this appears to be <strong>" +
    actualLabel +
    "</strong>.</p>" +
    "<p>Open the Extensions panel (Ctrl+Shift+X) and uninstall this extension, " +
    "then install the Artizo build that matches your editor.</p>" +
    "</body></html>";

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("artizo.sidebar", {
      resolveWebviewView(webviewView: vscode.WebviewView) {
        webviewView.webview.html = sidebarHtml;
      },
    }),
  );

  return false;
}

/**
 * Handle argv.json patching: prompt restart if the API entry was just added
 * or if resolvers are still unavailable. Returns true if activation should
 * abort (restart needed).
 */
export async function ensureResolversAvailable(): Promise<boolean> {
  const logger = getLogger();

  // If we're the workspace-side extension on an SSH remote, the apex-side
  // sideload already patched argv.json (or tried to). Don't pop the modal
  // here - it would trap the user in a restart loop on the remote box.
  const tier = getTier();
  if (tier.tier === ExecutionTier.RemoteSSH && tier.owner === "workspace") {
    logger.info(
      "ensureResolversAvailable: workspace-side on SSH remote, skipping modal",
    );
    return false;
  }

  const argvPatched = await ensureArgvProposedApi(
    {} as vscode.ExtensionContext,
  );

  if (argvPatched) {
    const adapter = await getPlatformAdapter();
    logger.info("argv.json patched, prompting for restart");
    const action = await vscode.window.showErrorMessage(
      `${BRAND}: A full restart of ${adapter.name} is required to enable remote container support. Please quit and reopen ${adapter.name}.`,
      { modal: true },
      `Quit ${adapter.name}`,
    );
    if (action === `Quit ${adapter.name}`) {
      await vscode.commands.executeCommand("workbench.action.quit");
    }
    return true;
  }

  if (
    typeof (vscode.workspace as any).registerRemoteAuthorityResolver !==
    "function"
  ) {
    const adapter = await getPlatformAdapter();
    logger.info("resolvers API not available, full restart required");
    const action = await vscode.window.showErrorMessage(
      `${BRAND}: A full restart of ${adapter.name} is required to enable remote container support. Please quit and reopen ${adapter.name}.`,
      { modal: true },
      `Quit ${adapter.name}`,
    );
    if (action === `Quit ${adapter.name}`) {
      await vscode.commands.executeCommand("workbench.action.quit");
    }
    return true;
  }

  return false;
}

/**
 * Register the authority resolver early, before any async work.
 * On window reload with a remote URI, VS Code calls the resolver during
 * activation. If we await anything first, the resolver won't be registered
 * in time.
 *
 * Returns the resolver so it can be wired to the ServerManager later.
 */
export function registerResolverEarly(
  context: vscode.ExtensionContext,
  settings: ExtensionSettings,
): RemoteAuthorityResolver {
  const resolver = new RemoteAuthorityResolver({
    dockerPath: settings.dockerPath,
    extensionPath: context.extensionPath,
  });
  registerAuthorityResolver(context, resolver);
  // Ensure SSH tunnels spawned by the State 4 proxy path are torn down on
  // extension deactivation so we don't leave orphaned `ssh -L` processes.
  context.subscriptions.push({ dispose: () => resolver.dispose() });
  getLogger().info("Authority resolver registered (early)");
  return resolver;
}

/**
 * Read product info asynchronously.
 * Must be called after resolver registration but before service creation.
 */
export async function loadProductInfo(): Promise<ProductInfo | undefined> {
  const logger = getLogger();
  try {
    const productInfo = await getProductInfo(vscode.env.appRoot);
    logger.info(
      `Product info: commit=${productInfo.commit}, server=${productInfo.serverApplicationName}`,
    );
    return productInfo;
  } catch (err: unknown) {
    logger.error(
      "Failed to read product.json: server install will fail",
      err instanceof Error ? err : new Error(String(err)),
    );
    return undefined;
  }
}

/**
 * Service creation result: all services except those created earlier
 * (resolver, log terminal, logger).
 */
export interface CreatedServices {
  configManager: ConfigManager;
  serverManager: ServerManager;
  ui: VscodeWorkflowUI;
  gitConfigCopier: GitConfigCopier;
  extensionInstaller: ExtensionInstaller;
  deps: WorkflowDependencies;
  containerLifecycle: ContainerLifecycle;
  sidebarProvider: SidebarProvider;
}

/**
 * Must be called AFTER registerResolverEarly() and loadProductInfo(),
 * so the ServerManager gets the resolved product info and the
 * resolver gets wired to the ServerManager.
 */
export function createServices(
  context: vscode.ExtensionContext,
  settings: ExtensionSettings,
  resolver: RemoteAuthorityResolver,
  productInfo: ProductInfo | undefined,
  buildLogPty: LogOutputTerminal,
  host?: Host,
): CreatedServices {
  const logger = getLogger();

  const configManager = new ConfigManager();

  const serverManager = new ServerManager({
    dockerPath: settings.dockerPath,
    productInfo,
    extensionPath: context.extensionPath,
    host: host!,
  });

  // Wire the serverManager into the resolver (it was created without one)
  resolver.setServerManager(serverManager);

  const ui = new VscodeWorkflowUI(buildLogPty);

  const copyGitConfigEnabled = vscode.workspace
    .getConfiguration("artizo")
    .get<boolean>("copyGitConfig", true);
  const gitConfigCopier = new GitConfigCopier({
    dockerPath: settings.dockerPath,
    enabled: copyGitConfigEnabled,
    host: host!,
  });

  const extensionInstaller = new ExtensionInstaller({
    dockerPath: settings.dockerPath,
    host: host!,
    getUserExtensionsDir: (containerId) =>
      serverManager.getUserExtensionsDir(containerId),
    localExtensionProvider: (extId) => {
      const lower = extId.toLowerCase();
      const ext = vscode.extensions.all.find(
        (e) => e.id.toLowerCase() === lower,
      );
      return ext?.extensionPath;
    },
  });

  const deps: WorkflowDependencies = {
    configManager,
    serverManager,
    gitConfigCopier,
    extensionInstaller,
    dockerPath: settings.dockerPath,
  };

  // Register tree views, sidebar, and config watcher (local only)
  const sidebarProvider = new SidebarProvider(
    context.extensionUri,
    configManager,
    host!,
  );
  if (!isInDevContainerWindow()) {
    const watcher = ConfigWatcher.register(context, { configManager });
    watcher.onDidConfigChange(() => {
      sidebarProvider.loadConfig();
    });

    // Refresh sidebar when devcontainer.json is edited (debounced)
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    context.subscriptions.push({
      dispose: () => {
        if (debounceTimer) {
          clearTimeout(debounceTimer);
        }
      },
    });
    context.subscriptions.push(
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document.uri.fsPath.endsWith("devcontainer.json")) {
          if (debounceTimer) {
            clearTimeout(debounceTimer);
          }
          debounceTimer = setTimeout(() => {
            sidebarProvider.loadConfig();
          }, 300);
        }
      }),
    );
  }
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      "artizo.sidebar",
      sidebarProvider,
    ),
  );

  // Refresh commands when workspace folders change
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(async () => {
      await sidebarProvider.refreshCommands();
      sidebarProvider.loadConfig();
    }),
  );

  // Register the container explorer (host-side only).
  ContainerExplorerProvider.register(context);

  logger.info("Sidebar and config watcher registered");

  const containerLifecycle = new ContainerLifecycle();

  return {
    configManager,
    serverManager,
    ui,
    gitConfigCopier,
    extensionInstaller,
    deps,
    containerLifecycle,
    sidebarProvider,
  };
}

/**
 * Auto-detect devcontainer.json and offer to reopen in container.
 */
export function autoDetectDevcontainer(
  context: vscode.ExtensionContext,
  configManager: ConfigManager,
): void {
  const logger = getLogger();
  if (!isInDevContainerWindow()) {
    const detector = new DevcontainerDetector(configManager);
    detector.checkAndPrompt(context).catch((err) => {
      logger.error(
        "DevcontainerDetector failed",
        err instanceof Error ? err : new Error(String(err)),
      );
    });
  }
}
