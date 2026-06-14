/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * AI assist factory.
 *
 * Selects the correct AiAssist implementation at build time via dynamic imports
 * gated by HAS_*_ADAPTER flags. esbuild eliminates the unused branches, so only
 * one vendor's chat module (and its command strings) ships per VSIX. This
 * mirrors platform/index.ts; keep the same dynamic-import pattern so the
 * vendor-isolation guarantee holds.
 */

import type { AiAssist } from "./types";

let _ai: AiAssist | undefined;

declare const HAS_KIRO_ADAPTER: boolean;
declare const HAS_TRAE_ADAPTER: boolean;
declare const HAS_DEVIN_ADAPTER: boolean;
declare const HAS_VSCODIUM_ADAPTER: boolean;

/**
 * Returns the AI assist implementation for the current build target.
 * Cached after first call.
 */
export async function getAiAssist(): Promise<AiAssist> {
  if (!_ai) {
    if (HAS_KIRO_ADAPTER) {
      const { KiroAiAssist } = await import("./kiro.js");
      _ai = new KiroAiAssist();
    } else if (HAS_TRAE_ADAPTER) {
      const { TraeAiAssist } = await import("./trae.js");
      _ai = new TraeAiAssist();
    } else if (HAS_DEVIN_ADAPTER) {
      const { DevinAiAssist } = await import("./devin.js");
      _ai = new DevinAiAssist();
    } else if (HAS_VSCODIUM_ADAPTER) {
      const { GenericAiAssist } = await import("./generic.js");
      _ai = new GenericAiAssist();
    } else {
      // No known AI chat for this build target.
      _ai = {
        async isAvailable() {
          return false;
        },
        async submit() {
          throw new Error("AI assist is not available on this platform.");
        },
      };
    }
  }
  return _ai!;
}

export type { AiAssist, AiSubmitOptions } from "./types";
