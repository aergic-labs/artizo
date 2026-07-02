/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect } from "vitest";
import { VSCodiumAdapter } from "../../src/platform/vscodium";
import type { PlatformConfig } from "../../src/platform/types";

const BASE_CONFIG: PlatformConfig = {
  name: "VSCodium",
  dataFolderName: ".vscode-oss",
  serverApplicationName: "vscodium-server",
  needsArgvPatch: true,
  additionalDockerRunArgs: ["--init"],
};

describe("VSCodiumAdapter", () => {
  describe("constructor", () => {
    it("exposes name, dataFolderName, serverApplicationName from config", () => {
      const adapter = new VSCodiumAdapter(BASE_CONFIG);
      expect(adapter.name).toBe("VSCodium");
      expect(adapter.dataFolderName).toBe(".vscode-oss");
      expect(adapter.serverApplicationName).toBe("vscodium-server");
    });
  });

  describe("getArgvPath", () => {
    it("joins homedir + dataFolderName + argv.json", () => {
      const adapter = new VSCodiumAdapter(BASE_CONFIG);
      const p = adapter.getArgvPath();
      expect(p).toContain(".vscode-oss");
      expect(p).toContain("argv.json");
    });

    it("uses hostDataFolderName when provided", () => {
      const adapter = new VSCodiumAdapter({
        ...BASE_CONFIG,
        hostDataFolderName: ".vscodium",
      });
      const p = adapter.getArgvPath();
      expect(p).toContain(".vscodium");
      expect(p).not.toContain(".vscode-oss");
      expect(p).toContain("argv.json");
    });
  });

  describe("getArgvDataFolderNames", () => {
    it("prepends dataFolderName and adds default fallbacks", () => {
      const adapter = new VSCodiumAdapter(BASE_CONFIG);
      const names = adapter.getArgvDataFolderNames();
      expect(names[0]).toBe(".vscode-oss");
      expect(names).toContain(".vscodium");
      expect(names).toContain(".code-oss");
      expect(names).toContain(".vscode");
      // No duplicates of the first entry
      expect(names.filter((n) => n === ".vscode-oss")).toHaveLength(1);
    });

    it("uses hostDataFolderName as the first candidate when provided", () => {
      const adapter = new VSCodiumAdapter({
        ...BASE_CONFIG,
        hostDataFolderName: ".vscodium",
      });
      const names = adapter.getArgvDataFolderNames();
      expect(names[0]).toBe(".vscodium");
    });

    it("uses config.argvDataFolderNames when provided instead of defaults", () => {
      const adapter = new VSCodiumAdapter({
        ...BASE_CONFIG,
        argvDataFolderNames: [".custom-one", ".custom-two"],
      });
      const names = adapter.getArgvDataFolderNames();
      expect(names[0]).toBe(".vscode-oss");
      expect(names).toContain(".custom-one");
      expect(names).toContain(".custom-two");
      expect(names).not.toContain(".vscodium");
    });
  });

  describe("needsArgvPatch", () => {
    it("returns config value (true)", () => {
      const adapter = new VSCodiumAdapter(BASE_CONFIG);
      expect(adapter.needsArgvPatch()).toBe(true);
    });

    it("returns config value (false)", () => {
      const adapter = new VSCodiumAdapter({
        ...BASE_CONFIG,
        needsArgvPatch: false,
      });
      expect(adapter.needsArgvPatch()).toBe(false);
    });
  });

  describe("getAdditionalDockerRunArgs", () => {
    it("returns config args", () => {
      const adapter = new VSCodiumAdapter(BASE_CONFIG);
      expect(adapter.getAdditionalDockerRunArgs()).toEqual(["--init"]);
    });
  });

  describe("getRemoteExtensionsDirCandidates", () => {
    it("returns vscodium-server and vscode-oss-server candidates", () => {
      const adapter = new VSCodiumAdapter(BASE_CONFIG);
      expect(adapter.getRemoteExtensionsDirCandidates()).toEqual([
        ".vscodium-server/extensions",
        ".vscode-oss-server/extensions",
      ]);
    });
  });

  describe("getApexExtensionsDir", () => {
    it("joins homedir + dataFolderName + extensions", () => {
      const adapter = new VSCodiumAdapter(BASE_CONFIG);
      const p = adapter.getApexExtensionsDir();
      expect(p).toContain(".vscode-oss");
      expect(p).toContain("extensions");
    });

    it("uses hostDataFolderName when provided", () => {
      const adapter = new VSCodiumAdapter({
        ...BASE_CONFIG,
        hostDataFolderName: ".vscodium",
      });
      const p = adapter.getApexExtensionsDir();
      expect(p).toContain(".vscodium");
      expect(p).not.toContain(".vscode-oss");
      expect(p).toContain("extensions");
    });
  });

  describe("getServerInstallRoot", () => {
    it("defaults to /tmp when not set", () => {
      const adapter = new VSCodiumAdapter(BASE_CONFIG);
      expect(adapter.getServerInstallRoot()).toBe("/tmp");
    });

    it("returns configured value when set", () => {
      const adapter = new VSCodiumAdapter({
        ...BASE_CONFIG,
        serverInstallRoot: "/opt/vscodium",
      });
      expect(adapter.getServerInstallRoot()).toBe("/opt/vscodium");
    });
  });

  describe("needsHomeSymlink", () => {
    it("defaults to false", () => {
      const adapter = new VSCodiumAdapter(BASE_CONFIG);
      expect(adapter.needsHomeSymlink()).toBe(false);
    });

    it("returns configured value when set", () => {
      const adapter = new VSCodiumAdapter({
        ...BASE_CONFIG,
        needsHomeSymlink: true,
      });
      expect(adapter.needsHomeSymlink()).toBe(true);
    });
  });

  describe("getServerDownloadUrl", () => {
    it("falls back to version 0.0.0 when product.json is unreadable", () => {
      // The mock appRoot /mock/app/root has no product.json, so
      // readVSCodiumVersion() catches and returns undefined -> "0.0.0".
      const adapter = new VSCodiumAdapter(BASE_CONFIG);
      const url = adapter.getServerDownloadUrl(
        "deadbeef",
        "stable",
        "linux",
        "x64",
      );
      expect(url).toBe(
        "https://github.com/VSCodium/vscodium/releases/download/0.0.0/vscodium-reh-linux-x64-0.0.0.tar.gz",
      );
    });

    it("incorporates targetArch into the URL", () => {
      const adapter = new VSCodiumAdapter(BASE_CONFIG);
      const url = adapter.getServerDownloadUrl(
        "abc",
        "stable",
        "linux",
        "arm64",
      );
      expect(url).toContain("vscodium-reh-linux-arm64-0.0.0.tar.gz");
    });
  });

  describe("isValidRuntime", () => {
    it("returns true when product.json cannot be read (catch branch)", () => {
      // Mock appRoot has no product.json -> readFileSync throws -> catch
      // returns true (permissive when detection is unavailable).
      const adapter = new VSCodiumAdapter(BASE_CONFIG);
      expect(adapter.isValidRuntime()).toBe(true);
    });
  });
});
