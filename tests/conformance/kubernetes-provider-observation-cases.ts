import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { createKubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import {
  currentComputeAbortSignal,
  withComputeAbortSignal,
} from "../../apps/controller/src/drivers/compute/operation-context.ts";
import type { ComputeRevisionContext } from "../../packages/contracts/src/index.ts";
import { providerReadinessFixture } from "../fixtures/kubernetes-provider-readiness.mjs";
import { authContext, options } from "../helpers/kubernetes-routed-scenarios.mjs";

export async function checkMalformedProviderPodObservations(t: TestContext) {
  const fixture = providerReadinessFixture();
  const ready = fixture.pod("harness-ready");
  const invalid = /invalid or incomplete provider Harness Pod list/;
  const invalidLists: [string, unknown][] = [
    ["null response", null],
    ["missing items", {}],
    ["object items", { items: {} }],
    ["null items", { items: null }],
    ["wrong list kind", { kind: "ServiceList", items: [ready] }],
    ["wrong list version", { apiVersion: "apps/v1", items: [ready] }],
    ["malformed list metadata", { metadata: [], items: [ready] }],
    ["continuation", { metadata: { continue: "next-page" }, items: [ready] }],
    ["SDK continuation", { metadata: { _continue: "next-page" }, items: [ready] }],
    ["remaining items", { metadata: { remainingItemCount: 1 }, items: [ready] }],
  ];
  for (const [name, response] of invalidLists) {
    await t.test(name, async () => {
      fixture.setObservation(response);
      await assert.rejects(fixture.ready(), invalid);
    });
  }
  type ProviderPod = {
    apiVersion: string;
    kind: string;
    metadata: { name: string; namespace: string; labels: Record<string, string> };
    status: { conditions: { type: string; status: string }[] };
  };
  const invalidPods: [string, (pod: ProviderPod) => unknown][] = [
    ["wrong kind", (pod) => ({ ...pod, kind: "Service" })],
    ["wrong version", (pod) => ({ ...pod, apiVersion: "apps/v1" })],
    ["missing metadata", ({ metadata: _metadata, ...pod }) => pod],
    ["array metadata", (pod) => ({ ...pod, metadata: [] })],
    [
      "missing name",
      (pod) => {
        const { name: _name, ...metadata } = pod.metadata;
        return { ...pod, metadata };
      },
    ],
    ["empty namespace", (pod) => ({ ...pod, metadata: { ...pod.metadata, namespace: "" } })],
    ["array labels", (pod) => ({ ...pod, metadata: { ...pod.metadata, labels: [] } })],
    [
      "nonstring label",
      (pod) => ({
        ...pod,
        metadata: { ...pod.metadata, labels: { ...pod.metadata.labels, extra: 1 } },
      }),
    ],
    [
      "contradictory selector label",
      (pod) => ({
        ...pod,
        metadata: {
          ...pod.metadata,
          labels: { ...pod.metadata.labels, "openclaw.dev/service-principal": "another-principal" },
        },
      }),
    ],
    ...(
      [
        ["null deletion timestamp", null],
        ["invalid deletion date", new Date(NaN)],
        ["invalid deletion string", "0"],
        // Date would roll these over to a plausible wrong day; the frontier rule refuses them.
        ["impossible deletion date", "2026-02-30T00:00:00Z"],
        ["non-leap February 29", "2026-02-29T00:00:00Z"],
        ["hour 24 deletion time", "2026-08-24T24:00:00Z"],
        ["offset deletion time", "2026-08-25T00:00:00+00:00"],
        ["nonzero offset deletion time", "2026-08-25T02:00:00.000+02:00"],
        ["ten fraction digits", "2026-08-25T00:00:00.1234567890Z"],
      ] as const
    ).map(([name, deletionTimestamp]): [string, (pod: ProviderPod) => unknown] => [
      name,
      (pod) => ({ ...pod, metadata: { ...pod.metadata, deletionTimestamp } }),
    ]),
    ["null status", (pod) => ({ ...pod, status: null })],
    ["array status", (pod) => ({ ...pod, status: [] })],
    ["object conditions", (pod) => ({ ...pod, status: { conditions: {} } })],
    [
      "null condition",
      (pod) => ({
        ...pod,
        status: { conditions: [...pod.status.conditions, null] },
      }),
    ],
    [
      "nonstring condition type",
      (pod) => ({
        ...pod,
        status: { conditions: [...pod.status.conditions, { type: 1, status: "True" }] },
      }),
    ],
    [
      "nonstring condition status",
      (pod) => ({
        ...pod,
        status: {
          conditions: pod.status.conditions.map((condition) => ({ ...condition, status: true })),
        },
      }),
    ],
    [
      "invalid condition status",
      (pod) => ({
        ...pod,
        status: {
          conditions: pod.status.conditions.map((condition) => ({ ...condition, status: "true" })),
        },
      }),
    ],
    [
      "duplicate Ready",
      (pod) => ({
        ...pod,
        status: { conditions: [...pod.status.conditions, { type: "Ready", status: "True" }] },
      }),
    ],
    [
      "conflicting Ready",
      (pod) => ({
        ...pod,
        status: { conditions: [...pod.status.conditions, { type: "Ready", status: "False" }] },
      }),
    ],
  ];
  for (const [name, makeMalformed] of invalidPods) {
    await t.test(name, async () => {
      const malformed = makeMalformed(fixture.pod("harness-malformed"));
      // A valid Ready entry must not hide invalid observations before or after it.
      for (const items of [[malformed], [ready, malformed], [malformed, ready]]) {
        fixture.setObservation({ items });
        await assert.rejects(fixture.ready(), invalid);
      }
    });
  }
  for (const malformed of [null, false, "pod", [], {}]) {
    fixture.setObservation({ items: [ready, malformed] });
    await assert.rejects(fixture.ready(), invalid);
  }
  fixture.setObservation({ metadata: { continue: "", remainingItemCount: 0 }, items: [ready] });
  assert.equal(await fixture.ready(), true);
}

export async function checkProviderActivationBeforeRouting() {
  const fixture = providerReadinessFixture();
  const context: ComputeRevisionContext = {
    ...authContext(fixture.revision),
    secretEnvironment: [],
  };
  const resolved = context.harnessAuth;
  assert.ok("backendRef" in resolved && resolved.backendRef !== undefined);
  const invalidContexts: (ComputeRevisionContext | undefined)[] = [
    undefined,
    { ...context, harnessAuth: { ...resolved, source: { ...resolved.source, id: "sec_other" } } },
    { ...context, harnessAuth: { ...resolved, secretDriverId: "another-secret-driver" } },
    {
      ...context,
      harnessAuth: {
        ...resolved,
        backendRef: { ...resolved.backendRef, namespaceName: "another-tenant" },
      },
    },
    { ...context, harnessAuth: { ...resolved, backendRef: { ...resolved.backendRef, uid: "" } } },
  ];
  for (const invalidContext of invalidContexts) {
    await assert.rejects(
      fixture.driver.activateRevision(fixture.revision, invalidContext),
      /authentication.*(?:context|source)/i,
    );
  }
  assert.equal(fixture.requests.length, 0, "invalid authentication must fail before Pod readiness");
  for (const items of [
    [],
    [fixture.pod("starting", "False")],
    [fixture.pod("ready"), fixture.pod("starting", "False")],
    [fixture.pod("ready"), fixture.pod("also-ready")],
  ]) {
    fixture.setObservation({ items });
    await assert.rejects(
      fixture.driver.activateRevision(fixture.revision, context),
      /The exact AgentRevision workload is not ready/,
    );
  }
  fixture.setObservation({ items: [fixture.pod("ready"), null] });
  await assert.rejects(
    fixture.driver.activateRevision(fixture.revision, context),
    /invalid or incomplete/,
  );
  assert.equal(fixture.requests.length, 5);
}

export async function checkProviderReadinessErrorsAndCancellation() {
  const fixture = providerReadinessFixture();
  Object.assign(fixture.driver, { waitBeforeRetry: async () => {} });
  const denied = Object.assign(new Error("Pod observation denied"), { statusCode: 403 });
  fixture.setObservation(() => {
    throw denied;
  });
  await assert.rejects(fixture.ready(), (error) => error === denied);
  assert.equal(fixture.requests.length, 1);
  const unavailable = Object.assign(new Error("Pod observation unavailable"), { statusCode: 503 });
  fixture.setObservation(() => {
    throw unavailable;
  });
  await assert.rejects(fixture.ready(), (error) => error === unavailable);
  assert.equal(fixture.requests.length, 7);

  const cancellation = new Error("revision observation cancelled");
  const alreadyAborted = new AbortController();
  alreadyAborted.abort(cancellation);
  await assert.rejects(
    withComputeAbortSignal(alreadyAborted.signal, () => fixture.ready()),
    (error) => error === cancellation,
  );
  assert.equal(fixture.requests.length, 7);
  for (const lateSuccess of [false, true]) {
    const owner = new AbortController();
    const { promise: observing, resolve: started } = Promise.withResolvers<AbortSignal>();
    const {
      promise: observation,
      resolve: release,
      reject,
    } = Promise.withResolvers<{ items: ReturnType<typeof fixture.pod>[] }>();
    fixture.setObservation(() => {
      const signal = currentComputeAbortSignal();
      assert.ok(signal);
      started(signal);
      if (!lateSuccess) {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }
      return observation;
    });
    // Manual owner cancellation exercises the driver context; it is not database lease-loss proof.
    const readiness = withComputeAbortSignal(owner.signal, () => fixture.ready());
    const rejected = assert.rejects(readiness, (error) => error === cancellation);
    const requestSignal = await observing;
    owner.abort(cancellation);
    assert.equal(requestSignal.aborted, true);
    if (lateSuccess) {
      release({ items: [fixture.pod("late-ready")] });
    }
    await rejected;
  }
  assert.equal(fixture.requests.length, 9);
}

export async function checkKubernetesReadRetryAfter() {
  const fixture = providerReadinessFixture();
  const waits: number[] = [];
  const waitBeforeRetry = async (ms: number) => {
    waits.push(ms);
  };
  Object.assign(fixture.driver, { waitBeforeRetry });
  const failing = (count: number, error: () => Error) => {
    let failures = 0;
    fixture.setObservation(() => {
      if (failures < count) {
        failures += 1;
        throw error();
      }
      return { items: [fixture.pod("ready")] };
    });
  };

  // Four 503s in a row (a few hundred milliseconds of API server restart) still
  // end in a successful read, with exponential, jittered waits.
  failing(4, () => Object.assign(new Error("unavailable"), { code: 503, headers: {} }));
  assert.equal(await fixture.ready(), true);
  assert.equal(fixture.requests.length, 5);
  assert.equal(waits.length, 4);
  waits.forEach((ms, index) => {
    assert.ok(ms >= 25 * 2 ** index && ms <= 50 * 2 ** index, `wait ${index}: ${ms}`);
  });

  // Retry-After in seconds and as an HTTP date is honored, capped at 2 s per wait.
  waits.length = 0;
  const throttled = (value: string) =>
    Object.assign(new Error("throttled"), { code: 429, headers: { "retry-after": value } });
  const retryAfter = ["1", new Date(Date.now() + 60_000).toUTCString()];
  fixture.setObservation(() => {
    const value = retryAfter.shift();
    if (value !== undefined) {
      throw throttled(value);
    }
    return { items: [fixture.pod("ready")] };
  });
  assert.equal(await fixture.ready(), true);
  // The date is a minute away, but the wait stops at the 2 s total.
  assert.deepEqual(waits, [1_000, 1_000]);

  // The total wait is bounded: a persistent outage fails within the budget.
  waits.length = 0;
  const before = fixture.requests.length;
  fixture.setObservation(() => {
    throw throttled("30");
  });
  await assert.rejects(fixture.ready(), /throttled/);
  assert.deepEqual(waits, [2_000]);
  assert.equal(fixture.requests.length - before, 2);

  // Mutating calls never retry, and a 404 is not retryable.
  waits.length = 0;
  let calls = 0;
  const flaky = () => {
    calls += 1;
    throw Object.assign(new Error("unavailable"), { code: 503, headers: {} });
  };
  await assert.rejects(fixture.driver["request"](flaky, { mutating: true }), /unavailable/);
  await assert.rejects(
    fixture.driver["request"](() => {
      calls += 1;
      throw Object.assign(new Error("missing"), { code: 404 });
    }),
    /missing/,
  );
  assert.equal(calls, 2);
  assert.deepEqual(waits, []);
}

export async function checkKubernetesRetryOwnerCancellation() {
  const driver = createKubernetesComputeDriver(options());
  const owner = new AbortController();
  const reason = new Error("revision observation cancelled");
  let calls = 0;
  const started = Date.now();
  const request = withComputeAbortSignal(owner.signal, () =>
    driver["request"](() => {
      calls += 1;
      throw Object.assign(new Error("throttled"), {
        code: 429,
        headers: { "Retry-After": "2" },
      });
    }),
  );
  const cancel = setTimeout(() => owner.abort(reason), 50);
  try {
    await assert.rejects(request, (error) => error === reason);
    assert.equal(calls, 1);
    assert.ok(Date.now() - started < 1_500);
  } finally {
    clearTimeout(cancel);
  }
}
