/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/** Recolor the extension icon to neutral grey for light/dark backgrounds. */

import * as fs from "node:fs";
import * as path from "node:path";
import UPNG from "upng-js";

const root = path.resolve(import.meta.dirname, "..");
const iconPath = path.join(root, "resources", "icon.png");

const GREY = 0x42; // #424242, matches ssh-remote icon

const img = UPNG.decode(fs.readFileSync(iconPath));
const w = img.width;
const h = img.height;
const data = new Uint8Array(UPNG.toRGBA8(img)[0]);

let touched = 0;
for (let i = 0; i < data.length; i += 4) {
  if (data[i + 3] === 0) continue; // transparent
  if (data[i] !== GREY || data[i + 1] !== GREY || data[i + 2] !== GREY) {
    data[i] = GREY;
    data[i + 1] = GREY;
    data[i + 2] = GREY;
    touched++;
  }
}

const encoded = Buffer.from(UPNG.encode([data.buffer], w, h, 0));
fs.writeFileSync(iconPath, encoded);
console.log(
  `Recolored ${path.relative(root, iconPath)} -> #424242 (${touched} pixels changed, ${w}x${h}, ${encoded.length} bytes)`,
);
