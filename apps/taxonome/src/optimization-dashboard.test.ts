// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { OptimizationDashboard } from "./optimization-dashboard.js";
import { createTaxonomeStyle } from "./style.js";

describe("OptimizationDashboard", () => {
  it("uses stable colored TTY rows and restores the cursor", () => {
    const stream = new PassThrough() as PassThrough & {
      isTTY?: boolean;
    };
    stream.isTTY = true;
    let text = "";
    stream.on("data", chunk => {
      text += chunk.toString();
    });
    const dashboard = new OptimizationDashboard(
      ["prompt-a", "prompt-b"],
      ["code-a"],
      createTaxonomeStyle(stream, { FORCE_COLOR: "1" }),
      stream as never,
    );
    dashboard.start();
    dashboard.update({
      elementId: "prompt-a",
      status: "OPTIMIZING",
      train: 2,
      validation: 1,
      metricCalls: 3,
      bestScore: 1,
      detail: "candidate scored",
    });
    dashboard.update({
      elementId: "prompt-a",
      status: "DONE",
      metricCalls: 4,
      bestScore: 1,
      detail: "optimized YAML ready",
    });
    dashboard.finalize();

    expect(text).toContain("\u001b[?25l");
    expect(text).toContain("\u001b[?25h");
    expect(text).toContain("deterministic element");
    expect(text).toContain("optimized YAML ready");
    expect(text).toMatch(/\u001b\[/);
  });

  it("emits stable plain lines for non-TTY output", () => {
    const stream = new PassThrough();
    let text = "";
    stream.on("data", chunk => {
      text += chunk.toString();
    });
    const dashboard = new OptimizationDashboard(
      ["prompt-a"],
      [],
      createTaxonomeStyle(stream, { NO_COLOR: "1" }),
      stream as never,
    );
    dashboard.start();
    dashboard.update({
      elementId: "prompt-a",
      status: "PREFLIGHT",
      train: 2,
      validation: 1,
      detail: "validated",
    });
    dashboard.finalize();
    expect(text).toContain("PREFLIGHT prompt-a train=2 validation=1");
    expect(text).not.toMatch(/\u001b\[/);
  });
});
