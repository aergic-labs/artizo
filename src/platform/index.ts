/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Platform adapter factory.
 *
 * One unified `VSCodiumAdapter` handles every supported fork (VSCodium,
 * code-oss, VSCode-OSS, Trae, Devin, Antigravity, Qoder, Kiro, Bob),
 * selected at runtime via `product.json` `applicationName`. The adapter
 * is bundled in every VSIX; detection happens at first call and the
 * result is cached. VSCodium is the catch-all fallback so the extension
 * always works on unrecognized IDEs (best-effort defaults).
 *
 * `detectPlatformName()` returns the AI-assist axis (decoupled from the
 * adapter so AI assist can select without instantiating the adapter).
 */

import * as vscode from "vscode";
import * as path from "node:path";
import { readFileSync } from "node:fs";
import type { IPlatformAdapter } from "./types";

let _adapter: IPlatformAdapter | undefined;

/** @internal Test-only reset of the cached adapter. */
export function _resetForTest(): void {
  _adapter = undefined;
}

/**
 * Read `product.json` from the running IDE's appRoot synchronously.
 * Used by the unified adapter for fork detection and per-fork field
 * overrides. Throws if product.json is missing or unparseable.
 */
export function readProductJson(): Record<string, unknown> {
  const productPath = path.join(vscode.env.appRoot, "product.json");
  return JSON.parse(readFileSync(productPath, "utf-8"));
}

/** IDE names returned by detectPlatformName(). */
export type PlatformName =
  | "Devin"
  | "Trae"
  | "Kiro"
  | "Antigravity"
  | "Qoder"
  | "Bob"
  | "VSCodium";

/**
 * Read `product.json` `applicationName` from the running IDE and match
 * it against known fork identifiers. Returns VSCodium for unrecognized
 * IDEs (the catch-all fallback per the runtime detection plan).
 */
export function detectPlatformName(): PlatformName {
  try {
    const productPath = path.join(vscode.env.appRoot, "product.json");
    const product = JSON.parse(readFileSync(productPath, "utf-8"));
    const appName: string = (product?.applicationName ?? "").toLowerCase();
    if (appName.includes("devin") || appName.includes("windsurf")) {
      return "Devin";
    }
    if (appName.includes("trae") || appName.includes("byte")) {
      return "Trae";
    }
    if (appName.includes("kiro")) {
      return "Kiro";
    }
    if (appName.includes("antigravity")) {
      return "Antigravity";
    }
    if (appName.includes("qoder")) {
      return "Qoder";
    }
    if (appName.includes("bob")) {
      return "Bob";
    }
  } catch {
    // product.json unreadable - fall through to VSCodium.
  }
  return "VSCodium";
}

/**
 * Returns the platform adapter for the running IDE. Detected at runtime
 * via `product.json`; cached after first call. Single unified adapter -
 * fork selection happens inside the adapter.
 */
export async function getPlatformAdapter(): Promise<IPlatformAdapter> {
  if (!_adapter) {
    const { VSCodiumAdapter } = await import("./vscodium.js");
    _adapter = new VSCodiumAdapter();
  }
  return _adapter!;
}

export type { IPlatformAdapter } from "./types";
