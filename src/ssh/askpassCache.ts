/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/** Process-wide passphrase/password cache for askpass. */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

interface CacheEntry {
  password: string;
  storedAt: number;
  /** Key file mtime at storage time (0 for non-key entries). */
  keyMtime: number;
  keyPath?: string;
}

/** Cache TTL: 30 minutes. */
const TTL_MS = 30 * 60 * 1000;

const store = new Map<string, CacheEntry>();

/** Extract the key file path from a passphrase prompt, or undefined. */
export function parseKeyPath(prompt: string): string | undefined {
  const idx = prompt.indexOf("for key");
  if (idx === -1) return undefined;

  const afterKey = prompt.slice(idx + "for key".length);
  const start = afterKey.indexOf("'");
  if (start === -1) return undefined;
  const end = afterKey.indexOf("'", start + 1);
  if (end === -1) return undefined;

  return afterKey.slice(start + 1, end);
}

/** Validate a passphrase via ssh-keygen. Returns { valid } or { valid, error }. */
export function validatePassphrase(
  keyPath: string,
  passphrase: string,
): { valid: boolean; error?: string } {
  try {
    if (!fs.existsSync(keyPath)) {
      return { valid: false, error: `Key file not found: ${keyPath}` };
    }

    // Use SSH_ASKPASS + SSH_ASKPASS_REQUIRE=force to feed the passphrase
    // to ssh-keygen. Piping via stdin doesn't work on Windows (ssh-keygen
    // uses the Console API, not stdin). The passphrase is passed to a temp
    // Node script via an env var (never on disk, never in the process
    // listing), and the script writes it to stdout where ssh-keygen reads
    // it via the askpass mechanism.
    const isWin = process.platform === "win32";
    const envVar = `ARTIZO_ASKPASS_${crypto.randomBytes(8).toString("hex")}`;
    const id = crypto.randomBytes(8).toString("hex");
    const tmp = os.tmpdir();
    const jsPath = path.join(tmp, `artizo-ap-${id}.js`);
    const wrapperPath = path.join(
      tmp,
      `artizo-ap-${id}${isWin ? ".cmd" : ".sh"}`,
    );
    const nodePath = process.execPath;

    fs.writeFileSync(
      jsPath,
      `process.stdout.write(process.env["${envVar}"] || "");`,
    );

    if (isWin) {
      fs.writeFileSync(wrapperPath, `@"${nodePath}" "${jsPath}"`);
    } else {
      fs.writeFileSync(wrapperPath, `#!/bin/sh\nexec "${nodePath}" "${jsPath}"`);
      fs.chmodSync(wrapperPath, 0o700);
    }

    try {
      execFileSync("ssh-keygen", ["-y", "-f", keyPath], {
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          [envVar]: passphrase,
          SSH_ASKPASS: wrapperPath,
          SSH_ASKPASS_REQUIRE: "force",
          DISPLAY: ":0",
        },
      });
      return { valid: true };
    } finally {
      try { fs.unlinkSync(jsPath); } catch { /* best effort */ }
      try { fs.unlinkSync(wrapperPath); } catch { /* best effort */ }
    }
  } catch (err: unknown) {
    const stderr =
      (err as { stderr?: string }).stderr?.trim() ||
      (err instanceof Error ? err.message : String(err));
    return { valid: false, error: stderr };
  }
}

/** Look up a cached secret. Returns undefined if missing, expired, or key rotated. */
export function getCached(prompt: string): string | undefined {
  const entry = store.get(prompt);
  if (!entry) return undefined;
  if (Date.now() - entry.storedAt > TTL_MS) {
    store.delete(prompt);
    return undefined;
  }
  if (entry.keyPath && entry.keyMtime > 0) {
    try {
      const stat = fs.statSync(entry.keyPath);
      if (stat.mtimeMs !== entry.keyMtime) {
        store.delete(prompt);
        return undefined;
      }
    } catch {
      store.delete(prompt);
      return undefined;
    }
  }
  return entry.password;
}

/** Store a secret. Validates key passphrases before caching. */
export function setCached(
  prompt: string,
  password: string,
): { stored: boolean; error?: string } {
  const keyPath = parseKeyPath(prompt);
  if (keyPath) {
    const result = validatePassphrase(keyPath, password);
    if (!result.valid) {
      return { stored: false, error: result.error };
    }
  }
  let keyMtime = 0;
  if (keyPath) {
    try {
      keyMtime = fs.statSync(keyPath).mtimeMs;
    } catch {
      // skip mtime tracking
    }
  }
  store.set(prompt, { password, storedAt: Date.now(), keyMtime, keyPath });
  return { stored: true };
}

/** Remove a single entry. */
export function evict(prompt: string): void {
  store.delete(prompt);
}

/** Clear all cached secrets. */
export function clearAllCached(): void {
  store.clear();
}
