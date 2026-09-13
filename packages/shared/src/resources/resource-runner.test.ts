// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import {
  runResourceSetups,
  runResourceTeardowns,
  selectPhaseBody,
  ResourcePhaseError,
} from "./resource-runner.js";
import type { ResourceConfig } from "../types/resource.js";

function resource(over: Partial<ResourceConfig> & Pick<ResourceConfig, "slug">): ResourceConfig {
  return {
    ref: `${over.slug}@r1`,
    resourceId: `id-${over.slug}`,
    revisionId: `rev-${over.slug}`,
    name: over.slug,
    setup: { sh: "true" },
    exports: [],
    ...over,
  } as ResourceConfig;
}

const opts = { cwd: tmpdir() };

describe("selectPhaseBody", () => {
  it("returns undefined when the phase is absent", () => {
    expect(selectPhaseBody(undefined, "s", "teardown")).toBeUndefined();
  });

  // Skipping silently would give a run that looks valid but has no resource.
  it("throws when the phase exists but has no sh body", () => {
    expect(() => selectPhaseBody({} as never, "s", "setup")).toThrow(ResourcePhaseError);
  });
});

describe("runResourceSetups", () => {
  it("publishes values written to $SCOPE_SETUP_ENV", async () => {
    const { values } = await runResourceSetups(
      [
        resource({
          slug: "sim",
          setup: { sh: 'echo "SIM_URL=http://localhost:18080" >> "$SCOPE_SETUP_ENV"' },
          exports: ["SIM_URL"],
        }),
      ],
      opts,
    );
    expect(values).toEqual({ SIM_URL: "http://localhost:18080" });
  });

  it("merges values across resources in order", async () => {
    const { values, provisioned } = await runResourceSetups(
      [
        resource({ slug: "a", setup: { sh: 'echo "A=1" >> "$SCOPE_SETUP_ENV"' }, exports: ["A"] }),
        resource({ slug: "b", setup: { sh: 'echo "B=2" >> "$SCOPE_SETUP_ENV"' }, exports: ["B"] }),
      ],
      opts,
    );
    expect(values).toEqual({ A: "1", B: "2" });
    expect(provisioned.map((r) => r.slug)).toEqual(["a", "b"]);
  });

  it("fails the run when the script exits non-zero", async () => {
    await expect(
      runResourceSetups([resource({ slug: "bad", setup: { sh: "exit 3" } })], opts),
    ).rejects.toThrow(ResourcePhaseError);
  });

  // `sh -e`: a failing command must abort rather than continue into a
  // half-provisioned state that reports success.
  it("aborts on the first failing command", async () => {
    await expect(
      runResourceSetups(
        [resource({ slug: "e", setup: { sh: 'false\necho "A=1" >> "$SCOPE_SETUP_ENV"' }, exports: ["A"] })],
        opts,
      ),
    ).rejects.toThrow(ResourcePhaseError);
  });

  // The omission would otherwise surface much later as an unresolved ${VAR}
  // inside an MCP registration failure.
  it("fails when a declared export is not published", async () => {
    await expect(
      runResourceSetups(
        [resource({ slug: "sim", setup: { sh: "true" }, exports: ["SIM_URL"] })],
        opts,
      ),
    ).rejects.toThrow(/did not publish declared exports: SIM_URL/);
  });

  it("reports the failing resource so the caller can unwind the prefix", async () => {
    const started: string[] = [];
    await expect(
      runResourceSetups(
        [
          resource({ slug: "ok", setup: { sh: "true" } }),
          resource({ slug: "bad", setup: { sh: "exit 1" } }),
        ],
        { ...opts, log: (_l, m) => void started.push(m) },
      ),
    ).rejects.toThrow(ResourcePhaseError);
    expect(started.some((m) => m.includes("'ok'"))).toBe(true);
    expect(started.some((m) => m.includes("'bad'"))).toBe(true);
  });

  it("rejects a malformed $SCOPE_SETUP_ENV rather than dropping the line", async () => {
    await expect(
      runResourceSetups(
        [resource({ slug: "m", setup: { sh: 'echo "nonsense" >> "$SCOPE_SETUP_ENV"' } })],
        opts,
      ),
    ).rejects.toThrow(/malformed \$SCOPE_SETUP_ENV/);
  });

  it("times out a hanging phase", async () => {
    await expect(
      runResourceSetups([resource({ slug: "slow", setup: { sh: "sleep 30" } })], {
        ...opts,
        timeoutMs: 300,
      }),
    ).rejects.toThrow(/timed out/);
  }, 10_000);

  it("passes extra environment through to the script", async () => {
    const { values } = await runResourceSetups(
      [
        resource({
          slug: "env",
          setup: { sh: 'echo "SEEN=$MY_VAR" >> "$SCOPE_SETUP_ENV"' },
          exports: ["SEEN"],
        }),
      ],
      { ...opts, env: { MY_VAR: "from-worker" } },
    );
    expect(values.SEEN).toBe("from-worker");
  });
});

describe("runResourceTeardowns", () => {
  it("releases in reverse order so dependants unwind first", async () => {
    const order: string[] = [];
    await runResourceTeardowns(
      [
        resource({ slug: "first", teardown: { sh: "true" } }),
        resource({ slug: "second", teardown: { sh: "true" } }),
      ],
      { ...opts, log: (_l, m) => void (m.includes("Releasing") && order.push(m)) },
    );
    expect(order[0]).toContain("'second'");
    expect(order[1]).toContain("'first'");
  });

  // Cleanup failure must not mask the result the run actually produced.
  it("keeps going when one teardown fails, and does not throw", async () => {
    const logs: string[] = [];
    await expect(
      runResourceTeardowns(
        [
          resource({ slug: "a", teardown: { sh: "true" } }),
          resource({ slug: "b", teardown: { sh: "exit 1" } }),
        ],
        { ...opts, log: (_l, m) => void logs.push(m) },
      ),
    ).resolves.toBeUndefined();
    expect(logs.some((m) => m.includes("teardown failed, continuing"))).toBe(true);
    expect(logs.some((m) => m.includes("Releasing resource 'a'"))).toBe(true);
  });

  it("skips resources with no teardown phase", async () => {
    await expect(
      runResourceTeardowns([resource({ slug: "none" })], opts),
    ).resolves.toBeUndefined();
  });
});
