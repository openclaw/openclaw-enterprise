import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import {
  isSecretHarnessAuth,
  type Agent,
  type AgentRevision,
  type ComputeDriver,
} from "../../packages/contracts/src/index.ts";
import type { OpenClawController } from "../../packages/occ/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { requiresPostgres } from "../helpers/postgres-backend-state.mjs";
import type {
  RevisionFixture,
  WorkIdentity,
} from "../helpers/postgres-worker-refused-candidate.ts";
import type { createTestSecretDriver } from "../helpers/secret-driver.ts";

interface DispatchFixture {
  admitInitialRevision: RevisionFixture["admitInitialRevision"];
  agent: RevisionFixture["agent"];
  revision: RevisionFixture["revision"];
  actor: RevisionFixture["actor"];
  compute: RevisionFixture["compute"];
  currentAgent: RevisionFixture["currentAgent"];
  namespace: RevisionFixture["namespace"];
  observerPool: RevisionFixture["observerPool"];
  productionHarness: RevisionFixture["productionHarness"];
  start: RevisionFixture["start"];
  state: RevisionFixture["state"];
  stop: RevisionFixture["stop"];
  deploymentStatus(
    owner: Pick<Agent, "id">,
    candidate: Pick<AgentRevision, "id">,
  ): ReturnType<OpenClawController["getDeploymentStatus"]>;
  secretDriver: Pick<ReturnType<typeof createTestSecretDriver>, "setResolveOverride">;
  work(candidate: WorkIdentity, state: "succeeded" | "failed_permanent"): Promise<unknown>;
}

interface DispatchFixtures {
  revisionTest(name: string, run: (fixture: DispatchFixture) => Promise<void>): void;
  setup(
    context: Pick<TestContext, "after">,
    options: { secretAuthMethod: "api_key" | "codex_pat" },
  ): Promise<DispatchFixture>;
}

type DispatchContext = Parameters<ComputeDriver["prepareRevision"]>[1];
type ComputeEffect = "bind" | "prepare";

function harnessSecretId(owner: Readonly<Agent>): string {
  assert.ok(
    isSecretHarnessAuth(owner.harnessAuth),
    `Agent ${owner.id} has a Harness Secret binding`,
  );
  return owner.harnessAuth.source.id;
}

function observeComputeEffects(compute: ComputeDriver, effects: ComputeEffect[]): ComputeDriver {
  return {
    ...compute,
    async bindAgent() {
      effects.push("bind");
    },
    async prepareRevision(revision) {
      effects.push("prepare");
      return compute.prepareRevision(revision);
    },
  };
}

export function registerRevisionDispatchCases({ revisionTest, setup }: DispatchFixtures): void {
  revisionTest(
    "one worker reconciles embedded OpenClaw and dedicated Codex but rejects unapproved pinned Harnesses",
    async (fixture) => {
      const embedded = await fixture.agent("embedded-openclaw");
      const dedicated = await fixture.agent("dedicated-codex", { executionMode: "dedicated" });
      const unsupported = await fixture.agent("unapproved-harness", { executionMode: "dedicated" });
      const mismatched = await fixture.agent("mismatched-placement");
      const embeddedRevision = await fixture.revision(embedded, 1);
      const dedicatedRevision = await fixture.revision(dedicated, 1);
      const unsupportedRevision = await fixture.revision(unsupported, 1, {
        harness: {
          id: "codex",
          version: "unapproved",
          mode: "dedicated",
        },
      });
      const mismatchedRevision = await fixture.revision(mismatched, 1, {
        harness: {
          ...fixture.productionHarness,
          mode: "embedded",
        },
      });

      await fixture.start(fixture.compute);
      await Promise.all([
        fixture.work(embeddedRevision, "succeeded"),
        fixture.work(dedicatedRevision, "succeeded"),
        fixture.work(unsupportedRevision, "failed_permanent"),
        fixture.work(mismatchedRevision, "failed_permanent"),
      ]);

      const active = await fixture.observerPool.query<{
        id: string;
        active_revision_id: string | null;
      }>(
        "SELECT id, active_revision_id FROM occ.agents WHERE namespace_id = $1 AND id = ANY($2::text[])",
        [fixture.namespace.id, [embedded.id, dedicated.id, unsupported.id, mismatched.id]],
      );
      const activeByAgent = new Map(
        active.rows.map(({ id, active_revision_id }) => [id, active_revision_id]),
      );
      assert.equal(activeByAgent.get(embedded.id), embeddedRevision.id);
      assert.equal(activeByAgent.get(dedicated.id), dedicatedRevision.id);
      assert.equal(activeByAgent.get(unsupported.id), null);
      assert.equal(activeByAgent.get(mismatched.id), null);
      // The deployment status provides recovery guidance for the rejected Harness (finding 828).
      assert.deepEqual((await fixture.deploymentStatus(unsupported, unsupportedRevision)).error, {
        code: "HARNESS_DESCRIPTOR_MISMATCH",
        message:
          "This revision's Harness or Harness version is no longer approved, for example after a controller upgrade. Deploy again to admit a revision with the approved version.",
      });
    },
  );

  for (const secretAuthMethod of ["api_key", "codex_pat"] as const) {
    test(
      `${secretAuthMethod} revision dispatch rechecks Configuration and exact harness Secret grants without backend Secret reads`,
      requiresPostgres,
      async (context) => {
        const fixture = await setup(context, { secretAuthMethod });
        const executionMode = secretAuthMethod === "codex_pat" ? "dedicated" : "embedded";
        const [allowed, configurationDenied, actorSecretDenied, agentSecretUngranted] =
          await Promise.all([
            fixture.agent("allowed", { executionMode }),
            fixture.agent("configuration-denied", { executionMode }),
            fixture.agent("actor-secret-denied", { executionMode }),
            fixture.agent("agent-secret-ungranted", { executionMode, grantHarnessSecret: false }),
          ]);
        const [
          allowedRevision,
          configurationDeniedRevision,
          actorSecretDeniedRevision,
          agentSecretUngrantedRevision,
        ] = await Promise.all([
          fixture.revision(allowed, 1),
          fixture.revision(configurationDenied, 1),
          fixture.revision(actorSecretDenied, 1),
          fixture.revision(agentSecretUngranted, 1),
        ]);
        const actorDeniedSecret = harnessSecretId(actorSecretDenied);
        const ungrantedSecret = harnessSecretId(agentSecretUngranted);
        // Revoke actor permissions after admission and independently exercise an
        // Agent lacking its own grant; actor authority never authorizes that Agent.
        await fixture.observerPool.query(
          `INSERT INTO occ.iam_restrictions
           (id, namespace_id, action, resource_kind, resource_id, effect)
         VALUES ($1, $2, 'read', 'configuration', $3, 'deny'),
                ($4, $2, 'operate', 'secret', $5, 'deny')`,
          [
            `restriction-${randomUUID()}`,
            fixture.namespace.id,
            configurationDenied.configurationId,
            `restriction-${randomUUID()}`,
            actorDeniedSecret,
          ],
        );
        const prepared: { id: AgentRevision["id"]; operationContext: DispatchContext }[] = [];
        // Production workers have no Secret API permission. Dispatch must project
        // authoritative OCC metadata without asking the backend owner to read values.
        fixture.secretDriver.setResolveOverride(() => {
          throw new Error("Worker cannot read backend Secrets.");
        });
        await fixture.start({
          ...fixture.compute,
          async prepareRevision(revision, operationContext) {
            prepared.push({ id: revision.id, operationContext });
            return fixture.compute.prepareRevision(revision);
          },
        });
        await Promise.all([
          fixture.work(allowedRevision, "succeeded"),
          fixture.work(configurationDeniedRevision, "failed_permanent"),
          fixture.work(actorSecretDeniedRevision, "failed_permanent"),
          fixture.work(agentSecretUngrantedRevision, "failed_permanent"),
        ]);
        const { harnessAuth } = allowedRevision;
        assert.ok(isSecretHarnessAuth(harnessAuth), "the admitted Harness uses a Secret");
        const source = await fixture.state.read((view) =>
          view.secrets.findSecret(fixture.namespace.id, harnessAuth.source.id),
        );
        assert.ok(source, "the admitted Secret is still stored");
        assert.deepEqual(
          prepared,
          [
            {
              id: allowedRevision.id,
              operationContext: {
                secretEnvironment: [],
                harnessAuth: { ...harnessAuth, backendRef: source.backendRef },
              },
            },
          ],
          "only the independently authorized binding reaches Compute, outside gateway environment projections",
        );
        const denied = await fixture.observerPool.query<{ authorization: unknown }>(
          `SELECT details->'__occAuditMetadata'->'authorization' AS authorization
         FROM occ.audit_events WHERE namespace_id = $1 AND kind = 'authorization_denial'`,
          [fixture.namespace.id],
        );
        const deniedResources = denied.rows
          .map(({ authorization }) => {
            const decision = asRecord(authorization);
            const resource = asRecord(decision?.resource);
            assert.ok(typeof decision?.principalId === "string", "denial has a principal");
            assert.ok(
              typeof resource?.kind === "string" && typeof resource.id === "string",
              "denial has an exact resource",
            );
            return `${decision.principalId}:${resource.kind}:${resource.id}`;
          })
          .sort();
        assert.deepEqual(
          deniedResources,
          [
            `${fixture.actor.id}:configuration:${configurationDenied.configurationId}`,
            `${fixture.actor.id}:secret:${actorDeniedSecret}`,
            `${agentSecretUngranted.servicePrincipalId}:secret:${ungrantedSecret}`,
          ].sort(),
        );
      },
    );
  }

  revisionTest(
    "revision dispatch refuses a different selected Secret Driver before binding or activating the Agent",
    async (fixture) => {
      const { owner, candidate } = await fixture.admitInitialRevision("changed-secret-owner");
      // Installation composition changed after admission. The revision remains
      // pinned to its admitted Secret Driver and cannot use the replacement.
      const effects: ComputeEffect[] = [];
      await fixture.start(observeComputeEffects(fixture.compute, effects), {
        transformDrivers: (drivers) => ({
          ...drivers,
          installation: {
            ...drivers.installation,
            drivers: {
              ...drivers.installation.drivers,
              secret: { ...drivers.installation.drivers.secret, id: "secret-replacement" },
            },
          },
          secretDriver: { ...drivers.secretDriver, id: "secret-replacement" },
        }),
      });
      await fixture.work(candidate, "failed_permanent");
      assert.deepEqual(effects, []);
      const current = await fixture.currentAgent(owner);
      assert.ok(current, "the Agent is still stored");
      assert.equal(current.activeRevisionId, undefined);
      const work = await fixture.observerPool.query<{ reason_code: string | null }>(
        "SELECT details->>'reasonCode' AS reason_code FROM occ.audit_events WHERE resource_id = $1 AND action = 'reconcile' AND outcome = 'failure'",
        [candidate.id],
      );
      const [failure] = work.rows;
      assert.ok(failure, "the failed reconciliation is audited");
      assert.equal(failure.reason_code, "SECRET_DRIVER_MISMATCH");
      // The deployment status provides recovery guidance without exposing Driver IDs (finding 828).
      assert.deepEqual((await fixture.deploymentStatus(owner, candidate)).error, {
        code: "SECRET_DRIVER_MISMATCH",
        message:
          "The Installation no longer selects the Secret Driver this revision was admitted with. Bind Secrets created through the selected Secret Driver, or remove the old Secret bindings, then deploy again.",
      });
    },
  );

  revisionTest(
    "revision dispatch refuses a different selected Compute Driver with a fixed status message",
    async (fixture) => {
      const { owner, candidate } = await fixture.admitInitialRevision("changed-compute-owner");
      // Installation composition changed after admission: the revision stays pinned to the
      // Compute Driver it was admitted with, so dispatch refuses it before any Compute effect.
      const effects: ComputeEffect[] = [];
      await fixture.start({
        ...observeComputeEffects(fixture.compute, effects),
        id: "compute-replacement",
      });
      await fixture.work(candidate, "failed_permanent");
      await fixture.stop();
      assert.deepEqual(effects, []);
      const current = await fixture.currentAgent(owner);
      assert.ok(current, "the Agent is still stored");
      assert.equal(current.activeRevisionId, undefined);
      assert.deepEqual((await fixture.deploymentStatus(owner, candidate)).error, {
        code: "COMPUTE_DRIVER_MISMATCH",
        message:
          "The Installation no longer selects the Compute Driver this revision was admitted with. Deploy again to admit a revision for the selected driver.",
      });
    },
  );
}
