/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("vscode", () => ({
  commands: {
    executeCommand: vi.fn(),
  },
  extensions: {
    getExtension: vi.fn(),
  },
}));

import * as vscode from "vscode";
import { BobAiAssist } from "../../src/ai/bob";

const executeCommand = vscode.commands.executeCommand as ReturnType<
  typeof vi.fn
>;
const getExtension = vscode.extensions.getExtension as ReturnType<
  typeof vi.fn
>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("BobAiAssist", () => {
  it("is available when IBM.bob-code extension is active", async () => {
    getExtension.mockReturnValue({ isActive: true });
    const ai = new BobAiAssist();
    expect(await ai.isAvailable()).toBe(true);
  });

  it("is not available when IBM.bob-code extension is inactive", async () => {
    getExtension.mockReturnValue({ isActive: false });
    const ai = new BobAiAssist();
    expect(await ai.isAvailable()).toBe(false);
  });

  it("is not available when IBM.bob-code extension is not installed", async () => {
    getExtension.mockReturnValue(undefined);
    const ai = new BobAiAssist();
    expect(await ai.isAvailable()).toBe(false);
  });

  it("submits prompt via bob-code.sendMessageWithHiddenPrompt with empty mask", async () => {
    executeCommand.mockResolvedValue(undefined);
    const ai = new BobAiAssist();
    await ai.submit("create a devcontainer");
    expect(executeCommand).toHaveBeenCalledWith(
      "bob-code.sendMessageWithHiddenPrompt",
      "",
      "create a devcontainer",
    );
  });

  it("inlines files into the prompt text", async () => {
    executeCommand.mockResolvedValue(undefined);
    const ai = new BobAiAssist();
    await ai.submit("fix this", { files: ["Makefile", "README.md"] });
    expect(executeCommand).toHaveBeenCalledWith(
      "bob-code.sendMessageWithHiddenPrompt",
      "",
      "fix this\n\nFiles: Makefile, README.md",
    );
  });

  it("submits prompt without files suffix when none provided", async () => {
    executeCommand.mockResolvedValue(undefined);
    const ai = new BobAiAssist();
    await ai.submit("hello");
    expect(executeCommand).toHaveBeenCalledWith(
      "bob-code.sendMessageWithHiddenPrompt",
      "",
      "hello",
    );
  });

  it("ignores title option (Bob has no title mapping)", async () => {
    executeCommand.mockResolvedValue(undefined);
    const ai = new BobAiAssist();
    await ai.submit("do thing", { title: "My Task" });
    expect(executeCommand).toHaveBeenCalledWith(
      "bob-code.sendMessageWithHiddenPrompt",
      "",
      "do thing",
    );
  });

  it("throws on command failure (no silent fallback)", async () => {
    executeCommand.mockRejectedValue(new Error("command not found"));
    const ai = new BobAiAssist();
    await expect(ai.submit("hello")).rejects.toThrow("command not found");
  });
});
