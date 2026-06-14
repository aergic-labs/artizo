/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { resolveDockerfilePath } from "../../src/config/dockerfilePath";

const DIR = path.join("/repo", ".devcontainer");

describe("resolveDockerfilePath", () => {
  it("resolves build.dockerfile relative to the config dir", () => {
    const p = resolveDockerfilePath({ build: { dockerfile: "Dockerfile" } }, DIR);
    expect(p).toBe(path.resolve(DIR, "Dockerfile"));
  });

  it("accepts the build.dockerFile spelling", () => {
    const p = resolveDockerfilePath(
      { build: { dockerFile: "docker/Dev.Dockerfile" } },
      DIR,
    );
    expect(p).toBe(path.resolve(DIR, "docker/Dev.Dockerfile"));
  });

  it("accepts the legacy top-level dockerFile", () => {
    const p = resolveDockerfilePath({ dockerFile: "Dockerfile" }, DIR);
    expect(p).toBe(path.resolve(DIR, "Dockerfile"));
  });

  it("resolves a string dockerComposeFile", () => {
    const p = resolveDockerfilePath(
      { dockerComposeFile: "docker-compose.yml" },
      DIR,
    );
    expect(p).toBe(path.resolve(DIR, "docker-compose.yml"));
  });

  it("resolves the first entry of a dockerComposeFile array", () => {
    const p = resolveDockerfilePath(
      { dockerComposeFile: ["compose.yaml", "compose.override.yaml"] },
      DIR,
    );
    expect(p).toBe(path.resolve(DIR, "compose.yaml"));
  });

  it("returns undefined for an image-based config", () => {
    expect(
      resolveDockerfilePath({ image: "mcr.microsoft.com/devcontainers/base" }, DIR),
    ).toBeUndefined();
  });

  it("prefers build.dockerfile over compose when both present", () => {
    const p = resolveDockerfilePath(
      { build: { dockerfile: "Dockerfile" }, dockerComposeFile: "compose.yaml" },
      DIR,
    );
    expect(p).toBe(path.resolve(DIR, "Dockerfile"));
  });
});
