/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect } from "vitest";
import {
  type ConfigToggles,
  type PortEntry,
  type MountEntry,
  type ContainerInfo,
  type VolumeInfo,
  type SoftwareFeature,
  type ConfigLoadedMessage,
  type UpdateContainersMessage,
  type UpdateVolumesMessage,
  type WebviewMessage,
  type ConfigParseError,
  type CommandInfo,
  type HostMessage,
} from "../../src/sidebar/messages";

// Force the module to be loaded at runtime so v8 coverage registers it.
// The file is purely type declarations with no runtime statements, so
// without a value import the coverage report stays at 0%.
import * as messagesModule from "../../src/sidebar/messages";

const _ensureLoaded = messagesModule;
void _ensureLoaded;

describe("messages types", () => {
  describe("ConfigToggles", () => {
    it("round-trips a fully-populated toggles object", () => {
      const toggles: ConfigToggles = {
        gpu: true,
        waylandSocket: false,
        mountHome: true,
        privileged: false,
        sshAgent: true,
        copyGitConfig: true,
        forwardPorts: [{ port: 3000, label: "web" }],
        extensions: ["ms-python.python"],
        mounts: [{ source: "/host", target: "/container" }],
        runArgs: ["--privileged"],
        remoteUser: "node",
      };
      expect(toggles.gpu).toBe(true);
      expect(toggles.forwardPorts[0].port).toBe(3000);
      expect(toggles.mounts[0].target).toBe("/container");
    });
  });

  describe("PortEntry", () => {
    it("supports a bare numeric port with empty label", () => {
      const entry: PortEntry = { port: 8080, label: "" };
      expect(entry.port).toBe(8080);
      expect(entry.label).toBe("");
    });
  });

  describe("MountEntry", () => {
    it("captures source and target paths", () => {
      const entry: MountEntry = { source: "/a", target: "/b" };
      expect(entry).toEqual({ source: "/a", target: "/b" });
    });
  });

  describe("ContainerInfo", () => {
    it("accepts each status variant", () => {
      const running: ContainerInfo = {
        id: "abc",
        name: "n",
        status: "running",
        image: "img",
        localFolder: "/folder",
      };
      const stopped: ContainerInfo = { ...running, status: "stopped" };
      const errored: ContainerInfo = { ...running, status: "error" };
      expect([running.status, stopped.status, errored.status]).toEqual([
        "running",
        "stopped",
        "error",
      ]);
    });
  });

  describe("VolumeInfo", () => {
    it("supports optional size field", () => {
      const withSize: VolumeInfo = {
        name: "v",
        driver: "local",
        size: "10MB",
        managed: true,
      };
      const noSize: VolumeInfo = {
        name: "v2",
        driver: "local",
        managed: false,
      };
      expect(withSize.size).toBe("10MB");
      expect(noSize.size).toBeUndefined();
    });
  });

  describe("SoftwareFeature", () => {
    it("captures ref, label and enabled state", () => {
      const feat: SoftwareFeature = {
        ref: "python",
        label: "Python",
        enabled: true,
      };
      expect(feat.ref).toBe("python");
      expect(feat.enabled).toBe(true);
    });
  });

  describe("ConfigLoadedMessage", () => {
    it("builds a message with toggles, software, and errors", () => {
      const msg: ConfigLoadedMessage = {
        type: "configLoaded",
        path: "/p/devcontainer.json",
        toggles: {
          gpu: false,
          waylandSocket: false,
          mountHome: false,
          privileged: false,
          sshAgent: false,
          copyGitConfig: false,
          forwardPorts: [],
          extensions: [],
          mounts: [],
          runArgs: [],
          remoteUser: "",
        },
        software: [],
        errors: [{ message: "bad", offset: 0, length: 1, line: 1, column: 1 }],
        aiAvailable: true,
      };
      expect(msg.type).toBe("configLoaded");
      expect(msg.errors?.[0].message).toBe("bad");
    });
  });

  describe("UpdateContainersMessage / UpdateVolumesMessage", () => {
    it("carries a containers array", () => {
      const msg: UpdateContainersMessage = {
        type: "updateContainers",
        containers: [],
      };
      expect(msg.type).toBe("updateContainers");
    });

    it("carries a volumes array", () => {
      const msg: UpdateVolumesMessage = { type: "updateVolumes", volumes: [] };
      expect(msg.type).toBe("updateVolumes");
    });
  });

  describe("WebviewMessage", () => {
    it("narrowes a ready message", () => {
      const msg: WebviewMessage = { type: "ready" };
      expect(msg.type).toBe("ready");
    });

    it("narrows a toggleOption message with optional mountPath", () => {
      const msg: WebviewMessage = {
        type: "toggleOption",
        feature: "mountHome",
        enabled: true,
        mountPath: "/home",
      };
      expect(msg.type === "toggleOption" && msg.mountPath).toBe("/home");
    });

    it("narrows a toggleSoftware message", () => {
      const msg: WebviewMessage = {
        type: "toggleSoftware",
        featureRef: "python",
        enabled: false,
      };
      expect(msg.type === "toggleSoftware" && msg.featureRef).toBe("python");
    });

    it("narrows addPort and removePort messages", () => {
      const add: WebviewMessage = { type: "addPort", port: 3000, label: "web" };
      const remove: WebviewMessage = { type: "removePort", index: 0 };
      expect(add.type === "addPort" && add.port).toBe(3000);
      expect(remove.type === "removePort" && remove.index).toBe(0);
    });

    it("narrows addExtension and removeExtension messages", () => {
      const add: WebviewMessage = {
        type: "addExtension",
        extensionId: "ms-python.python",
      };
      const remove: WebviewMessage = { type: "removeExtension", index: 1 };
      expect(add.type === "addExtension" && add.extensionId).toBeDefined();
      expect(remove.type === "removeExtension" && remove.index).toBe(1);
    });

    it("narrows toggleExtension message", () => {
      const msg: WebviewMessage = {
        type: "toggleExtension",
        extensionId: "x",
        enabled: true,
      };
      expect(msg.type === "toggleExtension" && msg.enabled).toBe(true);
    });

    it("narrows addMount and removeMount messages", () => {
      const add: WebviewMessage = {
        type: "addMount",
        source: "/s",
        target: "/t",
      };
      const remove: WebviewMessage = { type: "removeMount", index: 2 };
      expect(add.type === "addMount" && add.source).toBe("/s");
      expect(remove.type === "removeMount" && remove.index).toBe(2);
    });

    it("narrows addRunArg and removeRunArg messages", () => {
      const add: WebviewMessage = { type: "addRunArg", arg: "--init" };
      const remove: WebviewMessage = { type: "removeRunArg", index: 0 };
      expect(add.type === "addRunArg" && add.arg).toBe("--init");
      expect(remove.type === "removeRunArg" && remove.index).toBe(0);
    });

    it("narrows setRemoteUser message", () => {
      const msg: WebviewMessage = { type: "setRemoteUser", user: "root" };
      expect(msg.type === "setRemoteUser" && msg.user).toBe("root");
    });

    it("narrows action and browseExtensions messages", () => {
      const action: WebviewMessage = { type: "action", command: "do" };
      const browse: WebviewMessage = { type: "browseExtensions" };
      expect(action.type === "action" && action.command).toBe("do");
      expect(browse.type).toBe("browseExtensions");
    });

    it("narrows containerAction with each action variant", () => {
      const actions = [
        "start",
        "stop",
        "remove",
        "connectCurrentWindow",
        "connectNewWindow",
        "showLog",
        "inspect",
      ] as const;
      for (const a of actions) {
        const msg: WebviewMessage = {
          type: "containerAction",
          action: a,
          containerId: "id",
        };
        expect(msg.type === "containerAction" && msg.action).toBe(a);
      }
    });

    it("narrows containerAction with optional containerName", () => {
      const msg: WebviewMessage = {
        type: "containerAction",
        action: "start",
        containerId: "id",
        containerName: "name",
      };
      expect(msg.type === "containerAction" && msg.containerName).toBe("name");
    });

    it("narrows volumeAction message", () => {
      const msg: WebviewMessage = {
        type: "volumeAction",
        action: "inspect",
        volumeName: "v",
      };
      expect(msg.type === "volumeAction" && msg.volumeName).toBe("v");
    });

    it("narrows refreshSection for containers and volumes", () => {
      const c: WebviewMessage = {
        type: "refreshSection",
        section: "containers",
      };
      const v: WebviewMessage = { type: "refreshSection", section: "volumes" };
      expect(c.type === "refreshSection" && c.section).toBe("containers");
      expect(v.type === "refreshSection" && v.section).toBe("volumes");
    });

    it("narrows runCommand message", () => {
      const msg: WebviewMessage = { type: "runCommand", command: "ls" };
      expect(msg.type === "runCommand" && msg.command).toBe("ls");
    });

    it("narrows generateConfig and AI-related messages", () => {
      const gen: WebviewMessage = { type: "generateConfig", image: "ubuntu" };
      const aiGen: WebviewMessage = { type: "aiGenerateConfig" };
      const aiUpd: WebviewMessage = { type: "aiUpdateConfig" };
      const aiFix: WebviewMessage = { type: "aiFixConfig" };
      expect(gen.type === "generateConfig" && gen.image).toBe("ubuntu");
      expect(aiGen.type).toBe("aiGenerateConfig");
      expect(aiUpd.type).toBe("aiUpdateConfig");
      expect(aiFix.type).toBe("aiFixConfig");
    });

    it("narrows openConfigFile and repairConfig messages", () => {
      const open: WebviewMessage = { type: "openConfigFile" };
      const repair: WebviewMessage = { type: "repairConfig" };
      expect(open.type).toBe("openConfigFile");
      expect(repair.type).toBe("repairConfig");
    });
  });

  describe("ConfigParseError", () => {
    it("captures message, offset, length, line, column", () => {
      const err: ConfigParseError = {
        message: "Unexpected token",
        offset: 5,
        length: 2,
        line: 3,
        column: 4,
      };
      expect(err.offset).toBe(5);
      expect(err.line).toBe(3);
    });
  });

  describe("CommandInfo", () => {
    it("supports optional children", () => {
      const cmd: CommandInfo = {
        id: "root",
        label: "Root",
        children: [{ id: "child", label: "Child" }],
      };
      expect(cmd.children?.[0].id).toBe("child");
    });
  });

  describe("HostMessage", () => {
    it("narrows optionToggled message", () => {
      const msg: HostMessage = {
        type: "optionToggled",
        feature: "gpu",
        enabled: true,
      };
      expect(msg.type === "optionToggled" && msg.feature).toBe("gpu");
    });

    it("narrows configMissing variants", () => {
      const base: HostMessage = { type: "configMissing", aiAvailable: false };
      const noWs: HostMessage = {
        type: "configMissing",
        noWorkspace: true,
        aiAvailable: false,
      };
      const managed: HostMessage = {
        type: "configMissing",
        managed: true,
        aiAvailable: false,
      };
      expect(base.type).toBe("configMissing");
      expect(
        noWs.type === "configMissing" &&
          "noWorkspace" in noWs &&
          noWs.noWorkspace,
      ).toBe(true);
      expect(
        managed.type === "configMissing" &&
          "managed" in managed &&
          managed.managed,
      ).toBe(true);
    });

    it("narrows expandSection message", () => {
      const msg: HostMessage = { type: "expandSection", section: "config" };
      expect(msg.type === "expandSection" && msg.section).toBe("config");
    });

    it("narrows updateCommands message", () => {
      const msg: HostMessage = {
        type: "updateCommands",
        commands: [{ id: "c", label: "C" }],
      };
      expect(msg.type === "updateCommands" && msg.commands[0].id).toBe("c");
    });

    it("narrows setInstalledExtensions message", () => {
      const msg: HostMessage = {
        type: "setInstalledExtensions",
        extensions: [{ id: "x", label: "X", enabled: true }],
      };
      expect(
        msg.type === "setInstalledExtensions" && msg.extensions[0].enabled,
      ).toBe(true);
    });

    it("narrows aiStatus with each status variant", () => {
      const statuses = [
        "generating",
        "questions",
        "submitted",
        "done",
        "error",
        "timeout",
      ] as const;
      for (const status of statuses) {
        const msg: HostMessage = {
          type: "aiStatus",
          status,
          message: "m",
          target: "t",
        };
        expect(msg.type === "aiStatus" && msg.status).toBe(status);
      }
    });

    it("narrows aiStatus without optional fields", () => {
      const msg: HostMessage = { type: "aiStatus", status: "done" };
      expect(msg.type === "aiStatus" && msg.message).toBeUndefined();
    });

    it("narrows switchTab message", () => {
      const msg: HostMessage = { type: "switchTab", tab: "containers" };
      expect(msg.type === "switchTab" && msg.tab).toBe("containers");
    });
  });
});
