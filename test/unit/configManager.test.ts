/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

vi.mock("vscode", () => {
   
  const realFs = require("node:fs") as typeof import("node:fs");
   
  const realPath = require("node:path") as typeof import("node:path");

  return {
    Uri: {
      file: (p: string) => ({ fsPath: p, scheme: "file", path: p }),
      from: (opts: { scheme: string; path: string }) => ({
        fsPath: opts.path,
        scheme: opts.scheme,
        path: opts.path,
      }),
      joinPath: (base: { fsPath: string }, ...segments: string[]) => ({
        fsPath: realPath.join(base.fsPath, ...segments),
        scheme: "file",
        path: realPath.join(base.fsPath, ...segments),
      }),
    },
    workspace: {
      fs: {
        stat: async (uri: { fsPath: string }) => {
          if (realFs.existsSync(uri.fsPath)) {
            return { type: 1, ctime: 0, mtime: 0, size: 0 };
          }
          throw Object.assign(new Error("File not found"), {
            code: "FileNotFound",
          });
        },
        readFile: async (uri: { fsPath: string }) => {
          return realFs.readFileSync(uri.fsPath);
        },
      },
    },
  };
});

import * as vscode from "vscode";
import { ConfigManager } from "../../src/config/configManager";

describe("ConfigManager", () => {
  let configManager: ConfigManager;
  let tmpDir: string;

  beforeEach(() => {
    configManager = new ConfigManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "artizo-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("getConfigPath", () => {
    it("returns null when no config file exists", async () => {
      const result = await configManager.getConfigPath(vscode.Uri.file(tmpDir));
      expect(result).toBeNull();
    });

    it("finds .devcontainer/devcontainer.json", async () => {
      const devcontainerDir = path.join(tmpDir, ".devcontainer");
      fs.mkdirSync(devcontainerDir);
      fs.writeFileSync(path.join(devcontainerDir, "devcontainer.json"), "{}");

      const result = await configManager.getConfigPath(vscode.Uri.file(tmpDir));
      expect(result?.fsPath).toBe(
        path.join(devcontainerDir, "devcontainer.json"),
      );
    });

    it("finds .devcontainer.json at root", async () => {
      fs.writeFileSync(path.join(tmpDir, ".devcontainer.json"), "{}");

      const result = await configManager.getConfigPath(vscode.Uri.file(tmpDir));
      expect(result?.fsPath).toBe(path.join(tmpDir, ".devcontainer.json"));
    });

    it("prefers .devcontainer/devcontainer.json over .devcontainer.json", async () => {
      const devcontainerDir = path.join(tmpDir, ".devcontainer");
      fs.mkdirSync(devcontainerDir);
      fs.writeFileSync(
        path.join(devcontainerDir, "devcontainer.json"),
        '{"name":"folder"}',
      );
      fs.writeFileSync(
        path.join(tmpDir, ".devcontainer.json"),
        '{"name":"root"}',
      );

      const result = await configManager.getConfigPath(vscode.Uri.file(tmpDir));
      expect(result?.fsPath).toBe(
        path.join(devcontainerDir, "devcontainer.json"),
      );
    });
  });

  describe("readConfig", () => {
    it("returns null config when no file exists", async () => {
      const result = await configManager.readConfig(vscode.Uri.file(tmpDir));
      expect(result.config).toBeNull();
      expect(result.configPath).toBeNull();
      expect(result.parseErrors).toHaveLength(0);
    });

    it("parses a valid devcontainer.json", async () => {
      const devcontainerDir = path.join(tmpDir, ".devcontainer");
      fs.mkdirSync(devcontainerDir);
      const configContent = JSON.stringify({
        name: "Test Container",
        image: "node:18",
        forwardPorts: [3000, 5432],
      });
      fs.writeFileSync(
        path.join(devcontainerDir, "devcontainer.json"),
        configContent,
      );

      const result = await configManager.readConfig(vscode.Uri.file(tmpDir));
      expect(result.config).toEqual({
        name: "Test Container",
        image: "node:18",
        forwardPorts: [3000, 5432],
      });
      expect(result.configPath).toBe(
        path.join(devcontainerDir, "devcontainer.json"),
      );
      expect(result.parseErrors).toHaveLength(0);
    });

    it("parses JSONC with comments", async () => {
      const devcontainerDir = path.join(tmpDir, ".devcontainer");
      fs.mkdirSync(devcontainerDir);
      const configContent = `{
  // This is a comment
  "name": "Test",
  /* Multi-line
     comment */
  "image": "ubuntu:22.04"
}`;
      fs.writeFileSync(
        path.join(devcontainerDir, "devcontainer.json"),
        configContent,
      );

      const result = await configManager.readConfig(vscode.Uri.file(tmpDir));
      expect(result.config).toEqual({
        name: "Test",
        image: "ubuntu:22.04",
      });
      expect(result.parseErrors).toHaveLength(0);
    });

    it("parses JSONC with trailing commas", async () => {
      const devcontainerDir = path.join(tmpDir, ".devcontainer");
      fs.mkdirSync(devcontainerDir);
      const configContent = `{
  "name": "Test",
  "image": "node:18",
}`;
      fs.writeFileSync(
        path.join(devcontainerDir, "devcontainer.json"),
        configContent,
      );

      const result = await configManager.readConfig(vscode.Uri.file(tmpDir));
      expect(result.config).toEqual({
        name: "Test",
        image: "node:18",
      });
      expect(result.parseErrors).toHaveLength(0);
    });

    it("reports parse errors with location info", async () => {
      const devcontainerDir = path.join(tmpDir, ".devcontainer");
      fs.mkdirSync(devcontainerDir);
      // Missing value after colon
      const configContent = `{
  "name": ,
  "image": "node:18"
}`;
      fs.writeFileSync(
        path.join(devcontainerDir, "devcontainer.json"),
        configContent,
      );

      const result = await configManager.readConfig(vscode.Uri.file(tmpDir));
      expect(result.parseErrors.length).toBeGreaterThan(0);
      expect(result.parseErrors[0].line).toBeGreaterThan(0);
      expect(result.parseErrors[0].column).toBeGreaterThan(0);
      expect(result.parseErrors[0].offset).toBeGreaterThanOrEqual(0);
    });

    it("recovers partial config from malformed JSONC", async () => {
      const devcontainerDir = path.join(tmpDir, ".devcontainer");
      fs.mkdirSync(devcontainerDir);
      // Invalid JSON but recoverable
      const configContent = `{
  "name": "Test",
  "image": "node:18"
  "extra": "missing comma above"
}`;
      fs.writeFileSync(
        path.join(devcontainerDir, "devcontainer.json"),
        configContent,
      );

      const result = await configManager.readConfig(vscode.Uri.file(tmpDir));
      // Should still parse what it can
      expect(result.parseErrors.length).toBeGreaterThan(0);
      // The parser with error recovery should still return something
      expect(result.config).not.toBeNull();
    });
  });

  describe("parseContent", () => {
    it("parses empty object", () => {
      const result = configManager.parseContent("{}");
      expect(result.config).toEqual({});
      expect(result.parseErrors).toHaveLength(0);
    });

    it("parses complex config", () => {
      const content = JSON.stringify({
        name: "Full Config",
        image: "mcr.microsoft.com/devcontainers/typescript-node:18",
        features: {
          "ghcr.io/devcontainers/features/docker-in-docker:2": {},
        },
        forwardPorts: [3000],
        customizations: {
          vscode: {
            extensions: ["dbaeumer.vscode-eslint"],
            settings: { "editor.formatOnSave": true },
          },
        },
        postCreateCommand: "npm install",
      });

      const result = configManager.parseContent(content);
      expect(result.config).not.toBeNull();
      expect((result.config as any).name).toBe("Full Config");
      expect((result.config as any).features).toBeDefined();
      expect(result.parseErrors).toHaveLength(0);
    });

    it("handles completely invalid content", () => {
      const result = configManager.parseContent("not json at all");
      expect(result.parseErrors.length).toBeGreaterThan(0);
    });
  });

  describe("validateConfig", () => {
    it("validates a minimal image-based config", () => {
      const result = configManager.validateConfig({
        image: "node:18",
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("validates a dockerfile-based config", () => {
      const result = configManager.validateConfig({
        build: {
          dockerfile: "Dockerfile",
          context: ".",
        },
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("validates a compose-based config", () => {
      const result = configManager.validateConfig({
        dockerComposeFile: "docker-compose.yml",
        service: "app",
        workspaceFolder: "/workspace",
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("rejects non-object config", () => {
      const result = configManager.validateConfig("not an object");
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("rejects null config", () => {
      const result = configManager.validateConfig(null);
      expect(result.valid).toBe(false);
    });

    it("rejects config with wrong type for image", () => {
      const result = configManager.validateConfig({
        image: 123,
      });
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("rejects config with wrong type for forwardPorts", () => {
      const result = configManager.validateConfig({
        image: "node:18",
        forwardPorts: "not-an-array",
      });
      expect(result.valid).toBe(false);
    });

    it("validates config with extensions", () => {
      const result = configManager.validateConfig({
        image: "node:18",
        customizations: {
          vscode: {
            extensions: ["ms-python.python", "dbaeumer.vscode-eslint"],
          },
        },
      });
      expect(result.valid).toBe(true);
    });

    it("warns when no image/dockerfile/compose is specified", () => {
      const result = configManager.validateConfig({
        name: "Empty Config",
      });
      // Valid structurally but should have a warning
      expect(result.valid).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0].message).toContain("image");
    });

    it("validates config with features", () => {
      const result = configManager.validateConfig({
        image: "node:18",
        features: {
          "ghcr.io/devcontainers/features/docker-in-docker:2": {},
          "ghcr.io/devcontainers/features/git:1": { version: "latest" },
        },
      });
      expect(result.valid).toBe(true);
    });

    it("validates config with ports attributes", () => {
      const result = configManager.validateConfig({
        image: "node:18",
        forwardPorts: [3000, 5432],
        portsAttributes: {
          "3000": { label: "Web App", onAutoForward: "notify" },
          "5432": { label: "PostgreSQL", onAutoForward: "silent" },
        },
      });
      expect(result.valid).toBe(true);
    });
  });
});
