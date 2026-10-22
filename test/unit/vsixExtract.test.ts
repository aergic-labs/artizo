/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractVsix,
  unixModeFromEntry,
  safeExtractPath,
} from "../../src/extensions/vsixExtract";

/**
 * Build a VSIX-shaped zip with per-entry unix modes. yazl writes them to
 * `externalFileAttributes` and yauzl reads them back, same round-trip a
 * real VSIX goes through.
 */
async function buildVsix(
  entries: Array<{ path: string; content: string; mode?: number }>,
): Promise<string> {
  const yazl = await import("yazl");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "artizo-vsix-build-"));
  const zipPath = path.join(dir, "ext.vsix");
  const zw = new yazl.ZipFile();
  for (const e of entries) {
    const fileAbs = path.join(dir, e.path.replace(/\//g, "_"));
    fs.writeFileSync(fileAbs, e.content);
    // VSIX layout: real files live under `extension/`.
    zw.addFile(fileAbs, `extension/${e.path}`, e.mode ? { mode: e.mode } : undefined);
  }
  zw.end();
  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(zipPath);
    zw.outputStream.pipe(out);
    out.on("close", resolve);
    out.on("error", reject);
  });
  return zipPath;
}

describe("vsixExtract", () => {
  describe("unixModeFromEntry", () => {
    it("returns the unix mode from the upper 16 bits", () => {
      // 0o755 in upper 16 bits: (0o755 << 16) = 0x81ed0000
      expect(unixModeFromEntry({ externalFileAttributes: 0o755 << 16 })).toBe(
        0o755,
      );
      expect(unixModeFromEntry({ externalFileAttributes: 0o644 << 16 })).toBe(
        0o644,
      );
    });

    it("returns 0 when no unix mode is stored", () => {
      expect(unixModeFromEntry({ externalFileAttributes: 0 })).toBe(0);
      // Lower 16 bits (DOS attributes) are ignored.
      expect(unixModeFromEntry({ externalFileAttributes: 0x20 })).toBe(0);
    });
  });

  describe("safeExtractPath", () => {
    it("rejects zip-slip paths escaping the target dir", () => {
      const dir = mkdtempSync(join(tmpdir(), "artizo-vsix-safe-"));
      expect(safeExtractPath(dir, "../../etc/passwd")).toBeNull();
      rmSync(dir, { recursive: true, force: true });
    });

    it("accepts paths inside the target dir", () => {
      const dir = mkdtempSync(join(tmpdir(), "artizo-vsix-safe-"));
      expect(safeExtractPath(dir, "sub/file.txt")).toBe(
        join(dir, "sub/file.txt"),
      );
      rmSync(dir, { recursive: true, force: true });
    });
  });

  describe("extractVsix", () => {
    it("preserves executable bits from the zip's unix mode (issue #16)", async () => {
      const zipPath = await buildVsix([
        { path: "bin/java", content: "\u007fELF", mode: 0o755 },
        { path: "lib/jspawnhelper", content: "helper", mode: 0o755 },
        { path: "package.json", content: "{}", mode: 0o644 },
      ]);
      const target = mkdtempSync(join(tmpdir(), "artizo-vsix-ext-"));
      try {
        const result = await extractVsix(zipPath, target);
        expect(result.dir).toBe(target);
        // The two bundled binaries must be reported as executable.
        expect(result.executableRelPaths.has("bin/java")).toBe(true);
        expect(result.executableRelPaths.has("lib/jspawnhelper")).toBe(true);
        // package.json must NOT be executable.
        expect(result.executableRelPaths.has("package.json")).toBe(false);

        // File contents land at the target root (extension/ stripped).
        expect(readFileSync(join(target, "bin/java"), "utf-8")).toBe(
          "\u007fELF",
        );
        expect(readFileSync(join(target, "package.json"), "utf-8")).toBe("{}");

        // On Unix apex, the chmod round-trips through stat; on Windows it
        // does not (NTFS has no exec bit), so only assert the on-disk mode
        // where the OS supports it.
        if (process.platform !== "win32") {
          expect(statSync(join(target, "bin/java")).mode & 0o111).not.toBe(0);
          expect(statSync(join(target, "package.json")).mode & 0o111).toBe(0);
        }
      } finally {
        rmSync(target, { recursive: true, force: true });
        rmSync(join(zipPath, ".."), { recursive: true, force: true });
      }
    });

    it("returns an empty executableRelPaths set for a zip with no exec bits", async () => {
      const zipPath = await buildVsix([
        { path: "plain.txt", content: "hi", mode: 0o644 },
      ]);
      const target = mkdtempSync(join(tmpdir(), "artizo-vsix-plain-"));
      try {
        const result = await extractVsix(zipPath, target);
        expect(result.executableRelPaths.size).toBe(0);
        expect(readFileSync(join(target, "plain.txt"), "utf-8")).toBe("hi");
      } finally {
        rmSync(target, { recursive: true, force: true });
        rmSync(join(zipPath, ".."), { recursive: true, force: true });
      }
    });
  });
});
