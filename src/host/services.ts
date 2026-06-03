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
import { initLogger, getLogger } from "../utils/logger";
import { BRAND } from "../utils/constants";
import { ConfigManager } from "../config/configManager";
import { ServerManager } from "../remote/serverManager";
import { CommunicationBridge } from "../remote/communicationBridge";
import { WorkflowOrchestrator } from "../workflows/orchestrator";
import {
  RemoteAuthorityResolver,
  registerAuthorityResolver,
} from "../remote/authorityResolver";
import { VscodeWorkflowUI } from "../workflows/vscodeUI";
import { DevcontainerDetector } from "../workflows/devcontainerDetector";
import { LogOutputTerminal, LogLevel } from "../workflows/logOutputTerminal";
import { getProductInfo, type ProductInfo } from "../remote/productInfo";
import type { WorkflowDependencies } from "../workflows/types";
import { GitConfigCopier } from "../credentials/gitConfigCopier";
import { getPlatformAdapter } from "../platform";

declare const HAS_TRAE_ADAPTER: boolean;
declare const HAS_KIRO_ADAPTER: boolean;
declare const HAS_DEVIN_ADAPTER: boolean;
import { ConfigWatcher } from "../config/configWatcher";
import { ContainerLifecycle } from "../lifecycle/containerLifecycle";
import { SidebarProvider } from "../sidebar/provider";

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
 */
async function ensureArgvProposedApi(
  _context: vscode.ExtensionContext,
): Promise<boolean> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const { parse, modify, applyEdits } = await import("jsonc-parser");

  const adapter = await getPlatformAdapter();
  const argvPath = adapter.getArgvPath();

  if (!adapter.needsArgvPatch()) {
    return false;
  }
  const extensionId = HAS_KIRO_ADAPTER
    ? "aergic.artizo-kiro"
    : HAS_TRAE_ADAPTER
      ? "aergic.artizo-trae"
      : HAS_DEVIN_ADAPTER
        ? "aergic.artizo-devin"
        : "aergic.artizo-windsurf";

  let content: string;
  try {
    content = await fs.readFile(argvPath, "utf-8");
  } catch {
    const newContent = JSON.stringify(
      { "enable-proposed-api": [extensionId] },
      null,
      "\t",
    );
    await fs.mkdir(path.dirname(argvPath), { recursive: true });
    await fs.writeFile(argvPath, newContent, "utf-8");
    return true;
  }

  const parsed = parse(content) as Record<string, unknown>;
  const existing = parsed["enable-proposed-api"];
  if (Array.isArray(existing) && existing.includes(extensionId)) {
    return false;
  }

  const newValue = Array.isArray(existing)
    ? [...existing, extensionId]
    : [extensionId];

  const edits = modify(content, ["enable-proposed-api"], newValue, {
    formattingOptions: {
      eol: "\n",
      insertSpaces: true,
      tabSize: 4,
    },
  });

  const patched = applyEdits(content, edits);
  await fs.writeFile(argvPath, patched, "utf-8");
  return true;
}

/**
 * Initialize the log terminal and logger.
 * Returns the Pty and Terminal instances for downstream use.
 */
export function initializeLogger(context: vscode.ExtensionContext): {
  buildLogPty: LogOutputTerminal;
  buildLogTerminal: vscode.Terminal;
} {
  const nodePath = require("node:path");
  const logFilePath = nodePath.join(context.logPath, "artizo.log");
  const buildLogPty = new LogOutputTerminal(logFilePath);
  const buildLogTerminal = vscode.window.createTerminal({
    name: `Dev Containers (${BRAND})`,
    pty: buildLogPty,
  });
  context.subscriptions.push(buildLogTerminal);

  const logLevelConfig = vscode.workspace
    .getConfiguration("artizo")
    .get<string>("logLevel", "info");
  const logLevelMap: Record<string, LogLevel> = {
    info: LogLevel.Info,
    debug: LogLevel.Debug,
    trace: LogLevel.Trace,
  };
  buildLogPty.setLogLevel(logLevelMap[logLevelConfig] ?? LogLevel.Info);

  const logger = initLogger(buildLogPty);
  logger.info(`${BRAND} activating...`);
  logger.info(`Extension path: ${context.extensionPath}`);
  logger.info(`Log file: ${logFilePath}`);

  // Register reveal log terminal command
  context.subscriptions.push(
    vscode.commands.registerCommand("artizo.revealLogTerminal", () => {
      buildLogTerminal.show();
    }),
  );

  return { buildLogPty, buildLogTerminal };
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
  try {
    const fs = require("node:fs");
    const path = require("node:path");
    const productPath = path.join(vscode.env.appRoot, "product.json");
    const product = JSON.parse(fs.readFileSync(productPath, "utf-8"));
    actual = product?.applicationName ?? "unknown";
  } catch {
    /* ignore */
  }

  const message = `${BRAND}: This extension is built for ${expected}. It cannot run on ${actual}. Please install the correct extension for your editor.`;
  logger.error(message);
  vscode.window.showErrorMessage(message);

  const stubError = () => vscode.window.showErrorMessage(message);
  const allCommandIds = [
    "artizo.reopenInContainer",
    "artizo.reopenLocally",
    "artizo.openDevContainerFile",
    "artizo.rebuildContainer",
    "artizo.rebuildContainerMenu",
    "artizo.rebuildContainerNoCache",
    "artizo.rebuildAndReopenInContainer",
    "artizo.revealLogTerminal",
    "artizo.configureDevContainer",
    "artizo.openFolderInContainer",
    "artizo.cloneInVolume",
    "artizo.attachToRunningContainer",
    "artizo.addConfiguration",
    "artizo.cleanUpContainers",
    "artizo.explorer.refresh",
    "artizo.explorer.connectCurrentWindow",
    "artizo.explorer.connectNewWindow",
    "artizo.ports.add",
    "artizo.ports.remove",
    "artizo.ports.setLabel",
    "artizo.volumes.refresh",
    "artizo.volumes.inspect",
    "artizo.volumes.remove",
  ];

  for (const id of allCommandIds) {
    context.subscriptions.push(vscode.commands.registerCommand(id, stubError));
  }

  return false;
}

/**
 * Handle argv.json patching: prompt restart if the API entry was just added
 * or if resolvers are still unavailable. Returns true if activation should
 * abort (restart needed).
 */
export async function ensureResolversAvailable(): Promise<boolean> {
  const logger = getLogger();
  const argvPatched = await ensureArgvProposedApi(
    {} as vscode.ExtensionContext,
  );

  if (argvPatched) {
    const adapter = await getPlatformAdapter();
    logger.info("argv.json patched, prompting for restart");
    const action = await vscode.window.showInformationMessage(
      `Dev Containers: A full restart of ${adapter.name} is required to enable remote container support. Please quit and reopen ${adapter.name}.`,
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
    const action = await vscode.window.showInformationMessage(
      `Dev Containers: A full restart of ${adapter.name} is required to enable remote container support. Please quit and reopen ${adapter.name}.`,
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
  });
  registerAuthorityResolver(context, resolver);
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
  bridge: CommunicationBridge;
  orchestrator: WorkflowOrchestrator;
  ui: VscodeWorkflowUI;
  gitConfigCopier: GitConfigCopier;
  deps: WorkflowDependencies;
  containerLifecycle: ContainerLifecycle;
  sidebarProvider: SidebarProvider;
}

/**
 * Must be called AFTER registerResolverEarly() and loadProductInfo(),
 * so that the ServerManager gets the resolved product info and the
 * resolver gets wired to the ServerManager.
 */
export function createServices(
  context: vscode.ExtensionContext,
  settings: ExtensionSettings,
  resolver: RemoteAuthorityResolver,
  productInfo: ProductInfo | undefined,
  buildLogPty: LogOutputTerminal,
): CreatedServices {
  const logger = getLogger();

  const configManager = new ConfigManager();

  const serverManager = new ServerManager({
    dockerPath: settings.dockerPath,
    productInfo,
    extensionPath: context.extensionPath,
  });

  // Wire the serverManager into the resolver (it was created without one)
  resolver.setServerManager(serverManager);

  const bridge = new CommunicationBridge({ dockerPath: settings.dockerPath });
  const orchestrator = new WorkflowOrchestrator();
  const ui = new VscodeWorkflowUI(buildLogPty);

  const copyGitConfigEnabled = vscode.workspace
    .getConfiguration("artizo")
    .get<boolean>("copyGitConfig", true);
  const gitConfigCopier = new GitConfigCopier({
    dockerPath: settings.dockerPath,
    enabled: copyGitConfigEnabled,
  });

  const deps: WorkflowDependencies = {
    configManager,
    serverManager,
    bridge,
    orchestrator,
    gitConfigCopier,
  };

  // Register tree views, sidebar, and config watcher (local only)
  const sidebarProvider = new SidebarProvider(
    context.extensionUri,
    configManager,
    settings.dockerPath,
  );
  if (!vscode.env.remoteName) {
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
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      sidebarProvider.refreshCommands();
      sidebarProvider.loadConfig();
    }),
  );

  logger.info("Sidebar and config watcher registered");

  const containerLifecycle = new ContainerLifecycle();

  return {
    configManager,
    serverManager,
    bridge,
    orchestrator,
    ui,
    gitConfigCopier,
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
  if (!vscode.env.remoteName) {
    const detector = new DevcontainerDetector(configManager);
    detector.checkAndPrompt(context).catch((err) => {
      logger.error(
        "DevcontainerDetector failed",
        err instanceof Error ? err : new Error(String(err)),
      );
    });
  }
}
