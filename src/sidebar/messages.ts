/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Message protocol between extension host and sidebar webview.
 *
 * Extension → Webview messages push state updates.
 * Webview → Extension messages request actions or state changes.
 */

// Data types
export interface ConfigToggles {
  gpu: boolean;
  waylandSocket: boolean;
  mountHome: boolean;
  privileged: boolean;
  sshAgent: boolean;
  copyGitConfig: boolean;
  forwardPorts: PortEntry[];
  extensions: string[];
  mounts: MountEntry[];
  runArgs: string[];
  remoteUser: string;
}

export interface PortEntry {
  port: number;
  label: string;
}

export interface MountEntry {
  source: string;
  target: string;
}

export interface ContainerInfo {
  id: string;
  name: string;
  status: "running" | "stopped" | "error";
  image: string;
  localFolder: string;
}

export interface VolumeInfo {
  name: string;
  driver: string;
  size?: string;
  managed: boolean;
}

export interface SoftwareFeature {
  ref: string;
  label: string;
  enabled: boolean;
}

// Extension → Webview
export interface ConfigLoadedMessage {
  type: "configLoaded";
  path: string;
  toggles: ConfigToggles;
  software: SoftwareFeature[];
  errors?: ConfigParseError[];
  aiAvailable: boolean;
}

export interface UpdateContainersMessage {
  type: "updateContainers";
  containers: ContainerInfo[];
}

export interface UpdateVolumesMessage {
  type: "updateVolumes";
  volumes: VolumeInfo[];
}

// Webview → Extension
export type WebviewMessage =
  | { type: "ready" }
  | {
      type: "toggleOption";
      feature: string;
      enabled: boolean;
      mountPath?: string;
    }
  | { type: "toggleSoftware"; featureRef: string; enabled: boolean }
  | { type: "addPort"; port: number; label: string }
  | { type: "removePort"; index: number }
  | { type: "addExtension"; extensionId: string }
  | { type: "removeExtension"; index: number }
  | {
      type: "toggleExtension";
      extensionId: string;
      enabled: boolean;
    }
  | { type: "addMount"; source: string; target: string }
  | { type: "removeMount"; index: number }
  | { type: "addRunArg"; arg: string }
  | { type: "removeRunArg"; index: number }
  | { type: "setRemoteUser"; user: string }
  | { type: "action"; command: string }
  | { type: "browseExtensions" }
  | {
      type: "containerAction";
      action:
        | "start"
        | "stop"
        | "remove"
        | "connectCurrentWindow"
        | "connectNewWindow"
        | "showLog"
        | "inspect";
      containerId: string;
      containerName?: string;
    }
  | { type: "volumeAction"; action: "inspect" | "remove"; volumeName: string }
  | { type: "refreshSection"; section: "containers" | "volumes" }
  | { type: "runCommand"; command: string }
  | { type: "generateConfig"; image: string }
  | { type: "aiGenerateConfig" }
  | { type: "aiUpdateConfig" }
  | { type: "aiFixConfig" }
  | { type: "openConfigFile" }
  | { type: "repairConfig" };

export interface ConfigParseError {
  message: string;
  offset: number;
  length: number;
  line: number;
  column: number;
}

export interface CommandInfo {
  id: string;
  label: string;
  children?: { id: string; label: string }[];
}

// Extension → Webview
export type HostMessage =
  | ConfigLoadedMessage
  | { type: "optionToggled"; feature: string; enabled: boolean }
  | { type: "configMissing"; aiAvailable?: boolean }
  | { type: "configMissing"; noWorkspace: true; aiAvailable?: boolean }
  | { type: "configMissing"; managed: true; aiAvailable?: boolean }
  | UpdateContainersMessage
  | UpdateVolumesMessage
  | { type: "expandSection"; section: string }
  | { type: "updateCommands"; commands: CommandInfo[] }
  | {
      type: "setInstalledExtensions";
      extensions: { id: string; label: string; enabled: boolean }[];
    }
  | {
      type: "aiStatus";
      status:
        | "generating"
        | "questions"
        | "submitted"
        | "done"
        | "error"
        | "timeout";
      message?: string;
      target?: string;
    }
  | { type: "switchTab"; tab: string };
