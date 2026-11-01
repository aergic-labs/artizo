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
  env: { appRoot: "/mock/app/root", uriScheme: "vscode" },
}));

import { VSCodiumAdapter } from "../../src/platform/vscodium";

function mockProduct(applicationName: string): void {
  mockReadFileSync.mockImplementation((p: string) => {
    if (typeof p === "string" && p.endsWith("product.json")) {
      return JSON.stringify({ applicationName });
    }
    throw new Error(`unexpected readFileSync(${p})`);
  });
}

describe("Devin fork (via VSCodiumAdapter)", () => {
  beforeEach(() => {
    mockReadFileSync.mockReset();
    mockProduct("devin");
  });

  it("has correct name", () => {
    expect(new VSCodiumAdapter().name).toBe("Devin");
  });

  it("has correct data folder name", () => {
    expect(new VSCodiumAdapter().dataFolderName).toBe(".devin-server");
  });

  it("has correct server application name", () => {
    expect(new VSCodiumAdapter().serverApplicationName).toBe("devin-server");
  });

  describe("getServerDownloadUrl", () => {
    it("constructs URL with commit and quality", async () => {
      const { url } = await new VSCodiumAdapter().getServerDownloadUrl(
        "abc123",
        "stable",
        "linux",
        "x64",
      );
      expect(url).toContain("windsurf-stable.codeiumdata.com");
      expect(url).toContain("/stable/abc123/");
      expect(url).toContain("devin-reh-linux-x64");
    });

    it("uses buildId as version when provided", async () => {
      const { url } = await new VSCodiumAdapter().getServerDownloadUrl(
        "def456",
        "insider",
        "linux",
        "arm64",
        "2.3.9",
      );
      expect(url).toContain("devin-reh-linux-arm64-2.3.9.tar.gz");
    });

    it("defaults version to 0.0.0 when buildId is absent", async () => {
      const { url } = await new VSCodiumAdapter().getServerDownloadUrl(
        "ghi789",
        "stable",
        "linux",
        "x64",
      );
      expect(url).toContain("devin-reh-linux-x64-0.0.0.tar.gz");
    });

    it("uses windsurfVersion from product.json when no buildId", async () => {
      mockReadFileSync.mockImplementation((p: string) => {
        if (typeof p === "string" && p.endsWith("product.json")) {
          return JSON.stringify({
            applicationName: "devin",
            windsurfVersion: "1.5.0",
          });
        }
        throw new Error(`unexpected readFileSync(${p})`);
      });
      const { url } = await new VSCodiumAdapter().getServerDownloadUrl(
        "c0",
        "stable",
        "linux",
        "x64",
      );
      expect(url).toContain("devin-reh-linux-x64-1.5.0.tar.gz");
    });
  });

  describe("getAdditionalDockerRunArgs", () => {
    it("returns empty array", () => {
      expect(new VSCodiumAdapter().getAdditionalDockerRunArgs()).toEqual([]);
    });
  });

  describe("getServerInstallRoot", () => {
    it("returns /tmp", () => {
      expect(new VSCodiumAdapter().getServerInstallRoot()).toBe("/tmp");
    });
  });

  describe("needsArgvPatch", () => {
    it("returns true", () => {
      expect(new VSCodiumAdapter().needsArgvPatch()).toBe(true);
    });
  });

  describe("needsHomeSymlink", () => {
    it("returns true (Devin is the only fork needing a home symlink)", () => {
      expect(new VSCodiumAdapter().needsHomeSymlink()).toBe(true);
    });
  });

  describe("getArgvPath", () => {
    it("uses hostDataFolderName (.devin), not dataFolderName (.devin-server)", () => {
      const argvPath = new VSCodiumAdapter().getArgvPath();
      expect(argvPath).toContain(".devin");
      expect(argvPath).not.toContain(".devin-server");
      expect(argvPath).toContain("argv.json");
    });
  });

  describe("getApexExtensionsDir", () => {
    it("uses hostDataFolderName (.devin)", () => {
      const p = new VSCodiumAdapter().getApexExtensionsDir();
      expect(p).toContain(".devin");
      expect(p).not.toContain(".devin-server");
      expect(p).toContain("extensions");
    });
  });

  describe("getChecksumConfig", () => {
    it("returns manifest sha256 with windsurf manifest URL", () => {
      expect(new VSCodiumAdapter().getChecksumConfig()).toEqual({
        checksumMethod: "manifest",
        manifestTemplate:
          "https://windsurf-stable.codeiumdata.com/${os}-reh-${arch}/${quality}/manifest-${commit}.json",
        manifestField: "sha256hash",
        checksumAlgo: "sha256",
      });
    });
  });

  describe("readAuthFiles", () => {
    it("returns empty (Devin has no auth files)", () => {
      expect(new VSCodiumAdapter().readAuthFiles()).toEqual([]);
    });
  });

  describe("isValidRuntime", () => {
    it("returns true (Devin is a valid runtime for the unified adapter)", () => {
      expect(new VSCodiumAdapter().isValidRuntime()).toBe(true);
    });
  });
});
