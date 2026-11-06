/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// Regression: object entries in forwardPorts (e.g. { port, label }) are not
// in the spec and previously crashed the vendored CLI's mergeForwardPorts
// regex ("Cannot convert object to primitive value"). A patch once
// normalized them in the vendored file; that has been reverted and the
// spec is now enforced at the Artizo boundary instead.

import { describe, it, expect } from "vitest";
import {
  validateForwardPorts,
  assertForwardPortsValid,
} from "../../src/devcontainer/forwardPortsValidation";

describe("validateForwardPorts", () => {
  it("accepts numbers and strings", () => {
    expect(validateForwardPorts([3000, "localhost:8080", 5432])).toEqual([]);
  });

  it("rejects object entries, naming the value", () => {
    const issues = validateForwardPorts([
      3000,
      { port: 5432, label: "DB" },
      { foo: 1 },
    ]);
    expect(issues).toHaveLength(2);
    expect(issues[0].message).toContain('"port":5432');
    expect(issues[issues.length - 1].message).toContain('"foo":1');
  });

  it("rejects a non-array forwardPorts", () => {
    const issues = validateForwardPorts(3000);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toBe("forwardPorts must be an array");
  });

  it("treats absent forwardPorts as valid", () => {
    expect(validateForwardPorts(undefined)).toEqual([]);
    expect(validateForwardPorts(null)).toEqual([]);
  });
});

describe("assertForwardPortsValid", () => {
  it("throws naming the config path and each bad entry", () => {
    const config = {
      forwardPorts: [3000, { port: 5432, label: "DB" }],
    };
    expect(() =>
      assertForwardPortsValid(config, "/work/.devcontainer/devcontainer.json"),
    ).toThrow(/Invalid forwardPorts in \/work\/\.devcontainer\/devcontainer\.json.*"port":5432/);
  });

  it("does not throw for a spec-valid config", () => {
    expect(() =>
      assertForwardPortsValid({ forwardPorts: [3000, "localhost:8080"] }, "/x"),
    ).not.toThrow();
  });

  it("does not throw when forwardPorts is absent", () => {
    expect(() => assertForwardPortsValid({ image: "x" }, "/x")).not.toThrow();
    expect(() => assertForwardPortsValid(null, "/x")).not.toThrow();
  });
});
