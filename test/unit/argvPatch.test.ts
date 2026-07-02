/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { patchArgvContent, applyArgvPatch } from "../../src/host/argvPatch";

const EXT = "aergic.artizo-vscodium";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "artizo-argv-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("patchArgvContent", () => {
  it("adds enable-proposed-api when absent, preserving comments", () => {
    const input = '{\n\t// keep me\n\t"locale": "en"\n}\n';
    const result = patchArgvContent(input, EXT);
    expect(result).not.toBeNull();
    expect(result!.changed).toBe(true);
    expect(result!.patched).toContain("// keep me");
    expect(result!.patched).toContain('"locale": "en"');
    expect(result!.patched).toContain(EXT);
  });

  it("appends to an existing array without dropping entries or comments", () => {
    const input =
      '{\n\t// c\n\t"enable-proposed-api": ["existing.ext"]\n}\n';
    const result = patchArgvContent(input, EXT);
    expect(result).not.toBeNull();
    expect(result!.patched).toContain("existing.ext");
    expect(result!.patched).toContain(EXT);
    expect(result!.patched).toContain("// c");
  });

  it("returns null when the id is already present (idempotent)", () => {
    const input = `{\n\t"enable-proposed-api": ["${EXT}"]\n}\n`;
    expect(patchArgvContent(input, EXT)).toBeNull();
  });

  it("does not corrupt a value containing comment-like characters", () => {
    // The old regex-strip approach would have mangled this URL.
    const input = '{\n\t"someUrl": "https://example.com/a//b"\n}\n';
    const result = patchArgvContent(input, EXT);
    expect(result).not.toBeNull();
    expect(result!.patched).toContain("https://example.com/a//b");
    expect(result!.patched).toContain(EXT);
  });
});

describe("applyArgvPatch", () => {
  it("creates the file (and parent dir) when no candidate exists", () => {
    const target = path.join(tmpDir, ".vscodium-oss", "argv.json");
    const result = applyArgvPatch(EXT, [target]);
    expect(result.created).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.path).toBe(target);
    const written = fs.readFileSync(target, "utf-8");
    expect(JSON.parse(written)["enable-proposed-api"]).toEqual([EXT]);
  });

  it("patches the first existing candidate, leaving comments intact", () => {
    const dir = path.join(tmpDir, ".vscode-oss");
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, "argv.json");
    fs.writeFileSync(target, '{\n\t// hello\n\t"locale": "fr"\n}\n', "utf-8");

    const missing = path.join(tmpDir, ".other", "argv.json");
    const result = applyArgvPatch(EXT, [missing, target]);
    expect(result.path).toBe(target);
    expect(result.created).toBe(false);
    expect(result.changed).toBe(true);
    const written = fs.readFileSync(target, "utf-8");
    expect(written).toContain("// hello");
    expect(written).toContain(EXT);
    // The first (missing) candidate must not have been created.
    expect(fs.existsSync(missing)).toBe(false);
  });

  it("is a no-op write when the id is already present", () => {
    const target = path.join(tmpDir, "argv.json");
    const original = `{\n\t"enable-proposed-api": ["${EXT}"]\n}\n`;
    fs.writeFileSync(target, original, "utf-8");
    const before = fs.statSync(target).mtimeMs;
    const result = applyArgvPatch(EXT, [target]);
    expect(result.changed).toBe(false);
    expect(fs.readFileSync(target, "utf-8")).toBe(original);
    // No rewrite, so mtime is unchanged.
    expect(fs.statSync(target).mtimeMs).toBe(before);
  });

  it("throws when given no candidates", () => {
    expect(() => applyArgvPatch(EXT, [])).toThrow();
  });
});
