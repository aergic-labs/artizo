/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Standalone entry bundled to dist/argv-patch-remote.cjs and pushed over
 * ssh stdin to `node -` on the SSH remote (see patchRemoteArgvJson in
 * sideload.ts). It patches the remote's argv.json with our extension ID
 * using the exact same jsonc-parser-based core as the apex-local path,
 * so comments and formatting are preserved.
 *
 * Args (after `node -`):
 *   argv[2]    extension ID to add to enable-proposed-api
 *   argv[3..]  candidate argv.json paths, in priority order
 *
 * On success prints the chosen path to stdout and exits 0. On error
 * prints a message to stderr and exits non-zero.
 */

import { applyArgvPatch } from "../host/argvPatch";

function main(): void {
  const extId = process.argv[2];
  const candidates = process.argv.slice(3);
  if (!extId || candidates.length === 0) {
    process.stderr.write("usage: node - <extId> <candidate...>\n");
    process.exit(2);
  }
  try {
    const result = applyArgvPatch(extId, candidates);
    process.stderr.write(
      `argv: path=${result.path} changed=${result.changed} created=${result.created}\n`,
    );
    process.stdout.write(`${result.path}\n`);
  } catch (err) {
    process.stderr.write(
      `argv: ERROR ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(2);
  }
}

main();
