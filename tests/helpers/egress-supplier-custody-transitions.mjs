import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { openShellSandboxLogReader } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";

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

  async function sameSupervisor() {
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
  }

  async function read(timeoutMs) {
    const signal = AbortSignal.timeout(Math.min(timeoutMs, 5000));
    const { lines, bufferTotal } = await reader
      .getSandboxLogs({ workspace, sandbox, lines: ringSize }, signal)
      .catch((error) => {
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
    // No filter or time cursor. A full ring could have lost a prefix. Keep only
    // fingerprints of other lines so a rewrite or reset cannot silently move our baseline.
    assert.ok(
      bufferTotal === lines.length && bufferTotal < ringSize,
      "incomplete supplier log ring",
    );
    assert.ok(lines.length >= received.length, "supplier log prefix disappeared");
    const next = [];
    const additions = [];
    for (const [index, line] of lines.entries()) {
      assert.ok(line.sandboxId === sandboxId, "foreign Sandbox in selected supplier log");
      const { fields, ...metadata } = line;
      const fingerprint = createHash("sha256")
        .update(
          JSON.stringify([metadata, Object.entries(fields).sort(([a], [b]) => a.localeCompare(b))]),
        )
        .digest("hex");
      next.push(fingerprint);
      if (index < received.length) {
        assert.ok(fingerprint === received[index], "supplier log prefix changed");
      } else if (Object.hasOwn(fields, "response_custody_event") || line.message === message) {
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
    received = next;
    events = Object.freeze([...events, ...additions]);
  }

  return Object.freeze({
    async snapshot() {
      await sameSupervisor();
      await read(5000);
      await sameSupervisor();
      snapshots.add(events);
      return events;
    },

    // Only reread the log. A matching partial sequence may still be in flight;
    // a missing resolve, explicit no_permit, or terminal transition fails the test.
    // Reuse the original snapshot to follow an acknowledged pending operation to FIN.
    async expectAfter(before, expected) {
      assert.ok(
        snapshots.has(before) && expected.length > 0,
        "snapshot from this enrolled Sandbox",
      );
      await sameSupervisor();
      const deadline = performance.now() + deliveryTimeoutMs;
      while (performance.now() < deadline) {
        await read(Math.max(1, Math.ceil(deadline - performance.now())));
        const fresh = events.slice(before.length);
        const id = fresh[0]?.id;
        assert.ok(
          !id || !before.some((entry) => entry.id === id),
          "supplier reused an earlier request ID",
        );
        assert.ok(
          fresh.length <= expected.length &&
            fresh.every((entry, i) => entry.id === id && entry.event === expected[i]),
          "unexpected, missing, or ambiguous supplier custody transition",
        );
        if (fresh.length === expected.length) {
          await sameSupervisor();
          return id;
        }
        await setTimeout(Math.max(1, Math.min(pollIntervalMs, deadline - performance.now())));
      }
      assert.fail("required supplier custody transitions unobservable before delivery deadline");
    },
  });
}
