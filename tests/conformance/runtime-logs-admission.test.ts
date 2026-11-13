import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { Socket } from "node:net";
import test from "node:test";

import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import type { AgentRuntimeLogRequest, ComputeDriver } from "../../packages/contracts/src/index.ts";
import { authenticatedHeaders } from "../helpers/auth-session.mjs";
import { fetchLoopback } from "../helpers/console-fixture-transport.ts";
import { createRuntimeLogComputeDriver, createRuntimeLogFixture } from "../helpers/runtime-logs.ts";

const publicOrigin = "https://console.oce.localhost";

type RuntimeRoute = "logs" | "status";
type ClosedResponse = {
  requestComplete: boolean;
  requestAborted: boolean;
  responseDestroyed: boolean;
  responseEnded: boolean;
  replySent: boolean;
};
type HandledResponse = { statusCode: number; payload: unknown };

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function assertTimeoutResponse(response: HandledResponse): void {
  assert.equal(response.statusCode, 504);
  assert.ok(typeof response.payload === "string");
  const payload: unknown = JSON.parse(response.payload);
  assert.equal(record(record(payload).error).code, "RUNTIME_LOGS_TIMEOUT");
}

async function assertRuntimeResponse(
  response: Response,
  revisionId: string,
  route: RuntimeRoute,
): Promise<void> {
  assert.equal(response.status, 200);
  const payload: unknown = await response.json();
  const data = record(record(payload).data);
  assert.equal(data.revisionId, revisionId);
  if (route === "logs") {
    assert.equal(data.source, "gateway");
    assert.ok(Array.isArray(data.records));
  } else {
    assert.ok(Array.isArray(data.pods));
    assert.ok(Array.isArray(data.sources));
  }
}

async function createListeningFixture(compute: ComputeDriver) {
  const fixture = await createRuntimeLogFixture({ computeDriver: compute });
  const target = await fixture.deployAgent("runtime-log-disconnect");
  const iam = fixture.controller.selectedDriver("iam");
  const app = createFastifyApp({
    controller: fixture.controller,
    iamDriver: iam,
    computeDriver: compute,
    auth: fixture.admin.auth,
    auditSink: fixture.auditSink,
    resolveHarness: resolveApprovedHarness,
    development: {
      enabled: true,
      installationId: fixture.controller.installation.id,
      browserOrigin: publicOrigin,
    },
    agentRuntimeLogs: {
      enabled: true,
      cursorSecret: `runtime-log-disconnect-${randomUUID()}`,
    },
  });
  const sockets = new Set<Socket>();
  app.server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  return {
    fixture,
    target,
    iam,
    app,
    headers: authenticatedHeaders(fixture.adminSession, {
      host: new URL(publicOrigin).host,
      origin: publicOrigin,
    }),
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await within(app.close(), "Controller listener cleanup");
      assert.equal(app.server.listening, false);
    },
  };
}

// The Compute fixture supplies cluster observations only. Authentication, authorization,
// admission, response handling, and cancellation all run through the real TCP HTTP route.
for (const route of ["logs", "status"] as const) {
  test(
    `Agent runtime ${route} requests cancel when the response closes during IAM lookup`,
    { timeout: 30_000 },
    async (context) => {
      type Phase = "setup" | "normal" | "early" | "later";
      let phase: Phase = "setup";
      let earlyResponse: ServerResponse | undefined;
      const calls: Array<{
        phase: Phase;
        operation: "describe" | "read";
        signal: AbortSignal;
        abortedOnEntry: boolean;
        responseDestroyed: boolean | undefined;
      }> = [];
      const compute: ComputeDriver = createRuntimeLogComputeDriver();
      assert.ok(compute.describeAgentRuntime);
      assert.ok(compute.readAgentRuntimeLogs);
      const describe = compute.describeAgentRuntime.bind(compute);
      const read = compute.readAgentRuntimeLogs.bind(compute);
      const observe = (operation: "describe" | "read", signal: AbortSignal) => {
        calls.push({
          phase,
          operation,
          signal,
          abortedOnEntry: signal.aborted,
          responseDestroyed: phase === "early" ? earlyResponse?.destroyed : undefined,
        });
        // Model a Driver that honors the supplied cancellation signal before doing I/O.
        signal.throwIfAborted();
      };
      compute.describeAgentRuntime = async (...args) => {
        observe("describe", args[1]);
        return describe(...args);
      };
      compute.readAgentRuntimeLogs = async (...args) => {
        observe("read", args[1].signal);
        return read(...args);
      };

      const running = await createListeningFixture(compute);
      const { app, fixture, target, iam, headers } = running;
      const path = route === "logs" ? target.logsPath() : target.runtimePath;
      const lookupEntered = Promise.withResolvers<void>();
      const lookupReleased = Promise.withResolvers<void>();
      const identityResolved = Promise.withResolvers<string | undefined>();
      const normalClosed = Promise.withResolvers<boolean>();
      const earlyClosed = Promise.withResolvers<ClosedResponse>();
      const earlyHandled = Promise.withResolvers<HandledResponse>();
      const clientAbort = new AbortController();
      let holdNextLookup = false;
      let earlyRequestId: string | undefined;
      const lookupIdentity = iam.lookupIdentity.bind(iam);
      context.after(async () => {
        lookupReleased.resolve();
        clientAbort.abort();
        iam.lookupIdentity = lookupIdentity;
        compute.describeAgentRuntime = describe;
        compute.readAgentRuntimeLogs = read;
        await running.close();
      });
      iam.lookupIdentity = async (input) => {
        if (!holdNextLookup) {
          return lookupIdentity(input);
        }
        holdNextLookup = false;
        lookupEntered.resolve();
        await within(lookupReleased.promise, "held IAM lookup release");
        const identity = await lookupIdentity(input);
        identityResolved.resolve(identity?.id);
        return identity;
      };
      app.addHook("preHandler", async (request, reply) => {
        if (request.method !== "GET" || request.url !== path) {
          return;
        }
        if (phase === "normal") {
          reply.raw.once("close", () => normalClosed.resolve(reply.raw.writableEnded));
        } else if (phase === "early" && earlyRequestId === undefined) {
          earlyRequestId = request.id;
          earlyResponse = reply.raw;
          holdNextLookup = true;
          reply.raw.once("close", () => {
            earlyClosed.resolve({
              requestComplete: request.raw.complete,
              requestAborted: request.raw.aborted,
              responseDestroyed: reply.raw.destroyed,
              responseEnded: reply.raw.writableEnded,
              replySent: reply.sent,
            });
          });
        }
      });
      app.addHook("onSend", async (request, reply, payload) => {
        if (request.id === earlyRequestId) {
          earlyHandled.resolve({ statusCode: reply.statusCode, payload });
        }
        return payload;
      });
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      const url = new URL(path, address).href;
      const connectedRead = async (next: "normal" | "later") => {
        phase = next;
        await assertRuntimeResponse(
          await fetchLoopback(url, { method: "GET", headers, signal: AbortSignal.timeout(5_000) }),
          target.revisionId,
          route,
        );
        const selected = calls.filter((call) => call.phase === next);
        assert.deepEqual(
          selected.map((call) => call.operation),
          route === "logs" ? ["describe", "read"] : ["describe"],
        );
        assert.ok(selected.every((call) => !call.abortedOnEntry && !call.signal.aborted));
      };

      await connectedRead("normal");
      assert.equal(await within(normalClosed.promise, "completed response close"), true);
      assert.ok(
        calls.filter((call) => call.phase === "normal").every((call) => !call.signal.aborted),
      );

      phase = "early";
      const earlyOutcome = fetchLoopback(url, {
        method: "GET",
        headers,
        signal: clientAbort.signal,
      }).then(
        () => "unexpected-response",
        (error: unknown) => (error instanceof Error ? error.name : "non-error"),
      );
      await within(lookupEntered.promise, "IAM lookup entry");
      assert.equal(calls.filter((call) => call.phase === "early").length, 0);
      clientAbort.abort();
      assert.equal(await within(earlyOutcome, "early client abort"), "AbortError");
      const closed = await within(earlyClosed.promise, "early server response close");
      assert.equal(closed.requestComplete, true);
      assert.equal(closed.responseDestroyed, true);
      assert.equal(closed.responseEnded, false);
      assert.equal(closed.replySent, false);
      assert.ok(closed.requestAborted || closed.responseDestroyed);

      // IAM still resolves the real admitted identity, after the close event has fired.
      // The original handler missed that event and started live Compute reads here.
      lookupReleased.resolve();
      assert.equal(
        await within(identityResolved.promise, "real IAM identity"),
        fixture.admin.seed.principal.id,
      );
      const handled = await within(earlyHandled.promise, "early handler completion");
      const earlyCalls = calls.filter((call) => call.phase === "early");
      assert.ok(earlyCalls.every((call) => call.responseDestroyed === true));
      assert.deepEqual(
        earlyCalls.filter((call) => !call.abortedOnEntry).map((call) => call.operation),
        [],
        "a destroyed response must not start live Driver I/O",
      );
      assertTimeoutResponse(handled);
      await connectedRead("later");
    },
  );
}

test(
  "Agent runtime log disconnects cancel active I/O and release shared read permits",
  { timeout: 45_000 },
  async (context) => {
    let phase: "setup" | "late" | "later" | "permits" = "setup";
    const lateEntered = Promise.withResolvers<AgentRuntimeLogRequest>();
    const lateAborted = Promise.withResolvers<AgentRuntimeLogRequest>();
    const lateClosed = Promise.withResolvers<boolean>();
    const lateHandled = Promise.withResolvers<HandledResponse>();
    const permitsEntered = Promise.withResolvers<void>();
    const permitsReleased = Promise.withResolvers<void>();
    const permitSignals: AbortSignal[] = [];
    const clientAbort = new AbortController();
    const cleanupAbort = new AbortController();
    const compute: ComputeDriver = createRuntimeLogComputeDriver();
    assert.ok(compute.describeAgentRuntime);
    assert.ok(compute.readAgentRuntimeLogs);
    const describe = compute.describeAgentRuntime.bind(compute);
    const read = compute.readAgentRuntimeLogs.bind(compute);
    compute.describeAgentRuntime = async (...args) => {
      const signal = args[1];
      if (phase === "permits") {
        permitSignals.push(signal);
        if (permitSignals.length === 16) {
          permitsEntered.resolve();
        }
        await within(permitsReleased.promise, "shared permit release");
      }
      signal.throwIfAborted();
      return describe(...args);
    };
    compute.readAgentRuntimeLogs = async (...args) => {
      const request = args[1];
      if (phase === "late") {
        const onAbort = () => lateAborted.resolve(request);
        request.signal.addEventListener("abort", onAbort, { once: true });
        try {
          lateEntered.resolve(request);
          if (request.signal.aborted) {
            onAbort();
          }
          await within(lateAborted.promise, "active Driver cancellation");
        } finally {
          request.signal.removeEventListener("abort", onAbort);
        }
      }
      request.signal.throwIfAborted();
      return read(...args);
    };
    const running = await createListeningFixture(compute);
    const { app, fixture, target, headers } = running;
    let lateRequestId: string | undefined;
    context.after(async () => {
      permitsReleased.resolve();
      clientAbort.abort();
      cleanupAbort.abort();
      compute.describeAgentRuntime = describe;
      compute.readAgentRuntimeLogs = read;
      await running.close();
    });
    app.addHook("preHandler", async (request, reply) => {
      if (phase === "late" && request.method === "GET" && request.url === target.logsPath()) {
        lateRequestId = request.id;
        reply.raw.once("close", () => {
          lateClosed.resolve(reply.raw.destroyed && !reply.raw.writableEnded);
        });
      }
    });
    app.addHook("onSend", async (request, reply, payload) => {
      if (request.id === lateRequestId) {
        lateHandled.resolve({ statusCode: reply.statusCode, payload });
      }
      return payload;
    });
    const sibling = await fixture.deployAgent("permit-control", { namespace: target.namespace });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const url = new URL(target.logsPath(), address).href;
    phase = "late";
    const lateOutcome = fetchLoopback(url, {
      method: "GET",
      headers,
      signal: clientAbort.signal,
    }).then(
      () => "unexpected-response",
      (error: unknown) => (error instanceof Error ? error.name : "non-error"),
    );
    const entered = await within(lateEntered.promise, "active Driver read");
    assert.equal(entered.signal.aborted, false);
    clientAbort.abort();
    assert.equal(await within(lateOutcome, "late client abort"), "AbortError");
    assert.equal(await within(lateAborted.promise, "Driver abort observation"), entered);
    assert.equal(entered.signal.aborted, true);
    const reason: unknown = entered.signal.reason;
    assert.ok(reason instanceof Error);
    assert.equal(reason.name, "AbortError");
    assert.equal(await within(lateClosed.promise, "late response close"), true);
    assertTimeoutResponse(await within(lateHandled.promise, "late handler completion"));

    phase = "later";
    await assertRuntimeResponse(
      await fetchLoopback(url, { method: "GET", headers, signal: AbortSignal.timeout(5_000) }),
      target.revisionId,
      "logs",
    );

    // Occupy all 16 existing replica-local permits after cancellation. Two Agent keys keep
    // this control within the per-principal/per-Agent burst, and a status read shares the pool.
    // A leaked permit would leave at least one request unable to reach Compute.
    phase = "permits";
    const requests = [target, sibling].flatMap((selected) =>
      Array.from({ length: 8 }, (_, index): { target: typeof target; route: RuntimeRoute } => ({
        target: selected,
        route: selected === target && index === 0 ? "status" : "logs",
      })),
    );
    const results = Promise.allSettled(
      requests.map(async ({ target: selected, route }) => {
        const path = route === "status" ? selected.runtimePath : selected.logsPath();
        await assertRuntimeResponse(
          await fetchLoopback(new URL(path, address).href, {
            method: "GET",
            headers,
            signal: AbortSignal.any([cleanupAbort.signal, AbortSignal.timeout(8_000)]),
          }),
          selected.revisionId,
          route,
        );
      }),
    );
    await within(permitsEntered.promise, "all shared read permits");
    assert.equal(permitSignals.length, 16);
    assert.ok(permitSignals.every((signal) => !signal.aborted));
    permitsReleased.resolve();
    for (const result of await within(results, "shared permit requests")) {
      if (result.status === "rejected") {
        const reason: unknown = result.reason;
        throw reason;
      }
    }
  },
);
