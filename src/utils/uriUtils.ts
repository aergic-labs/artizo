/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Utility functions for encoding/decoding remote authority URIs.
 *
 * Authority format: `artizo-container+<hex-encoded-id>`
 * The hex encoding avoids issues with special characters in container IDs or paths.
 *
 * Chained authority (State 4 - devcontainer over SSH): an authority may
 * carry a parent remote after `@`, e.g.
 * `artizo-container+<hex>@ssh-remote+<hex>`. VS Code core resolves
 * chained authorities right-to-left, calling `resolveExecServer` on
 * every resolver in the chain except the last. MS's remote-ssh
 * implements `resolveExecServer`; third-party SSH extensions do not,
 * so a chained authority throws "Exec server was not available for
 * ssh-remote+<hex>" before our resolver is reached. `buildRemoteAuthority`
 * therefore emits a *bare* authority (no `@<parent>` suffix) so our
 * resolver is the only/last one and `resolve` is called directly.
 * `encodeChainedAuthority` is retained for future use with a forked
 * SSH extension that implements `resolveExecServer`.
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
  // Strip any chained parent (e.g. `artizo-container+<hex>@ssh-remote+<hex>`).
  // Only the outermost segment is ours to decode; the parent is resolved by
  // VS Code core + the vendor SSH extension.
  const atIdx = authority.indexOf("@");
  const outer = atIdx === -1 ? authority : authority.substring(0, atIdx);

  const plusIndex = outer.indexOf("+");
  if (plusIndex === -1) {
    throw new Error(
      `Invalid authority format: missing '+' separator in "${authority}"`,
    );
  }

  const scheme = outer.substring(0, plusIndex);
  const hex = outer.substring(plusIndex + 1);

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

/**
 * Build a chained authority for State 4: a devcontainer over an SSH remote.
 *
 * Returns `artizo-container+<hex>@ssh-remote+<hex>` (or attached-container)
 * so a new window opened from the workspace-side extension on the SSH host
 * routes back through the SSH host before reaching our resolver. Without
 * the `@<parentAuthority>` suffix, the new window opens on the client.
 *
 * `parentAuthority` is the raw authority of the SSH remote, e.g.
 * `ssh-remote+7b22686f...` - obtainable from the workspace folder's URI.
 */
export function encodeChainedAuthority(
  scheme: string,
  id: string,
  parentAuthority: string,
): string {
  return `${encodeAuthority(scheme, id)}@${parentAuthority}`;
}

/**
 * Build the authority for an `artizo-container` / `attached-container`
 * remote URI.
 *
 * Always emits a *bare* authority (`artizo-container+<hex>`, no
 * `@ssh-remote+<hex>` parent) even when running workspace-side on an
 * SSH host.
 *
 * Why not chain? VS Code core resolves chained authorities
 * right-to-left, calling `resolveExecServer` on every resolver in the
 * chain except the last. For `artizo-container+<hex>@ssh-remote+<hex>`
 * the `ssh-remote` resolver is not last, so core calls
 * `resolveExecServer` on the vendor's SSH extension. MS's remote-ssh
 * implements that method; third-party SSH extensions (Trae's
 * `cloudide-remote-ssh`, `jeanp413/open-remote-ssh`, Kiro's absent
 * one) do not, so core throws "Exec server was not available for
 * ssh-remote+<hex>" before our resolver is ever reached. We cannot
 * inject a stub because the call is routed to the SSH extension's
 * resolver, not ours.
 *
 * The bare authority makes our resolver the only (and therefore last)
 * authority in the chain, so core calls our `resolve` directly with
 * `execServer === undefined`. Our resolver then returns the
 * already-running server endpoint (`127.0.0.1:<port>`) and we drive
 * Docker ourselves - we don't need the exec server's `env()` /
 * `fsStat()` / `remoteExec` surface that MS uses for Docker plumbing.
 *
 * `encodeChainedAuthority` is retained for reference and future use
 * (e.g. if a forked SSH extension that implements `resolveExecServer`
 * is installed), but is not used by `buildRemoteAuthority`.
 */
export function buildRemoteAuthority(scheme: string, id: string): string {
  return encodeAuthority(scheme, id);
}

/**
 * Normalize backslashes to forward slashes in an fsPath.
 *
 * VS Code's fsPath uses the local OS path separator, which produces
 * backslashes on Windows even for Linux remote paths. Forward slashes
 * work everywhere (including Node.js fs on Windows).
 */
export function normalizeFsPath(uri: { fsPath: string }): string {
  return uri.fsPath.replace(/\\/g, "/");
}

/**
 * Resolve the workspace folder path on the host machine.
 *
 * When inside a managed container, the authority encodes the original host
 * path - decode it. Otherwise returns the raw fsPath.
 *
 * IMPORTANT: do NOT normalize path separators here. The
 * `artizo.local_folder` / `devcontainer.local_folder` Docker labels are set
 * by us from the raw fsPath (backslashes on Windows). The resolver and
 * label filters must match that exact string. Normalizing to forward slashes
 * breaks the match and the new window fails to resolve with
 * "No dev container found for workspace".
 */
import * as vscode from "vscode";
import { getLogger } from "./logger";
export function getHostWorkspaceFolder(): string | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!folder) {
    getLogger().info("getHostWorkspaceFolder: no workspace folders");
    return undefined;
  }

  getLogger().info(
    `getHostWorkspaceFolder: authority="${folder.authority}", scheme="${folder.scheme}", fsPath="${folder.fsPath}", path="${folder.path}"`,
  );

  if (
    folder.authority?.startsWith("artizo-container") ||
    folder.authority?.startsWith("attached-container")
  ) {
    const decoded = decodeAuthority(folder.authority).id;
    getLogger().info(
      `getHostWorkspaceFolder: decoded authority -> "${decoded}"`,
    );

    // State 4 proxy payload: the decoded id is a JSON object with
    // `proxy: true`, not a filesystem path. "Reopen in Host" should reopen
    // the SSH-remote workspace, so reconstruct the vscode-remote URI using
    // the embedded sshAuthority + hostWorkspacePath.
    if (decoded.startsWith("{")) {
      try {
        const payload = JSON.parse(decoded) as Record<string, unknown>;
        if (
          payload.proxy === true &&
          typeof payload.sshAuthority === "string" &&
          typeof payload.hostWorkspacePath === "string" &&
          payload.sshAuthority &&
          payload.hostWorkspacePath
        ) {
          const hostPath = payload.hostWorkspacePath as string;
          const uriPath = hostPath.startsWith("/") ? hostPath : "/" + hostPath;
          const uri = `vscode-remote://${payload.sshAuthority}${uriPath}`;
          getLogger().info(
            `getHostWorkspaceFolder: proxy payload -> reopening SSH remote "${uri}"`,
          );
          return uri;
        }
        getLogger().info(
          "getHostWorkspaceFolder: proxy payload missing sshAuthority/hostWorkspacePath",
        );
      } catch {
        getLogger().info(
          "getHostWorkspaceFolder: proxy payload JSON parse failed",
        );
      }
      return undefined;
    }

    // Attached containers encode the container ID (64-char hex) as the id.
    // That's not a host path, so "Reopen in Host" is not available.
    if (/^[0-9a-f]{64}$/i.test(decoded)) {
      getLogger().info(
        `getHostWorkspaceFolder: decoded id is a container ID, not a host path`,
      );
      return undefined;
    }

    return decoded;
  }

  getLogger().info(`getHostWorkspaceFolder: fsPath -> "${folder.fsPath}"`);
  return folder.fsPath;
}
