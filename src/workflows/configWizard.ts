/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Configuration Wizard workflow.
 *
 * Fetches templates from the devcontainers template registry, presents
 * template list and feature selection, then generates devcontainer.json.
 */

import type { WorkflowDependencies, WorkflowUI } from "./types";
import {
  templates as fetchTemplates,
  features as fetchFeatures,
} from "../devcontainer/templates";

/**
 * A dev container template from the registry.
 */
export interface DevContainerTemplate {
  id: string;
  name: string;
  description: string;
  categories?: string[];
}

/**
 * A dev container feature from the registry.
 */
export interface DevContainerFeature {
  id: string;
  name: string;
  description: string;
  version?: string;
}

/**
 * Extended UI interface for the config wizard workflow.
 */
export interface ConfigWizardUI extends WorkflowUI {
  pickTemplate(
    templates: DevContainerTemplate[],
  ): Promise<DevContainerTemplate | undefined>;
  pickCustomImage(): Promise<string | undefined>;
  pickFeatures(features: DevContainerFeature[]): Promise<DevContainerFeature[]>;
  confirmAfterCreate(): Promise<"reopen" | "edit" | "done">;
}

/**
 * Parameters for the config wizard workflow.
 */
export interface ConfigWizardParams {
  workspaceFolder: string;
}

/**
 * Result of the config wizard.
 */
export interface ConfigWizardResult {
  templateId: string;
  features: string[];
  configPath: string;
  action: "reopen" | "edit" | "done";
}

/** Parse template list output from the CLI. */
export function parseTemplateList(stdout: string): DevContainerTemplate[] {
  try {
    const parsed = JSON.parse(stdout);
    if (Array.isArray(parsed)) {
      return parsed.map((t: any) => ({
        id: t.id ?? "",
        name: t.name ?? t.id ?? "",
        description: t.description ?? "",
        categories: t.categories ?? [],
      }));
    }
    // Some CLI versions wrap in an object
    if (parsed.templates && Array.isArray(parsed.templates)) {
      return parsed.templates.map((t: any) => ({
        id: t.id ?? "",
        name: t.name ?? t.id ?? "",
        description: t.description ?? "",
        categories: t.categories ?? [],
      }));
    }
    return [];
  } catch {
    return [];
  }
}

export function parseFeatureList(stdout: string): DevContainerFeature[] {
  try {
    const parsed = JSON.parse(stdout);
    if (Array.isArray(parsed)) {
      return parsed.map((f: any) => ({
        id: f.id ?? "",
        name: f.name ?? f.id ?? "",
        description: f.description ?? "",
        version: f.version,
      }));
    }
    if (parsed.features && Array.isArray(parsed.features)) {
      return parsed.features.map((f: any) => ({
        id: f.id ?? "",
        name: f.name ?? f.id ?? "",
        description: f.description ?? "",
        version: f.version,
      }));
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Template selection, feature selection, config generation, and validation.
 * Offers to reopen in container when done.
 */
export async function configWizard(
  deps: WorkflowDependencies,
  ui: ConfigWizardUI,
  params: ConfigWizardParams,
): Promise<ConfigWizardResult | undefined> {
  const { configManager } = deps;
  const { workspaceFolder } = params;

  try {
    const templates = getDefaultTemplates();

    const selectedTemplate = await ui.pickTemplate(templates);
    if (!selectedTemplate) {
      return undefined;
    }
    if (selectedTemplate.id === "__custom__") {
      const image = await ui.pickCustomImage();
      if (!image) {
        return undefined;
      }
    }

    let features: DevContainerFeature[] = [];

    await ui.showProgress(
      "Dev Containers: Loading Features",
      async (progress) => {
        progress.report({ message: "Fetching available features..." });

        const result = await fetchFeatures({ list: true });
        features = parseFeatureList(result.stdout);
      },
    );

    const selectedFeatures = await ui.pickFeatures(features);
    const featureIds = selectedFeatures.map((f) => f.id);

    await ui.showProgress(
      "Dev Containers: Generating Configuration",
      async (progress) => {
        progress.report({ message: "Generating devcontainer.json..." });

        const result = await fetchTemplates({
          templateId: selectedTemplate.id,
          outputFolder: workspaceFolder,
          features: featureIds,
        });

        if (result.exitCode !== 0) {
          throw new Error(`Failed to generate configuration: ${result.stderr}`);
        }
      },
    );

    const configResult = configManager.readConfig(workspaceFolder);
    if (configResult.config) {
      const validation = configManager.validateConfig(configResult.config);
      if (!validation.valid) {
        const warnings = validation.errors.map((e) => e.message).join(", ");
        await ui.showInfo(`Configuration generated with warnings: ${warnings}`);
      }
    }

    const configPath =
      configResult.configPath ??
      `${workspaceFolder}/.devcontainer/devcontainer.json`;

    const action = await ui.confirmAfterCreate();

    return {
      templateId: selectedTemplate.id,
      features: featureIds,
      configPath,
      action,
    };
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));

    await ui.showError(
      `Configuration wizard failed: ${error.message}`,
      "Retry",
      "Cancel",
    );

    throw error;
  }
}

function getDefaultTemplates(): DevContainerTemplate[] {
  // Inline defaults so the wizard works without network
  return [
    {
      id: "ghcr.io/devcontainers/templates/typescript-node:1",
      name: "Node.js & TypeScript",
      description: "Node.js and TypeScript development container",
      categories: ["Languages"],
    },
    {
      id: "ghcr.io/devcontainers/templates/python:1",
      name: "Python 3",
      description: "Python development container",
      categories: ["Languages"],
    },
    {
      id: "ghcr.io/devcontainers/templates/rust:1",
      name: "Rust",
      description: "Rust development container",
      categories: ["Languages"],
    },
    {
      id: "ghcr.io/devcontainers/templates/go:1",
      name: "Go",
      description: "Go development container",
      categories: ["Languages"],
    },
    {
      id: "ghcr.io/devcontainers/templates/java:1",
      name: "Java",
      description: "Java development container",
      categories: ["Languages"],
    },
    {
      id: "ghcr.io/devcontainers/templates/dotnet:1",
      name: ".NET",
      description: ".NET development container",
      categories: ["Languages"],
    },
    {
      id: "ghcr.io/devcontainers/templates/ubuntu:1",
      name: "Ubuntu",
      description: "Ubuntu base development container",
      categories: ["Base"],
    },
    {
      id: "ghcr.io/devcontainers/templates/alpine:1",
      name: "Alpine Linux",
      description: "Alpine Linux base development container",
      categories: ["Base"],
    },
  ];
}

/** Validate a Docker image reference.
 * Accepts: alpine, ubuntu:22.04, registry:5000/name:tag, org/image@sha256:...
 * Rejects: empty, whitespace, backslashes, invalid characters in name/tag. */
export function isValidImageRef(ref: string): string | null {
  if (!ref || ref.trim() !== ref) {
    return "Image reference must not be empty or have leading/trailing whitespace.";
  }
  if (/\s/.test(ref)) {
    return "Image reference must not contain whitespace.";
  }
  if (/\\/.test(ref)) {
    return "Image reference must not contain backslashes.";
  }

  // Practical regex covering registry, path, tag, and digest.
  // Registry: [host][:port]/  (optional)
  // Path:     name[/name]*
  // Tag:      :tag (optional)
  // Digest:   @sha256:64hex (optional)
  const imageRefRe =
    /^(?:(?:[a-zA-Z0-9.-]+(?::[0-9]+)?)\/)?(?:[a-z0-9._-]+(?:\/[a-z0-9._-]+)*)(?::[a-zA-Z0-9_.-]{1,128})?(?:@sha256:[a-f0-9]{64})?$/;

  if (!imageRefRe.test(ref)) {
    return "Invalid image reference format. Expected: [registry/]name[:tag] or ...@sha256:...";
  }

  return null;
}