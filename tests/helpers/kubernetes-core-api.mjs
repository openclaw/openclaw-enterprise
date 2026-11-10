import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { currentComputeAbortSignal } from "../../apps/controller/src/drivers/compute/operation-context.ts";

// Shared parts of the in-memory CoreV1Api stand-ins that the Kubernetes Configuration and Secret
// Driver tests use, and the clock and deadline controls for their request tests. The fakes are
// not live SDK or cluster proof: tests/conformance/kubernetes-client.test.mjs covers transport.

// The error a fake call throws for a queued failure: an API status or error code, or "dropped".
export function injectedFailure(failure, method) {
  if (failure === "dropped") {
    // What the client throws when the API server closes the connection unanswered.
    return Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  }
  return Object.assign(new Error(`${method} failed with ${failure}`), { code: failure });
}

// Holds a fake call until its request is aborted (its deadline or its owner), then rejects with
// the abort reason: an API server that accepts a request and never answers.
export async function stallUntilAborted(method) {
  const signal = currentComputeAbortSignal();
  if (signal === undefined) {
    throw new Error(`${method} would stall with no deadline`);
  }
  signal.throwIfAborted();
  await new Promise((_, reject) =>
    signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
  );
}

// The OCC Namespace discovery calls: a Namespace labelled for an OCC Namespace ID in the shared,
// split-gateway or adopted layout.
export class FakeNamespaceCoreV1Api {
  namespaces = new Map();

  addNamespace(id, layout = "shared") {
    const name =
      layout === "split"
        ? `oce-gateways-${createHash("sha256").update(id).digest("hex").slice(0, 24)}`
        : layout === "adopted"
          ? "customer-support"
          : `oce-${createHash("sha256").update(id).digest("hex").slice(0, 15)}`;
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

  async listNamespace({ labelSelector }) {
    const [label, id] = labelSelector.split("=");
    return {
      items: [...this.namespaces.values()].filter(
        ({ metadata }) => metadata.labels?.[label] === id,
      ),
    };
  }

  async readNamespace({ name }) {
    const namespace = this.namespaces.get(name);
    if (namespace === undefined) {
      throw Object.assign(new Error("missing Namespace"), { code: 404 });
    }
    return structuredClone(namespace);
  }
}

// Freezes Date.now for the test at `clock.now`; the test moves time by assigning to it.
export function frozenClock(t, start = Date.parse("2026-11-01T00:00:00.000Z")) {
  const clock = { now: start };
  t.mock.method(Date, "now", () => clock.now);
  return clock;
}

// Replaces each request's own deadline (AbortSignal.timeout) for the test with a signal that
// fires only when the test fires it, and records each requested delay.
export function controlledRequestTimeouts(t) {
  const timeouts = {
    delays: [],
    deadlines: [],
    // Fires the deadline of the request sent last.
    fireLatest() {
      timeouts.deadlines.at(-1).abort(new DOMException("deadline", "TimeoutError"));
    },
    // Settles every pending request, also when an assertion failed first.
    fireAll() {
      for (const deadline of timeouts.deadlines) {
        deadline.abort();
      }
    },
  };
  t.mock.method(AbortSignal, "timeout", (delay) => {
    timeouts.delays.push(delay);
    const deadline = new AbortController();
    timeouts.deadlines.push(deadline);
    return deadline.signal;
  });
  return timeouts;
}

// Whether `promise` has settled; the caller still handles its outcome.
export function settlement(promise) {
  const state = { settled: false };
  promise.then(
    () => (state.settled = true),
    () => (state.settled = true),
  );
  return state;
}

// Runs up to `count` event-loop turns, and stops early once `done()` is true. The fake clients
// answer in microtasks, so a few turns reach a pending retry pause or request.
export async function nextTurns(count, done = () => false) {
  for (let turn = 0; turn < count && !done(); turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// Runs event-loop turns until `isSent()` is true; fails after 100 turns.
export async function untilSent(isSent, what) {
  for (let turn = 0; !isSent(); turn += 1) {
    assert.ok(turn < 100, `${what} was never sent`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}
