/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Diagnostic logger. Routes all output through a vscode LogOutputChannel
 * (the "Output" panel), which is the authoritative, always-available sink -
 * no pseudo-terminal, no renderer-attach guessing, works during early
 * activation and the remote side-load bootstrap. Docker build output is
 * mirrored to a pty terminal separately (see logOutputTerminal.ts).
 */

import * as vscode from "vscode";

/** Log levels matching the official extension. */
export enum LogLevel {
  Info = 0,
  Debug = 1,
  Trace = 2,
}

export class Logger {
  private channel: vscode.LogOutputChannel;
  /** Gates debug/trace per the `artizo.logLevel` setting. */
  private level: LogLevel = LogLevel.Info;

  constructor(channel: vscode.LogOutputChannel) {
    this.channel = channel;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  debug(message: string): void {
    if (this.level >= LogLevel.Debug) {
      this.channel.debug(message);
    }
  }

  trace(message: string): void {
    if (this.level >= LogLevel.Trace) {
      this.channel.trace(message);
    }
  }

  info(message: string): void {
    this.channel.info(message);
  }

  warn(message: string): void {
    this.channel.warn(message);
  }

  error(message: string, errorOrContext?: Error | string): void {
    let formatted = message;
    if (errorOrContext instanceof Error) {
      formatted += ` ${errorOrContext.message}`;
    } else if (typeof errorOrContext === "string") {
      formatted += ` ${errorOrContext}`;
    }
    this.channel.error(formatted);
  }

  show(): void {
    this.channel.show();
  }

  /**
   * Append raw text to the channel with no timestamp/level prefix. Used for
   * docker build output, which must read like a build log, not a decorated
   * app log. Each call should include its own trailing newline.
   */
  append(text: string): void {
    this.channel.append(text);
  }
}

let globalLogger: Logger | undefined;

/** Initialize the global logger. Call once during extension activation. */
export function initLogger(channel: vscode.LogOutputChannel): Logger {
  globalLogger = new Logger(channel);
  return globalLogger;
}

/** Get the global logger instance. */
export function getLogger(): Logger {
  if (!globalLogger) {
    // Return a no-op logger before initLogger() is called - useful for
    // early-activation checks like validatePlatformRuntime that run first.
    return {
      info() {},
      warn() {},
      error() {},
      debug() {},
      trace() {},
      setLevel() {},
      show() {},
      append() {},
    } as unknown as Logger;
  }
  return globalLogger;
}
