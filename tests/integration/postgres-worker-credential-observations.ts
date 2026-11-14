import assert from "node:assert/strict";
import type { Pool } from "pg";
import type { TestContext } from "node:test";
import { gitCommandBodies } from "../helpers/openshell-online-git-journey.mjs";
import { Type, type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { IAMPermissionSchema } from "../../packages/contracts/src/api/resources.ts";
import type { ControllerWorkState } from "../../packages/occ/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import type { RevisionFixture } from "../helpers/postgres-worker-refused-candidate.ts";

export const workState = Type.Union([
  Type.Literal("queued"),
  Type.Literal("claimed"),
  Type.Literal("succeeded"),
  Type.Literal("failed_permanent"),
]) satisfies TSchema;
const nullableText = Type.Union([Type.String(), Type.Null()]);
const attempts = Type.Integer({ minimum: 0 });
const sourceIds = Type.Array(Type.String());

export const workKey = Type.Object({ idempotency_key: Type.String() });
export const workKeyAndState = Type.Object({ ...workKey.properties, state: workState });
export const workKeyStateAndAttempts = Type.Object({
  ...workKeyAndState.properties,
  attempt_count: attempts,
});
export const workStateAndReason = Type.Object({ state: workState, reason_code: nullableText });
export const workStateAndActor = Type.Object({
  state: workState,
  actor_id: Type.String(),
  attempt_count: attempts,
});
export const workAttempt = Type.Object({
  ...workStateAndActor.properties,
  ...workKey.properties,
});
const workSnapshot = Type.Object({
  state: workState,
  claim_token: nullableText,
  attempt_count: attempts,
});
const maintenanceRow = Type.Object({
  ...workKey.properties,
  actor_id: Type.String(),
  attempt_count: attempts,
});
const outcomeRow = Type.Object({
  reason_code: nullableText,
  result_data: Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()]),
});
export const workDelay = Type.Object({
  ...workKey.properties,
  delay_ms: Type.Union([Type.String({ pattern: "^-?[0-9]+(?:\\.[0-9]+)?$" }), Type.Number()]),
});
export const counter = Type.Object({ count: Type.Integer({ minimum: 0 }) });
export const stopActorBinding = Type.Object({
  id: Type.String(),
  namespace_id: nullableText,
  resource_kind: nullableText,
  resource_id: nullableText,
  permissions: Type.Array(IAMPermissionSchema),
});
const egressInstallation = Type.Object({
  installation: Type.Object({ plan: Type.Unknown(), sandboxId: Type.String() }),
});

const auditKind = Type.Union([Type.Literal("mutation"), Type.Literal("authorization_denial")]);
const auditOutcome = Type.Union([
  Type.Literal("success"),
  Type.Literal("failure"),
  Type.Literal("denied"),
]);
export const withdrawalFields = {
  kind: auditKind,
  actor_id: Type.String(),
  outcome: auditOutcome,
  reason_code: nullableText,
  revision_id: nullableText,
  resource_id: nullableText,
  sources: Type.Union([sourceIds, Type.Null()]),
};
export type WithdrawalField = keyof typeof withdrawalFields;

export function required<Value>(value: Value | undefined, description: string): Value {
  assert.ok(value !== undefined, description);
  return value;
}

export function checkProjection<Schema extends TSchema>(
  schema: Schema,
  row: unknown,
  description: string,
): Static<Schema> {
  assert.ok(Check(schema, row), `Unexpected ${description} projection`);
  return row;
}

export async function readRows<Schema extends TSchema>(
  pool: Pick<Pool, "query">,
  schema: Schema,
  sql: string,
  parameters: unknown[],
): Promise<Static<Schema>[]> {
  const { rows } = await pool.query<Record<string, unknown>>(sql, parameters);
  return rows.map((row) => checkProjection(schema, row, "PostgreSQL row"));
}

export async function readWork(
  fixture: RevisionFixture,
  work: Parameters<RevisionFixture["work"]>[0],
  state: ControllerWorkState,
  timeout?: Parameters<RevisionFixture["work"]>[2],
) {
  return checkProjection(workSnapshot, await fixture.work(work, state, timeout), "work");
}

export async function readWorkResult(
  fixture: RevisionFixture,
  work: Parameters<RevisionFixture["workResult"]>[0],
) {
  const { rows } = await fixture.workResult(work);
  return checkProjection(outcomeRow, required(rows[0], "missing work result"), "work result");
}

export function readMaintenanceResult(row: unknown) {
  return checkProjection(maintenanceRow, row, "maintenance work");
}

export async function readEgressInstallation(fixture: RevisionFixture, revisionId: string) {
  const rows = await readRows(
    fixture.observerPool,
    egressInstallation,
    "SELECT installation FROM occ.egress_installations WHERE revision_id=$1",
    [revisionId],
  );
  assert.equal(rows.length, 1, "one egress installation belongs to the revision");
  const row = required(rows[0], "missing revision egress installation").installation;
  assert.ok(asRecord(row.plan), "egress installation has a persisted plan");
  return row;
}

export function readGitDecision(input: unknown) {
  return checkProjection(
    Type.Object({
      decision: Type.Union([Type.Literal(1), Type.Literal(2)]),
      reason_code: Type.Optional(Type.String()),
    }),
    input,
    "online Git decision",
  );
}

const gitWorld = Type.Object({
  id: Type.Optional(Type.String()),
  writes: Type.Integer({ minimum: 0 }),
  version: Type.Integer({ minimum: 0 }),
  modelFailed: Type.Boolean(),
  denyPlatformProfile: Type.Optional(Type.Boolean()),
  profileReads: Type.Array(Type.String()),
  detaches: Type.Array(Type.Unknown()),
  reports: Type.Array(Type.Tuple([Type.String(), Type.String(), Type.String()])),
  addRetainedEndpoint: Type.Function([Type.String()], Type.Void()),
});

export function readGitWorld(value: unknown) {
  return checkProjection(gitWorld, value, "controlled Gateway");
}

export async function readGitFetchCommands(context: TestContext, pushRef: string) {
  const commands = asRecord(await gitCommandBodies(context, pushRef));
  assert.ok(
    commands && Buffer.isBuffer(commands.fetch),
    "expected a Git upload-pack request Buffer",
  );
  const uploadPack = commands.uploadPack;
  assert.ok(typeof uploadPack === "function", "expected the Git upload-pack command");
  return {
    fetch: commands.fetch,
    uploadPack(input: Buffer) {
      assert.ok(Buffer.isBuffer(input), "expected a Git upload-pack input Buffer");
      const reply: unknown = uploadPack(input);
      assert.ok(Buffer.isBuffer(reply), "expected a Git upload-pack reply Buffer");
      return reply;
    },
  };
}
