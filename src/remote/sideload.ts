/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Remote side-load bootstrap.
 *
 * When the extension activates UI-side on Windows in an SSH-remote window
 * (ExecutionTier.RemoteSSH, owner === "none"), the vendor SSH extension
 * has not installed us onto the remote host - so we can't drive Docker
 * there. This module copies our own extension folder onto the remote's
 * `~/.<vendor>-server/extensions/` directory via `workspace.fs`, mutates
 * the remote's `extensions.json` ledger, and reloads the window. After
 * reload, VS Code's extension scanner picks up the entry and boots us
 * natively in the remote extension host as a real workspace extension
 * with direct access to the SSH host's Docker socket.
 *
 * Verified end-to-end on Trae 2026-06-19: the scanner honors a manually
 * mutated `extensions.json` on `reloadWindow`, and the workspace-side
 * extension activates with `extensionKind === Workspace` on the SSH host.
 * See `plans/remaining-work.md` (State 4 side-load) for the full design.
 */

import * as vscode from "vscode";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { getLogger } from "../utils/logger";
import type { DetectedTier } from "../host/state";
import { getPlatformAdapter } from "../platform";
import {
  buildExtensionEntry,
  extensionFolderName,
  isExtensionInEntries,
  type TargetPlatform,
} from "../extensions/extensionRegistry";
import {
  apexTargetPlatform,
  canCopyFromApex,
  isPlatformSpecificTarget,
  unameToTargetPlatform,
} from "../extensions/platformDetect";
import { MarketplaceClient } from "../extensions/marketplaceClient";
import { extractVsix } from "../extensions/vsixExtract";
import { getArgvExtensionId } from "../host/services";
import {
  getRemoteExec,
  type RemoteExec,
  type RemoteExecResult,
} from "./remoteExec";

/** Marker file dropped into the side-loaded folder for loop prevention. */
const SIDELOAD_MARKER = ".artizo-sideloaded";

/**
 * Direct file-write diagnostic log. The bootstrap runs on the UI-side
 * exthost before initLogger() is called, so getLogger() returns a no-op
 * and every log call is silently dropped. This writes to a fixed path
 * so we can trace the bootstrap even when the logger isn't up yet.
 *
 * Writes to multiple paths so it works regardless of which exthost
 * (apex UI-side on Windows, or anywhere else) actually runs the bootstrap:
 *   - os.tmpdir()/artizo-sideload.log  (portable across platforms)
 *   - context.logPath/artizo-sideload.log  (canonical extension log dir,
 *     created on demand)
 *   - console.error  (last resort; Trae's exthost.log may not capture this)
 */
let DIAG_PATHS: string[] = [];
function diag(message: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${message}\n`;
  for (const p of DIAG_PATHS) {
    try {
      fs.appendFileSync(p, line);
    } catch {
      // Path may be on a host we can't reach; try the next one.
    }
  }
  // Last resort: console.error. Trae's exthost.log doesn't reliably
  // capture extension console output, but it's better than nothing.
  console.error(`[artizo-sideload] ${message}`);
}

/** Initialize diag log paths from the extension context. */
function initDiagPaths(context: vscode.ExtensionContext): void {
  const paths: string[] = [];
  // Always include os.tmpdir() - portable across Windows/Linux/macOS.
  try {
    paths.push(path.join(os.tmpdir(), "artizo-sideload.log"));
  } catch {
    // os.tmpdir() should never fail, but be safe.
  }
  // Also write to the extension's log directory if available. Trae
  // creates this per-window under .../exthost/<ext-id>/. The dir may
  // not exist yet on the UI-side bootstrap window; create it.
  try {
    const logPath = (context as unknown as { logPath?: string }).logPath;
    if (logPath) {
      try {
        fs.mkdirSync(logPath, { recursive: true });
      } catch {
        // May already exist, or may be unwritable. Proceed; appendFileSync
        // will fail per-path and we fall through to other paths.
      }
      paths.push(path.join(logPath, "artizo-sideload.log"));
    }
  } catch {
    // logPath access failed; we still have os.tmpdir().
  }
  DIAG_PATHS = paths;
  diag(`initDiagPaths: writing to ${paths.join(", ")}`);
}

// Cached remote platform. Lazily detected via `uname -ms` over SSH,
// only when a per-platform extension is encountered.
let cachedRemotePlatform: TargetPlatform | undefined;
let remotePlatformDetected = false;

/**
 * Detect the SSH remote's platform by running `uname -ms`.
 * Cached for the session. Bails hard on failure.
 */
async function detectRemotePlatform(
  remoteAuthority: string | undefined,
  exec: RemoteExec,
): Promise<TargetPlatform> {
  if (remotePlatformDetected) return cachedRemotePlatform;
  remotePlatformDetected = true;

  if (!remoteAuthority) {
    throw new Error("No remote authority for platform detection");
  }

  const log = getLogger();
  log.info(`sideload: detecting remote platform via remote exec`);

  let output: string;
  try {
    const result = await exec.run("uname -ms", { timeout: 10_000 });
    if (result.code !== 0) {
      throw new Error(`uname exited with ${result.code} stderr: ${result.stderr.trim()}`);
    }
    output = result.stdout;
  } catch (err) {
    throw new Error(
      `Failed to detect remote platform (uname -ms): ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    );
  }

  cachedRemotePlatform = unameToTargetPlatform(output);
  log.info(
    `sideload: remote platform=${cachedRemotePlatform} (uname: ${output.trim()})`,
  );
  return cachedRemotePlatform;
}

/**
 * Resolve the absolute path of `tar` on the apex. Present on Windows
 * (System32 bsdtar since 1803, plus git-bash), macOS, and Linux. Throws
 * if missing - tar is a hard requirement for the stream-copy path.
 */
function resolveTarBinary(): string {
  // On Windows prefer System32 bsdtar (handles both \ and / paths).
  if (process.platform === "win32") {
    const winTar = "C:\\Windows\\System32\\tar.exe";
    try {
      if (fs.existsSync(winTar)) return winTar;
    } catch {
      // fall through
    }
  }
  return "tar";
}

/**
 * Copy a local directory tree to a remote SSH path via tar over ssh.
 *
 * Two-phase approach for reliability on Windows where a direct
 * tar.stdout -> sshProc.stdin pipe can truncate the last bytes when tar
 * exits before ssh.exe has drained its stdin. Phase 1 writes a temp tar.gz
 * to apex disk (tar to a real file is reliable). Phase 2 streams that file
 * into ssh's stdin, which ssh reads to EOF cleanly.
 *
 * One ssh round trip for the whole tree, regardless of file count - avoids
 * the per-file latency of workspace.fs.copy over SSH.
 *
 * Assumes `tar` is present on both apex and remote. Windows ships bsdtar
 * since 1803; macOS and Linux always have it. SSH remotes without tar
 * are so rare we don't bother falling back.
 */
async function tarStreamToRemote(
  srcDir: string,
  remoteTargetPath: string,
  exec: RemoteExec,
  log: ReturnType<typeof getLogger>,
): Promise<void> {
  const tarBinary = resolveTarBinary();

  diag(`tarStream: src=${srcDir} remote=${remoteTargetPath}`);
  log.info(`sideload: tar stream ${srcDir} -> ${remoteTargetPath}`);

  // Phase 1: tar apex-local dir to a temp file.
  const tmpTar = path.join(
    os.tmpdir(),
    `artizo-stream-${Date.now()}-${process.pid}.tar.gz`,
  );
  try {
    execFileSync(tarBinary, ["czf", tmpTar, "."], {
      cwd: srcDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const size = fs.statSync(tmpTar).size;
    diag(`tarStream: temp tar ${size} bytes`);
    log.info(`sideload: tar built ${size} bytes`);
  } catch (err) {
    throw new Error(`tar create failed: ${(err as Error).message}`, {
      cause: err,
    });
  }

  // Phase 2: stream the temp file to the remote via exec.stdin.
  const escapedPath = remoteTargetPath.replace(/'/g, "'\\''");
  const remoteCmd = `mkdir -p '${escapedPath}' && tar xzf - -C '${escapedPath}'`;

  try {
    const input = fs.createReadStream(tmpTar);
    await exec.streamToStdin(remoteCmd, input);
    diag(`tarStream: done`);
    log.info("sideload: tar stream complete");
  } finally {
    try {
      fs.unlinkSync(tmpTar);
    } catch {
      // ignore
    }
  }
}

/**
 * Per-platform candidate server extension directories, relative to the
 * remote home. Returned by the platform adapter so only the current
 * build target's candidate ships in each vendor VSIX (guard-bundle.mjs
 * rejects builds that leak other vendor names).
 */
async function candidateRelDirs(): Promise<string[]> {
  const adapter = await getPlatformAdapter();
  return adapter.getRemoteExtensionsDirCandidates();
}

/**
 * Resolve the remote home directory.
 *
 * Strategy in order:
 *   1. Infer from the workspace URI path (works for `/home/<user>/...`).
 *   2. Cached home in globalState, keyed by SSH authority.
 *   3. Probe via `ssh <host> 'echo $HOME'` (one round trip).
 * The cache is populated on successful sideload and persists across
 * sessions via globalState.
 */
async function resolveRemoteHome(
  authority: string,
  wsPath: string | undefined,
  context: vscode.ExtensionContext,
  log: ReturnType<typeof getLogger>,
  exec: RemoteExec,
): Promise<string | undefined> {
  // 1. Path inference from the workspace folder.
  if (wsPath) {
    const segments = wsPath.split("/").filter(Boolean);
    if (segments.length >= 2) {
      return "/" + segments.slice(0, 2).join("/");
    }
  }

  // 2. Cache lookup.
  const cached = context.globalState.get<string>(homeCacheKey(authority));
  if (cached) {
    diag(`resolveRemoteHome: using cached home ${cached} for ${authority}`);
    return cached;
  }

  // 3. Probe via ssh `echo $HOME`.
  try {
    const probed = await probeRemoteHome(log, exec);
    if (probed) {
      diag(`resolveRemoteHome: ssh probe returned ${probed}`);
      await context.globalState.update(homeCacheKey(authority), probed);
      return probed;
    }
  } catch (err) {
    log.warn(
      `sideload: ssh home probe failed (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  return undefined;
}

/**
 * Probe the remote `$HOME` via a one-shot `ssh <host> 'echo $HOME'`.
 * Uses the same ssh binary + authority decoding as the tar stream and
 * platform detection paths. Returns the trimmed path or undefined.
 */
async function probeRemoteHome(
  log: ReturnType<typeof getLogger>,
  exec: RemoteExec,
): Promise<string | undefined> {
  log.info("sideload: probing remote $HOME");
  try {
    const result = await exec.run("echo $HOME", { timeout: 10_000 });
    if (result.code === 0 && result.stdout.trim()) {
      return result.stdout.trim();
    }
    log.warn(
      `sideload: home probe failed (exit=${result.code}) stderr: ${result.stderr}`,
    );
  } catch (err) {
    log.warn(
      `sideload: home probe failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return undefined;
}

/** Build a globalState key for caching remote home by SSH authority. */
function homeCacheKey(authority: string): string {
  return `remoteHome:${authority}`;
}

/**
 * Run a command on the remote SSH host and capture stdout/stderr/exit.
 * Resolves with {stdout, stderr, code}. Rejects only on spawn failure.
 *
 * When `stdinInput` is provided, it is written to the remote command's
 * stdin and the stream is closed. This lets callers pipe a script body
 * (e.g. `node -`) without shell-quoting it into the command string.
 *
 * Every step is logged via diag() so it lands in the persistent
 * artizo-sideload.log: the exact command, exit code, trimmed stdout,
 * trimmed stderr.
 */
function runRemoteCmd(
  remoteCmd: string,
  log: ReturnType<typeof getLogger>,
  timeoutMs: number,
  stdinInput: string | undefined,
  exec: RemoteExec,
): Promise<RemoteExecResult> {
  log.info(`sideload: remote exec: ${remoteCmd}`);
  diag(`runRemoteCmd: cmd=${remoteCmd}`);
  if (stdinInput !== undefined) {
    diag(`runRemoteCmd: piping ${stdinInput.length} bytes to stdin`);
  }
  return exec.run(remoteCmd, { stdin: stdinInput, timeout: timeoutMs }).then(
    (result) => {
      log.info(
        `sideload: exit=${result.code} stdout=${result.stdout.trim()} stderr=${result.stderr.trim()}`,
      );
      diag(
        `runRemoteCmd: exit=${result.code} stdout=${result.stdout.trim()} stderr=${result.stderr.trim()}`,
      );
      return result;
    },
  );
}

/**
 * Cached contents of the bundled remote argv patch script. Read once from
 * the dist directory alongside the bundled extension.
 */
let cachedPatchScript: string | undefined;
let patchScriptLoadAttempted = false;

/**
 * Load the bundled argv-patch-remote.cjs script from disk. It is emitted
 * by esbuild next to dist/extension/extension.js, so __dirname (dist/extension/
 * in the bundle) is the primary location; a dev/test fallback covers running
 * from source. Returns undefined if not found.
 */
function loadRemotePatchScript(): string | undefined {
  if (patchScriptLoadAttempted) return cachedPatchScript;
  patchScriptLoadAttempted = true;
  const candidates = [
    path.join(__dirname, "..", "argv-patch-remote.cjs"),
    path.join(__dirname, "argv-patch-remote.cjs"),
    path.join(process.cwd(), "dist", "argv-patch-remote.cjs"),
  ];
  for (const p of candidates) {
    try {
      const content = fs.readFileSync(p, "utf-8");
      cachedPatchScript = content;
      diag(`loadRemotePatchScript: loaded ${content.length} bytes from ${p}`);
      return cachedPatchScript;
    } catch {
      // Try the next candidate.
    }
  }
  diag(`loadRemotePatchScript: not found in ${candidates.join(", ")}`);
  return undefined;
}

/** Wrap a string in single quotes for safe use in a POSIX shell command. */
function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Patch argv.json on the remote SSH host before reloadWindow.
 *
 * Probes candidate data folder names (from the platform adapter) joined
 * with the resolved remote home, reads the first existing argv.json,
 * patches it with our extension ID in enable-proposed-api, and writes it
 * back atomically with fsync. Creates the file if none exists.
 *
 * The patch runs the bundled argv-patch-remote.cjs script (the same
 * jsonc-parser-based core as the apex-local path, so comments and
 * formatting are preserved) on the remote via `node -`, with the script
 * piped over ssh stdin and the extension ID + candidate paths passed as
 * argv. Piping the script (rather than `node -e '...'`) avoids any shell
 * quoting of the script body.
 *
 * Returns the patched argv.json path, or undefined if patching was
 * skipped (adapter doesn't need it, bundled script missing, or no node
 * on the remote) or all candidates failed.
 */
async function patchRemoteArgvJson(
  remoteHome: string,
  log: ReturnType<typeof getLogger>,
  exec: RemoteExec,
): Promise<string | undefined> {
  const adapter = await getPlatformAdapter();
  if (!adapter.needsArgvPatch()) {
    log.info("sideload: argv patch not needed for this adapter, skipping");
    diag("patchRemoteArgvJson: adapter does not need argv patch, skipping");
    return undefined;
  }

  const extensionId = getArgvExtensionId();
  const candidates = adapter
    .getArgvDataFolderNames()
    .map((name) => `${remoteHome}/${name}/argv.json`);
  log.info(`sideload: argv candidates=${JSON.stringify(candidates)}`);
  diag(
    `patchRemoteArgvJson: extId=${extensionId} candidates=${JSON.stringify(candidates)}`,
  );

  const script = loadRemotePatchScript();
  if (!script) {
    log.warn("sideload: bundled remote argv patch script missing; skipping");
    diag("patchRemoteArgvJson: bundled script not found, skipping");
    return undefined;
  }

  // Find node on the remote, then run `node -` so the script arrives on
  // stdin. The remote usually has no system node; the vendor's server
  // ships its own under ~/.<vendor>-server/bin/<commit>/node, which is
  // essentially always present, so probe that first and fall back to
  // system locations. Derive the server roots from the adapter's
  // extensions-dir candidates (per-vendor and tree-shaken, so only this
  // build's vendor dirs are searched). The script body is piped via
  // stdin (never interpolated); only the wrapper + argv are shell-quoted,
  // and the argv values (extension ID + derived paths) are single-quoted.
  const serverRoots = adapter
    .getRemoteExtensionsDirCandidates()
    .map((rel) => rel.replace(/\/extensions\/?$/, ""));
  const nodeSearch = [
    ...serverRoots.map((r) => `"\${HOME}"/${r}/bin/*/node`),
    "node",
    "/usr/bin/node",
    "/usr/local/bin/node",
  ];
  diag(`patchRemoteArgvJson: node search=[${nodeSearch.join(", ")}]`);
  const nodeProbe =
    `for n in ${nodeSearch.join(" ")}; do ` +
    `if [ -x "$n" ]; then echo "$n"; break; fi; done`;
  const argv = [extensionId, ...candidates].map(shellSingleQuote).join(" ");
  const remoteCmd =
    `NP=$(${nodeProbe}); ` +
    `if [ -z "$NP" ]; then echo "NO_NODE" >&2; exit 3; fi; ` +
    `"$NP" - ${argv}`;

  let result;
  try {
    result = await runRemoteCmd(
      remoteCmd,
      log,
      20_000,
      script,
      exec,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`sideload: remote argv patch spawn failed: ${msg}`);
    diag(`patchRemoteArgvJson: spawn failed: ${msg}`);
    return undefined;
  }

  if (result.code === 3 || result.stderr.includes("NO_NODE")) {
    log.warn("sideload: no node found on remote; skipping argv patch");
    diag("patchRemoteArgvJson: NO_NODE on remote, skipping");
    return undefined;
  }
  if (result.code !== 0) {
    log.warn(
      `sideload: remote argv patch failed code=${result.code} ` +
        `stderr=${result.stderr.trim()}`,
    );
    diag(
      `patchRemoteArgvJson: failed code=${result.code} stderr=${result.stderr.trim()}`,
    );
    return undefined;
  }
  const patchedPath = result.stdout.trim();
  log.info(`sideload: remote argv patched at ${patchedPath}`);
  diag(`patchRemoteArgvJson: success path=${patchedPath}`);
  return patchedPath;
}

/**
 * Kill any running remote VS Code server process so it restarts and
 * re-reads the patched argv.json. Targets processes with
 * `connection-token-file` in their command line (the marker arg the
 * server launcher passes). Returns the number of PIDs signaled.
 */
async function killRemoteServer(
  log: ReturnType<typeof getLogger>,
  exec: RemoteExec,
): Promise<number> {
  // pgrep -f is more portable than ps | grep. Fall back to ps if pgrep
  // is missing. We use pkill-style: list PIDs first so we can log them.
  const cmd =
    `pgrep -f connection-token-file 2>/dev/null || ` +
    `ps -eo pid=,args= 2>/dev/null | grep '[c]onnection-token-file' | awk '{print $1}'`;
  const result = await runRemoteCmd(
    cmd,
    log,
    10_000,
    undefined,
    exec,
  ).catch((err) => {
    log.warn(
      `sideload: killRemoteServer spawn failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return { stdout: "", stderr: "", code: 1 };
  });
  const pids = result.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (pids.length === 0) {
    log.info("sideload: no remote server process found to kill");
    diag("killRemoteServer: no PIDs found");
    return 0;
  }
  log.info(`sideload: killing remote server PIDs: ${pids.join(", ")}`);
  diag(`killRemoteServer: PIDs=${pids.join(", ")}`);
  const killCmd = `kill ${pids.join(" ")} 2>/dev/null; sleep 1; kill -9 ${pids.join(" ")} 2>/dev/null; true`;
  const killResult = await runRemoteCmd(
    killCmd,
    log,
    10_000,
    undefined,
    exec,
  ).catch(() => ({ stdout: "", stderr: "", code: null }));
  log.info("sideload: remote server kill issued");
  diag(`killRemoteServer: kill issued, exit=${killResult.code}`);
  return pids.length;
}

/**
 * Probe each candidate dir with `workspace.fs.readDirectory`; return the
 * first that exists. URIs are built with the `vscode-remote` scheme +
 * the remote authority so `workspace.fs` routes through the SSH file
 * system provider.
 */
async function findRemoteExtensionsDir(
  homePath: string,
  authority: string,
  log: ReturnType<typeof getLogger>,
  context: vscode.ExtensionContext,
): Promise<vscode.Uri | undefined> {
  const base = vscode.Uri.parse(`vscode-remote://${authority}/`);
  const candidates = await candidateRelDirs();
  for (const rel of candidates) {
    const candidate = base.with({ path: `${homePath}/${rel}` });
    try {
      await vscode.workspace.fs.readDirectory(candidate);
      log.info(`sideload: found extensions dir: ${candidate.toString()}`);
      await context.globalState.update(homeCacheKey(authority), homePath);
      return candidate;
    } catch (err) {
      log.info(
        `sideload: candidate missing: ${rel} (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }
  return undefined;
}

/**
 * Read the remote extensions.json, merge in the given entries (skipping
 * any already present by id or folder name), and write it back once.
 * Single read-modify-write so Trae's scanner sees one atomic change.
 */
async function commitExtensionsJson(
  extDir: vscode.Uri,
  newEntries: Array<{
    folderName: string;
    extId: string;
    version: string;
    publisherDisplayName: string;
    targetPlatform: string | undefined;
  }>,
  log: ReturnType<typeof getLogger>,
): Promise<void> {
  if (newEntries.length === 0) return;

  const jsonUri = vscode.Uri.joinPath(extDir, "extensions.json");

  let entries: unknown[];
  try {
    const raw = await vscode.workspace.fs.readFile(jsonUri);
    const text = new TextDecoder("utf-8").decode(raw);
    entries = JSON.parse(text);
    if (!Array.isArray(entries)) {
      log.warn(
        `sideload: extensions.json is not an array (got ${typeof entries}); overwriting`,
      );
      entries = [];
    }
  } catch (err) {
    log.info(
      `sideload: extensions.json read failed (${err instanceof Error ? err.message : String(err)}); seeding with []`,
    );
    entries = [];
  }

  let added = 0;
  for (const e of newEntries) {
    if (isExtensionInEntries(entries, e.extId, e.folderName)) {
      log.info(
        `sideload: ${e.extId} already in extensions.json; not re-adding`,
      );
      continue;
    }
    const folderPath = vscode.Uri.joinPath(extDir, e.folderName).path;
    const entry = buildExtensionEntry({
      extId: e.extId,
      version: e.version,
      folderPath,
      publisherDisplayName: e.publisherDisplayName,
      targetPlatform: e.targetPlatform as TargetPlatform | undefined,
    });
    entries.push(entry);
    added++;
  }

  if (added === 0) {
    log.info("sideload: no new entries to add to extensions.json");
    return;
  }

  const encoded = new TextEncoder().encode(JSON.stringify(entries, null, 2));
  await vscode.workspace.fs.writeFile(jsonUri, encoded);
  log.info(`sideload: committed ${added} entries to extensions.json`);
}

/** Check whether the side-load marker exists in the target folder. */
async function markerExists(
  extDir: vscode.Uri,
  folderName: string,
): Promise<boolean> {
  const markerUri = vscode.Uri.joinPath(extDir, folderName, SIDELOAD_MARKER);
  try {
    await vscode.workspace.fs.stat(markerUri);
    return true;
  } catch {
    return false;
  }
}

/**
 * Mirror locally-installed UI extensions to the SSH remote.
 *
 * Copy-vs-download decision per extension:
 *   1. Universal (no per-platform builds): copy from apex-local.
 *      Apex arch doesn't matter for universal extensions.
 *   2. Per-platform, apex arch == remote arch: copy from apex-local.
 *   3. Per-platform, apex arch != remote arch: download fresh for
 *      the remote's platform (apex has internet, remote may not).
 *
 * Arch detection is lazy: only runs `uname -ms` over SSH when the
 * first per-platform extension is encountered. Cached for the session.
 */
interface ApexExtensionEntry {
  extId: string;
  version: string;
  relativeLocation: string;
  targetPlatform: string | undefined;
  publisherDisplayName: string;
  extensionUuid: string | undefined;
  publisherUuid: string | undefined;
}

/**
 * Read the apex's extensions.json ledger from disk and return entries
 * for user-installed extensions (excluding built-ins and Artizo).
 *
 * We can't use vscode.extensions.all because on the apex UI-side
 * exthost it only lists extensions loaded into that process -
 * workspace-kind extensions (hex editor, lua, etc) are installed on
 * disk but not loaded there, so they'd be invisible. Reading the disk
 * ledger matches what the workbench's "Local - Installed" view shows.
 */
async function readApexInstalledExtensions(
  log: ReturnType<typeof getLogger>,
): Promise<ApexExtensionEntry[]> {
  const adapter = await getPlatformAdapter();
  const apexDir = adapter.getApexExtensionsDir();
  diag(`mirror: apex extensions dir=${apexDir}`);
  const jsonPath = path.join(apexDir, "extensions.json");

  let raw: string;
  try {
    raw = fs.readFileSync(jsonPath, "utf-8");
  } catch (err) {
    diag(
      `mirror: could not read apex extensions.json at ${jsonPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    log.warn(
      `sideload: could not read apex extensions.json at ${jsonPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }

  let entries: unknown[];
  try {
    entries = JSON.parse(raw);
    if (!Array.isArray(entries)) {
      diag(`mirror: apex extensions.json is not an array`);
      log.warn("sideload: apex extensions.json is not an array");
      return [];
    }
  } catch (err) {
    diag(
      `mirror: apex extensions.json parse failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    log.warn(
      `sideload: apex extensions.json parse failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }

  diag(`mirror: apex extensions.json has ${entries.length} entries`);

  const out: ApexExtensionEntry[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as {
      identifier?: { id?: string; uuid?: string };
      version?: string;
      relativeLocation?: string;
      location?: { path?: string };
      metadata?: {
        targetPlatform?: string;
        publisherDisplayName?: string;
        publisherId?: string;
        id?: string;
      };
    };
    const extId = e.identifier?.id;
    if (!extId) continue;
    // Skip built-ins (vscode.* prefix) and Artizo itself.
    // Note: ms-vscode.* (e.g. hexeditor) is a marketplace publisher,
    // distinct from vscode.* built-ins - keep those.
    if (extId.startsWith("vscode.")) continue;
    if (/^aergic\.artizo-/.test(extId)) continue;
    const version = e.version ?? "0.0.0";
    const relativeLocation =
      e.relativeLocation ??
      e.location?.path?.split(/[\\/]/).pop() ??
      `${extId}-${version}`;
    const targetPlatform = e.metadata?.targetPlatform;
    const publisherDisplayName =
      e.metadata?.publisherDisplayName ?? extId.split(".")[0];
    out.push({
      extId,
      version,
      relativeLocation,
      targetPlatform,
      publisherDisplayName,
      extensionUuid: e.identifier?.uuid ?? e.metadata?.id,
      publisherUuid: e.metadata?.publisherId,
    });
  }

  diag(`mirror: ${out.length} apex extensions after filter`);
  for (const e of out) {
    diag(
      `  mirror candidate: id=${e.extId} version=${e.version} platform=${e.targetPlatform ?? "none"} rel=${e.relativeLocation}`,
    );
  }
  return out;
}

async function mirrorLocalExtensions(
  extDir: vscode.Uri,
  log: ReturnType<typeof getLogger>,
  remoteAuthority: string | undefined,
  selfEntry: {
    folderName: string;
    extId: string;
    version: string;
    publisherDisplayName: string;
    targetPlatform: string | undefined;
  },
  report: (message: string, inc?: number) => void,
  exec: RemoteExec,
): Promise<void> {
  // Enumerate apex-installed extensions from disk. vscode.extensions.all
  // on the UI-side exthost doesn't list workspace-kind extensions that
  // aren't loaded into that process (hex editor, lua, etc), so we read
  // the disk ledger directly - matches what the workbench's
  // "Local - Installed" view shows.
  const localExts = await readApexInstalledExtensions(log);
  diag(`mirror: localExts.length=${localExts.length}`);

  diag(`mirror: mirroring ${localExts.length} local extensions to remote`);
  log.info(
    `sideload: mirroring ${localExts.length} local extensions to remote`,
  );

  const adapter = await getPlatformAdapter();
  const apexDir = adapter.getApexExtensionsDir();
  diag(`mirror: apex extensions dir=${apexDir}`);

  // Marketplace client for downloading platform-specific VSIXs.
  const marketplace = new MarketplaceClient();
  diag(`mirror: apexTargetPlatform=${apexTargetPlatform() ?? "undefined"}`);

  let copied = 0;
  let downloaded = 0;
  let skipped = 0;
  const pendingEntries: Array<{
    folderName: string;
    extId: string;
    version: string;
    publisherDisplayName: string;
    targetPlatform: string | undefined;
  }> = [selfEntry];
  diag(`mirror: queued self entry for extensions.json commit`);
  for (const ext of localExts) {
    const { extId, version, relativeLocation, publisherDisplayName } = ext;
    const extPlatform: string | undefined = ext.targetPlatform;
    const isPlatformSpecific = isPlatformSpecificTarget(extPlatform);
    diag(
      `mirror: processing extId=${extId} version=${version} extPlatform=${extPlatform ?? "none"} isPlatformSpecific=${isPlatformSpecific}`,
    );

    // Determine if we can copy from apex-local.
    let canCopyLocal = true;
    let remotePlatform: TargetPlatform | undefined;
    if (isPlatformSpecific) {
      diag(`mirror: ${extId} platform-specific, detecting remote platform`);
      try {
        remotePlatform = await detectRemotePlatform(remoteAuthority, exec);
        diag(
          `mirror: ${extId} remotePlatform=${remotePlatform ?? "undefined"}`,
        );
      } catch (err) {
        diag(
          `mirror: ${extId} detectRemotePlatform THREW: ${err instanceof Error ? err.message : String(err)}; skipping`,
        );
        log.warn(
          `sideload: could not detect remote platform for ${extId}: ${
            err instanceof Error ? err.message : String(err)
          }; skipping`,
        );
        continue;
      }
      // Shared copy-vs-download decision (see platformDetect.ts).
      canCopyLocal = canCopyFromApex(true, remotePlatform);
      diag(
        `mirror: ${extId} canCopyLocal=${canCopyLocal} (apex=${apexTargetPlatform() ?? "undefined"} remote=${remotePlatform ?? "undefined"})`,
      );
    } else {
      diag(`mirror: ${extId} not platform-specific, canCopyLocal=true`);
    }

    const effectivePlatform = canCopyLocal ? extPlatform : remotePlatform;
    const folderName = extensionFolderName(extId, version, effectivePlatform);
    const targetFolder = vscode.Uri.joinPath(extDir, folderName);
    diag(
      `mirror: ${extId} folderName=${folderName} effectivePlatform=${effectivePlatform ?? "none"}`,
    );

    // Check if already present on remote (idempotent). If the folder
    // exists we still queue an extensions.json entry - the commit
    // dedupes by id/folderName, so re-runs after a partial state are
    // safe.
    try {
      await vscode.workspace.fs.stat(targetFolder);
      diag(`mirror: ${extId} folder already present on remote`);
      skipped++;
    } catch {
      diag(`mirror: ${extId} folder not present on remote, proceeding`);
    }

    try {
      if (canCopyLocal) {
        diag(`mirror: ${extId} copying from apex-local`);
        report(`copying ${extId}...`);
        const srcPath = path.join(apexDir, relativeLocation);
        diag(`mirror: ${extId} src=${srcPath} dst=${targetFolder.path}`);
        await tarStreamToRemote(
          srcPath,
          targetFolder.path,
          exec,
          log,
        );
        copied++;
        diag(`mirror: ${extId} tar stream succeeded`);
        log.info(`sideload: mirrored ${extId} v${version}`);
      } else {
        diag(`mirror: ${extId} downloading fresh for ${remotePlatform}`);
        report(`downloading ${extId}...`);
        const meta = await marketplace.getExtensionInfo(extId, remotePlatform);
        diag(`mirror: ${extId} got metadata`);
        const tmpVsix = await marketplace.downloadFromMetadata(
          meta,
          os.tmpdir(),
        );
        diag(`mirror: ${extId} downloaded vsix=${tmpVsix}`);
        const extractDir = path.join(
          os.tmpdir(),
          `artizo-ext-${extId}-${Date.now()}`,
        );
        try {
          await extractVsix(tmpVsix, extractDir);
          diag(`mirror: ${extId} extracted to ${extractDir}`);
          report(`installing ${extId}...`);
          await tarStreamToRemote(
            extractDir,
            targetFolder.path,
            exec,
            log,
          );
          downloaded++;
          diag(`mirror: ${extId} tar stream from extract succeeded`);
          log.info(
            `sideload: downloaded ${extId} v${version} for ${remotePlatform}`,
          );
        } finally {
          try {
            fs.unlinkSync(tmpVsix);
          } catch {
            // Ignore
          }
          try {
            fs.rmSync(extractDir, { recursive: true, force: true });
          } catch {
            // Ignore
          }
        }
      }

      // Queue for a single batched extensions.json write at the end.
      pendingEntries.push({
        folderName,
        extId,
        version,
        publisherDisplayName,
        targetPlatform: effectivePlatform,
      });
      diag(`mirror: ${extId} queued for extensions.json commit`);
    } catch (err) {
      diag(
        `mirror: ${extId} THREW: ${err instanceof Error ? err.message : String(err)}`,
      );
      log.warn(
        `sideload: failed to mirror ${extId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  diag(
    `mirror: copy phase complete - ${copied} copied, ${downloaded} downloaded, ${skipped} already present`,
  );
  log.info(
    `sideload: mirror copy phase - ${copied} copied, ${downloaded} downloaded, ${skipped} already present`,
  );

  // Single read-modify-write for all entries.
  diag(
    `mirror: committing ${pendingEntries.length} entries to extensions.json`,
  );
  await commitExtensionsJson(extDir, pendingEntries, log);
  diag(`mirror: extensions.json commit done`);

  diag(
    `mirror: complete - ${copied} copied, ${downloaded} downloaded, ${skipped} already present`,
  );
  log.info(
    `sideload: mirror complete - ${copied} copied, ${downloaded} downloaded, ${skipped} already present`,
  );
}

/**
 * Bootstrap the extension onto the SSH remote host.
 *
 * Steps:
 *   1. Resolve the remote extensions dir via platform adapter candidates.
 *   2. Copy `context.extensionUri` (the installed extension folder) to
 *      `<remoteExtDir>/<id>-<version>/` via `workspace.fs.copy`. Skipped
 *      if the marker file is already present (idempotent re-run).
 *   3. Write the marker file for loop prevention.
 *   4. Mutate `extensions.json` to register the side-loaded extension.
 *   5. Reload the window. The remote extension host re-scans and boots
 *      us natively as a workspace extension on the SSH host.
 *
 * The `status` item is updated in place so the user sees progress (the
 * sidebar is hidden during bootstrap - see the `when` clause on the
 * activity bar entry in `package.json`).
 *
 * Loop prevention: the bootstrap branch in `activate()` is gated on
 * `detected.owner === "none"`, which is only true when
 * `extensionKind === UI` on a RemoteSSH tier. After reload, the
 * extension activates with `extensionKind === Workspace` on the SSH
 * host, so `owner === "workspace"` and the bootstrap is skipped. The
 * marker file is belt-and-suspenders: it lets us skip the copy step on
 * a re-run (e.g. user reloads the pre-side-load window again before the
 * post-side-load window has activated).
 */
export async function bootstrapRemoteSideLoad(
  context: vscode.ExtensionContext,
  _detected: DetectedTier,
  status: vscode.StatusBarItem,
  progress: vscode.Progress<{ message?: string; increment?: number }>,
): Promise<void> {
  initDiagPaths(context);
  diag(`=== bootstrapRemoteSideLoad start ===`);
  diag(
    `apex process.platform=${process.platform} process.arch=${process.arch}`,
  );
  diag(`apex vscode.env.appRoot=${vscode.env.appRoot}`);
  diag(`apex vscode.env.remoteName=${vscode.env.remoteName ?? "none"}`);
  diag(
    `apex vscode.env.remoteAuthority=${(vscode.env as any).remoteAuthority ?? "none"}`,
  );
  diag(`workspaceFolders=${vscode.workspace.workspaceFolders?.length ?? 0}`);

  const log = getLogger();
  const report = (message: string, inc?: number) => {
    progress.report({ message, increment: inc });
    status.text = `$(loading~spin) Artizo: ${message}`;
  };

  // Detect ExecServer first; fall back to ssh + askpass. When ExecServer
  // is available, no ssh is spawned and no askpass server starts.
  const rawAuthority = (vscode.env as any).remoteAuthority as
    | string
    | undefined;
  if (!rawAuthority) {
    diag(`THROW: no remote authority`);
    throw new Error(
      "No SSH remote authority. Connect to an SSH remote first.",
    );
  }
  const authority = rawAuthority;
  const { exec, askpass } = await getRemoteExec(
    authority,
    context.extensionPath,
  );
  try {
    diag(`authority=${authority}`);

    // 1. Resolve remote home and extensions dir.
    const wsPath = vscode.workspace.workspaceFolders?.[0]?.uri.path;
    diag(`wsPath=${wsPath ?? "undefined"}`);
    const homePath = await resolveRemoteHome(
      authority,
      wsPath,
      context,
      log,
      exec,
    );
    diag(`remote home=${homePath ?? "undefined"}`);
    log.info(`sideload: resolved remote home=${homePath ?? "undefined"}`);
    if (!homePath) {
      diag(`THROW: no homePath`);
      throw new Error(
        "Could not resolve remote home directory. " +
          "Ensure `ssh <host> 'echo $HOME'` works from your apex machine.",
      );
    }

    const extDir = await findRemoteExtensionsDir(
      homePath,
      authority,
      log,
      context,
    );
    diag(`extDir=${extDir?.toString() ?? "undefined"}`);
    if (!extDir) {
      const candidates = await candidateRelDirs();
      diag(`THROW: no extDir, candidates=${candidates.join(",")}`);
      throw new Error(
        "Could not find a remote extensions directory. Probed: " +
          candidates.join(", "),
      );
    }

    // 2. Compute target folder name.
    const extId = context.extension.id;
    const version = context.extension.packageJSON.version;
    const publisherDisplayName: string =
      context.extension.packageJSON.publisher ?? extId.split(".")[0];
    const targetPlatform: string | undefined =
      context.extension.packageJSON.__metadata?.targetPlatform;
    const folderName = extensionFolderName(extId, version, targetPlatform);
    const targetFolderUri = vscode.Uri.joinPath(extDir, folderName);
    diag(
      `self extId=${extId} version=${version} targetPlatform=${targetPlatform ?? "none"}`,
    );
    diag(`self target folder=${targetFolderUri.toString()}`);
    log.info(`sideload: extId=${extId} version=${version}`);
    log.info(`sideload: target folder=${targetFolderUri.toString()}`);

    // 3. Copy the installed extension folder to the remote. Skip if the
    //    marker already exists (idempotent re-run).
    const alreadyThere = await markerExists(extDir, folderName);
    diag(`marker alreadyThere=${alreadyThere}`);
    if (alreadyThere) {
      diag(`skipping self-copy, marker present`);
      log.info(
        `sideload: marker present at ${targetFolderUri.toString()}; skipping copy`,
      );
    } else {
      report("copying Artizo to remote...");
      diag(
        `self-copy: ${context.extensionUri.toString()} -> ${targetFolderUri.toString()}`,
      );
      log.info(
        `sideload: copying ${context.extensionUri.toString()} -> ${targetFolderUri.toString()}`,
      );
      const t0 = Date.now();
      // Stream the apex extension folder to the remote via tar over ssh.
      // Much faster than workspace.fs.copy for trees with many files
      // (per-file round trip vs one streamed archive).
      try {
        await tarStreamToRemote(
          context.extensionUri.fsPath,
          targetFolderUri.path,
          exec,
          log,
        );
      } catch (err) {
        diag(
          `THROW in self-copy: ${err instanceof Error ? err.message : String(err)}`,
        );
        throw err;
      }
      const elapsed = Date.now() - t0;
      diag(`self-copy done in ${elapsed}ms`);
      log.info(`sideload: copy done in ${elapsed}ms`);

      // Write the marker file so we can detect the side-load on
      // re-activation and skip re-copying.
      const markerUri = vscode.Uri.joinPath(targetFolderUri, SIDELOAD_MARKER);
      try {
        await vscode.workspace.fs.writeFile(
          markerUri,
          new TextEncoder().encode(`sideloaded ${new Date().toISOString()}\n`),
        );
      } catch (err) {
        diag(
          `THROW writing marker: ${err instanceof Error ? err.message : String(err)}`,
        );
        throw err;
      }
      diag(`wrote marker ${markerUri.toString()}`);
      log.info(`sideload: wrote marker ${markerUri.toString()}`);
    }

    // 4. Queue self entry for the single batched extensions.json write
    //    that mirrorLocalExtensions will do at the end.
    status.text = "$(settings-gear) Artizo: preparing on remote host...";
    report("preparing extensions...");
    const selfEntry = {
      folderName,
      extId,
      version,
      publisherDisplayName,
      targetPlatform,
    };
    diag(`queued self entry for extensions.json commit`);

    // 5. Mirror local extensions to the remote. SSH remotes may lack
    //    internet access, so VSIXs are copied from the apex. When
    //    disabled, we still commit our own entry to extensions.json.
    const mirrorEnabled = vscode.workspace
      .getConfiguration("artizo.remote.ssh")
      .get<boolean>("mirrorExtensions", false);
    if (mirrorEnabled) {
      status.text = "$(cloud~upload) Artizo: mirroring extensions to remote...";
      diag(`calling mirrorLocalExtensions, authority=${authority}`);
      try {
        await mirrorLocalExtensions(
          extDir,
          log,
          authority,
          selfEntry,
          report,
          exec,
        );
        diag(`mirrorLocalExtensions returned without throw`);
      } catch (err) {
        diag(
          `THROW in mirrorLocalExtensions: ${err instanceof Error ? err.message : String(err)}`,
        );
        throw err;
      }
    } else {
      diag(`mirror disabled by config, committing self entry only`);
      log.info("sideload: mirror disabled, committing self entry only");
      await commitExtensionsJson(extDir, [selfEntry], log);
    }

    // 6. Patch argv.json, then kill the server so it restarts with the
    //    patched argv on reload. Avoids the activation-time patch prompt.
    diag(`patchRemoteArgvJson start, remoteHome=${homePath}`);
    log.info(`sideload: patching remote argv.json (home=${homePath})`);
    report("patching remote argv.json...");
    const argvPath = await patchRemoteArgvJson(
      homePath,
      log,
      exec,
    );
    diag(`patchRemoteArgvJson result=${argvPath ?? "undefined"}`);
    if (argvPath) {
      log.info(`sideload: argv patched at ${argvPath}, killing server`);
      report("restarting remote server...");
      const killed = await killRemoteServer(log, exec);
      diag(`killRemoteServer killed=${killed}`);
      // Don't wait for the server. The vendor SSH extension relaunches
      // it on reconnect. The reload below brings it back.
      if (killed === 0) {
        log.info(
          "sideload: no server process to kill; argv will be read on next restart",
        );
      }
    } else {
      log.info(
        "sideload: remote argv patch skipped or failed; workspace-side patch will run on activation",
      );
    }

    // 7. Reload. Killing the server dropped the connection; reload
    //    re-establishes it before the connection-lost modal settles.
    diag(`reloadWindow`);
    log.info("sideload: reloadWindow");
    report("reloading window...");
    status.text = "$(loading~spin) Artizo: reloading window...";
    vscode.commands.executeCommand("workbench.action.reloadWindow");
  } catch (err) {
    // Evict host passwords so a retry re-prompts instead of reusing
    // a bad password.
    if (askpass?.server.usedHostPassword) {
      diag(`evicting host password cache entries`);
      askpass.server.evictHostPasswords();
    }
    throw err;
  } finally {
    // Stop the askpass server.
    await askpass?.server.stop().catch(() => {
      /* best effort */
    });
  }
}

// --- Test-only exports (not part of the public API) ---
export const __test = {
  diag,
  initDiagPaths,
  homeCacheKey,
  candidateRelDirs,
  resolveTarBinary,
  markerExists,
  resolveRemoteHome,
  probeRemoteHome,
  findRemoteExtensionsDir,
  commitExtensionsJson,
  runRemoteCmd,
  detectRemotePlatform,
  patchRemoteArgvJson,
  killRemoteServer,
  loadRemotePatchScript,
  shellSingleQuote,
  readApexInstalledExtensions,
  resetRemotePlatformCache: () => {
    cachedRemotePlatform = undefined;
    remotePlatformDetected = false;
  },
  resetPatchScriptCache: () => {
    cachedPatchScript = undefined;
    patchScriptLoadAttempted = false;
  },
  SIDELOAD_MARKER,
};
