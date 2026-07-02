/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock vscode
vi.mock("vscode", () => ({
  window: {
    showErrorMessage: vi.fn(),
    showInformationMessage: vi.fn(),
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: "/test/workspace" } }],
    fs: { stat: vi.fn() },
  },
  env: { remoteName: undefined, appRoot: "/mock/app/root" },
  Uri: {
    parse: (s: string) => ({ toString: () => s }),
    joinPath: (...parts: string[]) => ({ toString: () => parts.join("/") }),
  },
  extensions: { all: [] },
}));

vi.mock("../../src/ai", async () => ({
  getAiAssist: vi.fn(),
}));

import { AiAssistController } from "../../src/sidebar/aiAssistController";
import { getAiAssist } from "../../src/ai";

function createController() {
  const post = vi.fn();
  const reloadConfig = vi.fn().mockResolvedValue(undefined);
  const configManager = {
    getConfigPath: vi
      .fn()
      .mockResolvedValue({ fsPath: "/test/.devcontainer/devcontainer.json" }),
  };
  const controller = new AiAssistController({
    post,
    extensionUri: { toString: () => "/mock/ext" } as any,
    configManager,
    reloadConfig,
  });
  return { controller, post, reloadConfig, configManager };
}

describe("AiAssistController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("dispatchAi", () => {
    it("calls submit with correct args", async () => {
      const { controller } = createController();
      const submit = vi.fn().mockResolvedValue(undefined);
      (getAiAssist as any).mockResolvedValue({
        isAvailable: () => Promise.resolve(true),
        submit,
      });

      await (controller as any).dispatchAi("test prompt", [], "Test", "wizard");

      expect(submit).toHaveBeenCalledWith("test prompt", {
        files: [],
        title: "Test",
      });
    });

    it("does not throw when submit fails", async () => {
      const { controller } = createController();
      (getAiAssist as any).mockResolvedValue({
        isAvailable: () => Promise.resolve(true),
        submit: vi.fn().mockRejectedValue(new Error("AI down")),
      });

      await expect(
        (controller as any).dispatchAi("prompt", [], "T", "config"),
      ).resolves.toBeUndefined();
    });
  });

  describe("watchAiProgress", () => {
    it("stops and reports when questions are pending", async () => {
      vi.useFakeTimers();
      try {
        const { controller, post } = createController();
        const ai = { pollPendingQuestions: vi.fn().mockResolvedValue(2) };

        const promise = (controller as any).watchAiProgress("config", ai);
        await vi.advanceTimersByTimeAsync(1000);
        await promise;

        expect(post).toHaveBeenCalledWith(
          expect.objectContaining({ type: "aiStatus", status: "questions" }),
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
