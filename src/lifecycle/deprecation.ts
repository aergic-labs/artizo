/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Deprecation notice for the trae and devin Artizo VSIX builds.
 *
 * The trae and devin builds are no longer updated. When one is installed,
 * we surface a toast and an unremovable sidebar banner telling the user to
 * install the supported build for the IDE they are actually running (Kiro
 * IDE -> aergic.artizo-kiro; anything else -> aergic.artizo-vscodium).
 *
 * Two detections, kept strictly separate:
 *
 *  1. Who gets the notice = the installed VSIX identity. We read
 *     `context.extension.id` at activate. This is NOT runtime IDE sniffing;
 *     a trae VSIX running inside Kiro still qualifies.
 *  2. What to install = the running IDE. We reuse `detectPlatformName()` so
 *     a trae VSIX inside Kiro recommends the kiro build, not vscodium.
 *
 * If a supported build (kiro OR vscodium) is already installed alongside the
 * deprecated one, the deprecated build registers nothing and points the user
 * at "uninstall this one". This avoids view/command/resolver conflicts between
 * the two co-installed Artizo builds.
 */

import * as vscode from "vscode";
import { detectPlatformName, type PlatformName } from "../platform/index.js";

/** VSIX ids of the deprecated builds (no further updates). */
const DEPRECATED_BUILD_IDS = new Set<string>([
  "aergic.artizo-trae",
  "aergic.artizo-devin",
]);

/** VSIX ids of the supported builds (still maintained). */
const SUPPORTED_BUILD_IDS = new Set<string>([
  "aergic.artizo-kiro",
  "aergic.artizo-vscodium",
]);

/** Per-build globalState key for "toast dismissed". */
function dismissKey(extensionId: string): string {
  return `artizo.deprecation.dismissed.${extensionId}`;
}

/**
 * Pick the supported build to recommend for the running IDE.
 *
 * Kiro -> kiro build. Anything else (VSCodium, Trae, Devin, unrecognized) ->
 * vscodium build. Per the deprecation plan: kiro people install kiro, everyone
 * else installs vscodium.
 */
export function recommendReplacementId(
  platform: PlatformName = detectPlatformName(),
): string {
  return platform === "Kiro"
    ? "aergic.artizo-kiro"
    : "aergic.artizo-vscodium";
}

/** True if either supported Artizo build is installed in this process. */
function replacementInstalled(): boolean {
  return [...SUPPORTED_BUILD_IDS].some(
    (id) => vscode.extensions.getExtension(id) !== undefined,
  );
}

/** Open the Extensions viewlet filtered to the given ids (array form). */
function showExtensionsWithIds(ids: string[]): Thenable<unknown> {
  return vscode.commands.executeCommand(
    "workbench.extensions.action.showExtensionsWithIds",
    ids,
  );
}

/** Uninstall the deprecated build by its own id, fall back to opening the viewlet. */
async function uninstallSelf(selfId: string): Promise<void> {
  try {
    await vscode.commands.executeCommand(
      "workbench.extensions.uninstallExtension",
      selfId,
    );
    const reload = await vscode.window.showInformationMessage(
      `Artizo: uninstalled ${selfId}. Reload to finish.`,
      "Reload Now",
    );
    if (reload === "Reload Now") {
      await vscode.commands.executeCommand("workbench.action.reloadWindow");
    }
  } catch {
    // Command missing or rejected (older IDEs) - fall back to the viewlet
    // filtered to the deprecated id so the user can uninstall manually.
    await showExtensionsWithIds([selfId]);
  }
}

/** Result of showDeprecationNotice(), read by activate to decide what to register. */
export interface DeprecationState {
  /** True when the running VSIX is a deprecated build (trae or devin). */
  deprecated: boolean;
  /** True when a supported build is installed alongside the deprecated one. */
  replacementInstalled: boolean;
  /** VSIX id the user should install to replace this deprecated build. */
  recommendedReplacementId: string | null;
  /** The running VSIX id (`context.extension.id`). */
  selfId: string;
}

let _state: DeprecationState | undefined;

/** Read the latest state computed by showDeprecationNotice(). Sidebar uses this. */
export function getDeprecationState(): DeprecationState | undefined {
  return _state;
}

/**
 * Show the deprecation toast (and record state for the sidebar banner).
 *
 * Returns the state so `activate()` can decide whether to register views and
 * commands. When `deprecated && replacementInstalled`, the caller MUST NOT
 * register anything - the supported build already owns those identifiers.
 *
 * Side effects:
 *  - Sets `artizo.deprecated:hasReplacement` / `artizo.deprecated:noReplacement`
 *    context keys so the sidebar can render the right banner variant.
 *  - One toast per session for the "install replacement" branch (gated on a
 *    per-machine globalState dismiss flag). The "uninstall this one" branch
 *    is shown every activate since it's the only path out of the conflict.
 *
 * Does NOT block activation on the toast. The toast Thenable doesn't resolve
 * until the user clicks a button (or dismisses), so awaiting it would park
 * activate() with no log, no hostContext, no icon, no sidebar. Fire-and-forget
 * the toast; handle the click in .then().
 */
export async function showDeprecationNotice(
  context: vscode.ExtensionContext,
): Promise<DeprecationState> {
  const selfId = context.extension.id;
  const deprecated = DEPRECATED_BUILD_IDS.has(selfId);
  const replacement = replacementInstalled();
  const recommendedId = deprecated ? recommendReplacementId() : null;

  const state: DeprecationState = {
    deprecated,
    replacementInstalled: replacement,
    recommendedReplacementId: recommendedId,
    selfId,
  };
  _state = state;

  if (!deprecated) {
    // Supported build - no notice, no context keys. Normal activation.
    return state;
  }

  if (replacement) {
    // Supported Artizo is installed alongside. We will register nothing.
    // Steer the user to uninstall this deprecated one to resolve the conflict.
    await vscode.commands.executeCommand(
      "setContext",
      "artizo.deprecated:hasReplacement",
      true,
    );
    // Fire-and-forget: don't park activate() on the toast.
    void vscode.window
      .showWarningMessage(
        `Artizo: the ${selfId} build is no longer updated. A supported Artizo build is installed. Uninstall this one to avoid conflicts.`,
        "Uninstall this deprecated build",
      )
      .then((action) => {
        if (action === "Uninstall this deprecated build") {
          void uninstallSelf(selfId);
        }
      });
    return state;
  }

  // No supported build installed yet. Continue activating so the user still
  // has a working extension while they go install the replacement.
  await vscode.commands.executeCommand(
    "setContext",
    "artizo.deprecated:noReplacement",
    true,
  );

  const dismissFlagKey = dismissKey(selfId);
  if (context.globalState.get<boolean>(dismissFlagKey, false)) {
    return state;
  }

  const buildLabel = selfId === "aergic.artizo-trae" ? "trae" : "devin";
  const platform = detectPlatformName();
  const recommendLabel =
    platform === "Kiro" ? "Kiro Artizo" : "VSCodium Artizo";
  // Fire-and-forget: don't park activate() on the toast.
  void vscode.window
    .showWarningMessage(
      `Artizo: the ${buildLabel} build is no longer updated. Install ${recommendLabel} to keep getting updates.`,
      "Install replacement",
      "Don't show again",
    )
    .then((action) => {
      if (action === "Install replacement" && recommendedId) {
        void showExtensionsWithIds([recommendedId]);
      } else if (action === "Don't show again") {
        void context.globalState.update(dismissFlagKey, true);
      }
    });

  return state;
}
