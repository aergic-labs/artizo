/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock vscode module (logger.ts uses vscode.LogOutputChannel only as a type,
// which is erased at runtime, so a minimal mock suffices).
vi.mock("vscode", () => ({}));

import {
  Logger,
  LogLevel,
  initLogger,
  getLogger,
} from "../../src/utils/logger";

// Channel-shaped mock matching vscode.LogOutputChannel's log methods.
function createMockChannel() {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    append: vi.fn(),
    appendLine: vi.fn(),
    show: vi.fn(),
    dispose: vi.fn(),
  };
}

describe("Logger", () => {
  let mockChannel: ReturnType<typeof createMockChannel>;
  let logger: Logger;

  beforeEach(() => {
    mockChannel = createMockChannel();
    logger = new Logger(mockChannel as any);
  });

  describe("log levels", () => {
    it("calls channel.info for info messages", () => {
      logger.info("test message");
      expect(mockChannel.info).toHaveBeenCalledWith("test message");
    });

    it("calls channel.warn for warn messages", () => {
      logger.warn("test warning");
      expect(mockChannel.warn).toHaveBeenCalledWith("test warning");
    });

    it("calls channel.error for error messages", () => {
      logger.error("test error");
      expect(mockChannel.error).toHaveBeenCalled();
      expect(mockChannel.error.mock.calls[0][0]).toContain("test error");
    });

    it("appends Error message to error log", () => {
      const err = new Error("boom");
      logger.error("something failed", err);
      expect(mockChannel.error).toHaveBeenCalled();
      expect(mockChannel.error.mock.calls[0][0]).toContain("boom");
    });

    it("appends string context to error log", () => {
      logger.error("failed", "connection refused");
      expect(mockChannel.error).toHaveBeenCalled();
      expect(mockChannel.error.mock.calls[0][0]).toContain(
        "connection refused",
      );
    });
  });

  describe("debug/trace gating by level", () => {
    it("suppresses debug at the default Info level", () => {
      logger.debug("dbg");
      expect(mockChannel.debug).not.toHaveBeenCalled();
    });

    it("emits debug once level is Debug", () => {
      logger.setLevel(LogLevel.Debug);
      logger.debug("dbg");
      expect(mockChannel.debug).toHaveBeenCalledWith("dbg");
    });

    it("suppresses trace below Trace level", () => {
      logger.setLevel(LogLevel.Debug);
      logger.trace("trc");
      expect(mockChannel.trace).not.toHaveBeenCalled();
    });

    it("emits trace once level is Trace", () => {
      logger.setLevel(LogLevel.Trace);
      logger.trace("trc");
      expect(mockChannel.trace).toHaveBeenCalledWith("trc");
    });
  });

  describe("show", () => {
    it("reveals the channel", () => {
      logger.show();
      expect(mockChannel.show).toHaveBeenCalled();
    });
  });

  describe("append", () => {
    it("writes raw text to the channel with no level prefix", () => {
      logger.append("#5 building...\n");
      expect(mockChannel.append).toHaveBeenCalledWith("#5 building...\n");
      // Raw append must not go through the leveled log methods.
      expect(mockChannel.info).not.toHaveBeenCalled();
    });
  });
});

describe("initLogger / getLogger", () => {
  it("returns a no-op logger before initLogger", () => {
    vi.resetModules();
    const log = getLogger();
    expect(log).toBeDefined();
    // No-op methods should not throw
    expect(() => log.info("test")).not.toThrow();
    expect(() => log.error("test")).not.toThrow();
  });

  it("returns the logger after initLogger", () => {
    const channel = createMockChannel();
    const log = initLogger(channel as any);
    expect(log).toBeInstanceOf(Logger);
    expect(getLogger()).toBe(log);
  });
});
