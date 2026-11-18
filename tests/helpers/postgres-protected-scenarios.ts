import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { TestContext } from "node:test";
import pg from "pg";
import { Check } from "typebox/value";

import type { Agent, EgressInstallation, Namespace } from "../../packages/contracts/src/index.ts";
import { AgentSchema, CredentialSourceSchema } from "../../packages/contracts/src/api/resources.ts";
import type { InstalledDriver, OpenClawController } from "../../packages/occ/src/index.ts";
import type { OpenShellCredentialProxyDriver } from "../../apps/controller/src/drivers/egress-proxy/openshell.ts";
import { attempt, type StoredSendReceipt } from "../../packages/occ/src/egress-send-receipts.ts";
import { commitAckProxy } from "../fixtures/postgres-commit-ack-proxy.mjs";
import { isArray, isRecord } from "./egress-observation-values.ts";
import { databaseUrl } from "./postgres-database.mjs";
import { postgresApp } from "./postgres-egress-app.mjs";
import type { Resolution } from "./static-egress-exchange-wire.ts";
import type { createExchangeOrigin, createStaticEgressExchange } from "./static-egress-exchange.ts";
import { staticEgressFixture } from "./static-egress.mjs";

export type Capture = ReturnType<ReturnType<typeof createStaticEgressExchange>["capture"]>;
type WireRequest = (
  method: string,
  path: string,
  options?: { body?: unknown },
) => Promise<{ status: number; body: unknown; data: unknown }>;
type SourceAdmissionInput = {
  app: { request: WireRequest };
  agent: Pick<Agent, "id" | "configurationId">;
  namespace: Pick<Namespace, "id">;
  path: string;
  origin: string;
  countSecretReads(): number;
};
type LostDispatchOptions = {
  proxyDriverId?: string;
  preparedGitHub?: object;
  admitSource?: (
    input: SourceAdmissionInput,
  ) => Promise<{ agent: { id: string }; source: { id: string } }>;
};
type ReceiptRow = Pick<StoredSendReceipt, "outcome" | "observation" | "settled" | "feedback"> & {
  binding: Pick<
    StoredSendReceipt,
    "sender" | "instanceId" | "useId" | "attemptId" | "material" | "deadlineAt"
  >;
  dispatch: StoredSendReceipt["authorization"];
};

export async function bindRuntimeSource<Source extends { id: string }>(
  app: { request: WireRequest },
  namespace: Pick<Namespace, "id">,
  agent: Pick<Agent, "id" | "configurationId">,
  source: Source,
) {
  const bound = await app.request("PATCH", `/namespaces/${namespace.id}/agents/${agent.id}`, {
    body: {
      configurationId: agent.configurationId,
      harnessAuth: { method: "runtime" },
      credentialSources: [{ sourceId: source.id }],
    },
  });
  assert.equal(bound.status, 200);
  assert.ok(Check(AgentSchema, bound.data), "the API returned the bound Agent");
  return { agent: bound.data, source };
}

export function noMaterialSelection(result: Resolution, captured: Capture) {
  assert.equal(result.ready, undefined, "no credential-bearing selection");
  const selection = result.ready_without_material;
  assert.ok(selection, "explicit no-material selection");
  assert.ok(Buffer.isBuffer(selection.operation_handle) && selection.operation_handle.length > 0);
  assert.deepEqual(selection, {
    audience: captured.audience,
    operation_handle: selection.operation_handle,
    request_id: captured.request.context.request_id,
  });
  return selection;
}

export async function readDispatchReceipt(pool: pg.Pool, captured: Capture) {
  const {
    rows: [row],
    rowCount,
  } = await pool.query<ReceiptRow>(
    "SELECT binding, authorized_dispatch AS dispatch, outcome, observation, settled, feedback FROM occ.egress_send_receipts WHERE use_id=$1",
    [captured.request.context.request_id],
  );
  assert.equal(rowCount, 1, "only one receipt for this request");
  assert.ok(row);
  return row;
}

export function readReceiptMaterial(binding: ReceiptRow["binding"]) {
  return attempt(binding, binding.sender).material;
}

type SupervisorEvidence = { instance_id: string; enforced_capabilities: readonly string[] };

function supervisorEvidence(value: unknown): value is SupervisorEvidence {
  return (
    isRecord(value) &&
    typeof value.instance_id === "string" &&
    isArray(value.enforced_capabilities) &&
    value.enforced_capabilities.every((capability) => typeof capability === "string")
  );
}

type FixturePorts = Pick<
  ReturnType<typeof createStaticEgressExchange>,
  | "authorize"
  | "capture"
  | "permitRequest"
  | "protect"
  | "providerRequests"
  | "refusalCode"
  | "resolve"
  | "secretReads"
  | "send"
> &
  Pick<Awaited<ReturnType<typeof createExchangeOrigin>>, "setResponse"> & {
    readonly controller: OpenClawController;
    readonly egress: OpenShellCredentialProxyDriver;
    readonly installation: EgressInstallation;
    readonly installedDriver: InstalledDriver;
    readonly namespace: Namespace;
    restartAuthority(): Promise<void>;
    revoke(): Promise<void>;
    readonly agent: unknown;
    readonly source: unknown;
    readonly observed: object;
    readonly pool?: pg.Pool;
    readonly request: WireRequest;
  };

export async function postgresEgressFixture(
  t: TestContext,
  options?: LostDispatchOptions,
  transportDatabaseUrl?: string,
) {
  const fixture: FixturePorts = await staticEgressFixture(t, {
    ...options,
    appFactory: postgresApp,
    transportDatabaseUrl,
  });
  const { agent, source, observed, pool } = fixture;
  assert.ok(pool instanceof pg.Pool);
  assert.ok(Check(AgentSchema, agent));
  assert.ok(Check(CredentialSourceSchema, source));
  assert.ok("evidence" in observed && supervisorEvidence(observed.evidence));

  const { namespaceId, agentId, revisionId } = fixture.installation.plan.execution;
  const revision = await fixture.controller.transact((unit) =>
    unit.revisions.findRevision(namespaceId, agentId, revisionId),
  );
  assert.ok(revision?.egressPlan);
  // Preserve the shared fixture getters and expose the verified resource shapes.
  return Object.assign(fixture, {
    pool,
    agent,
    source,
    revision,
    supervisorEvidence: observed.evidence,
  });
}

export async function commitLossScenario(t: TestContext, options?: LostDispatchOptions) {
  assert.ok(databaseUrl, "the commit fault requires a test database");
  const proxy = await commitAckProxy(databaseUrl, { egressDispatch: true });
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const f = await postgresEgressFixture(t, options, proxy.url).finally(() => {
    // Register on failure as well as success, after the app's pool shutdown.
    // Closing the transport before the pool can terminate idle clients with an error.
    t.after(async () => {
      try {
        await pool.end();
      } finally {
        await proxy.close();
      }
    });
  });
  return {
    f,
    proxy,
    pool,
    receipt: (captured: Capture) => readDispatchReceipt(pool, captured),
    async assertLostDispatch(captured: Capture, { noMaterial = false } = {}) {
      const count = f.providerRequests.length;
      const authorizations = proxy.egress.authorizations;
      const custodyId = createHash("sha256").update(captured.response_custody).digest("hex");
      let committed: ReceiptRow | undefined;
      for (const phase of ["lose dispatch COMMIT reply", "retry after authority restart"]) {
        const result = await f.resolve(captured);
        const material = result.ready;
        const ready = noMaterial ? noMaterialSelection(result, captured) : material;
        assert.ok(ready, phase + ": select again with the original request still live");
        const permit = f.permitRequest(captured, ready, { noMaterial });
        if (!committed) {
          proxy.arm({ instanceId: f.installation.enforcement.instanceId });
        }
        const decision = await f.authorize(permit);
        // Exercise a permit if one escapes, so the origin count is an independent observation.
        if (decision.allowed) {
          const outbound = noMaterial ? { credential_headers: [] } : material;
          assert.ok(outbound);
          await f.send(captured, outbound);
        }
        assert.ok(decision.refused, phase);
        assert.equal(proxy.observedCommit, true, "consumed the server's actual dispatch COMMIT");
        assert.equal(f.providerRequests.length, count, phase + ": no request reached the origin");
        assert.equal(
          proxy.egress.authorizations,
          authorizations + 1,
          "exactly one durable dispatch",
        );
        const row = await readDispatchReceipt(pool, captured);
        if (committed) {
          assert.deepEqual(row, committed, "restart must not replay or rewrite uncertain dispatch");
        } else {
          assert.deepEqual(row.outcome, { kind: "uncertain", dispatch: "possible" });
          assert.equal(row.observation, null);
          assert.ok(row.dispatch, "the exact dispatch was durably authorized");
          assert.equal(row.dispatch.association.custodyId, custodyId);
          assert.equal(
            row.dispatch.injectionDigest,
            permit.credential_headers_sha256.toString("hex"),
          );
          committed = row;
          await f.restartAuthority();
        }
      }
    },
  };
}
