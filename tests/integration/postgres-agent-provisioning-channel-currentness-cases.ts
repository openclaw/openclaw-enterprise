import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import type {
  ConfigurationDriver,
  ProvisionAgentBody,
  AgentProvisioningResponse,
  SecretWire,
} from "@openclaw-enterprise/contracts";
import { createTestSecretDriver } from "../helpers/secret-driver.ts";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import type { createProvisioningFixture } from "./postgres-agent-provisioning-fixture.ts";

type Fixture = Awaited<ReturnType<typeof createProvisioningFixture>>;
type Secrets = Record<
  "modelKey" | "slackBotToken" | "slackSigningSecret" | "externalServiceToken",
  SecretWire
>;
interface Dependencies {
  createFixture: (
    context: TestContext,
    options?: Parameters<typeof createProvisioningFixture>[1],
  ) => Promise<Fixture>;
  createProvisioningConfigurationDriver: (options: { id: string }) => ConfigurationDriver;
  createProvisioningSecrets: (
    fixture: Pick<Fixture, "request">,
    namespaceId: string,
  ) => Promise<Secrets>;
  provisioningBody: (namespaceId: string, secrets: Secrets) => ProvisionAgentBody;
}

function hold() {
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  return {
    entered: entered.promise,
    release: released.resolve,
    async pause() {
      entered.resolve();
      await released.promise;
    },
  };
}

function syntheticProvider() {
  let calls = 0;
  return {
    fetch: (async (url) => {
      assert.equal(String(url), "https://slack.com/api/auth.test");
      calls++;
      return Response.json({ ok: true, bot_id: "B0123456789", team_id: "T0123456789" });
    }) satisfies typeof fetch,
    calls: () => calls,
  };
}

async function durableCounts(fixture: Fixture, namespaceId: string) {
  const { rows } = await fixture.pool.query(
    `SELECT
    (SELECT count(*)::integer FROM occ.agent_provisioning_work WHERE namespace_id = $1) AS plans,
    (SELECT count(*)::integer FROM occ.agents WHERE namespace_id = $1) AS agents,
    (SELECT count(*)::integer FROM occ.configurations WHERE namespace_id = $1) AS configurations,
    (SELECT count(*)::integer FROM occ.agent_revisions WHERE namespace_id = $1) AS revisions,
    (SELECT count(*)::integer FROM occ.controller_work WHERE namespace_id = $1 AND work_kind = 'provisioning') AS work,
    (SELECT count(*)::integer FROM occ.audit_events WHERE namespace_id = $1 AND action = 'openclaw.agents.provision' AND outcome = 'success') AS success_audit`,
    [namespaceId],
  );
  return rows[0];
}

export function registerChannelCurrentnessCases({
  createFixture,
  createProvisioningConfigurationDriver,
  createProvisioningSecrets,
  provisioningBody,
}: Dependencies) {
  test(
    "provisioning rechecks target authority before Secret and provider use",
    requiresPostgres,
    async (context) => {
      for (const resourceKind of ["agent", "configuration"] as const) {
        for (const stage of ["configuration", "secret"] as const) {
          await context.test(`${resourceKind} revoked after ${stage} I/O`, async (context) => {
            const boundary = hold();
            const configurationDriver = createProvisioningConfigurationDriver({
              id: "configuration-provisioning",
            });
            const secretDriver = createTestSecretDriver({ id: "secret-provisioning" });
            const provider = syntheticProvider();
            const fixture = await createFixture(context, {
              configurationDriver,
              secretDriver,
              slackFetch: provider.fetch,
            });
            const namespace = await fixture.bootstrapNamespace();
            const secrets = await createProvisioningSecrets(fixture, namespace.id);
            const calls = provider.calls;
            const principalId = await fixture.revokeCurrentPrincipal();
            const roleId = `role-provisioning-${randomUUID()}`;
            const bindingId = `binding-provisioning-${randomUUID()}`;
            const targetRoleId = `role-provisioning-${randomUUID()}`;
            const targetBindingId = `binding-provisioning-${randomUUID()}`;
            const permissions = [
              { action: "administer", resourceKind: "installation" },
              { action: "create", resourceKind: "agent" },
              { action: "create", resourceKind: "configuration" },
              { action: "operate", resourceKind: "secret" },
            ];
            await fixture.pool.query(
              "INSERT INTO occ.iam_roles (id, namespace_id, name, permissions) VALUES ($1, NULL, $2, $3::jsonb)",
              [
                roleId,
                `Provisioning currentness ${randomUUID()}`,
                JSON.stringify(
                  permissions.filter(
                    (permission) =>
                      !(permission.action === "create" && permission.resourceKind === resourceKind),
                  ),
                ),
              ],
            );
            await fixture.pool.query(
              "INSERT INTO occ.iam_access_bindings (id, namespace_id, identity_subject_id, group_subject_id, role_id, resource_kind, resource_id) VALUES ($1, NULL, $2, NULL, $3, NULL, NULL)",
              [bindingId, principalId, roleId],
            );
            await fixture.pool.query(
              "INSERT INTO occ.iam_roles (id, namespace_id, name, permissions) VALUES ($1, NULL, $2, $3::jsonb)",
              [
                targetRoleId,
                `Provisioning target ${randomUUID()}`,
                JSON.stringify([{ action: "create", resourceKind }]),
              ],
            );
            const restoreTarget = () =>
              fixture.pool.query(
                "INSERT INTO occ.iam_access_bindings (id, namespace_id, identity_subject_id, group_subject_id, role_id, resource_kind, resource_id) VALUES ($1, NULL, $2, NULL, $3, NULL, NULL)",
                [targetBindingId, principalId, targetRoleId],
              );
            await restoreTarget();
            let pause = true;
            if (stage === "configuration") {
              const validate = configurationDriver.validate.bind(configurationDriver);
              configurationDriver.validate = async (configuration) => {
                await validate(configuration);
                if (pause) {
                  pause = false;
                  await boundary.pause();
                }
              };
            } else {
              const withValue = secretDriver.withValue.bind(secretDriver);
              secretDriver.withValue = (secret, use) =>
                withValue(secret, async (value) => {
                  if (secret.id === secrets.slackBotToken.id && pause) {
                    pause = false;
                    await boundary.pause();
                  }
                  return use(value);
                });
            }
            const before = await durableCounts(fixture, namespace.id);
            const body = provisioningBody(namespace.id, secrets);
            const pending = fixture.request(
              "POST",
              `/namespaces/${namespace.id}/agents/provision`,
              { body },
            );
            try {
              await boundary.entered;
              // Persist only the target-grant revocation. Native IAM and Secret operate remain real.
              const revoked = await fixture.pool.query(
                "DELETE FROM occ.iam_access_bindings WHERE id = $1",
                [targetBindingId],
              );
              assert.equal(revoked.rowCount, 1);
              boundary.release();
              const response = await pending;
              assert.equal(response.status, 403, JSON.stringify(response.body));
              assert.equal(
                calls(),
                0,
                "revoked provisioning authority must prevent provider dispatch",
              );
              assert.deepEqual(await durableCounts(fixture, namespace.id), before);
              // Restoring the sole missing grant admits the same operation and validates once.
              await restoreTarget();
              const accepted = await fixture.request<AgentProvisioningResponse["data"]>(
                "POST",
                `/namespaces/${namespace.id}/agents/provision`,
                { body },
              );
              assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
              assert.equal(calls(), 1);
              assert.ok(accepted.data);
              fixture.cancelQueuedWorkAtTeardown(
                accepted.data.provisioning.workId,
                "currentness case complete",
              );
            } finally {
              boundary.release();
              await pending;
              await fixture.pool.query("DELETE FROM occ.iam_access_bindings WHERE id = $1", [
                bindingId,
              ]);
              await fixture.pool.query("DELETE FROM occ.iam_roles WHERE id = $1", [roleId]);
              await fixture.pool.query("DELETE FROM occ.iam_access_bindings WHERE id = $1", [
                targetBindingId,
              ]);
              await fixture.pool.query("DELETE FROM occ.iam_roles WHERE id = $1", [targetRoleId]);
            }
          });
        }
      }
    },
  );

  test(
    "provisioning rechecks exact Secret ownership after storage I/O",
    requiresPostgres,
    async (context) => {
      for (const change of ["delete", "rotate", "unchanged"] as const) {
        await context.test(change, async (context) => {
          const boundary = hold();
          const secretDriver = createTestSecretDriver({ id: "secret-provisioning" });
          const provider = syntheticProvider();
          const fixture = await createFixture(context, {
            secretDriver,
            slackFetch: provider.fetch,
          });
          const namespace = await fixture.bootstrapNamespace();
          const secrets = await createProvisioningSecrets(fixture, namespace.id);
          const calls = provider.calls;
          const withValue = secretDriver.withValue.bind(secretDriver);
          let pause = true;
          secretDriver.withValue = (secret, use) =>
            withValue(secret, async (value) => {
              if (secret.id === secrets.slackBotToken.id && pause) {
                pause = false;
                await boundary.pause();
              }
              return use(value);
            });
          const before = await durableCounts(fixture, namespace.id);
          const body = provisioningBody(namespace.id, secrets);
          const pending = fixture.request<AgentProvisioningResponse["data"]>(
            "POST",
            `/namespaces/${namespace.id}/agents/provision`,
            { body },
          );
          try {
            await boundary.entered;
            if (change === "delete") {
              // The Secret has no durable consumer until provisioning admission commits.
              const deleted = await fixture.request(
                "DELETE",
                `/namespaces/${namespace.id}/secrets/${secrets.slackBotToken.id}`,
              );
              assert.equal(deleted.status, 204, JSON.stringify(deleted.body));
              const retained = await fixture.pool.query(
                "SELECT id FROM occ.secrets WHERE namespace_id = $1 AND id = $2",
                [namespace.id, secrets.slackBotToken.id],
              );
              assert.equal(
                retained.rowCount,
                0,
                "the authorized deletion must commit before the callback resumes",
              );
            } else if (change === "rotate") {
              const rotated = await fixture.request(
                "PATCH",
                `/namespaces/${namespace.id}/secrets/${secrets.slackBotToken.id}`,
                { body: { value: `xoxb-${randomUUID()}` } },
              );
              assert.equal(rotated.status, 200, JSON.stringify(rotated.body));
            }
            boundary.release();
            const response = await pending;
            if (change === "delete") {
              assert.equal(calls(), 0, "a removed exact Secret must prevent provider dispatch");
              assert.equal(response.status, 503, JSON.stringify(response.body));
              assert.deepEqual(await durableCounts(fixture, namespace.id), before);
            } else {
              assert.equal(response.status, 202, JSON.stringify(response.body));
              assert.equal(calls(), 1, "unchanged ownership, including rotation, validates once");
              assert.ok(response.data);
              fixture.cancelQueuedWorkAtTeardown(
                response.data.provisioning.workId,
                "currentness case complete",
              );
              const replay = await fixture.request(
                "POST",
                `/namespaces/${namespace.id}/agents/provision`,
                { body },
              );
              assert.equal(replay.status, 202, JSON.stringify(replay.body));
              assert.equal(calls(), 1, "accepted replay does not repeat provider I/O");
            }
          } finally {
            boundary.release();
            await pending;
          }
        });
      }
    },
  );
}
