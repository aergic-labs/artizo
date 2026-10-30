/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// Guards two one-line split fixes in the vendored devcontainers CLI that make
// wslc accept ';' in devcontainer.json mounts (the canonical format). Re-vendoring
// overwrites them. If this test fails:
//   - extraction error (function/const not found): a symbol was renamed or
//     removed. Update the names below.
//   - assertion error: the `split(/[,;]/)` was dropped on re-vendor. Re-apply it to:
//       convertMountToVolume in spec-node/singleContainer.ts
//       parseMount in spec-configuration/containerFeaturesConfiguration.ts

import { describe, it, expect } from "vitest";
import * as ts from "typescript";
import * as fs from "node:fs";
import * as path from "node:path";

const vendorRoot = path.join(
  process.cwd(),
  "vendor/devcontainers-cli/src",
);

function extractNodeText(
  filePath: string,
  kind: "function" | "const",
  name: string,
): string {
  const src = fs.readFileSync(filePath, "utf8");
  const sf = ts.createSourceFile(filePath, src, ts.ScriptTarget.Latest, true);
  for (const stmt of sf.statements) {
    if (
      kind === "function" &&
      ts.isFunctionDeclaration(stmt) &&
      stmt.name?.text === name
    ) {
      return src.slice(stmt.getStart(sf), stmt.getEnd());
    }
    if (kind === "const" && ts.isVariableStatement(stmt)) {
      const decl = stmt.declarationList.declarations[0];
      if (decl && ts.isIdentifier(decl.name) && decl.name.text === name) {
        return src.slice(stmt.getStart(sf), stmt.getEnd());
      }
    }
  }
  throw new Error(`${kind} ${name} not found in ${filePath}`);
}

function toJs(text: string): string {
  return ts.transpileModule(text, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
  }).outputText;
}

function loadParseMount(): (s: string) => Record<string, string> {
  const file = path.join(
    vendorRoot,
    "spec-configuration/containerFeaturesConfiguration.ts",
  );
  const dep = extractNodeText(file, "const", "normalizedMountKeys");
  const fn = extractNodeText(file, "function", "parseMount").replace(
    /^\s*export\s+/m,
    "",
  );
  return (new Function(toJs(`${dep}\n${fn}\nreturn parseMount;`)) as any)();
}

function loadConvertMountToVolume(): (s: string) => string[] {
  const file = path.join(vendorRoot, "spec-node/singleContainer.ts");
  const fn = extractNodeText(file, "function", "convertMountToVolume");
  return (new Function(toJs(`${fn}\nreturn convertMountToVolume;`)) as any)();
}

describe("wslc mount split fix (vendored CLI)", () => {
  it("parseMount splits on ';'", () => {
    const parseMount = loadParseMount();
    expect(parseMount("source=myvol;target=/data;type=volume")).toEqual({
      source: "myvol",
      target: "/data",
      type: "volume",
    });
  });

  it("parseMount still splits on ','", () => {
    const parseMount = loadParseMount();
    expect(parseMount("type=volume,source=myvol,target=/data")).toEqual({
      type: "volume",
      source: "myvol",
      target: "/data",
    });
  });

  it("convertMountToVolume emits -v for ';' mount", () => {
    const convertMountToVolume = loadConvertMountToVolume();
    expect(
      convertMountToVolume("source=myvol;target=/data;type=volume"),
    ).toEqual(["-v", "myvol:/data"]);
  });

  it("convertMountToVolume emits -v for ',' mount", () => {
    const convertMountToVolume = loadConvertMountToVolume();
    expect(
      convertMountToVolume("type=bind,source=/host,target=/data"),
    ).toEqual(["-v", "/host:/data"]);
  });

  it("convertMountToVolume handles anonymous volume (target only)", () => {
    const convertMountToVolume = loadConvertMountToVolume();
    expect(convertMountToVolume("type=volume;target=/data")).toEqual([
      "-v",
      "/data",
    ]);
  });
});