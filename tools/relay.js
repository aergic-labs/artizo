/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// TCP relay script deployed alongside <vendor>-reh inside containers.
// Usage: node relay.js <port>
// Connects to 127.0.0.1:<port> and pipes stdin/stdout bidirectionally.
// Uses stream.pipeline for proper error propagation and cleanup.

const net = require("net");
const { pipeline } = require("stream");

const port = parseInt(process.argv[2], 10);
if (!port || port < 1 || port > 65535) {
  process.stderr.write("Error: Invalid port specified\n");
  process.exit(1);
}

// Prevent Node from crashing on broken standard pipes
process.stdout.on("error", () => process.exit(1));
process.stderr.on("error", () => process.exit(1));

const conn = net.createConnection(port, "127.0.0.1");

// Enable TCP KeepAlive to detect dead sockets in devcontainers early
conn.setKeepAlive(true, 5000);
conn.setNoDelay(true); // Disable Nagle's algorithm for low latency

// Pipeline 1: Stdin -> TCP Socket
pipeline(process.stdin, conn, (err) => {
  if (err) process.exit(1);
  process.exit(0);
});

// Pipeline 2: TCP Socket -> Stdout
pipeline(conn, process.stdout, (err) => {
  if (err) process.exit(1);
  process.exit(0);
});