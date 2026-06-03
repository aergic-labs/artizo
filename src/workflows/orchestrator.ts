/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Workflow orchestrator and state machine for dev container operations.
 *
 * The orchestrator owns the valid phase sequences. Workflows declare which
 * phases they need as closures. The orchestrator runs them in order with
 * correct state transitions. This replaces the old pattern where every
 * workflow manually called beginConfigPhase, beginBuildPhase, etc.
 *
 * The state machine is defined in orchestrator-config.json. A single
 * source of truth for all valid transitions. Adding a new edge is one
 * entry in one JSON array. No if-statement changes needed.
 */

import { EventEmitter } from "node:events";
import config from "./orchestrator-config.json";
import type { ProgressReport } from "./types";

// ── Public types ────────────────────────────────────────────────────

export type WorkflowState =
  | "idle"
  | "parsing-config"
  | "building-container"
  | "installing-server"
  | "connecting"
  | "connected"
  | "disconnecting"
  | "error";

/** Returned by build phase (or skip) for downstream phases. */
export interface BuildResult {
  containerId: string;
  remoteUser: string;
  remoteWorkspaceFolder: string;
}

/**
 * Declarative spec for the build phase of a workflow.
 *
 * If skip returns a BuildResult, the build phase is bypassed. The
 * orchestrator transitions directly to installing-server and returns
 * the skip result as if it were a build result.
 *
 * run receives a report callback for progress. Callers typically wrap
 * this in their own showProgress for richer UI.
 */
export interface BuildSpec {
  label: string;
  skip?: () => Promise<BuildResult | null>;
  run: (progress: ProgressReport) => Promise<BuildResult>;
}

/**
 * A workflow definition. At minimum a workflow has a config phase. The
 * build phase is optional (build-only and attach workflows skip it). The
 * orchestrator owns state transitions. The workflow provides the domain
 * logic at each phase.
 */
export interface WorkflowSpec {
  /** Human-readable name for logging */
  name: string;

  /** Config phase: read and validate devcontainer.json */
  config: () => Promise<void>;

  /** Build phase: build/start the container (optional) */
  build?: BuildSpec;
}

// ── Interfaces ──────────────────────────────────────────────────────

export interface IWorkflowOrchestrator {
  readonly state: WorkflowState;
  readonly error: Error | null;

  // ── High-level runner (new API) ────────────────────────────────

  /**
   * Run a workflow's config and build phases. Returns the build result for
   * downstream phases (connect, window management) that the workflow
   * handles itself.
   *
   * Throws on failure. The orchestrator transitions to error state and
   * re-throws. The workflow is responsible for error UX.
   */
  run(spec: WorkflowSpec): Promise<BuildResult | null>;

  // ── Low-level state transitions (for workflows that don't fit the
  //    standard config, build, connect pattern) ──────────────────

  beginConfigPhase(): void;
  beginAttachPhase(): void;
  beginBuildPhase(): void;
  skipBuildPhase(): void;
  buildPhaseComplete(): void;
  beginConnectionPhase(): void;
  connectionEstablished(): void;
  beginDisconnect(): void;
  disconnectComplete(): void;
  fail(error: Error): void;
  reset(): void;
  onDidChangeState(listener: (state: WorkflowState) => void): void;
}

// ── Implementation ──────────────────────────────────────────────────

export class WorkflowOrchestrator implements IWorkflowOrchestrator {
  private _state: WorkflowState = "idle";
  private _error: Error | null = null;
  private readonly emitter = new EventEmitter();

  get state(): WorkflowState {
    return this._state;
  }
  get error(): Error | null {
    return this._error;
  }

  onDidChangeState(listener: (state: WorkflowState) => void): void {
    this.emitter.on("didChangeState", listener);
  }

  // ── High-level runner ──────────────────────────────────────────

  async run(spec: WorkflowSpec): Promise<BuildResult | null> {
    try {
      // Phase 1: Config
      this.beginConfigPhase();
      await spec.config();

      // Phase 2: Build (optional)
      if (!spec.build) return null;

      const skipped = spec.build.skip ? await spec.build.skip() : null;
      if (skipped) {
        this.skipBuildPhase();
        return skipped;
      }

      this.beginBuildPhase();
      const result = await spec.build.run({ report: (_msg) => {} });
      this.buildPhaseComplete();
      return result;
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (this._state !== "error") {
        this.fail(error);
      }
      throw error;
    }
  }

  // ── Semantic state transitions ─────────────────────────────────

  beginConfigPhase(): void {
    this.assertTransition("beginConfigPhase");
  }
  beginAttachPhase(): void {
    this.assertTransition("beginAttachPhase");
  }
  beginBuildPhase(): void {
    this.assertTransition("beginBuildPhase");
  }
  skipBuildPhase(): void {
    this.assertTransition("skipBuildPhase");
  }
  buildPhaseComplete(): void {
    this.assertTransition("buildPhaseComplete");
  }
  beginConnectionPhase(): void {
    this.assertTransition("beginConnectionPhase");
  }
  connectionEstablished(): void {
    this.assertTransition("connectionEstablished");
  }
  beginDisconnect(): void {
    this.assertTransition("beginDisconnect");
  }
  disconnectComplete(): void {
    this.assertTransition("disconnectComplete");
  }

  // ── Unconditional state changes ─────────────────────────────────

  fail(error: Error): void {
    this._error = error;
    this._state = "error";
    this.emitter.emit("didChangeState", "error");
  }

  reset(): void {
    this._error = null;
    this._state = "idle";
    this.emitter.emit("didChangeState", "idle");
  }

  // ── Private: table-driven transition validation ─────────────────

  private assertTransition(methodName: string): void {
    const method = (
      config.methods as Record<
        string,
        { from: string[]; to: string; why: string }
      >
    )[methodName];

    if (!method.from.includes(this._state)) {
      const label = methodName
        .replace(/([A-Z])/g, " $1")
        .toLowerCase()
        .trim();
      const why =
        (config.why as Record<string, string>)[method.why] ?? method.why;
      throw new Error(`Cannot ${label} from '${this._state}': ${why}`);
    }

    if (this._state === "error") {
      this._error = null;
    }
    this._state = method.to as WorkflowState;
    this.emitter.emit("didChangeState", this._state);
  }
}