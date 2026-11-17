/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect } from "vitest";
import { pickFreePort, type TunnelController } from "../../src/remote/sshTunnel";

describe("pickFreePort", () => {
  it("returns a usable loopback port", async () => {
    const port = await pickFreePort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65536);
  });

  it("returns distinct ports across calls", async () => {
    const a = await pickFreePort();
    const b = await pickFreePort();
    expect(a).not.toBe(b);
  });

  it("TunnelController is the shape the resolver stores", () => {
    const controller: TunnelController = {
      localPort: 1234,
      stop: () => {},
      isAlive: () => true,
    };
    expect(controller.localPort).toBe(1234);
    expect(controller.isAlive()).toBe(true);
  });
});