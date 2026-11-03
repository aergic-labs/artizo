/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// Regression: mergeConfiguration (called after a successful image build) threw
// "Cannot convert object to primitive value" when forwardPorts contained an
// object entry, because mergeForwardPorts ran RegExp.test on it.
// This file is excluded from tsconfig.test.json: importing the vendored CLI
// pulls its own sources into our typecheck program, which they do not satisfy.

import { describe, it, expect } from "vitest";
import { mergeConfiguration } from "../../vendor/devcontainers-cli/src/spec-node/imageMetadata";

describe("mergeConfiguration forwardPorts", () => {
  it("normalizes object ports and does not throw", () => {
    const merged = mergeConfiguration({ image: "x" } as never, [
      {
        forwardPorts: [
          3000,
          { port: 8080 } as never,
          "not-a-port",
          99999,
          { foo: 1 } as never,
        ],
      } as never,
    ]);
    expect(merged.forwardPorts).toEqual([3000, 8080, "not-a-port", 99999]);
  });

  it("dedupes an object port that duplicates a numeric port", () => {
    const merged = mergeConfiguration({ image: "x" } as never, [
      { forwardPorts: [8080, { port: 8080 } as never] } as never,
    ]);
    expect(merged.forwardPorts).toEqual([8080]);
  });

  it("returns undefined when there are no ports", () => {
    const merged = mergeConfiguration({ image: "x" } as never, [{} as never]);
    expect(merged.forwardPorts).toBeUndefined();
  });
});
