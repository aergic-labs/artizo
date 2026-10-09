/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Stub fetch for adapters that try to detect CDN
vi.stubGlobal("fetch", () => Promise.reject(new Error("no network")));

// detectPlatformName reads product.json from vscode.env.appRoot via
// readFileSync. Mock fs to return a product.json with the right
// applicationName per test.
const { mockReadFileSync } = vi.hoisted(() => ({
  mockReadFileSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  readFileSync: mockReadFileSync,
  existsSync: vi.fn().mockReturnValue(false),
}));

vi.mock("vscode", () => ({
  env: { appRoot: "/mock/app", uriScheme: "kiro" },
}));

import {
  getPlatformAdapter,
  detectPlatformName,
  _resetForTest,
} from "../../src/platform/index";
import type { IPlatformAdapter } from "../../src/platform/types";

function mockProduct(applicationName: string): void {
  mockReadFileSync.mockImplementation((p: string) => {
    if (typeof p === "string" && p.endsWith("product.json")) {
      return JSON.stringify({ applicationName });
    }
    throw new Error(`unexpected readFileSync(${p})`);
  });
}

describe("detectPlatformName", () => {
  beforeEach(() => {
    mockReadFileSync.mockReset();
  });

  it("detects Devin via applicationName", () => {
    mockProduct("devin");
    expect(detectPlatformName()).toBe("Devin");
  });

  it("detects Devin via windsurf applicationName", () => {
    mockProduct("windsurf");
    expect(detectPlatformName()).toBe("Devin");
  });

  it("detects Trae via applicationName", () => {
    mockProduct("trae");
    expect(detectPlatformName()).toBe("Trae");
  });

  it("detects Trae via byte applicationName", () => {
    mockProduct("byte");
    expect(detectPlatformName()).toBe("Trae");
  });

  it("detects Kiro via applicationName", () => {
    mockProduct("kiro");
    expect(detectPlatformName()).toBe("Kiro");
  });

  it("falls back to VSCodium for vscodium applicationName", () => {
    mockProduct("vscodium");
    expect(detectPlatformName()).toBe("VSCodium");
  });

  it("falls back to VSCodium for codium applicationName", () => {
    mockProduct("codium");
    expect(detectPlatformName()).toBe("VSCodium");
  });

  it("falls back to VSCodium for code-oss applicationName", () => {
    mockProduct("code-oss");
    expect(detectPlatformName()).toBe("VSCodium");
  });

  it("falls back to VSCodium for unrecognized IDE", () => {
    mockProduct("some-unknown-editor");
    expect(detectPlatformName()).toBe("VSCodium");
  });

  it("falls back to VSCodium when product.json is unreadable", () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(detectPlatformName()).toBe("VSCodium");
  });
});

describe("getPlatformAdapter", () => {
  beforeEach(() => {
    _resetForTest();
    mockReadFileSync.mockReset();
  });

  it("returns the Kiro adapter when applicationName is kiro", async () => {
    mockProduct("kiro");
    const adapter = await getPlatformAdapter();
    expect(adapter.name).toBe("Kiro");
    expect(adapter.dataFolderName).toBe(".kiro");
  });

  it("returns the Trae adapter when applicationName is trae", async () => {
    mockProduct("trae");
    const adapter = await getPlatformAdapter();
    expect(adapter.name).toBe("Trae");
    expect(adapter.dataFolderName).toBe(".trae");
  });

  it("returns the Devin adapter when applicationName is devin", async () => {
    mockProduct("devin");
    const adapter = await getPlatformAdapter();
    expect(adapter.name).toBe("Devin");
    expect(adapter.dataFolderName).toBe(".devin-server");
  });

  it("returns the VSCodium adapter when applicationName is vscodium", async () => {
    mockProduct("vscodium");
    const adapter = await getPlatformAdapter();
    expect(adapter.name).toBe("VSCodium");
    expect(adapter.dataFolderName).toBe(".vscode-oss");
  });

  it("returns the VSCodium adapter for unrecognized IDE", async () => {
    mockProduct("unknown-ide");
    const adapter = await getPlatformAdapter();
    expect(adapter.name).toBe("VSCodium");
  });

  it("caches the adapter across calls", async () => {
    mockProduct("kiro");
    const first = await getPlatformAdapter();
    const second = await getPlatformAdapter();
    expect(first).toBe(second);
  });

  it("adapter has valid basic properties", async () => {
    mockProduct("kiro");
    const adapter: IPlatformAdapter = await getPlatformAdapter();
    expect(typeof adapter.dataFolderName).toBe("string");
    expect(typeof adapter.serverApplicationName).toBe("string");
    expect(adapter.getArgvPath()).toContain("argv.json");
    expect(Array.isArray(adapter.getAdditionalDockerRunArgs())).toBe(true);
    expect(typeof adapter.needsArgvPatch()).toBe("boolean");
    expect(typeof adapter.isValidRuntime()).toBe("boolean");
    expect(adapter.getApexExtensionsDir().endsWith("extensions")).toBe(true);
  });
});
