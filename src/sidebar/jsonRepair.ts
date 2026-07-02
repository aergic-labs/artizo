/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Best-effort repair of malformed devcontainer.json. The heuristics here
 * (bracket balancing, missing-comma insertion, bare-value fixing) are
 * inherently approximate; callers must back up the original first.
 */

import { parse as cjParse, stringify as cjStringify } from "comment-json";

// Bracket balancer (comment + string aware)
function balanceBrackets(text: string): string {
  let result = "";
  const stack = [];
  let inString = false,
    escape = false;
  let inLineComment = false,
    inBlockComment = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1] || "";

    if (
      !inString &&
      !inLineComment &&
      ch === "/" &&
      next === "*" &&
      !inBlockComment
    ) {
      inBlockComment = true;
      result += ch;
      continue;
    }
    if (inBlockComment && ch === "*" && next === "/") {
      inBlockComment = false;
      result += ch + next;
      i++;
      continue;
    }
    if (inBlockComment) {
      result += ch;
      continue;
    }

    if (!inString && !inBlockComment && ch === "/" && next === "/") {
      inLineComment = true;
      result += ch;
      continue;
    }
    if (inLineComment && ch === "\n") {
      inLineComment = false;
      result += ch;
      continue;
    }
    if (inLineComment) {
      result += ch;
      continue;
    }

    if (escape) {
      result += ch;
      escape = false;
      continue;
    }
    if (ch === "\\" && inString) {
      result += ch;
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      result += ch;
      continue;
    }
    if (inString) {
      result += ch;
      continue;
    }

    if (ch === "{" || ch === "[") {
      stack.push(ch);
      result += ch;
    } else if (ch === "}") {
      if (stack[stack.length - 1] === "{") {
        stack.pop();
        result += ch;
      }
    } else if (ch === "]") {
      if (stack[stack.length - 1] === "[") {
        stack.pop();
        result += ch;
      }
    } else {
      result += ch;
    }
  }
  while (stack.length > 0) result += stack.pop() === "{" ? "}" : "]";
  return result;
}

// Bare value fixer (comment-safe)
function fixBareValues(text: string): string {
  const comments: string[] = [];
  text = text
    .replace(/\/\*[\s\S]*?\*\//g, (m: string) => {
      comments.push(m);
      return `__C${comments.length - 1}__`;
    })
    .replace(/\/\/.*$/gm, (m: string) => {
      comments.push(m);
      return `__C${comments.length - 1}__`;
    });

  text = text.replace(
    /:\s*(True|False|None|Null|TRUE|FALSE|NONE|undefined)\b/g,
    (_: string, w: string) => {
      const lower = w.toLowerCase();
      return ": " + (lower === "undefined" ? "null" : lower);
    },
  );
  text = text.replace(
    /:\s*([a-zA-Z_][a-zA-Z0-9_.\-]*)(\s*[,\]\}])/g,
    (_m: string, word: string, tail: string) => {
      const lower = word.toLowerCase();
      return /^(true|false|null|undefined|none)$/.test(lower)
        ? ":" +
            (lower === "undefined" || lower === "none" ? "null" : lower) +
            tail
        : ': "' + word + '"' + tail;
    },
  );
  text = text.replace(
    /:\s*([a-zA-Z_][a-zA-Z0-9_.\-]*)\s*$/gm,
    (_m: string, word: string) => {
      const lower = word.toLowerCase();
      return /^(true|false|null|undefined|none)$/.test(lower)
        ? ":" + (lower === "undefined" || lower === "none" ? "null" : lower)
        : ': "' + word + '"';
    },
  );

  for (let i = 0; i < comments.length; i++)
    text = text.replace(`__C${i}__`, comments[i]);
  return text;
}

// Full repair pipeline
export function repairDevcontainerJson(rawInput: string): string {
  let text = rawInput;
  // Replace smart/curly quotes with straight ASCII quotes
  text = text.replace(/[“”]/g, '"');
  text = text.replace(/[‘’]/g, "'");
  // Collapse duplicate commas
  text = text.replace(/,{2,}/g, ",");
  // Insert missing commas between consecutive values
  text = text.replace(/(["\]\}\d])\s*\n\s*(")/g, "$1,\n$2");
  // Single quotes
  text = text.replace(/'([^']*)'/g, '"$1"');
  // Unquoted keys (skips comments)
  text = text.replace(
    /([{,]\s*(?:\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*)([a-zA-Z0-9_\-]+)\s*:/g,
    '$1"$2":',
  );
  // Drop unbalanced brackets
  text = balanceBrackets(text);
  // Re-collapse duplicate commas that balanceBrackets may have introduced
  text = text.replace(/,{2,}/g, ",");
  // Fix bare values + unquoted keys (comment-safe)
  text = fixBareValues(text);
  // comment-json round-trip (validates + pretty-prints)
  try {
    return cjStringify(cjParse(text), null, 2);
  } catch {
    return text;
  }
}
