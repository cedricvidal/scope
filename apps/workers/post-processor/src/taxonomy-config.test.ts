// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_TAXONOME_MODEL,
  resolveTaxonomeModel,
} from "./taxonomy-config.js";

describe("Taxonome model configuration", () => {
  it("uses provider-resolved auto selection by default", () => {
    expect(DEFAULT_TAXONOME_MODEL).toBe("auto");
    expect(resolveTaxonomeModel({})).toBe("auto");
  });

  it("preserves a trimmed explicit TAXONOME_MODEL override", () => {
    expect(resolveTaxonomeModel({ TAXONOME_MODEL: " configured-model " }))
      .toBe("configured-model");
  });

  it("does not read coding-run model or reasoning-effort environment keys", () => {
    expect(resolveTaxonomeModel({
      MODEL: "coding-model",
      REASONING_EFFORT: "xhigh",
    })).toBe("auto");
  });
});
