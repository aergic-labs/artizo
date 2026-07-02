/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("../../src/utils/logger", () => ({
  getLogger: () => ({ info: vi.fn(), error: vi.fn() }),
}));

import { parseHome, ContainerBootstrap } from "../../src/remote/bootstrap";

function makeChild() {
  const c = new EventEmitter() as any;
  c.stdin = { write: vi.fn(), end: vi.fn() };
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  return c;
}

describe("parseHome", () => {
  it("extracts HOME", () => expect(parseHome("HOME=/x\n")).toBe("/x"));
  it("defaults to /root", () => expect(parseHome("")).toBe("/root"));
});

describe("bootstrap files", () => {
  it("setup.sh", () => {
    const s = readFileSync(join(process.cwd(), "tools", "setup.sh"), "utf-8");
    expect(s).toContain("#!/tmp/.artizo/bin/sh");
    expect(s).toContain("gzip -d | tar -xC");
    // Auth token arrives on stdin (base64), never on argv.
    expect(s).toContain("ARTIZO_AUTH_TOKEN_STDIN");
    expect(s).toContain("base64 -d");
    expect(s).not.toContain('echo "${ARTIZO_AUTH_TOKEN}"');
  });
});

describe("ContainerBootstrap methods", () => {
  const tmp = join(import.meta.dirname, "..", "..");
  function boot(s?: any, f?: any) {
    return new ContainerBootstrap({
      extensionPath: tmp,
      spawner: s,
      fetcher: f,
    });
  }

  beforeEach(() => vi.clearAllMocks());

  it("bootstrapBusybox spawns and pipes binary", async () => {
    const s = vi.fn(),
      c = makeChild();
    s.mockReturnValue(c);
    const p = boot(s).bootstrapBusybox("c1", "x64");
    c.emit("close", 0);
    await p;
    expect(s).toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining(["exec", "-i"]),
    );
    expect(c.stdin.write).toHaveBeenCalled();
    expect(c.stdin.end).toHaveBeenCalled();
  });

  it("deployTools creates tar", async () => {
    const s = vi.fn(),
      c = makeChild();
    s.mockReturnValue(c);
    const p = boot(s).deployTools("c1");
    c.emit("close", 0);
    await p;
    expect(s).toHaveBeenCalledWith("docker", [
      "exec",
      "-i",
      "c1",
      "/tmp/.artizo/bin/tar",
      "-xC",
      "/tmp/.artizo/bin",
    ]);
  });

  it("runSetup returns home", async () => {
    const s = vi.fn(),
      c = makeChild();
    s.mockReturnValue(c);
    const f = vi.fn((_url: string, cb: Function) => {
      const r: any = new EventEmitter();
      r.statusCode = 200;
      r.headers = {};
      r.pipe = (dest: any) => dest.end();
      cb(r);
      r.emit("end");
      return { on: vi.fn() };
    });
    const p = boot(s, f).runSetup("c1", "https://x", "/tmp/.kiro");
    c.stdout.emit("data", Buffer.from("HOME=/app\n"));
    c.emit("close", 0);
    expect((await p).home).toBe("/app");
  });

  it("runSetup no home defaults to /root", async () => {
    const s = vi.fn(),
      c = makeChild();
    s.mockReturnValue(c);
    const f = vi.fn((_url: string, cb: Function) => {
      const r: any = new EventEmitter();
      r.statusCode = 200;
      r.headers = {};
      r.pipe = (dest: any) => dest.end();
      cb(r);
      r.emit("end");
      return { on: vi.fn() };
    });
    const p = boot(s, f).runSetup("c1", "https://x", "/tmp/.trae");
    c.emit("close", 0);
    expect((await p).home).toBe("/root");
  });

  it("streams auth token on stdin, keeping it off argv", async () => {
    const s = vi.fn(),
      c = makeChild();
    s.mockReturnValue(c);
    const f = vi.fn((_url: string, cb: Function) => {
      const r: any = new EventEmitter();
      r.statusCode = 200;
      r.headers = {};
      cb(r);
      r.emit("data", Buffer.from("server-bytes"));
      r.emit("end");
      return { on: vi.fn() };
    });
    const p = boot(s, f).runSetup(
      "c1",
      "https://x",
      "/tmp/.kiro",
      "secret-token",
      ".aws/sso/cache/k.json",
    );
    c.emit("close", 0);
    await p;

    const args = s.mock.calls[0][1] as string[];
    // Marker flag + destination path on argv, but never the token itself.
    expect(args).toEqual(
      expect.arrayContaining(["-e", "ARTIZO_AUTH_TOKEN_STDIN=1"]),
    );
    expect(args).toEqual(
      expect.arrayContaining([
        "-e",
        "ARTIZO_AUTH_TOKEN_PATH=.aws/sso/cache/k.json",
      ]),
    );
    expect(args.join(" ")).not.toContain("secret-token");
    // Token is streamed as a base64 line ahead of the tarball bytes.
    const b64 = Buffer.from("secret-token").toString("base64");
    expect(c.stdin.write).toHaveBeenCalledWith(Buffer.from(`${b64}\n`));
    expect(c.stdin.write).toHaveBeenCalledWith(Buffer.from("server-bytes"));
  });

  it("runSetup throws on non-zero exit", async () => {
    const s = vi.fn(),
      c = makeChild();
    s.mockReturnValue(c);
    const f = vi.fn((_url: string, cb: Function) => {
      const r: any = new EventEmitter();
      r.statusCode = 200;
      r.headers = {};
      r.pipe = (dest: any) => dest.end();
      cb(r);
      r.emit("end");
      return { on: vi.fn() };
    });
    const p = boot(s, f).runSetup("c1", "https://x", "/tmp/.kiro");
    c.emit("close", 1);
    await expect(p).rejects.toThrow("Setup script failed");
  });

  it("runSetup follows a redirect to the final server URL", async () => {
    const s = vi.fn();
    const c = makeChild();
    s.mockReturnValue(c);

    let call = 0;
    const f = vi.fn((_url: string, cb: Function) => {
      call++;
      const r: any = new EventEmitter();
      if (call === 1) {
        r.statusCode = 302;
        r.headers = { location: "https://cdn.example/server.tar.gz" };
        r.resume = vi.fn();
        cb(r);
      } else {
        r.statusCode = 200;
        r.headers = {};
        cb(r);
        r.emit("data", Buffer.from("server-bytes"));
        r.emit("end");
      }
      return { on: vi.fn() };
    });

    const p = boot(s, f).runSetup("c1", "https://x", "/tmp/.kiro");
    c.stdout.emit("data", Buffer.from("HOME=/app\n"));
    c.emit("close", 0);

    expect((await p).home).toBe("/app");
    expect(f).toHaveBeenCalledTimes(2);
    expect(f.mock.calls[1][0]).toBe("https://cdn.example/server.tar.gz");
    expect(c.stdin.write).toHaveBeenCalledWith(Buffer.from("server-bytes"));
  });

  it("runSetup rejects on an HTTP error status", async () => {
    const s = vi.fn();
    s.mockReturnValue(makeChild());
    const f = vi.fn((_url: string, cb: Function) => {
      const r: any = new EventEmitter();
      r.statusCode = 500;
      r.headers = {};
      r.resume = vi.fn();
      cb(r);
      return { on: vi.fn() };
    });

    await expect(
      boot(s, f).runSetup("c1", "https://x", "/tmp/.kiro"),
    ).rejects.toThrow("HTTP 500 fetching server");
  });

  it("runSetup rejects after too many redirects", async () => {
    const s = vi.fn();
    s.mockReturnValue(makeChild());
    const f = vi.fn((_url: string, cb: Function) => {
      const r: any = new EventEmitter();
      r.statusCode = 302;
      r.headers = { location: "https://loop.example/again" };
      r.resume = vi.fn();
      cb(r);
      return { on: vi.fn() };
    });

    await expect(
      boot(s, f).runSetup("c1", "https://x", "/tmp/.kiro"),
    ).rejects.toThrow("Too many redirects");
    // initial attempt + 5 redirect follow-ups
    expect(f).toHaveBeenCalledTimes(6);
  });

  it("runSetup rejects when the download stalls (inactivity timeout)", async () => {
    const s = vi.fn();
    s.mockReturnValue(makeChild());
    // Never delivers a response; the request's inactivity timeout fires.
    const f = vi.fn((_url: string, _cb: Function) => {
      const req: any = new EventEmitter();
      req.setTimeout = (_ms: number, onTimeout: () => void) => onTimeout();
      req.destroy = (err?: Error) => {
        if (err) req.emit("error", err);
      };
      return req;
    });

    await expect(
      boot(s, f).runSetup("c1", "https://x", "/tmp/.kiro"),
    ).rejects.toThrow("timed out");
  });
});