/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getProductInfo,
  buildServerDownloadUrl,
  type ProductInfo,
} from "../../src/remote/productInfo";
import { getPlatformAdapter } from "../../src/platform";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const { vscodeMock } = vi.hoisted(() => {
  const vscode = {
    workspace: {
      getConfiguration: () => ({
        get: () => ({}),
      }),
    },
  };
  return { vscodeMock: vscode };
});

vi.mock("vscode", () => ({ default: vscodeMock, ...vscodeMock }));
vi.mock("node:fs/promises");

vi.mock("../../src/platform", () => ({
  getPlatformAdapter: vi.fn(),
}));

const mockGetPlatformAdapter = vi.mocked(getPlatformAdapter);

describe("productInfo", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockGetPlatformAdapter.mockReturnValue({
      serverApplicationName: "kiro-server",
      dataFolderName: ".kiro",
      getServerDownloadUrl: (
        commit: string,
        quality: string,
        _targetPlatform: string,
        _targetArch: string,
      ) => ({
        url: `https://update.code.visualstudio.com/commit:${commit}/server-linux-x64/${quality}`,
        type: "auto" as const,
      }),
      getAdditionalDockerRunArgs: vi.fn().mockReturnValue([]),
    } as any);
  });

  describe("getProductInfo", () => {
    it("extracts all fields from a complete product.json", async () => {
      const product = {
        commit: "abc123def456",
        quality: "insider",
        serverApplicationName: "kiro-reh",
        serverDataFolderName: ".kiro-server",
        serverDownloadUrlTemplate:
          "https://example.com/${quality}/${commit}/server-linux-${platform}",
      };

      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(product));

      const info = await getProductInfo("/app/root");

      expect(info).toMatchObject({
        commit: "abc123def456",
        quality: "insider",
        serverApplicationName: "kiro-reh",
        serverDataFolderName: ".kiro-server",
        serverDownloadUrlTemplate:
          "https://example.com/${quality}/${commit}/server-linux-${platform}",
      });

      expect(fs.readFile).toHaveBeenCalledWith(
        path.join("/app/root", "product.json"),
        "utf-8",
      );
    });

    it("uses default values when optional fields are missing", async () => {
      const product = {
        commit: "deadbeef1234",
      };

      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(product));

      const info = await getProductInfo("/some/path");

      expect(info.commit).toBe("deadbeef1234");
      expect(info.quality).toBe("stable");
      expect(info.serverApplicationName).toBe("kiro-server");
      expect(info.serverDataFolderName).toBe(".kiro");
      expect(info.serverDownloadUrlTemplate).toBeUndefined();
    });

    it("reads serverDownloadUrlTemplate from remote.SSH if top-level is missing", async () => {
      const product = {
        commit: "abc123",
        remote: {
          SSH: {
            serverDownloadUrlTemplate:
              "https://ssh.example.com/${commit}/${platform}",
          },
        },
      };

      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(product));

      const info = await getProductInfo("/app");

      expect(info.serverDownloadUrlTemplate).toBe(
        "https://ssh.example.com/${commit}/${platform}",
      );
    });

    it("throws an error when commit is missing", async () => {
      const product = {
        quality: "stable",
        serverApplicationName: "kiro-reh",
      };

      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(product));

      await expect(getProductInfo("/app")).rejects.toThrow(
        'product.json is missing "commit" field',
      );
    });

    it("throws when product.json does not exist", async () => {
      vi.mocked(fs.readFile).mockRejectedValue(
        new Error("ENOENT: no such file or directory"),
      );

      await expect(getProductInfo("/missing")).rejects.toThrow("ENOENT");
    });
  });

  describe("buildServerDownloadUrl", () => {
    it("uses the template when serverDownloadUrlTemplate is provided", async () => {
      const info: ProductInfo = {
        commit: "abc123",
        quality: "stable",
        version: "1.0.0",
        release: "1.0.0",
        verifyChecksum: false,
        onNoChecksum: "warn",
        serverApplicationName: "kiro-reh",
        serverDataFolderName: ".kiro-server",
        serverDownloadUrlTemplate:
          "https://cdn.example.com/${quality}/${commit}/server-linux-${platform}.tar.gz",
      };

      const { url } = await buildServerDownloadUrl(info, "x64");

      expect(url).toBe(
        "https://cdn.example.com/stable/abc123/server-linux-x64.tar.gz",
      );
    });

    it("replaces all occurrences of placeholders in the template", async () => {
      const info: ProductInfo = {
        commit: "deadbeef",
        quality: "insider",
        version: "1.0.0",
        release: "1.0.0",
        verifyChecksum: false,
        onNoChecksum: "warn",
        serverApplicationName: "kiro-reh",
        serverDataFolderName: ".kiro-server",
        serverDownloadUrlTemplate:
          "https://example.com/${commit}/${commit}/${quality}/${platform}",
      };

      const { url } = await buildServerDownloadUrl(info, "arm64");

      expect(url).toBe("https://example.com/deadbeef/deadbeef/insider/arm64");
    });

    it("constructs default URL when no template is provided", async () => {
      const info: ProductInfo = {
        commit: "abc123def",
        quality: "stable",
        version: "1.0.0",
        release: "1.0.0",
        verifyChecksum: false,
        onNoChecksum: "warn",
        serverApplicationName: "kiro-reh",
        serverDataFolderName: ".kiro-server",
      };

      const { url } = await buildServerDownloadUrl(info, "x64");

      expect(url).toBe(
        "https://update.code.visualstudio.com/commit:abc123def/server-linux-x64/stable",
      );
    });

    it("constructs default URL for arm64 platform", async () => {
      const info: ProductInfo = {
        commit: "fedcba987",
        quality: "insider",
        version: "1.0.0",
        release: "1.0.0",
        verifyChecksum: false,
        onNoChecksum: "warn",
        serverApplicationName: "kiro-reh",
        serverDataFolderName: ".kiro-server",
      };

      const { url } = await buildServerDownloadUrl(info, "arm64");

      expect(url).toBe(
        "https://update.code.visualstudio.com/commit:fedcba987/server-linux-x64/insider",
      );
    });

    it("bob auto-path uses the product.json template, not the vscodium fallback", async () => {
      mockGetPlatformAdapter.mockReturnValue({
        name: "Bob",
        dataFolderName: ".bobide",
        serverApplicationName: "bobide-server",
        getServerDownloadUrl: () => ({
          url: "https://wrong.example.com/vscodium-reh.tar.gz",
          type: "fallback" as const,
        }),
        getAdditionalDockerRunArgs: vi.fn().mockReturnValue([]),
      } as any);

      const product = {
        applicationName: "bobide",
        commit: "b48bf62",
        version: "1.126.0+bob2.3.0",
        serverApplicationName: "bobide-server",
        serverDataFolderName: ".bobide-server",
        serverDownloadUrlTemplate:
          "https://api.us-east.bob.ibm.com/update/reh/ibm-bob/${os}/${arch}/${version}",
      };

      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(product));

      const info = await getProductInfo("/app/root");
      const result = await buildServerDownloadUrl(info, "x64");

      expect(result.type).toBe("custom");
      expect(result.url).toBe(
        "https://api.us-east.bob.ibm.com/update/reh/ibm-bob/linux/x64/1.126.0+bob2.3.0",
      );
    });
  });
});