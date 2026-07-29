/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Dev container label scheme.
 *
 * We set both an artizo.* and a devcontainer.* label for every value.
 * The devcontainer.* labels are the generic/spec namespace that other
 * tooling reads; the artizo.* labels are ours alone. At read time we
 * accept either, so containers built by us, by the official extension,
 * or by the vendored CLI directly are all recognized.
 *
 * `com.docker.compose.project` is set by docker compose itself, not by
 * us; we read it but never set it.
 */

const LABEL_LOCAL_FOLDER = "artizo.local_folder";
const LABEL_LOCAL_FOLDER_SPEC = "devcontainer.local_folder";
const LABEL_CONFIG_FILE = "artizo.config_file";
const LABEL_CONFIG_FILE_SPEC = "devcontainer.config_file";
const LABEL_VOLUME_NAME = "artizo.volume_name";
const LABEL_VOLUME_NAME_SPEC = "devcontainer.volume_name";
const LABEL_VOLUME_FOLDER = "artizo.volume_folder";
const LABEL_VOLUME_FOLDER_SPEC = "devcontainer.volume_folder";
const LABEL_COMPOSE_PROJECT = "com.docker.compose.project";

export interface ContainerSummary {
  id: string;
  name: string;
  state: string;
  image: string;
  labels: Record<string, string>;
}

/** Local folder path from either namespace. */
export function getLocalFolder(
  labels: Record<string, string>,
): string | undefined {
  return labels[LABEL_LOCAL_FOLDER] || labels[LABEL_LOCAL_FOLDER_SPEC];
}

/** Config file path from either namespace. */
export function getConfigFile(
  labels: Record<string, string>,
): string | undefined {
  return labels[LABEL_CONFIG_FILE] || labels[LABEL_CONFIG_FILE_SPEC];
}

/** Volume name from either namespace. */
export function getVolumeName(
  labels: Record<string, string>,
): string | undefined {
  return labels[LABEL_VOLUME_NAME] || labels[LABEL_VOLUME_NAME_SPEC];
}

/** Volume folder from either namespace. */
export function getVolumeFolder(
  labels: Record<string, string>,
): string | undefined {
  return labels[LABEL_VOLUME_FOLDER] || labels[LABEL_VOLUME_FOLDER_SPEC];
}

/** True if the container is any flavor of dev container. */
export function isDevContainer(labels: Record<string, string>): boolean {
  return (
    !!getLocalFolder(labels) ||
    (!!getVolumeName(labels) && !!getVolumeFolder(labels)) ||
    !!labels[LABEL_COMPOSE_PROJECT]
  );
}

/**
 * Parse `docker ps --format {{json .}}` stdout into container summaries.
 * Each line is one JSON object; Labels can be a comma-separated string
 * or a JSON object depending on docker version.
 */
export function parseContainerList(stdout: string): ContainerSummary[] {
  const summaries: ContainerSummary[] = [];
  for (const line of stdout.trim().split("\n")) {
    if (!line) continue;
    let c: {
      ID?: string;
      Id?: string;
      Names?: string | string[];
      State?: string;
      Image?: string;
      Labels?: string | Record<string, string>;
    };
    try {
      c = JSON.parse(line) as {
        ID?: string;
        Id?: string;
        Names?: string | string[];
        State?: string;
        Image?: string;
        Labels?: string | Record<string, string>;
      };
    } catch {
      // Skip malformed lines (docker CLI warnings, proxy banners). Logging
      // here would require injecting a logger; callers log the count.
      continue;
    }
    // Docker emits Names as a string; podman's compat API emits an array.
    const names = Array.isArray(c.Names) ? (c.Names[0] ?? "") : (c.Names ?? "");
    // Labels likewise: string from docker, object from podman.
    const labels =
      c.Labels && typeof c.Labels === "object"
        ? c.Labels
        : parseLabelString(typeof c.Labels === "string" ? c.Labels : "");
    summaries.push({
      // Docker emits "ID"; podman's compat emits "Id".
      id: c.ID || c.Id || "",
      name: names.replace(/^\/+/, ""),
      state: c.State || "",
      image: c.Image || "",
      labels,
    });
  }
  return summaries;
}

/** Parse docker's Labels field (string or JSON) into a map. */
export function parseLabelString(labels: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!labels) {
    return result;
  }
  try {
    const obj = JSON.parse(labels);
    if (typeof obj === "object" && obj !== null) {
      return obj as Record<string, string>;
    }
  } catch {
    // comma-separated key=value
  }
  // Split on commas that separate key=value pairs, but not commas inside
  // values. A comma belongs to a value when it isn't immediately followed by
  // a `key=` (i.e. no `,(?=[^,=]+=)` boundary). Artizo stamps labels like
  // `artizo.local_folder=C:\\Users\\Doe, John\\project`; a naive split would
  // corrupt the value.
  for (const part of labels.split(/,(?=[^,=]+=)/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      result[part.slice(0, eq).trim()] = part.slice(eq + 1);
    }
  }
  return result;
}
