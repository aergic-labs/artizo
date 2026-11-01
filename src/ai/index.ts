/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * AI assist factory.
 *
 * Selects the correct AiAssist implementation at runtime via
 * `detectPlatformName()` (which reads `product.json` `applicationName`).
 * All modules are bundled in every VSIX; the factory picks one at first
 * call and caches it. Mirrors platform/index.ts - same detection order,
 * same VSCodium fallback. Antigravity and Qoder fall through to
 * GenericAiAssist (no vendor AI chat command).
 */

import { detectPlatformName } from "../platform/index.js";
import type { AiAssist } from "./types";

let _ai: AiAssist | undefined;

/** @internal Test-only reset of the cached AI assist. */
export function _resetForTest(): void {
  _ai = undefined;
}

/**
 * Returns the AI assist implementation for the running IDE. Detected at
 * runtime via `product.json`; cached after first call. GenericAiAssist
 * is the VSCodium/fallback for unrecognized IDEs (probes for Cline/Roo
 * Code/Zoo Code at runtime).
 */
export async function getAiAssist(): Promise<AiAssist> {
  if (!_ai) {
    const platform = detectPlatformName();
    if (platform === "Kiro") {
      const { KiroAiAssist } = await import("./kiro.js");
      _ai = new KiroAiAssist();
    } else if (platform === "Trae") {
      const { TraeAiAssist } = await import("./trae.js");
      _ai = new TraeAiAssist();
    } else if (platform === "Devin") {
      const { DevinAiAssist } = await import("./devin.js");
      _ai = new DevinAiAssist();
    } else if (platform === "Bob") {
      const { BobAiAssist } = await import("./bob.js");
      _ai = new BobAiAssist();
    } else {
      // VSCodium, Antigravity, Qoder, and unrecognized IDEs - generic
      // assist probes for Cline/Roo Code/Zoo Code extensions at runtime.
      const { GenericAiAssist } = await import("./generic.js");
      _ai = new GenericAiAssist();
    }
  }
  return _ai!;
}

export type { AiAssist } from "./types";
