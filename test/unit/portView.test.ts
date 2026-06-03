/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock vscode module
vi.mock("vscode", () => {
  const EventEmitter = vi.fn().mockImplementation(() => ({
    event: vi.fn(),
    fire: vi.fn(),
    dispose: vi.fn(),
  }));

  return {
    TreeItem: class {
      label: string;
      collapsibleState: number;
      description?: string;
      tooltip?: string;
      contextValue?: string;
      iconPath?: unknown;
      constructor(label: string, collapsibleState: number) {
        this.label = label;
        this.collapsibleState = collapsibleState;
      }
    },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ThemeIcon: class {
      id: string;
      constructor(id: string) {
        this.id = id;
      }
    },
    EventEmitter,
    window: {
      createTreeView: vi.fn().mockReturnValue({ dispose: vi.fn() }),
      showInputBox: vi.fn(),
    },
    commands: {
      registerCommand: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    },
  };
});

import * as vscode from "vscode";
import { PortViewProvider, PortTreeItem } from "../../src/ports/portView";
import type { ForwardedPort } from "../../src/ports/portForwarder";
import type { IPortForwarderView } from "../../src/ports/portView";

function createMockForwarder(ports: ForwardedPort[] = []): IPortForwarderView {
  return {
    forwardPort: vi.fn().mockResolvedValue(undefined),
    unforwardPort: vi.fn().mockResolvedValue(undefined),
    getForwardedPorts: vi.fn().mockReturnValue(ports),
    onDidForwardPort: vi.fn(),
    onDidUnforwardPort: vi.fn(),
  };
}

function createPort(overrides: Partial<ForwardedPort> = {}): ForwardedPort {
  return {
    containerPort: 3000,
    localPort: 3000,
    protocol: "tcp",
    source: "user",
    ...overrides,
  };
}

describe("PortTreeItem", () => {
  it("displays port mapping without label", () => {
    const port = createPort({ containerPort: 8080, localPort: 8080 });
    const item = new PortTreeItem(port);

    expect(item.label).toBe("8080→8080");
    expect(item.description).toBe("tcp · user");
    expect(item.contextValue).toBe("forwardedPort");
  });

  it("displays label with port mapping when label is set", () => {
    const port = createPort({
      containerPort: 3000,
      localPort: 3001,
      label: "Web Server",
    });
    const item = new PortTreeItem(port);

    expect(item.label).toBe("Web Server (3000→3001)");
  });

  it("shows protocol and source in description", () => {
    const port = createPort({ protocol: "tcp", source: "config" });
    const item = new PortTreeItem(port);

    expect(item.description).toBe("tcp · config");
  });

  it("shows auto-detected source in description", () => {
    const port = createPort({ source: "auto-detected" });
    const item = new PortTreeItem(port);

    expect(item.description).toBe("tcp · auto-detected");
  });

  it("builds tooltip with all port details", () => {
    const port = createPort({
      containerPort: 5432,
      localPort: 5433,
      protocol: "tcp",
      source: "config",
      label: "PostgreSQL",
    });
    const item = new PortTreeItem(port);

    expect(item.tooltip).toContain("Container Port: 5432");
    expect(item.tooltip).toContain("Local Port: 5433");
    expect(item.tooltip).toContain("Protocol: tcp");
    expect(item.tooltip).toContain("Source: config");
    expect(item.tooltip).toContain("Label: PostgreSQL");
  });

  it("builds tooltip without label line when no label", () => {
    const port = createPort({ containerPort: 80, localPort: 80 });
    const item = new PortTreeItem(port);

    expect(item.tooltip).not.toContain("Label:");
    expect(item.tooltip).toContain("Container Port: 80");
  });

  it("uses plug icon", () => {
    const port = createPort();
    const item = new PortTreeItem(port);

    expect(item.iconPath).toBeInstanceOf(vscode.ThemeIcon);
    expect((item.iconPath as vscode.ThemeIcon).id).toBe("plug");
  });

  it("has no collapsible state (flat list)", () => {
    const port = createPort();
    const item = new PortTreeItem(port);

    expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.None);
  });
});

describe("PortViewProvider", () => {
  let forwarder: IPortForwarderView;
  let provider: PortViewProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    forwarder = createMockForwarder();
    provider = new PortViewProvider(forwarder);
  });

  describe("constructor", () => {
    it("subscribes to onDidForwardPort event", () => {
      expect(forwarder.onDidForwardPort).toHaveBeenCalledWith(
        expect.any(Function),
      );
    });

    it("subscribes to onDidUnforwardPort event", () => {
      expect(forwarder.onDidUnforwardPort).toHaveBeenCalledWith(
        expect.any(Function),
      );
    });
  });

  describe("getChildren", () => {
    it("returns all forwarded ports when no element is provided", () => {
      const ports = [
        createPort({ containerPort: 3000 }),
        createPort({ containerPort: 8080 }),
      ];
      forwarder = createMockForwarder(ports);
      provider = new PortViewProvider(forwarder);

      const children = provider.getChildren();

      expect(children).toEqual(ports);
    });

    it("returns empty array when element is provided (flat list)", () => {
      const port = createPort();
      const children = provider.getChildren(port);

      expect(children).toEqual([]);
    });

    it("returns empty array when no ports are forwarded", () => {
      const children = provider.getChildren();

      expect(children).toEqual([]);
    });
  });

  describe("getTreeItem", () => {
    it("returns a PortTreeItem for a forwarded port", () => {
      const port = createPort({
        containerPort: 4000,
        localPort: 4001,
        label: "API",
      });
      const item = provider.getTreeItem(port);

      expect(item).toBeInstanceOf(PortTreeItem);
      expect(item.label).toBe("API (4000→4001)");
    });
  });

  describe("refresh", () => {
    it("fires onDidChangeTreeData event", () => {
      // Access the internal emitter mock
      const emitter = (provider as any)._onDidChangeTreeData;
      provider.refresh();

      expect(emitter.fire).toHaveBeenCalled();
    });
  });

  describe("addPort", () => {
    it("prompts user for port number and forwards it", async () => {
      vi.mocked(vscode.window.showInputBox).mockResolvedValue("3000");

      await provider.addPort();

      expect(vscode.window.showInputBox).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: "Enter the container port to forward",
        }),
      );
      expect(forwarder.forwardPort).toHaveBeenCalledWith(3000);
    });

    it("does nothing when user cancels input", async () => {
      vi.mocked(vscode.window.showInputBox).mockResolvedValue(undefined);

      await provider.addPort();

      expect(forwarder.forwardPort).not.toHaveBeenCalled();
    });

    it("validates port number input", async () => {
      vi.mocked(vscode.window.showInputBox).mockResolvedValue("8080");

      await provider.addPort();

      const inputBoxCall = vi.mocked(vscode.window.showInputBox).mock
        .calls[0][0]!;
      const validateInput = inputBoxCall.validateInput!;

      expect(validateInput("0")).toBe("Enter a valid port number (1-65535)");
      expect(validateInput("65536")).toBe(
        "Enter a valid port number (1-65535)",
      );
      expect(validateInput("abc")).toBe("Enter a valid port number (1-65535)");
      expect(validateInput("")).toBe("Enter a valid port number (1-65535)");
      expect(validateInput("1")).toBeUndefined();
      expect(validateInput("65535")).toBeUndefined();
      expect(validateInput("3000")).toBeUndefined();
    });
  });

  describe("removePort", () => {
    it("unforwards the specified port", async () => {
      const port = createPort({ containerPort: 5000 });

      await provider.removePort(port);

      expect(forwarder.unforwardPort).toHaveBeenCalledWith(5000);
    });
  });

  describe("setLabel", () => {
    it("prompts user for label and updates port", async () => {
      vi.mocked(vscode.window.showInputBox).mockResolvedValue("My Service");
      const port = createPort({ containerPort: 3000 });

      await provider.setLabel(port);

      expect(vscode.window.showInputBox).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: "Enter a label for this port",
          value: "",
        }),
      );
      expect(port.label).toBe("My Service");
    });

    it("shows existing label as default value", async () => {
      vi.mocked(vscode.window.showInputBox).mockResolvedValue("Updated");
      const port = createPort({ label: "Old Label" });

      await provider.setLabel(port);

      expect(vscode.window.showInputBox).toHaveBeenCalledWith(
        expect.objectContaining({
          value: "Old Label",
        }),
      );
      expect(port.label).toBe("Updated");
    });

    it("clears label when empty string is entered", async () => {
      vi.mocked(vscode.window.showInputBox).mockResolvedValue("");
      const port = createPort({ label: "Existing" });

      await provider.setLabel(port);

      expect(port.label).toBeUndefined();
    });

    it("does nothing when user cancels", async () => {
      vi.mocked(vscode.window.showInputBox).mockResolvedValue(undefined);
      const port = createPort({ label: "Keep This" });

      await provider.setLabel(port);

      expect(port.label).toBe("Keep This");
    });
  });

  describe("register", () => {
    it("creates a tree view with the correct id", () => {
      const context = {
        subscriptions: [] as vscode.Disposable[],
      } as unknown as vscode.ExtensionContext;

      PortViewProvider.register(context, forwarder);

      expect(vscode.window.createTreeView).toHaveBeenCalledWith(
        "artizo.portsView",
        {
          treeDataProvider: expect.any(PortViewProvider),
          showCollapseAll: false,
        },
      );
    });

    it("registers add, remove, and setLabel commands", () => {
      const context = {
        subscriptions: [] as vscode.Disposable[],
      } as unknown as vscode.ExtensionContext;

      PortViewProvider.register(context, forwarder);

      const registeredCommands = vi
        .mocked(vscode.commands.registerCommand)
        .mock.calls.map((call) => call[0]);
      expect(registeredCommands).toContain("artizo.ports.add");
      expect(registeredCommands).toContain("artizo.ports.remove");
      expect(registeredCommands).toContain("artizo.ports.setLabel");
    });

    it("pushes disposables to context subscriptions", () => {
      const context = {
        subscriptions: [] as vscode.Disposable[],
      } as unknown as vscode.ExtensionContext;

      PortViewProvider.register(context, forwarder);

      expect(context.subscriptions.length).toBeGreaterThanOrEqual(4);
    });
  });

  describe("auto-refresh on forwarder events", () => {
    it("refreshes when a port is forwarded", () => {
      // Get the callback that was registered for onDidForwardPort
      const forwardCallback = vi.mocked(forwarder.onDidForwardPort).mock
        .calls[0][0];
      const emitter = (provider as any)._onDidChangeTreeData;

      forwardCallback(createPort());

      expect(emitter.fire).toHaveBeenCalled();
    });

    it("refreshes when a port is unforwarded", () => {
      // Get the callback that was registered for onDidUnforwardPort
      const unforwardCallback = vi.mocked(forwarder.onDidUnforwardPort).mock
        .calls[0][0];
      const emitter = (provider as any)._onDidChangeTreeData;

      unforwardCallback(3000);

      expect(emitter.fire).toHaveBeenCalled();
    });
  });
});