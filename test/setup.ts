/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { vi } from "vitest";

// No build-time flags — platform/AI factories do runtime detection via
// product.json. Tests that need a specific platform mock detectPlatformName
// or the adapter directly.
