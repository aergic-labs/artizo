/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("vscode", () => ({
  window: {
    showErrorMessage: vi.fn(),
  },
  Uri: {
    joinPath: (...parts: string[]) => ({ fsPath: parts.join("/") }),
  },
}));

vi.mock("../../src/ai", () => ({
  getAiAssist: vi.fn(),
}));

vi.mock("../../src/utils/logger", () => ({
  getLogger: () => ({
    warn: vi.fn(),
  }),
}));

vi.mock("../../src/utils/constants", () => ({
  BRAND_PREFIX: "[Artizo]",
}));

vi.mock("../../src/config/dockerfilePath", () => ({
  resolveDockerfilePath: vi.fn(() => undefined),
}));

import * as vscode from "vscode";
import { getAiAssist } from "../../src/ai";
import { reportProvisionFailure } from "../../src/host/reportProvisionFailure";

function ctx() {
  return {
    buildLogPty: {
      getRecentText: () => "mock log tail",
      getLogPath: () => "/tmp/artizo.log",
    } as any,
    buildLogTerminal: { show: vi.fn() },
    configManager: {} as any,
    extensionUri: { fsPath: "/ext" } as any,
  };
}

describe("reportProvisionFailure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows Show Log when AI is unavailable", async () => {
    (getAiAssist as any).mockResolvedValue({
      isAvailable: () => Promise.resolve(false),
    });
    (vscode.window.showErrorMessage as any).mockResolvedValue("Show Log");

    const c = ctx();
    await reportProvisionFailure(
      {
        message: "build failed",
        buildOutput: "",
        configPath: undefined,
      } as any,
      c,
    );

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "[Artizo] Container build failed: build failed",
      "Show Log",
    );
    expect(c.buildLogTerminal.show).toHaveBeenCalled();
  });

  it("shows Diagnose with AI when AI is available", async () => {
    (getAiAssist as any).mockResolvedValue({
      isAvailable: () => Promise.resolve(true),
      submit: vi.fn().mockResolvedValue(undefined),
    });
    (vscode.window.showErrorMessage as any).mockResolvedValue(
      "Diagnose with AI",
    );

    const c = ctx();
    await reportProvisionFailure(
      {
        message: "build failed",
        buildOutput: "",
        configPath: undefined,
      } as any,
      c,
    );

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "[Artizo] Container build failed: build failed",
      "Diagnose with AI",
    );
  });

  it("does nothing when dialog is dismissed", async () => {
    (getAiAssist as any).mockResolvedValue({
      isAvailable: () => Promise.resolve(true),
    });
    (vscode.window.showErrorMessage as any).mockResolvedValue(undefined);

    await reportProvisionFailure(
      { message: "fail", buildOutput: "", configPath: undefined } as any,
      ctx(),
    );

    // Should not throw
  });

  it("handles ai.isAvailable() throwing", async () => {
    (getAiAssist as any).mockResolvedValue({
      isAvailable: () => Promise.reject(new Error("no ai")),
    });
    (vscode.window.showErrorMessage as any).mockResolvedValue("Show Log");

    const c = ctx();
    await reportProvisionFailure(
      { message: "fail", buildOutput: "", configPath: undefined } as any,
      c,
    );

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      "[Artizo] Container build failed: fail",
      "Show Log",
    );
  });
});
