#!/usr/bin/env node
/**
 * Verify vendor README templates resolve against README.md sections.
 *
 * README.md has sections delimited by:
 *   <!-- BEGIN:name --> ... <!-- END:name -->
 *
 * Template files (vendor/README.template.md, vendor/vscodium/README.md)
 * reference these via {{section:name}} placeholders. Expansion happens
 * at package time in build-vsix.mjs. This script just checks every
 * placeholder resolves to a section in README.md. Does not write.
 *
 * Run via: make docs
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const root = import.meta.dirname
  ? path.resolve(import.meta.dirname, "..")
  : path.resolve("..");

const readme = readFileSync(path.join(root, "README.md"), "utf-8");
const sections = {};
const re = /<!-- BEGIN:(\S+) -->\r?\n([\s\S]*?)<!-- END:\1 -->/g;
let m;
while ((m = re.exec(readme)) !== null) {
  sections[m[1]] = m[2].replace(/\n$/, "");
}

const templates = [
  path.join(root, "vendor", "kiro", "README.md"),
  path.join(root, "vendor", "vscodium", "README.md"),
];

let missing = 0;
for (const tplPath of templates) {
  const tpl = readFileSync(tplPath, "utf-8");
  for (const match of tpl.matchAll(/\{\{section:(\S+)\}\}/g)) {
    const name = match[1];
    if (sections[name] === undefined) {
      console.error(
        `  MISSING section "${name}" in README.md (referenced by ${path.relative(root, tplPath)})`,
      );
      missing++;
    }
  }
}

if (missing > 0) {
  console.error(`  ${missing} missing section(s)`);
  process.exit(1);
}

console.log("  all section placeholders resolve");