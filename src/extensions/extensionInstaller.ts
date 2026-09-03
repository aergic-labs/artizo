/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Extension installer for dev containers.
 *
 * Installs extensions from devcontainer.json into the container.
 * Downloads VSIX files on the host (apex) so containers without
 * outbound internet access still work, extracts them on the apex
 * using yauzl (no `unzip` needed in the container), then streams the
 * extracted directory tree into the container's server extensions
 * directory via `docker exec -i tar -xC` (no `docker cp` — files land
 * owned by the container's remoteUser, not root).
 *
 * Dependency resolution: Open VSX metadata includes `dependencies`
 * (hard deps, won't activate without them) and `bundledExtensions`
 * (extension packs). Both are fetched transitively, deduplicated, and
 * installed in dependency-first order.
 */

import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import type { Host } from "../host/host";
import {
  MarketplaceClient,
  type MarketplaceClientOptions,
  type ExtensionMetadata,
} from "./marketplaceClient";
import { extractExtensionIds } from "./extensionClassifier";
import {
  buildExtensionEntry,
  extensionFolderName,
  type TargetPlatform,
} from "./extensionRegistry";
import { extractVsix } from "./vsixExtract";
import {
  canCopyFromApex,
  dockerArchToTargetPlatform,
  hasPlatformVariants,
} from "./platformDetect";
import { getLogger } from "../utils/logger";
import {
  dockerInspect,
  dockerInspectImage,
  dockerSpawn,
  childPipes,
} from "../utils/dockerUtils";
import { tarDirectory } from "../utils/tar";

/**
 * Default path inside the container where extensions are installed.
 * Each platform adapter's server uses a `.<name>-server/extensions`
 * convention; the installer resolves this dynamically from the
 * adapter when not explicitly overridden.
 */
export const DEFAULT_EXTENSIONS_INSTALL_PATH = "~/.artizo-server/extensions";

/**
 * Result of installing a single extension.
 */
export interface ExtensionInstallResult {
  id: string;
  success: boolean;
  error?: string;
}

/**
 * Provider for locally-installed extensions on the apex. Returns
 * the install path for an extension id, or undefined if not installed.
 * Used for the copy-from-apex fast path.
 */
export type LocalExtensionProvider = (extId: string) => string | undefined;

/**
 * Progress sink for extension installation. Receives the same
 * "[extensions] ..." lines as the diagnostic logger, so callers can surface
 * them where the user is looking (e.g. the build log terminal).
 */
export type ExtensionInstallProgress = (text: string) => void;

/**
 * Options for the extension installer.
 */
export interface ExtensionInstallerOptions {
  dockerPath?: string;
  marketplaceOptions?: MarketplaceClientOptions;
  host: Host;
  /**
   * Override the container-side extensions directory (tests).
   * In production this is resolved via `getUserExtensionsDir` from
   * ServerManager, ensuring the installer and server agree.
   */
  extensionsDir?: string;
  /**
   * Provider for the container-side user extensions directory.
   * Wired to `ServerManager.getUserExtensionsDir()` in production so
   * the installer and server share one source of truth.
   */
  getUserExtensionsDir?: (containerId: string) => Promise<string>;
  /**
   * Provider for locally-installed extensions (copy-from-apex path).
   * Defaults to a no-op provider (always download).
   */
  localExtensionProvider?: LocalExtensionProvider;
}

/**
 * Install extensions into a running container.
 */
export class ExtensionInstaller {
  private readonly dockerPath: string;
  private readonly host: Host;
  private readonly marketplace: MarketplaceClient;
  private readonly extensionsDirOverride: string | undefined;
  private readonly extensionsDirProvider:
    | ((containerId: string) => Promise<string>)
    | undefined;
  private readonly localExtensionProvider: LocalExtensionProvider;
  // Cache of resolved target platform per container ID. Avoids
  // repeated docker inspect calls within a single install batch.
  private readonly platformCache = new Map<string, TargetPlatform>();
  // Cache of apex-local extension paths by id. Avoids repeated
  // filesystem scans when installing multiple extensions.
  private localExtCache = new Map<string, string | undefined>();

  constructor(options: ExtensionInstallerOptions) {
    this.dockerPath = options?.dockerPath ?? "docker";
    this.host = options.host;
    this.marketplace = new MarketplaceClient(options?.marketplaceOptions);
    this.extensionsDirOverride = options?.extensionsDir;
    this.extensionsDirProvider = options?.getUserExtensionsDir;
    this.localExtensionProvider =
      options?.localExtensionProvider ?? (() => undefined);
  }

  /**
   * Resolve the container-side extensions directory.
   *
   * Explicit override (tests) -> provider (ServerManager in production)
   * -> throw. The provider is wired so the installer and server share
   * one source of truth and can never diverge.
   */
  private async resolveExtensionsDir(containerId: string): Promise<string> {
    if (this.extensionsDirOverride) return this.extensionsDirOverride;
    if (this.extensionsDirProvider) {
      return this.extensionsDirProvider(containerId);
    }
    throw new Error(
      "ExtensionInstaller has no extensions dir provider or override",
    );
  }

  /**
   * Resolve the target platform for a container by inspecting its image.
   * Cached per container ID for the session. Only called when an
   * extension has per-platform builds (lazy).
   */
  private async resolveTargetPlatform(
    containerId: string,
  ): Promise<TargetPlatform> {
    const cached = this.platformCache.get(containerId);
    if (cached) return cached;

    const log = getLogger();
    // Container inspect gives us the image reference; image inspect
    // gives us the architecture fields. Two calls, but only once per
    // container per session.
    const containerInfo = await dockerInspect(containerId, {
      dockerPath: this.dockerPath,
    });
    const imageRef = containerInfo.config.image;
    log.info(`[extensions] inspecting image "${imageRef}" for platform`);
    const imgInfo = await dockerInspectImage(imageRef, {
      dockerPath: this.dockerPath,
    });
    const platform = dockerArchToTargetPlatform(
      imgInfo.architecture,
      imgInfo.os,
      imgInfo.variant,
    );
    log.info(
      `[extensions] container ${containerId} platform=${platform} ` +
        `(arch=${imgInfo.architecture} os=${imgInfo.os} variant=${imgInfo.variant ?? "-"})`,
    );
    this.platformCache.set(containerId, platform);
    return platform;
  }

  /**
   * Find a locally-installed extension on the apex that is valid for
   * the target. Returns the extension path or undefined. Used for the
   * copy-from-apex fast path (avoids download when the apex already
   * has a valid VSIX for the target platform).
   *
   * The caller already checked that copying is valid (universal
   * extension, or apex arch matches target). This just finds the path.
   */
  private findLocalExtension(extId: string): string | undefined {
    const cached = this.localExtCache.get(extId);
    if (cached !== undefined) return cached;

    const found = this.localExtensionProvider(extId);
    this.localExtCache.set(extId, found);
    return found;
  }

  /**
   * Install all extensions specified in a devcontainer.json config into the container.
   *
   * @param containerId - The Docker container ID
   * @param config - The parsed devcontainer.json object
   * @returns Array of results for each extension installation attempt
   */
    async installFromConfig(
      containerId: string,
      config: Record<string, unknown>,
      remoteUser?: string,
      onLog?: ExtensionInstallProgress,
    ): Promise<ExtensionInstallResult[]> {
      const extensionIds = extractExtensionIds(config);
      if (extensionIds.length === 0) {
        // Diagnose why nothing was extracted: which config keys the
        // installer actually saw (issue #11).
        const customizations = config.customizations as
          | Record<string, unknown>
          | undefined;
        const vscode = customizations?.vscode as
          | Record<string, unknown>
          | undefined;
        this.emit(
          onLog,
          `no extension ids in config ` +
            `(customizations: ${!!customizations}, ` +
            `customizations.vscode: ${!!vscode}, ` +
            `customizations.vscode.extensions: ${Array.isArray(vscode?.extensions)}, ` +
            `legacy extensions: ${Array.isArray(config.extensions)})`,
        );
      } else {
        this.emit(
          onLog,
          `found ${extensionIds.length} extension(s) in config: ` +
            extensionIds.join(", "),
        );
      }
      return this.installExtensions(
        containerId,
        extensionIds,
        remoteUser,
        onLog,
      );
    }

    /** Emit an install-progress line to the diagnostic logger and, when
     * provided, the caller's progress sink (e.g. the build log). */
    private emit(
      onLog: ExtensionInstallProgress | undefined,
      text: string,
    ): void {
      getLogger().info(`[extensions] ${text}`);
      onLog?.(`[extensions] ${text}`);
    }

  /**
   * Install a list of extensions by ID into the container.
   *
   * Resolves dependencies transitively, deduplicates, and installs in
   * dependency-first order.
   *
   * @param containerId - The Docker container ID
   * @param extensionIds - Array of extension IDs (e.g., ["publisher.extension-name"])
   * @returns Array of results for each extension installation attempt
   */
  async installExtensions(
    containerId: string,
    extensionIds: string[],
    remoteUser?: string,
    onLog?: ExtensionInstallProgress,
  ): Promise<ExtensionInstallResult[]> {
    if (extensionIds.length === 0) {
      this.emit(onLog, "no extensions to install");
      return [];
    }

    const log = getLogger();
    const extensionsDir = await this.resolveExtensionsDir(containerId);
    this.emit(onLog, `extensions dir: ${extensionsDir}`);

    // Resolve the full dependency tree, dedup, topo-sort so deps come first.
    // Target platform is resolved lazily: only fetched from docker inspect
    // when at least one extension in the tree has per-platform builds.
    const ordered = await this.resolveDependencyTree(extensionIds);

    // Determine whether any extension has platform variants. If none do,
    // skip the docker inspect call entirely (the common case).
    const needsPlatform = ordered.some((m) => hasPlatformVariants(m));
    let targetPlatform: TargetPlatform | undefined;
    if (needsPlatform) {
      try {
        targetPlatform = await this.resolveTargetPlatform(containerId);
        // Re-fetch metadata for platform-specific extensions so the
        // downloadUrl and targetPlatform fields reflect the target.
        for (let i = 0; i < ordered.length; i++) {
          if (!hasPlatformVariants(ordered[i])) continue;
          const id = `${ordered[i].namespace}.${ordered[i].name}`;
          try {
            ordered[i] = await this.marketplace.getExtensionInfo(
              id,
              targetPlatform,
            );
          } catch (err) {
            log.warn(
              `[extensions] could not re-fetch ${id} for ${targetPlatform}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }
      } catch (err) {
        log.warn(
          `[extensions] could not resolve container platform: ${
            err instanceof Error ? err.message : String(err)
          }; falling back to universal`,
        );
      }
    }

    if (ordered.length > extensionIds.length) {
      const orderedIds = ordered.map((m) => `${m.namespace}.${m.name}`);
      const extra = orderedIds.filter((id) => !extensionIds.includes(id));
      this.emit(
        onLog,
        `resolved ${ordered.length} extensions to install ` +
          `(${extensionIds.length} requested + ${extra.length} dependencies): ` +
          extra.join(", "),
      );
    } else {
      this.emit(
        onLog,
        `installing ${ordered.length} extensions: ` +
          ordered.map((m) => `${m.namespace}.${m.name}`).join(", "),
      );
    }

    // Ensure the extensions directory exists in the container
    await this.ensureExtensionsDir(containerId, extensionsDir, remoteUser);

    const results: ExtensionInstallResult[] = [];

    for (const meta of ordered) {
      const result = await this.installSingleExtension(
        containerId,
        meta,
        extensionsDir,
        targetPlatform,
        remoteUser,
        onLog,
      );
      results.push(result);
    }

    return results;
  }

  /**
   * Resolve the full dependency tree for a set of extension IDs.
   *
   * Fetches metadata for each extension, follows `dependencies`
   * (hard deps) and `bundledExtensions` (extension packs)
   * transitively, deduplicates, and returns a topologically-sorted
   * list where dependencies appear before their dependents.
   */
  private async resolveDependencyTree(
    rootIds: string[],
  ): Promise<ExtensionMetadata[]> {
    const visited = new Set<string>();
    const byId = new Map<string, ExtensionMetadata>();
    // Track IDs that failed metadata fetch so we can still attempt
    // their install (and report the failure) rather than throwing.
    const failed = new Map<string, string>();

    const visit = async (id: string): Promise<void> => {
      if (visited.has(id)) return;
      visited.add(id);

      let meta: ExtensionMetadata;
      try {
        meta = await this.marketplace.getExtensionInfo(id);
      } catch (err) {
        // Metadata fetch failed - mark as failed so we still attempt
        // install (which will re-try the download and report the
        // error). Don't recurse into unknown deps.
        failed.set(id, err instanceof Error ? err.message : String(err));
        return;
      }
      byId.set(id, meta);

      // Recurse into dependencies (hard deps) and bundled extensions
      // (extension packs). Both must be installed for the parent to
      // fully function.
      const children = [...meta.dependencies, ...meta.bundledExtensions];
      for (const childId of children) {
        await visit(childId);
      }
    };

    // Fetch all metadata (depth-first)
    for (const id of rootIds) {
      await visit(id);
    }

    // Topological sort: a node's dependencies must come before it.
    const sorted: ExtensionMetadata[] = [];
    const added = new Set<string>();

    const addNode = (id: string, stack: Set<string>): void => {
      if (added.has(id)) return;
      const meta = byId.get(id);
      if (!meta) return;

      // Detect cycles - skip a node that's already on the current
      // DFS stack to avoid infinite recursion.
      if (stack.has(id)) return;
      stack.add(id);

      for (const depId of meta.dependencies) {
        addNode(depId, stack);
      }
      // Bundled extensions have no ordering constraint relative to
      // the parent (they're independent), but install them first so
      // the pack's dependents are satisfied.
      for (const depId of meta.bundledExtensions) {
        addNode(depId, stack);
      }

      stack.delete(id);
      if (!added.has(id)) {
        added.add(id);
        sorted.push(meta);
      }
    };

    for (const id of rootIds) {
      addNode(id, new Set());
    }

    // Include failed IDs so installSingleExtension attempts them and
    // reports the error to the user. Parse the namespace/name from the ID.
    for (const [id, errMsg] of failed) {
      if (!added.has(id)) {
        added.add(id);
        const dot = id.indexOf(".");
        const ns = dot > 0 ? id.substring(0, dot) : id;
        const name = dot > 0 ? id.substring(dot + 1) : "";
        sorted.push({
          namespace: ns,
          name,
          version: "unknown",
          downloadUrl: "",
          dependencies: [],
          bundledExtensions: [],
          fetchError: errMsg,
        });
      }
    }

    return sorted;
  }

  /**
   * Install a single extension into the container.
   *
   * Copy-vs-download decision:
   *   1. Extension is universal (no per-platform builds): copy from
   *      apex-local if present, download only if not.
   *   2. Extension is per-platform, apex arch == target arch: copy
   *      from apex-local if present.
   *   3. Extension is per-platform, apex arch != target arch: download
   *      fresh for the target platform.
   *
   * After obtaining the VSIX (copy or download), extracts on the apex
   * using yauzl (no `unzip` needed in container), streams the extracted
   * tree into the container's extensions dir via `docker exec -i tar -xC`,
   * and registers in `extensions.json`.
   */
  private async installSingleExtension(
    containerId: string,
    meta: ExtensionMetadata,
    extensionsDir: string,
    targetPlatform: TargetPlatform | undefined,
    remoteUser?: string,
    onLog?: ExtensionInstallProgress,
  ): Promise<ExtensionInstallResult> {
    const tmpDir = os.tmpdir();
    const id = `${meta.namespace}.${meta.name}`;
    let vsixPath: string | undefined;
    let extractedDir: string | undefined;
    let copiedFromLocal = false;

    try {
      const platformVariants = hasPlatformVariants(meta);

      // Shared copy-vs-download decision. Apex-local copy is valid when:
      //   - extension is universal (no platform variants), OR
      //   - extension is per-platform and apex matches target.
      // See `canCopyFromApex` in platformDetect.ts.
      const canCopyLocal = canCopyFromApex(platformVariants, targetPlatform);

      if (canCopyLocal) {
        const localPath = this.findLocalExtension(id);
        if (localPath) {
          // Copy the already-installed extension folder directly.
          // No download, no extraction needed.
          this.emit(onLog, `${id}: copying from apex install (${localPath})`);
          const folderName = extensionFolderName(
            id,
            meta.version,
            meta.targetPlatform,
          );
          const containerExtDir = `${extensionsDir}/${folderName}`;
          await this.copyToContainer(
            containerId,
            localPath,
            containerExtDir,
            remoteUser,
          );
          await this.registerInExtensionsJson(
            containerId,
            extensionsDir,
            id,
            meta,
            remoteUser,
          );
          copiedFromLocal = true;
          this.emit(
            onLog,
            `${id}: installed (copied from apex to ${containerExtDir})`,
          );
          return { id, success: true };
        }
      }

      // Download path: fetch the right VSIX for the target platform.
      // Uses pre-fetched metadata (already resolved with target platform).
      this.emit(
        onLog,
        `${id}: downloading VSIX ` +
          `(version ${meta.version}` +
          `${meta.targetPlatform ? `, platform ${meta.targetPlatform}` : ""})`,
      );
      if (!meta.downloadUrl) {
        throw new Error(
          meta.fetchError ??
            `No download URL available for ${id}` +
              (targetPlatform ? ` (targetPlatform=${targetPlatform})` : ""),
        );
      }
      vsixPath = await this.marketplace.downloadFromMetadata(meta, tmpDir);

      // 2. Extract VSIX on the apex (no unzip needed in container)
      const extractBase = path.join(tmpDir, `artizo-ext-${id}-${Date.now()}`);
      extractedDir = await extractVsix(vsixPath, extractBase);

      // 3. Copy into container. Folder name must match what
      //    registerInExtensionsJson writes.
      const folderName = extensionFolderName(
        id,
        meta.version,
        meta.targetPlatform,
      );
      const containerExtDir = `${extensionsDir}/${folderName}`;
      await this.copyToContainer(
        containerId,
        extractedDir,
        containerExtDir,
        remoteUser,
      );

      // 4. Register in extensions.json
      await this.registerInExtensionsJson(
        containerId,
        extensionsDir,
        id,
        meta,
        remoteUser,
      );

      this.emit(
        onLog,
        `${id}: installed (downloaded v${meta.version} to ${containerExtDir})`,
      );

      return { id, success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { id, success: false, error: message };
    } finally {
      // Clean up local temp files (download path only)
      if (!copiedFromLocal) {
        if (vsixPath) {
          try {
            fs.unlinkSync(vsixPath);
          } catch {
            // Ignore
          }
        }
        if (extractedDir) {
          try {
            fs.rmSync(extractedDir, { recursive: true, force: true });
          } catch {
            // Ignore
          }
        }
      }
    }
  }

  private async ensureExtensionsDir(
    containerId: string,
    extensionsDir: string,
    remoteUser?: string,
  ): Promise<void> {
    const result = await this.host.dockerExec(
      containerId,
      ["mkdir", "-p", extensionsDir],
      remoteUser ? { user: remoteUser } : undefined,
    );

    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to create extensions directory (exit ${result.exitCode}): ${result.stderr}`,
      );
    }
  }

  /**
   * The tar binary to use inside containers: the artizo-bootstrapped
   * busybox tar, always. It is installed on purpose (and its install
   * fails hard when it fails), so container tar availability and flag
   * quirks are never a dependency.
   */
  private async resolveContainerTar(_containerId: string): Promise<string> {
    return "/tmp/.artizo/bin/tar";
  }

  private async copyToContainer(
    containerId: string,
    hostPath: string,
    containerPath: string,
    remoteUser?: string,
  ): Promise<void> {
    // tar -C requires the destination directory to exist. The per-extension
    // subfolder is created here (as remoteUser, not root) before streaming.
    const mkdir = await this.host.dockerExec(
      containerId,
      ["mkdir", "-p", containerPath],
      remoteUser ? { user: remoteUser } : undefined,
    );
    if (mkdir.exitCode !== 0) {
      throw new Error(
        `Failed to create extension destination ${containerPath} (exit ${mkdir.exitCode}): ${mkdir.stderr}`,
      );
    }

    // Stream a tar of the host tree into `docker exec -i tar -xC <dir>`.
    // Files land owned by whatever user the exec runs as (remoteUser when
    // set, otherwise the container's default — usually root). This replaces
    // `docker cp`, which always wrote as root and caused the
    // root-owned extensions.json / extension folders seen in issue #7.
    const tarBin = await this.resolveContainerTar(containerId);
    const tarBuf = tarDirectory(hostPath);
    const args = ["exec", "-i"];
    if (remoteUser) args.push("-u", remoteUser);
    args.push(containerId, tarBin, "-xC", containerPath);
    const child = dockerSpawn(this.dockerPath, args);
    const pipes = childPipes(child);
    let stderr = "";
    pipes.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    pipes.stdin.write(tarBuf);
    pipes.stdin.end();
    const exitCode = await new Promise<number>((resolve) =>
      child.on("close", resolve),
    );
    if (exitCode !== 0) {
      throw new Error(
        `Failed to copy extension to container (exit ${exitCode}): ${stderr}`,
      );
    }
  }

  /**
   * Register an extension in the container's extensions.json ledger.
   *
   * Reads the file via `docker exec cat`, parses on the apex, injects
   * the entry if not already present (dedup by identifier.id or
   * relativeLocation), and writes back by streaming the JSON to
   * `docker exec -i sh -c "cat > path"`.
   *
   * No script is pushed into the container - the JSON manipulation
   * happens on the apex where we have full Node.js, and `docker exec`
   * is used only for file I/O. Writes run as remoteUser so the ledger
   * is owned by the container user, not root.
   */
  private async registerInExtensionsJson(
    containerId: string,
    extensionsDir: string,
    extId: string,
    meta: ExtensionMetadata,
    remoteUser?: string,
  ): Promise<void> {
    const version = meta.version;
    const jsonPath = `${extensionsDir}/extensions.json`;
    const folderName = extensionFolderName(extId, version, meta.targetPlatform);

    // Read existing extensions.json (may not exist on fresh container)
    let entries: unknown[];
    const readResult = await this.host.dockerExec(containerId, [
      "cat",
      jsonPath,
    ]);
    if (readResult.exitCode === 0) {
      try {
        entries = JSON.parse(readResult.stdout);
        if (!Array.isArray(entries)) {
          getLogger().warn(
            `[extensions] extensions.json is not an array (got ${typeof entries}); overwriting`,
          );
          entries = [];
        }
      } catch {
        getLogger().warn(
          `[extensions] extensions.json parse failed; overwriting`,
        );
        entries = [];
      }
    } else {
      // File doesn't exist: seed with empty array
      entries = [];
    }

    const folderPath = `${extensionsDir}/${folderName}`;
    const entry = buildExtensionEntry({
      extId,
      version,
      folderPath,
      publisherDisplayName: meta.publisherDisplayName ?? meta.namespace,
      targetPlatform: meta.targetPlatform,
    });

    // Already registered at this exact folder -> nothing to do. This covers
    // the same-version case. Folder-only check: an id match with a different
    // folder means version drift, handled by the replace below.
    const alreadyAtFolder = entries.some(
      (e) =>
        typeof e === "object" &&
        e !== null &&
        (e as { relativeLocation?: string }).relativeLocation === folderName,
    );
    if (alreadyAtFolder) {
      getLogger().info(
        `[extensions] ${extId} already in extensions.json; not re-adding`,
      );
      return;
    }

    // Registered under the same id but a different folder (version drift,
    // e.g. GUI installed an older version) -> replace the stale entry so
    // the newly extracted folder is the one that loads. Without this the
    // new folder would be orphaned and the old version would keep loading.
    const idLower = extId.toLowerCase();
    const existingIdx = entries.findIndex(
      (e) =>
        typeof e === "object" &&
        e !== null &&
        (e as { identifier?: { id?: string } }).identifier?.id
          ?.toLowerCase() === idLower,
    );
    if (existingIdx >= 0) {
      const existing = entries[existingIdx] as { relativeLocation?: string };
      getLogger().info(
        `[extensions] ${extId}: replacing stale registration ` +
          `${existing.relativeLocation ?? "<unknown>"} with ${folderName}`,
      );
      entries[existingIdx] = entry;
    } else {
      entries.push(entry);
    }

    // Write back by streaming the JSON to `docker exec -i sh -c "cat > path"`.
    // Runs as remoteUser so extensions.json is owned by the container user
    // (not root). jsonPath is artizo-controlled and derived from
    // extensionsDir (validated above) + the fixed filename `extensions.json`,
    // so no shell metacharacter injection is possible here; the path is
    // single-quoted anyway so a future extensions dir containing spaces
    // still works.
    const jsonContent = JSON.stringify(entries, null, 2);
    const quotedPath = `'${jsonPath.replace(/'/g, "'\\''")}'`;
    const writeArgs = ["exec", "-i"];
    if (remoteUser) writeArgs.push("-u", remoteUser);
    writeArgs.push(containerId, "sh", "-c", `cat > ${quotedPath}`);
    const child = dockerSpawn(this.dockerPath, writeArgs);
    const pipes = childPipes(child);
    let stderr = "";
    pipes.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    pipes.stdin.write(jsonContent);
    pipes.stdin.end();
    const exitCode = await new Promise<number>((resolve) =>
      child.on("close", resolve),
    );
    if (exitCode !== 0) {
      throw new Error(
        `Failed to write extensions.json (exit ${exitCode}): ${stderr}`,
      );
    }
    getLogger().info(
      `[extensions] registered ${extId} v${version} in extensions.json`,
    );
  }
}
