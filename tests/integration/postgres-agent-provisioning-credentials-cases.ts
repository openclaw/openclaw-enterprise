import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { AgentProvisioningResponse } from "../../packages/contracts/src/api/resources.ts";
import type { ControllerWorkState } from "../../packages/occ/src/index.ts";
import {
  createProvisioningConfigurationDriver,
  required,
} from "./postgres-agent-provisioning-setup.ts";

import { assertApiError } from "../helpers/api-error.ts";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { PROVISIONING_NOT_COMPLETED } from "../helpers/refusal-text.mjs";
import { waitFor } from "../helpers/wait-for.ts";

import {
  claimProvisioningWork,
  createFixture,
  createNamespaceSecret,
  createProvisioningSecrets,
  provisioningBody,
  provisioningError,
  provisioningRow,
} from "./postgres-agent-provisioning-setup.ts";

export function registerCredentialCases() {
  test(
    "a retained legacy proxy provisioning plan refuses status and retry with recovery guidance",
    { ...requiresPostgres, timeout: 60_000 },
    async (context) => {
      const fixture = await createFixture(context);
      const namespace = await fixture.bootstrapNamespace();
      const actorId = await fixture.administratorPrincipalId();
      const workId = `agent-provisioning:${randomUUID().replaceAll("-", "")}`;
      const proxySecret = await createNamespaceSecret(
        fixture,
        namespace.id,
        "legacy-proxy-authorization",
        `Basic ${Buffer.from(`synthetic:${randomUUID()}`).toString("base64")}`,
      );
      // Reproduce the immutable plan shape saved by the old release. By upgrade time the
      // failed job is retained for status, but it cannot be executed using its legacy selection.
      await fixture.state.transact((unit) =>
        unit.provisioning.create({
          workId,
          namespaceId: namespace.id,
          actorId,
          requestId: randomUUID(),
          requestFingerprint: "0".repeat(64),
          plan: {
            name: "legacy-proxy-provisioning",
            configuration: { kind: "agent", values: {} },
            harnessAuth: { method: "runtime" },
            executionMode: "dedicated",
            gatewayManagedMode: true,
            networkProxy: { url: "https://proxy.example:8443", credentialSecretId: proxySecret.id },
            drivers: {
              compute: fixture.computeDriver.id,
              configuration: fixture.configurationDriver.id,
              iam: "native-iam",
            },
          },
        }),
      );
      const claim = await claimProvisioningWork(fixture.pool, workId);
      const failure = { code: "PROVISIONING_REJECTED", message: PROVISIONING_NOT_COMPLETED };
      await fixture.state.transact((unit) =>
        unit.provisioning.recordFailure(
          claim,
          { completedPhase: "admitted", progress: { error: failure } },
          { disposition: "permanent", ...failure },
        ),
      );
      const path = `/namespaces/${namespace.id}/agents/provision/${workId}`;
      for (const result of [
        await fixture.request("GET", path),
        await fixture.request("POST", `${path}/retry`),
      ]) {
        assertApiError(result, 409, "RESOURCE_CONFLICT");
        assert.match(
          provisioningError(result).message ?? "",
          /Submit a new Agent provisioning request\./,
        );
      }
    },
  );

  test(
    "provisioning worker reauthorizes after admission and revoked authority creates no backend effects",
    { ...requiresPostgres, timeout: 60_000 },
    async (context) => {
      const configurationDriver = createProvisioningConfigurationDriver({
        id: "configuration-provisioning",
      });
      const fixture = await createFixture(context, { configurationDriver });
      const namespace = await fixture.bootstrapNamespace();
      const body = provisioningBody(
        namespace.id,
        await createProvisioningSecrets(fixture, namespace.id),
      );
      const admitted = await fixture.requestChecked(
        AgentProvisioningResponse,
        "POST",
        `/namespaces/${namespace.id}/agents/provision`,
        {
          body,
        },
      );
      assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
      const callsBeforeRevocation = structuredClone(fixture.secretDriver.calls);
      const runtimeCallsBeforeRevocation = structuredClone(fixture.computeDriver.calls);
      const externalOperations = (["createExact", "inspectExact"] as const).map((method) =>
        context.mock.method(configurationDriver, method),
      );
      await fixture.revokeCurrentPrincipal();
      await fixture.startWorker();
      const work = await waitFor(
        "provisioning work to fail after authority revocation",
        async () => {
          const observed = await fixture.pool.query<{
            state: ControllerWorkState;
            reason_code: string | null;
          }>(
            "SELECT state, reason_code FROM occ.controller_work WHERE work_kind = 'provisioning' AND namespace_id = $1 AND idempotency_key = $2",
            [namespace.id, admitted.data.provisioning.workId],
          );
          assert.equal(observed.rowCount, 1);
          return required(observed.rows[0]).state === "failed_permanent"
            ? observed.rows[0]
            : undefined;
        },
      );
      await fixture.stopWorker();
      assert.equal(work.reason_code, "PROVISIONING_REJECTED");
      // Only duplicate-name, plugin-policy and runtime-image refusals reach the status read; the
      // error recorded for this authorization denial keeps its own message internal.
      const job = await fixture.pool.query<{ error: unknown }>(
        "SELECT progress->'error' AS error FROM occ.agent_provisioning_work WHERE work_id = $1",
        [admitted.data.provisioning.workId],
      );
      assert.deepEqual(job.rows, [
        {
          error: {
            code: "PROVISIONING_REJECTED",
            message: PROVISIONING_NOT_COMPLETED,
          },
        },
      ]);
      const denialAudit = await fixture.pool.query<{
        kind: string;
        outcome: string;
        reason_code: string | null;
      }>(
        `SELECT kind, outcome, details->'__occAuditMetadata'->>'reasonCode' AS reason_code
       FROM occ.audit_events
       WHERE namespace_id = $1
         AND resource_kind = 'agent'
         AND resource_id = $2
         AND action = 'openclaw.agents.provision.failure'
         AND kind = 'authorization_denial'`,
        [namespace.id, admitted.data.provisioning.workId],
      );
      assert.deepEqual(denialAudit.rows, [
        {
          kind: "authorization_denial",
          outcome: "denied",
          reason_code: "AUTHORIZATION_DENIED",
        },
      ]);
      assert.deepEqual(
        fixture.secretDriver.calls,
        callsBeforeRevocation,
        "revoked initiating authority must not perform further Secret backend operations",
      );
      assert.deepEqual(
        fixture.computeDriver.calls,
        runtimeCallsBeforeRevocation,
        "revoked authority must not perform runtime operations",
      );
      for (const operation of externalOperations) {
        assert.equal(operation.mock.callCount(), 0, "revoked authority must not contact a backend");
      }
      const record = await provisioningRow(fixture.pool, namespace.id, body.requestId);
      assert.equal(record.completed_phase, "admitted");
      assert.equal(record.agent_id, null);
      assert.equal(record.configuration_id, null);
      const resources = await fixture.pool.query<{
        agents: number;
        configurations: number;
        revisions: number;
        secrets: number;
        source_grants: number;
      }>(
        `SELECT
       (SELECT count(*)::integer FROM occ.agents WHERE namespace_id = $1) AS agents,
       (SELECT count(*)::integer FROM occ.configurations WHERE namespace_id = $1) AS configurations,
       (SELECT count(*)::integer FROM occ.agent_revisions WHERE namespace_id = $1) AS revisions,
       (SELECT count(*)::integer FROM occ.secrets WHERE namespace_id = $1) AS secrets,
       (SELECT count(*)::integer FROM occ.iam_access_bindings
         WHERE namespace_id = $1 AND resource_kind = 'credential_source') AS source_grants`,
        [namespace.id],
      );
      assert.deepEqual(resources.rows[0], {
        agents: 0,
        configurations: 0,
        revisions: 0,
        secrets: 2,
        source_grants: 0,
      });
    },
  );

  test(
    "provisioning requires Installation administer on top of every Namespace grant",
    { ...requiresPostgres, timeout: 60_000 },
    async (context) => {
      const fixture = await createFixture(context);
      const namespace = await fixture.bootstrapNamespace();
      const secrets = await createProvisioningSecrets(fixture, namespace.id);
      const provision = () =>
        fixture.request("POST", `/namespaces/${namespace.id}/agents/provision`, {
          body: provisioningBody(namespace.id, secrets),
        });

      // The caller keeps every action on every Namespace resource kind, inside this Namespace
      // only, and loses its Installation grants.
      const principalId = await fixture.revokeCurrentPrincipal();
      const kinds = ["agent", "configuration", "secret", "service_account", "credential_source"];
      const actions = ["create", "read", "update", "delete", "deploy", "operate"];
      const policy = (
        [
          [
            null,
            [
              { action: "read", resourceKind: "namespace" },
              { action: "read", resourceKind: "preset" },
              ...kinds.flatMap((resourceKind) =>
                actions.map((action) => ({ action, resourceKind })),
              ),
            ],
            namespace.id,
          ],
          [null, [{ action: "administer", resourceKind: "installation" }], null],
        ] as const
      ).map(([roleNamespace, permissions, bindingNamespace]) => ({
        roleId: `role-provisioning-${randomUUID()}`,
        bindingId: `binding-provisioning-${randomUUID()}`,
        roleNamespace,
        permissions,
        bindingNamespace,
      }));
      const grant = async ({
        roleId,
        bindingId,
        roleNamespace,
        permissions,
        bindingNamespace,
      }: (typeof policy)[number]) => {
        await fixture.pool.query<Record<string, unknown>>(
          "INSERT INTO occ.iam_roles (id, namespace_id, name, permissions) VALUES ($1, $2, $3, $4::jsonb)",
          [roleId, roleNamespace, `Provisioning ${randomUUID()}`, JSON.stringify(permissions)],
        );
        await fixture.pool.query<Record<string, unknown>>(
          `INSERT INTO occ.iam_access_bindings
           (id, namespace_id, identity_subject_id, group_subject_id, role_id, resource_kind, resource_id)
           VALUES ($1, $2, $3, NULL, $4, NULL, NULL)`,
          [bindingId, bindingNamespace, principalId, roleId],
        );
      };
      try {
        await grant(required(policy[0]));
        const denied = await provision();
        assert.equal(denied.status, 403, JSON.stringify(denied.body));
        assert.equal(provisioningError(denied).code, "FORBIDDEN");
        const plans = await fixture.pool.query<{ plans: number }>(
          "SELECT count(*)::integer AS plans FROM occ.agent_provisioning_work WHERE namespace_id = $1",
          [namespace.id],
        );
        assert.equal(required(plans.rows[0]).plans, 0);

        // Installation administer is the only grant the refused caller lacked.
        await grant(required(policy[1]));
        const admitted = await provision();
        assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
      } finally {
        for (const { roleId, bindingId } of policy) {
          await fixture.pool.query<Record<string, unknown>>(
            "DELETE FROM occ.iam_access_bindings WHERE id = $1",
            [bindingId],
          );
          await fixture.pool.query<Record<string, unknown>>(
            "DELETE FROM occ.iam_roles WHERE id = $1",
            [roleId],
          );
        }
      }
    },
  );
}
