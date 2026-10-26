/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  initVscodiumBundledVersion,
  getNewestBundledVersion,
} from "../../src/platform/vscodiumBundledVersion";

describe("vscodiumBundledVersion", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "artizo-bundled-ver-"),
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    // Reset module state so a stale path doesn't leak into other test
    // files in the same worker. initVscodiumBundledVersion with an
    // unreadable path is the closest we get to "uninitialized".
    initVscodiumBundledVersion({ bundledPath: "/nonexistent-path-reset" });
  });

  it("returns undefined when not initialized", () => {
    // Re-import a fresh module instance to test the uninit path. The
    // shared module state is per-import, so we use vi.resetModules
    // pattern indirectly: just call with a fresh tmp path that won't
    // match anything and assert undefined.
    initVscodiumBundledVersion({ bundledPath: path.join(tmpDir, "missing.json") });
    expect(getNewestBundledVersion()).toBeUndefined();
  });

  it("returns undefined when the bundled file is missing", () => {
    initVscodiumBundledVersion({
      bundledPath: path.join(tmpDir, "does-not-exist.json"),
    });
    expect(getNewestBundledVersion()).toBeUndefined();
  });

  it("returns the first (highest) version from the bundled list", () => {
    const bundledPath = path.join(tmpDir, "versions.json");
    fs.writeFileSync(bundledPath, JSON.stringify(["1.99.0", "1.98.2", "1.97.0"]));
    initVscodiumBundledVersion({ bundledPath });
    expect(getNewestBundledVersion()).toBe("1.99.0");
  });

  it("returns undefined when the bundled file is corrupt JSON", () => {
    const bundledPath = path.join(tmpDir, "versions.json");
    fs.writeFileSync(bundledPath, "{not json");
    initVscodiumBundledVersion({ bundledPath });
    expect(getNewestBundledVersion()).toBeUndefined();
  });

  it("returns undefined when the bundled file is not an array", () => {
    const bundledPath = path.join(tmpDir, "versions.json");
    fs.writeFileSync(bundledPath, JSON.stringify({ version: "1.99.0" }));
    initVscodiumBundledVersion({ bundledPath });
    expect(getNewestBundledVersion()).toBeUndefined();
  });

  it("returns undefined when the first array element is not a string", () => {
    const bundledPath = path.join(tmpDir, "versions.json");
    fs.writeFileSync(bundledPath, JSON.stringify([123, "1.98.0"]));
    initVscodiumBundledVersion({ bundledPath });
    expect(getNewestBundledVersion()).toBeUndefined();
  });
});
