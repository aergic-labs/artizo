/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";

/** Log levels matching the official extension. */
export enum LogLevel {
  Info = 0,
  Debug = 1,
  Trace = 2,
}

/**
 * ANSI escape codes for terminal formatting.
 */
const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

/**
 * A pseudo-terminal that writes text directly to the terminal buffer
 * without shell interpretation. Uses Pseudoterminal (no OutputChannel),
 * file-based log persistence, ANSI color support, session timestamps,
 * and log level filtering.
 */
export class LogOutputTerminal implements vscode.Pseudoterminal {
  private writeEmitter = new vscode.EventEmitter<string>();
  private closeEmitter = new vscode.EventEmitter<number | void>();
  private inputEmitter = new vscode.EventEmitter<string>();
  private opened = false;
  private buffer: string[] = [];
  private logPath: string;
  private sessionStart: Date;
  private logLevel: LogLevel = LogLevel.Info;

  /** Bounded recent-output ring buffer (chars), for diagnose-on-failure. */
  private recent = "";
  private static readonly RECENT_MAX = 64 * 1024;

  onDidWrite = this.writeEmitter.event;
  onDidClose = this.closeEmitter.event;
  onDidInput = this.inputEmitter.event;
  /** Called when the user presses a key. Used for "press any key to close" */
  onDidInputRaw = this.inputEmitter.event;

  constructor(logPath?: string) {
    this.sessionStart = new Date();
    this.logPath =
      logPath ||
      path.join(
        require("node:os").tmpdir(),
        `artizo-${this.sessionStart.toISOString().replace(/[:.]/g, "-")}.log`,
      );
  }

  setLogLevel(level: LogLevel): void {
    this.logLevel = level;
  }

  /**
   * Recent log output (bounded tail), with ANSI codes and CRLF stripped —
   * suitable for handing to an AI for diagnosis. `maxChars` further trims the
   * returned tail (the prompt doesn't need the full 64KB).
   */
  getRecentText(maxChars = 16 * 1024): string {
    const clean = this.recent
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;]*m/g, "")
      .replace(/\r\n/g, "\n");
    return clean.slice(-maxChars);
  }

  /** Absolute path to the full on-disk log file (whole session). */
  getLogPath(): string {
    return this.logPath;
  }

  open(): void {
    this.opened = true;
    // Flush buffered writes
    for (const text of this.buffer) {
      this.writeEmitter.fire(text);
    }
    this.buffer = [];
  }

  close(): void {
    // No-op. Cleanup handled by dispose
  }

  handleInput(data: string): void {
    this.inputEmitter.fire(data);
  }

  write(text: string): void {
    const formatted = text.replace(/\r?\n/g, "\r\n");
    this.appendToLogFile(formatted);
    if (this.opened) {
      this.writeEmitter.fire(formatted);
    } else {
      this.buffer.push(formatted);
    }
  }

  writeLine(text: string): void {
    this.write(text + "\n");
  }

  // Bypasses \r\n conversion for binary/ANSI output.
  raw(text: string): void {
    this.appendToLogFile(text);
    if (this.opened) {
      this.writeEmitter.fire(text);
    } else {
      this.buffer.push(text);
    }
  }

  // ---- Log level methods ----

  info(message: string): void {
    if (this.logLevel >= LogLevel.Info) {
      const ts = this.timestamp();
      this.writeLine(
        `${ANSI.gray}[${ts}]${ANSI.reset} ${ANSI.cyan}[INFO]${ANSI.reset} ${message}`,
      );
    }
  }

  debug(message: string): void {
    if (this.logLevel >= LogLevel.Debug) {
      const ts = this.timestamp();
      this.writeLine(
        `${ANSI.gray}[${ts}]${ANSI.reset} ${ANSI.green}[DEBUG]${ANSI.reset} ${message}`,
      );
    }
  }

  trace(message: string): void {
    if (this.logLevel >= LogLevel.Trace) {
      const ts = this.timestamp();
      this.writeLine(
        `${ANSI.gray}[${ts}]${ANSI.reset} ${ANSI.dim}[TRACE]${ANSI.reset} ${message}`,
      );
    }
  }

  error(message: string): void {
    const ts = this.timestamp();
    this.writeLine(
      `${ANSI.gray}[${ts}]${ANSI.reset} ${ANSI.red}[ERROR]${ANSI.reset} ${message}`,
    );
  }

  warn(message: string): void {
    if (this.logLevel >= LogLevel.Info) {
      const ts = this.timestamp();
      this.writeLine(
        `${ANSI.gray}[${ts}]${ANSI.reset} ${ANSI.yellow}[WARN]${ANSI.reset} ${message}`,
      );
    }
  }

  done(): void {
    this.raw(
      `\r\n${ANSI.bold}Done. Press any key to close the terminal.${ANSI.reset}\r\n`,
    );
  }

  end(exitCode?: number): void {
    this.closeEmitter.fire(exitCode);
  }

  dispose(): void {
    this.writeEmitter.dispose();
    this.closeEmitter.dispose();
    this.inputEmitter.dispose();
    try {
      require("node:fs").unlinkSync(this.logPath);
    } catch {}
  }

  // ---- Private helpers ----

  private timestamp(): string {
    return new Date().toISOString().slice(11, 19);
  }

  private _logFileFailed = false;

  private appendToLogFile(text: string): void {
    // Keep a bounded tail of recent output for diagnose-on-failure.
    this.recent = (this.recent + text).slice(-LogOutputTerminal.RECENT_MAX);

    if (this._logFileFailed) return;
    try {
      const dir = path.dirname(this.logPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.appendFileSync(this.logPath, text);
    } catch (err: unknown) {
      this._logFileFailed = true;
      // Warn once on the terminal that file logging is broken
      const msg = err instanceof Error ? err.message : String(err);
      this.write(
        `\r\n${ANSI.yellow}[WARN] Cannot write log file: ${msg}${ANSI.reset}\r\n`,
      );
    }
  }
}