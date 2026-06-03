/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Extension classification based on extensionKind declarations.
 *
 * Every VS Code extension declares extensionKind in its package.json:
 * - ["ui"] → runs locally only (themes, keybindings)
 * - ["workspace"] → runs in the container (language servers, linters)
 * - ["ui", "workspace"] → can run in either; prefer local
 * - No declaration → defaults to ["workspace"] (runs in container)
 */

/**
 * - 'local': runs on the host (UI extensions like themes)
 * - 'remote': runs in the container (workspace extensions like language servers)
 * - 'both': can run in either location
 */
export type ExtensionLocation = "local" | "remote" | "both";

export function classifyExtension(extensionKind?: string[]): ExtensionLocation {
  if (!extensionKind || extensionKind.length === 0) return "remote";
  if (extensionKind.includes("ui") && extensionKind.includes("workspace"))
    return "both";
  if (extensionKind.includes("ui")) return "local";
  return "remote";
}

// Supports both customizations.vscode.extensions and legacy extensions.
export function extractExtensionIds(config: Record<string, unknown>): string[] {
  // Check current format: customizations.vscode.extensions
  const customizations = config.customizations as
    | Record<string, unknown>
    | undefined;
  if (customizations) {
    const vscode = customizations.vscode as Record<string, unknown> | undefined;
    if (vscode && Array.isArray(vscode.extensions)) {
      return vscode.extensions.filter(
        (ext): ext is string => typeof ext === "string",
      );
    }
  }

  // Check legacy format: extensions
  if (Array.isArray(config.extensions)) {
    return config.extensions.filter(
      (ext): ext is string => typeof ext === "string",
    );
  }

  return [];
}