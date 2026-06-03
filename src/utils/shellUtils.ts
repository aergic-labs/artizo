/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Shell argument escaping for sh -c commands.
 *
 * Use escapeShellArg() for any user-controlled or variable input
 * interpolated into sh -c command strings. Prefer argv-based
 * dockerExec calls where possible. They bypass shell interpretation
 * entirely.
 */

/**
 * Escape a value for safe interpolation into a single-quoted string
 * inside a sh -c command. Handles the only character that can break
 * out of single quotes: a literal single quote itself.
 *
 * Example:
 *   escapeShellArg("it's working") → 'it'\''s working'
 */
export function escapeShellArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}