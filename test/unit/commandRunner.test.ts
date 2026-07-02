/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const capturedHandlers: Record<string, () => Promise<void>> = {};

const mockLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
};

vi.mock("../../src/utils/logger", () => ({
  getLogger: () => mockLogger,
}));

vi.mock("../../src/utils/constants", () => ({
  BRAND_PREFIX: "[Artizo]",
  BRAND: "Artizo",
  MANAGED_LABEL: "com.artizo.managed=true",
}));

const { mockReportProvisionFailure } = vi.hoisted(() => ({
  mockReportProvisionFailure: vi.fn(),
}));

vi.mock("../../src/devcontainer/provisionError", () => ({
  ProvisionFailedError: class extends Error {
    constructor(message: string) {
      super(message);
      this.name = "ProvisionFailedError";
    }
  },
}));

vi.mock("../../src/host/reportProvisionFailure", () => ({
  reportProvisionFailure: mockReportProvisionFailure,
}));

vi.mock("../../src/host/guards", () => ({
  guardHostContext: vi.fn(),
  checkDockerAvailable: vi.fn(),
  getHostWorkspaceFolder: vi.fn(),
}));

vi.mock("vscode", () => ({
  window: {
    showErrorMessage: vi.fn().mockResolvedValue(undefined),
  },
  commands: {
    registerCommand: vi.fn((id: string, handler: () => Promise<void>) => {
      capturedHandlers[id] = handler;
      return { dispose: vi.fn() };
    }),
  },
  Uri: {
    file: (p: string) => ({ fsPath: p, scheme: "file", path: p }),
  },
}));

import * as vscode from "vscode";
import {
  guardHostContext,
  checkDockerAvailable,
  getHostWorkspaceFolder,
} from "../../src/host/guards";
import {
  registerCommand,
  type CommandSpec,
} from "../../src/host/commandRunner";
import { ProvisionFailedError } from "../../src/devcontainer/provisionError";
import type { CommandContext } from "../../src/host/commands";

function createMockCommandContext(
  overrides: Partial<CommandContext> = {},
): CommandContext {
  return {
    deps: {} as any,
    ui: {} as any,
    configManager: {} as any,
    containerLifecycle: {} as any,
    buildLogTerminal: { show: vi.fn(), dispose: vi.fn() } as any,
    buildLogPty: {
      writeLine: vi.fn(),
      write: vi.fn(),
      show: vi.fn(),
      dispose: vi.fn(),
    } as any,
    dockerPath: "docker",
    extensionUri: vscode.Uri.file("/test/extension"),
    sidebarProvider: {} as any,
    ...overrides,
  };
}

function makeSpec(overrides: Partial<CommandSpec> = {}): CommandSpec {
  return {
    id: "test.command",
    label: "Test Command",
    guardLocal: false,
    guardDocker: false,
    workspaceRequired: false,
    handler: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("registerCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(capturedHandlers)) {
      delete capturedHandlers[key];
    }
  });

  it("pushes a disposable to context.subscriptions", () => {
    const ctx = createMockCommandContext();
    const context = { subscriptions: [] as any[] };
    const spec = makeSpec();

    registerCommand(context as any, ctx, spec);

    expect(context.subscriptions.length).toBe(1);
  });

  it("registers the command with vscode.commands.registerCommand", () => {
    const ctx = createMockCommandContext();
    const context = { subscriptions: [] };
    const spec = makeSpec({ id: "artizo.test" });

    registerCommand(context as any, ctx, spec);

    expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
      "artizo.test",
      expect.any(Function),
    );
    expect(capturedHandlers["artizo.test"]).toBeDefined();
  });

  describe("handler execution", () => {
    it("executes the spec handler", async () => {
      const ctx = createMockCommandContext();
      const context = { subscriptions: [] };
      const handler = vi.fn().mockResolvedValue(undefined);
      const spec = makeSpec({ id: "test.run", handler });

      registerCommand(context as any, ctx, spec);
      await capturedHandlers["test.run"]();

      expect(handler).toHaveBeenCalledWith(ctx, undefined);
    });

    it("logs start and completion", async () => {
      const ctx = createMockCommandContext();
      const context = { subscriptions: [] };
      const spec = makeSpec({ id: "test.log", label: "Log Test" });

      registerCommand(context as any, ctx, spec);
      await capturedHandlers["test.log"]();

      expect(mockLogger.info).toHaveBeenCalledWith("=== Log Test starting ===");
      expect(mockLogger.info).toHaveBeenCalledWith(
        "=== Log Test completed ===",
      );
    });

    it("writes start and done messages to buildLogPty", async () => {
      const ctx = createMockCommandContext();
      const context = { subscriptions: [] };
      const spec = makeSpec({ id: "test.pty", label: "PTY Test" });

      registerCommand(context as any, ctx, spec);
      await capturedHandlers["test.pty"]();

      expect(ctx.buildLogPty.writeLine).toHaveBeenCalledWith(
        "[Artizo] PTY Test starting...",
      );
      expect(ctx.buildLogPty.writeLine).toHaveBeenCalledWith("[Artizo] Done.");
    });

    it("shows the build log terminal", async () => {
      const ctx = createMockCommandContext();
      const context = { subscriptions: [] };
      const spec = makeSpec({ id: "test.show" });

      registerCommand(context as any, ctx, spec);
      await capturedHandlers["test.show"]();

      expect(ctx.buildLogTerminal.show).toHaveBeenCalled();
    });
  });

  describe("workspaceRequired", () => {
    it("resolves workspace folder when required", async () => {
      const ctx = createMockCommandContext();
      const context = { subscriptions: [] };
      vi.mocked(getHostWorkspaceFolder).mockReturnValue("/my/workspace");
      const handler = vi.fn().mockResolvedValue(undefined);
      const spec = makeSpec({
        id: "test.ws",
        workspaceRequired: true,
        handler,
      });

      registerCommand(context as any, ctx, spec);
      await capturedHandlers["test.ws"]();

      expect(handler).toHaveBeenCalledWith(ctx, "/my/workspace");
      expect(ctx.buildLogPty.writeLine).toHaveBeenCalledWith(
        "[Artizo] Workspace: /my/workspace",
      );
    });

    it("shows error when workspace is required but none exists", async () => {
      const ctx = createMockCommandContext();
      const context = { subscriptions: [] };
      vi.mocked(getHostWorkspaceFolder).mockReturnValue(undefined);
      const handler = vi.fn();
      const spec = makeSpec({
        id: "test.nows",
        workspaceRequired: true,
        handler,
      });

      registerCommand(context as any, ctx, spec);
      await capturedHandlers["test.nows"]();

      expect(handler).not.toHaveBeenCalled();
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        "No workspace folder open.",
      );
    });
  });

  describe("guards", () => {
    it("executes guardLocal when spec requires it", async () => {
      const ctx = createMockCommandContext();
      const context = { subscriptions: [] };
      const spec = makeSpec({ id: "test.guard", guardLocal: true });

      registerCommand(context as any, ctx, spec);
      await capturedHandlers["test.guard"]();

      expect(guardHostContext).toHaveBeenCalled();
    });

    it("executes checkDockerAvailable when spec requires it", async () => {
      const ctx = createMockCommandContext();
      const context = { subscriptions: [] };
      const spec = makeSpec({ id: "test.docker", guardDocker: true });

      registerCommand(context as any, ctx, spec);
      await capturedHandlers["test.docker"]();

      expect(checkDockerAvailable).toHaveBeenCalledWith(ctx.dockerPath);
    });

    it("double-guards when both guardLocal and guardDocker are true", async () => {
      const ctx = createMockCommandContext();
      const context = { subscriptions: [] };
      const spec = makeSpec({
        id: "test.both",
        guardLocal: true,
        guardDocker: true,
      });

      registerCommand(context as any, ctx, spec);
      await capturedHandlers["test.both"]();

      // guardHostContext called twice (once standalone, once as double-guard)
      expect(guardHostContext).toHaveBeenCalledTimes(2);
      expect(checkDockerAvailable).toHaveBeenCalledTimes(1);
    });

    it("does not execute guards when both are false", async () => {
      const ctx = createMockCommandContext();
      const context = { subscriptions: [] };
      const spec = makeSpec({ id: "test.noguard" });

      registerCommand(context as any, ctx, spec);
      await capturedHandlers["test.noguard"]();

      expect(guardHostContext).not.toHaveBeenCalled();
      expect(checkDockerAvailable).not.toHaveBeenCalled();
    });
  });

  describe("error handling", () => {
    it("catches errors from the handler and shows error message", async () => {
      const ctx = createMockCommandContext();
      const context = { subscriptions: [] };
      const handler = vi.fn().mockRejectedValue(new Error("Boom!"));
      const spec = makeSpec({ id: "test.err", label: "Error Test", handler });

      registerCommand(context as any, ctx, spec);
      await capturedHandlers["test.err"]();

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        "Error Test failed: Boom!",
        "Show Log",
      );
    });

    it("writes error to buildLogPty", async () => {
      const ctx = createMockCommandContext();
      const context = { subscriptions: [] };
      const error = new Error("Something broke");
      const handler = vi.fn().mockRejectedValue(error);
      const spec = makeSpec({ id: "test.ptyerr", label: "PTY Err", handler });

      registerCommand(context as any, ctx, spec);
      await capturedHandlers["test.ptyerr"]();

      expect(ctx.buildLogPty.writeLine).toHaveBeenCalledWith(
        "[Artizo] ERROR: Something broke",
      );
      expect(ctx.buildLogPty.writeLine).toHaveBeenCalledWith(error.stack!);
    });

    it("shows build log terminal on error", async () => {
      const ctx = createMockCommandContext();
      const context = { subscriptions: [] };
      const handler = vi.fn().mockRejectedValue(new Error("fail"));
      const spec = makeSpec({ id: "test.showerr", handler });

      registerCommand(context as any, ctx, spec);
      await capturedHandlers["test.showerr"]();

      // Called once to show at start, once more on error
      expect(ctx.buildLogTerminal.show).toHaveBeenCalledTimes(2);
    });

    it("converts non-Error throws to Error", async () => {
      const ctx = createMockCommandContext();
      const context = { subscriptions: [] };
      const handler = vi.fn().mockRejectedValue("string error");
      const spec = makeSpec({
        id: "test.strerr",
        label: "String Err",
        handler,
      });

      registerCommand(context as any, ctx, spec);
      await capturedHandlers["test.strerr"]();

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        "String Err failed: string error",
        "Show Log",
      );
      expect(mockLogger.error).toHaveBeenCalledWith(
        "String Err failed",
        expect.any(Error),
      );
    });

    it('shows log terminal when user clicks "Show Log"', async () => {
      const ctx = createMockCommandContext();
      const context = { subscriptions: [] };
      const handler = vi.fn().mockRejectedValue(new Error("fail"));
      const spec = makeSpec({ id: "test.showlog", label: "ShowLog", handler });

      let resolveAction: (value: any) => void;
      vi.mocked(vscode.window.showErrorMessage).mockReturnValue(
        new Promise((resolve) => {
          resolveAction = resolve;
        }),
      );

      registerCommand(context as any, ctx, spec);
      const handlerPromise = capturedHandlers["test.showlog"]();

      // Resolve the error dialog with "Show Log"
      resolveAction!("Show Log");
      await handlerPromise;

      // Called 3 times: start, error handler, then "Show Log" action
      expect(ctx.buildLogTerminal.show).toHaveBeenCalledTimes(3);
    });

    it("handles error without stack", async () => {
      const ctx = createMockCommandContext();
      const context = { subscriptions: [] };
      const error = new Error("no stack");
      delete (error as any).stack;
      const handler = vi.fn().mockRejectedValue(error);
      const spec = makeSpec({ id: "test.nostack", label: "NoStack", handler });

      registerCommand(context as any, ctx, spec);
      await capturedHandlers["test.nostack"]();

      // Error message still logged, but stack writeLine NOT called
      expect(ctx.buildLogPty.writeLine).toHaveBeenCalledWith(
        "[Artizo] ERROR: no stack",
      );
      // Only the ERROR message + "Done." were written, no stack line
      expect(mockLogger.error).toHaveBeenCalledWith(
        "NoStack failed",
        expect.any(Error),
      );
    });

    it("routes ProvisionFailedError to reportProvisionFailure", async () => {
      const ctx = createMockCommandContext();
      const context = { subscriptions: [] };
      const handler = vi
        .fn()
        .mockRejectedValue(new ProvisionFailedError("provision boom"));
      const spec = makeSpec({
        id: "test.provision",
        label: "ProvisionErr",
        workspaceRequired: true,
        handler,
      });
      vi.mocked(getHostWorkspaceFolder).mockReturnValue("/ws");

      registerCommand(context as any, ctx, spec);
      await capturedHandlers["test.provision"]();

      expect(mockReportProvisionFailure).toHaveBeenCalledWith(
        expect.any(ProvisionFailedError),
        {
          buildLogPty: ctx.buildLogPty,
          buildLogTerminal: ctx.buildLogTerminal,
          configManager: ctx.configManager,
          extensionUri: ctx.extensionUri,
        },
        "/ws",
      );
    });
  });
});
