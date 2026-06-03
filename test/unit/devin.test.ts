/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect } from "vitest";
import { DevinAdapter } from "../../src/platform/devin";

const TEST_CONFIG = {
  name: "Devin",
  dataFolderName: ".devin-server",
  serverApplicationName: "devin-server",
  needsArgvPatch: true,
  additionalDockerRunArgs: [],
  serverInstallRoot: "/tmp",
  needsHomeSymlink: true,
};

describe("DevinAdapter", () => {
  const adapter = new DevinAdapter(TEST_CONFIG);

  it("has correct name", () => {
    expect(adapter.name).toBe("Devin");
  });

  it("has correct data folder name", () => {
    expect(adapter.dataFolderName).toBe(".devin-server");
  });

  describe("getServerDownloadUrl", () => {
    it("constructs URL with commit and quality", () => {
      const url = adapter.getServerDownloadUrl(
        "abc123",
        "stable",
        "linux",
        "x64",
      );
      expect(url).toContain("windsurf-stable.codeiumdata.com");
      expect(url).toContain("/stable/abc123/");
      expect(url).toContain("devin-reh-linux-x64");
    });

    it("uses buildId as version when provided", () => {
      const url = adapter.getServerDownloadUrl(
        "def456",
        "insider",
        "linux",
        "arm64",
        "2.3.9",
      );
      expect(url).toContain("devin-reh-linux-arm64-2.3.9.tar.gz");
    });

    it("defaults version to 0.0.0 when buildId is absent", () => {
      const url = adapter.getServerDownloadUrl(
        "ghi789",
        "stable",
        "linux",
        "x64",
      );
      expect(url).toContain("devin-reh-linux-x64-0.0.0.tar.gz");
    });
  });

  describe("getAdditionalDockerRunArgs", () => {
    it("returns empty array", () => {
      expect(adapter.getAdditionalDockerRunArgs()).toEqual([]);
    });
  });

  describe("getServerInstallRoot", () => {
    it("returns /tmp", () => {
      expect(adapter.getServerInstallRoot()).toBe("/tmp");
    });
  });

  describe("needsArgvPatch", () => {
    it("returns true", () => {
      expect(adapter.needsArgvPatch()).toBe(true);
    });
  });

  describe("needsHomeSymlink", () => {
    it("returns true", () => {
      expect(adapter.needsHomeSymlink()).toBe(true);
    });
  });

  describe("getArgvPath", () => {
    it("returns path under data folder in home directory", () => {
      const argvPath = adapter.getArgvPath();
      expect(argvPath).toContain(".devin-server");
      expect(argvPath).toContain("argv.json");
    });
  });
});
