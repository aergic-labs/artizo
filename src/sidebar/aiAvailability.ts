/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * AI availability check, shared by the sidebar provider and the config edit
 * service. Extracted so neither has to reach into the AI factory directly and
 * both report availability the same way.
 */

import { getAiAssist } from "../ai";

/** Whether AI assist can be offered in the current runtime. */
export async function isAiAvailable(): Promise<boolean> {
  return (await getAiAssist()).isAvailable();
}
