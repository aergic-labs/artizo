/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  setActiveExecServer,
  getActiveExecServer,
} from "../../src/remote/execServerCache";
import type { ExecServer } from "../../src/remote/execServerBridge";

describe("execServerCache", () => {
  beforeEach(() => setActiveExecServer(undefined));

  it("returns undefined by default", () => {
    expect(getActiveExecServer()).toBeUndefined();
  });

  it("returns the cached ExecServer", () => {
    const es = { tcpConnect: vi.fn() } as unknown as ExecServer;
    setActiveExecServer(es);
    expect(getActiveExecServer()).toBe(es);
  });

  it("clears when set to undefined", () => {
    setActiveExecServer({ tcpConnect: vi.fn() } as unknown as ExecServer);
    setActiveExecServer(undefined);
    expect(getActiveExecServer()).toBeUndefined();
  });
});