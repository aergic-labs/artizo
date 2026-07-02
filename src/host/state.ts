/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Central execution-tier detection.
 *
 * Four high-level tiers drive extension behavior:
 *
 *   LocalHost              - local machine, no remote. Docker is local.
 *   LocalDevContainer      - inside a devcontainer spawned from the host.
 *                            Workspace-side can't drive Docker; UI-side
 *                            (on the parent host) owns lifecycle.
 *   RemoteSSH              - on an SSH-class remote (ssh-remote and forks).
 *                            Docker is local to the workspace host.
 *   RemoteSSHDevContainer  - inside a devcontainer spawned from an SSH remote.
 *                            Workspace-side can't drive Docker; UI-side
 *                            (on the SSH host) owns lifecycle.
 *   UnknownRemote          - wsl, codespaces, tunnel, etc. Not supported.
 *
 * Under extensionKind ["workspace","ui"], the side that has Docker owns
 * container lifecycle:
 *   - LocalHost and RemoteSSH: workspace-side has Docker → workspace owns.
 *   - LocalDevContainer and RemoteSSHDevContainer: workspace-side is trapped
 *     in the container → UI owns.
 *
 * The prior UI-only design forced terminal-RPC to reach Docker across hosts.
 * Making the extension ["workspace","ui"] lets the side that has Docker
 * drive it directly.
 */

import * as vscode from "vscode";
import { decodeAuthority } from "../utils/uriUtils";

export enum ExecutionTier {
  LocalHost = "LocalHost",
  LocalDevContainer = "LocalDevContainer",
  RemoteSSH = "RemoteSSH",
  RemoteSSHDevContainer = "RemoteSSHDevContainer",
  UnknownRemote = "UnknownRemote",
}

export type LifecycleOwner = "workspace" | "ui" | "none";

export interface DetectedTier {
  tier: ExecutionTier;
  owner: LifecycleOwner;
  remoteName: string | undefined;
  remoteAuthority: string | undefined;
  extensionKind: vscode.ExtensionKind | undefined;
  /** For devcontainer tiers: the parent remote ("host" or "ssh-remote"). */
  parentRemote: string | undefined;
}

/**
 * Remotes we explicitly don't support. Anything that isn't one of these,
 * isn't undefined, and isn't a devcontainer/attached-container is treated
 * as an SSH-class remote. This is a denylist so unknown SSH forks work.
 */
const UNSUPPORTED_REMOTES = new Set(["wsl", "codespaces", "tunnel"]);

/** Devcontainer authority prefixes (our own + attached). */
const DEVCONTAINER_PREFIXES = ["artizo-container", "attached-container"];

function isDevcontainerName(remoteName: string): boolean {
  return DEVCONTAINER_PREFIXES.some((p) => remoteName.startsWith(p));
}

/**
 * Classify a devcontainer window's parent remote by decoding its authority.
 *
 * State-4 (devcontainer-over-SSH) authorities encode a `{ proxy: true, ... }`
 * JSON payload; a local devcontainer encodes a plain host path (or a container
 * id for attached-container). Presence of the proxy payload means the parent
 * is an SSH host. No cross-host call is needed - the discriminator is already
 * in the bare authority.
 */
function devcontainerParent(
  remoteAuthority: string | undefined,
): "host" | "ssh-remote" {
  if (!remoteAuthority) return "host";
  try {
    const { id } = decodeAuthority(remoteAuthority);
    if (id.startsWith("{")) {
      const payload = JSON.parse(id) as { proxy?: unknown };
      if (payload.proxy === true) return "ssh-remote";
    }
  } catch {
    /* malformed/undecodable authority: treat as a local devcontainer */
  }
  return "host";
}

/** True for any devcontainer tier (LocalDevContainer or RemoteSSHDevContainer). */
export function isDevContainerTier(tier: ExecutionTier): boolean {
  return (
    tier === ExecutionTier.LocalDevContainer ||
    tier === ExecutionTier.RemoteSSHDevContainer
  );
}

/**
 * Detect the current execution tier.
 *
 * `extensionKind` is the *actual* kind at runtime
 * (`context.extension.extensionKind`), not the declared preference - VS Code
 * may fall back to UI-only even when ["workspace","ui"] is declared.
 *
 * Devcontainer tiers are distinguished by decoding the bare authority: a
 * State-4 (devcontainer-over-SSH) authority carries a `{ proxy: true, ... }`
 * payload, while a local devcontainer encodes a plain host path (or container
 * id for attached). Proxy payload => RemoteSSHDevContainer (parentRemote
 * "ssh-remote"); otherwise LocalDevContainer (parentRemote "host").
 */
export function detectTier(
  extensionKind: vscode.ExtensionKind | undefined,
): DetectedTier {
  const remoteName = vscode.env.remoteName;
  // `remoteAuthority` is gated behind the `resolvers` API proposal. Before
  // the proposal is enabled (argv.json not yet patched), the getter throws.
  // We can still tier-detect from `remoteName` alone; `remoteAuthority` is
  // only needed to disambiguate devcontainer tiers, which can't happen
  // before the resolver is available anyway. Treat the throw as undefined.
  let remoteAuthority: string | undefined;
  try {
    remoteAuthority = (vscode.env as any).remoteAuthority as string | undefined;
  } catch {
    remoteAuthority = undefined;
  }

  // Tier 1: no remote - local host.
  if (!remoteName) {
    return {
      tier: ExecutionTier.LocalHost,
      owner: extensionKind === vscode.ExtensionKind.UI ? "ui" : "workspace",
      remoteName,
      remoteAuthority,
      extensionKind,
      parentRemote: undefined,
    };
  }

  // Tiers 2 / 4: inside a devcontainer.
  // Workspace-side bails in the activation guard; if we're here and running,
  // we're UI-side (on the parent host, which has Docker for local; for the
  // SSH case the parent is the SSH host reached via the State-4 relay).
  if (isDevcontainerName(remoteName)) {
    const parentRemote = devcontainerParent(remoteAuthority);
    return {
      tier:
        parentRemote === "ssh-remote"
          ? ExecutionTier.RemoteSSHDevContainer
          : ExecutionTier.LocalDevContainer,
      owner: "ui",
      remoteName,
      remoteAuthority,
      extensionKind,
      parentRemote,
    };
  }

  // Unsupported remotes (wsl, codespaces, tunnel).
  if (UNSUPPORTED_REMOTES.has(remoteName)) {
    return {
      tier: ExecutionTier.UnknownRemote,
      owner: "none",
      remoteName,
      remoteAuthority,
      extensionKind,
      parentRemote: undefined,
    };
  }

  // Tier 3: SSH-class remote (ssh-remote and variants across forks).
  // Workspace-side (on the remote host) owns lifecycle.
  // UI-side here means VS Code didn't start the workspace extension - broken,
  // the UI host can't reach Docker. Owner is "none" to signal this.
  return {
    tier: ExecutionTier.RemoteSSH,
    owner:
      extensionKind === vscode.ExtensionKind.Workspace ? "workspace" : "none",
    remoteName,
    remoteAuthority,
    extensionKind,
    parentRemote: undefined,
  };
}

// Cached extension kind
//
// extensionKind is only available at activation (via context.extension).
// Cache it once; detectTier() re-reads remoteName fresh each call so tests
// that mutate vscode.env.remoteName work naturally.

let _cachedExtensionKind: vscode.ExtensionKind | undefined;

/** Cache the extension kind. Called once at the start of activation. */
export function initTier(
  extensionKind: vscode.ExtensionKind | undefined,
): DetectedTier {
  _cachedExtensionKind = extensionKind;
  return detectTier(extensionKind);
}

/**
 * Get the detected tier, using the cached extension kind and the current
 * remoteName. Re-reads remoteName each call - safe to mutate in tests.
 */
export function getTier(): DetectedTier {
  return detectTier(_cachedExtensionKind);
}

/**
 * True when this extension host is trapped inside a devcontainer without Docker.
 *
 * This is the narrow "workspace-side, inside a container, no Docker" case
 * that the activation guard bails on. Used defensively by Host.create() to
 * build a managed (throw-on-exec) host if activation somehow reached it.
 *
 * UI-side in a devcontainer window returns false - it runs on the parent
 * host where Docker lives, so it can drive lifecycle.
 *
 * For the broader "is this window a devcontainer window?" predicate used by
 * command guards, sidebar, and detector, use isInDevContainerWindow().
 */
export function isInDevContainer(): boolean {
  const t = getTier();
  return (
    isDevContainerTier(t.tier) &&
    t.extensionKind === vscode.ExtensionKind.Workspace
  );
}

/** True when the current window is an attached-container window (not our managed container). */
export function isAttachedContainerWindow(): boolean {
  const remoteName = vscode.env.remoteName;
  return !!remoteName && remoteName.startsWith("attached-container");
}

/**
 * True when this window is a devcontainer window (remoteName is a
 * devcontainer/attached-container authority), regardless of which side
 * (workspace or UI) this extension host is.
 *
 * This is the predicate command guards, sidebar visibility, and the
 * devcontainer detector care about: "am I in a devcontainer window?"
 * Under extensionKind ["workspace","ui"], the workspace-side host inside
 * a devcontainer bails at activation, so this is effectively only true on
 * the UI-side - which runs on the parent host and should show managed UI
 * ("Reopen in Host" instead of "Rebuild Container", no config watcher, etc).
 */
export function isInDevContainerWindow(): boolean {
  return isDevContainerTier(getTier().tier);
}

/**
 * True when this extension host can drive Docker (owns container lifecycle).
 *
 * True for:
 *   - LocalHost (workspace-side, local Docker)
 *   - RemoteSSH (workspace-side, Docker on the SSH host)
 *   - LocalDevContainer / RemoteSSHDevContainer when UI-side (parent host has Docker)
 *
 * False for:
 *   - Workspace-side inside a devcontainer (trapped, no Docker)
 *   - Unsupported remotes (wsl/codespaces/tunnel)
 */
export function canDriveDocker(): boolean {
  const t = getTier();
  return t.owner === "workspace" || t.owner === "ui";
}
