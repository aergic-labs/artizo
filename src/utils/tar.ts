/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Minimal tar creator (zero deps).
 *
 * Used by ContainerBootstrap (server tool deployment) and
 * ExtensionInstaller (streaming extension files into the container
 * via `docker exec -i tar -xC`). Pure TypeScript — no host-side `tar`
 * binary needed, works on Windows/macOS/Linux apex.
 */

import { readFileSync, readdirSync, lstatSync, readlinkSync } from "node:fs";
import { join, relative, sep } from "node:path";

const BLOCK = 512;

export type TarEntryType = "file" | "dir" | "symlink";

export interface TarEntry {
  name: string;
  hostPath: string;
  mode: number; // octal, e.g. 0o755
  type?: TarEntryType; // defaults to "file"
  linkTarget?: string; // for symlinks
}

export function createTar(entries: TarEntry[]): Buffer {
  const chunks: Buffer[] = [];

  for (const entry of entries) {
    const type: TarEntryType = entry.type ?? "file";
    const content = type === "file" ? readFileSync(entry.hostPath) : Buffer.alloc(0);
    const header = Buffer.alloc(BLOCK, 0);
    header.write(entry.name.slice(0, 100), 0, 100, "utf-8"); // name
    header.write(oct(entry.mode, 7), 100, 8, "utf-8"); // mode
    header.write(oct(0, 7), 108, 8, "utf-8"); // uid
    header.write(oct(0, 7), 116, 8, "utf-8"); // gid
    const size = type === "file" ? content.length : 0;
    header.write(oct(size, 11), 124, 12, "utf-8"); // size
    header.write(oct(Math.floor(Date.now() / 1000), 11), 136, 12, "utf-8"); // mtime
    const typeflag = type === "file" ? "0" : type === "dir" ? "5" : "1";
    header.write(typeflag, 156, 1, "utf-8"); // typeflag
    if (type === "symlink" && entry.linkTarget) {
      header.write(entry.linkTarget.slice(0, 100), 157, 100, "utf-8"); // linkname
    }
    header.write("ustar\0", 257, 6, "utf-8"); // magic
    header.write(oct(checksum(header), 6), 148, 7, "utf-8"); // checksum

    chunks.push(header);
    if (type === "file") {
      chunks.push(content);
      const rem = size % BLOCK;
      if (rem > 0) chunks.push(Buffer.alloc(BLOCK - rem, 0));
    }
  }

  // Two zero blocks = end of archive
  chunks.push(Buffer.alloc(BLOCK * 2, 0));

  return Buffer.concat(chunks);
}

/**
 * Build a tar of an entire directory tree, preserving relative paths,
 * file modes, directory entries, and symlinks. Files land owned by
 * whatever user the `docker exec` runs as.
 */
export function tarDirectory(dirPath: string): Buffer {
  const entries: TarEntry[] = [];

  function walk(dir: string): void {
    for (const item of readdirSync(dir)) {
      const fullPath = join(dir, item);
      const stat = lstatSync(fullPath);
      const relPath = relative(dirPath, fullPath).split(sep).join("/");
      // Modes are forced by entry type, not taken from host stat: the
      // apex filesystem's modes are wrong for the container (Windows stat
      // gives directories 666 - no execute bit - which makes extracted
      // dirs non-traversable; see issue #11). VSIX publishers' own modes
      // carry no signal either (all regular files, no execute bits).
      // createTar callers that build entries by hand (bootstrap.ts)
      // still specify explicit modes.
      if (stat.isSymbolicLink()) {
        entries.push({
          name: relPath,
          hostPath: fullPath,
          mode: 0o777,
          type: "symlink",
          linkTarget: readlinkSync(fullPath),
        });
      } else if (stat.isDirectory()) {
        entries.push({
          name: relPath + "/",
          hostPath: fullPath,
          mode: 0o755,
          type: "dir",
        });
        walk(fullPath);
      } else if (stat.isFile()) {
        entries.push({
          name: relPath,
          hostPath: fullPath,
          mode: 0o644,
          type: "file",
        });
      }
    }
  }

  walk(dirPath);
  return createTar(entries);
}

function oct(num: number, len: number): string {
  const s = num.toString(8);
  return "0".repeat(Math.max(0, len - s.length)) + s + "\0";
}

function checksum(header: Buffer): number {
  // Checksum field (bytes 148-155) is treated as spaces during calculation
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) {
    sum += i >= 148 && i < 156 ? 32 : header[i];
  }
  return sum;
}
