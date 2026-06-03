/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * CLI Output Parser for devcontainer CLI JSON log lines.
 *
 * Parses `--log-format json` output into structured events
 * and formats them for human-readable terminal display.
 *
 * Bug Condition: Raw JSON lines must never be dumped to terminal or
 * interpreted as shell commands. They are parsed into structured events
 * and formatted for display.
 *
 * Preservation: Final JSON line with outcome:"success" is still parsed
 * for container metadata (containerId, remoteUser, remoteWorkspaceFolder).
 */

/**
 * Structured event types from devcontainer CLI JSON output.
 */
export type CliOutputEvent =
  | { type: "text"; level: number; timestamp: number; text: string }
  | { type: "raw"; level: number; timestamp: number; text: string }
  | { type: "start"; level: number; timestamp: number; text: string }
  | {
      type: "stop";
      level: number;
      timestamp: number;
      text: string;
      startTimestamp: number;
    }
  | { type: "progress"; level: number; timestamp: number; text: string };

const KNOWN_TYPES = new Set(["text", "raw", "start", "stop", "progress"]);

/**
 * Parse a single line of CLI output into a structured event.
 *
 * - Valid JSON with a recognized type field → typed CliOutputEvent
 * - Valid JSON without a recognized type → 'raw' event (preserves JSON text for metadata extraction)
 * - Non-JSON text → 'raw' event with the original text
 * - Empty/whitespace-only lines → null
 *
 * This ensures JSON lines are never passed raw to a shell or terminal.sendText().
 */
export function parseCliOutputLine(line: string): CliOutputEvent | null {
  const trimmed = line.trim();
  if (trimmed === "") {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed);

    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.type === "string" &&
      KNOWN_TYPES.has(parsed.type)
    ) {
      const level = typeof parsed.level === "number" ? parsed.level : 0;
      const timestamp =
        typeof parsed.timestamp === "number" ? parsed.timestamp : Date.now();
      const text = typeof parsed.text === "string" ? parsed.text : "";

      if (parsed.type === "stop") {
        return {
          type: "stop",
          level,
          timestamp,
          text,
          startTimestamp:
            typeof parsed.startTimestamp === "number"
              ? parsed.startTimestamp
              : 0,
        };
      }

      return { type: parsed.type, level, timestamp, text } as CliOutputEvent;
    }

    // Valid JSON but no recognized type field: return as raw event.
    // This covers the final outcome JSON line which can still be parsed
    // by the caller for container metadata (containerId, remoteUser, etc.)
    return { type: "raw", level: 0, timestamp: Date.now(), text: trimmed };
  } catch {
    // Not valid JSON; return as raw event (never interpret as shell command)
    return { type: "raw", level: 0, timestamp: Date.now(), text: trimmed };
  }
}

/**
 * Format a CLI output event for human-readable terminal display.
 * Uses \r\n line endings for pseudo-terminal compatibility.
 */
export function formatEventForTerminal(event: CliOutputEvent): string {
  switch (event.type) {
    case "text":
      return `${event.text}\r\n`;
    case "raw":
      return `${event.text}\r\n`;
    case "start":
      return `▶ ${event.text}\r\n`;
    case "stop": {
      const elapsedMs = event.timestamp - event.startTimestamp;
      const elapsedSec = (elapsedMs / 1000).toFixed(1);
      return `✓ ${event.text} (${elapsedSec}s)\r\n`;
    }
    case "progress":
      return `… ${event.text}\r\n`;
  }
}