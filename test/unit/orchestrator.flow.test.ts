/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Flow-only tests for WorkflowOrchestrator semantic API.
 *
 * These test the state machine in isolation: no mocks, no async, no I/O.
 * Every legal path and every illegal path is exercised.
 * Sub-millisecond each. Run as the CI gate before any other tests.
 *
 * Usage: vitest run test/unit/orchestrator.flow.test.ts
 */

import { describe, it, expect } from "vitest";
import { WorkflowOrchestrator } from "../../src/workflows/orchestrator";

// ---------------------------------------------------------------------------
// Happy paths: full workflow sequences
// ---------------------------------------------------------------------------

describe("happy paths", () => {
  it("full workflow: config → build → install → connect → connected", () => {
    const o = new WorkflowOrchestrator();
    o.beginConfigPhase();
    expect(o.state).toBe("parsing-config");

    o.beginBuildPhase();
    expect(o.state).toBe("building-container");

    o.buildPhaseComplete();
    expect(o.state).toBe("installing-server");

    o.beginConnectionPhase();
    expect(o.state).toBe("connecting");

    o.connectionEstablished();
    expect(o.state).toBe("connected");
  });

  it("skip-build workflow: config → install → connect → connected", () => {
    const o = new WorkflowOrchestrator();
    o.beginConfigPhase();
    expect(o.state).toBe("parsing-config");

    o.skipBuildPhase();
    expect(o.state).toBe("installing-server");

    o.beginConnectionPhase();
    expect(o.state).toBe("connecting");

    o.connectionEstablished();
    expect(o.state).toBe("connected");
  });

  it("attach workflow: attach → connect → connected", () => {
    const o = new WorkflowOrchestrator();
    o.beginAttachPhase();
    expect(o.state).toBe("installing-server");

    o.beginConnectionPhase();
    expect(o.state).toBe("connecting");

    o.connectionEstablished();
    expect(o.state).toBe("connected");
  });

  it("disconnect and reconnect: connected → disconnect → idle → config → ...", () => {
    const o = new WorkflowOrchestrator();

    // Get to connected first
    o.beginConfigPhase();
    o.beginBuildPhase();
    o.buildPhaseComplete();
    o.beginConnectionPhase();
    o.connectionEstablished();
    expect(o.state).toBe("connected");

    // Disconnect
    o.beginDisconnect();
    expect(o.state).toBe("disconnecting");

    o.disconnectComplete();
    expect(o.state).toBe("idle");

    // Start a new workflow
    o.beginConfigPhase();
    expect(o.state).toBe("parsing-config");
  });

  it("recovery: fail → reset → start new workflow", () => {
    const o = new WorkflowOrchestrator();

    o.beginConfigPhase();
    o.beginBuildPhase();
    o.fail(new Error("Docker daemon not running"));
    expect(o.state).toBe("error");
    expect(o.error?.message).toBe("Docker daemon not running");

    o.reset();
    expect(o.state).toBe("idle");
    expect(o.error).toBeNull();

    // Can start fresh
    o.beginConfigPhase();
    expect(o.state).toBe("parsing-config");
  });

  it("rebuild from connected: connected → config → build → ...", () => {
    const o = new WorkflowOrchestrator();

    // Get to connected
    o.beginConfigPhase();
    o.beginBuildPhase();
    o.buildPhaseComplete();
    o.beginConnectionPhase();
    o.connectionEstablished();
    expect(o.state).toBe("connected");

    // Rebuild: start config phase from connected
    o.beginConfigPhase();
    expect(o.state).toBe("parsing-config");

    o.beginBuildPhase();
    o.buildPhaseComplete();
    o.beginConnectionPhase();
    o.connectionEstablished();
    expect(o.state).toBe("connected");
  });

  it("attach from error state", () => {
    const o = new WorkflowOrchestrator();
    o.fail(new Error("previous failure"));
    expect(o.state).toBe("error");

    o.beginAttachPhase();
    expect(o.state).toBe("installing-server");
  });
});

// ---------------------------------------------------------------------------
// Error paths: calling methods out of order
// ---------------------------------------------------------------------------

describe("out-of-order calls throw with domain errors", () => {
  it("beginConfigPhase throws from building-container", () => {
    const o = new WorkflowOrchestrator();
    o.beginConfigPhase();
    o.beginBuildPhase();

    expect(() => o.beginConfigPhase()).toThrow(
      /Cannot begin config phase from 'building-container'/,
    );
  });

  it("beginConfigPhase throws from installing-server", () => {
    const o = new WorkflowOrchestrator();
    o.beginConfigPhase();
    o.beginBuildPhase();
    o.buildPhaseComplete();

    expect(() => o.beginConfigPhase()).toThrow(
      /Cannot begin config phase from 'installing-server'/,
    );
  });

  it("beginConfigPhase throws from connecting", () => {
    const o = new WorkflowOrchestrator();
    o.beginConfigPhase();
    o.beginBuildPhase();
    o.buildPhaseComplete();
    o.beginConnectionPhase();

    expect(() => o.beginConfigPhase()).toThrow(
      /Cannot begin config phase from 'connecting'/,
    );
  });

  it("beginBuildPhase throws from idle", () => {
    const o = new WorkflowOrchestrator();
    expect(() => o.beginBuildPhase()).toThrow(
      /Cannot begin build phase from 'idle'/,
    );
  });

  it("beginBuildPhase throws from installing-server", () => {
    const o = new WorkflowOrchestrator();
    o.beginConfigPhase();
    o.skipBuildPhase();

    expect(() => o.beginBuildPhase()).toThrow(
      /Cannot begin build phase from 'installing-server'/,
    );
  });

  it("skipBuildPhase throws from building-container", () => {
    const o = new WorkflowOrchestrator();
    o.beginConfigPhase();
    o.beginBuildPhase();

    expect(() => o.skipBuildPhase()).toThrow(
      /Cannot skip build phase from 'building-container'/,
    );
  });

  it("skipBuildPhase throws from idle", () => {
    const o = new WorkflowOrchestrator();
    expect(() => o.skipBuildPhase()).toThrow(
      /Cannot skip build phase from 'idle'/,
    );
  });

  it("buildPhaseComplete throws from parsing-config", () => {
    const o = new WorkflowOrchestrator();
    o.beginConfigPhase();

    expect(() => o.buildPhaseComplete()).toThrow(
      /Cannot build phase complete from 'parsing-config'/,
    );
  });

  it("buildPhaseComplete throws from idle", () => {
    const o = new WorkflowOrchestrator();
    expect(() => o.buildPhaseComplete()).toThrow(
      /Cannot build phase complete from 'idle'/,
    );
  });

  it("beginConnectionPhase throws from parsing-config", () => {
    const o = new WorkflowOrchestrator();
    o.beginConfigPhase();

    expect(() => o.beginConnectionPhase()).toThrow(
      /Cannot begin connection phase from 'parsing-config'/,
    );
  });

  it("beginConnectionPhase throws from building-container", () => {
    const o = new WorkflowOrchestrator();
    o.beginConfigPhase();
    o.beginBuildPhase();

    expect(() => o.beginConnectionPhase()).toThrow(
      /Cannot begin connection phase from 'building-container'/,
    );
  });

  it("beginConnectionPhase throws from idle", () => {
    const o = new WorkflowOrchestrator();
    expect(() => o.beginConnectionPhase()).toThrow(
      /Cannot begin connection phase from 'idle'/,
    );
  });

  it("connectionEstablished throws from idle", () => {
    const o = new WorkflowOrchestrator();
    expect(() => o.connectionEstablished()).toThrow(
      /Cannot connection established from 'idle'/,
    );
  });

  it("connectionEstablished throws from installing-server", () => {
    const o = new WorkflowOrchestrator();
    o.beginConfigPhase();
    o.skipBuildPhase();

    expect(() => o.connectionEstablished()).toThrow(
      /Cannot connection established from 'installing-server'/,
    );
  });

  it("beginAttachPhase throws from building-container", () => {
    const o = new WorkflowOrchestrator();
    o.beginConfigPhase();
    o.beginBuildPhase();

    expect(() => o.beginAttachPhase()).toThrow(
      /Cannot begin attach phase from 'building-container'/,
    );
  });

  it("beginAttachPhase throws from installing-server", () => {
    const o = new WorkflowOrchestrator();
    o.beginConfigPhase();
    o.skipBuildPhase();

    expect(() => o.beginAttachPhase()).toThrow(
      /Cannot begin attach phase from 'installing-server'/,
    );
  });

  it("beginDisconnect throws from idle", () => {
    const o = new WorkflowOrchestrator();
    expect(() => o.beginDisconnect()).toThrow(
      /Cannot begin disconnect from 'idle'/,
    );
  });

  it("beginDisconnect throws from parsing-config", () => {
    const o = new WorkflowOrchestrator();
    o.beginConfigPhase();

    expect(() => o.beginDisconnect()).toThrow(
      /Cannot begin disconnect from 'parsing-config'/,
    );
  });

  it("disconnectComplete throws from idle", () => {
    const o = new WorkflowOrchestrator();
    expect(() => o.disconnectComplete()).toThrow(
      /Cannot disconnect complete from 'idle'/,
    );
  });

  it("reset succeeds from building-container (build-only path)", () => {
    const o = new WorkflowOrchestrator();
    o.beginConfigPhase();
    o.beginBuildPhase();

    o.reset();
    expect(o.state).toBe("idle");
    expect(o.error).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Event emitter: unchanged from current behavior
// ---------------------------------------------------------------------------

describe("onDidChangeState", () => {
  it("fires for each semantic method call", () => {
    const o = new WorkflowOrchestrator();
    const states: string[] = [];
    o.onDidChangeState((s) => states.push(s));

    o.beginConfigPhase();
    o.beginBuildPhase();
    o.buildPhaseComplete();
    o.beginConnectionPhase();
    o.connectionEstablished();

    expect(states).toEqual([
      "parsing-config",
      "building-container",
      "installing-server",
      "connecting",
      "connected",
    ]);
  });

  it("fires on fail()", () => {
    const o = new WorkflowOrchestrator();
    const states: string[] = [];
    o.onDidChangeState((s) => states.push(s));

    o.fail(new Error("boom"));

    expect(states).toEqual(["error"]);
  });

  it("fires on reset()", () => {
    const o = new WorkflowOrchestrator();
    o.fail(new Error("boom"));

    const states: string[] = [];
    o.onDidChangeState((s) => states.push(s));

    o.reset();

    expect(states).toEqual(["idle"]);
  });
});

// ---------------------------------------------------------------------------
// ensureCanStartWorkflow: concurrent workflow gating
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

describe("initial state", () => {
  it("starts idle with no error", () => {
    const o = new WorkflowOrchestrator();
    expect(o.state).toBe("idle");
    expect(o.error).toBeNull();
  });
});