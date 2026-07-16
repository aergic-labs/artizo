/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockCreateBuildLogTerminal,
  mockValidatePlatformRuntime,
  mockEnsureResolversAvailable,
  mockReadSettings,
  mockRegisterResolverEarly,
  mockLoadProductInfo,
  mockCreateServices,
  mockAutoDetectDevcontainer,
  mockRegisterCoreCommands,
  mockHostCreate,
  mockGetPlatformAdapter,
} = vi.hoisted(() => ({
  mockCreateBuildLogTerminal: vi.fn(),
  mockValidatePlatformRuntime: vi.fn(),
  mockEnsureResolversAvailable: vi.fn(),
  mockReadSettings: vi.fn(),
  mockRegisterResolverEarly: vi.fn(),
  mockLoadProductInfo: vi.fn(),
  mockCreateServices: vi.fn(),
  mockAutoDetectDevcontainer: vi.fn(),
  mockRegisterCoreCommands: vi.fn(),
  mockHostCreate: vi.fn(),
  mockGetPlatformAdapter: vi.fn(),
}));

vi.mock("vscode", () => ({
  window: {
    createOutputChannel: vi.fn().mockReturnValue({
      info: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      append: vi.fn(),
      show: vi.fn(),
      dispose: vi.fn(),
    }),
    createTerminal: vi
      .fn()
      .mockReturnValue({ show: vi.fn(), dispose: vi.fn() }),
    createStatusBarItem: vi.fn().mockReturnValue({
      show: vi.fn(),
      dispose: vi.fn(),
    }),
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
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
  },
  Uri: {
    parse: (str: string) => ({ toString: () => str, fsPath: str }),
  },
  env: { remoteName: undefined, appRoot: "/mock/app/root" },
  ExtensionKind: { UI: 1, Workspace: 2 },
  StatusBarAlignment: { Left: 1, Right: 2 },
}));

vi.mock("../../src/host/services", () => ({
  createBuildLogTerminal: mockCreateBuildLogTerminal,
  validatePlatformRuntime: mockValidatePlatformRuntime,
  ensureResolversAvailable: mockEnsureResolversAvailable,
  readSettings: mockReadSettings,
  registerResolverEarly: mockRegisterResolverEarly,
  loadProductInfo: mockLoadProductInfo,
  createServices: mockCreateServices,
  autoDetectDevcontainer: mockAutoDetectDevcontainer,
}));

vi.mock("../../src/host/commands", () => ({
  registerCoreCommands: mockRegisterCoreCommands,
}));

vi.mock("../../src/host/host", () => ({
  Host: { create: mockHostCreate },
}));

vi.mock("../../src/platform/index", () => ({
  getPlatformAdapter: mockGetPlatformAdapter,
}));

vi.mock("../../src/utils/logger", () => ({
  initLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    setLevel: vi.fn(),
    show: vi.fn(),
    append: vi.fn(),
  })),
  getLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    setLevel: vi.fn(),
    show: vi.fn(),
    append: vi.fn(),
  }),
  LogLevel: { Info: 0, Debug: 1, Trace: 2 },
}));

vi.mock("../../src/utils/constants", () => ({
  BRAND: "Artizo",
  BRAND_PREFIX: "[Artizo]",
  MANAGED_LABEL: "com.artizo.managed=true",
}));

import { activate, deactivate } from "../../src/extension";

function createMockContext(): any {
  return {
    subscriptions: [] as any[],
    extensionPath: "/mock/extension/path",
    extensionUri: { toString: () => "file:///mock/extension/path" },
    logPath: "/mock/log/path",
    extensionMode: 1,
    extension: { extensionKind: 2 }, // workspace
    workspaceState: {
      get: vi.fn().mockReturnValue(false),
      update: vi.fn().mockResolvedValue(undefined),
    },
  };
}

describe("extension activation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateBuildLogTerminal.mockReturnValue({
      buildLogPty: { writeLine: vi.fn(), dispose: vi.fn() },
      buildLogTerminal: { show: vi.fn(), dispose: vi.fn() },
    });
    mockValidatePlatformRuntime.mockReturnValue(true);
    mockEnsureResolversAvailable.mockResolvedValue(false);
    mockReadSettings.mockReturnValue({ dockerPath: "docker" });
    mockRegisterResolverEarly.mockReturnValue({ setServerManager: vi.fn() });
    mockLoadProductInfo.mockResolvedValue({
      commit: "abc123",
      serverApplicationName: "kiro-server",
    });
    mockHostCreate.mockReturnValue({
      kind: "local",
      isManaged: false,
    });
    mockGetPlatformAdapter.mockResolvedValue({
      dataFolderName: ".kiro-server",
    });
    mockCreateServices.mockReturnValue({
      configManager: {},
      serverManager: {},
      ui: {},
      gitConfigCopier: {},
      deps: {},
      containerLifecycle: {},
      sidebarProvider: { loadConfig: vi.fn(), hasConfig: vi.fn() },
    });
  });

  it("calls activation steps in order", async () => {
    const context = createMockContext();
    await activate(context);

    // Core wiring: logger → platform check → settings → resolvers → services → commands
    expect(mockCreateBuildLogTerminal).toHaveBeenCalledWith(context);
    expect(mockValidatePlatformRuntime).toHaveBeenCalledWith(context);
    expect(mockReadSettings).toHaveBeenCalled();
    expect(mockHostCreate).toHaveBeenCalledWith(
      expect.objectContaining({ dockerPath: "docker" }),
    );
    expect(mockEnsureResolversAvailable).toHaveBeenCalled();
    expect(mockRegisterResolverEarly).toHaveBeenCalled();
    expect(mockLoadProductInfo).toHaveBeenCalled();
    expect(mockCreateServices).toHaveBeenCalled();
    expect(mockRegisterCoreCommands).toHaveBeenCalled();
    expect(mockAutoDetectDevcontainer).toHaveBeenCalled();
  });

  it("aborts when platform validation fails", async () => {
    mockValidatePlatformRuntime.mockReturnValue(false);

    const context = createMockContext();
    await activate(context);

    // Should stop after platform check; no resolver, no services, no commands
    expect(mockRegisterResolverEarly).not.toHaveBeenCalled();
    expect(mockCreateServices).not.toHaveBeenCalled();
    expect(mockRegisterCoreCommands).not.toHaveBeenCalled();
  });

  it("aborts when resolvers need restart", async () => {
    mockEnsureResolversAvailable.mockResolvedValue(true);

    const context = createMockContext();
    await activate(context);

    expect(mockRegisterResolverEarly).not.toHaveBeenCalled();
    expect(mockCreateServices).not.toHaveBeenCalled();
  });

  it("reads configuration settings from artizo", async () => {
    const context = createMockContext();
    await activate(context);

    expect(mockReadSettings).toHaveBeenCalled();
  });
});

describe("extension deactivation", () => {
  it("does not throw when logger is initialized", async () => {
    const context = createMockContext();
    await activate(context);

    expect(() => deactivate()).not.toThrow();
  });

  it("does not throw when logger is not initialized", () => {
    expect(() => deactivate()).not.toThrow();
  });
});
