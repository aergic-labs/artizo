/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("vscode", () => ({
  window: {
    withProgress: vi.fn(),
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
  },
  commands: {
    executeCommand: vi.fn(),
  },
  ProgressLocation: {
    Notification: 15,
  },
  Uri: {
    parse: (s: string) => ({
      scheme: "vscode-remote",
      authority: "artizo-container+hex",
      path: "/workspace",
      toString: () => s,
    }),
    from: (opts: any) => ({
      scheme: opts.scheme,
      authority: opts.authority,
      path: opts.path,
      forceNewWindow: opts.forceNewWindow,
    }),
  },
}));

vi.mock("../../src/terminal/outputParser", () => ({
  parseCliOutputLine: vi.fn(),
  formatEventForTerminal: vi.fn(),
  formatEventForChannel: vi.fn(),
}));

import * as vscode from "vscode";
import {
  parseCliOutputLine,
  formatEventForTerminal,
} from "../../src/terminal/outputParser";
import { VscodeWorkflowUI } from "../../src/workflows/vscodeUI";
import { LogOutputTerminal } from "../../src/workflows/logOutputTerminal";

function createMockBuildLogPty() {
  return {
    write: vi.fn(),
    writeLine: vi.fn(),
    show: vi.fn(),
    dispose: vi.fn(),
  } as unknown as LogOutputTerminal;
}

describe("VscodeWorkflowUI", () => {
  describe("constructor and dispose", () => {
    it("stores the build log pty", () => {
      const pty = createMockBuildLogPty();
      const ui = new VscodeWorkflowUI(pty);
      expect(ui).toBeDefined();
    });

    it("dispose calls buildLogPty.dispose", () => {
      const pty = createMockBuildLogPty();
      const ui = new VscodeWorkflowUI(pty);
      ui.dispose();
      expect(pty.dispose).toHaveBeenCalled();
    });
  });

  describe("showError", () => {
    it("delegates to vscode.window.showErrorMessage", async () => {
      const pty = createMockBuildLogPty();
      const ui = new VscodeWorkflowUI(pty);
      vi.mocked(vscode.window.showErrorMessage).mockResolvedValue(undefined);

      await ui.showError("Something failed", "Retry", "Cancel");

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        "Something failed",
        "Retry",
        "Cancel",
      );
    });

    it("returns the selected action", async () => {
      const pty = createMockBuildLogPty();
      const ui = new VscodeWorkflowUI(pty);
      vi.mocked(vscode.window.showErrorMessage).mockResolvedValue(
        "Retry" as any,
      );

      const result = await ui.showError("Fail", "Retry");

      expect(result).toBe("Retry");
    });
  });

  describe("showInfo", () => {
    it("delegates to vscode.window.showInformationMessage", async () => {
      const pty = createMockBuildLogPty();
      const ui = new VscodeWorkflowUI(pty);
      vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(
        undefined,
      );

      await ui.showInfo("All good", "OK");

      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        "All good",
        "OK",
      );
    });
  });

  describe("promptCreateConfig", () => {
    it("returns true when user picks Create", async () => {
      const pty = createMockBuildLogPty();
      const ui = new VscodeWorkflowUI(pty);
      vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(
        "Create" as any,
      );

      const result = await ui.promptCreateConfig();

      expect(result).toBe(true);
    });

    it("returns false when user picks Cancel", async () => {
      const pty = createMockBuildLogPty();
      const ui = new VscodeWorkflowUI(pty);
      vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(
        "Cancel" as any,
      );

      const result = await ui.promptCreateConfig();

      expect(result).toBe(false);
    });
  });

  describe("showBuildLog", () => {
    it("parses each line and writes formatted events to buildLogPty", () => {
      const pty = createMockBuildLogPty();
      const ui = new VscodeWorkflowUI(pty);

      const mockEvent = {
        type: "text" as const,
        level: 0,
        timestamp: 0,
        text: "hi",
      };
      vi.mocked(parseCliOutputLine).mockReturnValue(mockEvent);
      vi.mocked(formatEventForTerminal).mockReturnValue("hi\r\n");

      ui.showBuildLog("line1\nline2\nline3");

      expect(parseCliOutputLine).toHaveBeenCalledTimes(3);
      expect(formatEventForTerminal).toHaveBeenCalledTimes(3);
      expect(pty.write).toHaveBeenCalledTimes(3);
      expect(pty.write).toHaveBeenCalledWith("hi\r\n");
    });

    it("skips lines that parse to null", () => {
      const pty = createMockBuildLogPty();
      const ui = new VscodeWorkflowUI(pty);

      vi.mocked(parseCliOutputLine).mockReturnValue(null);

      ui.showBuildLog("line1\nline2");

      expect(pty.write).not.toHaveBeenCalled();
    });

    it("handles single-line content", () => {
      const pty = createMockBuildLogPty();
      const ui = new VscodeWorkflowUI(pty);

      const mockEvent = {
        type: "start" as const,
        level: 0,
        timestamp: 0,
        text: "building",
      };
      vi.mocked(parseCliOutputLine).mockReturnValue(mockEvent);
      vi.mocked(formatEventForTerminal).mockReturnValue("▶ building\r\n");

      ui.showBuildLog("building");

      expect(pty.write).toHaveBeenCalledWith("▶ building\r\n");
    });
  });

  describe("showProgress", () => {
    it("delegates to vscode.window.withProgress", async () => {
      const pty = createMockBuildLogPty();
      const ui = new VscodeWorkflowUI(pty);

      vi.mocked(vscode.window.withProgress).mockImplementation(
        async (_opts: any, fn: any) => {
          const progress = { report: vi.fn() };
          await fn(progress);
        },
      );

      let reportedValue: unknown;
      await ui.showProgress("Building...", async (report) => {
        report.report({ increment: 50 });
        reportedValue = "called";
      });

      expect(vscode.window.withProgress).toHaveBeenCalled();
      expect(reportedValue).toBe("called");
    });
  });

  describe("openWindow", () => {
    it("opens a folder in the current window by default", async () => {
      const pty = createMockBuildLogPty();
      const ui = new VscodeWorkflowUI(pty);

      await ui.openWindow("vscode-remote://artizo-container+hex/workspace");

      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        "vscode.openFolder",
        expect.anything(),
        undefined,
      );
    });

    it("opens in a new window when forceNewWindow is true", async () => {
      const pty = createMockBuildLogPty();
      const ui = new VscodeWorkflowUI(pty);

      await ui.openWindow("vscode-remote://artizo-container+hex/workspace", {
        forceNewWindow: true,
      });

      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        "vscode.openFolder",
        expect.anything(),
        { forceNewWindow: true },
      );
    });
  });
});
