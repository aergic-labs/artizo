/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect } from "vitest";
import {
  dockerArchToTargetPlatform,
  unameToTargetPlatform,
  apexTargetPlatform,
  canCopyFromApex,
  hasPlatformVariants,
  isPlatformSpecificTarget,
  selectDownloadUrl,
} from "../../src/extensions/platformDetect";
import type { ExtensionMetadata } from "../../src/extensions/marketplaceClient";
import type { TargetPlatform } from "../../src/extensions/extensionRegistry";

describe("platformDetect", () => {
  describe("dockerArchToTargetPlatform", () => {
    it("maps amd64 linux to linux-x64", () => {
      expect(dockerArchToTargetPlatform("amd64", "linux")).toBe("linux-x64");
    });

    it("maps arm64 linux to linux-arm64", () => {
      expect(dockerArchToTargetPlatform("arm64", "linux")).toBe("linux-arm64");
    });

    it("maps aarch64 linux to linux-arm64", () => {
      expect(dockerArchToTargetPlatform("aarch64", "linux")).toBe(
        "linux-arm64",
      );
    });

    it("maps arm v7 linux to linux-armhf", () => {
      expect(dockerArchToTargetPlatform("arm", "linux", "v7")).toBe(
        "linux-armhf",
      );
    });

    it("maps arm v8 linux to linux-arm64", () => {
      expect(dockerArchToTargetPlatform("arm", "linux", "v8")).toBe(
        "linux-arm64",
      );
    });

    it("maps x86_64 linux to linux-x64", () => {
      expect(dockerArchToTargetPlatform("x86_64", "linux")).toBe("linux-x64");
    });

    it("maps darwin amd64 to darwin-x64", () => {
      expect(dockerArchToTargetPlatform("amd64", "darwin")).toBe("darwin-x64");
    });

    it("maps darwin arm64 to darwin-arm64", () => {
      expect(dockerArchToTargetPlatform("arm64", "darwin")).toBe(
        "darwin-arm64",
      );
    });

    it("maps windows amd64 to win32-x64", () => {
      expect(dockerArchToTargetPlatform("amd64", "windows")).toBe("win32-x64");
    });

    it("is case-insensitive", () => {
      expect(dockerArchToTargetPlatform("AMD64", "Linux")).toBe("linux-x64");
      expect(dockerArchToTargetPlatform("ARM64", "LINUX")).toBe("linux-arm64");
    });

    it("throws on unknown arch", () => {
      expect(() => dockerArchToTargetPlatform("mips", "linux")).toThrow(
        /Unsupported docker arch/,
      );
    });

    it("throws on unknown os", () => {
      expect(() => dockerArchToTargetPlatform("amd64", "solaris")).toThrow(
        /Unsupported docker os/,
      );
    });
  });

  describe("unameToTargetPlatform", () => {
    it("maps Linux x86_64 to linux-x64", () => {
      expect(unameToTargetPlatform("Linux x86_64\n")).toBe("linux-x64");
    });

    it("maps Linux aarch64 to linux-arm64", () => {
      expect(unameToTargetPlatform("Linux aarch64\n")).toBe("linux-arm64");
    });

    it("maps Linux arm64 to linux-arm64", () => {
      expect(unameToTargetPlatform("Linux arm64\n")).toBe("linux-arm64");
    });

    it("maps Linux armv7l to linux-armhf", () => {
      expect(unameToTargetPlatform("Linux armv7l\n")).toBe("linux-armhf");
    });

    it("maps Darwin x86_64 to darwin-x64", () => {
      expect(unameToTargetPlatform("Darwin x86_64\n")).toBe("darwin-x64");
    });

    it("maps Darwin arm64 to darwin-arm64", () => {
      expect(unameToTargetPlatform("Darwin arm64\n")).toBe("darwin-arm64");
    });

    it("is case-insensitive", () => {
      expect(unameToTargetPlatform("linux x86_64\n")).toBe("linux-x64");
      expect(unameToTargetPlatform("LINUX X86_64\n")).toBe("linux-x64");
    });

    it("throws on unparseable output", () => {
      expect(() => unameToTargetPlatform("garbage")).toThrow(/not parseable/);
    });

    it("throws on unknown arch", () => {
      expect(() => unameToTargetPlatform("Linux mips\n")).toThrow(
        /Unsupported uname arch/,
      );
    });

    it("throws on unknown os", () => {
      expect(() => unameToTargetPlatform("Solaris amd64\n")).toThrow(
        /Unsupported uname os/,
      );
    });
  });

  describe("apexTargetPlatform", () => {
    it("returns a TargetPlatform or undefined", () => {
      const result = apexTargetPlatform();
      // Can't assert a specific value since it depends on the test
      // runner's platform, but it should be a string or undefined.
      expect(result === undefined || typeof result === "string").toBe(true);
    });
  });

  describe("hasPlatformVariants", () => {
    function makeMeta(downloads?: Record<string, string>): ExtensionMetadata {
      return {
        namespace: "ns",
        name: "ext",
        version: "1.0.0",
        downloadUrl: "https://example.com/ext.vsix",
        dependencies: [],
        bundledExtensions: [],
        downloads,
      };
    }

    it("returns false when downloads is undefined", () => {
      expect(hasPlatformVariants(makeMeta(undefined))).toBe(false);
    });

    it("returns false when downloads is empty", () => {
      expect(hasPlatformVariants(makeMeta({}))).toBe(false);
    });

    it("returns false when only universal is available", () => {
      expect(
        hasPlatformVariants(
          makeMeta({ universal: "https://example.com/universal.vsix" }),
        ),
      ).toBe(false);
    });

    it("returns true when multiple platforms are available", () => {
      expect(
        hasPlatformVariants(
          makeMeta({
            "linux-x64": "https://example.com/linux-x64.vsix",
            "linux-arm64": "https://example.com/linux-arm64.vsix",
            universal: "https://example.com/universal.vsix",
          }),
        ),
      ).toBe(true);
    });

    it("returns true when only platform-specific (no universal)", () => {
      expect(
        hasPlatformVariants(
          makeMeta({ "linux-x64": "https://example.com/linux-x64.vsix" }),
        ),
      ).toBe(true);
    });
  });

  describe("selectDownloadUrl", () => {
    const meta: ExtensionMetadata = {
      namespace: "ns",
      name: "ext",
      version: "1.0.0",
      downloadUrl: "https://example.com/default.vsix",
      dependencies: [],
      bundledExtensions: [],
      downloads: {
        "linux-x64": "https://example.com/linux-x64.vsix",
        "linux-arm64": "https://example.com/linux-arm64.vsix",
        universal: "https://example.com/universal.vsix",
      },
    };

    it("returns platform-specific URL when available", () => {
      expect(selectDownloadUrl(meta, "linux-x64")).toBe(
        "https://example.com/linux-x64.vsix",
      );
    });

    it("falls back to default when platform not in downloads", () => {
      expect(selectDownloadUrl(meta, "win32-x64")).toBe(
        "https://example.com/default.vsix",
      );
    });

    it("falls back to default when downloads is undefined", () => {
      const noDownloads: ExtensionMetadata = {
        ...meta,
        downloads: undefined,
      };
      expect(selectDownloadUrl(noDownloads, "linux-x64")).toBe(
        "https://example.com/default.vsix",
      );
    });
  });

  describe("isPlatformSpecificTarget", () => {
    it("returns false for undefined", () => {
      expect(isPlatformSpecificTarget(undefined)).toBe(false);
    });

    it("returns false for the literal 'undefined' string", () => {
      expect(isPlatformSpecificTarget("undefined")).toBe(false);
    });

    it("returns false for 'universal'", () => {
      expect(isPlatformSpecificTarget("universal")).toBe(false);
    });

    it("returns true for a real platform", () => {
      expect(isPlatformSpecificTarget("linux-x64")).toBe(true);
      expect(isPlatformSpecificTarget("darwin-arm64")).toBe(true);
      expect(isPlatformSpecificTarget("win32-x64")).toBe(true);
    });
  });

  describe("canCopyFromApex", () => {
    it("returns true for universal extensions", () => {
      expect(canCopyFromApex(false, undefined)).toBe(true);
      expect(canCopyFromApex(false, "linux-x64")).toBe(true);
      expect(canCopyFromApex(false, "win32-arm64")).toBe(true);
    });

    it("returns true for per-platform when apex matches target", () => {
      const apex = apexTargetPlatform();
      if (!apex) return; // can't assert on unsupported apex
      expect(canCopyFromApex(true, apex)).toBe(true);
    });

    it("returns false for per-platform when apex differs from target", () => {
      const apex = apexTargetPlatform();
      if (!apex) return;
      const other: TargetPlatform =
        apex === "linux-x64" ? "linux-arm64" : "linux-x64";
      expect(canCopyFromApex(true, other)).toBe(false);
    });

    it("returns false for per-platform when target is undefined", () => {
      expect(canCopyFromApex(true, undefined)).toBe(false);
    });
  });
});
