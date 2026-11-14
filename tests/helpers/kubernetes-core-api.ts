import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mock, type TestContext } from "node:test";

import type { resolveKubernetesControlNamespace } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { currentComputeAbortSignal } from "../../apps/controller/src/drivers/compute/operation-context.ts";

// Shared parts of the in-memory CoreV1Api stand-ins that the Kubernetes Configuration and Secret
// Driver tests use, and the clock and deadline controls for their request tests. The fakes are
// not live SDK or cluster proof: tests/conformance/kubernetes-client.test.mjs covers transport.

// The error a fake call throws for a queued failure: an API status or error code, or "dropped".
export function injectedFailure(failure: number | string, method: string) {
  if (failure === "dropped") {
    // What the client throws when the API server closes the connection unanswered.
    return Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  }
  return Object.assign(new Error(`${method} failed with ${failure}`), { code: failure });
}

type NamespaceCoreApi = Parameters<typeof resolveKubernetesControlNamespace>[0];
type ListNamespaceRequest = Parameters<NamespaceCoreApi["listNamespace"]>[0] & {
  labelSelector: string;
};
type ReadNamespaceRequest = Parameters<NamespaceCoreApi["readNamespace"]>[0];
type NamespaceLayout = "shared" | "split" | "adopted";
type NamespaceRecord = {
  metadata: {
    name: string;
    labels: Record<string, string>;
    annotations: Record<string, string>;
  };
  status: { phase: string };
};

// The OCC Namespace discovery calls: a Namespace labelled for an OCC Namespace ID in the shared,
// split-gateway or adopted layout.
export class FakeNamespaceCoreV1Api {
  namespaces = new Map<string, NamespaceRecord>();

  addNamespace(id: string, layout: NamespaceLayout = "shared"): string {
    let name: string;
    if (layout === "split") {
      name = `oce-gateways-${createHash("sha256").update(id).digest("hex").slice(0, 24)}`;
    } else if (layout === "adopted") {
      name = "customer-support";
    } else {
      name = `oce-${createHash("sha256").update(id).digest("hex").slice(0, 15)}`;
    }
    this.namespaces.set(name, {
      metadata: {
        name,
        labels: {
          "app.kubernetes.io/managed-by": "openclaw-enterprise",
          "openclaw.dev/gateway-namespace": id,
          ...(layout === "split" ? {} : { "openclaw.dev/namespace": id }),
          ...(layout === "adopted"
            ? Object.fromEntries(
                ["enforce", "audit", "warn"].map((mode) => [
                  `pod-security.kubernetes.io/${mode}`,
                  "restricted",
                ]),
              )
            : {}),
        },
        annotations: {
          "openclaw.dev/namespace-id": id,
          ...(layout === "adopted" ? { "openclaw.dev/namespace-lifecycle": "external" } : {}),
        },
      },
      status: { phase: "Active" },
    });
    return name;
  }

  async listNamespace({
    labelSelector,
  }: ListNamespaceRequest): ReturnType<NamespaceCoreApi["listNamespace"]> {
    const [label = "", id] = labelSelector.split("=");
    return {
      items: [...this.namespaces.values()].filter(
        ({ metadata }) => metadata.labels?.[label] === id,
      ),
    };
  }

  async readNamespace({ name }: ReadNamespaceRequest): Promise<NamespaceRecord> {
    const namespace = this.namespaces.get(name);
    if (namespace === undefined) {
      throw Object.assign(new Error("missing Namespace"), { code: 404 });
    }
    return structuredClone(namespace);
  }
}

// Holds a fake call until its request is aborted (its deadline or its owner), then rejects with
// the abort reason: an API server that accepts a request and never answers.
export async function stallUntilAborted(method: string): Promise<void> {
  const signal = currentComputeAbortSignal();
  if (signal === undefined) {
    throw new Error(`${method} would stall with no deadline`);
  }
  signal.throwIfAborted();
  await new Promise<never>((_, reject) =>
    signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
  );
}

// Freezes Date.now for the test at `clock.now`; the test moves time by assigning to it.
export function frozenClock(
  t: TestContext,
  start = Date.parse("2026-11-01T00:00:00.000Z"),
): { now: number } {
  const clock = { now: start };
  t.mock.method(Date, "now", () => clock.now);
  return clock;
}

type RequestTimeouts = {
  delays: number[];
  deadlines: AbortController[];
  fireLatest: () => void;
  fireAll: () => void;
};

// Replaces each request's own deadline (AbortSignal.timeout) for the test with a signal that
// fires only when the test fires it, and records each requested delay.
export function controlledRequestTimeouts(t: TestContext): RequestTimeouts {
  const timeouts: RequestTimeouts = {
    delays: [],
    deadlines: [],
    // Fires the deadline of the request sent last.
    fireLatest() {
      timeouts.deadlines.at(-1)!.abort(new DOMException("deadline", "TimeoutError"));
    },
    // Settles every pending request, also when an assertion failed first.
    fireAll() {
      for (const deadline of timeouts.deadlines) {
        deadline.abort();
      }
    },
  };
  t.mock.method(AbortSignal, "timeout", (delay: number) => {
    timeouts.delays.push(delay);
    const deadline = new AbortController();
    timeouts.deadlines.push(deadline);
    return deadline.signal;
  });
  return timeouts;
}

// Whether `promise` has settled; the caller still handles its outcome.
export function settlement(promise: Promise<unknown>): { settled: boolean } {
  const state = { settled: false };
  promise.then(
    () => (state.settled = true),
    () => (state.settled = true),
  );
  return state;
}

// Runs up to `count` event-loop turns, and stops early once `done()` is true. The fake clients
// answer in microtasks, so a few turns reach a pending retry pause or request.
export async function nextTurns(count: number, done = () => false): Promise<void> {
  for (let turn = 0; turn < count && !done(); turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

// Runs event-loop turns until `isSent()` is true; fails after 100 turns.
export async function untilSent(isSent: () => boolean, what: string): Promise<void> {
  for (let turn = 0; !isSent(); turn += 1) {
    assert.ok(turn < 100, `${what} was never sent`);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

// Runs an operation with mocked timers, firing each retry pause as soon as it is
// scheduled, and appends each pause's length to `pauses` (the mocked clock moves
// by exactly the pending pause). Request deadlines use AbortSignal.timeout, which
// stays real, and the loop spins until the operation settles: keep operations that
// wait for a real deadline out of it. Not reentrant.
export async function withRetryTimers<T>(
  operation: () => Promise<T>,
  pauses: number[] = [],
): Promise<T> {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    const result = operation();
    const state = settlement(result);
    while (!state.settled) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      const before = Date.now();
      mock.timers.runAll();
      if (Date.now() > before) {
        pauses.push(Date.now() - before);
      }
    }
    return await result;
  } finally {
    mock.timers.reset();
  }
}

// A copy of READ_RETRY_DELAYS_MS (apps/controller/src/drivers/kubernetes/request.ts),
// as a pin: five pauses, about four seconds in all. A change to the schedule
// updates both.
export const READ_RETRY_PAUSES_MS = [100, 250, 500, 1_000, 2_000];

// A copy of MINIMUM_SEND_BUDGET_MS (same file), as a pin: the least time an API write's deadline
// must leave to send a write, or to retry a read after its pause.
export const MINIMUM_SEND_BUDGET_MS = 2_000;
