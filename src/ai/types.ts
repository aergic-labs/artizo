/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Vendor-agnostic AI chat abstraction.
 *
 * Each supported IDE provides an implementation in its own module
 * (ai/<vendor>.ts), selected at build time by ai/index.ts via dynamic import
 * gated by HAS_*_ADAPTER. esbuild dead-code-eliminates the unused branches, so
 * a vendor's command strings never ship in another vendor's VSIX.
 *
 * The interface is intentionally generic ("submit a prompt") and carries no
 * devcontainer-specific concepts, so any feature can reuse it. Prompt-building
 * lives at the call site, not here.
 */

export interface AiSubmitOptions {
  /** Workspace-relative file paths to attach as context, when supported. */
  files?: string[];
  /** A short title for the interaction, when supported. */
  title?: string;
}

export interface AiAssist {
  /**
   * Whether AI assist can be offered in the current runtime. Async so a future
   * generic (vscodium) implementation can probe at runtime whether any AI chat
   * is actually enabled. Vendor builds with a known chat command return true.
   */
  isAvailable(): Promise<boolean>;

  /**
   * Open the platform's AI chat and submit the prompt as a user message.
   * Resolves once dispatched; throws if the platform command is unavailable.
   */
  submit(prompt: string, opts?: AiSubmitOptions): Promise<void>;

  /**
   * Optional progress capability. When present, the caller may poll for
   * pending agent questions after submitting (interactive agents only).
   * Returns the number of questions awaiting a user response.
   *
   * Implemented only by platforms with an observable agent (Kiro). Its absence
   * is the signal that progress cannot be tracked - no capability boolean needed.
   */
  pollPendingQuestions?(): Promise<number>;
}
