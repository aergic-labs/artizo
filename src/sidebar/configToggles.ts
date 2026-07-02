/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Config toggle helpers, pure functions for computing devcontainer.json
 * toggle state (GPU, mounts, ports, etc.) and toggling them on/off.
 *
 * Extracted from SidebarProvider to make the manipulation logic
 * independently testable without VS Code or Docker mocks.
 */

import type { ConfigToggles, SoftwareFeature } from "./messages";

// ---------------------------------------------------------------------------
// Option path table
// ---------------------------------------------------------------------------

/** A managed option's jsonPath (mounts/runArgs/flag entry) and its tag. */
export interface OptionPath {
  path: string[];
  managed: string;
}

/**
 * Build the mount/runArg path table used by toggleOption.
 *
 * Maps each managed feature (gpu, waylandSocket, mountHome, privileged,
 * sshAgent, copyGitConfig) to its jsonPath entries and artizoManaged tag.
 * The home mount source is parameterized because it depends on the host
 * home directory, which is computed at the call site.
 *
 * @param homePath - Host home directory, pre-escaped for the current platform
 * @returns Record keyed by feature name
 */
export function optionPaths(
  homePath: string,
): Record<string, OptionPath> {
  return {
    gpu: { path: ["runArgs", "--gpus", "all"], managed: "gpu" },
    waylandSocket: {
      path: [
        "mounts",
        "source=${localEnv:WAYLAND_DISPLAY}",
        "target=/tmp/.X11-unix",
      ],
      managed: "waylandSocket",
    },
    mountHome: {
      path: [
        "mounts",
        `source=${homePath}`,
        "target=/host-home",
        "type=bind",
      ],
      managed: "home",
    },
    privileged: { path: ["runArgs", "--privileged"], managed: "privileged" },
    sshAgent: {
      path: [
        "mounts",
        "source=${localEnv:SSH_AUTH_SOCK}",
        "target=/tmp/ssh-auth-sock",
      ],
      managed: "sshAgent",
    },
    copyGitConfig: {
      path: ["disableCopyGitConfig"],
      managed: "copyGitConfig",
    },
  };
}

// ---------------------------------------------------------------------------
// Pure toggle logic
// ---------------------------------------------------------------------------

/**
 * Compute the updated runArgs array when an option is toggled.
 *
 * @param runArgs - Current runArgs array
 * @param patchPath - The option's path entries [key, ...values]
 * @param enabled - Whether the option is being enabled or disabled
 * @returns The updated runArgs array
 */
export function computeRunArgsToggle(
  runArgs: string[],
  patchPath: string[],
  enabled: boolean,
): string[] {
  const arg1 = patchPath[1];
  const arg2 = patchPath[2];

  if (enabled) {
    const updated = [...runArgs];
    if (!updated.includes(arg1)) {
      updated.push(arg1);
    }
    if (arg2 && !updated.includes(arg2)) {
      updated.push(arg2);
    }
    return updated;
  }

  return runArgs.filter((a) => a !== arg1 && a !== arg2);
}

/**
 * Compute the updated mounts array when an option is toggled.
 *
 * @param mounts - Current mounts array
 * @param patchPath - The option's path entries with source=/target=/type= prefixes
 * @param enabled - Whether the option is being enabled or disabled
 * @param managed - The artizoManaged tag for this option
 * @returns The updated mounts array
 */
export function computeMountsToggle(
  mounts: Record<string, unknown>[],
  patchPath: string[],
  enabled: boolean,
  managed: string,
): Record<string, unknown>[] {
  if (enabled) {
    const source = patchPath[1].replace("source=", "");
    const target = patchPath[2].replace("target=", "");
    const mountEntry: Record<string, unknown> = { source, target };
    if (patchPath[3] && patchPath[3].startsWith("type=")) {
      mountEntry.type = patchPath[3].replace("type=", "");
    }
    mountEntry.artizoManaged = managed;

    const idx = mounts.findIndex((m) => (m as any).artizoManaged === managed);
    if (idx >= 0) {
      const updated = [...mounts];
      updated[idx] = mountEntry;
      return updated;
    }
    return [...mounts, mountEntry];
  }

  return mounts.filter((m) => (m as any).artizoManaged !== managed);
}

// ---------------------------------------------------------------------------
// Toggle extraction from parsed devcontainer.json
// ---------------------------------------------------------------------------

/**
 * Extract toggle state from a parsed devcontainer.json object.
 *
 * @param raw - Parsed devcontainer.json as a plain object
 * @returns Structured toggle state and config values
 */
export function extractToggles(raw: Record<string, unknown>): ConfigToggles {
  const runArgs = (raw.runArgs as string[]) || [];
  const mounts = (raw.mounts || raw.Mounts || []) as Array<
    Record<string, unknown>
  >;
  const forwardPortsRaw = (raw.forwardPorts as (number | string)[]) || [];
  const forwardPorts: { port: number; label: string }[] = forwardPortsRaw.map(
    (p) => {
      if (typeof p === "number") {
        return { port: p, label: "" };
      }
      const num = parseInt(p, 10);
      return { port: isNaN(num) ? 0 : num, label: "" };
    },
  );
  const extensions =
    ((
      (raw.customizations as Record<string, unknown>)?.vscode as Record<
        string,
        unknown
      >
    )?.extensions as string[]) || [];

  return {
    gpu: runArgs.includes("--gpus"),
    waylandSocket: mounts.some(
      (m) => (m as any).artizoManaged === "waylandSocket",
    ),
    mountHome: mounts.some((m) => (m as any).artizoManaged === "home"),
    privileged: runArgs.includes("--privileged"),
    sshAgent: mounts.some((m) => (m as any).artizoManaged === "sshAgent"),
    copyGitConfig: !(raw.disableCopyGitConfig as boolean),
    forwardPorts,
    extensions,
    mounts: mounts.map((m) => ({
      source: String(m.source || ""),
      target: String(m.target || ""),
    })),
    runArgs,
    remoteUser: (raw.remoteUser as string) || "",
  };
}

const CURATED_SOFTWARE: { ref: string; label: string }[] = [
  { ref: "ghcr.io/devcontainers/features/aws-cli:latest", label: "AWS CLI" },
  {
    ref: "ghcr.io/devcontainers/features/common-utils:latest",
    label: "Common Utilities",
  },
  {
    ref: "ghcr.io/devcontainers/features/docker-in-docker:latest",
    label: "Docker (in Docker)",
  },
  {
    ref: "ghcr.io/devcontainers/features/docker-outside-of-docker:latest",
    label: "Docker (outside of Docker)",
  },
  {
    ref: "ghcr.io/devcontainers/features/git:latest",
    label: "Git (from source)",
  },
  {
    ref: "ghcr.io/devcontainers/features/github-cli:latest",
    label: "GitHub CLI",
  },
  { ref: "ghcr.io/devcontainers/features/go:latest", label: "Go" },
  { ref: "ghcr.io/devcontainers/features/java:latest", label: "Java" },
  {
    ref: "ghcr.io/devcontainers/features/kubectl-helm-minikube:latest",
    label: "Kubernetes Tools",
  },
  { ref: "ghcr.io/devcontainers/features/node:latest", label: "Node.js" },
  { ref: "ghcr.io/devcontainers/features/python:latest", label: "Python" },
  { ref: "ghcr.io/devcontainers/features/rust:latest", label: "Rust" },
  {
    ref: "ghcr.io/devcontainers/features/terraform:latest",
    label: "Terraform",
  },
];

export function extractSoftware(
  raw: Record<string, unknown>,
): SoftwareFeature[] {
  const enabledFeatures = (raw.features || {}) as Record<string, unknown>;
  return CURATED_SOFTWARE.map((s) => ({
    ...s,
    enabled: s.ref in enabledFeatures,
  }));
}
