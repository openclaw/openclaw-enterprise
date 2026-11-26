import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRevision } from "../../packages/contracts/src/index.ts";
import { PostgresPlatformState } from "../../packages/occ/src/index.ts";
import { validHarnessAuthSnapshot } from "../../packages/occ/src/state/platform-state.ts";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import { postgresApp } from "../helpers/postgres-egress-app.mjs";
import { protectedMetadataFixture } from "../helpers/static-egress.mjs";

type ProtectedAdmittedSpec = {
  harness_auth: AgentRevision["harnessAuth"] & { protectedExecutionVersion: number };
  egress_plan: NonNullable<AgentRevision["egressPlan"]>;
  execution_admission: AgentRevision["executionAdmission"];
};

test(
  "PostgreSQL preserves the admitted Driver, rejects draft-only protected v2 and refuses missing or mixed-version custody",
  requiresPostgres,
  async (t) => {
    let application: Awaited<ReturnType<typeof postgresApp>> | undefined;
    const f = await protectedMetadataFixture(t, {
      async appFactory(context, options) {
        application = await postgresApp(context, options);
        return application;
      },
    });
    assert.ok(application);
    const { pool } = application;
    const state = new PostgresPlatformState(pool);
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
    } = await pool.query<{ admitted_spec: ProtectedAdmittedSpec }>(
      "SELECT admitted_spec FROM occ.agent_revisions WHERE id = $1",
      [revision.id],
    );
    assert.ok(row);
    const insert = (spec: object) =>
      pool.query<never>(
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
