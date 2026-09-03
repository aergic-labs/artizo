/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync, readlinkSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createTar, tarDirectory } from "../../src/utils/tar";

/**
 * Round-trip tarDirectory -> `tar -x` and verify the extracted tree
 * preserves paths, file modes, directory entries, and symlinks.
 *
 * Uses the system `tar` to extract (available on macOS/Linux; on Windows
 * CI this test is skipped if tar is missing).
 */
function haveTar(): boolean {
  const r = spawnSync("tar", ["--version"], { stdio: "ignore" });
  return r.status === 0;
}

function buildSourceTree(root: string): void {
  // <root>/dir/sub/file.txt
  mkdirSync(join(root, "dir", "sub"), { recursive: true });
  writeFileSync(join(root, "dir", "sub", "file.txt"), "hello\n");
  // <root>/dir/exec.sh (0o755)
  writeFileSync(join(root, "dir", "exec.sh"), "#!/bin/sh\n");
  // <root>/dir/sub/empty/  (dir entry)
  mkdirSync(join(root, "dir", "sub", "empty"), { recursive: true });
  // <root>/link -> dir/sub/file.txt (symlink, skipped on Windows)
  if (process.platform !== "win32") {
    symlinkSync(join("dir", "sub", "file.txt"), join(root, "link"));
  }
}

describe("tar", () => {
  const canTar = haveTar();

  describe("createTar", () => {
    it("builds a tar containing a regular file with the given mode", () => {
      const src = mkdtempSync(join(tmpdir(), "artizo-tar-"));
      const f = join(src, "a.txt");
      writeFileSync(f, "abc");
      const buf = createTar([{ name: "a.txt", hostPath: f, mode: 0o644 }]);
      // 1 header (512) + 3 bytes content + padding to 512 + 2 zero blocks
      // Total = 512 + 512 + 1024 = 2048
      expect(buf.length).toBe(2048);
      rmSync(src, { recursive: true, force: true });
    });
  });

  describe("tarDirectory", () => {
    it("forces deterministic modes by entry type, not host stat (issue #11)", () => {
      const src = mkdtempSync(join(tmpdir(), "artizo-tar-modes-"));
      mkdirSync(join(src, "sub"));
      writeFileSync(join(src, "sub", "f.txt"), "abc");
      const buf = tarDirectory(src);
      // Parse the two headers: sub/ (dir) and sub/f.txt (file).
      // Mode field is bytes 100-107, octal, space/NUL terminated.
      const readMode = (off: number) =>
        parseInt(
          buf.toString("utf-8", off + 100, off + 108).replace(/[\0 ]/g, ""),
          8,
        );
      expect(readMode(0)).toBe(0o755); // sub/
      expect(readMode(512)).toBe(0o644); // sub/f.txt
      rmSync(src, { recursive: true, force: true });
    });
    it.skipIf(!canTar)(
      "round-trips through `tar -x` preserving paths, modes, and symlinks",
      () => {
        const src = mkdtempSync(join(tmpdir(), "artizo-tar-src-"));
        const dst = mkdtempSync(join(tmpdir(), "artizo-tar-dst-"));
        try {
          buildSourceTree(src);

          const buf = tarDirectory(src);

          // Extract on the host using the system tar.
          // Windows: mkdtempSync returns a drive-letter path with
          // backslashes (C:\...); GNU tar reads the colon as a remote-host
          // specifier and backslashes as escapes. Normalize to forward
          // slashes and add --force-local to be safe.
          const dstArg = dst.split("\\").join("/");
          const tarArgs = ["-xC", dstArg];
          if (process.platform === "win32") tarArgs.unshift("--force-local");
          const r = spawnSync("tar", tarArgs, { input: buf });
          expect(r.status).toBe(0);

          // File content
          expect(readFileSync(join(dst, "dir", "sub", "file.txt"), "utf-8")).toBe(
            "hello\n",
          );

          // Exec mode preserved (Unix-only; Windows NTFS has no exec bit)
          const execStat = lstatSync(join(dst, "dir", "exec.sh"));
          if (process.platform !== "win32") {
            expect(execStat.mode & 0o111).not.toBe(0);
          } else {
            expect(execStat.isFile()).toBe(true);
          }

          // Empty directory entry preserved
          const emptyStat = lstatSync(join(dst, "dir", "sub", "empty"));
          expect(emptyStat.isDirectory()).toBe(true);

          // Symlink preserved (skipped on win32 in buildSourceTree)
          if (process.platform !== "win32") {
            expect(readlinkSync(join(dst, "link"))).toBe(
              join("dir", "sub", "file.txt"),
            );
          }
        } finally {
          rmSync(src, { recursive: true, force: true });
          rmSync(dst, { recursive: true, force: true });
        }
      },
    );
  });
});
