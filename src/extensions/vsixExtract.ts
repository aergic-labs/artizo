/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * VSIX (ZIP) extraction using yauzl.
 *
 * Shared by the devcontainer extension installer (extracts to temp,
 * then `docker cp` into the container) and the SSH side-load (extracts
 * to temp, then `workspace.fs.copy` to the remote).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type yauzl from "yauzl";

/**
 * Extract a VSIX (ZIP) file to a target directory using yauzl.
 *
 * VSIX files are ZIP archives whose layout is:
 *   extension/<actual files...>
 *   extension.vsixmanifest
 *   [Content_Types].xml
 *
 * VS Code expects the *contents* of `extension/` to be at the target
 * root. The manifest and Content_Types files are ZIP packaging metadata,
 * not part of the runtime extension - strip them.
 *
 * Extracting on the apex means the target (container or SSH remote)
 * never needs `unzip` or any other extraction tool.
 */
export async function extractVsix(
  vsixPath: string,
  targetDir: string,
): Promise<string> {
  const yauzl = await import("yauzl");

  return new Promise<string>((resolve, reject) => {
    fs.mkdirSync(targetDir, { recursive: true });

    yauzl.open(
      vsixPath,
      { lazyEntries: true },
      (err: Error | null, zipfile: yauzl.ZipFile | null | undefined) => {
        if (err) {
          reject(new Error(`Failed to open VSIX: ${err.message}`));
          return;
        }
        if (!zipfile) {
          reject(new Error("Failed to open VSIX: null zipfile"));
          return;
        }

        let pending = 0;
        let done = false;

        const finish = () => {
          if (!done && pending === 0) {
            done = true;
            resolve(targetDir);
          }
        };

        zipfile.on("entry", (entry: yauzl.Entry) => {
          // Skip directory entries - implicit in the file tree
          if (/\/$/.test(entry.fileName)) {
            zipfile.readEntry();
            return;
          }

          // Only extract entries under `extension/`. Skip VSIX packaging
          // metadata ([Content_Types].xml, *.vsixmanifest).
          if (!entry.fileName.startsWith("extension/")) {
            zipfile.readEntry();
            return;
          }

          // Strip the `extension/` prefix so package.json lands at the
          // target root, matching VS Code's expected on-disk layout.
          const relPath = entry.fileName.slice("extension/".length);
          if (!relPath) {
            zipfile.readEntry();
            return;
          }

          const destPath = path.join(targetDir, relPath);
          fs.mkdirSync(path.dirname(destPath), { recursive: true });

          zipfile.openReadStream(entry, (readErr, readStream) => {
            if (readErr) {
              reject(
                new Error(
                  `Failed to read entry ${entry.fileName}: ${readErr.message}`,
                ),
              );
              return;
            }
            const writeStream = fs.createWriteStream(destPath);
            pending++;
            writeStream.on("close", () => {
              pending--;
              finish();
            });
            writeStream.on("error", (writeErr) => {
              reject(
                new Error(
                  `Failed to write ${entry.fileName}: ${writeErr.message}`,
                ),
              );
            });
            readStream.pipe(writeStream);
            zipfile.readEntry();
          });
        });

        zipfile.on("end", () => {
          finish();
        });

        zipfile.on("error", (zipErr: Error) => {
          reject(new Error(`VSIX read error: ${zipErr.message}`));
        });

        zipfile.readEntry();
      },
    );
  });
}
