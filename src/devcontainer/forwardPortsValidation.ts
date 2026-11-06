/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Spec-validity check for `forwardPorts` entries.
 *
 * The devcontainer spec allows only numbers and `"host:port"` strings:
 * https://containers.dev/implementors/json_reference/#devcontainerjson
 *
 * Object entries (e.g. `{ port, label }`) are not in the spec. They were
 * once normalized by a patch to the vendored CLI's `mergeForwardPorts`,
 * which silently dropped anything it did not understand and discarded
 * labels. That patch has been reverted to keep the vendored CLI
 * upstream-faithful; this module enforces the spec at the Artizo
 * boundary so invalid entries are rejected with a clear message before
 * they can crash the vendored CLI's regex (which throws
 * `Cannot convert object to primitive value` on a non-string input).
 *
 * Labels belong in `portsAttributes`, the spec mechanism.
 */

export interface ForwardPortsIssue {
  /** The invalid entry, serialized for the message. */
  entry: unknown;
  /** Human-readable reason. */
  message: string;
}

function describe(entry: unknown): string {
  try {
    return JSON.stringify(entry);
  } catch {
    return String(entry);
  }
}

/**
 * Validate `forwardPorts` entries against the spec. Returns an issue per
 * entry that is not a number or a string. Numbers and strings pass; the
 * vendored CLI accepts both.
 */
export function validateForwardPorts(raw: unknown): ForwardPortsIssue[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    return [{ entry: raw, message: "forwardPorts must be an array" }];
  }
  const issues: ForwardPortsIssue[] = [];
  for (const entry of raw) {
    if (typeof entry === "number" || typeof entry === "string") {
      continue;
    }
    issues.push({
      entry,
      message: `forwardPorts entries must be a number or "host:port" string; got ${describe(entry)}`,
    });
  }
  return issues;
}

/**
 * Assert that `config.forwardPorts` is spec-valid. Throws a single error
 * naming every bad entry. Called before `launchProvision` so an invalid
 * config is rejected at the Artizo boundary instead of crashing the
 * vendored CLI.
 */
export function assertForwardPortsValid(
  config: unknown,
  configPath: string | null | undefined,
): void {
  const cfg = config as Record<string, unknown> | null | undefined;
  const issues = validateForwardPorts(cfg?.forwardPorts);
  if (issues.length === 0) return;
  const where = configPath ? ` in ${configPath}` : "";
  const detail = issues.map((i) => i.message).join("; ");
  throw new Error(`Invalid forwardPorts${where}: ${detail}`);
}
