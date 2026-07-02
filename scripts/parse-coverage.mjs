/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { readFileSync } from "node:fs";

const raw = readFileSync("coverage/lcov.info", "utf8");
const lines = raw.split("\n");

const files = [];
let cur = null;

for (const line of lines) {
  const sf = line.match(/^SF:(.+)/);
  if (sf) {
    cur = { file: sf[1], lf: 0, lh: 0, brf: 0, brh: 0, fnf: 0, fnh: 0 };
    files.push(cur);
    continue;
  }
  if (!cur) continue;

  const lf = line.match(/^LF:(\d+)/);
  if (lf) {
    cur.lf = +lf[1];
    continue;
  }
  const lh = line.match(/^LH:(\d+)/);
  if (lh) {
    cur.lh = +lh[1];
    continue;
  }
  const brf = line.match(/^BRF:(\d+)/);
  if (brf) {
    cur.brf = +brf[1];
    continue;
  }
  const brh = line.match(/^BRH:(\d+)/);
  if (brh) {
    cur.brh = +brh[1];
    continue;
  }
  const fnf = line.match(/^FNF:(\d+)/);
  if (fnf) {
    cur.fnf = +fnf[1];
    continue;
  }
  const fnh = line.match(/^FNH:(\d+)/);
  if (fnh) {
    cur.fnh = +fnh[1];
    continue;
  }
}

// sort by line pct ascending (worst first)
files.sort((a, b) => a.lh / a.lf - b.lh / b.lf);

const pad = (v, n) => String(v).padStart(n);

for (const f of files) {
  const lpct = f.lf ? ((f.lh / f.lf) * 100).toFixed(1) : "0.0";
  const bpct = f.brf ? ((f.brh / f.brf) * 100).toFixed(1) : "  -";
  const fpct = f.fnf ? ((f.fnh / f.fnf) * 100).toFixed(1) : "  -";
  const rel = f.file.replace(/\\/g, "/").replace(/^.*?artizo\//, "");
  console.log(
    `${pad(lpct, 6)}% L |${pad(bpct, 5)}% B |${pad(fpct, 5)}% F | ${pad(String(f.lf), 4)} lines | ${rel}`,
  );
}

// Overall totals
const totLf = files.reduce((s, f) => s + f.lf, 0);
const totLh = files.reduce((s, f) => s + f.lh, 0);
const totBrf = files.reduce((s, f) => s + f.brf, 0);
const totBrh = files.reduce((s, f) => s + f.brh, 0);
const totFnf = files.reduce((s, f) => s + f.fnf, 0);
const totFnh = files.reduce((s, f) => s + f.fnh, 0);

const oL = totLf ? ((totLh / totLf) * 100).toFixed(1) : "0.0";
const oB = totBrf ? ((totBrh / totBrf) * 100).toFixed(1) : "0.0";
const oF = totFnf ? ((totFnh / totFnf) * 100).toFixed(1) : "0.0";

console.log(`${"─".repeat(70)}`);
console.log(
  `${pad(oL, 6)}% L |${pad(oB, 5)}% B |${pad(oF, 5)}% F | ${pad(String(totLf), 4)} lines | OVERALL (${files.length} files)`,
);
