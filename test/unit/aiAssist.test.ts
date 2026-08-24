/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("vscode", () => ({
  commands: {
    executeCommand: vi.fn(),
  },
}));

import * as vscode from "vscode";
import { KiroAiAssist } from "../../src/ai/kiro";
import { TraeAiAssist } from "../../src/ai/trae";
import { DevinAiAssist } from "../../src/ai/devin";
import { getAiAssist } from "../../src/ai";

const executeCommand = vscode.commands.executeCommand as ReturnType<
  typeof vi.fn
>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

describe("KiroAiAssist", () => {
  it("is available", async () => {
    const ai = new KiroAiAssist();
    expect(await ai.isAvailable()).toBe(true);
  });

  it("submits via create -> sendPrompt -> viewSession with files inlined", async () => {
    executeCommand.mockReset();
    executeCommand.mockResolvedValueOnce({ sessionId: "s1" });
    const ai = new KiroAiAssist();
    await ai.submit("create a devcontainer", {
      files: ["Makefile"],
      title: "Set up Dev Container",
    });
    expect(executeCommand).toHaveBeenNthCalledWith(
      1,
      "kiroAgent.sessions.create",
    );
    expect(executeCommand).toHaveBeenNthCalledWith(
      2,
      "kiroAgent.sessions.sendPrompt",
      "s1",
      "create a devcontainer\n\nFiles: Makefile",
    );
    expect(executeCommand).toHaveBeenNthCalledWith(
      3,
      "kiroAgent.viewSession",
      "s1",
      "Set up Dev Container",
    );
  });

  it("submits prompt without files suffix when none provided", async () => {
    executeCommand.mockReset();
    executeCommand.mockResolvedValueOnce({ sessionId: "s2" });
    const ai = new KiroAiAssist();
    await ai.submit("hello");
    expect(executeCommand).toHaveBeenNthCalledWith(
      2,
      "kiroAgent.sessions.sendPrompt",
      "s2",
      "hello",
    );
    expect(executeCommand).toHaveBeenNthCalledWith(
      3,
      "kiroAgent.viewSession",
      "s2",
      undefined,
    );
  });

  it("throws when session creation returns no sessionId", async () => {
    executeCommand.mockReset();
    executeCommand.mockResolvedValueOnce({});
    const ai = new KiroAiAssist();
    await expect(ai.submit("hello")).rejects.toThrow(/no session id/);
  });
});

describe("TraeAiAssist", () => {
  it("is available", async () => {
    const ai = new TraeAiAssist();
    expect(await ai.isAvailable()).toBe(true);
  });

  it("opens chat then submits prompt after delay", async () => {
    const ai = new TraeAiAssist();
    const promise = ai.submit("fix this", { title: "Repair" });

    // First call: open chat without query
    await vi.advanceTimersByTimeAsync(0);
    expect(executeCommand).toHaveBeenCalledTimes(1);
    expect(executeCommand).toHaveBeenNthCalledWith(
      1,
      "workbench.action.chat.icube.open",
      { keepOpen: true },
    );

    // After 300ms: submit with query
    await vi.advanceTimersByTimeAsync(300);
    await promise;
    expect(executeCommand).toHaveBeenCalledTimes(2);
    expect(executeCommand).toHaveBeenNthCalledWith(
      2,
      "workbench.action.chat.icube.open",
      { query: "fix this", keepOpen: true },
    );
  });
});

describe("DevinAiAssist", () => {
  it("is available", async () => {
    const ai = new DevinAiAssist();
    expect(await ai.isAvailable()).toBe(true);
  });

  it("submits prompt via devin.executeCascadeAction", async () => {
    const ai = new DevinAiAssist();
    await ai.submit("create a devcontainer");
    expect(executeCommand).toHaveBeenCalledWith("devin.executeCascadeAction", [
      JSON.stringify({ text: "create a devcontainer" }),
    ]);
  });

  it("ignores files option", async () => {
    const ai = new DevinAiAssist();
    await ai.submit("prompt", { files: ["Makefile"] });
    expect(executeCommand).toHaveBeenCalledWith("devin.executeCascadeAction", [
      JSON.stringify({ text: "prompt" }),
    ]);
  });
});

describe("getAiAssist", () => {
  it("returns not-available fallback when no adapter is active", async () => {
    const ai = await getAiAssist();
    expect(await ai.isAvailable()).toBe(false);
    await expect(ai.submit("hello")).rejects.toThrow(
      "AI assist is not available",
    );
  });
});
