/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect } from "vitest";
import { repairDevcontainerJson } from "../../src/sidebar/jsonRepair";

describe("repairDevcontainerJson", () => {
  it("passes through valid JSON unchanged", () => {
    const input = `{
  "name": "Test",
  "image": "node:18"
}`;
    expect(repairDevcontainerJson(input)).toBe(input);
  });

  it("converts smart quotes to ASCII", () => {
    const input = `{
  "name": "Test",
  "image": "node:18"
}`;
    const result = repairDevcontainerJson(input);
    expect(result).not.toContain("\u201C");
    expect(result).not.toContain("\u201D");
    expect(result).not.toContain("\u2018");
    expect(result).not.toContain("\u2019");
  });

  it("collapses duplicate commas", () => {
    const result = repairDevcontainerJson(`{
  "name": "Test",,
  "image": "node:18"
}`);
    expect(result).toContain('"name": "Test",');
    expect(result).not.toContain(",,");
  });

  it("handles trailing comma in array", () => {
    const result = repairDevcontainerJson(`{
  "runArgs": [
    "--privileged",
  ]
}`);
    expect(result).toContain('"--privileged"');
    expect(result).toContain('"runArgs"');
  });

  it("converts single-quoted strings to double", () => {
    const result = repairDevcontainerJson(`{
  'name': 'Test'
}`);
    expect(result).toContain('"name": "Test"');
    expect(result).not.toContain("'Test'");
  });

  it("quotes unquoted keys", () => {
    const result = repairDevcontainerJson(`{
  name: "Test",
  image: "node:18"
}`);
    expect(result).toContain('"name"');
    expect(result).toContain('"image"');
  });

  it("fixes extra unbalanced braces", () => {
    // The test-project bug: stray } in array
    const input = `{
  "runArgs": [
    "--privileged",}
  ],
  "mounts": []
}`;
    const result = repairDevcontainerJson(input);
    expect(result).toContain('"runArgs"');
    expect(result).toContain('"mounts"');
    expect(result).toContain('"--privileged"');
    // Should parse as valid JSON
    JSON.parse(result);
  });

  it("fixes dangling extra brackets", () => {
    const input = `{
  "forwardPorts": [],
  "runArgs": [
    "--gpus", "all"
  ],]
  "mounts": []
}`;
    const result = repairDevcontainerJson(input);
    JSON.parse(result);
    expect(result).toContain('"mounts"');
  });

  it("converts bare true/false/null values", () => {
    const input = `{
  "name": True,
  "enabled": FALSE,
  "optional": null
}`;
    const result = repairDevcontainerJson(input);
    expect(result).toContain('"name": true');
    expect(result).toContain('"enabled": false');
    expect(result).toContain('"optional": null');
  });

  it("converts None and undefined to null", () => {
    const input = `{
  "name": None,
  "config": undefined
}`;
    const result = repairDevcontainerJson(input);
    expect(result).toContain('"name": null');
    expect(result).toContain('"config": null');
  });

  it("preserves comments through repair", () => {
    const input = `{
  // This is a comment
  "name": "Test",
  /* block comment */
  "image": "node:18"
  // trailing
}`;
    const result = repairDevcontainerJson(input);
    expect(result).toContain("// This is a comment");
    expect(result).toContain("/* block comment */");
  });

  it("appends missing closing brackets", () => {
    const input = `{
  "name": "Test",
  "features": {
    "node": {}
  `;
    const result = repairDevcontainerJson(input);
    // Should close the open braces
    JSON.parse(result);
  });

  it("handles completely broken input gracefully", () => {
    const input = `not json at all {{{`;
    // Should not throw
    expect(() => repairDevcontainerJson(input)).not.toThrow();
  });

  it("normalizes None values back to null", () => {
    const input = `{ "python": None }`;
    const result = repairDevcontainerJson(input);
    expect(result).toContain('"python": null');
  });

  it("preserves existing valid configuration", () => {
    const input = `{
  "name": "Dev Container",
  "image": "mcr.microsoft.com/devcontainers/base:ubuntu",
  "features": {
    "ghcr.io/devcontainers/features/node:1": {
      "version": "20"
    }
  },
  "forwardPorts": [],
  "customizations": {
    "vscode": {
      "extensions": []
    }
  }
}`;
    const result = repairDevcontainerJson(input);
    expect(result).toContain('"name": "Dev Container"');
    expect(result).toContain('"features"');
    expect(result).toContain('"forwardPorts"');
    JSON.parse(result);
  });
});
