/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as path from "node:path";

const fsMock = vi.hoisted(() => ({
  mkdirSync: vi.fn(),
  appendFileSync: vi.fn(),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, ...fsMock };
});

const config = vi.hoisted(() => ({ fileLog: false }));

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({
      get: (key: string, dflt: unknown) =>
        key === "fileLog" ? config.fileLog : dflt,
    }),
  },
}));

import { Logger } from "../../src/utils/logger";

const HOME = path.join(path.sep, "home", "u");
const LOCAL = path.join(path.sep, "Users", "u", "AppData", "Local");
const XDG = path.join(path.sep, "xdg", "state");

const savedEnv = {
  LOCALAPPDATA: process.env.LOCALAPPDATA,
  XDG_STATE_HOME: process.env.XDG_STATE_HOME,
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
};

function expectedDir(): string {
  if (process.platform === "win32") return path.join(LOCAL, "artizo");
  if (process.platform === "darwin") {
    return path.join(HOME, "Library", "Application Support", "artizo");
  }
  return path.join(XDG, "artizo");
}

function mockChannel() {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    append: vi.fn(),
    appendLine: vi.fn(),
    show: vi.fn(),
    dispose: vi.fn(),
  };
}

beforeEach(() => {
  fsMock.mkdirSync.mockReset();
  fsMock.appendFileSync.mockReset();
  config.fileLog = false;
  process.env.LOCALAPPDATA = LOCAL;
  process.env.XDG_STATE_HOME = XDG;
  process.env.HOME = HOME;
  process.env.USERPROFILE = HOME;
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("Logger file logging", () => {
  it("creates nothing when file logging is off", () => {
    const logger = new Logger(mockChannel() as never);
    logger.info("hello");
    expect(fsMock.mkdirSync).not.toHaveBeenCalled();
    expect(fsMock.appendFileSync).not.toHaveBeenCalled();
  });

  it("creates the directory on the first write, not at construction", () => {
    config.fileLog = true;
    const logger = new Logger(mockChannel() as never);
    expect(fsMock.mkdirSync).not.toHaveBeenCalled();

    logger.info("first");
    expect(fsMock.mkdirSync).toHaveBeenCalledTimes(1);
    expect(fsMock.mkdirSync).toHaveBeenCalledWith(expectedDir(), {
      recursive: true,
    });

    logger.info("second");
    expect(fsMock.mkdirSync).toHaveBeenCalledTimes(1);
    expect(fsMock.appendFileSync).toHaveBeenCalledTimes(2);
  });
});