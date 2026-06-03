#!/usr/bin/env node
/**
 * Guard: ensure package.json is in the neutral base state.
 * Build scripts temporarily merge vendor overrides; this catches
 * stale merges that weren't cleaned up.
 */
import { readFileSync } from "node:fs";

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
);

let ok = true;

if (pkg.name !== "artizo") {
  console.error(`package.json: name is "${pkg.name}", expected "artizo"`);
  ok = false;
}

if (!pkg.scripts || typeof pkg.scripts !== "object") {
  console.error("package.json: scripts missing (merged state)");
  ok = false;
}

if (!pkg.devDependencies) {
  console.error("package.json: devDependencies missing (merged state)");
  ok = false;
}

// Verify package-lock.json matches
const lockPath = new URL("../package-lock.json", import.meta.url);
let lockOk = true;
try {
  const lock = JSON.parse(readFileSync(lockPath, "utf-8"));
  if (lock.name !== "artizo") {
    console.error(
      `package-lock.json: name is "${lock.name}", expected "artizo"`,
    );
    lockOk = false;
  }
  if (lock.version !== pkg.version) {
    console.error(
      `package-lock.json: version is "${lock.version}", expected "${pkg.version}"`,
    );
    lockOk = false;
  }
  const rootPkg = lock.packages?.[""];
  if (rootPkg?.license !== undefined && rootPkg.license !== pkg.license) {
    console.error(
      `package-lock.json packages[""].license is "${rootPkg.license}", expected "${pkg.license}"`,
    );
    lockOk = false;
  }
  if (rootPkg?.name !== undefined && rootPkg.name !== "artizo") {
    console.error(
      `package-lock.json packages[""].name is "${rootPkg.name}", expected "artizo"`,
    );
    lockOk = false;
  }
  if (rootPkg?.version !== undefined && rootPkg.version !== pkg.version) {
    console.error(
      `package-lock.json packages[""].version is "${rootPkg.version}", expected "${pkg.version}"`,
    );
    lockOk = false;
  }
  if (rootPkg && !rootPkg.devDependencies) {
    console.error(
      'package-lock.json packages[""].devDependencies missing (merged state)',
    );
    lockOk = false;
  }
} catch {
  console.error("package-lock.json: missing or invalid");
  lockOk = false;
}

if (!lockOk) {
  console.error("Run: npm install");
}

ok = ok && lockOk;

if (!ok) {
  console.error(
    "Run: cp package.json.bak package.json (if backup exists) or git checkout -- package.json",
  );
  process.exit(1);
}
