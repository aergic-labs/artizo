/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Configuration manager for devcontainer.json files.
 *
 * Handles JSONC parsing with error recovery, schema validation,
 * and config file detection within workspace folders.
 *
 * Uses vscode.workspace.fs so file operations work correctly whether
 * the extension host runs locally or on a remote machine.
 */

import * as vscode from "vscode";
import { getLogger } from "../utils/logger";
import { parse, ParseError, printParseErrorCode } from "jsonc-parser";
import { SchemaValidator, type ValidationResult } from "./schemaValidator.js";

/** Represents a parsed devcontainer configuration. */
export interface DevContainerConfig {
  [key: string]: unknown;
}

/** Parse error with location information. */
export interface ConfigParseError {
  message: string;
  offset: number;
  length: number;
  line: number;
  column: number;
}

/** Result of reading a config file. */
export interface ReadConfigResult {
  config: DevContainerConfig | null;
  configPath: string | null;
  parseErrors: ConfigParseError[];
}

/** Interface for the configuration manager. */
export interface IConfigManager {
  readConfig(workspaceFolder: vscode.Uri): Promise<ReadConfigResult>;
  validateConfig(config: unknown): ValidationResult;
  getConfigPath(workspaceFolder: vscode.Uri): Promise<vscode.Uri | null>;
}

/** Compute line and column from an offset in a string. */
function getLineAndColumn(
  text: string,
  offset: number,
): { line: number; column: number } {
  let line = 1;
  let column = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === "\n") {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { line, column };
}

/** Configuration manager implementing IConfigManager. */
export class ConfigManager implements IConfigManager {
  private schemaValidator: SchemaValidator;

  constructor() {
    this.schemaValidator = new SchemaValidator();
  }

  /**
   * Detect the config file path within a workspace folder.
   *
   * Searches in order:
   * 1. `.devcontainer/devcontainer.json`
   * 2. `.devcontainer.json`
   */
  async getConfigPath(wsUri: vscode.Uri): Promise<vscode.Uri | null> {
    const candidates = [
      vscode.Uri.joinPath(wsUri, ".devcontainer", "devcontainer.json"),
      vscode.Uri.joinPath(wsUri, ".devcontainer.json"),
    ];

    for (const candidate of candidates) {
      try {
        await vscode.workspace.fs.stat(candidate);
        getLogger().info(
          `ConfigManager.getConfigPath: found ${candidate.fsPath}`,
        );
        return candidate;
      } catch {
        // Common case - most workspaces have no devcontainer config.
        // The absence of a "found" log is sufficient; don't spam INFO
        // with a miss line for every workspace we probe.
      }
    }

    return null;
  }

  /** Read and parse a devcontainer.json from a workspace folder. */
  async readConfig(wsUri: vscode.Uri): Promise<ReadConfigResult> {
    const configUri = await this.getConfigPath(wsUri);

    if (!configUri) {
      return { config: null, configPath: null, parseErrors: [] };
    }

    const bytes = await vscode.workspace.fs.readFile(configUri);
    const content = new TextDecoder().decode(bytes);
    return this.parseContent(content, configUri.fsPath);
  }

  /** Parse JSONC content with error recovery. */
  parseContent(
    content: string,
    configPath: string | null = null,
  ): ReadConfigResult {
    const errors: ParseError[] = [];
    const config = parse(content, errors, {
      allowTrailingComma: true,
      allowEmptyContent: false,
      disallowComments: false,
    });

    const parseErrors: ConfigParseError[] = errors.map((err) => {
      const { line, column } = getLineAndColumn(content, err.offset);
      return {
        message: printParseErrorCode(err.error),
        offset: err.offset,
        length: err.length,
        line,
        column,
      };
    });

    return {
      config: config ?? null,
      configPath,
      parseErrors,
    };
  }

  /** Validate a parsed config object against the devcontainer schema. */
  validateConfig(config: unknown): ValidationResult {
    return this.schemaValidator.validateConfig(config);
  }
}
