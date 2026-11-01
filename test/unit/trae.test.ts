/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Stub fetch to fail immediately; avoids 5s timeout on CDN detection.
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

import { VSCodiumAdapter, _resetTraeCdnBaseForTest } from "../../src/platform/vscodium";

function mockProduct(applicationName: string): void {
  mockReadFileSync.mockImplementation((p: string) => {
    if (typeof p === "string" && p.endsWith("product.json")) {
      return JSON.stringify({ applicationName });
    }
    throw new Error(`unexpected readFileSync(${p})`);
  });
}

describe("Trae fork (via VSCodiumAdapter)", () => {
  beforeEach(() => {
    mockReadFileSync.mockReset();
    _resetTraeCdnBaseForTest();
    mockProduct("trae");
  });

  it("has correct name", () => {
    expect(new VSCodiumAdapter().name).toBe("Trae");
  });

  it("has correct data folder name", () => {
    expect(new VSCodiumAdapter().dataFolderName).toBe(".trae");
  });

  it("has correct server application name", () => {
    expect(new VSCodiumAdapter().serverApplicationName).toBe("trae-server");
  });

  it("has correct server data folder name", () => {
    expect(new VSCodiumAdapter().serverDataFolderName).toBe(".trae-server");
  });

  describe("getAdditionalDockerRunArgs", () => {
    it("returns seccomp unconfined flag for Trae AI sandbox", () => {
      expect(new VSCodiumAdapter().getAdditionalDockerRunArgs()).toEqual([
        "--security-opt",
        "seccomp=unconfined",
      ]);
    });
  });

  describe("needsArgvPatch", () => {
    it("returns false; Trae does not need argv patching", () => {
      expect(new VSCodiumAdapter().needsArgvPatch()).toBe(false);
    });
  });

  describe("getArgvPath", () => {
    it("returns path under .trae data folder in home directory", () => {
      const argvPath = new VSCodiumAdapter().getArgvPath();
      expect(argvPath).toContain(".trae");
      expect(argvPath).toContain("argv.json");
    });
  });

  describe("getServerDownloadUrl", () => {
    it("constructs URL with commit and arch using default CDN", async () => {
      const { url } = await new VSCodiumAdapter().getServerDownloadUrl(
        "abc123def",
        "stable",
        "linux",
        "x64",
      );
      expect(url).toContain("abc123def");
      expect(url).toContain("x64");
      expect(url).toContain(".tar.gz");
      expect(url).toContain("linux-debian10");
      expect(url).toContain("/releases/stable/");
      expect(url).toMatch(/Trae-linux-x64/);
    });

    it("falls back to commit when version fetch fails (buildId ignored)", async () => {
      // fetch is stubbed to reject, so fetchTraeVersion falls back to commit.
      // buildId is not used by Trae.
      const { url } = await new VSCodiumAdapter().getServerDownloadUrl(
        "abc",
        "stable",
        "linux",
        "x64",
        "12345",
      );
      expect(url).toContain("Trae-linux-x64-abc.tar.gz");
    });

    it("falls back to commit when version fetch fails for arm64", async () => {
      const { url } = await new VSCodiumAdapter().getServerDownloadUrl(
        "abc",
        "stable",
        "linux",
        "arm64",
      );
      expect(url).toContain("Trae-linux-arm64-abc.tar.gz");
    });

    it("produces a valid URL structure with fetched version", async () => {
      const { url } = await new VSCodiumAdapter().getServerDownloadUrl(
        "commit123",
        "stable",
        "linux",
        "x64",
      );
      expect(url).toMatch(
        /^https:\/\/.+\/pkg\/server\/releases\/stable\/commit123\/linux-debian10\/Trae-linux-x64-commit123\.tar\.gz$/,
      );
    });
  });

  describe("getChecksumConfig", () => {
    it("returns sidecar md5", () => {
      expect(new VSCodiumAdapter().getChecksumConfig()).toEqual({
        checksumMethod: "sidecar",
        checksumAlgo: "md5",
      });
    });
  });

  describe("readAuthFiles", () => {
    it("returns empty (Trae has no auth files)", () => {
      expect(new VSCodiumAdapter().readAuthFiles()).toEqual([]);
    });
  });
});
