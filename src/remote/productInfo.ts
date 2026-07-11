/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/** Product information reader. */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getPlatformAdapter } from "../platform";

/**
 * Product information extracted from product.json, used for server
 * download URL construction and binary identification.
 */
export interface ProductInfo {
  commit: string;
  quality: string;
  serverApplicationName: string;
  serverDataFolderName: string;
  serverDownloadUrlTemplate?: string;
  buildId?: string;
}

export async function getProductInfo(appRoot: string): Promise<ProductInfo> {
  const productJsonPath = join(appRoot, "product.json");

  const rawContent = await readFile(productJsonPath, "utf-8");

  let productJson: Record<string, unknown>;
  try {
    productJson = JSON.parse(rawContent);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse product.json: ${message}`, { cause: err });
  }

  const commit =
    typeof productJson.commit === "string" ? productJson.commit : "";

  if (!commit) {
    throw new Error('product.json is missing "commit" field');
  }

  const quality =
    typeof productJson.quality === "string" ? productJson.quality : "stable";

  const adapter = await getPlatformAdapter();
  const serverApplicationName =
    typeof productJson.serverApplicationName === "string"
      ? productJson.serverApplicationName
      : adapter.serverApplicationName;

  const serverDataFolderName =
    typeof productJson.serverDataFolderName === "string"
      ? productJson.serverDataFolderName
      : adapter.dataFolderName;

  // Extract download URL template from top-level or nested remote.SSH location
  let serverDownloadUrlTemplate: string | undefined;
  if (typeof productJson.serverDownloadUrlTemplate === "string") {
    serverDownloadUrlTemplate = productJson.serverDownloadUrlTemplate;
  } else if (productJson.remote && typeof productJson.remote === "object") {
    const remote = productJson.remote as Record<string, unknown>;
    if (remote.SSH && typeof remote.SSH === "object") {
      const ssh = remote.SSH as Record<string, unknown>;
      if (typeof ssh.serverDownloadUrlTemplate === "string") {
        serverDownloadUrlTemplate = ssh.serverDownloadUrlTemplate;
      }
    }
  }

  const buildId =
    typeof productJson.buildId === "string" ? productJson.buildId : undefined;

  return {
    commit,
    quality,
    serverApplicationName,
    serverDataFolderName,
    serverDownloadUrlTemplate,
    buildId,
  };
}

export async function buildServerDownloadUrl(
  info: ProductInfo,
  targetArch: string,
): Promise<string> {
  if (info.serverDownloadUrlTemplate) {
    return info.serverDownloadUrlTemplate
      .replace(/\$\{commit\}/g, info.commit)
      .replace(/\$\{quality\}/g, info.quality)
      .replace(/\$\{os\}/g, "linux")
      .replace(/\$\{arch\}/g, targetArch)
      .replace(/\$\{platform\}/g, targetArch);
  }

  const adapter = await getPlatformAdapter();
  return adapter.getServerDownloadUrl(
    info.commit,
    info.quality,
    "linux",
    targetArch,
    info.buildId,
  );
}
