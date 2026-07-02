/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("vscode", () => {
  class MockEventEmitter {
    private listeners: Array<(data: any) => void> = [];
    // Expose hasListeners on _eventEmitter to match the real VS Code API
    // shape that LogOutputTerminal.safeFire probes.
    _eventEmitter = {
      hasListeners: false as boolean,
    };
    event = (listener: (data: any) => void) => {
      this.listeners.push(listener);
      this._eventEmitter.hasListeners = true;
      return { dispose: () => {} };
    };
    fire(data: any) {
      for (const listener of this.listeners) {
        listener(data);
      }
    }
    dispose() {
      this.listeners = [];
      this._eventEmitter.hasListeners = false;
    }
  }
  return { EventEmitter: MockEventEmitter };
});

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(true),
  mkdirSync: vi.fn(),
  appendFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

import { LogOutputTerminal } from "../../src/workflows/logOutputTerminal";

describe("LogOutputTerminal", () => {
  let terminal: LogOutputTerminal;

  beforeEach(() => {
    terminal = new LogOutputTerminal();
    terminal.open();
  });

  afterEach(() => {
    terminal.dispose();
  });

  it("implements open() without error", () => {
    expect(() => terminal.open()).not.toThrow();
  });

  it("implements close() without error", () => {
    expect(() => terminal.close()).not.toThrow();
  });

  it("fires text to onDidWrite listeners when write() is called", () => {
    const listener = vi.fn();
    terminal.onDidWrite(listener);
    terminal.write("hello world");
    expect(listener).toHaveBeenCalledWith("hello world");
  });

  it("writes JSON lines without shell interpretation", () => {
    const listener = vi.fn();
    terminal.onDidWrite(listener);
    const jsonLine =
      '{"type":"text","level":3,"timestamp":1234567890,"text":"Building image..."}';
    terminal.write(jsonLine);
    expect(listener).toHaveBeenCalledWith(jsonLine);
  });

  it("writes text containing shell metacharacters without interpretation", () => {
    const listener = vi.fn();
    terminal.onDidWrite(listener);
    const textWithMetachars = "echo $HOME && rm -rf / | cat > /dev/null";
    terminal.write(textWithMetachars);
    expect(listener).toHaveBeenCalledWith(textWithMetachars);
  });

  it("supports multiple write calls", () => {
    const listener = vi.fn();
    terminal.onDidWrite(listener);
    terminal.write("line 1\n");
    terminal.write("line 2\n");
    terminal.write("line 3\n");
    expect(listener).toHaveBeenCalledTimes(3);
    expect(listener.mock.calls[0][0]).toContain("line 1");
    expect(listener.mock.calls[1][0]).toContain("line 2");
    expect(listener.mock.calls[2][0]).toContain("line 3");
  });

  it("supports multiple listeners", () => {
    const listener1 = vi.fn();
    const listener2 = vi.fn();
    terminal.onDidWrite(listener1);
    terminal.onDidWrite(listener2);
    terminal.write("broadcast");
    expect(listener1.mock.calls[0][0]).toContain("broadcast");
    expect(listener2.mock.calls[0][0]).toContain("broadcast");
  });

  it("writes empty string without error", () => {
    const listener = vi.fn();
    terminal.onDidWrite(listener);
    terminal.write("");
    expect(listener).toHaveBeenCalledWith("");
  });

  describe("buffer before open", () => {
    it("buffers writes when no listener attached and flushes on open", () => {
      const closed = new LogOutputTerminal();
      const listener = vi.fn();
      // Write before any listener is attached - should buffer.
      closed.write("buffered");
      expect(listener).not.toHaveBeenCalled();
      // Attach listener and open - buffered write flushes.
      closed.onDidWrite(listener);
      closed.open();
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0][0]).toContain("buffered");
    });

    it("flushes multiple buffered writes in order", () => {
      const closed = new LogOutputTerminal();
      const listener = vi.fn();
      closed.onDidWrite(listener);
      closed.write("first");
      closed.write("second");
      closed.open();
      expect(listener).toHaveBeenCalledTimes(2);
      expect(listener.mock.calls[0][0]).toContain("first");
      expect(listener.mock.calls[1][0]).toContain("second");
    });
  });

  describe("writeLine", () => {
    it("appends newline and delegates to write", () => {
      const listener = vi.fn();
      terminal.onDidWrite(listener);
      terminal.writeLine("hello");
      expect(listener.mock.calls[0][0]).toContain("hello");
    });
  });

  describe("getRecentText", () => {
    it("returns recent output with ANSI stripped", () => {
      terminal.write("\x1b[31mred\x1b[0m text\n");
      const recent = terminal.getRecentText();
      expect(recent).toContain("red text");
      expect(recent).not.toContain("\x1b[");
    });
  });

  describe("dispose", () => {
    it("does not throw when called", () => {
      expect(() => terminal.dispose()).not.toThrow();
    });
  });
});
