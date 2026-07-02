/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect } from "vitest";
import { SchemaValidator } from "../../src/config/schemaValidator";

describe("SchemaValidator", () => {
  const validator = new SchemaValidator();

  describe("validateConfig", () => {
    it("accepts a valid image-based config", () => {
      const result = validator.validateConfig({
        name: "My Container",
        image: "node:20",
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("accepts a valid build-based config", () => {
      const result = validator.validateConfig({
        build: {
          dockerfile: "Dockerfile",
          context: ".",
          args: { NODE_VERSION: "20" },
        },
      });
      expect(result.valid).toBe(true);
    });

    it("accepts a valid compose-based config", () => {
      const result = validator.validateConfig({
        dockerComposeFile: ["docker-compose.yml", "docker-compose.dev.yml"],
        service: "app",
        runServices: ["app", "db"],
        workspaceFolder: "/workspace",
      });
      expect(result.valid).toBe(true);
    });

    it("rejects non-object values", () => {
      expect(validator.validateConfig(null).valid).toBe(false);
      expect(validator.validateConfig(undefined).valid).toBe(false);
      expect(validator.validateConfig(42).valid).toBe(false);
      expect(validator.validateConfig("string").valid).toBe(false);
      expect(validator.validateConfig([]).valid).toBe(false);
    });

    it("rejects invalid property types", () => {
      const result = validator.validateConfig({
        name: 123, // should be string
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.path.includes("name"))).toBe(true);
    });

    it("rejects invalid forwardPorts type", () => {
      const result = validator.validateConfig({
        image: "node:18",
        forwardPorts: { port: 3000 }, // should be array
      });
      expect(result.valid).toBe(false);
    });

    it("accepts forwardPorts with mixed number and string entries", () => {
      const result = validator.validateConfig({
        image: "node:18",
        forwardPorts: [3000, "8080:8080"],
      });
      expect(result.valid).toBe(true);
    });

    it("accepts additional unknown properties", () => {
      const result = validator.validateConfig({
        image: "node:18",
        someCustomProperty: "value",
        anotherOne: { nested: true },
      });
      expect(result.valid).toBe(true);
    });

    it("falls back to default message when error has no message", () => {
      // Monkey-patch the compiled validator to return an error without a message
      const origValidate = (validator as any).validate;
      (validator as any).validate = (config: unknown) => {
        const valid = origValidate(config);
        if (!valid) {
          (validator as any).validate.errors = [
            { instancePath: "/test", message: undefined },
          ];
        }
        return valid;
      };

      const result = validator.validateConfig({ name: 123 });
      expect(result.errors).toEqual([
        { path: "/test", message: "Unknown validation error" },
      ]);

      // Restore
      (validator as any).validate = origValidate;
    });

    it("validates shutdownAction enum", () => {
      const validResult = validator.validateConfig({
        image: "node:18",
        shutdownAction: "stopContainer",
      });
      expect(validResult.valid).toBe(true);

      const invalidResult = validator.validateConfig({
        image: "node:18",
        shutdownAction: "invalidAction",
      });
      expect(invalidResult.valid).toBe(false);
    });

    it("validates mounts as array of strings or objects", () => {
      const result = validator.validateConfig({
        image: "node:18",
        mounts: [
          "source=/var/run/docker.sock,target=/var/run/docker.sock,type=bind",
          { source: "/host/path", target: "/container/path", type: "bind" },
        ],
      });
      expect(result.valid).toBe(true);
    });

    it("generates warning when no image source is specified", () => {
      const result = validator.validateConfig({
        name: "No Image",
        forwardPorts: [3000],
      });
      expect(result.valid).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(0);
    });

    it("does not generate warning when image is specified", () => {
      const result = validator.validateConfig({
        image: "node:18",
      });
      expect(result.warnings).toHaveLength(0);
    });

    it("does not generate warning when dockerFile is specified", () => {
      const result = validator.validateConfig({
        dockerFile: "Dockerfile",
      });
      expect(result.warnings).toHaveLength(0);
    });

    it("does not generate warning when build is specified", () => {
      const result = validator.validateConfig({
        build: { dockerfile: "Dockerfile" },
      });
      expect(result.warnings).toHaveLength(0);
    });

    it("does not generate warning when dockerComposeFile is specified", () => {
      const result = validator.validateConfig({
        dockerComposeFile: "docker-compose.yml",
        service: "app",
      });
      expect(result.warnings).toHaveLength(0);
    });
  });
});
