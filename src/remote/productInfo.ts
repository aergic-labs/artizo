/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/** Product information reader. */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getPlatformAdapter } from "../platform";
import { mergeServerDownloadConfig, type RawProductFields } from "../platform/mergeConfig";
import { buildServerDownloadUrl as resolveDownloadUrl } from "./url";
import type { DownloadTemplateInfo, DownloadAdapter } from "../platform/downloadTypes";

/**
 * Product information extracted from product.json, used for server
 * download URL construction and binary identification.
 *
 * Extends DownloadTemplateInfo (the shared interface used by url.ts,
 * checksum.ts, and the config panel) with artizo-specific fields.
 */
export interface ProductInfo extends DownloadTemplateInfo {
  serverApplicationName: string;
  serverDataFolderName: string;
  buildId?: string;
}

/**
 * Read product.json from the running IDE's appRoot.
 */
export async function readProductJson(appRoot: string): Promise<Record<string, unknown>> {
  const productJsonPath = join(appRoot, "product.json");
  const rawContent = await readFile(productJsonPath, "utf-8");
  return JSON.parse(rawContent);
}

export async function getProductInfo(appRoot: string): Promise<ProductInfo> {
  let productJson: Record<string, unknown>;
  try {
    productJson = await readProductJson(appRoot);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse product.json: ${message}`, { cause: err });
  }

  const commit =
    typeof productJson.commit === "string" ? productJson.commit : "";

  if (!commit) {
    throw new Error('product.json is missing "commit" field');
  }

  const adapter = await getPlatformAdapter();
  const serverApplicationName =
    typeof productJson.serverApplicationName === "string"
      ? productJson.serverApplicationName
      : adapter.serverApplicationName;

  const serverDataFolderName =
    typeof productJson.serverDataFolderName === "string"
      ? productJson.serverDataFolderName
      : adapter.dataFolderName;

  const raw: RawProductFields = {
    commit,
    quality: typeof productJson.quality === "string" ? productJson.quality : "stable",
    version: typeof productJson.version === "string" ? productJson.version : "",
    productVersion:
      typeof productJson.productVersion === "string" ? productJson.productVersion : "",
    windsurfVersion:
      typeof productJson.windsurfVersion === "string" ? productJson.windsurfVersion : "",
    ideVersion:
      typeof productJson.ideVersion === "string" ? productJson.ideVersion : "",
    serverApplicationName,
    serverDataFolderName,
  };

  const merged = mergeServerDownloadConfig(
    raw,
    adapter.getChecksumConfig?.(),
    "artizo",
  );

  // Extract download URL template from nested remote.SSH location if present
  // (product.json-level template is handled by mergeConfig via user settings).
  if (!merged.serverDownloadUrlTemplate) {
    if (typeof productJson.serverDownloadUrlTemplate === "string") {
      merged.serverDownloadUrlTemplate = productJson.serverDownloadUrlTemplate;
    } else if (productJson.remote && typeof productJson.remote === "object") {
      const remote = productJson.remote as Record<string, unknown>;
      if (remote.SSH && typeof remote.SSH === "object") {
        const ssh = remote.SSH as Record<string, unknown>;
        if (typeof ssh.serverDownloadUrlTemplate === "string") {
          merged.serverDownloadUrlTemplate = ssh.serverDownloadUrlTemplate;
        }
      }
    }
  }

  const buildId =
    typeof productJson.buildId === "string" ? productJson.buildId : undefined;

  return {
    ...merged,
    buildId,
  };
}

/**
 * Resolve the server download URL using the shared template engine.
 * Delegates to url.ts's buildServerDownloadUrl, which handles
 * serverDownloadUrlTemplate (custom mode) and adapter fallback.
 */
export async function buildServerDownloadUrl(
  info: ProductInfo,
  targetArch: string,
): Promise<string> {
  const adapter = await getPlatformAdapter();
  return resolveDownloadUrl(info, adapter as DownloadAdapter, "linux", targetArch);
}

// Re-exports removed; config panel imports from ./url directly.
