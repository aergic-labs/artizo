/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import vscodeMock from "../__mocks__/vscode";

vi.mock("vscode", () => ({ default: vscodeMock, ...vscodeMock }));

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
import {
  batchModeArgs,
  sshEnvForAskpass,
  startAskpass,
} from "../../src/ssh/askpass";

function restoreConfigMock() {
  vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
    get: vi.fn((_key: string, defaultValue: unknown) => defaultValue),
    update: vi.fn().mockResolvedValue(undefined),
  } as any);
}

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
    expect(env!.AERGIC_SSH_ASKPASS_HANDLE).toBe("/tmp/askpass.sock");
    expect(env!.AERGIC_SSH_ASKPASS_TOKEN).toBe("tok-123");
    expect(env!.AERGIC_SSH_ASKPASS_NODE).toBe("/usr/bin/node");
    expect(env!.AERGIC_SSH_ASKPASS_MAIN).toBe("/scripts/askpass-main.js");
  });

  it("includes process.env in the result", () => {
    const handle = {
      server: { handle: "/tmp/sock", token: "tok" } as any,
      askpassScript: "/askpass.sh",
      askpassMain: "/askpass-main.js",
      nodePath: "/node",
    };

    const env = sshEnvForAskpass(handle);
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
