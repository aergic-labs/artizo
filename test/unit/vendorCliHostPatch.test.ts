/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Guards the artizo patch to the vendored devcontainers CLI.
 *
 * `patches/devcontainers-cli-clihost.patch` adds a `runWithCLIHost` seam
 * (AsyncLocalStorage) to `vendor/devcontainers-cli/src/spec-common/cliHost.ts`
 * so the CLI and `readResolvedConfig` can target a remote host without a
 * process-global override. If the vendored CLI is ever re-synced/updated
 * without reapplying that patch, these tests fail.
 */

import { describe, it, expect } from "vitest";

// Non-analyzable on purpose: tsc must not follow this into the vendor tree
// (not part of either tsconfig program), while vite-node resolves it at
// runtime. Same pattern as readResolvedConfig.test.ts.
const vendorRoot = "../../vendor/devcontainers-cli/src";

interface CliHostModule {
  runWithCLIHost?: <T>(host: unknown, fn: () => T) => T;
  getCLIHost: (
    cwd: string,
    loadNativeModule: (name: string) => Promise<unknown>,
    allowInheritTTY: boolean,
  ) => Promise<unknown>;
}

async function loadCliHost(): Promise<CliHostModule> {
  return (await import(`${vendorRoot}/spec-common/cliHost`)) as CliHostModule;
}

function loadLocal(): Promise<unknown> {
  return Promise.resolve(undefined);
}

describe("vendored CLIHost patch", () => {
  it("exposes runWithCLIHost (patch applied)", async () => {
    const mod = await loadCliHost();
    expect(typeof mod.runWithCLIHost).toBe("function");
  });

  it("getCLIHost returns the injected host across an async boundary", async () => {
    const mod = await loadCliHost();
    const fake = { type: "ssh", cwd: "/home/dev/project" };

    const host = await mod.runWithCLIHost!(fake, async () => {
      await new Promise((r) => setTimeout(r, 1));
      return mod.getCLIHost("/tmp", loadLocal, false);
    });

    expect(host).toBe(fake);
  });

  it("isolates concurrent call chains", async () => {
    const mod = await loadCliHost();
    const a = { type: "ssh", tag: "a" };
    const b = { type: "ssh", tag: "b" };

    const gotA = mod.runWithCLIHost!(a, async () => {
      await new Promise((r) => setTimeout(r, 2));
      return mod.getCLIHost("/tmp", loadLocal, false);
    });
    const gotB = mod.runWithCLIHost!(b, async () => {
      await new Promise((r) => setTimeout(r, 1));
      return mod.getCLIHost("/tmp", loadLocal, false);
    });

    expect(await gotA).toBe(a);
    expect(await gotB).toBe(b);
  });

  it("getCLIHost falls back to the local host outside runWithCLIHost", async () => {
    const mod = await loadCliHost();
    const host = (await mod.getCLIHost("/tmp", loadLocal, false)) as {
      type?: string;
    };
    expect(host?.type).toBe("local");
  });
});