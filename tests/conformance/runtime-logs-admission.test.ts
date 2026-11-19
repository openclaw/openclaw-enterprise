import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import test from "node:test";

import type { ComputeDriver } from "../../packages/contracts/src/index.ts";
import { fetchLoopback } from "../helpers/console-fixture-transport.ts";
import { createRuntimeLogComputeDriver } from "../helpers/runtime-logs.ts";
import { registerRuntimeLogActiveDisconnectCases } from "./runtime-logs-active-disconnect-cases.ts";
import {
  assertRuntimeResponse,
  assertTimeoutResponse,
  createListeningFixture,
  type HandledResponse,
  within,
} from "./runtime-logs-admission-fixture.ts";

type ClosedResponse = {
  requestComplete: boolean;
  requestAborted: boolean;
  responseDestroyed: boolean;
  responseEnded: boolean;
  replySent: boolean;
};

function registerRuntimeLogIamDisconnectCases(): void {
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
            await fetchLoopback(url, {
              method: "GET",
              headers,
              signal: AbortSignal.timeout(5_000),
            }),
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
}

registerRuntimeLogIamDisconnectCases();
registerRuntimeLogActiveDisconnectCases();
