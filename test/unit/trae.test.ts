/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { TraeAdapter } from "../../src/platform/trae";

const TEST_CONFIG = {
  name: "Trae",
  dataFolderName: ".trae",
  serverApplicationName: "trae-server",
  needsArgvPatch: false,
  additionalDockerRunArgs: ["--security-opt", "seccomp=unconfined"],
};

describe("TraeAdapter", () => {
  beforeEach(() => {
    // Stub fetch to fail immediately; avoids 5s timeout on CDN detection
    vi.stubGlobal("fetch", () => Promise.reject(new Error("no network")));
  });

  const adapter = new TraeAdapter(TEST_CONFIG);

  it("has correct name", () => {
    expect(adapter.name).toBe("Trae");
  });

  it("has correct data folder name", () => {
    expect(adapter.dataFolderName).toBe(".trae");
  });

  it("has correct server application name", () => {
    expect(adapter.serverApplicationName).toBe("trae-server");
  });

  describe("getAdditionalDockerRunArgs", () => {
    it("returns seccomp unconfined flag for Trae AI sandbox", () => {
      const args = adapter.getAdditionalDockerRunArgs();
      expect(args).toEqual(["--security-opt", "seccomp=unconfined"]);
    });
  });

  describe("needsArgvPatch", () => {
    it("returns false; Trae does not need argv patching", () => {
      expect(adapter.needsArgvPatch()).toBe(false);
    });
  });

  describe("getArgvPath", () => {
    it("returns path under .trae data folder in home directory", () => {
      const argvPath = adapter.getArgvPath();
      expect(argvPath).toContain(".trae");
      expect(argvPath).toContain("argv.json");
    });
  });

  describe("getServerDownloadUrl", () => {
    it("constructs URL with commit and arch using default CDN", async () => {
      const url = await adapter.getServerDownloadUrl(
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
      // Trae file path uses 'linux' not 'linux-debian10'
      expect(url).toMatch(/Trae-linux-x64/);
    });

    it("uses buildId in version when provided", async () => {
      const url = await adapter.getServerDownloadUrl(
        "abc",
        "stable",
        "linux",
        "x64",
        "12345",
      );
      expect(url).toContain("12345_1");
    });

    it("falls back to 0_1 when no buildId and no version file", async () => {
      const url = await adapter.getServerDownloadUrl(
        "abc",
        "stable",
        "linux",
        "arm64",
      );
      expect(url).toMatch(/Trae-linux-arm64-\d+_\d+/);
    });

    it("produces a valid URL structure", async () => {
      const url = await adapter.getServerDownloadUrl(
        "commit123",
        "stable",
        "linux",
        "x64",
        "42",
      );
      expect(url).toMatch(
        /^https:\/\/.+\/releases\/stable\/commit123\/linux-debian10\/Trae-linux-x64-42_1\.tar\.gz$/,
      );
    });
  });
});