/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Container lifecycle management commands: start, stop, and remove
 * dev containers. Uses Docker CLI directly.
 */

import { dockerExecPolicy } from "../docker/execPolicy.js";
import { MANAGED_LABEL } from "../utils/constants";

/**
 * Result of a lifecycle operation.
 */
export interface LifecycleResult {
  success: boolean;
  error?: string;
}

/**
 * Interface for container lifecycle management.
 */
export interface IContainerLifecycle {
  start(containerId: string): Promise<LifecycleResult>;
  stop(containerId: string): Promise<LifecycleResult>;
  remove(
    containerId: string,
    options?: RemoveOptions,
  ): Promise<LifecycleResult>;
  cleanUp(options?: CleanUpOptions): Promise<CleanUpResult>;
}

/**
 * Options for container removal.
 */
export interface RemoveOptions {
  force?: boolean;
  removeVolumes?: boolean;
}

/**
 * Options for the clean-up command.
 */
export interface CleanUpOptions {
  removeImages?: boolean;
  removeVolumes?: boolean;
  /** Only remove containers with this label. Defaults to dev-container set. */
  labelFilter?: string;
}

/** Default label filters for clean-up: artizo.* or devcontainer.* namespace. */
const CLEANUP_LABEL_FILTERS = [
  "artizo.local_folder",
  "devcontainer.local_folder",
];

/**
 * Result of a clean-up operation.
 */
export interface CleanUpResult {
  containersRemoved: number;
  imagesRemoved: number;
  volumesRemoved: number;
  errors: string[];
}

/**
 * Container lifecycle manager implementation.
 */
export class ContainerLifecycle implements IContainerLifecycle {
  async start(containerId: string): Promise<LifecycleResult> {
    const result = await this.execDocker(["start", containerId]);
    if (result.exitCode !== 0) {
      return {
        success: false,
        error: result.stderr || `Failed to start container ${containerId}`,
      };
    }
    return { success: true };
  }

  async stop(containerId: string): Promise<LifecycleResult> {
    const result = await this.execDocker(["stop", containerId]);
    if (result.exitCode !== 0) {
      return {
        success: false,
        error: result.stderr || `Failed to stop container ${containerId}`,
      };
    }
    return { success: true };
  }

  async remove(
    containerId: string,
    options?: RemoveOptions,
  ): Promise<LifecycleResult> {
    const args = ["rm"];

    if (options?.force) {
      args.push("--force");
    }

    if (options?.removeVolumes) {
      args.push("--volumes");
    }

    args.push(containerId);

    const result = await this.execDocker(args);
    if (result.exitCode !== 0) {
      return {
        success: false,
        error: result.stderr || `Failed to remove container ${containerId}`,
      };
    }
    return { success: true };
  }

  /**
   * Clean up unused dev containers and optionally images/volumes.
   *
   * Lists containers by the artizo.* / devcontainer.* local-folder labels
   * (docker --filter is AND-only, so we query each and dedup).
   */
  async cleanUp(options?: CleanUpOptions): Promise<CleanUpResult> {
    const result: CleanUpResult = {
      containersRemoved: 0,
      imagesRemoved: 0,
      volumesRemoved: 0,
      errors: [],
    };

    const labelFilters = options?.labelFilter
      ? [options.labelFilter]
      : CLEANUP_LABEL_FILTERS;

    const ids = new Set<string>();
    for (const labelFilter of labelFilters) {
      const listResult = await this.execDocker([
        "ps",
        "-a",
        "--filter",
        `label=${labelFilter}`,
        "--filter",
        "status=exited",
        "--format",
        "{{.ID}}",
      ]);
      if (listResult.exitCode === 0 && listResult.stdout.trim()) {
        for (const id of listResult.stdout.trim().split("\n").filter(Boolean)) {
          ids.add(id);
        }
      }
    }

    for (const id of ids) {
      const removeResult = await this.remove(id, {
        force: true,
        removeVolumes: options?.removeVolumes,
      });
      if (removeResult.success) {
        result.containersRemoved++;
      } else {
        result.errors.push(removeResult.error ?? `Failed to remove ${id}`);
      }
    }

    // Remove dangling images if requested
    if (options?.removeImages) {
      const pruneResult = await this.execDocker(["image", "prune", "--force"]);

      if (pruneResult.exitCode === 0) {
        // Count removed images from output
        const lines = pruneResult.stdout.trim().split("\n").filter(Boolean);
        result.imagesRemoved = lines.length > 1 ? lines.length - 1 : 0;
      } else {
        result.errors.push(pruneResult.stderr || "Failed to prune images");
      }
    }

    // Remove unused volumes if requested
    if (options?.removeVolumes) {
      const volumeResult = await this.execDocker([
        "volume",
        "ls",
        "--filter",
        "dangling=true",
        "--filter",
        `label=${MANAGED_LABEL}`,
        "--format",
        "{{.Name}}",
      ]);

      if (volumeResult.exitCode === 0 && volumeResult.stdout.trim()) {
        const volumeNames = volumeResult.stdout
          .trim()
          .split("\n")
          .filter(Boolean);

        for (const name of volumeNames) {
          const rmResult = await this.execDocker(["volume", "rm", name]);
          if (rmResult.exitCode === 0) {
            result.volumesRemoved++;
          } else {
            result.errors.push(
              rmResult.stderr || `Failed to remove volume ${name}`,
            );
          }
        }
      }
    }

    return result;
  }

  private async execDocker(
    args: string[],
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return dockerExecPolicy(args);
  }
}
