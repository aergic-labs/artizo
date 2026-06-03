/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Configuration manager for devcontainer.json files.
 *
 * Handles JSONC parsing with error recovery, schema validation,
 * and config file detection within workspace folders.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parse, ParseError, printParseErrorCode } from "jsonc-parser";
import { SchemaValidator, type ValidationResult } from "./schemaValidator.js";

/**
 * Represents a parsed devcontainer configuration.
 */
export interface DevContainerConfig {
  [key: string]: unknown;
}

/**
 * Parse error with location information.
 */
export interface ConfigParseError {
  message: string;
  offset: number;
  length: number;
  line: number;
  column: number;
}

/**
 * Result of reading a config file.
 */
export interface ReadConfigResult {
  config: DevContainerConfig | null;
  configPath: string | null;
  parseErrors: ConfigParseError[];
}

/**
 * Interface for the configuration manager.
 */
export interface IConfigManager {
  readConfig(workspaceFolder: string): ReadConfigResult;
  validateConfig(config: unknown): ValidationResult;
  getConfigPath(workspaceFolder: string): string | null;
}

/**
 * Compute line and column from an offset in a string.
 */
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

/**
 * Configuration manager implementing IConfigManager.
 *
 * Searches for devcontainer.json in standard locations,
 * parses JSONC with error recovery, and validates against schema.
 */
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
   *
   * @returns The absolute path to the config file, or null if not found.
   */
  getConfigPath(workspaceFolder: string): string | null {
    const candidates = [
      path.join(workspaceFolder, ".devcontainer", "devcontainer.json"),
      path.join(workspaceFolder, ".devcontainer.json"),
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  /**
   * Read and parse a devcontainer.json from a workspace folder.
   * Uses JSONC parsing with error recovery so partial configs can still
   * be returned even when there are syntax errors.
   */
  readConfig(workspaceFolder: string): ReadConfigResult {
    const configPath = this.getConfigPath(workspaceFolder);

    if (!configPath) {
      return { config: null, configPath: null, parseErrors: [] };
    }

    const content = fs.readFileSync(configPath, "utf-8");
    return this.parseContent(content, configPath);
  }

  /**
   * Parse JSONC content with error recovery.
   *
   * Exposed for testing purposes.
   */
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

  /**
   * Validate a parsed config object against the devcontainer schema.
   */
  validateConfig(config: unknown): ValidationResult {
    return this.schemaValidator.validateConfig(config);
  }
}