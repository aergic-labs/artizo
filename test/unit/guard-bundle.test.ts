/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect } from "vitest";
import {
  findForbidden,
  FORBIDDEN_TERMS,
  // @ts-expect-error - plain ESM script without type declarations
} from "../../scripts/guard-bundle.mjs";

describe("findForbidden", () => {
  it("detects case-insensitive substrings with counts", () => {
    const hits = findForbidden("Kiro and kiro and KIRO", ["kiro"]);
    expect(hits).toHaveLength(1);
    expect(hits[0].term).toBe("kiro");
    expect(hits[0].count).toBe(3);
  });

  it("returns empty for a clean string", () => {
    expect(findForbidden("icube chat open with query", ["kiro", "devin"])).toEqual(
      [],
    );
  });

  it("ignores innocent substrings (trae inside reportExtraError)", () => {
    expect(findForbidden("exports.reportExtraError = reportExtraError", ["trae"])).toEqual(
      [],
    );
  });

  it("still catches a brand embedded at a token start (kiroAgent)", () => {
    const hits = findForbidden('executeCommand("kiroAgent.agent.askAgent")', ["kiro"]);
    expect(hits).toHaveLength(1);
    expect(hits[0].count).toBe(1);
  });

  it("flags a leaked Devin command in the Kiro forbidden set", () => {
    const hits = findForbidden(
      'executeCommand("devin.executeCascadeAction")',
      FORBIDDEN_TERMS.kiro,
    );
    expect(hits.map((h: { term: string }) => h.term)).toContain("devin");
  });

  it("flags the historical kiro leak (comment + poll string)", () => {
    const leak = `Returns "kiro" for full interactive agent ... kiroAgent.executions.getPendingQuestions`;
    const hits = findForbidden(leak, FORBIDDEN_TERMS.trae);
    expect(hits.find((h: { term: string }) => h.term === "kiro")?.count).toBe(2);
  });
});

describe("FORBIDDEN_TERMS", () => {
  it("trae forbids competitors but not its own icube", () => {
    expect(FORBIDDEN_TERMS.trae).toEqual(
      expect.arrayContaining(["kiro", "devin", "windsurf"]),
    );
    expect(FORBIDDEN_TERMS.trae).not.toContain("icube");
  });

  it("devin allows windsurf (its own lineage) but forbids kiro/trae/icube", () => {
    expect(FORBIDDEN_TERMS.devin).not.toContain("windsurf");
    expect(FORBIDDEN_TERMS.devin).toEqual(
      expect.arrayContaining(["kiro", "trae", "icube"]),
    );
  });

  it("kiro forbids all other vendors", () => {
    expect(FORBIDDEN_TERMS.kiro).toEqual(
      expect.arrayContaining(["trae", "icube", "devin", "windsurf"]),
    );
  });
});
