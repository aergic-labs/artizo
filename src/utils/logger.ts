/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Logger that routes all output through the LogOutputTerminal Pseudoterminal.
 * No more OutputChannel, matches the official extension's approach.
 */

import { LogLevel } from "../workflows/logOutputTerminal";
import type { LogOutputTerminal } from "../workflows/logOutputTerminal";

export { LogLevel };

export class Logger {
  private terminal: LogOutputTerminal;

  constructor(terminal: LogOutputTerminal) {
    this.terminal = terminal;
  }

  setLevel(level: LogLevel): void {
    this.terminal.setLogLevel(level);
  }

  debug(message: string): void {
    this.terminal.debug(message);
  }

  info(message: string): void {
    this.terminal.info(message);
  }

  warn(message: string): void {
    this.terminal.warn(message);
  }

  error(message: string, errorOrContext?: Error | string): void {
    let formatted = message;
    if (errorOrContext instanceof Error) {
      formatted += ` ${errorOrContext.message}`;
    } else if (typeof errorOrContext === "string") {
      formatted += ` ${errorOrContext}`;
    }
    this.terminal.error(formatted);
  }

  show(): void {
    // Terminal is shown via the registered command
  }
}

let globalLogger: Logger | undefined;

/**
 * Initialize the global logger. Call once during extension activation.
 */
export function initLogger(terminal: LogOutputTerminal): Logger {
  globalLogger = new Logger(terminal);
  return globalLogger;
}

/**
 * Get the global logger instance.
 */
export function getLogger(): Logger {
  if (!globalLogger) {
    throw new Error("Logger not initialized. Call initLogger() first.");
  }
  return globalLogger;
}