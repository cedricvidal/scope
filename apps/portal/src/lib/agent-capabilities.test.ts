// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { isAgentCapabilityEnabled } from "./agent-capabilities.js";

describe("isAgentCapabilityEnabled", () => {
  it.each([undefined, false, true])(
    "preserves user choice for advertised=%s when strict mode is off",
    (advertised) => {
      expect(isAgentCapabilityEnabled(advertised, false)).toBe(true);
    },
  );

  it("requires an explicitly advertised capability in strict mode", () => {
    expect(isAgentCapabilityEnabled(true, true)).toBe(true);
    expect(isAgentCapabilityEnabled(false, true)).toBe(false);
    expect(isAgentCapabilityEnabled(undefined, true)).toBe(false);
  });
});
