import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout } from "node:timers/promises";
import {
  installationControllerOptions,
  loadInstallationConfiguration,
} from "../../apps/controller/src/composition/installation-config.ts";
import type { EgressRefusal, EgressRequest } from "../../packages/contracts/src/index.ts";
import {
  CREDENTIAL_PROXY_CAPACITY_MAXIMUM,
  type EgressExchangeOwner,
  type EgressResolution,
  CredentialProxy,
  DEFAULT_CREDENTIAL_PROXY_CAPACITY,
  OPERATION_AUTHENTICATION_BUDGET,
  OPERATION_CAPACITY,
  OPERATION_SANDBOX_SHARE,
  REPLAY_SANDBOX_SHARE,
  REPLAY_TABLE_CAPACITY,
} from "../../packages/occ/src/credential-proxy.ts";
import { EgressSendReceipts } from "../../packages/occ/src/egress-send-receipts.ts";
import { OpenClawController } from "../../packages/occ/src/index.ts";
import { InMemoryPlatformState } from "../../packages/occ/src/state/platform-state.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import capturedOperation from "../fixtures/static-egress/openshell-operation.json" with { type: "json" };
import { createCredentialProxyInstallationConfiguration } from "../helpers/installation-driver-configuration.ts";
import { syntheticDispatchFixture } from "../helpers/static-egress-dispatch.ts";
import { requestId } from "../helpers/static-egress-request-id.ts";
import { staticEgressWireFixture, wireTime } from "../helpers/static-egress.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";
import { registerStaticEgressResponsesWireCases } from "./static-egress-responses-wire-cases.ts";

function heldRequests(t: TestContext, release: () => void) {
  const cancellation = new AbortController();
  const pending: Promise<EgressResolution>[] = [];
  t.after(async () => {
    cancellation.abort();
    release();
    await Promise.allSettled(pending);
  });
  return { cancellation, pending };
}

// Closing a handle releases its operation slot while the captured ID stays reserved.
async function resolveThenClose(
  sandbox: ReturnType<Awaited<ReturnType<typeof syntheticDispatchFixture>>["sandboxes"]>,
  name: string,
  signal?: AbortSignal,
) {
  const closed = new AbortController();
  try {
    const decision = await sandbox.resolve(
      name,
      undefined,
      signal ? AbortSignal.any([closed.signal, signal]) : closed.signal,
    );
    return decision.kind === "ready" ? "ready" : decision;
  } finally {
    closed.abort();
  }
}

const capacityProbeOwner: EgressExchangeOwner = {
  verify: async () => undefined,
  capture: () => undefined,
  owns: () => false,
};

export function registerStaticEgressRequestCapacityCases(): void {
  test("signed supervisor instance and UUIDv7 creation horizon refuse old callers and deadline-extension replay", async (t) => {
    let elapsed = 0;
    const now = () => new Date(Date.now() + elapsed);
    const f = await staticEgressWireFixture(t, { now });
    const reads = f.secretReads;
    const operation = asRecord(capturedOperation);
    const context = asRecord(operation?.request_context);
    const deadline = asRecord(operation?.deadline);
    assert.ok(operation && context && deadline, "captured operation and wire envelope");
    const { request_id: historicalId } = context;
    const { seconds, nanos } = deadline;
    assert.ok(typeof historicalId === "string", "captured request ID");
    assert.ok(typeof seconds === "string" && Number.isSafeInteger(Number(seconds)), "wire seconds");
    assert.ok(typeof nanos === "number" && Number.isSafeInteger(nanos), "wire nanos");
    const serializedCreation = Number.parseInt(historicalId.replaceAll("-", "").slice(0, 12), 16);
    const serializedDeadline = Number(seconds) * 1000 + nanos / 1e6;
    assert.equal(serializedCreation, operation.creation_ms);
    assert.equal(serializedDeadline, serializedCreation + 30_000);
    assert.equal(operation.capture_delay_ms, 100);
    // The independently captured delayed sender wire is historical, never a reusable
    // authorization. Rebind only the fixture Sandbox to reach the real horizon check.
    const historical = f.capture();
    historical.request.context.request_id = historicalId;
    historical.deadline = { seconds, nanos };
    assert.ok((await f.resolve(historical)).refused);
    assert.equal(f.secretReads, reads);
    for (const claims of [
      { instance_id: undefined },
      { instance_id: "10000000-0000-4000-8000-000000000001" },
      { instance_id: f.namespace.id },
    ]) {
      if (claims.instance_id?.startsWith("10000000-")) {
        assert.ok((await f.resolve(f.capture(), f.metadata(claims))).refused);
      } else {
        await assert.rejects(f.resolve(f.capture(), f.metadata(claims)), { code: 7 });
      }
    }
    assert.equal(f.secretReads, reads);
    const captured = f.capture();
    captured.deadline = wireTime(now().getTime() + 1000);
    const ready = (await f.resolve(captured)).ready;
    assert.ok(ready);
    // A short submitted deadline does not shorten replay retention for this immutable operation ID.
    elapsed = 2000;
    captured.deadline = wireTime(now().getTime() + 20_000);
    assert.ok((await f.resolve({ ...captured, response_custody: randomBytes(32) })).refused);
    elapsed = 31_000;
    captured.deadline = wireTime(now().getTime() + 1000);
    assert.ok((await f.resolve({ ...captured, response_custody: randomBytes(32) })).refused);
    assert.equal(
      f.secretReads,
      reads + 1,
      "eviction cannot make an expired UUID into a new operation",
    );
    assert.ok((await f.resolve(f.capture())).ready);
  });

  test(
    "sustained sequential operations outlive replay capacity without waiting for JWT expiry",
    { timeout: 30_000 },
    async (t) => {
      // A fixed base keeps real time out of the advanced clock, so the horizon margin below holds
      // on a runner of any speed. The base is set again after setup (below).
      let start = Date.now();
      let elapsed = 0;
      // Configured bounds, validated like an Installation's requestCapacity, release through the
      // same registry code as the defaults, so the loop needs only about a hundred operations.
      const capacity = {
        operations: 16,
        authenticatingOperations: 4,
        sandboxOperations: 4,
        requestIds: 256,
        sandboxRequestIds: 64,
      };
      const f = await staticEgressWireFixture(t, {
        now: () => new Date(start + elapsed),
        credentialProxyCapacity: capacity,
      });
      assert.ok(f.controller instanceof OpenClawController);
      assert.deepEqual(
        f.controller.createCredentialProxy(capacityProbeOwner).capacity,
        capacity,
        "the controller builds the exchange's proxy with the configured bounds",
      );
      const peer = f.metadata({ exp: Math.floor(Date.now() / 1000) + 3600 });
      // Advance the controller's supported clock while keeping genuine signed identity, IAM,
      // Secret SDK, authority transport and HTTPS provider. Completion must release active capacity;
      // fixed operation horizons must release replay capacity during the same long-lived JWT.
      // One Sandbox at one request per 800 ms holds about 38 replay entries per 30 s horizon,
      // under its share of 64; a horizon twice as long would reach it. Its share is the first
      // replay bound it meets, so each operation past the share needs an expired entry released.
      // Operation slots must also return on completion, or the loop stops at the operation share
      // or capacity. "one Sandbox's replay share bounds it without refusing other Sandboxes"
      // covers the installation-wide table's expiry.
      const step = 800;
      const operations = capacity.sandboxRequestIds + 64;
      assert.ok(30_000 / step < capacity.sandboxRequestIds);
      assert.ok(60_000 / step > capacity.sandboxRequestIds);
      assert.ok(capacity.sandboxRequestIds < capacity.requestIds);
      assert.ok(capacity.operations < operations);
      // The Kubernetes Secret driver stamps each read with the wall clock, and the proxy refuses
      // material observed after its own clock. Setup can take longer than one step on a busy
      // runner, so start the advanced clock from the wall clock after setup, not before it.
      start = Date.now();
      for (let i = 0; i < operations; i += 1) {
        elapsed += step;
        const protectedResponse = await f.exchangeResponse(undefined, undefined, peer);
        assert.ok(
          "body" in protectedResponse && Buffer.isBuffer(protectedResponse.body),
          `sequential operation ${i}`,
        );
      }
      assert.equal(f.providerRequests.length, operations);
      assert.ok(
        f.providerRequests.every(
          ({ authorization }) => authorization === "Bearer synthetic-key-initial",
        ),
      );
    },
  );

  test("send receipt records the digest of the accepted request", async (t) => {
    const receipts = new EgressSendReceipts(new InMemoryPlatformState());
    const f = await syntheticDispatchFixture(t, receipts);
    // In this request, body precedes deadlineAt. Moving it to the end while copying the
    // request must not silently change the digest we commit to the authorization receipt.
    const accepted = { ...f.request, body: f.request.body.toString("base64") };
    const expectedDigest = createHash("sha256").update(JSON.stringify(accepted)).digest("hex");

    assert.equal((await f.resolve()).kind, "ready");
    assert.equal((await f.authorizeSend()).kind, "allow");
    const stored = await receipts.recover(f.sender, f.attempt());
    assert.ok(stored?.authorization);
    assert.equal(stored.authorization.requestDigest, expectedDigest);
    assert.equal(f.arrivals, 0, "committing the authorization is not evidence of a send");
  });

  for (const bodyType of ["Uint8Array", "Buffer"]) {
    test(`credential proxy detaches ${bodyType} and request fields before identity verification`, async (t) => {
      const f = await syntheticDispatchFixture(t);
      const verification = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      const callerRequest = {
        ...f.request,
        headers: f.request.headers.map(([name, value]): [string, string] => [name, value]),
        body: bodyType === "Buffer" ? Buffer.from(f.request.body) : new Uint8Array(f.request.body),
      };
      const proxy = new CredentialProxy({
        ...f.ports,
        exchangeOwner: {
          ...f.ports.exchangeOwner,
          async verify(authorization) {
            entered.resolve();
            await verification.promise;
            return f.ports.exchangeOwner.verify(authorization);
          },
        },
      });
      const cancellation = new AbortController();
      t.after(() => {
        cancellation.abort();
        verification.resolve();
      });
      const resolving = proxy.resolve(
        "synthetic-peer",
        f.association.installation.sandboxId,
        callerRequest,
        cancellation.signal,
      );
      t.after(async () => {
        await Promise.allSettled([resolving]);
      });
      const first = await Promise.race([entered.promise, resolving]);
      assert.equal(first, undefined, "verification must start before resolution settles");
      // The caller reuses its buffers while authentication is pending. Classification and
      // custody must still use the originally accepted request, including Buffer bytes.
      callerRequest.body.fill(0);
      const contentType = callerRequest.headers[0];
      assert.ok(contentType);
      contentType[1] = "application/octet-stream";
      callerRequest.headers.push(["authorization", "caller-controlled"]);
      callerRequest.url = "https://changed.example.test/";
      callerRequest.deadlineAt = "invalid";
      verification.resolve();
      assert.equal((await resolving).kind, "ready");
      assert.equal(f.reads, 1);
    });
  }

  test("credential proxy rejects an oversized body before copying request fields", async (t) => {
    const f = await syntheticDispatchFixture(t);
    const proxy = new CredentialProxy(f.ports);
    const request = {
      ...f.request,
      body: new Uint8Array(1024 * 1024 + 1),
      get headers(): EgressRequest["headers"] {
        throw new Error("an oversized request must not be copied");
      },
    };
    assert.deepEqual(
      await proxy.resolve(
        "synthetic-peer",
        f.association.installation.sandboxId,
        request,
        new AbortController().signal,
      ),
      { kind: "refused", error: { kind: "denied", code: "unsupported_operation" } },
    );
    assert.equal(f.reads, 0);
  });

  const saturated = { kind: "refused", error: { kind: "unavailable", code: "resolver" } };

  test("in-flight Secret selection and outstanding handles consume the same bounded capacity", async (t) => {
    // Exercise the actual 1024-slot registry, not a race to finish 1024 TLS handshakes,
    // native IAM checks and Kubernetes reads inside their intentionally short deadlines.
    const f = await syntheticDispatchFixture(t);
    let reads = 0;
    let target = 0;
    let filled: PromiseWithResolvers<void>;
    const gate = Promise.withResolvers<void>();
    const s = f.sandboxes((ports) => ({
      ...ports,
      async read(...args) {
        if (++reads === target) {
          filled.resolve();
        }
        await gate.promise;
        return ports.read(...args);
      },
    }));
    const first = new AbortController();
    t.after(() => first.abort());
    const { cancellation, pending } = heldRequests(t, gate.resolve);
    const other = cancellation.signal;
    // Four Sandboxes fill their shares; each burst exactly fits the authentication budget.
    assert.equal(OPERATION_SANDBOX_SHARE * 4, OPERATION_CAPACITY);
    assert.equal(OPERATION_AUTHENTICATION_BUDGET, OPERATION_SANDBOX_SHARE);
    for (const name of ["a", "b", "c", "d"]) {
      filled = Promise.withResolvers<void>();
      target += OPERATION_SANDBOX_SHARE;
      for (let i = 0; i < OPERATION_SANDBOX_SHARE; i += 1) {
        pending.push(s.resolve(name, undefined, pending.length === 0 ? first.signal : other));
      }
      await Promise.race([filled.promise, ...pending]);
      assert.equal(reads, target, "the burst reached the material lookup gate");
    }
    assert.deepEqual(
      await s.resolve("e", undefined, other),
      saturated,
      "pending selection is charged before material returns",
    );
    assert.deepEqual(
      await s.proxy.resolve(
        "e",
        "unauthenticated-sandbox",
        {
          ...f.request,
          get headers(): EgressRequest["headers"] {
            throw new Error("an exhausted registry must reject before copying request fields");
          },
        },
        other,
      ),
      saturated,
    );
    assert.equal(reads, OPERATION_CAPACITY, "the excess resolution never starts selection");
    gate.resolve();
    assert.ok((await Promise.all(pending)).every((decision) => decision.kind === "ready"));
    assert.deepEqual(
      await s.resolve("e", undefined, other),
      saturated,
      "ready handles remain charged",
    );
    first.abort();
    assert.equal(
      (await s.resolve("e", undefined, other)).kind,
      "ready",
      "closing the owning sender frees exactly its slot",
    );
    assert.deepEqual(await s.resolve("e", undefined, other), saturated);
  });

  test("one Sandbox's open handles leave operation capacity to other Sandboxes", async (t) => {
    const f = await syntheticDispatchFixture(t);
    const s = f.sandboxes();
    const held = new AbortController();
    t.after(() => held.abort());
    // As many requests as the installation-wide cap, each holding its handle open.
    const decisions: EgressResolution[] = [];
    for (let i = 0; i < OPERATION_CAPACITY; i += 1) {
      decisions.push(await s.resolve("a", undefined, held.signal));
    }
    assert.equal((await s.resolve("b")).kind, "ready", "another Sandbox's first request");
    assert.ok(decisions.slice(0, OPERATION_SANDBOX_SHARE).every((d) => d.kind === "ready"));
    for (const decision of decisions.slice(OPERATION_SANDBOX_SHARE)) {
      assert.deepEqual(decision, saturated, "a Sandbox holds at most its share");
    }
    assert.equal(f.reads, OPERATION_SANDBOX_SHARE + 1, "a refused request starts no selection");
    // Closing the handles returns the share, and so does their deadline.
    held.abort();
    const again = new AbortController();
    t.after(() => again.abort());
    for (let i = 0; i < OPERATION_SANDBOX_SHARE; i += 1) {
      assert.equal((await s.resolve("a", undefined, again.signal)).kind, "ready");
    }
    assert.deepEqual(await s.resolve("a"), saturated);
    f.advance(20_000);
    assert.equal((await s.resolve("a")).kind, "ready", "expired handles were discarded");
  });

  test("requests still authenticating share a small budget charged before verification", async (t) => {
    const f = await syntheticDispatchFixture(t);
    let gate: PromiseWithResolvers<void> | undefined;
    let verified = 0;
    const filled = Promise.withResolvers<void>();
    const s = f.sandboxes((ports) => ({
      ...ports,
      exchangeOwner: {
        ...ports.exchangeOwner,
        async verify(name) {
          verified += 1;
          if (gate && name === "a") {
            if (verified === OPERATION_AUTHENTICATION_BUDGET) {
              filled.resolve();
            }
            await gate.promise;
          }
          return ports.exchangeOwner.verify(name);
        },
      },
    }));
    gate = Promise.withResolvers<void>();
    const { cancellation, pending } = heldRequests(t, () => gate?.resolve());
    for (let i = 0; i < OPERATION_AUTHENTICATION_BUDGET; i += 1) {
      pending.push(s.resolve("a", undefined, cancellation.signal));
    }
    await Promise.race([filled.promise, ...pending]);
    assert.equal(verified, OPERATION_AUTHENTICATION_BUDGET, "the budget is filled");
    assert.deepEqual(await s.resolve("b"), saturated, "the budget is global before verification");
    assert.equal(verified, OPERATION_AUTHENTICATION_BUDGET, "the excess request is never verified");
    gate.resolve();
    assert.ok((await Promise.all(pending)).every((decision) => decision.kind === "ready"));
    gate = undefined;
    // Verified requests moved to their Sandbox's share and left the budget.
    assert.equal((await s.resolve("b")).kind, "ready");
  });

  test("every refusal returns its operation slot", async (t) => {
    const f = await syntheticDispatchFixture(t);
    let mode: string | undefined;
    const gate = Promise.withResolvers<void>();
    let gated = 0;
    const filled = Promise.withResolvers<void>();
    const s = f.sandboxes((ports) => ({
      ...ports,
      exchangeOwner: {
        ...ports.exchangeOwner,
        async verify(name) {
          if (mode === "gated" && name === "a") {
            if (++gated === OPERATION_AUTHENTICATION_BUDGET) {
              filled.resolve();
            }
            await gate.promise;
          }
          if (mode === "verification throws") {
            throw new Error("synthetic verification failure");
          }
          return mode === "unknown peer" ? undefined : ports.exchangeOwner.verify(name);
        },
      },
      installation: async (peer) =>
        mode === "installation missing" ? undefined : ports.installation(peer),
      async check(use) {
        if (mode === "policy throws") {
          throw new Error("synthetic policy failure");
        }
        return mode === "policy denies" ? { kind: "denied", code: "withdrawn" } : ports.check(use);
      },
      async read(...args) {
        if (mode === "Secret read throws") {
          throw new Error("synthetic Secret failure");
        }
        return ports.read(...args);
      },
    }));
    const denied = (code: Extract<EgressRefusal, { kind: "denied" }>["code"]) => ({
      kind: "refused",
      error: { kind: "denied", code },
    });
    const unavailable = (code: Extract<EgressRefusal, { kind: "unavailable" }>["code"]) => ({
      kind: "refused",
      error: { kind: "unavailable", code },
    });
    const unsupported = {
      body: Buffer.from(JSON.stringify({ model: "other-model", input: "hello", store: false })),
    };
    const paths = [
      // Before verification settles: the authentication budget.
      [
        "cancelled before verification",
        () => s.resolve("a", undefined, AbortSignal.abort()),
        { kind: "refused", error: { kind: "cancelled" } },
      ],
      ["unknown peer", () => s.resolve("a"), denied("identity")],
      [
        "verification throws",
        () =>
          s.resolve("a").catch((error: unknown) => {
            assert.ok(error instanceof Error);
            return error.message;
          }),
        "synthetic verification failure",
      ],
      [
        "another Sandbox's ID",
        () => s.proxy.resolve("a", "other-sandbox", s.request(), new AbortController().signal),
        denied("identity"),
      ],
      // After verification: the Sandbox's share.
      [
        "deadline already passed",
        () => s.resolve("a", { deadlineAt: new Date(f.ports.now()).toISOString() }),
        { kind: "refused", error: { kind: "deadline_exceeded" } },
      ],
      [
        "installation missing",
        () => s.resolve("a"),
        { kind: "refused", error: { kind: "not_ready", code: "attachment_pending" } },
      ],
      ["unsupported route", () => s.resolve("a", unsupported), denied("unsupported_operation")],
      ["policy denies", () => s.resolve("a"), denied("withdrawn")],
      ["policy throws", () => s.resolve("a"), unavailable("authority")],
      ["Secret read throws", () => s.resolve("a"), unavailable("secret_store")],
    ] as const;
    // Each path refuses more requests than the budget or a share holds, and all of them
    // together more than the installation-wide cap.
    for (const [name, attempt, refused] of paths) {
      mode = name;
      for (let i = 0; i <= OPERATION_SANDBOX_SHARE; i += 1) {
        assert.deepEqual(await attempt(), refused, name);
      }
      mode = undefined;
      const closed = new AbortController();
      try {
        assert.equal((await s.resolve("a", undefined, closed.signal)).kind, "ready", name);
      } finally {
        closed.abort();
      }
    }
    // No slot was returned twice either: the share and the budget still hold exactly.
    const held = new AbortController();
    t.after(() => held.abort());
    for (let i = 0; i < OPERATION_SANDBOX_SHARE; i += 1) {
      assert.equal((await s.resolve("a", undefined, held.signal)).kind, "ready");
    }
    assert.deepEqual(await s.resolve("a"), saturated, "the share still holds");
    held.abort();
    mode = "gated";
    const { cancellation, pending } = heldRequests(t, gate.resolve);
    for (let i = 0; i < OPERATION_AUTHENTICATION_BUDGET; i += 1) {
      pending.push(s.resolve("a", undefined, cancellation.signal));
    }
    await Promise.race([filled.promise, ...pending]);
    assert.equal(gated, OPERATION_AUTHENTICATION_BUDGET, "the budget is filled again");
    assert.deepEqual(await s.resolve("b"), saturated, "the budget still holds");
    mode = undefined;
    gate.resolve();
    assert.ok((await Promise.all(pending)).every((decision) => decision.kind === "ready"));
  });

  test("requests refused before capture leave the replay table to every Sandbox", async (t) => {
    const f = await syntheticDispatchFixture(t);
    const s = f.sandboxes();
    const unsupported = {
      body: Buffer.from(JSON.stringify({ model: "other-model", input: "hello", store: false })),
    };
    const refused = { kind: "refused", error: { kind: "denied", code: "unsupported_operation" } };
    for (let i = 0; i < REPLAY_TABLE_CAPACITY; i += 1) {
      assert.deepEqual(await s.resolve("a", unsupported), refused);
    }
    assert.equal((await s.resolve("b")).kind, "ready", "another Sandbox's first request");
    assert.equal((await s.resolve("a")).kind, "ready", "the refused Sandbox's next request");
    // Nothing used an ID refused before capture, so it remains the sender's to use.
    const id = requestId(f.ports.now());
    assert.deepEqual(await s.resolve("a", { ...unsupported, id }), refused);
    assert.equal((await s.resolve("a", { id })).kind, "ready");
    assert.equal(f.reads, 3);
  });

  test("one Sandbox's replay share bounds it without refusing other Sandboxes", async (t) => {
    const f = await syntheticDispatchFixture(t);
    let gate: PromiseWithResolvers<void> | undefined;
    let entered: PromiseWithResolvers<void> | undefined;
    const s = f.sandboxes((ports) => ({
      ...ports,
      async installation(peer) {
        entered?.resolve();
        await gate?.promise;
        return ports.installation(peer);
      },
    }));
    // Material was selected, so each ID stays reserved after its handle closes.
    const use = (name: string) => resolveThenClose(s, name);
    for (let i = 0; i < REPLAY_SANDBOX_SHARE; i += 1) {
      assert.equal(await use("a"), "ready");
    }
    assert.deepEqual(await use("a"), saturated, "a Sandbox past its share is refused");
    assert.equal(await use("b"), "ready", "another Sandbox keeps its share");
    for (const name of ["b", "c", "d"]) {
      for (let i = name === "b" ? 1 : 0; i < REPLAY_SANDBOX_SHARE; i += 1) {
        assert.equal(await use(name), "ready");
      }
    }
    assert.equal(REPLAY_SANDBOX_SHARE * 4, REPLAY_TABLE_CAPACITY);
    assert.deepEqual(await use("e"), saturated, "the installation-wide bound still holds");
    // Fixed 30-second horizons return both the shares and the table, including
    // horizons that pass while a request's installation lookup is pending.
    f.advance(29_000);
    gate = Promise.withResolvers<void>();
    entered = Promise.withResolvers<void>();
    const cancellation = new AbortController();
    const crossing = resolveThenClose(s, "a", cancellation.signal);
    t.after(async () => {
      cancellation.abort();
      gate?.resolve();
      await Promise.allSettled([crossing]);
    });
    await Promise.race([entered.promise, crossing]);
    f.advance(1_000);
    gate.resolve();
    assert.equal(await crossing, "ready");
    gate = undefined;
    entered = undefined;
    assert.equal(await use("e"), "ready");
  });

  test("request-time capacity defaults to today's bounds and is set once per controller", async (t) => {
    const f = await syntheticDispatchFixture(t);
    const today = {
      operations: OPERATION_CAPACITY,
      authenticatingOperations: OPERATION_AUTHENTICATION_BUDGET,
      sandboxOperations: OPERATION_SANDBOX_SHARE,
      requestIds: REPLAY_TABLE_CAPACITY,
      sandboxRequestIds: REPLAY_SANDBOX_SHARE,
    };
    assert.deepEqual(today, {
      operations: 1024,
      authenticatingOperations: 256,
      sandboxOperations: 256,
      requestIds: 8192,
      sandboxRequestIds: 2048,
    });
    assert.deepEqual(DEFAULT_CREDENTIAL_PROXY_CAPACITY, today);
    assert.deepEqual(new CredentialProxy(f.ports).capacity, today);
    const installation = { id: "installation", name: "installation", createdAt: f.startedAt };
    const owner = f.ports.exchangeOwner;
    assert.deepEqual(
      new OpenClawController(installation).createCredentialProxy(owner).capacity,
      today,
    );
    const configured = {
      operations: 64,
      authenticatingOperations: 8,
      sandboxOperations: 16,
      requestIds: 512,
      sandboxRequestIds: 128,
    };
    const controller = new OpenClawController(installation, {
      credentialProxyCapacity: configured,
    });
    assert.deepEqual(controller.createCredentialProxy(owner).capacity, configured);
    // Direct composition refuses what Installation startup refuses, before any request.
    for (const capacity of [
      { operations: 0 },
      { sandboxOperations: OPERATION_CAPACITY + 1 },
      { requestIds: 16, sandboxRequestIds: 17 },
      { requestIds: CREDENTIAL_PROXY_CAPACITY_MAXIMUM.requestIds + 1 },
      { operations: "64" },
    ]) {
      // Exercise the runtime JavaScript boundary with deliberately untyped input.
      assert.throws(() => {
        Reflect.construct(CredentialProxy, [f.ports, capacity]);
      }, RangeError);
      assert.throws(() => {
        Reflect.construct(OpenClawController, [
          installation,
          { credentialProxyCapacity: capacity },
        ]);
      }, RangeError);
    }
  });

  test("configured operation bounds limit each Sandbox, the process and authentication", async (t) => {
    const f = await syntheticDispatchFixture(t);
    const s = f.sandboxes(undefined, { operations: 7, sandboxOperations: 2 });
    assert.equal(s.proxy.capacity.authenticatingOperations, 1, "a quarter of the configured pool");
    const held = new Map<string, AbortController>();
    t.after(() => {
      for (const controller of held.values()) {
        controller.abort();
      }
    });
    const hold = async (name: string) => {
      const closed = held.get(name) ?? new AbortController();
      held.set(name, closed);
      const decision = await s.resolve(name, undefined, closed.signal);
      return decision.kind === "ready" ? "ready" : decision;
    };
    for (const name of ["a", "b", "c"]) {
      assert.equal(await hold(name), "ready");
      assert.equal(await hold(name), "ready");
      assert.deepEqual(await hold(name), saturated, `${name} holds at most its configured share`);
    }
    // Three full shares leave one slot of the configured process bound.
    assert.equal(await hold("d"), "ready");
    assert.deepEqual(await hold("d"), saturated, "the configured process bound holds");
    const firstSandbox = held.get("a");
    assert.ok(firstSandbox);
    firstSandbox.abort();
    assert.equal(await hold("d"), "ready", "a closed handle returns its slot");

    let gate: PromiseWithResolvers<void> | undefined = Promise.withResolvers<void>();
    let verified = 0;
    const filled = Promise.withResolvers<void>();
    const g = f.sandboxes(
      (ports) => ({
        ...ports,
        exchangeOwner: {
          ...ports.exchangeOwner,
          async verify(name) {
            if (++verified === 2) {
              filled.resolve();
            }
            await gate?.promise;
            return ports.exchangeOwner.verify(name);
          },
        },
      }),
      { authenticatingOperations: 2 },
    );
    const { cancellation, pending } = heldRequests(t, () => gate?.resolve());
    pending.push(
      g.resolve("a", undefined, cancellation.signal),
      g.resolve("b", undefined, cancellation.signal),
    );
    await Promise.race([filled.promise, ...pending]);
    assert.equal(verified, 2, "the configured budget is filled");
    assert.deepEqual(await g.resolve("c"), saturated, "the configured budget holds");
    assert.equal(verified, 2, "the excess request is never verified");
    gate.resolve();
    gate = undefined;
    assert.ok((await Promise.all(pending)).every((decision) => decision.kind === "ready"));
    assert.equal((await g.resolve("c")).kind, "ready");
  });

  test("configured replay bounds limit each Sandbox and the process", async (t) => {
    const f = await syntheticDispatchFixture(t);
    const s = f.sandboxes(undefined, { requestIds: 5, sandboxRequestIds: 3 });
    // Material was selected, so each ID stays reserved after its handle closes.
    const use = (name: string) => resolveThenClose(s, name);
    for (let i = 0; i < 3; i += 1) {
      assert.equal(await use("a"), "ready");
    }
    assert.deepEqual(await use("a"), saturated, "a Sandbox past its configured share");
    assert.equal(await use("b"), "ready");
    assert.equal(await use("b"), "ready");
    assert.deepEqual(await use("c"), saturated, "the configured table bound holds");
    f.advance(30_000);
    assert.equal(await use("c"), "ready", "expired IDs return both bounds");
    assert.equal(await use("a"), "ready");
  });

  test("an Installation's request capacity bounds the actual exchange and recovers on release", async (t) => {
    // Startup loads the operator's block, and the API compositions spread these options
    // into the controller unchanged; the fixture's controller takes the same value.
    const configuration = createCredentialProxyInstallationConfiguration();
    assert.ok("credential_proxy" in configuration.drivers);
    const proxyDriver = configuration.drivers.credential_proxy;
    assert.ok(typeof proxyDriver === "object" && proxyDriver !== null);
    Object.assign(proxyDriver, { requestCapacity: { sandboxOperations: 1 } });
    const directory = await temporaryDirectory(t, "oce-request-capacity-");
    const path = join(directory, "installation.yaml");
    await writeFile(path, JSON.stringify(configuration));
    const loaded = await loadInstallationConfiguration({
      mode: "development",
      environment: { OCC_CONFIG_PATH: path },
    });
    assert.ok(loaded);
    const { credentialProxyCapacity } = installationControllerOptions(loaded.installation);
    assert.ok(credentialProxyCapacity);
    assert.equal(credentialProxyCapacity.sandboxOperations, 1);
    const f = await staticEgressWireFixture(t, { credentialProxyCapacity });
    // The Sandbox's only operation slot is held by a ready handle on an open exchange.
    const held = await f.beginExchange();
    t.after(() => {
      held.stream.cancel();
    });
    held.stream.write(held.opening(f.capture()));
    const heldReply = await held.next();
    assert.equal(heldReply.event, "resolved");
    assert.ok(heldReply.resolved.ready, "the first request is ready");
    const reads = f.secretReads;
    const refused = await f.resolve(f.capture());
    assert.equal(refused.refused?.code, f.refusalCode("UNAVAILABLE"), JSON.stringify(refused));
    assert.equal(f.secretReads, reads, "a request past the configured share reads no Secret");
    // Closing the exchange releases its handle and with it the slot. The authority sees the
    // cancellation asynchronously, so the next request may briefly still be refused.
    held.stream.cancel();
    const deadline = Date.now() + 10_000;
    let next = await f.resolve(f.capture());
    while (!next.ready && Date.now() < deadline) {
      await setTimeout(50);
      next = await f.resolve(f.capture());
    }
    assert.ok(next.ready, `the released slot serves the next request: ${JSON.stringify(next)}`);
  });

  test("a request ID stays reserved once policy or Secret work can start", async (t) => {
    const f = await syntheticDispatchFixture(t);
    let checks = 0;
    let lookups = 0;
    let gate: PromiseWithResolvers<void> | undefined;
    const entered = Promise.withResolvers<void>();
    const lateGate = Promise.withResolvers<void>();
    const s = f.sandboxes((ports) => ({
      ...ports,
      async installation(peer) {
        lookups += 1;
        if (gate) {
          if (gate === lateGate) {
            entered.resolve();
          }
          await gate.promise;
        }
        return ports.installation(peer);
      },
      async check(use) {
        checks += 1;
        return checks === 1 ? { kind: "denied", code: "withdrawn" } : ports.check(use);
      },
    }));
    const replay = { kind: "refused", error: { kind: "denied", code: "invalid_handle" } };
    // A policy refusal is effectful: the ID cannot be used again in its window.
    const denied = s.request();
    assert.deepEqual(await s.resolve("a", denied), {
      kind: "refused",
      error: { kind: "denied", code: "withdrawn" },
    });
    assert.deepEqual(await s.resolve("a", denied), replay);
    assert.deepEqual([checks, lookups], [1, 1], "a known replay is refused before any lookup");
    const ready = s.request();
    assert.equal((await s.resolve("a", ready)).kind, "ready");
    assert.deepEqual(await s.resolve("a", ready), replay);
    // Concurrent duplicates both pass the early check; only one may reserve after the lookup.
    gate = Promise.withResolvers<void>();
    const duplicate = s.request();
    const { cancellation, pending } = heldRequests(t, () => gate?.resolve());
    const first = s.resolve("a", duplicate, cancellation.signal);
    const second = s.resolve("a", duplicate, cancellation.signal);
    pending.push(first, second);
    gate.resolve();
    const decisions = (await Promise.all([first, second])).map((decision) => decision.kind);
    assert.deepEqual(decisions.toSorted(), ["ready", "refused"]);
    assert.equal(lookups, 4, "both duplicates passed the early check");
    assert.equal(f.reads, 2);
    // A lookup that outlasts the deadline reserves nothing and starts no policy work.
    gate = lateGate;
    const late = s.resolve("a", undefined, cancellation.signal);
    pending.push(late);
    await Promise.race([entered.promise, late]);
    f.advance(30_000);
    gate.resolve();
    assert.deepEqual(await late, { kind: "refused", error: { kind: "deadline_exceeded" } });
    assert.equal(checks, 3);
  });
}

export function registerStaticEgressResponsesAndCapacityCases(
  unicodeEscapes: (text: string) => string,
): void {
  registerStaticEgressResponsesWireCases(unicodeEscapes);
  registerStaticEgressRequestCapacityCases();
}

export {
  runStaticEgressElapsedDeadlineCase,
  runStaticEgressReceiptCapacityCase,
} from "./static-egress-receipt-capacity-cases.ts";
export {
  runStaticEgressCredentialRejectionCase,
  runStaticEgressReceiptAuthorizationFailureCase,
  runStaticEgressReceiptRestartCase,
  runStaticEgressResponseCommitCase,
} from "./static-egress-receipt-persistence-cases.ts";
export { createReceiptPersistenceFaults } from "./static-egress-receipt-support.ts";
export { createStaticEgressAdmissionCases } from "./static-egress-admission-cases.ts";
