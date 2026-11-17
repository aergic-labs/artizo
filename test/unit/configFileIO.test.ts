/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  readConfigFileText,
  writeTempConfigFile,
  removeTempConfigFile,
} from "../../src/config/configFileIO";
import { setActiveExecServer } from "../../src/remote/execServerCache";
import type { ExecServer } from "../../src/remote/execServerBridge";

function makeExecServer(files: Map<string, string>): ExecServer {
  return {
    tcpConnect: async () => {
      throw new Error("not used");
    },
    fs: {
      mkdirp: async () => {},
      write: async (p: string) => {
        let content = "";
        return {
          stream: {
            write: (d: Uint8Array) => {
              content += Buffer.from(d).toString("utf-8");
            },
            end: () => {
              files.set(p, content);
            },
          },
          done: Promise.resolve(),
        };
      },
      read: async (p: string) => {
        if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
        const text = files.get(p)!;
        return {
          onDidReceiveMessage: (cb: (d: Uint8Array) => void) => {
            cb(new Uint8Array(Buffer.from(text)));
          },
          onEnd: Promise.resolve(),
        };
      },
      stat: async () => ({ type: 1, size: 0, mtime: 0, ctime: 0 }),
      rm: async (p: string) => {
        files.delete(p);
      },
      rename: async () => {},
      readdir: async () => [],
    },
  } as unknown as ExecServer;
}

describe("configFileIO", () => {
  afterEach(() => setActiveExecServer(undefined));

  it("reads, writes, and removes via the ExecServer when active", async () => {
    const files = new Map([
      ["/home/dev/.devcontainer/devcontainer.json", '{"image":"x"}'],
    ]);
    setActiveExecServer(makeExecServer(files));

    expect(
      await readConfigFileText("/home/dev/.devcontainer/devcontainer.json"),
    ).toBe('{"image":"x"}');

    const tmp = await writeTempConfigFile("artizo-override-1.json", '{"a":1}');
    expect(tmp).toBe("/tmp/artizo-override-1.json");
    expect(files.get(tmp)).toBe('{"a":1}');

    await removeTempConfigFile(tmp);
    expect(files.has(tmp)).toBe(false);
  });

  it("throws when the remote file is missing", async () => {
    setActiveExecServer(makeExecServer(new Map()));
    await expect(readConfigFileText("/nope.json")).rejects.toThrow("ENOENT");
  });
});