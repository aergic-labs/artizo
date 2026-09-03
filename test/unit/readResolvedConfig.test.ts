/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  readResolvedConfig,
  setVendorConfigReader,
  type VendorConfigReader,
} from "../../src/devcontainer/readResolvedConfig";

// The src-side lazy require() is not loadable under vitest (same as api.ts,
// whose vendor path no test exercises). Inject the real modules so the
// actual substitution logic runs. The specifiers are non-analyzable on
// purpose: tsc must not follow them into the vendor tree (it is not part of
// either tsconfig program), while vite-node resolves them at runtime.
const vendorRoot = "../../vendor/devcontainers-cli/src";

async function loadRealVendor(): Promise<VendorConfigReader> {
  const [cliHost, commonUtils, workspaces, log, configContainer] =
    await Promise.all([
      import(`${vendorRoot}/spec-common/cliHost`),
      import(`${vendorRoot}/spec-common/commonUtils`),
      import(`${vendorRoot}/spec-utils/workspaces`),
      import(`${vendorRoot}/spec-utils/log`),
      import(`${vendorRoot}/spec-node/configContainer`),
    ]);
  return {
    getCLIHost: cliHost.getCLIHost,
    loadNativeModule: commonUtils.loadNativeModule,
    workspaceFromPath: workspaces.workspaceFromPath,
    nullLog: log.nullLog,
    readDevContainerConfigFile: configContainer.readDevContainerConfigFile,
  };
}

describe("readResolvedConfig", () => {
  let tmpDir: string;
  let configPath: string;
  // USER may not exist in the build environment (e.g. some CI containers);
  // save and restore it so the test controls the value it expands to.
  const hadUser = Object.prototype.hasOwnProperty.call(process.env, "USER");
  const originalUser = process.env.USER;

  beforeEach(async () => {
    setVendorConfigReader(await loadRealVendor());
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "artizo-read-resolved-"));
    const devcontainerDir = path.join(tmpDir, ".devcontainer");
    fs.mkdirSync(devcontainerDir);
    configPath = path.join(devcontainerDir, "devcontainer.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        image: "node:18",
        workspaceFolder: "/home/${localEnv:USER}/ws",
        remoteEnv: { LOCAL_USER: "${localEnv:USER}" },
      }),
    );
    process.env.USER = "artizo-test-user";
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    setVendorConfigReader(undefined);
    if (hadUser) {
      process.env.USER = originalUser;
    } else {
      delete process.env.USER;
    }
  });

  it("expands ${localEnv:USER} in workspaceFolder to the host user's name (issue #12)", async () => {
    const result = await readResolvedConfig(tmpDir, configPath);
    expect(result.workspaceFolder).toBe("/home/artizo-test-user/ws");
  });

  it("substitutes ${localEnv:USER} everywhere in the config, not just workspaceFolder", async () => {
    const result = await readResolvedConfig(tmpDir, configPath);
    expect(result.config.workspaceFolder).toBe("/home/artizo-test-user/ws");
    expect(
      (result.config.remoteEnv as Record<string, string>).LOCAL_USER,
    ).toBe("artizo-test-user");
  });

  it("uses the default value when the env var is unset (${localEnv:MISSING_VAR:fallback})", async () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        image: "node:18",
        workspaceFolder: "/home/${localEnv:ARTIZO_UNSET_VAR:fallback}/ws",
      }),
    );
    const result = await readResolvedConfig(tmpDir, configPath);
    expect(result.workspaceFolder).toBe("/home/fallback/ws");
  });

  it("computes a default workspaceFolder when the config omits it", async () => {
    fs.writeFileSync(configPath, JSON.stringify({ image: "node:18" }));
    const result = await readResolvedConfig(tmpDir, configPath);
    expect(typeof result.workspaceFolder).toBe("string");
    expect(result.workspaceFolder.length).toBeGreaterThan(0);
  });
});
