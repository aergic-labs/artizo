/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Error thrown when a container build/provision (`launch()` / the CLI `up`)
 * fails - image build, feature install, or compose up. Carries the path to the
 * devcontainer.json so the failure reporter can offer "Diagnose with AI" with
 * the right config in hand. Caught once at the command layer; workflows let it
 * propagate rather than showing their own toast.
 *
 * Lifecycle-command failures are a separate, non-fatal surface (see
 * plans/diagnose-lifecycle-failures.md) and do NOT use this error.
 */
export class ProvisionFailedError extends Error {
  readonly configPath: string | undefined;
  readonly originalError: unknown;

  constructor(message: string, configPath?: string, originalError?: unknown) {
    super(message);
    this.name = "ProvisionFailedError";
    this.configPath = configPath;
    this.originalError = originalError;
    // commandRunner writes `error.stack` to the build log TTY and file. Keep
    // the stack from the real failure instead of the throw site here.
    const stack = (originalError as { stack?: string } | undefined)?.stack;
    if (stack) {
      this.stack = stack;
    }
  }
}
