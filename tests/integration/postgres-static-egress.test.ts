import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import {
  commitLossScenario,
  postgresEgressFixture,
  readDispatchReceipt,
  readReceiptMaterial,
} from "../helpers/postgres-protected-scenarios.ts";
import { parseJson } from "../helpers/egress-observation-values.ts";
import type { AgentRevision, AuditEvent } from "../../packages/contracts/src/index.ts";
import { PostgresPlatformState } from "../../packages/occ/src/index.ts";
import { validHarnessAuthSnapshot } from "../../packages/occ/src/state/platform-state.ts";

type AuditDetailsRow = { details: NonNullable<AuditEvent["details"]> };
type AuditRow = AuditDetailsRow & {
  actor_id: AuditEvent["actorId"];
  resource_id: string;
  outcome: AuditEvent["outcome"];
};
type ProtectedAdmittedSpec = {
  harness_auth: AgentRevision["harnessAuth"] & { protectedExecutionVersion: number };
  egress_plan: NonNullable<AgentRevision["egressPlan"]>;
  execution_admission: AgentRevision["executionAdmission"];
};

test(
  "losing the exact authorized-dispatch COMMIT reply yields no permit or origin, also after restart",
  { ...requiresPostgres, timeout: 60_000 },
  async (t) => {
    const { f, assertLostDispatch } = await commitLossScenario(t);
    const sibling = f.capture();
    const { ready } = await f.resolve(sibling);
    assert.ok(ready);
    assert.ok((await f.authorize(f.permitRequest(sibling, ready))).allowed);
    const normal = await f.protect(sibling, await f.send(sibling, ready));
    assert.ok("response_complete" in normal && normal.response_complete);
    assert.equal(f.providerRequests.length, 1);

    await assertLostDispatch(f.capture());
  },
);

test(
  "PostgreSQL egress admission, installation and selected-version fencing persist with fresh native IAM checks",
  requiresPostgres,
  async (t) => {
    const f = await postgresEgressFixture(t);
    const readsBeforeRefusal = f.secretReads;
    const marker = `schema-private-${randomUUID()}`;
    const valid = { model: "fixture-model", input: "hello", store: false };
    // The real signed TLS exchange must retain an attributable, value-free reason
    // before any credential read. Missing input wins over an invalid store value.
    const providers = f.egress.sourceControl.providers;
    const index = providers.findIndex((entry) => entry.sourceType.type === "openai");
    const original = providers[index];
    assert.ok(original);
    // A registered classifier may mutate its borrowed request. Attribution must
    // still use the original signed ID, never this unvalidated replacement.
    const observedProvider: typeof original = {
      ...original,
      classify(route, request, refused) {
        return original.classify(route, request, (rule) => {
          Reflect.set(request, "id", marker);
          refused?.(rule);
        });
      },
    };
    assert.ok(Reflect.set(providers, index, observedProvider));
    const restoreProvider = () => {
      assert.ok(Reflect.set(providers, index, original));
    };
    t.after(restoreProvider);
    for (const [body, rule] of [
      [{ model: "fixture-model", store: true }, 3],
      [{ ...valid, store: true }, 4],
      [{ ...valid, reasoning: { effort: marker } }, 9],
      [{ ...valid, [marker]: marker }, 1],
    ] as const) {
      const rejected = f.capture(body);
      const { refused } = await f.resolve(rejected);
      assert.equal(refused?.code, f.refusalCode("DENIED"));
      const audit = await f.pool.query<AuditRow>(
        "SELECT * FROM occ.audit_events WHERE namespace_id=$1 AND action='openclaw.egress.authorize' AND details->>'requestId' IN ($2, $3)",
        [f.namespace.id, rejected.request.context.request_id, marker],
      );
      assert.equal(JSON.stringify(audit.rows).includes(marker), false);
      assert.deepEqual(
        audit.rows.map((row) => {
          const details = { ...row.details };
          delete details.__occAuditMetadata;
          return { actor: row.actor_id, resource: row.resource_id, outcome: row.outcome, details };
        }),
        [
          {
            actor: f.agent.servicePrincipalId,
            resource: f.source.id,
            outcome: "denied",
            details: {
              code: "unsupported_operation",
              phase: "before_access",
              requestId: rejected.request.context.request_id,
              revisionId: f.revision.id,
              classificationRule: rule,
            },
          },
        ],
      );
      assert.equal(f.secretReads, readsBeforeRefusal);
      assert.equal(f.providerRequests.length, 0);
    }
    restoreProvider();
    const freshState = new PostgresPlatformState(f.pool);
    const plan = f.revision.egressPlan;
    const installed = await freshState.read((view) =>
      view.credentialSources.findEgressInstallation(
        f.egress.sourceControl.sender.id,
        f.installation.sandboxId,
      ),
    );
    assert.ok(installed);
    assert.deepEqual(installed.plan, plan);
    // Reconciliation must not move the recorded installation time or break captured requests.
    await f.controller.transact((unit) =>
      unit.credentialSources.recordEgressInstallation({
        ...installed,
        installedAt: new Date().toISOString(),
      }),
    );
    assert.deepEqual(
      await freshState.read((view) =>
        view.credentialSources.findEgressInstallation(installed.sender.id, installed.sandboxId),
      ),
      installed,
    );
    // Re-observation cannot turn a replacement supervisor into the previously admitted execution.
    await assert.rejects(
      f.controller.transact((unit) =>
        unit.credentialSources.recordEgressInstallation({
          ...installed,
          enforcement: {
            ...installed.enforcement,
            instanceId: "10000000-0000-4000-8000-000000000001",
          },
        }),
      ),
      { name: "ResourceStateConflictError" },
    );
    await assert.rejects(
      f.pool.query<never>(
        "UPDATE occ.credential_sources SET egress = jsonb_set(egress, '{secret,namespaceId}', '\"other-namespace\"') WHERE id = $1",
        [f.source.id],
      ),
      { code: "23514" },
    );
    await assert.rejects(
      f.controller.transact((unit) =>
        unit.credentialSources.recordEgressInstallation({
          ...installed,
          sandboxId: "another-execution",
        }),
      ),
      // A second Sandbox for one revision hits UNIQUE (namespace_id, revision_id): the same
      // state conflict the memory store raises, not the generic identity collision.
      {
        name: "ResourceStateConflictError",
        message: "Egress revision already has an installed execution.",
      },
    );
    const capture = f.capture();
    const ready = (await f.resolve(capture)).ready;
    assert.ok(ready);
    const acceptedAudit = await f.pool.query<Pick<AuditRow, "outcome" | "details">>(
      "SELECT outcome, details FROM occ.audit_events WHERE namespace_id=$1 AND action='openclaw.egress.authorize' AND details->>'requestId'=$2",
      [f.namespace.id, capture.request.context.request_id],
    );
    for (const row of acceptedAudit.rows) {
      assert.notEqual(row.outcome, "denied");
      assert.equal(Object.hasOwn(row.details, "classificationRule"), false);
    }
    assert.ok((await f.authorize(f.permitRequest(capture, ready))).allowed);
    f.setResponse({
      status: 401,
      body: {
        error: {
          code: "invalid_api_key",
          type: "invalid_request_error",
          message: "Invalid credential",
        },
      },
    });
    await f.protect(capture, await f.send(capture, ready));
    const { binding } = await readDispatchReceipt(f.pool, capture);
    const evidence = readReceiptMaterial(binding);
    assert.ok(evidence?.kind === "static");
    assert.deepEqual(parseJson(ready.evidence.authority_evidence.toString("utf8")), evidence);
    assert.equal(
      await freshState.read((view) => view.credentialSources.isEgressMaterialRejected(evidence)),
      true,
    );
    const pending = f.capture();
    const next = (await f.resolve(pending)).ready;
    assert.ok(next);
    await f.revoke();
    assert.ok((await f.authorize(f.permitRequest(pending, next))).refused);
    const denials = await f.pool.query<AuditDetailsRow>(
      "SELECT details FROM occ.audit_events WHERE action = 'openclaw.egress.authorize' AND namespace_id = $1",
      [f.namespace.id],
    );
    assert.ok(
      denials.rows.some(
        (row) => row.details.code === "unauthorized" && row.details.phase === "before_send",
      ),
    );
    assert.equal(f.providerRequests.length, 1);
  },
);

test(
  "PostgreSQL preserves the admitted Driver, rejects draft-only protected v2 and refuses missing or mixed-version custody",
  requiresPostgres,
  async (t) => {
    const f = await postgresEgressFixture(t);
    const state = new PostgresPlatformState(f.pool);
    const revision = await state.read((view) =>
      view.revisions.findRevision(f.namespace.id, f.agent.id, f.revision.id),
    );
    assert.ok(revision?.egressPlan);
    assert.deepEqual(revision.executionAdmission, { version: 3, mode: "protected" });
    assert.deepEqual(revision.egressPlan.driver, f.installedDriver.ref);
    for (const executionAdmission of [
      undefined,
      { version: 1, mode: "protected" },
      { version: 2, mode: "protected" },
      { version: 2, mode: "unprotected" },
    ]) {
      await assert.rejects(
        state.transact((unit) =>
          // @ts-expect-error Simulate a writer with no admission or an unsupported/mixed admission.
          unit.revisions.createRevision({ ...revision, executionAdmission }),
        ),
        {
          name: "ScopeViolationError",
          message: "The AgentRevision execution admission is missing or inconsistent.",
        },
      );
    }
    const {
      rows: [row],
    } = await f.pool.query<{ admitted_spec: ProtectedAdmittedSpec }>(
      "SELECT admitted_spec FROM occ.agent_revisions WHERE id = $1",
      [revision.id],
    );
    assert.ok(row);
    const insert = (spec: object) =>
      f.pool.query<never>(
        `
    INSERT INTO occ.agent_revisions (id, namespace_id, agent_id, revision_number, backend_id, admitted_spec, admitted_at)
    SELECT id, namespace_id, agent_id, revision_number, backend_id, $2::jsonb, admitted_at
    FROM occ.agent_revisions WHERE id = $1 ON CONFLICT DO NOTHING`,
        [revision.id, JSON.stringify(spec)],
      );
    // PostgreSQL checks constraints before resolving the duplicate key. The original
    // immutable row stays intact; the attempted old writer must still be rejected.
    const {
      execution_admission: admission,
      egress_plan: plan,
      harness_auth: fencedAuth,
      ...savedFields
    } = row.admitted_spec;
    const missing = { ...savedFields, egress_plan: plan, harness_auth: fencedAuth };
    const protectedWithoutPlan = {
      ...savedFields,
      execution_admission: admission,
      harness_auth: fencedAuth,
    };
    const { protectedExecutionVersion, ...unfencedAuth } = fencedAuth;
    assert.equal(protectedExecutionVersion, revision.executionAdmission.version);
    assert.equal(
      validHarnessAuthSnapshot(fencedAuth, f.namespace.id),
      false,
      "v1 reader must refuse protected auth",
    );
    assert.equal(
      validHarnessAuthSnapshot(unfencedAuth, f.namespace.id),
      true,
      "control must pass the same v1 validator",
    );
    const { driver: _driver, ...v2Plan } = row.admitted_spec.egress_plan;
    const v2 = {
      ...row.admitted_spec,
      egress_plan: v2Plan,
      execution_admission: { version: 2, mode: "protected" },
      harness_auth: { ...fencedAuth, protectedExecutionVersion: 2 },
    };
    // Protected v2 never existed on main. Neither it nor a mixed reader fence is admitted.
    for (const spec of [
      v2,
      { ...row.admitted_spec, harness_auth: unfencedAuth },
      { ...protectedWithoutPlan, execution_admission: { version: 2, mode: "unprotected" } },
      missing,
      { ...row.admitted_spec, execution_admission: { version: 4, mode: "protected" } },
      { ...row.admitted_spec, execution_admission: v2.execution_admission },
      { ...row.admitted_spec, egress_plan: v2Plan },
      { ...row.admitted_spec, harness_auth: v2.harness_auth },
      { ...v2, egress_plan: row.admitted_spec.egress_plan },
      { ...row.admitted_spec, execution_admission: { version: 2, mode: "unprotected" } },
      protectedWithoutPlan,
    ]) {
      await assert.rejects(insert(spec), {
        code: "23514",
        constraint: "agent_revisions_execution_admission",
      });
    }
    // Both modes have schema meaning. Empty protected routes are valid deny-all
    // intent; the shipped Compute cutoff separately refuses their execution.
    await insert({
      ...row.admitted_spec,
      egress_plan: { ...row.admitted_spec.egress_plan, routes: [] },
    });
    await insert({
      ...protectedWithoutPlan,
      harness_auth: unfencedAuth,
      execution_admission: { version: 2, mode: "unprotected" },
    });
  },
);
