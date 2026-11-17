import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import type { OpenShellSandboxLogLine } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import {
  rememberCustodyContext,
  safeConnectedFailure,
} from "../helpers/egress-connected-failure.ts";
import { createRunEvidence } from "../helpers/egress-installed-stack.mjs";
import { isArray, isRecord, parseJson } from "../helpers/egress-observation-values.ts";
import { createCustodyTransitions } from "../helpers/egress-supplier-custody-transitions.mjs";

type FailureDiagnostic = Parameters<NonNullable<Parameters<typeof safeConnectedFailure>[2]>>[0];

async function createCustodyEvidence(t: TestContext) {
  const evidence = await createRunEvidence(t, { input: { images: {} }, controller: {} }, {});
  t.after(() => rm(evidence.directory, { recursive: true, force: true }));
  return evidence;
}

async function readLedgerFailure(directory: string) {
  const ledger = parseJson(await readFile(join(directory, "observations.json"), "utf8"));
  assert.ok(isRecord(ledger) && isRecord(ledger.failure), "expected a recorded custody failure");
  return ledger.failure;
}

// The scripted supplier replies drive the real observer and terminal diagnostics.
// A final read failure must retain prior evidence.
export async function verifyCustodyFailures(t: TestContext) {
  const marker = "PRIVATE-CUSTODY-DIAGNOSTIC-SENTINEL";
  const sandboxId = "10000000-0000-4000-8000-000000000001";
  const containerID = `containerd://${"a".repeat(64)}`;
  const supervisor = {
    metadata: {
      uid: "20000000-0000-4000-8000-000000000001",
      namespace: "workspace",
      labels: {
        "openshell.ai/sandbox-id": sandboxId,
        "openshell.ai/boundary-role": "supervisor",
      },
    },
    status: {
      containerStatuses: [{ containerID, restartCount: 0 }],
    },
  };
  const requestId = "aaaaaaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa";
  const line: OpenShellSandboxLogLine = {
    sandboxId,
    time: null,
    source: "sandbox",
    level: "INFO",
    target: "openshell_supervisor_network::l7::rest::credentials",
    message: "Protected response custody transition",
    fields: {
      request_id: requestId,
      response_custody_event: "resolve_accepted",
      private: marker,
    },
  };
  await t.test(
    "missing resolution preserves private correlation without accepting the refusal",
    async (t) => {
      const evidence = await createCustodyEvidence(t);
      let lines: OpenShellSandboxLogLine[] = [];
      const custody = createCustodyTransitions({
        workspace: "workspace",
        sandbox: "sandbox",
        sandboxId,
        supervisor,
        readSupervisor: async () => supervisor,
        gatewayClient: { getSandboxLogs: async () => ({ lines, bufferTotal: lines.length }) },
      });
      const before = await custody.snapshot();
      lines = ["no_permit", "response_blocked"].map((event) => ({
        ...line,
        fields: { ...line.fields, response_custody_event: event },
      }));
      await assert.rejects(
        async () => {
          try {
            await custody.expectAfter(before, ["resolve_refused", "no_permit", "response_blocked"]);
          } catch (error) {
            rememberCustodyContext(error, "fresh-iam-revoked", {
              outcome: "observed",
              since: "2026-01-01T00:00:00.000Z",
              raw: marker,
              gateways: [
                {
                  podUid: supervisor.metadata.uid,
                  containerId: containerID,
                  outcome: "observed",
                  total: 2,
                  events: [
                    {
                      sessionId: sandboxId,
                      at: "2026-01-01T00:00:01.000Z",
                      event: "inbound_eof",
                      raw: marker,
                    },
                    { sessionId: marker, at: "2026-01-01T00:00:01.000Z", event: "inbound_eof" },
                  ],
                },
              ],
            });
            const safe = await safeConnectedFailure(error, "turn-result", evidence.recordFailure);
            assert.equal(safe.message.includes(requestId), false);
            assert.equal(safe.message.includes(sandboxId), false);
            assert.equal(safe.message.includes(marker), false);
            throw safe;
          }
        },
        { message: /Connected egress assertion failed.*after-custody-observation/ },
      );
      const failure = await readLedgerFailure(evidence.directory);
      assert.ok(isRecord(failure.custodyEvidence), "expected private custody evidence");
      assert.deepEqual(
        failure.custodyEvidence.events,
        ["no_permit", "response_blocked"].map((event) => ({
          requestId,
          event,
        })),
      );
      assert.deepEqual(failure.custodyEvidence.expected, [
        "resolve_refused",
        "no_permit",
        "response_blocked",
      ]);
      assert.equal(failure.custodyEvidence.identityCheck, "matched");
      assert.equal(failure.custodyEvidence.uniqueRequest, true);
      assert.equal(failure.custodyEvidence.singleRequest, true);
      assert.equal(failure.custodyEvidence.ordered, false);
      const context = failure.custodyContext;
      assert.ok(
        isRecord(context) && isRecord(context.sessions),
        "expected custody session context",
      );
      assert.equal(context.turnPhase, "fresh-iam-revoked");
      assert.equal(context.sessions.requestSessionCorrelation, "unavailable");
      assert.ok(isArray(context.sessions.gateways), "expected observed Gateways");
      const [gateway] = context.sessions.gateways;
      assert.ok(isRecord(gateway) && isArray(gateway.events), "expected observed Gateway events");
      assert.equal(gateway.events.length, 1);
      assert.equal(JSON.stringify(failure).includes(marker), false);
      // A new baseline must not reuse the prior turn's private evidence.
      const next = await custody.snapshot();
      lines = [...lines, ...Array.from({ length: 12 }, () => line)];
      const retained: { failure?: FailureDiagnostic } = {};
      await assert.rejects(
        async () => {
          try {
            await custody.expectAfter(next, ["resolve_accepted"]);
          } catch (error) {
            throw await safeConnectedFailure(error, "next-turn", async (value) => {
              retained.failure = value;
            });
          }
        },
        { message: /Connected egress assertion failed.*after-custody-observation/ },
      );
      const second = retained.failure;
      assert.ok(second?.custody && second.custodyEvidence, "expected bounded custody evidence");
      assert.equal(second.custodyEvidence.events.length, 9);
      assert.equal(second.custodyEvidence.truncated, true);
      assert.equal(second.custody.freshCount, 12);
      assert.equal(second.custodyEvidence.uniqueRequest, false);
      assert.equal(second.custodyContext, undefined);
    },
  );
  await t.test("multiline failure messages cannot choose the reported source frame", async () => {
    const spoofed = "egress-supplier-custody-transitions.mjs:12345:1234";
    for (const kind of ["operation", "assertion"]) {
      const custody = createCustodyTransitions({
        workspace: "workspace",
        sandbox: "sandbox",
        sandboxId,
        supervisor,
        readSupervisor: async () => supervisor,
        gatewayClient: {
          async getSandboxLogs() {
            const message = marker + "\n    at /untrusted/" + spoofed;
            if (kind === "assertion") {
              assert.fail(message);
            }
            throw new Error(message);
          },
        },
      });
      let failure: unknown;
      try {
        await custody.snapshot();
      } catch (error) {
        failure = error;
      }
      assert.ok(failure instanceof Error);
      const safe = await safeConnectedFailure(failure, "turn-result");
      assert.match(safe.message, /egress-supplier-custody-transitions\.mjs:\d+:\d+/);
      assert.equal(safe.message.includes(spoofed), false);
      assert.equal(safe.message.includes(marker), false);
    }
    // A stack with no usable frame keeps the fixed fallback.
    assert.match(
      (await safeConnectedFailure(new Error(marker), "turn-result")).message,
      /\(external-operation\)/,
    );
  });

  await t.test("non-Error rejection stays unchanged", async () => {
    const custody = createCustodyTransitions({
      workspace: "workspace",
      sandbox: "sandbox",
      sandboxId,
      supervisor,
      readSupervisor: async () => {
        throw marker;
      },
      gatewayClient: {
        getSandboxLogs: async () => {
          throw new Error("unexpected log read");
        },
      },
    });
    await assert.rejects(custody.snapshot(), (error) => error === marker);
  });
  await t.test("diagnostic write failure does not prevent cleanup recording", async () => {
    const evidence = await createCustodyEvidence(t);
    // A failed atomic write must not replace the observer's original failure;
    // the next cleanup checkpoint still persists that failure from memory.
    await mkdir(join(evidence.directory, "observations.pending.json"));
    const custody = createCustodyTransitions({
      workspace: "workspace",
      sandbox: "sandbox",
      sandboxId,
      supervisor,
      readSupervisor: async () => {
        throw new Error(marker);
      },
      gatewayClient: {
        getSandboxLogs: async () => {
          throw new Error("unexpected log read");
        },
      },
    });
    await assert.rejects(
      async () => {
        try {
          await custody.snapshot();
        } catch (error) {
          const safe = await safeConnectedFailure(error, "turn-result", evidence.recordFailure);
          assert.equal(safe.message.includes(marker), false);
          assert.equal(safe.cause, undefined);
          throw safe;
        }
      },
      {
        message:
          /Connected egress operation failed at turn-result \/ before-custody-supervisor-get/,
      },
    );
    await rm(join(evidence.directory, "observations.pending.json"), { recursive: true });
    await evidence.checkpoint("cleanup");
    const failure = await readLedgerFailure(evidence.directory);
    assert.ok(isRecord(failure.custody), "expected a custody summary after cleanup");
    assert.equal(failure.operation, "before-custody-supervisor-get");
    assert.equal(failure.custody.readAttempts, 0);
    assert.equal(failure.custody.lastRead, "unobserved");
  });
  await t.test(
    "continuation retains the acknowledged prefix when its first read fails",
    async () => {
      let reads = 0;
      const custody = createCustodyTransitions({
        workspace: "workspace",
        sandbox: "sandbox",
        sandboxId,
        supervisor,
        readSupervisor: async () => supervisor,
        gatewayClient: {
          async getSandboxLogs() {
            reads++;
            if (reads === 1) {
              return { lines: [], bufferTotal: 0 };
            }
            if (reads === 2) {
              return {
                lines: [
                  line,
                  {
                    ...line,
                    fields: { ...line.fields, response_custody_event: "permit_accepted" },
                  },
                ],
                bufferTotal: 2,
              };
            }
            throw new Error(marker);
          },
        },
      });
      const before = await custody.snapshot();
      await custody.expectAfter(before, ["resolve_accepted", "permit_accepted"]);
      const retained: { failure?: FailureDiagnostic } = {};
      await assert.rejects(
        async () => {
          try {
            await custody.expectAfter(before, [
              "resolve_accepted",
              "permit_accepted",
              "response_released",
            ]);
          } catch (error) {
            throw await safeConnectedFailure(error, "turn-result", async (value) => {
              retained.failure = value;
            });
          }
        },
        { message: /Connected egress operation failed at turn-result \/ after-custody-log-read/ },
      );
      const recorded = retained.failure;
      assert.ok(recorded?.custody, "expected a custody summary after the failed read");
      assert.equal(recorded.custody.lastRead, "error");
      assert.equal(recorded.custody.ring, "valid");
      assert.equal(recorded.custody.freshCount, 2);
      assert.deepEqual(recorded.custody.labels, ["resolve_accepted", "permit_accepted"]);
      assert.equal(recorded.custody.sequence, "partial");
      assert.equal(JSON.stringify(recorded).includes(marker), false);
    },
  );
  for (const kind of ["empty", "partial", "ring", "malformed"] as const) {
    await t.test(kind, async () => {
      let reads = 0;
      const custody = createCustodyTransitions(
        {
          workspace: "workspace",
          sandbox: "sandbox",
          sandboxId,
          supervisor,
          readSupervisor: async () => supervisor,
          gatewayClient: {
            async getSandboxLogs(_request, signal) {
              reads++;
              if (reads === 1) {
                return { lines: [], bufferTotal: 0 };
              }
              if (reads === 2) {
                if (kind === "ring") {
                  return { lines: [line], bufferTotal: 2001 };
                }
                if (kind === "malformed") {
                  return {
                    lines: [
                      { ...line, fields: { ...line.fields, response_custody_event: marker } },
                    ],
                    bufferTotal: 1,
                  };
                }
                return {
                  lines: kind === "partial" ? [line] : [],
                  bufferTotal: kind === "partial" ? 1 : 0,
                };
              }
              try {
                await delay(10000, undefined, { signal });
              } catch {
                const reason: unknown = signal.reason;
                throw reason;
              }
              throw new Error("deadline did not abort the scripted read");
            },
          },
        },
        { deliveryTimeoutMs: 1000, pollIntervalMs: 1 },
      );
      const before = await custody.snapshot();
      const evidence = await createCustodyEvidence(t);
      await assert.rejects(
        async () => {
          try {
            await custody.expectAfter(before, [
              "resolve_accepted",
              "permit_accepted",
              "response_released",
            ]);
          } catch (error) {
            const safe = await safeConnectedFailure(error, "turn-result", evidence.recordFailure);
            assert.equal(safe.message.includes(requestId), false);
            assert.equal(safe.message.includes(marker), false);
            assert.equal(safe.cause, undefined);
            throw safe;
          }
        },
        {
          message:
            /Connected egress (?:assertion|operation) failed at turn-result \/ after-custody-log-read/,
        },
      );
      const recorded = await readLedgerFailure(evidence.directory);
      assert.ok(isRecord(recorded.custody), "expected a custody summary");
      await evidence.checkpoint("cleanup");
      assert.deepEqual(await readLedgerFailure(evidence.directory), recorded);
      assert.equal(recorded.custody.successfulReads, 2);
      assert.equal(recorded.custody.readAttempts, kind === "empty" || kind === "partial" ? 3 : 2);
      assert.equal(JSON.stringify(recorded).includes(marker), false);
      // Validated correlation belongs only to the private evidence, never the
      // terminal error or the counter-only custody summary.
      assert.equal(JSON.stringify(recorded.custody).includes(requestId), false);
      assert.equal(
        JSON.stringify(recorded.custodyEvidence ?? {}).includes(requestId),
        kind === "partial",
      );
      if (kind === "empty" || kind === "partial") {
        assert.equal(recorded.custody.lastRead, "deadline");
        assert.equal(recorded.custody.ring, "valid");
        assert.equal(recorded.custody.lineCount, kind === "partial" ? 1 : 0);
        assert.equal(recorded.custody.sequence, kind === "partial" ? "partial" : "none");
        assert.deepEqual(recorded.custody.labels, kind === "partial" ? ["resolve_accepted"] : []);
      } else {
        assert.equal(recorded.custody.lastRead, "returned");
        assert.equal(recorded.custody.ring, kind === "ring" ? "incomplete" : "invalid-transition");
        assert.equal(recorded.custody.sequence, "unobserved");
        assert.equal(recorded.custody.bufferTotal, kind === "ring" ? null : 1);
      }
    });
  }
}
