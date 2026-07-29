/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import {
  computeConfigHashes,
  compareConfigHashes,
  serializeConfigHashes,
  deserializeConfigHashes,
} from "../../src/config/configHash";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "configHash-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("computeConfigHashes", () => {
  it("hashes devcontainer.json for an image-based config", async () => {
    const config = { image: "mcr.microsoft.com/devcontainers/base" };
    const hashes = await computeConfigHashes(
      config,
      tmpDir,
      path.join(tmpDir, "devcontainer.json"),
    );
    expect(Object.keys(hashes)).toEqual(["devcontainer.json"]);
    expect(hashes["devcontainer.json"]).toMatch(/^[0-9a-f]{16}$/);
  });

  it("hashes devcontainer.json + Dockerfile for a dockerfile config", async () => {
    await fs.writeFile(
      path.join(tmpDir, "Dockerfile"),
      "FROM node:20\n",
    );
    const config = { build: { dockerfile: "Dockerfile" } };
    const hashes = await computeConfigHashes(
      config,
      tmpDir,
      path.join(tmpDir, "devcontainer.json"),
    );
    expect(Object.keys(hashes).sort()).toEqual(["Dockerfile", "devcontainer.json"]);
    expect(hashes["Dockerfile"]).toMatch(/^[0-9a-f]{16}$/);
  });

  it("hashes a Dockerfile in a subdir with a relative-path key", async () => {
    await fs.mkdir(path.join(tmpDir, "docker"));
    await fs.writeFile(
      path.join(tmpDir, "docker", "Dev.Dockerfile"),
      "FROM python:3.12\n",
    );
    const config = { build: { dockerfile: "docker/Dev.Dockerfile" } };
    const hashes = await computeConfigHashes(
      config,
      tmpDir,
      path.join(tmpDir, "devcontainer.json"),
    );
    expect(hashes["docker/Dev.Dockerfile"]).toMatch(/^[0-9a-f]{16}$/);
  });

  it("strips forwardPorts, postStartCommand, postAttachCommand, configFilePath before hashing", async () => {
    const a = await computeConfigHashes(
      { image: "node:20", forwardPorts: [3000], postStartCommand: "echo hi" } as Record<string, unknown>,
      tmpDir,
      path.join(tmpDir, "devcontainer.json"),
    );
    const b = await computeConfigHashes(
      { image: "node:20", forwardPorts: [8080], postStartCommand: "echo bye", postAttachCommand: "echo attach" } as Record<string, unknown>,
      tmpDir,
      path.join(tmpDir, "devcontainer.json"),
    );
    // Only the devcontainer.json hash, and it should be equal because the
    // stripped fields don't enter the hash.
    expect(a["devcontainer.json"]).toBe(b["devcontainer.json"]);
  });

  it("produces different hashes for different image values", async () => {
    const a = await computeConfigHashes(
      { image: "node:20" },
      tmpDir,
      path.join(tmpDir, "devcontainer.json"),
    );
    const b = await computeConfigHashes(
      { image: "node:22" },
      tmpDir,
      path.join(tmpDir, "devcontainer.json"),
    );
    expect(a["devcontainer.json"]).not.toBe(b["devcontainer.json"]);
  });

  it("produces different hashes for different Dockerfile content", async () => {
    await fs.writeFile(path.join(tmpDir, "Dockerfile"), "FROM node:20\n");
    const a = await computeConfigHashes(
      { build: { dockerfile: "Dockerfile" } },
      tmpDir,
      path.join(tmpDir, "devcontainer.json"),
    );
    await fs.writeFile(path.join(tmpDir, "Dockerfile"), "FROM node:22\n");
    const b = await computeConfigHashes(
      { build: { dockerfile: "Dockerfile" } },
      tmpDir,
      path.join(tmpDir, "devcontainer.json"),
    );
    expect(a["Dockerfile"]).not.toBe(b["Dockerfile"]);
  });

  it("ignores missing referenced Dockerfile (build would have failed too)", async () => {
    const hashes = await computeConfigHashes(
      { build: { dockerfile: "Dockerfile" } },
      tmpDir,
      path.join(tmpDir, "devcontainer.json"),
    );
    expect(Object.keys(hashes)).toEqual(["devcontainer.json"]);
  });

  it("hashes a single compose file", async () => {
    await fs.writeFile(
      path.join(tmpDir, "docker-compose.yml"),
      "services:\n  app:\n    image: node:20\n",
    );
    const config = {
      dockerComposeFile: "docker-compose.yml",
      service: "app",
    };
    const hashes = await computeConfigHashes(
      config,
      tmpDir,
      path.join(tmpDir, "devcontainer.json"),
    );
    expect(Object.keys(hashes).sort()).toEqual([
      "devcontainer.json",
      "docker-compose.yml",
    ]);
  });

  it("hashes every compose file in an array", async () => {
    await fs.writeFile(
      path.join(tmpDir, "compose.yaml"),
      "services:\n  app:\n    build: .\n",
    );
    await fs.writeFile(
      path.join(tmpDir, "compose.override.yaml"),
      "services:\n  app:\n    environment:\n      - DEBUG=1\n",
    );
    const config = {
      dockerComposeFile: ["compose.yaml", "compose.override.yaml"],
      service: "app",
    };
    const hashes = await computeConfigHashes(
      config,
      tmpDir,
      path.join(tmpDir, "devcontainer.json"),
    );
    expect(Object.keys(hashes).sort()).toEqual([
      "compose.override.yaml",
      "compose.yaml",
      "devcontainer.json",
    ]);
  });

  it("hashes the compose service Dockerfile when build is a string (context)", async () => {
    await fs.mkdir(path.join(tmpDir, "build-context"));
    await fs.writeFile(
      path.join(tmpDir, "build-context", "Dockerfile"),
      "FROM node:20\n",
    );
    await fs.writeFile(
      path.join(tmpDir, "docker-compose.yml"),
      "services:\n  app:\n    build: ./build-context\n",
    );
    const config = {
      dockerComposeFile: "docker-compose.yml",
      service: "app",
    };
    const hashes = await computeConfigHashes(
      config,
      tmpDir,
      path.join(tmpDir, "devcontainer.json"),
    );
    expect(hashes["build-context/Dockerfile"]).toMatch(/^[0-9a-f]{16}$/);
  });

  it("hashes the compose service Dockerfile when build is an object with dockerfile+context", async () => {
    await fs.mkdir(path.join(tmpDir, "docker"));
    await fs.writeFile(
      path.join(tmpDir, "docker", "App.Dockerfile"),
      "FROM python:3.12\n",
    );
    await fs.writeFile(
      path.join(tmpDir, "docker-compose.yml"),
      "services:\n  app:\n    build:\n      context: ./docker\n      dockerfile: App.Dockerfile\n",
    );
    const config = {
      dockerComposeFile: "docker-compose.yml",
      service: "app",
    };
    const hashes = await computeConfigHashes(
      config,
      tmpDir,
      path.join(tmpDir, "devcontainer.json"),
    );
    expect(hashes["docker/App.Dockerfile"]).toMatch(/^[0-9a-f]{16}$/);
  });

  it("defaults context to the compose file's dir when build.dockerfile is set without context", async () => {
    await fs.writeFile(
      path.join(tmpDir, "Dockerfile"),
      "FROM alpine:3\n",
    );
    await fs.writeFile(
      path.join(tmpDir, "docker-compose.yml"),
      "services:\n  app:\n    build:\n      dockerfile: Dockerfile\n",
    );
    const config = {
      dockerComposeFile: "docker-compose.yml",
      service: "app",
    };
    const hashes = await computeConfigHashes(
      config,
      tmpDir,
      path.join(tmpDir, "devcontainer.json"),
    );
    expect(hashes["Dockerfile"]).toMatch(/^[0-9a-f]{16}$/);
  });

  it("does not hash a Dockerfile for an image-only compose service", async () => {
    await fs.writeFile(
      path.join(tmpDir, "docker-compose.yml"),
      "services:\n  app:\n    image: node:20\n",
    );
    const config = {
      dockerComposeFile: "docker-compose.yml",
      service: "app",
    };
    const hashes = await computeConfigHashes(
      config,
      tmpDir,
      path.join(tmpDir, "devcontainer.json"),
    );
    expect(Object.keys(hashes)).toEqual([
      "devcontainer.json",
      "docker-compose.yml",
    ]);
  });

  it("produces different hashes when the compose-service Dockerfile changes", async () => {
    await fs.writeFile(
      path.join(tmpDir, "Dockerfile"),
      "FROM node:20\n",
    );
    await fs.writeFile(
      path.join(tmpDir, "docker-compose.yml"),
      "services:\n  app:\n    build: .\n",
    );
    const config = {
      dockerComposeFile: "docker-compose.yml",
      service: "app",
    };
    const a = await computeConfigHashes(
      config,
      tmpDir,
      path.join(tmpDir, "devcontainer.json"),
    );
    await fs.writeFile(
      path.join(tmpDir, "Dockerfile"),
      "FROM node:22\n",
    );
    const b = await computeConfigHashes(
      config,
      tmpDir,
      path.join(tmpDir, "devcontainer.json"),
    );
    expect(a["Dockerfile"]).not.toBe(b["Dockerfile"]);
  });
});

describe("compareConfigHashes", () => {
  it("no changes", () => {
    const stored = { "devcontainer.json": "aaa", Dockerfile: "bbb" };
    const current = { "devcontainer.json": "aaa", Dockerfile: "bbb" };
    const diff = compareConfigHashes(stored, current);
    expect(diff.changed).toBe(false);
    expect(diff.deleted).toEqual([]);
    expect(diff.added).toEqual([]);
    expect(diff.modified).toEqual([]);
  });

  it("modified file", () => {
    const stored = { "devcontainer.json": "aaa", Dockerfile: "bbb" };
    const current = { "devcontainer.json": "aaa", Dockerfile: "ccc" };
    const diff = compareConfigHashes(stored, current);
    expect(diff.changed).toBe(true);
    expect(diff.modified).toEqual(["Dockerfile"]);
  });

  it("deleted file", () => {
    const stored = { "devcontainer.json": "aaa", Dockerfile: "bbb" };
    const current = { "devcontainer.json": "aaa" };
    const diff = compareConfigHashes(stored, current);
    expect(diff.changed).toBe(true);
    expect(diff.deleted).toEqual(["Dockerfile"]);
  });

  it("added file", () => {
    const stored = { "devcontainer.json": "aaa" };
    const current = { "devcontainer.json": "aaa", Dockerfile: "bbb" };
    const diff = compareConfigHashes(stored, current);
    expect(diff.changed).toBe(true);
    expect(diff.added).toEqual(["Dockerfile"]);
  });
});

describe("serialize / deserialize", () => {
  it("round-trips a ConfigHashes map", () => {
    const hashes = { "devcontainer.json": "aaa", Dockerfile: "bbb" };
    const serialized = serializeConfigHashes(hashes);
    const parsed = JSON.parse(serialized);
    expect(parsed.files).toEqual(hashes);
    expect(typeof parsed.writtenAt).toBe("string");
    expect(deserializeConfigHashes(serialized)).toEqual(hashes);
  });

  it("deserialize returns undefined for empty input", () => {
    expect(deserializeConfigHashes(undefined)).toBeUndefined();
    expect(deserializeConfigHashes("")).toBeUndefined();
  });

  it("deserialize returns undefined for malformed JSON", () => {
    expect(deserializeConfigHashes("not json")).toBeUndefined();
  });

  it("deserialize returns undefined if files key is missing", () => {
    expect(deserializeConfigHashes(JSON.stringify({ writtenAt: "x" }))).toBeUndefined();
  });
});
