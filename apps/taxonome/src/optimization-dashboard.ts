// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { TaxonomeStyle } from "./style.js";

type ElementState = {
  id: string;
  status: "WAIT" | "PREFLIGHT" | "OPTIMIZING" | "DONE" | "FAILED" | "SKIPPED";
  train: number;
  validation: number;
  metricCalls: number;
  bestScore?: number;
  detail: string;
};

/** Truthful stable-row progress for multi-element optimization. */
export class OptimizationDashboard {
  private readonly interactive: boolean;
  private readonly silent: boolean;
  private readonly rows: ElementState[];
  private renderedLines = 0;
  private started = false;

  constructor(
    elementIds: readonly string[],
    deterministicIds: readonly string[],
    private readonly style: TaxonomeStyle,
    private readonly stream: NodeJS.WriteStream = process.stderr,
    json = false,
  ) {
    this.silent = json;
    this.interactive = !json && stream.isTTY === true;
    this.rows = [
      ...elementIds.map(id => ({
        id,
        status: "WAIT" as const,
        train: 0,
        validation: 0,
        metricCalls: 0,
        detail: "waiting",
      })),
      ...deterministicIds.map(id => ({
        id,
        status: "SKIPPED" as const,
        train: 0,
        validation: 0,
        metricCalls: 0,
        detail: "deterministic element",
      })),
    ];
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    if (this.silent) return;
    if (this.interactive) this.stream.write("\u001b[?25l");
    this.render();
  }

  update(input: {
    elementId: string;
    status: ElementState["status"];
    train?: number;
    validation?: number;
    metricCalls?: number;
    bestScore?: number;
    detail: string;
  }): void {
    const row = this.rows.find(candidate => candidate.id === input.elementId);
    if (!row) return;
    Object.assign(row, {
      status: input.status,
      ...(input.train !== undefined ? { train: input.train } : {}),
      ...(input.validation !== undefined ? { validation: input.validation } : {}),
      ...(input.metricCalls !== undefined ? { metricCalls: input.metricCalls } : {}),
      ...(input.bestScore !== undefined ? { bestScore: input.bestScore } : {}),
      detail: input.detail,
    });
    if (this.silent) return;
    if (this.interactive) this.render();
    else {
      this.stream.write(
        `${input.status} ${input.elementId} train=${row.train} validation=${row.validation} calls=${row.metricCalls}` +
        `${row.bestScore === undefined ? "" : ` best=${row.bestScore}`} ${input.detail}\n`,
      );
    }
  }

  finalize(): void {
    if (!this.started) return;
    if (this.silent) return;
    if (this.interactive) {
      this.render();
      this.stream.write("\u001b[?25h");
    }
  }

  private render(): void {
    if (!this.interactive) return;
    if (this.renderedLines > 0) {
      this.stream.write(`\u001b[${this.renderedLines}A`);
    }
    const complete = this.rows.filter(row => row.status === "DONE").length;
    const failed = this.rows.filter(row => row.status === "FAILED").length;
    const skipped = this.rows.filter(row => row.status === "SKIPPED").length;
    const header = `Taxonome optimize  DONE ${complete}  FAIL ${failed}  SKIP ${skipped}`;
    const lines = [
      this.style.title(header),
      this.style.label("STATUS      ELEMENT                         TRAIN VALID CALLS BEST DETAIL"),
      ...this.rows.map(row => {
        const status = row.status === "DONE"
          ? this.style.pass(row.status)
          : row.status === "FAILED"
            ? this.style.fail(row.status)
            : row.status === "SKIPPED"
              ? this.style.warning(row.status)
              : this.style.prompt(row.status);
        return `${status.padEnd(19)} ${row.id.padEnd(31)} ${String(row.train).padStart(5)} ${String(row.validation).padStart(5)} ${String(row.metricCalls).padStart(5)} ${(row.bestScore ?? "-").toString().padStart(4)} ${this.style.dim(row.detail)}`;
      }),
    ];
    for (const line of lines) {
      this.stream.write(`\u001b[2K${line}\n`);
    }
    this.renderedLines = lines.length;
  }
}
