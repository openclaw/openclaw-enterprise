import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  OPERATION_REFUSAL_HINT_CODES,
  operationRefusalHintCode,
} from "../../packages/occ/src/deployment-work-status.ts";
import { AUTH_MAINTAIN_COMMANDS } from "../../scripts/lib/auth-maintain-arguments.ts";
import { occLogLine, unloggedFields } from "../helpers/occ-log-line.ts";

export function registerDeliveryCases(): void {
  test("logs keep OCC-assigned IDs, maintenance commands and guidance codes, never other shapes", () => {
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
}
