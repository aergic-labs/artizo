/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * JSON Schema validation for devcontainer.json using ajv.
 * Covers core properties (image, dockerFile, dockerComposeFile, features,
 * forwardPorts, customizations, etc.).
 */

import Ajv from "ajv";

export interface ValidationError {
  path: string;
  message: string;
}

export interface ValidationWarning {
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

/**
 * Minimal devcontainer schema covering common properties.
 * Validates structure without being overly restrictive. The official schema
 * is very large, so we focus on structural correctness.
 */
const devcontainerSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties: {
    name: { type: "string" },
    image: { type: "string" },
    dockerFile: { type: "string" },
    build: {
      type: "object",
      properties: {
        dockerfile: { type: "string" },
        context: { type: "string" },
        args: { type: "object", additionalProperties: { type: "string" } },
      },
    },
    dockerComposeFile: {
      oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
    },
    service: { type: "string" },
    runServices: { type: "array", items: { type: "string" } },
    workspaceFolder: { type: "string" },
    workspaceMount: { type: "string" },
    forwardPorts: {
      type: "array",
      items: {
        oneOf: [{ type: "number" }, { type: "string" }],
      },
    },
    portsAttributes: {
      type: "object",
      additionalProperties: {
        type: "object",
        properties: {
          label: { type: "string" },
          onAutoForward: { type: "string" },
          protocol: { type: "string" },
        },
      },
    },
    remoteUser: { type: "string" },
    containerUser: { type: "string" },
    remoteEnv: { type: "object", additionalProperties: { type: "string" } },
    containerEnv: { type: "object", additionalProperties: { type: "string" } },
    features: { type: "object" },
    customizations: {
      type: "object",
      properties: {
        vscode: {
          type: "object",
          properties: {
            extensions: { type: "array", items: { type: "string" } },
            settings: { type: "object" },
          },
        },
      },
    },
    mounts: {
      type: "array",
      items: {
        oneOf: [
          { type: "string" },
          {
            type: "object",
            properties: {
              source: { type: "string" },
              target: { type: "string" },
              type: { type: "string" },
            },
          },
        ],
      },
    },
    postCreateCommand: {
      oneOf: [
        { type: "string" },
        { type: "array", items: { type: "string" } },
        { type: "object" },
      ],
    },
    postStartCommand: {
      oneOf: [
        { type: "string" },
        { type: "array", items: { type: "string" } },
        { type: "object" },
      ],
    },
    postAttachCommand: {
      oneOf: [
        { type: "string" },
        { type: "array", items: { type: "string" } },
        { type: "object" },
      ],
    },
    onCreateCommand: {
      oneOf: [
        { type: "string" },
        { type: "array", items: { type: "string" } },
        { type: "object" },
      ],
    },
    updateContentCommand: {
      oneOf: [
        { type: "string" },
        { type: "array", items: { type: "string" } },
        { type: "object" },
      ],
    },
    shutdownAction: {
      type: "string",
      enum: ["none", "stopContainer", "stopCompose"],
    },
    overrideCommand: { type: "boolean" },
    privileged: { type: "boolean" },
    capAdd: { type: "array", items: { type: "string" } },
    securityOpt: { type: "array", items: { type: "string" } },
    runArgs: { type: "array", items: { type: "string" } },
    appPort: {
      oneOf: [
        { type: "number" },
        { type: "string" },
        {
          type: "array",
          items: { oneOf: [{ type: "number" }, { type: "string" }] },
        },
      ],
    },
    initializeCommand: {
      oneOf: [
        { type: "string" },
        { type: "array", items: { type: "string" } },
        { type: "object" },
      ],
    },
    hostRequirements: {
      type: "object",
      properties: {
        cpus: { type: "number" },
        memory: { type: "string" },
        storage: { type: "string" },
      },
    },
  },
  additionalProperties: true,
} as const;

export class SchemaValidator {
  private ajv: Ajv;
  private validate: ReturnType<Ajv["compile"]>;

  constructor() {
    this.ajv = new Ajv({ allErrors: true, strict: false });
    this.validate = this.ajv.compile(devcontainerSchema);
  }

  validateConfig(config: unknown): ValidationResult {
    if (config === null || config === undefined || typeof config !== "object") {
      return {
        valid: false,
        errors: [
          { path: "", message: "Configuration must be a non-null object" },
        ],
        warnings: [],
      };
    }

    const valid = this.validate(config);
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    if (!valid && this.validate.errors) {
      for (const err of this.validate.errors) {
        const path = err.instancePath || "/";
        const message = err.message || "Unknown validation error";
        errors.push({ path, message });
      }
    }

    // Generate warnings for common issues
    const cfg = config as Record<string, unknown>;
    if (!cfg.image && !cfg.dockerFile && !cfg.build && !cfg.dockerComposeFile) {
      warnings.push({
        path: "/",
        message:
          "Configuration should specify one of: image, dockerFile, build, or dockerComposeFile",
      });
    }

    return { valid: errors.length === 0, errors, warnings };
  }
}