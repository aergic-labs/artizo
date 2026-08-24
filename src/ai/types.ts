/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Vendor-agnostic AI chat abstraction.
 *
 * Each supported IDE provides an implementation in its own module
 * (ai/<vendor>.ts), selected at build time by ai/index.ts via dynamic import
 * gated by HAS_*_ADAPTER. esbuild keeps only the selected branch so each
 * fork's VSIX ships its own chat module.
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
   * No adapter currently implements this: Kiro's `getPendingQuestions` command
   * was removed (questions now surface in the chat session UI directly). Kept
   * on the interface for future adapters that expose an observable agent.
   */
  pollPendingQuestions?(): Promise<number>;
}
