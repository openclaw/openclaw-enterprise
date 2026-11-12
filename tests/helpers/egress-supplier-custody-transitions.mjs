import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { openShellSandboxLogReader } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";

import { observeConnectedOperation, rememberCustodyOutcome } from "./egress-connected-failure.mjs";

const ringSize = 2000;
const target = "openshell_supervisor_network::l7::rest::credentials";
const message = "Protected response custody transition";
const requestId = /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const transitions = new Set([
  "resolve_accepted",
  "resolve_no_material_accepted",
  "resolve_refused",
  "permit_accepted",
  "permit_no_material_accepted",
  "no_permit",
  "response_released",
  "response_blocked",
  "response_delivery_incomplete",
]);

/**
 * Observe one enrolled supplier Sandbox while it still exists. The supervisor's
 * LogPushLayer preserves tracing fields; its console shorthand does not. The
 * gateway binds pushed source and sandbox ID at ingestion, but push is best effort.
 * This is test evidence to join with the receipt and origin, never send authority.
 */
export function createCustodyTransitions(
  { gatewayClient, workspace, sandbox, sandboxId, supervisor, readSupervisor },
  { deliveryTimeoutMs = 20_000, pollIntervalMs = 400 } = {},
) {
  const reader = openShellSandboxLogReader(gatewayClient);
  const { uid } = supervisor.metadata;
  const containerId = supervisor.status.containerStatuses[0].containerID;
  assert.ok(workspace && sandbox && sandboxId && uid && containerId, "enrolled supplier identity");
  const snapshots = new WeakSet();
  let received = [];
  let events = [];
  const diagnostic = {
    readAttempts: 0,
    successfulReads: 0,
    lastRead: "unobserved",
    ring: "unobserved",
    lineCount: null,
    bufferTotal: null,
    freshCount: null,
    labels: [],
    sequence: "unobserved",
    evidence: null,
  };
  let identityCheck = "unobserved";
  function describeSequence(before, expected) {
    const fresh = events.slice(before.length);
    const id = fresh[0]?.id;
    const unique = !id || !before.some((entry) => entry.id === id);
    const ordered =
      fresh.length <= expected.length &&
      fresh.every((entry, i) => entry.id === id && entry.event === expected[i]);
    diagnostic.freshCount = fresh.length;
    diagnostic.labels = fresh.map(({ event }) => event).slice(0, 9);
    diagnostic.evidence = {
      sandboxId,
      supervisorUid: uid,
      containerId,
      identityCheck,
      expected,
      events: fresh.slice(0, 9).map(({ id, event }) => ({ requestId: id, event })),
      truncated: fresh.length > 9,
      uniqueRequest: unique,
      singleRequest: fresh.every((entry) => entry.id === id),
      ordered,
    };
    if (!unique || !ordered) {
      diagnostic.sequence = "invalid";
    } else if (fresh.length === expected.length) {
      diagnostic.sequence = "complete";
    } else {
      diagnostic.sequence = fresh.length ? "partial" : "none";
    }
    return { fresh, id, unique, ordered };
  }
  async function diagnose(action) {
    try {
      return await action();
    } catch (error) {
      throw rememberCustodyOutcome(error, diagnostic);
    }
  }

  async function sameSupervisor() {
    identityCheck = "pending";
    try {
      const { metadata, status } = await readSupervisor();
      assert.equal(metadata.uid, uid, "selected supervisor UID changed");
      assert.equal(metadata.namespace, workspace, "selected supervisor workspace");
      assert.equal(metadata.deletionTimestamp, undefined, "selected supervisor is retiring");
      assert.equal(metadata.labels["openshell.ai/sandbox-id"], sandboxId);
      assert.equal(metadata.labels["openshell.ai/boundary-role"], "supervisor");
      const [container, ...others] = status.containerStatuses;
      assert.equal(others.length, 0, "one selected supervisor container");
      assert.equal(container.restartCount, 0, "selected supervisor restarted");
      assert.equal(container.containerID, containerId, "selected supervisor container changed");
      identityCheck = "matched";
    } catch (error) {
      identityCheck = "failed";
      throw error;
    } finally {
      if (diagnostic.evidence) {
        diagnostic.evidence.identityCheck = identityCheck;
      }
    }
  }

  async function read(timeoutMs) {
    diagnostic.readAttempts++;
    diagnostic.lastRead = "pending";
    const signal = AbortSignal.timeout(Math.min(timeoutMs, 5000));
    const { lines, bufferTotal } = await reader
      .getSandboxLogs({ workspace, sandbox, lines: ringSize }, signal)
      .catch((error) => {
        diagnostic.lastRead = signal.aborted && error === signal.reason ? "deadline" : "error";
        // The final in-flight read can reach our deadline before the poll loop does.
        // Preserve the actual read timeout; neither deadline path means no_permit.
        if (signal.aborted && error === signal.reason) {
          throw new Error(
            "supplier custody transitions unobservable before delivery deadline (GetSandboxLogs read timed out)",
            { cause: error },
          );
        }
        throw error;
      });
    diagnostic.successfulReads++;
    diagnostic.lastRead = "returned";
    diagnostic.lineCount = lines.length;
    diagnostic.bufferTotal = bufferTotal;
    diagnostic.ring = "incomplete";
    // No filter or time cursor. A full ring could have lost a prefix. Keep only
    // fingerprints of other lines so a rewrite or reset cannot silently move our baseline.
    assert.ok(
      bufferTotal === lines.length && bufferTotal < ringSize,
      "incomplete supplier log ring",
    );
    diagnostic.ring = "prefix-disappeared";
    assert.ok(lines.length >= received.length, "supplier log prefix disappeared");
    const next = [];
    const additions = [];
    for (const [index, line] of lines.entries()) {
      diagnostic.ring = "foreign-sandbox";
      assert.ok(line.sandboxId === sandboxId, "foreign Sandbox in selected supplier log");
      const { fields, ...metadata } = line;
      const fingerprint = createHash("sha256")
        .update(
          JSON.stringify([metadata, Object.entries(fields).sort(([a], [b]) => a.localeCompare(b))]),
        )
        .digest("hex");
      next.push(fingerprint);
      if (index < received.length) {
        diagnostic.ring = "prefix-changed";
        assert.ok(fingerprint === received[index], "supplier log prefix changed");
      } else if (Object.hasOwn(fields, "response_custody_event") || line.message === message) {
        diagnostic.ring = "invalid-transition";
        const { request_id: id, response_custody_event: event } = fields;
        assert.ok(
          line.source === "sandbox" &&
            line.level === "INFO" &&
            line.target === target &&
            line.message === message,
          "custody transition was not the selected supervisor INFO event",
        );
        assert.ok(
          requestId.test(id) && transitions.has(event),
          "malformed supplier custody transition",
        );
        additions.push(Object.freeze({ event, id }));
      }
    }
    diagnostic.ring = "valid";
    received = next;
    events = Object.freeze([...events, ...additions]);
  }

  return Object.freeze({
    async snapshot() {
      diagnostic.freshCount = null;
      diagnostic.labels = [];
      diagnostic.sequence = "unobserved";
      diagnostic.evidence = null;
      return diagnose(async () => {
        await observeConnectedOperation("before-custody-supervisor-get", sameSupervisor);
        await observeConnectedOperation("before-custody-log-read", () => read(5000));
        await observeConnectedOperation("before-custody-supervisor-recheck", sameSupervisor);
        snapshots.add(events);
        return events;
      });
    },

    // Only reread the log. A matching partial sequence may still be in flight;
    // a missing resolve, explicit no_permit, or terminal transition fails the test.
    // Reuse the original snapshot to follow an acknowledged pending operation to FIN.
    async expectAfter(before, expected) {
      diagnostic.freshCount = null;
      diagnostic.labels = [];
      diagnostic.sequence = "unobserved";
      diagnostic.evidence = null;
      return diagnose(() =>
        observeConnectedOperation("after-custody-observation", async () => {
          assert.ok(
            snapshots.has(before) && expected.length > 0,
            "snapshot from this enrolled Sandbox",
          );
          // Reusing a baseline after a pending response must retain the known
          // prefix even when the next log read fails before returning a ring.
          if (events !== before) {
            describeSequence(before, expected);
          }
          await observeConnectedOperation("after-custody-supervisor-get", sameSupervisor);
          const deadline = performance.now() + deliveryTimeoutMs;
          while (performance.now() < deadline) {
            await observeConnectedOperation("after-custody-log-read", () =>
              read(Math.max(1, Math.ceil(deadline - performance.now()))),
            );
            const { fresh, id, unique, ordered } = describeSequence(before, expected);
            assert.ok(unique, "supplier reused an earlier request ID");
            assert.ok(ordered, "unexpected, missing, or ambiguous supplier custody transition");
            if (fresh.length === expected.length) {
              await observeConnectedOperation("after-custody-supervisor-recheck", sameSupervisor);
              return id;
            }
            await setTimeout(Math.max(1, Math.min(pollIntervalMs, deadline - performance.now())));
          }
          assert.fail(
            "required supplier custody transitions unobservable before delivery deadline",
          );
        }),
      );
    },
  });
}
