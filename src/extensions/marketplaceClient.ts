/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Open VSX Registry client for fetching extension metadata and downloading VSIX files.
 */

import * as https from "node:https";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Metadata returned from the Open VSX Registry for an extension.
 */
export interface ExtensionMetadata {
  namespace: string;
  name: string;
  version: string;
  displayName?: string;
  description?: string;
  downloadUrl: string;
  extensionKind?: string[];
  /**
   * Target platform for the VSIX (e.g. "universal", "linux-x64").
   * Open VSX returns this per-version; it determines the folder suffix
   * the server's extension scanner expects (`<id>-<version>-<platform>`).
   */
  targetPlatform?: string;
  /**
   * Per-platform download URLs when the extension ships platform-specific
   * builds. Keys are TargetPlatform strings ("linux-x64", "linux-arm64",
   * ...), values are the VSIX URL. Universal-only extensions have just
   * `{ "universal": url }` or omit this field.
   */
  downloads?: Record<string, string>;
  /**
   * Publisher display name from the registry. Falls back to the
   * namespace (publisher id) when the registry provides no separate
   * display name.
   */
  publisherDisplayName?: string;
  /** Extension IDs that this extension hard-depends on (namespace.name). */
  dependencies: string[];
  /** Extension IDs bundled by this extension pack (namespace.name). */
  bundledExtensions: string[];
  /** Error from metadata fetch, when the fetch failed. */
  fetchError?: string;
}

/**
 * Options for the marketplace client, allowing injection of a custom HTTP fetcher for testing.
 */
export interface MarketplaceClientOptions {
  registryUrl?: string;
  httpGet?: (url: string) => Promise<string>;
  httpDownload?: (url: string, destPath: string) => Promise<void>;
}

const DEFAULT_REGISTRY_URL = "https://open-vsx.org/api";

export function parseExtensionId(id: string): {
  namespace: string;
  name: string;
} {
  const dotIndex = id.indexOf(".");
  if (dotIndex <= 0 || dotIndex === id.length - 1) {
    throw new Error(
      `Invalid extension ID format: "${id}". Expected "namespace.name".`,
    );
  }
  return {
    namespace: id.substring(0, dotIndex),
    name: id.substring(dotIndex + 1),
  };
}

function defaultHttpGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          defaultHttpGet(res.headers.location).then(resolve, reject);
          return;
        }

        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }

        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
        res.on("error", reject);
      })
      .on("error", reject);
  });
}

function defaultHttpDownload(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          defaultHttpDownload(res.headers.location, destPath).then(
            resolve,
            reject,
          );
          return;
        }

        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode} downloading ${url}`));
          return;
        }

        const fileStream = fs.createWriteStream(destPath);
        res.pipe(fileStream);
        fileStream.on("finish", () => {
          fileStream.close();
          resolve();
        });
        fileStream.on("error", (err) => {
          fs.unlink(destPath, () => {});
          reject(err);
        });
      })
      .on("error", (err) => {
        reject(err);
      });
  });
}

/**
 * Client for the Open VSX Registry.
 */
export class MarketplaceClient {
  private readonly registryUrl: string;
  private readonly httpGet: (url: string) => Promise<string>;
  private readonly httpDownload: (
    url: string,
    destPath: string,
  ) => Promise<void>;

  constructor(options?: MarketplaceClientOptions) {
    this.registryUrl = options?.registryUrl ?? DEFAULT_REGISTRY_URL;
    this.httpGet = options?.httpGet ?? defaultHttpGet;
    this.httpDownload = options?.httpDownload ?? defaultHttpDownload;
  }

  /**
   * Fetch extension metadata from the Open VSX Registry.
   *
   * @param id - Extension ID in "namespace.name" format
   * @param targetPlatform - Optional target platform. When set and the
   *   extension has per-platform builds, the returned `downloadUrl` and
   *   `targetPlatform` fields reflect the platform-specific variant.
   * @returns Extension metadata including download URL
   */
  async getExtensionInfo(
    id: string,
    targetPlatform?: string,
  ): Promise<ExtensionMetadata> {
    const { namespace, name } = parseExtensionId(id);
    const url = `${this.registryUrl}/${namespace}/${name}`;

    const body = await this.httpGet(url);
    const data = JSON.parse(body);

    const downloads: Record<string, string> | undefined =
      typeof data.downloads === "object" && data.downloads !== null
        ? data.downloads
        : undefined;

    // Pick the platform-specific download URL when available.
    let downloadUrl = data.files?.download;
    let resolvedPlatform: string | undefined = data.targetPlatform;
    if (targetPlatform && downloads && downloads[targetPlatform]) {
      downloadUrl = downloads[targetPlatform];
      resolvedPlatform = targetPlatform;
    }
    if (!downloadUrl) {
      throw new Error(`No download URL found for extension "${id}"`);
    }

    const deps = Array.isArray(data.dependencies)
      ? data.dependencies
          .map(
            (d: { namespace: string; extension: string }) =>
              `${d.namespace}.${d.extension}`,
          )
          .filter((id: string) => typeof id === "string")
      : [];
    const bundled = Array.isArray(data.bundledExtensions)
      ? data.bundledExtensions
          .map(
            (d: { namespace: string; extension: string }) =>
              `${d.namespace}.${d.extension}`,
          )
          .filter((id: string) => typeof id === "string")
      : [];

    return {
      namespace,
      name,
      version: data.version ?? "unknown",
      displayName: data.displayName,
      description: data.description,
      downloadUrl,
      extensionKind: data.extensionKind,
      targetPlatform: resolvedPlatform,
      downloads,
      publisherDisplayName:
        data.namespaceDisplayName ?? data.publishedBy?.loginName ?? namespace,
      dependencies: deps,
      bundledExtensions: bundled,
    };
  }

  /**
   * Download a VSIX file for an extension to a target directory.
   *
   * @param id - Extension ID in "namespace.name" format
   * @param targetDir - Directory to save the VSIX file
   * @param targetPlatform - Optional target platform for platform-specific VSIX
   * @returns Path to the downloaded VSIX file
   */
  async downloadVsix(
    id: string,
    targetDir: string,
    targetPlatform?: string,
  ): Promise<string> {
    const metadata = await this.getExtensionInfo(id, targetPlatform);
    return this.downloadFromMetadata(metadata, targetDir);
  }

  /**
   * Download a VSIX using pre-fetched metadata (avoids re-fetching
   * from the registry when the caller already has the metadata).
   */
  async downloadFromMetadata(
    metadata: ExtensionMetadata,
    targetDir: string,
  ): Promise<string> {
    const fileName = `${metadata.namespace}.${metadata.name}-${metadata.version}.vsix`;
    const destPath = path.join(targetDir, fileName);

    await this.httpDownload(metadata.downloadUrl, destPath);

    return destPath;
  }
}
