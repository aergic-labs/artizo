/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Local-loopback plumbing shared by the ExecServer bridge.
 *
 * The `ssh -L` tunnel transport this module used to provide is gone: the
 * resolver reaches the SSH host's relay through the parent's ExecServer
 * (`tcpConnect`), so no `ssh` process is spawned on the apex.
 *
 * What remains is the contract the resolver holds on to (`TunnelController`,
 * so bridges can be stopped on dispose) and the free-port helper the bridge
 * needs to pick the apex-side listening port.
 */

import * as net from "node:net";

/**
 * Controller for a local listener that relays bytes somewhere else.
 *
 * The controller owns `localPort` for its lifetime: VS Code is told to
 * connect to that port, so it must not change.
 */
export interface TunnelController {
  /** The local port VS Code was told to connect to. */
  localPort: number;
  /** Stop the listener and drop active connections. Idempotent. */
  stop(): void;
  /** Whether the listener is still accepting connections. */
  isAlive(): boolean;
}

/**
 * Pick a free TCP port on the apex host's loopback.
 * Uses the OS by binding to port 0 and immediately closing.
 */
export function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as net.AddressInfo;
      const port = addr.port;
      server.close(() => resolve(port));
    });
  });
}