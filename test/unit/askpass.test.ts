/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as net from "node:net";
import * as path from "node:path";
import vscodeMock from "../__mocks__/vscode";

const { mockExecFileSync, mockExistsSync, mockStatSync, mockUnlinkSync, mockWriteFileSync, mockChmodSync } =
  vi.hoisted(() => ({
    mockExecFileSync: vi.fn(),
    mockExistsSync: vi.fn(),
    mockStatSync: vi.fn(),
    mockUnlinkSync: vi.fn(),
    mockWriteFileSync: vi.fn(),
    mockChmodSync: vi.fn(),
  }));

vi.mock("vscode", () => ({ default: vscodeMock, ...vscodeMock }));

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
  exec: vi.fn(),
}));

vi.mock("node:fs", () => ({
  default: {
    existsSync: mockExistsSync,
    statSync: mockStatSync,
    unlinkSync: mockUnlinkSync,
    writeFileSync: mockWriteFileSync,
    chmodSync: mockChmodSync,
  },
  existsSync: mockExistsSync,
  statSync: mockStatSync,
  unlinkSync: mockUnlinkSync,
  writeFileSync: mockWriteFileSync,
  chmodSync: mockChmodSync,
}));

vi.mock("../../src/utils/logger", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    show: vi.fn(),
    dispose: vi.fn(),
  }),
}));

import * as vscode from "vscode";
import { AskpassServer } from "../../src/ssh/askpassServer";
import {
  getCached,
  setCached,
  evict,
  clearAllCached,
  parseKeyPath,
  validatePassphrase,
} from "../../src/ssh/askpassCache";
import {
  batchModeArgs,
  sshEnvForAskpass,
  startAskpass,
} from "../../src/ssh/askpass";

const mockLogger = {
  info: () => {},
  debug: () => {},
  error: () => {},
  show: () => {},
  dispose: () => {},
};

function resetFsMocks() {
  mockExecFileSync.mockReset();
  mockExistsSync.mockReset();
  mockStatSync.mockReset();
  mockUnlinkSync.mockReset();
  mockWriteFileSync.mockReset();
  mockChmodSync.mockReset();
}

/** Restore the default vscode config mock (askpass = default value). */
function restoreConfigMock() {
  vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
    get: vi.fn((_key: string, defaultValue: unknown) => defaultValue),
    update: vi.fn().mockResolvedValue(undefined),
  } as any);
}

describe("AskpassServer", () => {
  beforeEach(() => {
    clearAllCached();
    resetFsMocks();
  });

  it("responds with the password from showPrompt", async () => {
    const server = new AskpassServer(mockLogger as any, {
      showPrompt: vi.fn().mockResolvedValue("hunter2"),
    });
    const handle = await server.start();

    const response = await sendRequest(handle, "Password for host:", server.token);
    expect(response).toEqual({ password: "hunter2" });

    await server.stop();
  });

  it("rejects a request with no token", async () => {
    const showPrompt = vi.fn().mockResolvedValue("secret");
    const server = new AskpassServer(mockLogger as any, { showPrompt });
    const handle = await server.start();

    const response = await sendRaw(
      handle,
      JSON.stringify({ request: "Password:" }) + "\n",
    );
    expect(response).toEqual({ error: "unauthorized" });
    // The prompt is never shown to an unauthenticated caller.
    expect(showPrompt).not.toHaveBeenCalled();

    await server.stop();
  });

  it("rejects a request with a wrong token", async () => {
    const showPrompt = vi.fn().mockResolvedValue("secret");
    const server = new AskpassServer(mockLogger as any, { showPrompt });
    const handle = await server.start();

    const response = await sendRaw(
      handle,
      JSON.stringify({ request: "Password:", token: "deadbeef" }) + "\n",
    );
    expect(response).toEqual({ error: "unauthorized" });
    expect(showPrompt).not.toHaveBeenCalled();

    await server.stop();
  });

  it("responds with cancelled when showPrompt returns undefined", async () => {
    const server = new AskpassServer(mockLogger as any, {
      showPrompt: vi.fn().mockResolvedValue(undefined),
    });
    const handle = await server.start();

    const response = await sendRequest(handle, "Passphrase:", server.token);
    expect(response).toEqual({ cancelled: true });

    await server.stop();
  });

  it("handles multiple sequential requests", async () => {
    let call = 0;
    const passwords = ["pw1", "pw2"];
    const server = new AskpassServer(mockLogger as any, {
      showPrompt: vi
        .fn()
        .mockImplementation(() => Promise.resolve(passwords[call++])),
    });
    const handle = await server.start();

    expect(await sendRequest(handle, "Prompt 1", server.token)).toEqual({
      password: "pw1",
    });
    expect(await sendRequest(handle, "Prompt 2", server.token)).toEqual({
      password: "pw2",
    });

    await server.stop();
  });

  it("returns cached password without re-prompting on repeat prompts", async () => {
    const showPrompt = vi.fn().mockResolvedValue("secret");
    const server = new AskpassServer(mockLogger as any, { showPrompt });
    const handle = await server.start();

    // Use a host password prompt so setCached skips ssh-keygen validation.
    expect(await sendRequest(handle, "dev@host's password:", server.token)).toEqual({
      password: "secret",
    });
    expect(showPrompt).toHaveBeenCalledTimes(1);

    // Second request is a cache hit.
    expect(await sendRequest(handle, "dev@host's password:", server.token)).toEqual({
      password: "secret",
    });
    expect(showPrompt).toHaveBeenCalledTimes(1);

    await server.stop();
  });

  it("responds with error for invalid JSON", async () => {
    const server = new AskpassServer(mockLogger as any, {
      showPrompt: vi.fn(),
    });
    const handle = await server.start();

    const response = await sendRaw(handle, "not valid json\n");
    expect(response.error).toBeTruthy();

    await server.stop();
  });

  it("responds with error when 'request' field is missing", async () => {
    const server = new AskpassServer(mockLogger as any, {
      showPrompt: vi.fn(),
    });
    const handle = await server.start();

    const response = await sendRaw(
      handle,
      JSON.stringify({ foo: "bar", token: server.token }) + "\n",
    );
    expect(response).toEqual({ error: "missing 'request' field" });

    await server.stop();
  });

  it("re-prompts when passphrase validation fails, up to 3 attempts", async () => {
    mockExistsSync.mockReturnValue(true);
    let keygenCalls = 0;
    mockExecFileSync.mockImplementation(() => {
      keygenCalls++;
      if (keygenCalls < 3) {
        throw { stderr: "incorrect passphrase" };
      }
      return "ssh-ed25519 AAAA...";
    });
    mockStatSync.mockReturnValue({ mtimeMs: 1000 });

    const showPrompt = vi.fn();
    showPrompt.mockResolvedValueOnce("wrong1");
    showPrompt.mockResolvedValueOnce("wrong2");
    showPrompt.mockResolvedValueOnce("correct");

    const server = new AskpassServer(mockLogger as any, { showPrompt });
    const handle = await server.start();

    const response = await sendRequest(
      handle,
      "Enter passphrase for key '/home/user/.ssh/id_rsa':",
      server.token,
    );
    expect(response).toEqual({ password: "correct" });
    expect(showPrompt).toHaveBeenCalledTimes(3);
    // Second and third calls should include the error message.
    expect(showPrompt.mock.calls[1][1]).toContain("incorrect passphrase");
    // Wrong passwords should not be cached.
    expect(
      getCached("Enter passphrase for key '/home/user/.ssh/id_rsa':"),
    ).toBe("correct");

    await server.stop();
  });

  it("returns error after exhausting all passphrase attempts", async () => {
    mockExistsSync.mockReturnValue(true);
    mockExecFileSync.mockImplementation(() => {
      throw { stderr: "incorrect passphrase" };
    });

    const showPrompt = vi.fn().mockResolvedValue("wrong-pass");
    const server = new AskpassServer(mockLogger as any, { showPrompt });
    const handle = await server.start();

    const response = await sendRequest(
      handle,
      "Enter passphrase for key '/home/user/.ssh/id_rsa':",
      server.token,
    );
    expect(response.error).toBe("incorrect passphrase");
    expect(showPrompt).toHaveBeenCalledTimes(3);
    // Wrong passphrase should not be cached.
    expect(
      getCached("Enter passphrase for key '/home/user/.ssh/id_rsa':"),
    ).toBeUndefined();

    await server.stop();
  });

  it("stores and returns a key passphrase when validation succeeds", async () => {
    mockExistsSync.mockReturnValue(true);
    mockExecFileSync.mockReturnValue("ssh-ed25519 AAAA...");
    mockStatSync.mockReturnValue({ mtimeMs: 1000 });

    const server = new AskpassServer(mockLogger as any, {
      showPrompt: vi.fn().mockResolvedValue("correct-pass"),
    });
    const handle = await server.start();

    const response = await sendRequest(
      handle,
      "Enter passphrase for key '/home/user/.ssh/id_rsa':",
      server.token,
    );
    expect(response).toEqual({ password: "correct-pass" });

    await server.stop();
  });

  it("tracks host password prompts in usedHostPassword", async () => {
    const server = new AskpassServer(mockLogger as any, {
      showPrompt: vi.fn().mockResolvedValue("hunter2"),
    });
    const handle = await server.start();

    expect(server.usedHostPassword).toBe(false);
    await sendRequest(handle, "dev@host's password:", server.token);
    expect(server.usedHostPassword).toBe(true);

    await server.stop();
  });

  it("does not set usedHostPassword for key passphrase prompts", async () => {
    mockExistsSync.mockReturnValue(true);
    mockExecFileSync.mockReturnValue("ssh-ed25519 AAAA...");
    mockStatSync.mockReturnValue({ mtimeMs: 1000 });

    const server = new AskpassServer(mockLogger as any, {
      showPrompt: vi.fn().mockResolvedValue("passphrase"),
    });
    const handle = await server.start();

    await sendRequest(
      handle,
      "Enter passphrase for key '/home/u/.ssh/id_rsa':",
      server.token,
    );
    expect(server.usedHostPassword).toBe(false);

    await server.stop();
  });

  it("evictHostPasswords removes cached host passwords", async () => {
    const server = new AskpassServer(mockLogger as any, {
      showPrompt: vi.fn().mockResolvedValue("hunter2"),
    });
    const handle = await server.start();

    const prompt = "dev@host's password:";
    await sendRequest(handle, prompt, server.token);
    expect(getCached(prompt)).toBe("hunter2");
    expect(server.usedHostPassword).toBe(true);

    server.evictHostPasswords();
    expect(getCached(prompt)).toBeUndefined();
    expect(server.usedHostPassword).toBe(false);

    await server.stop();
  });

  it("evictHostPasswords clears multiple host prompts", async () => {
    let call = 0;
    const server = new AskpassServer(mockLogger as any, {
      showPrompt: vi.fn().mockImplementation(() =>
        Promise.resolve(`pw${++call}`),
      ),
    });
    const handle = await server.start();

    const p1 = "user@host1's password:";
    const p2 = "user@host2's password:";
    await sendRequest(handle, p1, server.token);
    await sendRequest(handle, p2, server.token);
    expect(getCached(p1)).toBe("pw1");
    expect(getCached(p2)).toBe("pw2");
    expect(server.usedHostPassword).toBe(true);

    server.evictHostPasswords();
    expect(getCached(p1)).toBeUndefined();
    expect(getCached(p2)).toBeUndefined();
    expect(server.usedHostPassword).toBe(false);

    await server.stop();
  });

  it("re-prompts after eviction on a repeat host password request", async () => {
    const showPrompt = vi.fn().mockResolvedValue("hunter2");
    const server = new AskpassServer(mockLogger as any, { showPrompt });
    const handle = await server.start();

    const prompt = "dev@host's password:";
    await sendRequest(handle, prompt, server.token);
    expect(showPrompt).toHaveBeenCalledTimes(1);

    // Cache hit: no re-prompt.
    await sendRequest(handle, prompt, server.token);
    expect(showPrompt).toHaveBeenCalledTimes(1);

    // After eviction, the next request re-prompts.
    server.evictHostPasswords();
    await sendRequest(handle, prompt, server.token);
    expect(showPrompt).toHaveBeenCalledTimes(2);

    await server.stop();
  });
});

describe("askpassCache", () => {
  beforeEach(() => {
    clearAllCached();
    resetFsMocks();
  });

  describe("parseKeyPath", () => {
    it("extracts the key path from a passphrase prompt", () => {
      expect(
        parseKeyPath("Enter passphrase for key '/home/user/.ssh/id_rsa':"),
      ).toBe("/home/user/.ssh/id_rsa");
    });

    it("handles Windows paths with backslashes", () => {
      expect(
        parseKeyPath(
          "Enter passphrase for key 'C:\\Users\\dev/.ssh/id_ed25519':",
        ),
      ).toBe("C:\\Users\\dev/.ssh/id_ed25519");
    });

    it("handles paths with spaces", () => {
      expect(
        parseKeyPath(
          "Enter passphrase for key 'C:\\Users\\John Smith\\.ssh\\id_rsa':",
        ),
      ).toBe("C:\\Users\\John Smith\\.ssh\\id_rsa");
    });

    it("returns undefined for host password prompts", () => {
      expect(parseKeyPath("dev@host's password:")).toBeUndefined();
    });

    it("returns undefined when there is no quoted path", () => {
      expect(parseKeyPath("Enter passphrase for key:")).toBeUndefined();
    });
  });

  describe("validatePassphrase", () => {
    it("returns valid:true when ssh-keygen succeeds", () => {
      mockExistsSync.mockReturnValue(true);
      mockExecFileSync.mockReturnValue("ssh-ed25519 AAAA...");

      const result = validatePassphrase("/key", "pass");
      expect(result).toEqual({ valid: true });
    });

    it("uses SSH_ASKPASS env, not stdin, to feed passphrase", () => {
      mockExistsSync.mockReturnValue(true);
      mockExecFileSync.mockReturnValue("ssh-ed25519 AAAA...");

      validatePassphrase("/key", "pass");

      expect(mockExecFileSync).toHaveBeenCalledTimes(1);
      const [, , opts] = mockExecFileSync.mock.calls[0];
      // stdin is ignored, not piped
      expect(opts.stdio[0]).toBe("ignore");
      // SSH_ASKPASS + SSH_ASKPASS_REQUIRE=force must be set
      expect(opts.env.SSH_ASKPASS_REQUIRE).toBe("force");
      expect(opts.env.SSH_ASKPASS).toBeDefined();
      // Passphrase is passed via env var, not via stdin input
      expect(opts.input).toBeUndefined();
    });

    it("cleans up temp files after validation", () => {
      mockExistsSync.mockReturnValue(true);
      mockExecFileSync.mockReturnValue("ssh-ed25519 AAAA...");

      validatePassphrase("/key", "pass");

      // Two writeFileSync calls: js script + wrapper
      expect(mockWriteFileSync).toHaveBeenCalledTimes(2);
      // Two unlinkSync calls: js script + wrapper
      expect(mockUnlinkSync).toHaveBeenCalledTimes(2);
    });

    it("returns valid:false with error when ssh-keygen fails", () => {
      mockExistsSync.mockReturnValue(true);
      mockExecFileSync.mockImplementation(() => {
        throw { stderr: "incorrect passphrase" };
      });

      const result = validatePassphrase("/key", "pass");
      expect(result).toEqual({ valid: false, error: "incorrect passphrase" });
    });

    it("returns valid:false when key file is missing", () => {
      mockExistsSync.mockReturnValue(false);

      const result = validatePassphrase("/missing", "pass");
      expect(result).toEqual({
        valid: false,
        error: "Key file not found: /missing",
      });
    });

    it("handles spawn errors without stderr", () => {
      mockExistsSync.mockReturnValue(true);
      mockExecFileSync.mockImplementation(() => {
        throw new Error("spawn ENOENT");
      });

      const result = validatePassphrase("/key", "pass");
      expect(result.valid).toBe(false);
      expect(result.error).toBe("spawn ENOENT");
    });
  });

  describe("getCached / setCached", () => {
    it("stores and retrieves a non-key prompt without validation", () => {
      const result = setCached("dev@host's password:", "pw123");
      expect(result.stored).toBe(true);
      expect(getCached("dev@host's password:")).toBe("pw123");
    });

    it("returns undefined for a missing prompt", () => {
      expect(getCached("never stored")).toBeUndefined();
    });

    it("evicts a single entry", () => {
      setCached("prompt-a", "pw-a");
      evict("prompt-a");
      expect(getCached("prompt-a")).toBeUndefined();
    });

    it("clears all entries", () => {
      setCached("prompt-a", "pw-a");
      setCached("prompt-b", "pw-b");
      clearAllCached();
      expect(getCached("prompt-a")).toBeUndefined();
      expect(getCached("prompt-b")).toBeUndefined();
    });

    it("validates key passphrase and stores on success", () => {
      mockExistsSync.mockReturnValue(true);
      mockExecFileSync.mockReturnValue("ssh-ed25519 AAAA...");
      mockStatSync.mockReturnValue({ mtimeMs: 5000 });

      const prompt = "Enter passphrase for key '/home/user/.ssh/id_rsa':";
      const result = setCached(prompt, "correct");
      expect(result.stored).toBe(true);
      expect(getCached(prompt)).toBe("correct");
    });

    it("rejects wrong passphrase and does not cache", () => {
      mockExistsSync.mockReturnValue(true);
      mockExecFileSync.mockImplementation(() => {
        throw { stderr: "bad passphrase" };
      });

      const prompt = "Enter passphrase for key '/home/user/.ssh/id_rsa':";
      const result = setCached(prompt, "wrong");
      expect(result.stored).toBe(false);
      expect(result.error).toBe("bad passphrase");
      expect(getCached(prompt)).toBeUndefined();
    });

    it("evicts when key file mtime changes", () => {
      mockExistsSync.mockReturnValue(true);
      mockExecFileSync.mockReturnValue("ssh-ed25519 AAAA...");
      mockStatSync.mockReturnValue({ mtimeMs: 5000 });

      const prompt = "Enter passphrase for key '/home/user/.ssh/id_rsa':";
      setCached(prompt, "correct");
      expect(getCached(prompt)).toBe("correct");

      // Key file modified - cache evicts.
      mockStatSync.mockReturnValue({ mtimeMs: 9999 });
      expect(getCached(prompt)).toBeUndefined();
    });

    it("evicts when key file is deleted", () => {
      mockExistsSync.mockReturnValue(true);
      mockExecFileSync.mockReturnValue("ssh-ed25519 AAAA...");
      mockStatSync.mockReturnValue({ mtimeMs: 5000 });

      const prompt = "Enter passphrase for key '/home/user/.ssh/id_rsa':";
      setCached(prompt, "correct");

      // statSync throws - key file gone.
      mockStatSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });
      expect(getCached(prompt)).toBeUndefined();
    });

    it("returns cached key passphrase when mtime is unchanged", () => {
      mockExistsSync.mockReturnValue(true);
      mockExecFileSync.mockReturnValue("ssh-ed25519 AAAA...");
      mockStatSync.mockReturnValue({ mtimeMs: 5000 });

      const prompt = "Enter passphrase for key '/home/user/.ssh/id_rsa':";
      setCached(prompt, "correct");

      // Same mtime - still valid.
      expect(getCached(prompt)).toBe("correct");
    });

    it("evicts after TTL expires", () => {
      vi.useFakeTimers();
      try {
        setCached("dev@host's password:", "pw");

        // Under TTL - still cached.
        vi.setSystemTime(Date.now() + 29 * 60 * 1000);
        expect(getCached("dev@host's password:")).toBe("pw");

        // Past TTL - evicted.
        vi.setSystemTime(Date.now() + 2 * 60 * 1000);
        expect(getCached("dev@host's password:")).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

describe("batchModeArgs", () => {
  it("returns empty array when askpass is enabled", () => {
    expect(batchModeArgs(true)).toEqual([]);
  });

  it("returns BatchMode=yes args when askpass is disabled", () => {
    expect(batchModeArgs(false)).toEqual(["-o", "BatchMode=yes"]);
  });
});

describe("sshEnvForAskpass", () => {
  it("returns undefined when handle is undefined", () => {
    expect(sshEnvForAskpass(undefined)).toBeUndefined();
  });

  it("sets all SSH_ASKPASS env vars when handle is provided", () => {
    const handle = {
      server: { handle: "/tmp/askpass.sock", token: "tok-123" } as any,
      askpassScript: "/scripts/askpass.sh",
      askpassMain: "/scripts/askpass-main.js",
      nodePath: "/usr/bin/node",
    };

    const env = sshEnvForAskpass(handle);
    expect(env).toBeDefined();
    expect(env!.SSH_ASKPASS).toBe("/scripts/askpass.sh");
    expect(env!.SSH_ASKPASS_REQUIRE).toBe("force");
    expect(env!.DISPLAY).toBe("artizo");
    expect(env!.ARTIZO_SSH_ASKPASS_HANDLE).toBe("/tmp/askpass.sock");
    expect(env!.ARTIZO_SSH_ASKPASS_TOKEN).toBe("tok-123");
    expect(env!.ARTIZO_SSH_ASKPASS_NODE).toBe("/usr/bin/node");
    expect(env!.ARTIZO_SSH_ASKPASS_MAIN).toBe("/scripts/askpass-main.js");
  });

  it("includes process.env in the result", () => {
    const handle = {
      server: { handle: "/tmp/sock", token: "tok" } as any,
      askpassScript: "/askpass.sh",
      askpassMain: "/askpass-main.js",
      nodePath: "/node",
    };

    const env = sshEnvForAskpass(handle);
    // process.env values should be present (spread first, then overwritten).
    expect(env).toMatchObject({ PATH: process.env.PATH });
  });
});

describe("startAskpass", () => {
  beforeEach(() => {
    restoreConfigMock();
  });

  afterEach(() => {
    restoreConfigMock();
  });

  it("returns undefined when askpass is disabled", async () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn().mockReturnValue(false),
      update: vi.fn().mockResolvedValue(undefined),
    } as any);

    const result = await startAskpass("/ext/path");
    expect(result).toBeUndefined();
  });

  it("returns handle with script paths when enabled", async () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: vi.fn((_key: string, def: unknown) =>
        _key === "askpass" ? true : def,
      ),
      update: vi.fn().mockResolvedValue(undefined),
    } as any);

    const result = await startAskpass("/ext/path");
    expect(result).toBeDefined();
    expect(result!.nodePath).toBe(process.execPath);
    expect(result!.askpassMain).toBe(
      path.join("/ext/path", "scripts", "askpass", "askpass-main.js"),
    );

    const expectedScript =
      process.platform === "win32" ? "askpass.cmd" : "askpass.sh";
    expect(result!.askpassScript).toBe(
      path.join("/ext/path", "scripts", "askpass", expectedScript),
    );

    await result!.server.stop();
  });
});

function sendRequest(
  handle: string,
  prompt: string,
  token: string,
): Promise<{ password?: string; cancelled?: boolean; error?: string }> {
  return sendRaw(handle, JSON.stringify({ request: prompt, token }) + "\n");
}

function sendRaw(
  handle: string,
  raw: string,
): Promise<{ password?: string; cancelled?: boolean; error?: string }> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(handle);
    let buf = "";
    client.on("connect", () => {
      client.write(raw);
    });
    client.on("data", (data) => {
      buf += data.toString();
      if (buf.endsWith("\n")) {
        client.end();
        resolve(JSON.parse(buf.trim()));
      }
    });
    client.on("error", reject);
    setTimeout(() => {
      client.destroy();
      reject(new Error("timeout"));
    }, 2000);
  });
}
