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
 *
 * When `artizo.fileLog` is on, every line is also appended to
 * `<state dir>/artizo.log` so logs survive an SSH window close and from
 * multiple windows appear in one tailable file.
 */

import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { stateDir } from "../common/appDirs";

/** Log levels matching the official extension. */
export enum LogLevel {
  Info = 0,
  Debug = 1,
  Trace = 2,
}

/** Log path in the platform state directory. Nothing is created here. */
function sharedLogPath(): string {
  return path.join(stateDir("artizo"), "artizo.log");
}

export class Logger {
  private channel: vscode.LogOutputChannel;
  /** Gates debug/trace per the `artizo.logLevel` setting. */
  private level: LogLevel = LogLevel.Info;
  private readonly logPath: string;
  private readonly fileLogging: boolean;
  private logDirReady = false;

  constructor(channel: vscode.LogOutputChannel) {
    this.channel = channel;
    this.logPath = sharedLogPath();
    try {
      this.fileLogging = vscode.workspace
        .getConfiguration("artizo")
        .get<boolean>("fileLog", false);
    } catch {
      // vscode.workspace may be unavailable during early activation or in
      // unit tests; default to no file logging in that case.
      this.fileLogging = false;
    }
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  /** Create the log directory on first write, never at construction. */
  private ensureLogDir(): void {
    if (this.logDirReady) return;
    this.logDirReady = true;
    try {
      fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
    } catch {
      // Best effort; the append below will fail the same way.
    }
  }

  private toFile(level: string, msg: string): void {
    if (!this.fileLogging) return;
    this.ensureLogDir();
    const line = `[${new Date().toISOString()}] [${level}] ${msg}\n`;
    try { fs.appendFileSync(this.logPath, line); } catch { /* best effort */ }
  }

  debug(message: string): void {
    if (this.level >= LogLevel.Debug) {
      this.channel.debug(message);
      this.toFile("debug", message);
    }
  }

  trace(message: string): void {
    if (this.level >= LogLevel.Trace) {
      this.channel.trace(message);
      this.toFile("trace", message);
    }
  }

  info(message: string): void {
    this.channel.info(message);
    this.toFile("info", message);
  }

  warn(message: string): void {
    this.channel.warn(message);
    this.toFile("warn", message);
  }

  error(message: string, errorOrContext?: Error | string): void {
    let formatted = message;
    if (errorOrContext instanceof Error) {
      formatted += ` ${errorOrContext.message}`;
    } else if (typeof errorOrContext === "string") {
      formatted += ` ${errorOrContext}`;
    }
    this.channel.error(formatted);
    this.toFile("error", formatted);
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
    if (this.fileLogging) {
      try { fs.appendFileSync(this.logPath, text); } catch { /* best effort */ }
    }
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
    // early-activation code paths that run before the logger is up.
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
