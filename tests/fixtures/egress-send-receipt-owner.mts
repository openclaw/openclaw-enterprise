// A disposable caller process. The parent consumes PostgreSQL's real COMMIT reply,
// then recovers the exact attempt only after this process and its pool have exited.
import assert from "node:assert/strict";
import pg from "pg";
import type { EgressRef } from "../../packages/contracts/src/index.ts";
import {
  EgressSendReceipts,
  attempt,
  object,
  outcome,
  type SendAttempt,
  type SendOutcome,
} from "../../packages/occ/src/egress-send-receipts.ts";
import {
  PostgresCommitOutcomeUnknownError,
  PostgresPlatformState,
} from "../../packages/occ/src/state/postgres-state.ts";

type Rejection = Parameters<EgressSendReceipts["record"]>[3];
export type SendReceiptOwnerCommand =
  | [method: "begin", sender: EgressRef, input: SendAttempt]
  | [
      method: "record",
      sender: EgressRef,
      input: SendAttempt,
      result: SendOutcome,
      rejection?: Rejection,
    ];

function parseSender(value: unknown): EgressRef {
  const sender = object(value);
  const { id, generation } = sender;
  assert.ok(
    Object.keys(sender).length === 2 &&
      typeof id === "string" &&
      id.length > 0 &&
      typeof generation === "number" &&
      Number.isSafeInteger(generation) &&
      generation >= 1,
    "Expected an exact sender reference",
  );
  return { id, generation };
}

function parseCommand(
  method: string | undefined,
  serialized: string | undefined,
): SendReceiptOwnerCommand {
  assert.ok(method === "begin" || method === "record", "Expected begin or record");
  assert.ok(serialized, "Expected receipt arguments");
  const value: unknown = JSON.parse(serialized);
  assert.ok(Array.isArray(value), "Expected a receipt argument tuple");
  const args: readonly unknown[] = value;
  if (method === "begin") {
    assert.equal(args.length, 2, "Expected sender and attempt");
    const sender = parseSender(args[0]);
    return [method, sender, attempt(args[1], sender)];
  }
  assert.ok(
    args.length === 3 || args.length === 4,
    "Expected sender, attempt, result and optional feedback",
  );
  const sender = parseSender(args[0]);
  const input = attempt(args[1], sender);
  const result = outcome(args[2]);
  if (args.length === 3) {
    return [method, sender, input, result];
  }
  const feedback = object(args[3]);
  const { classification, evidence } = feedback;
  assert.ok(
    Object.keys(feedback).length === 2 &&
      classification === "credential_rejected" &&
      Object.hasOwn(feedback, "evidence"),
    "Expected credential rejection evidence",
  );
  // The receipt store validates the evidence shape and its binding to this attempt.
  return [method, sender, input, result, { classification, evidence }];
}

const [method, sender, input, result, rejection] = parseCommand(process.argv[2], process.argv[3]);
const connectionString = process.env.OCC_TEST_DATABASE_URL;
assert.ok(connectionString, "Expected the disposable PostgreSQL connection");
const state = new PostgresPlatformState(new pg.Pool({ connectionString, max: 1 }));
try {
  const receipts = new EgressSendReceipts(state);
  await assert.rejects(
    method === "begin"
      ? receipts.begin(sender, input)
      : receipts.record(sender, input, result, rejection),
    PostgresCommitOutcomeUnknownError,
  );
} finally {
  await state.close();
}
