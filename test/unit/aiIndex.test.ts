/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.stubGlobal("fetch", () => Promise.reject(new Error("no network")));

const { mockReadFileSync } = vi.hoisted(() => ({
  mockReadFileSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  readFileSync: mockReadFileSync,
  existsSync: vi.fn().mockReturnValue(false),
}));

vi.mock("vscode", () => ({
  env: { appRoot: "/mock/app", uriScheme: "kiro" },
  commands: { executeCommand: vi.fn() },
}));

import { getAiAssist, _resetForTest } from "../../src/ai/index";

function mockProduct(applicationName: string): void {
  mockReadFileSync.mockImplementation((p: string) => {
    if (typeof p === "string" && p.endsWith("product.json")) {
      return JSON.stringify({ applicationName });
    }
    throw new Error(`unexpected readFileSync(${p})`);
  });
}

describe("getAiAssist", () => {
  beforeEach(() => {
    _resetForTest();
    mockReadFileSync.mockReset();
  });

  it("returns an AI assist instance", async () => {
    mockProduct("kiro");
    const ai = await getAiAssist();
    expect(ai).toBeDefined();
    expect(typeof ai.isAvailable).toBe("function");
    expect(typeof ai.submit).toBe("function");
  });

  it("caches the instance across calls", async () => {
    mockProduct("kiro");
    const first = await getAiAssist();
    const second = await getAiAssist();
    expect(first).toBe(second);
  });

  it("returns a usable assist for unrecognized IDE (VSCodium fallback)", async () => {
    mockProduct("unknown-ide");
    const ai = await getAiAssist();
    expect(ai).toBeDefined();
    expect(typeof ai.isAvailable).toBe("function");
  });
});
