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

  it("runSetup passes auth token", async () => {
    const s = vi.fn(),
      c = makeChild();
    s.mockReturnValue(c);
    const f = vi.fn((_url: string, cb: Function) => {
      cb({
        statusCode: 200,
        headers: {},
        pipe: (dest: any) => dest.end(),
        on: vi.fn(),
      } as any);
      return { on: vi.fn() };
    });
    boot(s, f).runSetup(
      "c1",
      "https://x",
      "/tmp/.kiro",
      "t",
      ".aws/sso/cache/k.json",
    );
    c.emit("close", 0);
    await vi.waitFor(() =>
      expect(s).toHaveBeenCalledWith(
        "docker",
        expect.arrayContaining(["-e", "ARTIZO_AUTH_TOKEN=t"]),
      ),
    );
    await vi.waitFor(() =>
      expect(s).toHaveBeenCalledWith(
        "docker",
        expect.arrayContaining([
          "-e",
          "ARTIZO_AUTH_TOKEN_PATH=.aws/sso/cache/k.json",
        ]),
      ),
    );
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
});