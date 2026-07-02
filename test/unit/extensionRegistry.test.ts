/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect } from "vitest";
import {
  stableExtensionUuid,
  buildExtensionEntry,
  extensionFolderName,
  isExtensionInEntries,
} from "../../src/extensions/extensionRegistry";

describe("extensionRegistry", () => {
  describe("stableExtensionUuid", () => {
    it("returns a valid UUID format", () => {
      const uuid = stableExtensionUuid("ms-vscode.hexeditor");
      expect(uuid).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it("is deterministic: same id produces same uuid", () => {
      const a = stableExtensionUuid("pub.ext");
      const b = stableExtensionUuid("pub.ext");
      expect(a).toBe(b);
    });

    it("differs for different ids", () => {
      const a = stableExtensionUuid("pub.ext-a");
      const b = stableExtensionUuid("pub.ext-b");
      expect(a).not.toBe(b);
    });
  });

  describe("extensionFolderName", () => {
    it("produces <id>-<version> when targetPlatform is undefined", () => {
      expect(extensionFolderName("pub.ext", "1.0.0")).toBe("pub.ext-1.0.0");
    });

    it("produces <id>-<version>-<platform> when targetPlatform is set", () => {
      expect(
        extensionFolderName("ms-vscode.hexeditor", "1.11.1", "universal"),
      ).toBe("ms-vscode.hexeditor-1.11.1-universal");
      expect(extensionFolderName("pub.ext", "1.0.0", "linux-x64")).toBe(
        "pub.ext-1.0.0-linux-x64",
      );
    });

    it("treats only 'undefined' as no suffix", () => {
      expect(
        extensionFolderName("pub.ext", "1.0.0", "undefined" as string),
      ).toBe("pub.ext-1.0.0");
      expect(extensionFolderName("pub.ext", "1.0.0", "unknown" as string)).toBe(
        "pub.ext-1.0.0-unknown",
      );
      expect(
        extensionFolderName("pub.ext", "1.0.0", "universal" as string),
      ).toBe("pub.ext-1.0.0-universal");
    });
  });

  describe("buildExtensionEntry", () => {
    it("builds an entry with the expected shape", () => {
      const entry = buildExtensionEntry({
        extId: "ms-vscode.hexeditor",
        version: "1.11.1",
        folderPath: "/tmp/.kiro-server/extensions/ms-vscode.hexeditor-1.11.1",
        publisherDisplayName: "ms-vscode",
      });

      expect(entry.identifier.id).toBe("ms-vscode.hexeditor");
      expect(entry.version).toBe("1.11.1");
      expect(entry.location.scheme).toBe("file");
      expect(entry.location.$mid).toBe(1);
      expect(entry.location.path).toBe(
        "/tmp/.kiro-server/extensions/ms-vscode.hexeditor-1.11.1",
      );
      expect(entry.relativeLocation).toBe("ms-vscode.hexeditor-1.11.1");
      expect(entry.metadata.source).toBe("vsix");
      expect(entry.metadata.pinned).toBe(false);
      expect(entry.metadata.isPreReleaseVersion).toBe(false);
      expect(entry.metadata.hasPreReleaseVersion).toBe(false);
      expect(entry.metadata.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it("uses a stable uuid derived from the extension id", () => {
      const entry = buildExtensionEntry({
        extId: "pub.ext",
        version: "1.0.0",
        folderPath: "/path",
        publisherDisplayName: "pub",
      });
      // metadata.id from the full extension id
      expect(entry.metadata.id).toBe(stableExtensionUuid("pub.ext"));
      // publisherId from the namespace only
      expect(entry.metadata.publisherId).toBe(stableExtensionUuid("pub"));
    });

    it("includes targetPlatform in folder name and metadata when set", () => {
      const entry = buildExtensionEntry({
        extId: "ms-vscode.hexeditor",
        version: "1.11.1",
        folderPath: "/ext/ms-vscode.hexeditor-1.11.1-universal",
        publisherDisplayName: "ms-vscode",
        targetPlatform: "universal",
      });
      expect(entry.relativeLocation).toBe(
        "ms-vscode.hexeditor-1.11.1-universal",
      );
      expect(entry.metadata.targetPlatform).toBe("universal");
    });

    it("omits targetPlatform from metadata when undefined", () => {
      const entry = buildExtensionEntry({
        extId: "pub.ext",
        version: "1.0.0",
        folderPath: "/path",
        publisherDisplayName: "pub",
      });
      expect(entry.relativeLocation).toBe("pub.ext-1.0.0");
      expect(entry.metadata.targetPlatform).toBeUndefined();
    });
  });

  describe("isExtensionInEntries", () => {
    it("returns true when id matches", () => {
      const entries = [
        { identifier: { id: "pub.ext" }, relativeLocation: "pub.ext-1.0.0" },
      ];
      expect(isExtensionInEntries(entries, "pub.ext", "pub.ext-1.0.0")).toBe(
        true,
      );
    });

    it("returns true when relativeLocation matches", () => {
      const entries = [
        {
          identifier: { id: "other.ext" },
          relativeLocation: "pub.ext-1.0.0",
        },
      ];
      expect(isExtensionInEntries(entries, "pub.ext", "pub.ext-1.0.0")).toBe(
        true,
      );
    });

    it("returns false when neither matches", () => {
      const entries = [
        {
          identifier: { id: "other.ext" },
          relativeLocation: "other.ext-1.0.0",
        },
      ];
      expect(isExtensionInEntries(entries, "pub.ext", "pub.ext-1.0.0")).toBe(
        false,
      );
    });

    it("returns false for empty entries", () => {
      expect(isExtensionInEntries([], "pub.ext", "pub.ext-1.0.0")).toBe(false);
    });

    it("handles malformed entries gracefully", () => {
      const entries = [null, undefined, "string", 42, {}];
      expect(isExtensionInEntries(entries, "pub.ext", "pub.ext-1.0.0")).toBe(
        false,
      );
    });
  });
});
