/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Config-file URIs for the vendored CLI.
 *
 * The CLI picks its document reader by URI scheme
 * (`spec-configuration/editableFiles.ts`): `file:` is read with the CLI's own
 * local filesystem, `vscode-fileHost` is read through its `FileHost` (the
 * `CLIHost`). In a UI-only extension the local filesystem is the apex, so a
 * remote devcontainer.json passed as `file:` comes back "not found".
 *
 * `vscode-fileHost` is the CLI's own convention: `getDefaultDevContainerConfigPath`
 * and `getDevContainerConfigPathIn` build config URIs with that scheme for
 * every host type, local included. Use it unconditionally; nothing here should
 * depend on whether an ExecServer happens to be cached in this window.
 */

import { URI } from "vscode-uri";

/** Scheme the CLI routes through its `CLIHost`. */
export const CLIHOST_URI_SCHEME = "vscode-fileHost";

/** Build a config-file URI the CLI reads through its `CLIHost`. */
export function cliFileUri(path: string): URI {
  return URI.file(path).with({ scheme: CLIHOST_URI_SCHEME });
}