/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Stub fetch so Trae CDN detection fails fast (no 5s timeout).
vi.stubGlobal("fetch", () => Promise.reject(new Error("no network")));

const { mockReadFileSync } = vi.hoisted(() => ({
  mockReadFileSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  readFileSync: mockReadFileSync,
  existsSync: vi.fn().mockReturnValue(false),
}));

vi.mock("vscode", () => ({
  env: { appRoot: "/mock/app/root", uriScheme: "vscode" },
}));

import { VSCodiumAdapter } from "../../src/platform/vscodium";
import { _resetTraeCdnBaseForTest } from "../../src/platform/vscodium";

/** Mock product.json with the given applicationName and optional fields. */
function mockProduct(
  applicationName: string,
  extra: Record<string, unknown> = {},
): void {
  mockReadFileSync.mockImplementation((p: string) => {
    if (typeof p === "string" && p.endsWith("product.json")) {
      return JSON.stringify({ applicationName, ...extra });
    }
    throw new Error(`unexpected readFileSync(${p})`);
  });
}

describe("VSCodiumAdapter", () => {
  beforeEach(() => {
    mockReadFileSync.mockReset();
    _resetTraeCdnBaseForTest();
  });

  describe("VSCodium fork", () => {
    it("exposes name, dataFolderName, serverApplicationName", () => {
      mockProduct("vscodium");
      const adapter = new VSCodiumAdapter();
      expect(adapter.name).toBe("VSCodium");
      expect(adapter.dataFolderName).toBe(".vscode-oss");
      expect(adapter.serverApplicationName).toBe("codium-server");
      expect(adapter.serverDataFolderName).toBe(".vscodium-server");
    });

    it("getArgvPath joins homedir + dataFolderName + argv.json", () => {
      mockProduct("vscodium");
      const adapter = new VSCodiumAdapter();
      const p = adapter.getArgvPath();
      expect(p).toContain(".vscode-oss");
      expect(p).toContain("argv.json");
    });

    it("getArgvDataFolderNames prepends dataFolderName and adds fallbacks", () => {
      mockProduct("vscodium");
      const adapter = new VSCodiumAdapter();
      const names = adapter.getArgvDataFolderNames();
      expect(names[0]).toBe(".vscode-oss");
      expect(names).toContain(".vscodium");
      expect(names).toContain(".code-oss");
      expect(names).toContain(".vscode");
      expect(names.filter((n) => n === ".vscode-oss")).toHaveLength(1);
    });

    it("needsArgvPatch returns true", () => {
      mockProduct("vscodium");
      expect(new VSCodiumAdapter().needsArgvPatch()).toBe(true);
    });

    it("getAdditionalDockerRunArgs returns empty array", () => {
      mockProduct("vscodium");
      expect(new VSCodiumAdapter().getAdditionalDockerRunArgs()).toEqual([]);
    });

    it("getRemoteExtensionsDirCandidates returns vscodium-server and vscode-oss-server", () => {
      mockProduct("vscodium");
      expect(new VSCodiumAdapter().getRemoteExtensionsDirCandidates()).toEqual([
        ".vscodium-server/extensions",
        ".vscode-oss-server/extensions",
      ]);
    });

    it("getApexExtensionsDir joins homedir + dataFolderName + extensions", () => {
      mockProduct("vscodium");
      const p = new VSCodiumAdapter().getApexExtensionsDir();
      expect(p).toContain(".vscode-oss");
      expect(p).toContain("extensions");
    });

    it("getServerInstallRoot defaults to /tmp", () => {
      mockProduct("vscodium");
      expect(new VSCodiumAdapter().getServerInstallRoot()).toBe("/tmp");
    });

    it("needsHomeSymlink defaults to false", () => {
      mockProduct("vscodium");
      expect(new VSCodiumAdapter().needsHomeSymlink()).toBe(false);
    });

    it("readAuthFiles returns empty (VSCodium has no auth files)", () => {
      mockProduct("vscodium");
      expect(new VSCodiumAdapter().readAuthFiles()).toEqual([]);
    });

    it("getChecksumConfig returns sidecar sha256", () => {
      mockProduct("vscodium");
      expect(new VSCodiumAdapter().getChecksumConfig()).toEqual({
        checksumMethod: "sidecar",
        checksumAlgo: "sha256",
      });
    });
  });

  describe("getServerDownloadUrl (VSCodium)", () => {
    it("falls back to version 0.0.0 when product.json has no version", async () => {
      mockProduct("vscodium");
      const adapter = new VSCodiumAdapter();
      const { url } = await adapter.getServerDownloadUrl(
        "deadbeef",
        "stable",
        "linux",
        "x64",
      );
      expect(url).toBe(
        "https://github.com/VSCodium/vscodium/releases/download/0.0.0/vscodium-reh-linux-x64-0.0.0.tar.gz",
      );
    });

    it("incorporates targetArch into the URL", async () => {
      mockProduct("vscodium");
      const adapter = new VSCodiumAdapter();
      const { url } = await adapter.getServerDownloadUrl("abc", "stable", "linux", "arm64");
      expect(url).toContain("vscodium-reh-linux-arm64-0.0.0.tar.gz");
    });

    it("uses version from product.json when present", async () => {
      mockProduct("vscodium", { version: "1.100.0" });
      const adapter = new VSCodiumAdapter();
      const { url } = await adapter.getServerDownloadUrl("c0", "stable", "linux", "x64");
      expect(url).toContain("vscodium-reh-linux-x64-1.100.0.tar.gz");
    });
  });

  describe("isValidRuntime", () => {
    it("returns true (VSCodium build allows any runtime)", () => {
      mockProduct("vscodium");
      expect(new VSCodiumAdapter().isValidRuntime()).toBe(true);
    });
  });
});
