import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  AgentProvisioningResponse,
  AgentProvisioningStatusResponse,
  AgentReadResponse,
  CredentialSourceListResponse,
  CredentialSourceResponse,
} from "../../packages/contracts/src/api/resources.ts";
import type {
  CredentialGatewayDriver,
  ProvisionAgentBody,
  SandboxDriver,
} from "../../packages/contracts/src/index.ts";
import type { ControllerWorkState } from "../../packages/occ/src/index.ts";
import { DEDICATED_OPENCLAW_SUPPORT } from "../helpers/sandbox-driver.ts";
import type { WorkerEvent } from "./postgres-agent-provisioning-setup.ts";
import {
  createProvisioningConfigurationDriver,
  type Fixture,
  handedOff,
  required,
} from "./postgres-agent-provisioning-setup.ts";

import { KubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { conformanceKubernetesOptions } from "../helpers/kubernetes-compute.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import {
  assertProvisioningSourceStatus,
  assertProvisioningSourceWithdrawal,
} from "../helpers/provisioning-source-status.ts";
import { PROVISIONING_NOT_COMPLETED } from "../helpers/refusal-text.mjs";
import { waitFor } from "../helpers/wait-for.mjs";
import { createRuntimeComputeDriver } from "./postgres-agent-provisioning-transport-fixture.ts";

import {
  authAccountResponse,
  claimProvisioningWork,
  createFixture,
  createNamespaceSecret,
  createProvisioningSecrets,
  provisioningBody,
  provisioningError,
  provisioningRow,
  requestId,
  signInToControllerApp,
} from "./postgres-agent-provisioning-setup.ts";

export function registerCredentialCases() {
  for (const harnessAuth of ["api_key", "credential_source"] as const) {
    test(
      harnessAuth === "api_key"
        ? "provisioning worker reauthorizes after admission and revoked authority creates no backend effects"
        : "provisioning worker reauthorizes an accepted source after only its exact operate grant is revoked",
      { ...requiresPostgres, timeout: 60_000 },
      async (context) => {
        const sourceBacked = harnessAuth === "credential_source";
        const sourceDrivers = sourceBacked ? sourceProvisioningDrivers() : undefined;
        const drivers = sourceDrivers ?? {};
        const configurationDriver = createProvisioningConfigurationDriver({
          id: "configuration-provisioning",
        });
        const fixture = await createFixture(context, { ...drivers, configurationDriver });
        const namespace = await fixture.bootstrapNamespace();
        let body: ProvisionAgentBody;
        let session = fixture.session;
        let revokeAuthority: () => Promise<unknown> = () => fixture.revokeCurrentPrincipal();
        if (sourceBacked) {
          const { source } = await createProvisioningModelSource(fixture, namespace.id);
          body = sourceProvisioningBody(source.id, "openclaw");
          // Give a separate requester only the required provisioning permissions. The API also
          // requires Installation administer; this Role has no wildcard or Secret permission.
          const roleId = `role-provisioning-${randomUUID()}`;
          const sourceRoleId = `role-source-${randomUUID()}`;
          await fixture.pool.query<Record<string, unknown>>(
            `INSERT INTO occ.iam_roles (id, namespace_id, name, permissions)
             VALUES ($1, NULL, $2, $3::jsonb), ($4, $5, $6, $7::jsonb)`,
            [
              roleId,
              `Source provisioning requester ${randomUUID()}`,
              JSON.stringify([
                { action: "administer", resourceKind: "installation" },
                { action: "create", resourceKind: "agent" },
                { action: "create", resourceKind: "configuration" },
              ]),
              sourceRoleId,
              namespace.id,
              `Exact model source operator ${randomUUID()}`,
              JSON.stringify([{ action: "operate", resourceKind: "credential_source" }]),
            ],
          );
          const requester = {
            email: `source-provisioning-${randomUUID()}@example.test`,
            password: `generated-password-${randomUUID()}`,
          };
          const created = await fixture.requestChecked(
            authAccountResponse,
            "POST",
            "/api/auth/accounts",
            {
              body: { ...requester, name: "Source provisioning requester", roleId },
            },
          );
          assert.equal(created.status, 201, JSON.stringify(created.body));
          const principalId = created.data.principalId;
          session = await signInToControllerApp(fixture.app, requester);
          const sourceBindingId = `binding-source-${randomUUID()}`;
          for (const [id, selectedRoleId, kind, resourceId] of [
            [`binding-provisioning-${randomUUID()}`, roleId, null, null],
            [sourceBindingId, sourceRoleId, "credential_source", source.id],
          ]) {
            await fixture.pool.query<Record<string, unknown>>(
              `INSERT INTO occ.iam_access_bindings
             (id, namespace_id, identity_subject_id, role_id, resource_kind, resource_id)
             VALUES ($1, $2, $3, $4, $5, $6)`,
              [id, namespace.id, principalId, selectedRoleId, kind, resourceId],
            );
          }
          revokeAuthority = async () => {
            const revoked = await fixture.pool.query<Record<string, unknown>>(
              "DELETE FROM occ.iam_access_bindings WHERE id = $1 RETURNING id",
              [sourceBindingId],
            );
            assert.equal(revoked.rowCount, 1, "only the requester's exact source grant is revoked");
            const iam = new NativeIAMDriver(fixture.state);
            const installation = required(await fixture.state.loadInstallation());
            for (const [action, resource] of [
              ["administer", { kind: "installation", id: installation.id }],
              ["create", { kind: "agent", namespaceId: namespace.id, id: namespace.id }],
              ["create", { kind: "configuration", namespaceId: namespace.id, id: namespace.id }],
            ] as const) {
              const decision = await iam.authorize({ principalId, action, resource });
              assert.equal(
                decision.allowed,
                true,
                `${action} ${resource.kind} must remain allowed`,
              );
            }
            const sourceAccess = await iam.authorize({
              principalId,
              action: "operate",
              resource: { kind: "credential_source", namespaceId: namespace.id, id: source.id },
            });
            assert.equal(sourceAccess.allowed, false, "the exact model source must be denied");
          };
        } else {
          const secrets = await createProvisioningSecrets(fixture, namespace.id);
          body = provisioningBody(namespace.id, secrets);
        }
        const admitted = await fixture.requestChecked(
          AgentProvisioningResponse,
          "POST",
          `/namespaces/${namespace.id}/agents/provision`,
          {
            body,
            session,
          },
        );
        assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
        const callsBeforeRevocation = structuredClone(fixture.secretDriver.calls);
        const runtimeCallsBeforeRevocation = structuredClone(fixture.computeDriver.calls);
        const externalOperations = [
          ...(["createExact", "inspectExact"] as const).map((method) =>
            context.mock.method(configurationDriver, method),
          ),
          ...(sourceDrivers !== undefined
            ? (
                [
                  "listSourceTypes",
                  "registerSource",
                  "updateSource",
                  "sourceStatus",
                  "removeSource",
                  "attachForRevision",
                  "attachmentStatus",
                  "withdraw",
                ] as const
              ).map((method) => context.mock.method(sourceDrivers.credentialGatewayDriver, method))
            : []),
          ...(sourceDrivers !== undefined
            ? (["provisionHarness", "cleanup"] as const).map((method) =>
                context.mock.method(sourceDrivers.sandboxDriver, method),
              )
            : []),
        ];
        await revokeAuthority();
        if (sourceBacked) {
          const denied = await fixture.request("GET", admitted.data.provisioning.url, { session });
          assert.equal(denied.status, 403, JSON.stringify(denied.body));
        }
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
          assert.equal(
            operation.mock.callCount(),
            0,
            "revoked authority must not contact a backend",
          );
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
          secrets: sourceBacked ? 1 : 4,
          source_grants: 0,
        });
      },
    );
  }

  // The gateway is the external credential-store boundary. These cases use real HTTP,
  // PostgreSQL checkpoints, Native IAM and Kubernetes authentication admission; they do
  // not claim OpenShell injection or a live model turn.
  function sourceProvisioningDrivers() {
    const stored = new Set<string>();
    const credentialGatewayDriver: CredentialGatewayDriver = {
      id: "credential-gateway-provisioning",
      capability: "credential_gateway",
      implementation: "test-credential-store",
      validateSourceConfig() {},
      async listSourceTypes() {
        return [
          {
            type: "openai",
            config: [],
            secrets: [{ name: "api_key", required: true }],
            rotation: "none",
            harnessAuth: { modelProvider: "openai", loginMode: "api_key" },
          },
        ];
      },
      async registerSource({ source }) {
        stored.add(source.id);
        return { state: "ready" };
      },
      async updateSource() {
        return { state: "ready" };
      },
      async sourceStatus({ source }) {
        return { state: stored.has(source.id) ? "ready" : "absent" };
      },
      async removeSource({ source }) {
        stored.delete(source.id);
      },
      async attachForRevision() {
        assert.fail("this case ends at provisioning handoff");
      },
      async attachmentStatus() {
        assert.fail("this case ends at provisioning handoff");
      },
      async withdraw() {
        assert.fail("this case has no deployed Sandbox");
      },
    };
    const sandboxDriver = {
      id: "sandbox-source-provisioning",
      capability: "sandbox",
      implementation: "test-provisioning",
      supportsHarnessExecutionMode: DEDICATED_OPENCLAW_SUPPORT,
      facets: ["networking", "filesystem", "process"],
      async provisionHarness() {
        assert.fail("this case ends at provisioning handoff");
      },
      async cleanup() {},
    } satisfies SandboxDriver;
    const topology = new KubernetesComputeDriver(
      conformanceKubernetesOptions({ gatewayTrustedProxyCidrs: ["127.0.0.1/32"] }),
      { id: "source-provisioning-topology", sandboxDriver, credentialGatewayDriver },
    );
    const computeDriver = createRuntimeComputeDriver();
    computeDriver.validateHarnessAuth = topology.validateHarnessAuth.bind(topology);
    // Namespace placement and actual transport effects remain the established runtime fixture.
    computeDriver.resolveSandboxNamespace = async (namespace) => namespace;
    return { computeDriver, sandboxDriver, credentialGatewayDriver };
  }

  async function createProvisioningModelSource(fixture: Fixture, namespaceId: string) {
    const secret = await createNamespaceSecret(fixture, namespaceId, "gateway-model-key");
    const registered = await fixture.requestChecked(
      CredentialSourceResponse,
      "POST",
      `/namespaces/${namespaceId}/credential-sources`,
      {
        body: { name: "provisioning-model", type: "openai", secrets: { api_key: secret.ref } },
      },
    );
    assert.equal(registered.status, 201, JSON.stringify(registered.body));
    return { secret, source: registered.data };
  }

  function sourceProvisioningBody(
    sourceId: string,
    harness: "openclaw" | "codex",
  ): ProvisionAgentBody {
    const { agents, models } = createHarnessConfiguration(
      harness,
      harness === "openclaw" ? "gpt-5" : "gpt-6-astra",
    );
    return {
      requestId: requestId(),
      name: `Source ${harness} ${randomUUID().slice(0, 8)}`,
      executionMode: "dedicated",
      configuration: {
        kind: "agent",
        values: { agents, models },
      },
      harnessAuth: { method: "credential_source", sourceId },
    };
  }

  test(
    "source provisioning status preserves saved work when its Gateway catalog is unavailable",
    { ...requiresPostgres, timeout: 60_000 },
    async (context) => {
      const drivers = sourceProvisioningDrivers();
      drivers.computeDriver.provisionAgentRuntimeCredentials = async () => {
        throw new Error("synthetic transport failure");
      };
      const fixture = await createFixture(context, drivers);
      const namespace = await fixture.bootstrapNamespace();
      const { source } = await createProvisioningModelSource(fixture, namespace.id);
      const body = sourceProvisioningBody(source.id, "openclaw");
      const admissionPath = `/namespaces/${namespace.id}/agents/provision`;
      const admitted = await fixture.requestChecked(
        AgentProvisioningResponse,
        "POST",
        admissionPath,
        { body },
      );
      assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
      const target = { ...admitted.data.provisioning, admissionPath, body };
      fixture.cancelQueuedWorkAtTeardown(target.workId, "Source status test completed.");
      await assertProvisioningSourceStatus(
        context,
        fixture,
        drivers.credentialGatewayDriver,
        target,
      );

      // The actual worker creates the Agent and exact source grant before transport fails.
      await fixture.startWorker();
      const failed = await waitFor("source provisioning transport to fail", async () => {
        const observed = await fixture.requestChecked(
          AgentProvisioningStatusResponse,
          "GET",
          target.url,
        );
        assert.equal(observed.status, 200, JSON.stringify(observed.body));
        return observed.data.status === "failed" ? observed.data : undefined;
      });
      await fixture.stopWorker();
      assert.ok(failed.agentId);
      fixture.cancelProvisioningAtTeardown(namespace.id, failed.agentId);
      await assertProvisioningSourceStatus(
        context,
        fixture,
        drivers.credentialGatewayDriver,
        target,
      );

      // Removing the Agent's exact source permission must still deny the saved read.
      const revoked = await fixture.pool.query<Record<string, unknown>>(
        `DELETE FROM occ.iam_access_bindings WHERE namespace_id = $1
         AND resource_kind = 'credential_source' AND resource_id = $2 RETURNING id`,
        [namespace.id, source.id],
      );
      assert.equal(revoked.rowCount, 1);
      const deniedAgent = await fixture.request("GET", target.url);
      assert.equal(deniedAgent.status, 403, JSON.stringify(deniedAgent.body));
      await fixture.revokeCurrentPrincipal();
      const deniedOperator = await fixture.request("GET", target.url);
      assert.equal(deniedOperator.status, 403, JSON.stringify(deniedOperator.body));
    },
  );

  test(
    "source provisioning worker rejects a withdrawn type while failed status remains readable",
    { ...requiresPostgres, timeout: 60_000 },
    async (context) => {
      const drivers = sourceProvisioningDrivers();
      const fixture = await createFixture(context, drivers);
      const namespace = await fixture.bootstrapNamespace();
      const { source } = await createProvisioningModelSource(fixture, namespace.id);
      const admitted = await fixture.requestChecked(
        AgentProvisioningResponse,
        "POST",
        `/namespaces/${namespace.id}/agents/provision`,
        {
          body: sourceProvisioningBody(source.id, "openclaw"),
        },
      );
      assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
      fixture.cancelQueuedWorkAtTeardown(
        admitted.data.provisioning.workId,
        "Source withdrawal test completed.",
      );
      await assertProvisioningSourceWithdrawal(
        fixture,
        drivers.credentialGatewayDriver,
        admitted.data.provisioning,
      );
    },
  );

  for (const harness of ["openclaw", "codex"] as const) {
    test(
      `guided ${harness} provisioning holds its model source and grants only source access`,
      { ...requiresPostgres, timeout: 60_000 },
      async (context) => {
        const fixture = await createFixture(context, {
          ...sourceProvisioningDrivers(),
          stopAfterProvisioning: true,
        });
        const namespace = await fixture.bootstrapNamespace();
        const { secret, source } = await createProvisioningModelSource(fixture, namespace.id);
        const body = sourceProvisioningBody(source.id, harness);
        const admitted = await fixture.requestChecked(
          AgentProvisioningResponse,
          "POST",
          `/namespaces/${namespace.id}/agents/provision`,
          { body },
        );
        assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
        const queued = await provisioningRow(fixture.pool, namespace.id, body.requestId);
        assert.equal(queued.agent_id, null);
        // The accepted model reference holds the source before an Agent exists.
        const deleted = await fixture.request(
          "DELETE",
          `/namespaces/${namespace.id}/credential-sources/${source.id}`,
        );
        assert.equal(deleted.status, 409, JSON.stringify(deleted.body));
        const replay = await fixture.requestChecked(
          AgentProvisioningResponse,
          "POST",
          `/namespaces/${namespace.id}/agents/provision`,
          {
            body,
          },
        );
        assert.equal(replay.status, 202, JSON.stringify(replay.body));
        assert.equal(replay.data.provisioning.workId, admitted.data.provisioning.workId);
        await fixture.startWorker();
        const status = await waitFor("source provisioning to hand off", async () => {
          const observed = await fixture.requestChecked(
            AgentProvisioningStatusResponse,
            "GET",
            admitted.data.provisioning.url,
          );
          assert.equal(observed.status, 200, JSON.stringify(observed.body));
          assert.notEqual(observed.data.status, "failed", JSON.stringify(observed.body));
          // Provisioning succeeds only after activation; this fixture stops at its queued handoff.
          return observed.data.revisionId !== undefined && observed.data.status === "queued"
            ? handedOff(observed.data)
            : undefined;
        });
        await fixture.stopWorker();
        fixture.cancelProvisioningAtTeardown(namespace.id, status.agentId);
        const agent = await fixture.requestChecked(
          AgentReadResponse,
          "GET",
          `/namespaces/${namespace.id}/agents/${status.agentId}`,
        );
        assert.ok("harnessAuth" in agent.data);
        assert.deepEqual(agent.data.harnessAuth, body.harnessAuth);
        assert.deepEqual(agent.data.credentialSources, [{ sourceId: source.id }]);
        const revisions = await fixture.state.read((view) =>
          view.revisions.listRevisions(namespace.id, status.agentId),
        );
        assert.equal(revisions.length, 1);
        assert.equal(required(revisions[0]).harness.id, harness);
        assert.deepEqual(required(revisions[0]).credentialSources, [
          {
            sourceId: source.id,
            credentialGatewayId: "credential-gateway-provisioning",
            sourceType: "openai",
          },
        ]);
        const bindings = await fixture.pool.query<{
          resource_kind: string | null;
          resource_id: string | null;
        }>(
          "SELECT resource_kind, resource_id FROM occ.iam_access_bindings WHERE namespace_id = $1 AND identity_subject_id = $2 ORDER BY resource_kind, resource_id",
          [namespace.id, agent.data.servicePrincipalId],
        );
        assert.deepEqual(bindings.rows, [
          { resource_kind: "credential_source", resource_id: source.id },
        ]);
        assert.equal(
          bindings.rows.some(({ resource_id }) => resource_id === secret.id),
          false,
        );
      },
    );
  }

  test(
    "guided provisioning rejects Secret model delivery when a Credential Gateway is selected",
    { ...requiresPostgres, timeout: 60_000 },
    async (context) => {
      const fixture = await createFixture(context, sourceProvisioningDrivers());
      const namespace = await fixture.bootstrapNamespace();
      const secret = await createNamespaceSecret(fixture, namespace.id, "model-key");
      for (const harness of ["openclaw", "codex"] as const) {
        const body = sourceProvisioningBody("unused-source", harness);
        body.harnessAuth = { method: "api_key", source: secret.ref };
        const refused = await fixture.request(
          "POST",
          `/namespaces/${namespace.id}/agents/provision`,
          {
            body,
          },
        );
        assert.equal(refused.status, 409, JSON.stringify(refused.body));
        assert.match(
          provisioningError(refused).message,
          /requires credential-source Harness authentication/u,
        );
      }
      const resources = await fixture.pool.query<{
        jobs: number;
        agents: number;
        configurations: number;
      }>(
        `SELECT
         (SELECT count(*)::integer FROM occ.agent_provisioning_work WHERE namespace_id = $1) AS jobs,
         (SELECT count(*)::integer FROM occ.agents WHERE namespace_id = $1) AS agents,
         (SELECT count(*)::integer FROM occ.configurations WHERE namespace_id = $1) AS configurations`,
        [namespace.id],
      );
      assert.deepEqual(resources.rows[0], { jobs: 0, agents: 0, configurations: 0 });
    },
  );

  test(
    "guided source provisioning cannot bind an uncertain registration",
    { ...requiresPostgres, timeout: 60_000 },
    async (context) => {
      const drivers = sourceProvisioningDrivers();
      drivers.credentialGatewayDriver.registerSource = async () => {
        throw new Error("synthetic uncertain credential registration");
      };
      const fixture = await createFixture(context, drivers);
      const namespace = await fixture.bootstrapNamespace();
      const secret = await createNamespaceSecret(fixture, namespace.id, "model-key");
      const registration = await fixture.request(
        "POST",
        `/namespaces/${namespace.id}/credential-sources`,
        {
          body: { name: "uncertain model", type: "openai", secrets: { api_key: secret.ref } },
        },
      );
      assert.equal(registration.status, 503, JSON.stringify(registration.body));
      const sources = await fixture.requestChecked(
        CredentialSourceListResponse,
        "GET",
        `/namespaces/${namespace.id}/credential-sources`,
      );
      assert.equal(sources.status, 200, JSON.stringify(sources.body));
      assert.equal(sources.data.length, 1);
      assert.equal(required(sources.data[0]).state, "deleting");
      const refused = await fixture.request(
        "POST",
        `/namespaces/${namespace.id}/agents/provision`,
        {
          body: sourceProvisioningBody(required(sources.data[0]).id, "openclaw"),
        },
      );
      assert.equal(refused.status, 404, JSON.stringify(refused.body));
      const jobs = await fixture.pool.query<Record<string, unknown>>(
        "SELECT work_id FROM occ.agent_provisioning_work WHERE namespace_id = $1",
        [namespace.id],
      );
      assert.equal(jobs.rowCount, 0);
    },
  );

  test(
    "guided source provisioning authorizes its source and rechecks ownership before worker effects",
    { ...requiresPostgres, timeout: 60_000 },
    async (context) => {
      const drivers = sourceProvisioningDrivers();
      const fixture = await createFixture(context, drivers);
      const namespace = await fixture.bootstrapNamespace();
      const { source } = await createProvisioningModelSource(fixture, namespace.id);
      const body = sourceProvisioningBody(source.id, "openclaw");
      const admitted = await fixture.requestChecked(
        AgentProvisioningResponse,
        "POST",
        `/namespaces/${namespace.id}/agents/provision`,
        {
          body,
        },
      );
      assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
      // A selected gateway change cannot reuse another gateway's accepted source.
      const switched = await createFixture(context, {
        ...drivers,
        credentialGatewayDriver: {
          ...drivers.credentialGatewayDriver,
          id: "credential-gateway-replacement",
        },
      });
      const status = await switched.request("GET", admitted.data.provisioning.url);
      assert.equal(status.status, 503, JSON.stringify(status.body));
      const replay = await switched.request(
        "POST",
        `/namespaces/${namespace.id}/agents/provision`,
        {
          body,
        },
      );
      assert.equal(replay.status, 503, JSON.stringify(replay.body));
      const retry = await switched.request("POST", `${admitted.data.provisioning.url}/retry`);
      assert.equal(retry.status, 503, JSON.stringify(retry.body));
      const { workId } = admitted.data.provisioning;
      const ended = (event: WorkerEvent) =>
        event.event === "worker.completed" && event.workId === workId;
      const events: WorkerEvent[] = [];
      const worker = await createFixture(context, {
        ...drivers,
        credentialGatewayDriver: {
          ...drivers.credentialGatewayDriver,
          id: "credential-gateway-replacement",
        },
        onWorkerEvent: (event) => events.push(event),
        // Stop in the pass that ends the first attempt: its retry can be due at once (finding 1610).
        stopWorkerAfter: ended,
      });
      await worker.startWorker();
      await waitFor("the worker to revalidate the source owner", async () => events.find(ended));
      await worker.stopWorker();
      assert.deepEqual(
        events.filter(ended).map(({ attempt, outcome, code }) => ({ attempt, outcome, code })),
        [{ attempt: 1, outcome: "retry", code: "PROVISIONING_DEPENDENCY_UNAVAILABLE" }],
      );
      const row = await provisioningRow(fixture.pool, namespace.id, body.requestId);
      assert.equal(row.completed_phase, "admitted");
      assert.equal(row.agent_id, null);
      assert.equal(row.configuration_id, null);
      const resources = await fixture.pool.query<{
        agents: number;
        configurations: number;
        revisions: number;
      }>(
        `SELECT
         (SELECT count(*)::integer FROM occ.agents WHERE namespace_id = $1) AS agents,
         (SELECT count(*)::integer FROM occ.configurations WHERE namespace_id = $1) AS configurations,
         (SELECT count(*)::integer FROM occ.agent_revisions WHERE namespace_id = $1) AS revisions`,
        [namespace.id],
      );
      assert.deepEqual(resources.rows[0], { agents: 0, configurations: 0, revisions: 0 });
      // The actor retains provisioning grants but cannot operate this exact source.
      const principalId = await fixture.revokeCurrentPrincipal();
      const roleId = `role-provisioning-${randomUUID()}`;
      const bindingId = `binding-provisioning-${randomUUID()}`;
      await fixture.pool.query<Record<string, unknown>>(
        "INSERT INTO occ.iam_roles (id, namespace_id, name, permissions) VALUES ($1, NULL, $2, $3::jsonb)",
        [
          roleId,
          `Provisioning without source ${randomUUID()}`,
          JSON.stringify([
            { action: "administer", resourceKind: "installation" },
            { action: "create", resourceKind: "agent" },
            { action: "create", resourceKind: "configuration" },
          ]),
        ],
      );
      await fixture.pool.query<Record<string, unknown>>(
        "INSERT INTO occ.iam_access_bindings (id, namespace_id, identity_subject_id, group_subject_id, role_id, resource_kind, resource_id) VALUES ($1, NULL, $2, NULL, $3, NULL, NULL)",
        [bindingId, principalId, roleId],
      );
      try {
        const denied = await fixture.request(
          "POST",
          `/namespaces/${namespace.id}/agents/provision`,
          {
            body: { ...body, requestId: requestId() },
          },
        );
        assert.equal(denied.status, 403, JSON.stringify(denied.body));
      } finally {
        await fixture.pool.query<Record<string, unknown>>(
          "DELETE FROM occ.iam_access_bindings WHERE id = $1",
          [bindingId],
        );
        await fixture.pool.query<Record<string, unknown>>(
          "DELETE FROM occ.iam_roles WHERE id = $1",
          [roleId],
        );
      }
      const claim = await claimProvisioningWork(fixture.pool, admitted.data.provisioning.workId);
      await fixture.state.transact((unit) =>
        unit.provisioning.cancel(claim, {
          code: "PROVISIONING_CANCELLED",
          message: "source ownership case completed without effects",
        }),
      );
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
