/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetExtension } = vi.hoisted(() => ({
  mockGetExtension: vi.fn(),
}));

vi.mock("vscode", () => ({
  extensions: {
    getExtension: mockGetExtension,
  },
}));

import { GenericAiAssist } from "../../src/ai/generic";

function mockClineExt(exports?: unknown) {
  mockGetExtension.mockReturnValue({
    isActive: true,
    exports: exports ?? {
      startNewTask: vi.fn().mockResolvedValue(undefined),
    },
  });
}

function mockRooExt(exports?: unknown) {
  mockGetExtension.mockReturnValue({
    isActive: true,
    exports: exports ?? {
      startNewTask: vi.fn().mockResolvedValue("ok"),
    },
  });
}

function mockZooExt(exports?: unknown) {
  mockGetExtension.mockReturnValue({
    isActive: true,
    exports: exports ?? {
      startNewTask: vi.fn().mockResolvedValue("ok"),
    },
  });
}

describe("GenericAiAssist", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("isAvailable", () => {
    it("returns false when no extensions are installed", async () => {
      mockGetExtension.mockReturnValue(undefined);
      const ai = new GenericAiAssist();
      expect(await ai.isAvailable()).toBe(false);
    });

    it("returns false when extensions are not active", async () => {
      mockGetExtension.mockReturnValue({ isActive: false, exports: {} });
      const ai = new GenericAiAssist();
      expect(await ai.isAvailable()).toBe(false);
    });

    it("returns false when extension has no startNewTask", async () => {
      mockGetExtension.mockReturnValue({
        isActive: true,
        exports: { notRight: true },
      });
      const ai = new GenericAiAssist();
      expect(await ai.isAvailable()).toBe(false);
    });

    it("returns true when Cline (claude-dev) is installed", async () => {
      mockClineExt();
      const ai = new GenericAiAssist();
      expect(await ai.isAvailable()).toBe(true);
    });

    it("returns true when Roo Code is installed", async () => {
      // Cline not found, Roo Code found
      mockGetExtension.mockImplementation((id: string) => {
        if (id === "saoudrizwan.claude-dev") return undefined;
        if (id === "RooVeterinaryInc.roo-cline")
          return {
            isActive: true,
            exports: { startNewTask: vi.fn().mockResolvedValue("ok") },
          };
        return undefined;
      });
      const ai = new GenericAiAssist();
      expect(await ai.isAvailable()).toBe(true);
    });

    it("returns true when Zoo Code is installed", async () => {
      mockGetExtension.mockImplementation((id: string) => {
        if (id === "ZooCodeOrganization.zoo-code")
          return {
            isActive: true,
            exports: { startNewTask: vi.fn().mockResolvedValue("ok") },
          };
        return undefined;
      });
      const ai = new GenericAiAssist();
      expect(await ai.isAvailable()).toBe(true);
    });

    it("caches probe result (only probes once)", async () => {
      mockClineExt();
      const ai = new GenericAiAssist();
      await ai.isAvailable();
      await ai.isAvailable();
      // getExtension called once per target (3 targets) = 3 calls total
      // It stops at Cline (first target), so only 1 call
      expect(mockGetExtension).toHaveBeenCalledTimes(1);
    });

    it("handles getExtension throwing", async () => {
      mockGetExtension.mockImplementation(() => {
        throw new Error("boom");
      });
      const ai = new GenericAiAssist();
      // Should not throw, just return false
      expect(await ai.isAvailable()).toBe(false);
    });
  });

  describe("submit", () => {
    it("throws when no AI is available", async () => {
      mockGetExtension.mockReturnValue(undefined);
      const ai = new GenericAiAssist();
      await expect(ai.submit("hello")).rejects.toThrow(
        "AI assist is not available",
      );
    });

    it("submits prompt via Cline startNewTask", async () => {
      const startNewTask = vi.fn().mockResolvedValue(undefined);
      mockClineExt({ startNewTask });
      const ai = new GenericAiAssist();
      await ai.submit("create a devcontainer");
      expect(startNewTask).toHaveBeenCalledWith("create a devcontainer");
    });

    it("submits prompt via Roo Code startNewTask with object", async () => {
      const startNewTask = vi.fn().mockResolvedValue("ok");
      mockRooExt({ startNewTask });
      // Make Cline return undefined so it falls through to Roo
      mockGetExtension.mockImplementation((id: string) => {
        if (id === "saoudrizwan.claude-dev") return undefined;
        if (id === "RooVeterinaryInc.roo-cline")
          return { isActive: true, exports: { startNewTask } };
        return undefined;
      });
      const ai = new GenericAiAssist();
      await ai.submit("hello world");
      expect(startNewTask).toHaveBeenCalledWith({ text: "hello world" });
    });

    it("appends files to the prompt when provided", async () => {
      const startNewTask = vi.fn().mockResolvedValue(undefined);
      mockClineExt({ startNewTask });
      const ai = new GenericAiAssist();
      await ai.submit("fix this", { files: ["Makefile", "Dockerfile"] });
      expect(startNewTask).toHaveBeenCalledWith(
        "fix this\n\nFiles: Makefile, Dockerfile",
      );
    });

    it("does not append files when empty", async () => {
      const startNewTask = vi.fn().mockResolvedValue(undefined);
      mockClineExt({ startNewTask });
      const ai = new GenericAiAssist();
      await ai.submit("plain prompt", { files: [] });
      expect(startNewTask).toHaveBeenCalledWith("plain prompt");
    });
  });
});
