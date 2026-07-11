/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as vscode from "vscode";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * A pseudo-terminal that renders docker build / provision output in a
 * familiar colored terminal view. It also keeps a bounded on-disk log and
 * a recent-output ring buffer for diagnose-on-failure.
 *
 * This is NOT the app logger - diagnostics go through getLogger() to an
 * OutputChannel (see utils/logger.ts). This terminal is a build-output
 * mirror only; the OutputChannel holds the authoritative record.
 */
export class LogOutputTerminal implements vscode.Pseudoterminal {
  private writeEmitter = new vscode.EventEmitter<string>();
  private closeEmitter = new vscode.EventEmitter<number | void>();
  private buffer: string[] = [];
  private opened = false;
  private logPath: string;
  private sessionStart: Date;

  /** Bounded recent-output ring buffer (chars), for diagnose-on-failure. */
  private recent = "";
  private static readonly RECENT_MAX = 64 * 1024;

  onDidWrite = this.writeEmitter.event;
  onDidClose = this.closeEmitter.event;

  constructor(logPath?: string) {
    this.sessionStart = new Date();
    this.logPath =
      logPath ||
      path.join(
        os.tmpdir(),
        `artizo-${this.sessionStart.toISOString().replace(/[:.]/g, "-")}.log`,
      );
  }

  /**
   * Recent log output (bounded tail), with ANSI codes and CRLF stripped -
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
    // The renderer has subscribed to onDidWrite by now. Flush anything
    // buffered before the terminal was shown, then stream directly.
    this.opened = true;
    for (const text of this.buffer) {
      this.writeEmitter.fire(text);
    }
    this.buffer = [];
  }

  close(): void {
    // No-op. Cleanup handled by dispose.
  }

  write(text: string): void {
    const formatted = text.replace(/\r?\n/g, "\r\n");
    this.appendToLogFile(formatted);
    // Once the terminal is open, fire directly. Before that, buffer so the
    // output isn't lost; open() flushes it. (A naive opened-flag rather than
    // probing the emitter's private internals, which proved unreliable and
    // dropped all post-open output.)
    if (this.opened) {
      this.writeEmitter.fire(formatted);
    } else {
      this.buffer.push(formatted);
    }
  }

  writeLine(text: string): void {
    this.write(text + "\n");
  }

  dispose(): void {
    this.writeEmitter.dispose();
    this.closeEmitter.dispose();
    try {
      fs.unlinkSync(this.logPath);
    } catch {
      // best effort
    }
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
    } catch {
      // Disk logging is best-effort; the OutputChannel is the authoritative
      // record, so a failure here is silent (avoid a write loop).
      this._logFileFailed = true;
    }
  }
}
