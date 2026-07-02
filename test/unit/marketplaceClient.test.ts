/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  parseExtensionId,
  MarketplaceClient,
  type ExtensionMetadata,
} from "../../src/extensions/marketplaceClient";

describe("parseExtensionId", () => {
  it("parses a valid namespace.name", () => {
    const result = parseExtensionId("ms-python.python");
    expect(result).toEqual({ namespace: "ms-python", name: "python" });
  });

  it("parses with multiple dots in name", () => {
    const result = parseExtensionId("eamodio.gitlens");
    expect(result).toEqual({ namespace: "eamodio", name: "gitlens" });
  });

  it("throws on missing dot", () => {
    expect(() => parseExtensionId("no-dot")).toThrow(
      "Invalid extension ID format",
    );
  });

  it("throws on trailing dot", () => {
    expect(() => parseExtensionId("namespace.")).toThrow(
      "Invalid extension ID format",
    );
  });

  it("throws on leading dot", () => {
    expect(() => parseExtensionId(".name")).toThrow(
      "Invalid extension ID format",
    );
  });
});

describe("MarketplaceClient", () => {
  const mockHttpGet = vi.fn();
  const mockHttpDownload = vi.fn();

  beforeEach(() => {
    vi.resetAllMocks();
  });

  function createClient(overrides?: {
    httpGet?: any;
    httpDownload?: any;
    registryUrl?: string;
  }) {
    return new MarketplaceClient({
      httpGet: overrides?.httpGet ?? mockHttpGet,
      httpDownload: overrides?.httpDownload ?? mockHttpDownload,
      registryUrl: overrides?.registryUrl,
    });
  }

  describe("getExtensionInfo", () => {
    it("fetches and parses extension metadata", async () => {
      mockHttpGet.mockResolvedValue(
        JSON.stringify({
          version: "2024.1.0",
          displayName: "Python",
          description: "Python language support",
          files: { download: "https://example.com/python.vsix" },
        }),
      );

      const client = createClient();
      const info = await client.getExtensionInfo("ms-python.python");

      expect(info).toEqual({
        namespace: "ms-python",
        name: "python",
        version: "2024.1.0",
        displayName: "Python",
        description: "Python language support",
        downloadUrl: "https://example.com/python.vsix",
        extensionKind: undefined,
        targetPlatform: undefined,
        downloads: undefined,
        publisherDisplayName: "ms-python",
        dependencies: [],
        bundledExtensions: [],
      });
      expect(mockHttpGet).toHaveBeenCalledWith(
        "https://open-vsx.org/api/ms-python/python",
      );
    });

    it("throws when no download URL in response", async () => {
      mockHttpGet.mockResolvedValue(
        JSON.stringify({ version: "1.0.0", files: {} }),
      );

      const client = createClient();
      await expect(client.getExtensionInfo("foo.bar")).rejects.toThrow(
        "No download URL found",
      );
    });

    it("handles missing optional fields", async () => {
      mockHttpGet.mockResolvedValue(
        JSON.stringify({
          files: { download: "https://example.com/ext.vsix" },
        }),
      );

      const client = createClient();
      const info = await client.getExtensionInfo("test.extension");

      expect(info.version).toBe("unknown");
      expect(info.displayName).toBeUndefined();
      expect(info.downloadUrl).toBe("https://example.com/ext.vsix");
      expect(info.dependencies).toEqual([]);
      expect(info.bundledExtensions).toEqual([]);
    });

    it("uses custom registry URL", async () => {
      mockHttpGet.mockResolvedValue(
        JSON.stringify({
          files: { download: "https://example.com/foo.vsix" },
        }),
      );

      const client = createClient({
        registryUrl: "https://custom.registry/api",
      });
      await client.getExtensionInfo("a.b");

      expect(mockHttpGet).toHaveBeenCalledWith(
        "https://custom.registry/api/a/b",
      );
    });

    it("returns downloads map when present", async () => {
      mockHttpGet.mockResolvedValue(
        JSON.stringify({
          version: "1.0.0",
          files: { download: "https://example.com/default.vsix" },
          downloads: {
            "linux-x64": "https://example.com/linux-x64.vsix",
            "linux-arm64": "https://example.com/linux-arm64.vsix",
            universal: "https://example.com/default.vsix",
          },
        }),
      );

      const client = createClient();
      const info = await client.getExtensionInfo("ns.ext");

      expect(info.downloads).toEqual({
        "linux-x64": "https://example.com/linux-x64.vsix",
        "linux-arm64": "https://example.com/linux-arm64.vsix",
        universal: "https://example.com/default.vsix",
      });
      // Default downloadUrl when no targetPlatform specified
      expect(info.downloadUrl).toBe("https://example.com/default.vsix");
      expect(info.targetPlatform).toBeUndefined();
    });

    it("picks platform-specific download URL when targetPlatform is set", async () => {
      mockHttpGet.mockResolvedValue(
        JSON.stringify({
          version: "1.0.0",
          files: { download: "https://example.com/default.vsix" },
          targetPlatform: "universal",
          downloads: {
            "linux-x64": "https://example.com/linux-x64.vsix",
            "linux-arm64": "https://example.com/linux-arm64.vsix",
            universal: "https://example.com/default.vsix",
          },
        }),
      );

      const client = createClient();
      const info = await client.getExtensionInfo("ns.ext", "linux-arm64");

      expect(info.downloadUrl).toBe("https://example.com/linux-arm64.vsix");
      expect(info.targetPlatform).toBe("linux-arm64");
    });

    it("falls back to default when platform-specific URL is missing", async () => {
      mockHttpGet.mockResolvedValue(
        JSON.stringify({
          version: "1.0.0",
          files: { download: "https://example.com/default.vsix" },
          targetPlatform: "universal",
          downloads: {
            "linux-x64": "https://example.com/linux-x64.vsix",
            universal: "https://example.com/default.vsix",
          },
        }),
      );

      const client = createClient();
      const info = await client.getExtensionInfo("ns.ext", "win32-x64");

      // win32-x64 not in downloads, falls back to default
      expect(info.downloadUrl).toBe("https://example.com/default.vsix");
    });
  });

  describe("downloadVsix", () => {
    it("downloads VSIX and returns path", async () => {
      mockHttpGet.mockResolvedValue(
        JSON.stringify({
          version: "1.2.3",
          files: { download: "https://cdn.example.com/ns.name-1.2.3.vsix" },
        }),
      );
      mockHttpDownload.mockResolvedValue(undefined);

      const client = createClient();
      const result = await client.downloadVsix("ns.name", "/tmp/ext");

      expect(result).toContain("ns.name-1.2.3.vsix");
      expect(mockHttpDownload).toHaveBeenCalledWith(
        "https://cdn.example.com/ns.name-1.2.3.vsix",
        expect.stringContaining("ns.name-1.2.3.vsix"),
      );
    });

    it("downloads platform-specific VSIX when targetPlatform is set", async () => {
      mockHttpGet.mockResolvedValue(
        JSON.stringify({
          version: "1.0.0",
          files: { download: "https://cdn.example.com/default.vsix" },
          downloads: {
            "linux-x64": "https://cdn.example.com/linux-x64.vsix",
            universal: "https://cdn.example.com/default.vsix",
          },
        }),
      );
      mockHttpDownload.mockResolvedValue(undefined);

      const client = createClient();
      const result = await client.downloadVsix(
        "ns.ext",
        "/tmp/ext",
        "linux-x64",
      );

      expect(mockHttpDownload).toHaveBeenCalledWith(
        "https://cdn.example.com/linux-x64.vsix",
        expect.stringContaining("ns.ext-1.0.0.vsix"),
      );
    });
  });
});
