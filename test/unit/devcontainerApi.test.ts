/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi } from "vitest";

import { withDefaults } from "../../src/devcontainer/api";

describe("devcontainer/api", () => {
  describe("withDefaults", () => {
    it("fills all defaults for minimal input", () => {
      const log = vi.fn();
      const result = withDefaults({ workspaceFolder: "/ws", log });

      expect(result.workspaceFolder).toBe("/ws");
      expect(result.log).toBe(log);
      expect(result.dockerPath).toBe("docker");
      expect(result.logLevel).toBe(1);
      expect(result.logFormat).toBe("json");
      expect(result.defaultUserEnvProbe).toBe("loginInteractiveShell");
      expect(result.removeExistingContainer).toBe(false);
      expect(result.buildNoCache).toBe(false);
      expect(result.postCreateEnabled).toBe(true);
      expect(result.skipNonBlocking).toBe(false);
      expect(result.prebuild).toBe(false);
      expect(result.additionalMounts).toEqual([]);
      expect(result.updateRemoteUserUIDDefault).toBe("never");
      expect(result.remoteEnv).toEqual({});
      expect(result.additionalCacheFroms).toEqual([]);
      expect(result.useBuildKit).toBe("auto");
      expect(result.buildxPush).toBe(false);
      expect(result.additionalLabels).toEqual([]);
      expect(result.additionalFeatures).toEqual({});
      expect(result.skipFeatureAutoMapping).toBe(false);
      expect(result.skipPostAttach).toBe(false);
      expect(result.skipPersistingCustomizationsFromFeatures).toBe(false);
      expect(result.omitConfigRemotEnvFromMetadata).toBe(false);
      expect(result.dotfiles).toEqual({ targetPath: "~/dotfiles" });
      expect(result.noLockfile).toBe(false);
      expect(result.frozenLockfile).toBe(false);
      expect(result.omitSyntaxDirective).toBe(false);
      expect(result.includeConfig).toBe(false);
      expect(result.includeMergedConfig).toBe(false);
      expect(result.mountWorkspaceGitRoot).toBe(false);
      expect(result.mountGitWorktreeCommonDir).toBe(false);
    });

    it("overrides individual defaults", () => {
      const log = vi.fn();
      const result = withDefaults({
        workspaceFolder: "/ws",
        log,
        dockerPath: "/custom/docker",
        logLevel: 2,
        buildNoCache: true,
        removeExistingContainer: true,
      });

      expect(result.dockerPath).toBe("/custom/docker");
      expect(result.logLevel).toBe(2);
      expect(result.buildNoCache).toBe(true);
      expect(result.removeExistingContainer).toBe(true);
      // Un-overridden defaults should stay
      expect(result.postCreateEnabled).toBe(true);
    });

    it("passes through extra keys", () => {
      const log = vi.fn();
      const result = withDefaults({
        workspaceFolder: "/ws",
        log,
        customField: "value",
      } as any);

      expect((result as any).customField).toBe("value");
    });
  });
});