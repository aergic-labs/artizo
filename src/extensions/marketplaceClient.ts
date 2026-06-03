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
   * @returns Extension metadata including download URL
   */
  async getExtensionInfo(id: string): Promise<ExtensionMetadata> {
    const { namespace, name } = parseExtensionId(id);
    const url = `${this.registryUrl}/${namespace}/${name}`;

    const body = await this.httpGet(url);
    const data = JSON.parse(body);

    const downloadUrl = data.files?.download;
    if (!downloadUrl) {
      throw new Error(`No download URL found for extension "${id}"`);
    }

    return {
      namespace,
      name,
      version: data.version ?? "unknown",
      displayName: data.displayName,
      description: data.description,
      downloadUrl,
      extensionKind: data.extensionKind,
    };
  }

  /**
   * Download a VSIX file for an extension to a target directory.
   *
   * @param id - Extension ID in "namespace.name" format
   * @param targetDir - Directory to save the VSIX file
   * @returns Path to the downloaded VSIX file
   */
  async downloadVsix(id: string, targetDir: string): Promise<string> {
    const metadata = await this.getExtensionInfo(id);
    const fileName = `${metadata.namespace}.${metadata.name}-${metadata.version}.vsix`;
    const destPath = path.join(targetDir, fileName);

    await this.httpDownload(metadata.downloadUrl, destPath);

    return destPath;
  }
}