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
 * using yauzl (no `unzip` needed in the container), then `docker cp`s
 * the extracted directory tree into the container's server extensions
 * directory.
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
  isExtensionInEntries,
  type TargetPlatform,
} from "./extensionRegistry";
import { extractVsix } from "./vsixExtract";
import {
  canCopyFromApex,
  dockerArchToTargetPlatform,
  hasPlatformVariants,
} from "./platformDetect";
import { getPlatformAdapter } from "../platform";
import { getLogger } from "../utils/logger";
import { dockerInspect, dockerInspectImage } from "../utils/dockerUtils";

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
 * Options for the extension installer.
 */
export interface ExtensionInstallerOptions {
  dockerPath?: string;
  marketplaceOptions?: MarketplaceClientOptions;
  host: Host;
  /**
   * Override the container-side extensions directory.
   * Defaults to resolving via the platform adapter.
   */
  extensionsDir?: string;
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
    this.localExtensionProvider =
      options?.localExtensionProvider ?? (() => undefined);
  }

  /**
   * Resolve the container-side extensions directory.
   *
   * Uses the explicit override if provided (tests use this), otherwise
   * derives it from the platform adapter's remote extensions dir
   * candidates - these encode the `.<name>-server/extensions`
   * convention per platform.
   */
  private async resolveExtensionsDir(): Promise<string> {
    if (this.extensionsDirOverride) return this.extensionsDirOverride;
    const adapter = await getPlatformAdapter();
    const installRoot = adapter.getServerInstallRoot?.() ?? "/tmp";
    const candidates = adapter.getRemoteExtensionsDirCandidates();
    // Candidates are relative to home (e.g. ".<name>-server/extensions").
    // The container install root is /tmp, so build an absolute path.
    const rel = candidates[0] ?? `${adapter.dataFolderName}-server/extensions`;
    return `${installRoot}/${rel}`;
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
  ): Promise<ExtensionInstallResult[]> {
    const extensionIds = extractExtensionIds(config);
    return this.installExtensions(containerId, extensionIds);
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
  ): Promise<ExtensionInstallResult[]> {
    if (extensionIds.length === 0) {
      return [];
    }

    const log = getLogger();
    const extensionsDir = await this.resolveExtensionsDir();

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
      log.info(
        `[extensions] resolved ${ordered.length} extensions to install ` +
          `(${extensionIds.length} requested + ${extra.length} dependencies): ` +
          extra.join(", "),
      );
    } else {
      log.info(
        `[extensions] installing ${ordered.length} extensions: ` +
          ordered.map((m) => `${m.namespace}.${m.name}`).join(", "),
      );
    }

    // Ensure the extensions directory exists in the container
    await this.ensureExtensionsDir(containerId, extensionsDir);

    const results: ExtensionInstallResult[] = [];

    for (const meta of ordered) {
      const result = await this.installSingleExtension(
        containerId,
        meta,
        extensionsDir,
        targetPlatform,
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
   * using yauzl (no `unzip` needed in container), `docker cp`s the
   * extracted tree into the container's extensions dir, and registers
   * in `extensions.json`.
   */
  private async installSingleExtension(
    containerId: string,
    meta: ExtensionMetadata,
    extensionsDir: string,
    targetPlatform: TargetPlatform | undefined,
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
          const folderName = extensionFolderName(
            id,
            meta.version,
            meta.targetPlatform,
          );
          const containerExtDir = `${extensionsDir}/${folderName}`;
          await this.copyToContainer(containerId, localPath, containerExtDir);
          await this.registerInExtensionsJson(
            containerId,
            extensionsDir,
            id,
            meta,
          );
          copiedFromLocal = true;
          return { id, success: true };
        }
      }

      // Download path: fetch the right VSIX for the target platform.
      // Uses pre-fetched metadata (already resolved with target platform).
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
      await this.copyToContainer(containerId, extractedDir, containerExtDir);

      // 4. Register in extensions.json
      await this.registerInExtensionsJson(containerId, extensionsDir, id, meta);

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
  ): Promise<void> {
    const result = await this.host.dockerExec(containerId, [
      "mkdir",
      "-p",
      extensionsDir,
    ]);

    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to create extensions directory (exit ${result.exitCode}): ${result.stderr}`,
      );
    }
  }

  private async copyToContainer(
    containerId: string,
    hostPath: string,
    containerPath: string,
  ): Promise<void> {
    const { dockerCp } = await import("../utils/dockerUtils.js");
    const result = await dockerCp(
      this.dockerPath,
      hostPath,
      containerId,
      containerPath,
    );
    if (result.exitCode !== 0) {
      throw new Error(`Failed to copy file to container: ${result.stderr}`);
    }
  }

  /**
   * Register an extension in the container's extensions.json ledger.
   *
   * Reads the file via `docker exec cat`, parses on the apex, injects
   * the entry if not already present (dedup by identifier.id or
   * relativeLocation), and writes back via a temp file + `docker cp`.
   *
   * No script is pushed into the container - the JSON manipulation
   * happens on the apex where we have full Node.js, and `docker exec`
   * / `docker cp` are used only for file I/O.
   */
  private async registerInExtensionsJson(
    containerId: string,
    extensionsDir: string,
    extId: string,
    meta: ExtensionMetadata,
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

    if (isExtensionInEntries(entries, extId, folderName)) {
      getLogger().info(
        `[extensions] ${extId} already in extensions.json; not re-adding`,
      );
      return;
    }

    const folderPath = `${extensionsDir}/${folderName}`;
    const entry = buildExtensionEntry({
      extId,
      version,
      folderPath,
      publisherDisplayName: meta.publisherDisplayName ?? meta.namespace,
      targetPlatform: meta.targetPlatform,
    });
    entries.push(entry);

    // Write back via temp file + docker cp to avoid shell quoting issues
    // with the JSON content.
    const os = await import("node:os");
    const tmpFile = path.join(
      os.tmpdir(),
      `artizo-ext-json-${Date.now()}.json`,
    );
    fs.writeFileSync(tmpFile, JSON.stringify(entries, null, 2));
    try {
      const { dockerCp } = await import("../utils/dockerUtils.js");
      const cpResult = await dockerCp(
        this.dockerPath,
        tmpFile,
        containerId,
        jsonPath,
      );
      if (cpResult.exitCode !== 0) {
        throw new Error(
          `Failed to write extensions.json (exit ${cpResult.exitCode}): ${cpResult.stderr}`,
        );
      }
      getLogger().info(
        `[extensions] registered ${extId} v${version} in extensions.json`,
      );
    } finally {
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}
