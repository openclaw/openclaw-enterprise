import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { RepositoryDeliveryPendingLog } from "../../apps/controller/src/composition/repository-credentials/transport.ts";
import {
  OPERATION_REFUSAL_HINT_CODES,
  operationRefusalHintCode,
} from "../../packages/occ/src/state/controller-work.ts";
import { AUTH_MAINTAIN_COMMANDS } from "../../scripts/lib/auth-maintain-arguments.ts";
import { occLogLine, unloggedFields } from "../helpers/occ-log-line.ts";
import { bindDeliveryTransport } from "./common-logging-delivery-fixture.ts";
import type { RepositoryTransportEmit } from "../../apps/controller/src/composition/repository-credentials/contracts.ts";

function refusedReconcile(): never {
  throw new Error("The gateway refused the reconcile.");
}

export function registerDeliveryCases(): void {
  test("logs keep OCC-assigned IDs, maintenance commands and guidance codes, never other shapes", async (t) => {
    // The shapes the bootstrap and auth:maintain scripts and the worker emit (finding 2245).
    // Fixed, because a random v4 UUID can be all digits and then its uppercase form equals itself.
    const installationId = "ins_3f9d2c4e-7a1b-4c5d-8e6f-0a1b2c3d4e5f";
    const configurationId = `cfg_${randomUUID()}`;
    const kept = [
      { event: "installation.bootstrapped", installationId },
      { event: "installation.already-bootstrapped", installationId, step: "fast-path" },
      { event: "auth-maintain.status", installationId },
      ...AUTH_MAINTAIN_COMMANDS.map((command) => ({
        event: "auth-maintain.failed",
        code: "AUTH_MAINTENANCE_FAILED",
        command,
      })),
      {
        event: "worker.completed",
        outcome: "permanent",
        code: "PROVISIONING_REJECTED",
        orphanedConfigurationId: configurationId,
      },
      ...Object.entries(OPERATION_REFUSAL_HINT_CODES).map(([code, hintCode]) => ({
        event: "worker.completed",
        outcome: "permanent",
        code,
        hintCode,
      })),
    ];
    for (const event of kept) {
      assert.deepEqual(unloggedFields(event), [], JSON.stringify(event));
    }
    // The guidance code names the gateway refusal's guidance; other refusals log none.
    assert.equal(
      operationRefusalHintCode("SANDBOX_GATEWAY_UNAUTHORIZED"),
      "sandbox-gateway-identity",
    );
    for (const code of ["SANDBOX_DELETION_UNCONFIRMED", "DEPENDENCY_UNAVAILABLE", "toString"]) {
      assert.equal(operationRefusalHintCode(code), undefined, code);
    }

    // The delivery-pending line names the protected Git Driver, which is the selected Sandbox
    // Driver, by the Sandbox Driver ID the log keeps.
    const events: Parameters<RepositoryTransportEmit>[0][] = [];
    const { binding } = await bindDeliveryTransport(t, refusedReconcile, (event) => {
      events.push(event);
    });
    try {
      // The failed reconcile starts during binding. Let it settle before closing the transport.
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      await binding.close();
    }
    const [pending] = events;
    assert.ok(pending);
    assert.deepEqual(pending, {
      event: "worker.repository-delivery-pending",
      sandboxDriverId: "openshell-sandbox",
    });
    assert.deepEqual(unloggedFields(pending), []);

    // An ID passes only in its own OCC-assigned format; a command or guidance code only as a short
    // identifier, never an argument, a path, a token shape or the guidance sentence itself.
    const rejected: ReadonlyArray<readonly [field: string, value: unknown]> = [
      ["installationId", "ins_production"],
      ["installationId", configurationId],
      ["installationId", installationId.replace(/[a-f]/g, (digit) => digit.toUpperCase())],
      ["installationId", `${installationId}\n`],
      ["installationId", ` ${installationId}`],
      ["installationId", { id: installationId }],
      ["orphanedConfigurationId", installationId],
      ["orphanedConfigurationId", "agent-config"],
      ["orphanedConfigurationId", `${configurationId}-extra`],
      ["orphanedConfigurationId", 7],
      ["command", "status --writers-stopped"],
      ["command", "reset-recovery-password /run/secrets/password"],
      ["command", "ghp_abcdefghijklmnopqrstuvwxyz0123"],
      ["command", `c${"x".repeat(64)}`],
      ["hintCode", "Check the controller gateway identity's token file, then deploy again."],
      ["hintCode", ["sandbox-gateway-identity"]],
    ];
    for (const [key, value] of rejected) {
      const line = occLogLine({ event: "auth-maintain.failed", code: "X", [key]: value });
      assert.equal(Object.hasOwn(line, key), false, `${key}: ${JSON.stringify(value)}`);
    }
    // A code-shaped command passes only on auth:maintain events, whose commands are a fixed list.
    for (const event of ["worker.completed", "http.completed", "auth-maintainer.failed"]) {
      assert.equal(
        Object.hasOwn(occLogLine({ event, command: "status" }), "command"),
        false,
        event,
      );
    }
  });

  test("a delivery that keeps failing logs when it starts pending, then at most once a minute", async (t) => {
    // Finding 2251: the reconcile retries every second, and every failed pass logged a line.
    // The loop runs on its own one-second timer, mocked here, and the log reads a fake clock.
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const now = { value: 5_000_000 };
    const events: Parameters<RepositoryTransportEmit>[0][] = [];
    let refuse = true;
    // Let the pass's reconcile settle and schedule the next one.
    const settle = async () => {
      for (let turn = 0; turn < 5; turn += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    };
    const pass = async () => {
      now.value += 1_000;
      t.mock.timers.tick(1_000);
      await settle();
    };
    const pendingLines = () =>
      events.filter(({ event }) => event === "worker.repository-delivery-pending").length;
    const reconcile = t.mock.fn(() => {
      if (refuse) {
        refusedReconcile();
      }
    });
    const { binding, closeSender } = await bindDeliveryTransport(
      t,
      reconcile,
      (event) => events.push(event),
      new RepositoryDeliveryPendingLog(() => now.value),
    );
    try {
      await settle();
      assert.equal(pendingLines(), 1, "the first failed pass logs");
      for (let second = 1; second < 60; second += 1) {
        await pass();
      }
      assert.equal(pendingLines(), 1, "a minute of failed passes logs once");
      await pass();
      assert.equal(pendingLines(), 2, "a delivery still pending a minute later logs again");
      refuse = false;
      await pass();
      refuse = true;
      await pass();
      assert.equal(pendingLines(), 3, "a failure after a completed pass logs at once");
      await pass();
      assert.equal(pendingLines(), 3);
      assert.deepEqual(events.at(-1), {
        event: "worker.repository-delivery-pending",
        sandboxDriverId: "openshell-sandbox",
      });
    } finally {
      await binding.close();
    }
    // Closing the transport releases the sender and cancels the scheduled retry.
    assert.equal(closeSender.mock.callCount(), 1);
    const passes = reconcile.mock.callCount();
    await pass();
    assert.equal(reconcile.mock.callCount(), passes);
  });
}
