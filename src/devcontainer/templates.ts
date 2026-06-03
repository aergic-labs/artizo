/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Template and feature registry: spawns the devcontainer CLI for
 * template/feature operations.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";

export interface TemplatesOptions {
  outputFolder: string;
  templateId: string;
  features?: string[];
}

export interface FeaturesOptions {
  list?: boolean;
}

function buildTemplatesArgs(options: TemplatesOptions): string[] {
  const args: string[] = ["templates", "apply"];
  args.push("--template-id", options.templateId);
  args.push("--template-args", JSON.stringify({}));
  args.push("--output-folder", options.outputFolder);
  if (options.features && options.features.length > 0) {
    for (const feature of options.features) args.push("--features", feature);
  }
  return args;
}

function buildFeaturesArgs(options: FeaturesOptions): string[] {
  const args: string[] = ["features"];
  if (options.list) args.push("list");
  return args;
}

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  containerId?: string;
  remoteUser?: string;
  remoteWorkspaceFolder?: string;
}

function resolveCliPath(extensionPath: string): string {
  const bundledPath = path.join(
    extensionPath,
    "dist",
    "node_modules",
    "@devcontainers",
    "cli",
    "devcontainer.js",
  );
  if (existsSync(bundledPath)) {
    return bundledPath;
  }
  return path.join(
    extensionPath,
    "node_modules",
    "@devcontainers",
    "cli",
    "devcontainer.js",
  );
}

let _cliPath: string | undefined;

function getCliPath(): string {
  if (!_cliPath) {
    // extensionPath isn't available at module level; resolve relative to cwd
    _cliPath = resolveCliPath(process.cwd());
  }
  return _cliPath;
}

function spawnCli(args: string[]): Promise<CliResult> {
  const cliPath = getCliPath();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      resolve({
        exitCode: 1,
        stdout,
        stderr: stderr + `spawn error: ${err.message}`,
      });
    });

    child.on("close", (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

export async function templates(options: TemplatesOptions): Promise<CliResult> {
  return spawnCli(buildTemplatesArgs(options));
}

export async function features(options: FeaturesOptions): Promise<CliResult> {
  return spawnCli(buildFeaturesArgs(options));
}