/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
  return { EventEmitter: MockEventEmitter };
});

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(true),
  mkdirSync: vi.fn(),
  appendFileSync: vi.fn(),
}));

import {
  LogOutputTerminal,
  LogLevel,
} from "../../src/workflows/logOutputTerminal";

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
    it("buffers writes and flushes on open", () => {
      const closed = new LogOutputTerminal();
      const listener = vi.fn();
      closed.onDidWrite(listener);
      closed.write("buffered");
      expect(listener).not.toHaveBeenCalled();
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

  describe("raw", () => {
    it("writes without converting line endings", () => {
      const listener = vi.fn();
      terminal.onDidWrite(listener);
      terminal.raw("binary\ndata");
      expect(listener.mock.calls[0][0]).toContain("binary");
      expect(listener.mock.calls[0][0]).toContain("data");
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

  describe("done", () => {
    it("writes the press-any-key message", () => {
      const listener = vi.fn();
      terminal.onDidWrite(listener);
      terminal.done();
      expect(listener.mock.calls[0][0]).toContain("Press any key");
    });
  });

  describe("end", () => {
    it("fires the close emitter with exit code", () => {
      const listener = vi.fn();
      terminal.onDidClose(listener);
      terminal.end(42);
      expect(listener).toHaveBeenCalledWith(42);
    });
  });

  describe("dispose", () => {
    it("does not throw when called", () => {
      expect(() => terminal.dispose()).not.toThrow();
    });
  });

  describe("log level filtering", () => {
    it("info writes when log level is Info", () => {
      const listener = vi.fn();
      terminal.onDidWrite(listener);
      terminal.setLogLevel(LogLevel.Info);
      terminal.info("message");
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0][0]).toContain("[INFO]");
      expect(listener.mock.calls[0][0]).toContain("message");
    });

    it("debug does NOT write when log level is Info", () => {
      const listener = vi.fn();
      terminal.onDidWrite(listener);
      terminal.setLogLevel(LogLevel.Info);
      terminal.debug("message");
      expect(listener).not.toHaveBeenCalled();
    });

    it("debug writes when log level is Debug", () => {
      const listener = vi.fn();
      terminal.onDidWrite(listener);
      terminal.setLogLevel(LogLevel.Debug);
      terminal.debug("message");
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0][0]).toContain("[DEBUG]");
      expect(listener.mock.calls[0][0]).toContain("message");
    });

    it("trace writes when log level is Trace", () => {
      const listener = vi.fn();
      terminal.onDidWrite(listener);
      terminal.setLogLevel(LogLevel.Trace);
      terminal.trace("message");
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0][0]).toContain("[TRACE]");
      expect(listener.mock.calls[0][0]).toContain("message");
    });

    it("trace does NOT write when log level is Debug", () => {
      const listener = vi.fn();
      terminal.onDidWrite(listener);
      terminal.setLogLevel(LogLevel.Debug);
      terminal.trace("message");
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("error and warn", () => {
    it("error always writes regardless of log level", () => {
      const listener = vi.fn();
      terminal.onDidWrite(listener);
      terminal.setLogLevel(LogLevel.Info);
      terminal.error("fail");
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0][0]).toContain("[ERROR]");
      expect(listener.mock.calls[0][0]).toContain("fail");
    });

    it("warn writes at Info level", () => {
      const listener = vi.fn();
      terminal.onDidWrite(listener);
      terminal.setLogLevel(LogLevel.Info);
      terminal.warn("caution");
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0][0]).toContain("[WARN]");
      expect(listener.mock.calls[0][0]).toContain("caution");
    });
  });
});