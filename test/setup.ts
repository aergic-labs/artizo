/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { vi } from "vitest";

// esbuild define flags - tests use the default (Kiro) path
declare global {
  // eslint-disable-next-line no-var
  var HAS_KIRO_ADAPTER: boolean;
  // eslint-disable-next-line no-var
  var HAS_TRAE_ADAPTER: boolean;
  // eslint-disable-next-line no-var
  var HAS_DEVIN_ADAPTER: boolean;
  // eslint-disable-next-line no-var
  var HAS_VSCODIUM_ADAPTER: boolean;
  // eslint-disable-next-line no-var
  var HAS_SECCOMP_UNCONFINED: boolean;
  // eslint-disable-next-line no-var
  var HAS_HOME_SYMLINK: boolean;
  // eslint-disable-next-line no-var
  var HAS_ARGV_PATCH: boolean;
  // eslint-disable-next-line no-var
  var ARTIZO_SPIKE: boolean;
}

globalThis.HAS_KIRO_ADAPTER = false;
globalThis.HAS_TRAE_ADAPTER = false;
globalThis.HAS_DEVIN_ADAPTER = false;
globalThis.HAS_VSCODIUM_ADAPTER = false;
globalThis.HAS_SECCOMP_UNCONFINED = false;
globalThis.HAS_HOME_SYMLINK = false;
globalThis.HAS_ARGV_PATCH = true;
globalThis.ARTIZO_SPIKE = false;
