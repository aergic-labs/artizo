/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Utility functions for encoding/decoding remote authority URIs.
 *
 * Authority format: `artizo-container+<hex-encoded-id>`
 * The hex encoding avoids issues with special characters in container IDs or paths.
 */

/** Encode a container identifier into a remote authority string. */
export function encodeAuthority(scheme: string, id: string): string {
  const hex = Buffer.from(id, "utf-8").toString("hex");
  return `${scheme}+${hex}`;
}

/** Decode a remote authority string back to its container identifier. */
export function decodeAuthority(authority: string): {
  scheme: string;
  id: string;
} {
  const plusIndex = authority.indexOf("+");
  if (plusIndex === -1) {
    throw new Error(
      `Invalid authority format: missing '+' separator in "${authority}"`,
    );
  }

  const scheme = authority.substring(0, plusIndex);
  const hex = authority.substring(plusIndex + 1);

  if (hex.length === 0) {
    throw new Error(
      `Invalid authority format: empty identifier in "${authority}"`,
    );
  }

  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error(
      `Invalid authority format: non-hex characters in identifier "${hex}"`,
    );
  }

  if (hex.length % 2 !== 0) {
    throw new Error(`Invalid authority format: odd-length hex string "${hex}"`);
  }

  const id = Buffer.from(hex, "hex").toString("utf-8");
  return { scheme, id };
}

/** Resolve the local workspace folder path, even when connected to a remote. */
import * as vscode from "vscode";
export function getLocalWorkspaceFolder(): string | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!folder) return undefined;
  if (!vscode.env.remoteName) return folder.fsPath;

  try {
    const { id } = decodeAuthority(folder.authority);
    return id;
  } catch {
    return folder.fsPath;
  }
}