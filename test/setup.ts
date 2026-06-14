/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { vi } from "vitest";

// esbuild define flags — tests use the default (Kiro) path
globalThis.HAS_KIRO_ADAPTER = false;
globalThis.HAS_TRAE_ADAPTER = false;
globalThis.HAS_DEVIN_ADAPTER = false;
globalThis.HAS_VSCODIUM_ADAPTER = false;
globalThis.HAS_SECCOMP_UNCONFINED = false;
globalThis.HAS_HOME_SYMLINK = false;
globalThis.HAS_ARGV_PATCH = true;
