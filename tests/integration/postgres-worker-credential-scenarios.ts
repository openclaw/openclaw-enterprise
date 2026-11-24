import { DEDICATED_OPENCLAW_SUPPORT } from "../helpers/sandbox-driver.ts";
import assert from "node:assert/strict";
import { Type } from "typebox";
import test, { type TestContext, type TestOptions } from "node:test";
import type { ControllerWorkerOptions } from "../../apps/controller/src/worker.ts";
import type {
  Agent,
  ComputeDriver,
  HarnessAuthBinding,
} from "../../packages/contracts/src/index.ts";
import type { CredentialGatewayDriver } from "../../packages/contracts/src/drivers/credential-gateway/index.ts";
import type { SandboxDriver } from "../../packages/contracts/src/drivers/sandbox/index.ts";
import type {
  RevisionFixture,
  WorkIdentity,
} from "../helpers/postgres-worker-refused-candidate.ts";
import { DependencyUnavailableError } from "../../packages/occ/src/index.ts";
import { requiresPostgres } from "../helpers/postgres-backend-state.mjs";
import { waitFor } from "../helpers/wait-for.ts";
import {
  CREDENTIAL_GATEWAY_FIXTURE_ID,
  createWorkerRevisionFixtures,
} from "../helpers/postgres-worker-revision-fixture.mjs";
import { deferWork, makeWorkDue } from "../helpers/postgres-worker-revision-queue.ts";

import {
  readMaintenanceResult,
  readRows,
  required,
  withdrawalFields,
  workAttempt,
  workDelay,
  workStateAndReason,
} from "./postgres-worker-credential-observations.ts";

export type RuntimeDrivers = NonNullable<ControllerWorkerOptions["drivers"]>;
export type FixtureRevision = Awaited<ReturnType<RevisionFixture["revision"]>>;
export type CredentialSourceAgent = Readonly<Agent> & {
  harnessAuth: Extract<HarnessAuthBinding, { method: "credential_source" }>;
};
export type Identified = { id: string };
type RetrySeries = WorkIdentity & { delayMs: number };
export type WithdrawalCall = [revisionId: string, sourceId: string];

export function createCredentialSourceRevisionCases(testFile: string) {
  const { setup, cleanup } = createWorkerRevisionFixtures(testFile);

  function revisionTest(
    name: string,
    run: (fixture: RevisionFixture, context: TestContext) => Promise<void>,
    options?: TestOptions,
  ) {
    test(name, { ...requiresPostgres, ...options }, async (context) =>
      run(await setup(context), context),
    );
  }

  return { setup, cleanup, revisionTest };
}

export type CredentialSourceRevisionCases = ReturnType<typeof createCredentialSourceRevisionCases>;
export function assertCredentialSourceAgent(
  agent: Readonly<Agent>,
): asserts agent is CredentialSourceAgent {
  assert.equal(typeof agent.id, "string");
  assert.ok(agent.harnessAuth?.method === "credential_source");
  assert.equal(typeof agent.harnessAuth.sourceId, "string");
}

// Selects a paired Sandbox and Credential Gateway so the worker admits credential-source
// revisions. Compute stands in for the gateway calls; these doubles only identify the pair.
export function withCredentialGateway(drivers: RuntimeDrivers): RuntimeDrivers {
  const sandboxDriver: SandboxDriver = {
    id: "sandbox-worker-fixture",
    capability: "sandbox",
    implementation: "sandbox-worker-fixture",
    supportsHarnessExecutionMode: DEDICATED_OPENCLAW_SUPPORT,
    facets: ["networking"],
    async cleanup() {},
  };
  const credentialGatewayDriver = credentialGatewayFixture();
  const select = (driver: SandboxDriver | CredentialGatewayDriver) => ({
    id: driver.id,
    implementation: driver.implementation,
    configuration: {},
    definition: {
      configurationSchema: { type: "object", additionalProperties: false },
      validateConfiguration: () => [],
    },
  });
  return {
    ...drivers,
    installation: {
      ...drivers.installation,
      drivers: {
        ...drivers.installation.drivers,
        sandbox: select(sandboxDriver),
        credential_gateway: select(credentialGatewayDriver),
      },
    },
    sandboxDriver,
    credentialGatewayDriver,
  };
}

export function credentialGatewayFixture(): CredentialGatewayDriver {
  return {
    id: CREDENTIAL_GATEWAY_FIXTURE_ID,
    capability: "credential_gateway",
    implementation: "credential-gateway-worker-fixture",
    validateSourceConfig() {},
    async listSourceTypes() {
      return [];
    },
    async registerSource() {
      return { state: "ready" };
    },
    async updateSource() {
      return { state: "ready" };
    },
    async sourceStatus() {
      return { state: "ready" };
    },
    async removeSource() {},
    async attachForRevision() {
      return [];
    },
    async attachmentStatus() {
      return [];
    },
    async withdraw(context) {
      return { sourceId: context.sourceId, state: "pending" };
    },
  };
}

export async function admitInitialRevisionWithHarnessSource(
  fixture: RevisionFixture,
  label: string,
) {
  const { owner, candidate } = await fixture.admitInitialRevision(label, {
    agent: { auth: "credential_source" },
  });
  assertCredentialSourceAgent(owner);
  return { owner, candidate };
}

export async function agentWithHarnessAndToolSources(
  fixture: RevisionFixture,
  label: string,
  nonModelSources: number,
) {
  const owner = await fixture.agent(label, { auth: "credential_source", nonModelSources });
  assertCredentialSourceAgent(owner);
  return owner;
}

// The Agent's list starts with its Harness source; the remaining entries are tool sources.
export function toolSources(owner: CredentialSourceAgent) {
  return required(owner.credentialSources, "Agent has no credential sources").filter(
    ({ sourceId }) => sourceId !== owner.harnessAuth.sourceId,
  );
}

// The revision's queued withdrawal series (the request's, or a scheduled retry) and how long
// until the worker may claim it.
export async function queuedWithdrawal(fixture: RevisionFixture, revision: Identified) {
  const rows = await readRows(
    fixture.observerPool,
    workDelay,
    `SELECT idempotency_key,
            EXTRACT(EPOCH FROM (available_at - clock_timestamp())) * 1000 AS delay_ms
     FROM occ.controller_work
     WHERE revision_id = $1 AND agent_target = 'credentials_withdrawn' AND state = 'queued'`,
    [revision.id],
  );
  assert.equal(rows.length, 1, "a revision has at most one withdrawal series queued");
  const row = required(rows[0], "missing queued withdrawal");
  const delayMs = Number(row.delay_ms);
  assert.ok(Number.isFinite(delayMs), "withdrawal retry delay must be finite");
  return {
    id: revision.id,
    idempotencyKey: row.idempotency_key,
    delayMs,
  };
}

// A scheduled retry waits `expectedMs` from the failure that queued it, never less.
export function assertRetryDelay(series: RetrySeries, expectedMs: number) {
  assert.ok(
    series.delayMs > expectedMs - 5_000 && series.delayMs <= expectedMs + 1_000,
    `expected a retry about ${expectedMs} ms away, got ${series.delayMs} ms`,
  );
}

// Lets a scheduled retry run now instead of waiting out its delay. The worker still claims it.
export async function runScheduledRetryNow(fixture: RevisionFixture, series: WorkIdentity) {
  const updated = await makeWorkDue(fixture.observerPool, {
    key: series.idempotencyKey,
    state: "queued",
  });
  assert.equal(updated.rowCount, 1);
}

const withdrawalAuditRow = Type.Pick(Type.Object(withdrawalFields), [
  "kind",
  "actor_id",
  "outcome",
  "reason_code",
  "sources",
]);

// The withdrawal audit events in order; with `fields`, only those columns, in that key order.
export async function withdrawalAudit(
  fixture: RevisionFixture,
  ...fields: (keyof typeof withdrawalAuditRow.properties)[]
) {
  const rows = await readRows(
    fixture.observerPool,
    withdrawalAuditRow,
    `SELECT kind, actor_id, outcome, details->>'reasonCode' AS reason_code,
            details->'credentialSourceIds' AS sources
     FROM occ.audit_events
     WHERE namespace_id = $1 AND action = 'openclaw.agents.lifecycle.credentials_withdraw'
     ORDER BY occurred_at, kind DESC`,
    [fixture.namespace.id],
  );
  return fields.length === 0
    ? rows
    : rows.map((row) => Object.fromEntries(fields.map((field) => [field, row[field]] as const)));
}

// A Compute double for a gateway outage: each withdrawal fails as unreachable while
// `gateway.down` is true and is revoked once it is false. `gateway.withdrawn` lists the source
// of every call, and `beforeAnswer` runs with the call count before the gateway answers.
export function gatewayOutage(
  fixture: RevisionFixture,
  beforeAnswer: (calls: number) => Promise<void> = async () => {},
) {
  const gateway: { down: boolean; withdrawn: string[] } = { down: true, withdrawn: [] };
  const compute: ComputeDriver = {
    ...fixture.compute,
    async withdrawCredentialSource(_revision, source) {
      gateway.withdrawn.push(source.id);
      await beforeAnswer(gateway.withdrawn.length);
      if (gateway.down) {
        throw new DependencyUnavailableError("The OpenShell gateway is unreachable.");
      }
      return { sourceId: source.id, state: "revoked" };
    },
  };
  return { gateway, compute };
}

export function revokingCompute(
  fixture: RevisionFixture,
  withdrawn: WithdrawalCall[],
): ComputeDriver {
  return {
    ...fixture.compute,
    async withdrawCredentialSource(revision, source) {
      withdrawn.push([revision.id, source.id]);
      return { sourceId: source.id, state: "revoked" };
    },
  };
}

export function startWithGateway(fixture: RevisionFixture, compute: ComputeDriver) {
  return fixture.start(compute, {
    convergenceTimeoutMs: 50,
    transformDrivers: withCredentialGateway,
  });
}

// Admits `number` for `owner` with its deployment held back, as one that has not run yet.
export async function admitHeldRevision(
  fixture: RevisionFixture,
  owner: Readonly<Agent>,
  number: number,
) {
  const revision = await fixture.revision(owner, number);
  await deferWork(fixture.observerPool, revision.idempotencyKey, "1 day");
  return revision;
}

export async function currentAgent(fixture: RevisionFixture, owner: Identified) {
  return required(await fixture.currentAgent(owner), "missing Agent");
}

// The withdrawal request API's target: one of the Agent's credential sources.
export function withdrawalRequest(
  fixture: RevisionFixture,
  owner: Identified,
  credentialSourceId: string,
) {
  return { namespaceId: fixture.namespace.id, agentId: owner.id, credentialSourceId };
}

// Request one Agent source; reads and replays keep that target while naming their own principal.
export async function requestWithdrawal(
  fixture: RevisionFixture,
  owner: Identified,
  credentialSourceId: string,
  requester: string,
) {
  const target = withdrawalRequest(fixture, owner, credentialSourceId);
  const initial = await fixture.controller.withdrawAgentCredentialSource(requester, target);
  return {
    initial,
    read: (reader: string) => fixture.controller.readAgentCredentialWithdrawal(reader, target),
    replay: (requester: string) =>
      fixture.controller.withdrawAgentCredentialSource(requester, target),
  };
}

export async function startHarnessWithdrawal(
  fixture: RevisionFixture,
  owner: CredentialSourceAgent,
  active: WorkIdentity,
) {
  await fixture.work(active, "succeeded");
  const withdrawal = await requestWithdrawal(
    fixture,
    owner,
    owner.harnessAuth.sourceId,
    fixture.actor.id,
  );
  const [firstAttempt] = await withdrawalAttempts(fixture, active);
  assert.ok(firstAttempt, "missing withdrawal work");
  return { withdrawal, firstAttempt };
}

// The revision's withdrawal work rows, oldest first, each ready for fixture.work. Each row is
// one queued withdrawal; the worker may run it up to maxAttempts times (its attempt_count).
export async function withdrawalAttempts(fixture: RevisionFixture, revision: Identified) {
  const rows = await readRows(
    fixture.observerPool,
    Type.Pick(workAttempt, ["idempotency_key", "actor_id", "state"]),
    `SELECT idempotency_key, actor_id, state FROM occ.controller_work
     WHERE revision_id = $1 AND agent_target = 'credentials_withdrawn'
     ORDER BY created_at`,
    [revision.id],
  );
  return rows.map(({ idempotency_key: idempotencyKey, actor_id: actorId, state }) => ({
    id: revision.id,
    idempotencyKey,
    actorId,
    state,
  }));
}

// Each revision's withdrawal of the source (or undefined), read in one State view.
export async function withdrawalAttempt(fixture: RevisionFixture, revision: Identified) {
  const [first] = await withdrawalAttempts(fixture, revision);
  return required(first, "missing withdrawal work");
}

export function findWithdrawals(
  fixture: RevisionFixture,
  revisions: readonly Identified[],
  credentialSourceId: string,
) {
  return fixture.state.read((view) =>
    Promise.all(
      revisions.map((revision) =>
        view.credentialSources.findCredentialWithdrawal(
          fixture.namespace.id,
          revision.id,
          credentialSourceId,
        ),
      ),
    ),
  );
}

// The revision's withdrawal of the source, or undefined.
export async function findWithdrawal(
  fixture: RevisionFixture,
  revision: Identified,
  credentialSourceId: string,
) {
  const [withdrawal] = await findWithdrawals(fixture, [revision], credentialSourceId);
  return withdrawal;
}

// A pending withdrawal with no attempt outstanding, as exhausted attempts leave it.
export function recordPendingWithdrawal(
  fixture: RevisionFixture,
  owner: Identified,
  revision: Identified,
  credentialSourceId: string,
) {
  return fixture.state.transact((unit) =>
    unit.credentialSources.requestCredentialWithdrawal({
      namespaceId: fixture.namespace.id,
      agentId: owner.id,
      revisionId: revision.id,
      credentialSourceId,
      state: "pending",
      requestedBy: fixture.actor.id,
      requestedAt: new Date().toISOString(),
    }),
  );
}

// Makes the revision's one queued maintenance pass due without waiting for it to run.
export async function makeMaintenancePassDue(fixture: RevisionFixture, revision: Identified) {
  const due = await fixture.advanceMaintenance(revision);
  assert.equal(due.rowCount, 1, "one maintenance pass is queued");
  return { id: revision.id, idempotencyKey: readMaintenanceResult(due.rows[0]).idempotency_key };
}

export function waitForMaintenancePass(fixture: RevisionFixture, pass: WorkIdentity) {
  return waitFor("the maintenance pass to settle", async () => {
    const rows = await readRows(
      fixture.observerPool,
      workStateAndReason,
      `SELECT state, reason_code FROM occ.controller_work WHERE idempotency_key = $1`,
      [pass.idempotencyKey],
    );
    const row = rows[0];
    return row?.state === "succeeded" || row?.state === "failed_permanent" ? row : undefined;
  });
}

export async function runMaintenancePass(fixture: RevisionFixture, revision: Identified) {
  const pass = await makeMaintenancePassDue(fixture, revision);
  const settled = await waitForMaintenancePass(fixture, pass);
  assert.equal(settled.state, "succeeded", `maintenance ended ${settled.reason_code}`);
  return pass;
}

// Removes the Agent principal's exact grant on one credential source.
export async function removeSourceGrant(
  fixture: RevisionFixture,
  owner: Pick<Agent, "servicePrincipalId">,
  credentialSourceId: string,
) {
  const { rowCount } = await fixture.observerPool.query<never>(
    `DELETE FROM occ.iam_access_bindings
     WHERE identity_subject_id = $1 AND resource_kind = 'credential_source'
       AND resource_id = $2`,
    [owner.servicePrincipalId, credentialSourceId],
  );
  assert.equal(rowCount, 1);
}
