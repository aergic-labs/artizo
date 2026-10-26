/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Download busybox-static binaries from Alpine CDN.
 *
 * Usage: node scripts/download-busybox.mjs [--arch=x86_64,aarch64] [--alpine=3.23]
 *
 * Extracts bin/busybox.static from each .apk and writes to tools/busybox/.
 * Uses only Node.js built-ins; no shell, tar, or curl required.
 */

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { get } from "node:https";
import { gunzipSync } from "node:zlib";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEST_DIR = `${ROOT}/tools/busybox`;

// Alpine CDN arch -> our runtime arch (matches validateArch in serverManager.ts)
const ALPINE_TO_RUNTIME = {
  x86_64: "x64",
  aarch64: "arm64",
};

// CLI args

const args = process.argv.slice(2);
const alpineVer = parseArg("--alpine") ?? "3.23";
const archList = (parseArg("--arch") ?? "x86_64,aarch64").split(",");

function parseArg(flag) {
  for (const a of args) {
    if (a.startsWith(`${flag}=`)) return a.slice(flag.length + 1);
    if (a === flag) {
      const i = args.indexOf(a);
      return args[i + 1]?.startsWith("-") ? undefined : args[i + 1];
    }
  }
  return undefined;
}

// HTTP helper

function download(url) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    get(url, (res) => {
      if (!res.statusCode || res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
        return;
      }
      // Follow redirects
      if (res.statusCode >= 300 && res.headers.location) {
        resolve(download(res.headers.location));
        return;
      }
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject);
  });
}

// APK / tar.gz extraction

/**
 * Extract a single named file from a gzipped tar (APK format).
 *
 * Each tar entry is a 512-byte header followed by ceil(size, 512) bytes of data.
 */
function extractFromTarGz(gzBuf, targetPath) {
  const buf = gunzipSync(gzBuf);
  let pos = 0;
  const BLOCK = 512;

  while (pos + BLOCK <= buf.length) {
    const name = buf.toString("utf-8", pos, pos + 100).replace(/\0.*/, "");
    if (name === "") break; // end of archive (two zero blocks)

    // Parse size from octal in header bytes 124-135
    const sizeStr = buf
      .toString("utf-8", pos + 124, pos + 136)
      .replace(/\0.*/, "");
    const size = parseInt(sizeStr, 8) || 0;
    pos += BLOCK;

    if (name === targetPath) {
      return buf.subarray(pos, pos + size);
    }

    // Skip data blocks (padded to 512)
    pos += Math.ceil(size / BLOCK) * BLOCK;
  }

  return null;
}

/**
 * Parse the APKINDEX to find the version of busybox-static.
 * Format: multiple entries separated by blank lines.
 * Each entry: P:package\nV:version\n...lines...
 */
function parseBusyboxVersion(indexTarGz) {
  // APKINDEX.tar.gz contains a single file called APKINDEX
  const entry = extractFromTarGz(indexTarGz, "APKINDEX");
  if (!entry) throw new Error("APKINDEX file not found in APKINDEX.tar.gz");
  const text = entry.toString("utf-8");
  const chunks = text.split(/\n\n+/);
  for (const chunk of chunks) {
    if (!chunk.includes("P:busybox-static")) continue;
    const match = chunk.match(/^V:(.+)$/m);
    if (match) return match[1].trim();
  }
  throw new Error("busybox-static not found in APKINDEX");
}

// Main

// Windows AV (Defender et al.) briefly locks a freshly-written executable
// while it scans it, which surfaces as `UNKNOWN: unknown error, open ...` on
// the next writeFile of a binary in the same directory. Retry with backoff so
// a transient scan doesn't fail the whole package build.
async function writeBinary(dest, buf) {
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await writeFile(dest, buf, { mode: 0o755 });
      return;
    } catch (err) {
      lastErr = err;
      // Retry on the Windows-flaky open errors; bail on anything else.
      const code = err?.code;
      if (
        code !== "UNKNOWN" &&
        code !== "EBUSY" &&
        code !== "EPERM" &&
        code !== "EACCES"
      ) {
        throw err;
      }
      await sleep(250 * Math.pow(2, attempt));
    }
  }
  throw lastErr;
}

async function main() {
  await mkdir(DEST_DIR, { recursive: true });

  const cdn = `https://dl-cdn.alpinelinux.org/alpine/v${alpineVer}/main`;

  for (const alpineArch of archList) {
    const runtimeArch = ALPINE_TO_RUNTIME[alpineArch] ?? alpineArch;
    console.log(`${alpineArch} -> bb-${runtimeArch}`);

    if (alpineArch === "x86_64") {
      await resolveLocal(runtimeArch);
    } else {
      await resolveRemote(alpineArch, runtimeArch, cdn);
    }
  }
}

async function resolveRemote(alpineArch, runtimeArch, cdn) {
  const indexUrl = `${cdn}/${alpineArch}/APKINDEX.tar.gz`;
  process.stdout.write(`  Fetching index... `);
  const indexBuf = await download(indexUrl);
  const ver = parseBusyboxVersion(indexBuf);
  console.log(`busybox-static ${ver}`);

  const apkUrl = `${cdn}/${alpineArch}/busybox-static-${ver}.apk`;
  process.stdout.write(`  Downloading apk... `);
  const apkBuf = await download(apkUrl);

  const binary = extractFromTarGz(apkBuf, "bin/busybox.static");
  if (!binary) throw new Error("bin/busybox.static not found in apk");

  await writeBinary(`${DEST_DIR}/bb-${runtimeArch}`, binary);
  console.log(`done (${(binary.length / 1024 / 1024).toFixed(1)} MB)`);
}

/**
 * Copy busybox.static from local Alpine system (APK installs to /bin).
 * Falls back to remote download if not found locally.
 */
async function resolveLocal(runtimeArch) {
  try {
    const buf = await readFile("/bin/busybox.static");
    await writeBinary(`${DEST_DIR}/bb-${runtimeArch}`, buf);
    console.log(`  busybox-static -> tools/busybox/bb-${runtimeArch} (local)`);
    console.log(`  done (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
  } catch {
    await resolveRemote(
      "x86_64",
      runtimeArch,
      `https://dl-cdn.alpinelinux.org/alpine/v${alpineVer}/main`,
    );
  }
}

main().catch((err) => {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});
