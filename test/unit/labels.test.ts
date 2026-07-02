/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect } from "vitest";
import {
  isDevContainer,
  getLocalFolder,
  getConfigFile,
  getVolumeName,
  getVolumeFolder,
  parseContainerList,
  parseLabelString,
} from "../../src/devcontainer/labels";

describe("labels", () => {
  describe("isDevContainer", () => {
    it("recognizes artizo.local_folder", () => {
      expect(isDevContainer({ "artizo.local_folder": "/proj" })).toBe(true);
    });

    it("recognizes devcontainer.local_folder", () => {
      expect(isDevContainer({ "devcontainer.local_folder": "/proj" })).toBe(
        true,
      );
    });

    it("recognizes volume labels (both namespaces)", () => {
      expect(
        isDevContainer({
          "artizo.volume_name": "v1",
          "artizo.volume_folder": "/workspace",
        }),
      ).toBe(true);
      expect(
        isDevContainer({
          "devcontainer.volume_name": "v1",
          "devcontainer.volume_folder": "/workspace",
        }),
      ).toBe(true);
    });

    it("requires both volume name and folder", () => {
      expect(isDevContainer({ "artizo.volume_name": "v1" })).toBe(false);
      expect(isDevContainer({ "artizo.volume_folder": "/w" })).toBe(false);
    });

    it("recognizes compose project", () => {
      expect(isDevContainer({ "com.docker.compose.project": "myapp" })).toBe(
        true,
      );
    });

    it("rejects unrelated labels", () => {
      expect(isDevContainer({ foo: "bar" })).toBe(false);
      expect(isDevContainer({})).toBe(false);
    });
  });

  describe("getLocalFolder", () => {
    it("prefers artizo namespace", () => {
      expect(
        getLocalFolder({
          "artizo.local_folder": "/artizo-path",
          "devcontainer.local_folder": "/spec-path",
        }),
      ).toBe("/artizo-path");
    });

    it("falls back to spec namespace", () => {
      expect(
        getLocalFolder({ "devcontainer.local_folder": "/spec-path" }),
      ).toBe("/spec-path");
    });

    it("returns undefined when absent", () => {
      expect(getLocalFolder({})).toBeUndefined();
    });
  });

  describe("getConfigFile", () => {
    it("reads artizo.config_file", () => {
      expect(
        getConfigFile({ "artizo.config_file": "/path/devcontainer.json" }),
      ).toBe("/path/devcontainer.json");
    });

    it("falls back to devcontainer.config_file", () => {
      expect(
        getConfigFile({
          "devcontainer.config_file": "/path/devcontainer.json",
        }),
      ).toBe("/path/devcontainer.json");
    });
  });

  describe("getVolumeName / getVolumeFolder", () => {
    it("reads artizo namespace", () => {
      const labels = {
        "artizo.volume_name": "vol1",
        "artizo.volume_folder": "/workspace",
      };
      expect(getVolumeName(labels)).toBe("vol1");
      expect(getVolumeFolder(labels)).toBe("/workspace");
    });

    it("falls back to devcontainer namespace", () => {
      const labels = {
        "devcontainer.volume_name": "vol2",
        "devcontainer.volume_folder": "/data",
      };
      expect(getVolumeName(labels)).toBe("vol2");
      expect(getVolumeFolder(labels)).toBe("/data");
    });
  });

  describe("parseContainerList", () => {
    it("parses multiple JSON lines", () => {
      const stdout = [
        JSON.stringify({
          ID: "abc",
          Names: "/c1",
          State: "running",
          Image: "ubuntu",
          Labels: "devcontainer.local_folder=/p",
        }),
        JSON.stringify({
          ID: "def",
          Names: "/c2",
          State: "exited",
          Image: "alpine",
          Labels: "",
        }),
      ].join("\n");
      const list = parseContainerList(stdout);
      expect(list).toHaveLength(2);
      expect(list[0]).toEqual({
        id: "abc",
        name: "c1",
        state: "running",
        image: "ubuntu",
        labels: { "devcontainer.local_folder": "/p" },
      });
      expect(list[1].name).toBe("c2");
    });

    it("handles empty stdout", () => {
      expect(parseContainerList("")).toEqual([]);
      expect(parseContainerList("  \n  ")).toEqual([]);
    });
  });

  describe("parseLabelString", () => {
    it("parses comma-separated key=value", () => {
      expect(
        parseLabelString("a=1,b=2,c=hello world"),
      ).toEqual({
        a: "1",
        b: "2",
        c: "hello world",
      });
    });

    it("parses JSON object", () => {
      expect(parseLabelString('{"a":"1","b":"2"}')).toEqual({
        a: "1",
        b: "2",
      });
    });

    it("returns empty object for empty input", () => {
      expect(parseLabelString("")).toEqual({});
    });
  });
});
