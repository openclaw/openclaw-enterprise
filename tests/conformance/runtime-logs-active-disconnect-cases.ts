import assert from "node:assert/strict";
import test from "node:test";

import type { AgentRuntimeLogRequest, ComputeDriver } from "../../packages/contracts/src/index.ts";
import { fetchLoopback } from "../helpers/console-fixture-transport.ts";
import { createRuntimeLogComputeDriver } from "../helpers/runtime-logs.ts";
import {
  assertRuntimeResponse,
  assertTimeoutResponse,
  createListeningFixture,
  type HandledResponse,
  type RuntimeRoute,
  within,
} from "./runtime-logs-admission-fixture.ts";

export function registerRuntimeLogActiveDisconnectCases(): void {
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
}
