/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { safeExtractPath } from "../../src/extensions/vsixExtract";

describe("safeExtractPath", () => {
  const target = path.resolve("/tmp/artizo-ext");

  it("resolves a normal file entry inside the target", () => {
    const result = safeExtractPath(target, "package.json");
    expect(result).toBe(path.join(target, "package.json"));
  });

  it("resolves a nested entry inside the target", () => {
    const result = safeExtractPath(target, "out/main.js");
    expect(result).toBe(path.join(target, "out", "main.js"));
  });

  it("rejects a parent-traversal entry (zip slip)", () => {
    expect(safeExtractPath(target, "../evil.sh")).toBeNull();
  });

  it("rejects a deep parent-traversal entry", () => {
    expect(safeExtractPath(target, "../../../../home/user/.bashrc")).toBeNull();
  });

  it("rejects an absolute path escape", () => {
    // An absolute POSIX path resolves away from the target on POSIX; on
    // Windows a drive-relative path likewise escapes.
    const escape =
      process.platform === "win32" ? "C:\\Windows\\evil" : "/etc/passwd";
    expect(safeExtractPath(target, escape)).toBeNull();
  });

  it("rejects entries that traverse out and back via a sibling prefix", () => {
    // `..\artizo-ext-evil` shares the target's basename as a prefix but is a
    // different directory - must not be treated as inside.
    expect(safeExtractPath(target, "../artizo-ext-evil/x")).toBeNull();
  });
});
