/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockInitLogger, mockGetLogger, mockLogger } = vi.hoisted(() => ({
  mockInitLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  })),
  mockGetLogger: vi.fn(),
  mockLogger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
}));

vi.mock("vscode", () => ({
  window: {
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    createTerminal: vi
      .fn()
      .mockReturnValue({ show: vi.fn(), dispose: vi.fn() }),
    registerWebviewViewProvider: vi.fn().mockReturnValue({ dispose: vi.fn() }),
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
  Uri: {
    joinPath: (...parts: string[]) => ({ toString: () => parts.join("/") }),
  },
  languages: {
    setTextDocumentLanguage: vi.fn(),
  },
}));

vi.mock("../../src/utils/logger", () => ({
  initLogger: mockInitLogger,
  getLogger: () => mockLogger,
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
  initializeLogger,
  type ExtensionSettings,
} from "../../src/host/services";
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

      const services = createServices(
        context,
        settings,
        resolver,
        productInfo,
        pty,
      );

      expect(services.configManager).toBeDefined();
      expect(services.serverManager).toBeDefined();
      expect(services.bridge).toBeDefined();
      expect(services.orchestrator).toBeDefined();
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

      createServices(context, settings, resolver, productInfo, pty);

      expect(resolver.setServerManager).toHaveBeenCalled();
    });
  });

  describe("initializeLogger", () => {
    it("creates terminal with branded name", () => {
      const ctx = {
        subscriptions: [],
        logPath: "/logs",
        extensionPath: "/ext",
      } as any;
      const result = initializeLogger(ctx);

      expect(vscode.window.createTerminal).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Dev Containers (Artizo)" }),
      );
      expect(result.buildLogPty).toBeDefined();
      expect(result.buildLogTerminal).toBeDefined();
      expect(mockInitLogger).toHaveBeenCalled();
    });

    it("registers revealLogTerminal command", () => {
      const ctx = {
        subscriptions: [],
        logPath: "/logs",
        extensionPath: "/ext",
      } as any;
      initializeLogger(ctx);

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
      vi.mocked(vscode.window.createTerminal).mockImplementation(() => ({
        show: () => {
          callCount++;
          if (callCount === 1) throw new Error("closed");
        },
        dispose: vi.fn(),
      }));

      const result = initializeLogger(ctx);
      result.buildLogTerminal.show();

      // Should have created a second terminal
      expect(vscode.window.createTerminal).toHaveBeenCalledTimes(2);
    });
  });
});
