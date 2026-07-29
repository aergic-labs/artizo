/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Config file hashing for container reuse decisions.
 *
 * Computes stable hashes of the devcontainer.json and every file it
 * references (Dockerfile, docker-compose files, and the Dockerfile
 * referenced by a compose service's `build:` block), so a container built
 * from one set of config files can be compared against the current set on
 * reconnect. If the hashes differ, the container is stale and the user is
 * prompted to rebuild.
 *
 * Storage: docker label `artizo.config_hash` on the container, value is a
 * JSON string with one entry per file keyed by path relative to the config
 * dir. Individual hashes (not a hash of hashes) so the mismatch prompt can
 * name which file changed.
 *
 * Hash: sha256 of file content, hex, first 16 chars. Matches docker's own
 * short-ID length (12) plus a small margin for collision safety.
 */

import { createHash } from "node:crypto";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as yaml from "js-yaml";
import {
  resolveDockerfilePath,
  resolveComposeFilePaths,
} from "./dockerfilePath.js";

/** Fields stripped from devcontainer.json before hashing. Matches the
 * official extension's normalization: these keys affect runtime behavior
 * (port forwarding, lifecycle hooks) but not the container image itself. */
const STRIPPED_FIELDS = [
  "forwardPorts",
  "postStartCommand",
  "postAttachCommand",
  "configFilePath",
] as const;

/** Per-file hashes keyed by path relative to the config dir. */
export type ConfigHashes = Record<string, string>;

/** Result of comparing two ConfigHashes. */
export interface ConfigHashDiff {
  changed: boolean;
  /** Files present in stored but missing in current (deleted). */
  deleted: string[];
  /** Files present in current but missing in stored (added). */
  added: string[];
  /** Files present in both with different hash. */
  modified: string[];
}

/**
 * Normalize a parsed devcontainer.json for hashing: strip fields that don't
 * affect the container image, then stringify with sorted keys for stability.
 */
function normalizeDevContainerJson(config: Record<string, unknown>): string {
  const stripped: Record<string, unknown> = {};
  for (const key of Object.keys(config)) {
    if (!STRIPPED_FIELDS.includes(key as (typeof STRIPPED_FIELDS)[number])) {
      stripped[key] = config[key];
    }
  }
  return JSON.stringify(sortKeysDeep(stripped));
}

/** Sort object keys recursively for stable JSON output. */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/** sha256 of content, hex, first 16 chars. */
function hashContent(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/** Relative path from configDir, posix-style for cross-platform stability. */
function relKey(absPath: string, configDir: string): string {
  const rel = path.relative(configDir, absPath);
  return rel.split(path.sep).join("/");
}

/**
 * Compute config hashes for a devcontainer.json + the files it references.
 *
 * @param config parsed devcontainer.json
 * @param configDir absolute path to the directory containing devcontainer.json
 * @param configFilePath absolute path to the devcontainer.json file itself
 *
 * Hashes:
 * - devcontainer.json (normalized: STRIPPED_FIELDS removed, keys sorted)
 * - For Dockerfile configs: the Dockerfile resolved by resolveDockerfilePath
 * - For compose configs: every docker-compose file referenced, plus the
 *   Dockerfile referenced by the compose service's `build:` block
 *
 * The compose-service Dockerfile resolution mirrors
 * `getBuildInfoForService` in
 * `vendor/devcontainers-cli/src/spec-node/dockerCompose.ts` (lines 121-150):
 * - `build` absent  -> image-only service, no Dockerfile
 * - `build: <str>`  -> context is the string, Dockerfile is "Dockerfile"
 * - `build: {dockerfile, context}` -> defaults: dockerfile "Dockerfile",
 *   context dirname of the first compose file
 *
 * Multi-file compose configs: each file is hashed individually (so a change
 * in any override file is detected). The service Dockerfile is resolved
 * from the first compose file that defines the service with a `build` block.
 * Cross-file merge of `build:` is not handled; that's an edge case of an
 * edge case.
 */
export async function computeConfigHashes(
  config: Record<string, unknown>,
  configDir: string,
  configFilePath: string,
): Promise<ConfigHashes> {
  const hashes: ConfigHashes = {};

  // devcontainer.json itself, normalized.
  hashes[relKey(configFilePath, configDir)] = hashContent(
    normalizeDevContainerJson(config),
  );

  const composePaths = resolveComposeFilePaths(config, configDir);
  if (composePaths.length > 0) {
    // Hash every compose file.
    for (const composePath of composePaths) {
      try {
        const content = await fs.readFile(composePath);
        hashes[relKey(composePath, configDir)] = hashContent(content);
      } catch {
        // Missing compose file: skip. The build would have failed too.
      }
    }

    // Resolve and hash the compose service's Dockerfile.
    const serviceDockerfile = await resolveComposeServiceDockerfile(
      config,
      composePaths,
    );
    if (serviceDockerfile) {
      try {
        const content = await fs.readFile(serviceDockerfile);
        hashes[relKey(serviceDockerfile, configDir)] = hashContent(content);
      } catch {
        // Missing Dockerfile: skip.
      }
    }
    return hashes;
  }

  // Non-compose: hash the referenced Dockerfile (if any).
  const referencedPath = resolveDockerfilePath(config, configDir);
  if (referencedPath) {
    try {
      const content = await fs.readFile(referencedPath);
      hashes[relKey(referencedPath, configDir)] = hashContent(content);
    } catch {
      // Missing referenced file: skip. The build would have failed too.
    }
  }

  return hashes;
}

/**
 * Resolve the Dockerfile referenced by a compose service's `build:` block.
 *
 * Mirrors `getBuildInfoForService` from the vendored CLI
 * (`vendor/devcontainers-cli/src/spec-node/dockerCompose.ts:121-150`).
 * Reimplemented here (rather than imported) to keep configHash pure and
 * unit-testable without loading the vendored CLI module graph.
 *
 * Parses each compose file in order; the first one that defines the service
 * with a `build` block wins. Cross-file merge of `build:` is not handled.
 */
async function resolveComposeServiceDockerfile(
  config: Record<string, unknown>,
  composePaths: string[],
): Promise<string | undefined> {
  const serviceName =
    typeof config.service === "string" ? config.service : undefined;
  if (!serviceName || composePaths.length === 0) {
    return undefined;
  }

  for (const composePath of composePaths) {
    let composeConfig: unknown;
    try {
      const content = await fs.readFile(composePath, "utf-8");
      composeConfig = yaml.load(content);
    } catch {
      continue; // unreadable or invalid YAML: try the next file
    }
    if (!composeConfig || typeof composeConfig !== "object") continue;

    const services = (composeConfig as { services?: Record<string, unknown> })
      .services;
    if (!services || typeof services !== "object") continue;

    const service = services[serviceName] as
      | { build?: string | Record<string, unknown>; image?: unknown }
      | undefined;
    if (!service || !service.build) {
      // Service not defined here, or image-only (no build): try next file.
      // If the service IS defined here without `build`, we stop - no dockerfile.
      if (service) return undefined;
      continue;
    }

    const composeBuild = service.build;
    let dockerfileRel: string;
    let contextDir: string;
    const composeDir = path.dirname(composePath);
    if (typeof composeBuild === "string") {
      dockerfileRel = "Dockerfile";
      // build: <string> means the string is the context, relative to the
      // compose file's dir (matching docker compose's resolution).
      contextDir = path.isAbsolute(composeBuild)
        ? composeBuild
        : path.resolve(composeDir, composeBuild);
    } else {
      dockerfileRel =
        (typeof composeBuild.dockerfile === "string" && composeBuild.dockerfile) ||
        "Dockerfile";
      const contextRaw =
        (typeof composeBuild.context === "string" && composeBuild.context) ||
        undefined;
      // No context: default to the first compose file's dir, matching
      // getBuildInfoForService's `cliHostPath.dirname(localComposeFiles[0])`.
      contextDir = contextRaw
        ? path.isAbsolute(contextRaw)
          ? contextRaw
          : path.resolve(composeDir, contextRaw)
        : path.dirname(composePaths[0]);
    }

    // Resolve relative to context dir, matching the vendored CLI.
    return path.isAbsolute(dockerfileRel)
      ? dockerfileRel
      : path.resolve(contextDir, dockerfileRel);
  }

  return undefined;
}

/**
 * Hash just the devcontainer.json content (normalized), using the same
 * key (file basename) that computeConfigHashes produces. Exported for the
 * remote check path, which can only read the config file itself.
 */
export function hashDevcontainerJsonOnly(
  config: Record<string, unknown>,
  configFilePath: string,
): ConfigHashes {
  const fileName = configFilePath.split(/[/\\]/).pop() ?? "devcontainer.json";
  return {
    [fileName]: hashContent(normalizeDevContainerJson(config)),
  };
}

/**
 * Compare stored hashes against current hashes.
 *
 * A file is "changed" if it was deleted, added, or modified. The caller
 * uses `changed` to decide whether to prompt, and the per-category lists
 * to format the prompt.
 */
export function compareConfigHashes(
  stored: ConfigHashes,
  current: ConfigHashes,
): ConfigHashDiff {
  const deleted: string[] = [];
  const added: string[] = [];
  const modified: string[] = [];

  for (const key of Object.keys(stored)) {
    if (!(key in current)) {
      deleted.push(key);
    } else if (stored[key] !== current[key]) {
      modified.push(key);
    }
  }
  for (const key of Object.keys(current)) {
    if (!(key in stored)) {
      added.push(key);
    }
  }

  return {
    changed: deleted.length > 0 || added.length > 0 || modified.length > 0,
    deleted,
    added,
    modified,
  };
}

/** Serialize hashes for storage in a docker label. */
export function serializeConfigHashes(hashes: ConfigHashes): string {
  return JSON.stringify({
    files: hashes,
    writtenAt: new Date().toISOString(),
  });
}

/** Parse hashes from a docker label value. Returns undefined if missing or
 * malformed (treated as "container predates config tracking"). */
export function deserializeConfigHashes(labelValue: string | undefined): ConfigHashes | undefined {
  if (!labelValue) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(labelValue) as { files?: ConfigHashes };
    if (parsed.files && typeof parsed.files === "object") {
      return parsed.files;
    }
  } catch {
    // Malformed label: treat as absent.
  }
  return undefined;
}
