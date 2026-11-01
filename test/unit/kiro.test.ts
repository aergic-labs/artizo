/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.stubGlobal("fetch", () => Promise.reject(new Error("no network")));

const { mockReadFileSync, mockExistsSync } = vi.hoisted(() => ({
  mockReadFileSync: vi.fn(),
  mockExistsSync: vi.fn().mockReturnValue(false),
}));

vi.mock("node:fs", () => ({
  readFileSync: mockReadFileSync,
  existsSync: mockExistsSync,
}));

vi.mock("vscode", () => ({
  env: { appRoot: "/mock/app/root", uriScheme: "kiro" },
}));

import { VSCodiumAdapter } from "../../src/platform/vscodium";

function mockProduct(applicationName: string): void {
  mockReadFileSync.mockImplementation((p: string) => {
    if (typeof p === "string" && p.endsWith("product.json")) {
      return JSON.stringify({ applicationName });
    }
    // Allow token file reads to pass through (overridden per-test).
    throw new Error(`unexpected readFileSync(${p})`);
  });
}

describe("Kiro fork (via VSCodiumAdapter)", () => {
  beforeEach(() => {
    mockReadFileSync.mockReset();
    mockExistsSync.mockReturnValue(false);
    mockProduct("kiro");
  });

  it("has correct static properties", () => {
    const adapter = new VSCodiumAdapter();
    expect(adapter.name).toBe("Kiro");
    expect(adapter.dataFolderName).toBe(".kiro");
    expect(adapter.serverDataFolderName).toBe(".kiro-server");
    expect(adapter.serverApplicationName).toBe("kiro-server");
  });

  it("needsArgvPatch returns true", () => {
    expect(new VSCodiumAdapter().needsArgvPatch()).toBe(true);
  });

  it("getAdditionalDockerRunArgs returns empty array", () => {
    expect(new VSCodiumAdapter().getAdditionalDockerRunArgs()).toEqual([]);
  });

  it("getServerInstallRoot returns /tmp", () => {
    expect(new VSCodiumAdapter().getServerInstallRoot()).toBe("/tmp");
  });

  it("needsHomeSymlink returns false", () => {
    expect(new VSCodiumAdapter().needsHomeSymlink()).toBe(false);
  });

  it("getArgvPath returns path under .kiro in home directory", () => {
    const p = new VSCodiumAdapter().getArgvPath();
    expect(p).toContain(".kiro");
    expect(p).toContain("argv.json");
  });

  it("getApexExtensionsDir returns path under .kiro/extensions", () => {
    const p = new VSCodiumAdapter().getApexExtensionsDir();
    expect(p).toContain(".kiro");
    expect(p).toContain("extensions");
  });

  it("getRemoteExtensionsDirCandidates returns .kiro-server/extensions", () => {
    expect(new VSCodiumAdapter().getRemoteExtensionsDirCandidates()).toEqual([
      ".kiro-server/extensions",
    ]);
  });

  it("getChecksumConfig returns empty (Kiro has no checksum source)", () => {
    expect(new VSCodiumAdapter().getChecksumConfig()).toEqual({});
  });

  describe("readAuthFiles", () => {
    it("implements readAuthFiles", () => {
      expect(typeof new VSCodiumAdapter().readAuthFiles).toBe("function");
    });

    it("returns empty array when token file is missing", () => {
      mockExistsSync.mockReturnValue(false);
      expect(new VSCodiumAdapter().readAuthFiles()).toEqual([]);
    });

    it("returns token file when present", () => {
      const tokenJson = JSON.stringify({
        accessToken: "tok",
        clientIdHash: "abc123def456",
      });
      mockExistsSync.mockImplementation((p: string) =>
        typeof p === "string" && p.endsWith("kiro-auth-token.json"),
      );
      mockReadFileSync.mockImplementation((p: string) => {
        if (typeof p === "string" && p.endsWith("kiro-auth-token.json")) {
          return tokenJson;
        }
        if (typeof p === "string" && p.endsWith("product.json")) {
          return JSON.stringify({ applicationName: "kiro" });
        }
        throw new Error(`unexpected readFileSync(${p})`);
      });
      const files = new VSCodiumAdapter().readAuthFiles();
      expect(files).toHaveLength(1);
      expect(files[0].path).toBe(".aws/sso/cache/kiro-auth-token.json");
    });

    it("includes registration sibling when clientIdHash file exists", () => {
      const tokenJson = JSON.stringify({ clientIdHash: "deadbeef" });
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockImplementation((p: string) => {
        if (typeof p === "string" && p.endsWith("kiro-auth-token.json")) {
          return tokenJson;
        }
        if (typeof p === "string" && p.endsWith("deadbeef.json")) {
          return JSON.stringify({ clientId: "id", clientSecret: "secret" });
        }
        if (typeof p === "string" && p.endsWith("product.json")) {
          return JSON.stringify({ applicationName: "kiro" });
        }
        throw new Error(`unexpected readFileSync(${p})`);
      });
      const files = new VSCodiumAdapter().readAuthFiles();
      expect(files).toHaveLength(2);
      expect(files[1].path).toBe(".aws/sso/cache/deadbeef.json");
    });
  });

  describe("getServerDownloadUrl", () => {
    it("constructs URL pointing at Kiro CDN with commit and arch", async () => {
      const { url } = await new VSCodiumAdapter().getServerDownloadUrl(
        "abc123",
        "stable",
        "linux",
        "x64",
      );
      expect(url).toContain("prod.download.desktop.kiro.dev");
      expect(url).toContain("/releases/remotes/abc123/");
      expect(url).toContain("kiro-reh-linux-x64.tar.gz");
    });
  });

  describe("isValidRuntime", () => {
    it("returns true (Kiro is a valid runtime for the unified adapter)", () => {
      expect(new VSCodiumAdapter().isValidRuntime()).toBe(true);
    });
  });
});
