/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/** SSH askpass server. Listens on a Unix socket (Unix) or named pipe (Windows). */

import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import type { Logger } from "../utils/logger";
import { getCached, setCached, evict, validatePassphrase, parseKeyPath } from "./askpassCache";

export interface AskpassServerDeps {
  showPrompt(
    prompt: string,
    errorMessage?: string,
  ): Thenable<string | undefined>;
}

export class AskpassServer {
  private server: net.Server | undefined;
  private socketPath = "";
  private readonly pending = new Map<net.Socket, { buffer: string }>();
  /**
   * Per-server shared secret. The askpass client must present this token or
   * the request is rejected. Passed to the client out-of-band via an env var
   * (never on the command line), so co-resident local processes that discover
   * the socket cannot harvest cached secrets or trigger prompts.
   */
  private readonly authToken = crypto.randomBytes(32).toString("hex");
  /** Host password prompts handled this session. Used to evict bad
   * passwords on SSH failure so a retry re-prompts instead of reusing. */
  private readonly hostPrompts = new Set<string>();

  constructor(
    private readonly logger: Logger,
    private readonly deps: AskpassServerDeps,
  ) {}

  /** The auth token the askpass client must present. */
  get token(): string {
    return this.authToken;
  }

  /** True if any host password prompts were handled this session. */
  get usedHostPassword(): boolean {
    return this.hostPrompts.size > 0;
  }

  /** Evict all host password cache entries from this session.
   * Called on resolve failure so a retry doesn't reuse a bad password. */
  evictHostPasswords(): void {
    for (const prompt of this.hostPrompts) {
      evict(prompt);
    }
    this.hostPrompts.clear();
  }

  /** Start listening. Returns the socket path. */
  async start(): Promise<string> {
    this.socketPath = this.generateSocketPath();
    const server = net.createServer((socket) => this.handleConnection(socket));
    this.server = server;
    server.on("error", (err) => {
      this.logger.error(`[askpass] server error: ${err.message}`);
    });
    await new Promise<void>((resolve, reject) => {
      server.listen(this.socketPath, () => resolve());
      server.once("error", reject);
    });
    // Restrict the socket to the current user (Unix). Named pipes on Windows
    // are namespaced separately; the unguessable name + token guard those.
    if (process.platform !== "win32") {
      try {
        fs.chmodSync(this.socketPath, 0o600);
      } catch (err) {
        this.logger.error(
          `[askpass] failed to chmod socket: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    this.logger.info(`[askpass] listening on ${this.socketPath}`);
    return this.socketPath;
  }

  async stop(): Promise<void> {
    for (const [socket] of this.pending) {
      try {
        socket.destroy();
      } catch {
        // ignore
      }
    }
    this.pending.clear();
    const server = this.server;
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      this.server = undefined;
    }
    if (this.socketPath && process.platform !== "win32") {
      try {
        fs.unlinkSync(this.socketPath);
      } catch {
        // ignore
      }
    }
    this.logger.info("[askpass] stopped");
  }

  get handle(): string {
    return this.socketPath;
  }

  private handleConnection(socket: net.Socket): void {
    this.pending.set(socket, { buffer: "" });

    socket.on("data", (data: Buffer) => {
      const state = this.pending.get(socket);
      if (!state) return;
      state.buffer += data.toString("utf-8");
      if (state.buffer.includes("\n")) {
        this.handleRequest(socket, state.buffer);
      }
    });

    socket.on("error", () => {
      this.pending.delete(socket);
    });

    socket.on("close", () => {
      this.pending.delete(socket);
    });
  }

  /** Constant-time comparison of the presented token against ours. */
  private validToken(provided: unknown): boolean {
    if (typeof provided !== "string") return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(this.authToken);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  private async handleRequest(socket: net.Socket, raw: string): Promise<void> {
    try {
      const parsed = JSON.parse(raw.trim());
      if (!this.validToken(parsed.token)) {
        this.logger.error("[askpass] rejected request with invalid token");
        this.respond(socket, { error: "unauthorized" });
        return;
      }
      if (typeof parsed.request !== "string") {
        this.respond(socket, { error: "missing 'request' field" });
        return;
      }
      const prompt = parsed.request;
      const cached = getCached(prompt);
      if (cached !== undefined) {
        this.logger.info(
          `[askpass] cache hit for: ${prompt}`,
        );
        this.respond(socket, { password: cached });
        return;
      }

      // For key passphrases, validate before returning to ssh. ssh-keygen
      // does not retry askpass, so a wrong passphrase returned to ssh is a
      // dead end. Loop here: prompt, validate, re-prompt on failure. Up to
      // 3 attempts. Only cache and return after validation passes.
      const keyPath = parseKeyPath(prompt);
      const maxAttempts = keyPath ? 3 : 1;
      let lastError: string | undefined;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        this.logger.info(
          `[askpass] prompting for: ${prompt}${attempt > 0 ? " (retry " + attempt + ")" : ""}`,
        );
        const password = await this.deps.showPrompt(prompt, lastError);
        if (password === undefined) {
          this.respond(socket, { cancelled: true });
          return;
        }

        if (!keyPath) {
          // Non-key prompt (host password). Can't pre-validate. Track it
          // so the caller can evict on SSH failure, cache best-effort, and
          // return to ssh.
          this.hostPrompts.add(prompt);
          this.logger.info(
            `[askpass] host password (${
              password.length === 0 ? "empty" : "value"
            }) for: ${prompt}`,
          );
          const result = setCached(prompt, password);
          if (!result.stored) {
            this.logger.info(`[askpass] cache store failed: ${result.error}`);
          }
          this.respond(socket, { password });
          return;
        }

        const result = validatePassphrase(keyPath, password);
        this.logger.info(
          `[askpass] validatePassphrase(key=${keyPath}, pass=${password.length === 0 ? "empty" : "value"}) => valid=${result.valid}${result.error ? ` err=${result.error}` : ""}`,
        );
        if (result.valid) {
          setCached(prompt, password);
          this.respond(socket, { password });
          return;
        }

        lastError = result.error;
        this.logger.info(`[askpass] passphrase rejected: ${result.error}`);
      }

      // Exhausted all attempts.
      this.respond(socket, { error: lastError ?? "passphrase rejected" });
    } catch (err) {
      this.respond(socket, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private respond(socket: net.Socket, obj: object): void {
    socket.write(JSON.stringify(obj) + "\n");
    socket.end();
    this.pending.delete(socket);
  }

  private generateSocketPath(): string {
    const id = crypto.randomBytes(16).toString("hex");
    if (process.platform === "win32") {
      return `\\\\.\\pipe\\artizo-askpass-${id}`;
    }
    return path.join(os.tmpdir(), `artizo-askpass-${id}.sock`);
  }
}
