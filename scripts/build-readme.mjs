#!/usr/bin/env node
/**
 * Build vendor README templates from the main README.
 *
 * The main README.md contains sections delimited by HTML comments:
 *   <!-- BEGIN:name --> ... <!-- END:name -->
 *
 * Template files (vendor/README.template.md, vendor/vscodium/README.md)
 * reference these via {{section:name}} placeholders. This script extracts
 * sections from README.md and substitutes them into each template, then
 * applies the existing {{NAME}} / {{URL}} substitution at package time.
 *
 * Run via: make docs
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = import.meta.dirname
  ? path.resolve(import.meta.dirname, "..")
  : path.resolve("..");

const readmePath = path.join(root, "README.md");
const templates = [
  path.join(root, "vendor", "README.template.md"),
  path.join(root, "vendor", "vscodium", "README.md"),
];

// Extract sections from the main README.
const readme = readFileSync(readmePath, "utf-8");
const sections = {};
const re = /<!-- BEGIN:(\S+) -->\r?\n([\s\S]*?)<!-- END:\1 -->/g;
let m;
while ((m = re.exec(readme)) !== null) {
  sections[m[1]] = m[2].replace(/\n$/, "");
}

let changed = false;

for (const tplPath of templates) {
  let tpl = readFileSync(tplPath, "utf-8");
  tpl = tpl.replace(/\{\{section:(\S+)\}\}/g, (_match, name) => {
    const content = sections[name];
    if (content === undefined) {
      console.error(`  MISSING section "${name}" in README.md`);
      process.exit(1);
    }
    return content;
  });

  // Skip if unchanged.
  const current = readFileSync(tplPath, "utf-8");
  if (tpl === current) continue;

  writeFileSync(tplPath, tpl, "utf-8");
  console.log(`  updated ${path.relative(root, tplPath)}`);
  changed = true;
}

if (!changed) console.log("  all templates up to date");
