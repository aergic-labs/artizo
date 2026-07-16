/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockInitLogger, mockGetLogger, mockLogger } = vi.hoisted(() => ({
  mockInitLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    setLevel: vi.fn(),
    show: vi.fn(),
  })),
  mockGetLogger: vi.fn(),
  mockLogger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    setLevel: vi.fn(),
    show: vi.fn(),
    append: vi.fn(),
  },
}));

vi.mock("vscode", () => {
  class TreeItem {
    label: string;
    collapsibleState: number;
    description?: string;
    tooltip?: string;
    contextValue?: string;
    iconPath?: unknown;
    constructor(label: string, collapsibleState: number) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  }
  class ThemeIcon {
    id: string;
    constructor(id: string) {
      this.id = id;
    }
  }
  class EventEmitter {
    event = vi.fn();
    fire = vi.fn();
    dispose = vi.fn();
  }
  return {
  TreeItem,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon,
  EventEmitter,
  window: {
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showTextDocument: vi.fn(),
    createOutputChannel: vi.fn().mockReturnValue({
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      append: vi.fn(),
      appendLine: vi.fn(),
      show: vi.fn(),
      dispose: vi.fn(),
    }),
    createTerminal: vi
      .fn()
      .mockReturnValue({ show: vi.fn(), dispose: vi.fn() }),
    registerWebviewViewProvider: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    createTreeView: vi.fn().mockReturnValue({ dispose: vi.fn() }),
  },
  commands: {
    registerCommand: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    executeCommand: vi.fn(),
  },
  workspace: {
    getConfiguration: vi.fn().mockReturnValue({
      get: vi.fn((_key: string, defaultValue: unknown) => defaultValue),
    }),
    workspaceFolders: [{ uri: { fsPath: "/test/workspace" } }],
    onDidChangeWorkspaceFolders: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    onDidChangeTextDocument: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    registerRemoteAuthorityResolver: vi
      .fn()
      .mockReturnValue({ dispose: vi.fn() }),
    registerTextDocumentContentProvider: vi
      .fn()
      .mockReturnValue({ dispose: vi.fn() }),
  },
  env: { remoteName: undefined, appRoot: "/mock/app/root" },
  ExtensionKind: { UI: 1, Workspace: 2 },
  Uri: {
    joinPath: (...parts: string[]) => ({ toString: () => parts.join("/") }),
  },
  languages: {
    setTextDocumentLanguage: vi.fn(),
  },
  extensions: { all: [] },
  };
});

const { mockFsPromises } = vi.hoisted(() => ({
  mockFsPromises: {
    access: vi.fn(),
    readFile: vi.fn(),
    mkdir: vi.fn(),
    writeFile: vi.fn(),
  },
}));

vi.mock("node:fs/promises", () => mockFsPromises);

vi.mock("../../src/utils/logger", () => ({
  initLogger: mockInitLogger,
  getLogger: () => mockLogger,
  LogLevel: { Info: 0, Debug: 1, Trace: 2 },
}));

vi.mock("../../src/utils/constants", () => ({
  BRAND: "Artizo",
  BRAND_PREFIX: "[Artizo]",
  MANAGED_LABEL: "com.artizo.managed=true",
}));

vi.mock("../../src/platform", () => ({
  getPlatformAdapter: vi.fn().mockReturnValue({
    name: "Kiro",
    dataFolderName: ".kiro",
    serverApplicationName: "kiro-server",
    getArgvPath: () => "/home/user/.kiro/argv.json",
    needsArgvPatch: () => true,
    getArgvDataFolderNames: () => [".kiro"],
    isValidRuntime: () => true,
    getServerDownloadUrl: () => "https://example.com/server.tar.gz",
    getAdditionalDockerRunArgs: () => [],
    getServerInstallRoot: () => "/tmp",
    needsHomeSymlink: () => false,
  }),
}));

vi.mock("../../src/remote/productInfo", () => ({
  getProductInfo: vi.fn(),
}));

vi.mock("../../src/remote/authorityResolver", () => ({
  registerAuthorityResolver: vi.fn(),
  RemoteAuthorityResolver: class {
    setServerManager = vi.fn();
    constructor(opts: any) {}
  },
}));

vi.mock("../../src/workflows/vscodeUI", () => ({
  VscodeWorkflowUI: class {
    dispose = vi.fn();
  },
}));

vi.mock("../../src/workflows/logOutputTerminal", () => ({
  LogOutputTerminal: class {
    setLogLevel = vi.fn();
    dispose = vi.fn();
    write = vi.fn();
    writeLine = vi.fn();
  },
  LogLevel: { Info: 0, Debug: 1, Trace: 2 },
}));

vi.mock("../../src/workflows/devcontainerDetector", () => ({
  DevcontainerDetector: class {
    checkAndPrompt = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock("../../src/config/configManager", () => ({
  ConfigManager: class {},
}));

vi.mock("../../src/config/configWatcher", () => ({
  ConfigWatcher: {
    register: vi.fn().mockReturnValue({
      onDidConfigChange: vi.fn(),
      dispose: vi.fn(),
    }),
  },
}));

vi.mock("../../src/lifecycle/containerLifecycle", () => ({
  ContainerLifecycle: class {},
}));

import * as vscode from "vscode";
import {
  readSettings,
  registerResolverEarly,
  loadProductInfo,
  autoDetectDevcontainer,
  createServices,
  createBuildLogTerminal,
  ensureResolversAvailable,
  validatePlatformRuntime,
  getArgvExtensionId,
  type ExtensionSettings,
} from "../../src/host/services";
import { patchArgvContent } from "../../src/host/argvPatch";
import { getPlatformAdapter } from "../../src/platform";
import { initTier } from "../../src/host/state";
import { getProductInfo } from "../../src/remote/productInfo";
import type { ProductInfo } from "../../src/remote/productInfo";
import type { RemoteAuthorityResolver } from "../../src/remote/authorityResolver";
import type { LogOutputTerminal } from "../../src/workflows/logOutputTerminal";

describe("services", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("readSettings", () => {
    it("returns settings from vscode configuration", () => {
      const settings = readSettings();
      expect(settings.dockerPath).toBe("docker");
      expect(vscode.workspace.getConfiguration).toHaveBeenCalledWith("artizo");
    });

    it("uses custom docker path from config", () => {
      vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
        get: vi.fn().mockReturnValue("/custom/docker"),
      } as any);

      const settings = readSettings();
      expect(settings.dockerPath).toBe("/custom/docker");
    });
  });

  describe("registerResolverEarly", () => {
    it("creates and registers the authority resolver", () => {
      const context = { subscriptions: [] } as any;
      const settings: ExtensionSettings = { dockerPath: "docker" };

      const resolver = registerResolverEarly(context, settings);

      expect(resolver).toBeDefined();
      expect(mockLogger.info).toHaveBeenCalledWith(
        "Authority resolver registered (early)",
      );
    });
  });

  describe("loadProductInfo", () => {
    it("returns product info on success", async () => {
      vi.mocked(getProductInfo).mockResolvedValue({
        commit: "abc123",
        serverApplicationName: "kiro-server",
      } as ProductInfo);

      const result = await loadProductInfo();

      expect(result).toBeDefined();
      expect(result!.commit).toBe("abc123");
    });

    it("returns undefined and logs error on failure", async () => {
      vi.mocked(getProductInfo).mockRejectedValue(new Error("read failed"));

      const result = await loadProductInfo();

      expect(result).toBeUndefined();
      expect(mockLogger.error).toHaveBeenCalledWith(
        "Failed to read product.json: server install will fail",
        expect.any(Error),
      );
    });
  });

  describe("autoDetectDevcontainer", () => {
    it("skips detection when running in a remote", () => {
      const context = { subscriptions: [] } as any;
      (vscode.env as any).remoteName = "artizo-container";

      autoDetectDevcontainer(context, {} as any);

      // No error should be thrown; function returns early
    });

    it("runs detector locally and swallows errors", () => {
      const context = { subscriptions: [] } as any;
      (vscode.env as any).remoteName = undefined;

      autoDetectDevcontainer(context, {} as any);

      // Should not throw; errors are caught by .catch()
    });
  });

  describe("createServices", () => {
    function makeResolver(): RemoteAuthorityResolver {
      return { setServerManager: vi.fn() } as any;
    }

    it("constructs all service objects", () => {
      const context = {
        subscriptions: [],
        extensionUri: { toString: () => "/ext" },
        globalState: {
          get: vi.fn((_k: string, d: unknown) => d),
          update: vi.fn().mockResolvedValue(undefined),
        },
      } as any;
      const settings: ExtensionSettings = { dockerPath: "docker" };
      const resolver = makeResolver();
      const productInfo: ProductInfo = {
        commit: "abc",
        quality: "stable",
        serverApplicationName: "kiro-server",
        serverDataFolderName: ".kiro-server",
      };
      const pty = {
        writeLine: vi.fn(),
        dispose: vi.fn(),
      } as unknown as LogOutputTerminal;

      const mockHost = {
        kind: "local" as const,
        dockerPath: "docker",
        exec: vi
          .fn()
          .mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" }),
        onReady: vi.fn(() => ({ dispose: vi.fn() })),
      } as any;

      const services = createServices(
        context,
        settings,
        resolver,
        productInfo,
        pty,
        mockHost,
      );

      expect(services.configManager).toBeDefined();
      expect(services.serverManager).toBeDefined();
      expect(services.ui).toBeDefined();
      expect(services.gitConfigCopier).toBeDefined();
      expect(services.deps).toBeDefined();
      expect(services.containerLifecycle).toBeDefined();
      expect(services.sidebarProvider).toBeDefined();
    });

    it("wires the serverManager into the resolver", () => {
      const context = {
        subscriptions: [],
        extensionUri: { toString: () => "/ext" },
        globalState: {
          get: vi.fn((_k: string, d: unknown) => d),
          update: vi.fn().mockResolvedValue(undefined),
        },
      } as any;
      const settings: ExtensionSettings = { dockerPath: "docker" };
      const resolver = makeResolver();
      const productInfo: ProductInfo = {
        commit: "abc",
        quality: "stable",
        serverApplicationName: "kiro-server",
        serverDataFolderName: ".kiro-server",
      };
      const pty = {
        writeLine: vi.fn(),
        dispose: vi.fn(),
      } as unknown as LogOutputTerminal;

      const mockHost = {
        kind: "local" as const,
        dockerPath: "docker",
        exec: vi
          .fn()
          .mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" }),
        onReady: vi.fn(() => ({ dispose: vi.fn() })),
      } as any;

      createServices(context, settings, resolver, productInfo, pty, mockHost);

      expect(resolver.setServerManager).toHaveBeenCalled();
    });
  });

  describe("createBuildLogTerminal", () => {
    it("creates terminal with branded name", () => {
      const ctx = {
        subscriptions: [],
        logPath: "/logs",
        extensionPath: "/ext",
      } as any;
      const result = createBuildLogTerminal(ctx);

      result.buildLogTerminal.show();

      expect(vscode.window.createTerminal).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Dev Containers (Artizo)" }),
      );
      expect(result.buildLogPty).toBeDefined();
      expect(result.buildLogTerminal).toBeDefined();
    });

    it("registers revealLogTerminal command", () => {
      const ctx = {
        subscriptions: [],
        logPath: "/logs",
        extensionPath: "/ext",
      } as any;
      createBuildLogTerminal(ctx);

      expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
        "artizo.revealLogTerminal",
        expect.any(Function),
      );
    });

    it("recreates terminal when show fails", () => {
      const ctx = {
        subscriptions: [],
        logPath: "/logs",
        extensionPath: "/ext",
      } as any;

      // First terminal.show() throws
      let callCount = 0;
      vi.mocked(vscode.window.createTerminal).mockImplementation(
        () =>
          ({
            show: () => {
              callCount++;
              if (callCount === 1) throw new Error("closed");
            },
            dispose: vi.fn(),
          }) as any,
      );

      const result = createBuildLogTerminal(ctx);
      result.buildLogTerminal.show();

      // Should have created a second terminal
      expect(vscode.window.createTerminal).toHaveBeenCalledTimes(2);
    });
  });

  describe("getArgvExtensionId", () => {
    it("returns the vscodium extension ID when all adapter flags are false", () => {
      // test/setup.ts sets all HAS_*_ADAPTER flags to false
      expect(getArgvExtensionId()).toBe("aergic.artizo-vscodium");
    });

    it("returns the Kiro extension ID when HAS_KIRO_ADAPTER is set", () => {
      (globalThis as any).HAS_KIRO_ADAPTER = true;
      try {
        expect(getArgvExtensionId()).toBe("aergic.artizo-kiro");
      } finally {
        (globalThis as any).HAS_KIRO_ADAPTER = false;
      }
    });
  });

  describe("patchArgvContent", () => {
    it("adds the extension ID to an empty argv.json", () => {
      const content = JSON.stringify({}, null, "\t");
      const result = patchArgvContent(content, "aergic.artizo-kiro");
      expect(result).not.toBeNull();
      expect(result!.changed).toBe(true);
      const parsed = JSON.parse(result!.patched);
      expect(parsed["enable-proposed-api"]).toEqual(["aergic.artizo-kiro"]);
    });

    it("appends to an existing enable-proposed-api array", () => {
      const content = JSON.stringify(
        { "enable-proposed-api": ["other.ext"] },
        null,
        "\t",
      );
      const result = patchArgvContent(content, "aergic.artizo-kiro");
      expect(result).not.toBeNull();
      const parsed = JSON.parse(result!.patched);
      expect(parsed["enable-proposed-api"]).toEqual([
        "other.ext",
        "aergic.artizo-kiro",
      ]);
    });

    it("returns null when the ID is already present", () => {
      const content = JSON.stringify(
        { "enable-proposed-api": ["aergic.artizo-kiro"] },
        null,
        "\t",
      );
      const result = patchArgvContent(content, "aergic.artizo-kiro");
      expect(result).toBeNull();
    });
  });

  describe("ensureResolversAvailable", () => {
    afterEach(() => {
      (vscode.env as any).remoteName = undefined;
      initTier(undefined);
    });

    it("returns false immediately when workspace-side on SSH remote", async () => {
      (vscode.env as any).remoteName = "ssh-remote";
      initTier(vscode.ExtensionKind.Workspace);

      const result = await ensureResolversAvailable();

      expect(result).toBe(false);
      expect(mockLogger.info).toHaveBeenCalledWith(
        "ensureResolversAvailable: workspace-side on SSH remote, skipping modal",
      );
    });

    it("returns true and quits when argv.json was just patched", async () => {
      (vscode.env as any).remoteName = undefined;
      initTier(undefined);

      vi.mocked(getPlatformAdapter).mockReturnValue({
        name: "Kiro",
        needsArgvPatch: () => true,
        getArgvDataFolderNames: () => [".kiro"],
      } as any);

      mockFsPromises.access.mockRejectedValue(new Error("ENOENT"));
      mockFsPromises.readFile.mockRejectedValue(new Error("ENOENT"));
      mockFsPromises.mkdir.mockResolvedValue(undefined);
      mockFsPromises.writeFile.mockResolvedValue(undefined);

      vi.mocked(vscode.window.showErrorMessage).mockResolvedValue(
        "Quit Kiro" as any,
      );

      const result = await ensureResolversAvailable();

      expect(result).toBe(true);
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining("full restart of Kiro"),
        expect.objectContaining({ modal: true }),
        "Quit Kiro",
      );
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        "workbench.action.quit",
      );
    });

    it("returns true without quitting when user dismisses restart prompt", async () => {
      (vscode.env as any).remoteName = undefined;
      initTier(undefined);

      vi.mocked(getPlatformAdapter).mockReturnValue({
        name: "Kiro",
        needsArgvPatch: () => true,
        getArgvDataFolderNames: () => [".kiro"],
      } as any);

      mockFsPromises.access.mockRejectedValue(new Error("ENOENT"));
      mockFsPromises.readFile.mockRejectedValue(new Error("ENOENT"));
      mockFsPromises.mkdir.mockResolvedValue(undefined);
      mockFsPromises.writeFile.mockResolvedValue(undefined);

      vi.mocked(vscode.window.showErrorMessage).mockResolvedValue(
        undefined as any,
      );

      const result = await ensureResolversAvailable();

      expect(result).toBe(true);
      expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
    });

    it("returns true when resolvers API is unavailable", async () => {
      (vscode.env as any).remoteName = undefined;
      initTier(undefined);

      vi.mocked(getPlatformAdapter).mockReturnValue({
        name: "Kiro",
        needsArgvPatch: () => false,
        getArgvDataFolderNames: () => [".kiro"],
      } as any);

      const saved = (vscode.workspace as any).registerRemoteAuthorityResolver;
      (vscode.workspace as any).registerRemoteAuthorityResolver = undefined;
      try {
        vi.mocked(vscode.window.showErrorMessage).mockResolvedValue(
          undefined as any,
        );

        const result = await ensureResolversAvailable();

        expect(result).toBe(true);
        expect(mockLogger.info).toHaveBeenCalledWith(
          "resolvers API not available, full restart required",
        );
      } finally {
        (vscode.workspace as any).registerRemoteAuthorityResolver = saved;
      }
    });

    it("returns false when argv not needed and resolvers API available", async () => {
      (vscode.env as any).remoteName = undefined;
      initTier(undefined);

      vi.mocked(getPlatformAdapter).mockReturnValue({
        name: "Kiro",
        needsArgvPatch: () => false,
        getArgvDataFolderNames: () => [".kiro"],
      } as any);

      const result = await ensureResolversAvailable();

      expect(result).toBe(false);
    });

    it("returns false when argv already patched and resolvers available", async () => {
      (vscode.env as any).remoteName = undefined;
      initTier(undefined);

      vi.mocked(getPlatformAdapter).mockReturnValue({
        name: "Kiro",
        needsArgvPatch: () => true,
        getArgvDataFolderNames: () => [".kiro"],
      } as any);

      const alreadyPatched = JSON.stringify({
        "enable-proposed-api": [getArgvExtensionId()],
      });
      mockFsPromises.access.mockResolvedValue(undefined);
      mockFsPromises.readFile.mockResolvedValue(alreadyPatched);

      const result = await ensureResolversAvailable();

      expect(result).toBe(false);
    });
  });

  describe("validatePlatformRuntime", () => {
    it("returns true when runtime is valid", async () => {
      vi.mocked(getPlatformAdapter).mockReturnValue({
        name: "Kiro",
        isValidRuntime: () => true,
      } as any);

      const context = { subscriptions: [] } as any;
      const result = await validatePlatformRuntime(context);

      expect(result).toBe(true);
    });

    it("returns false, shows error, and registers sidebar when invalid", async () => {
      vi.mocked(getPlatformAdapter).mockReturnValue({
        name: "Kiro",
        isValidRuntime: () => false,
      } as any);

      const context = { subscriptions: [] } as any;
      const result = await validatePlatformRuntime(context);

      expect(result).toBe(false);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("built for Kiro"),
      );
      expect(vscode.window.showErrorMessage).toHaveBeenCalled();
      expect(vscode.window.registerWebviewViewProvider).toHaveBeenCalledWith(
        "artizo.sidebar",
        expect.any(Object),
      );
    });
  });
});
