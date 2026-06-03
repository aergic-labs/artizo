/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Stub fetch for adapters that try to detect CDN
vi.stubGlobal("fetch", () => Promise.reject(new Error("no network")));

vi.mock("vscode", () => ({
  env: { appName: "Kiro", appRoot: "/mock/app", uriScheme: "kiro" },
}));

import { getPlatformAdapter } from "../../src/platform/index";
import type { IPlatformAdapter } from "../../src/platform/types";

describe("getPlatformAdapter", () => {
  describe("default (Kiro) path", () => {
    let adapter: IPlatformAdapter;

    beforeEach(async () => {
      adapter = await getPlatformAdapter();
    });

    it("returns a platform adapter", () => {
      expect(adapter).toBeDefined();
      expect(adapter.name).toBeDefined();
    });

    it("returns the same instance on subsequent calls (caching)", async () => {
      const first = await getPlatformAdapter();
      const second = await getPlatformAdapter();
      expect(first).toBe(second);
    });

    it("has a non-empty dataFolderName", () => {
      expect(adapter.dataFolderName).toBeTruthy();
      expect(typeof adapter.dataFolderName).toBe("string");
    });

    it("has a non-empty serverApplicationName", () => {
      expect(adapter.serverApplicationName).toBeTruthy();
      expect(typeof adapter.serverApplicationName).toBe("string");
    });

    it("getArgvPath returns a valid path", () => {
      const path = adapter.getArgvPath();
      expect(path).toContain("argv.json");
    });

    it("getAdditionalDockerRunArgs returns an array", () => {
      const args = adapter.getAdditionalDockerRunArgs();
      expect(Array.isArray(args)).toBe(true);
    });

    it("needsArgvPatch returns a boolean", () => {
      expect(typeof adapter.needsArgvPatch()).toBe("boolean");
    });

    it("getServerDownloadUrl returns a string or promise", () => {
      const url = adapter.getServerDownloadUrl("abc", "stable", "linux", "x64");
      expect(url).toBeDefined();
    });

    it("isValidRuntime returns a boolean", () => {
      expect(typeof adapter.isValidRuntime()).toBe("boolean");
    });
  });
});