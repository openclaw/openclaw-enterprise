// A disposable caller process. The parent consumes PostgreSQL's real COMMIT reply,
// then recovers the exact attempt only after this process and its pool have exited.
import assert from "node:assert/strict";
import pg from "pg";
import { EgressSendReceipts } from "../../packages/occ/src/egress-send-receipts.ts";
import {
  PostgresCommitOutcomeUnknownError,
  PostgresPlatformState,
} from "../../packages/occ/src/state/postgres-state.ts";

const [method, serialized] = process.argv.slice(2);
assert.ok(method === "begin" || method === "record");
const state = new PostgresPlatformState(
  new pg.Pool({ connectionString: process.env.OCC_TEST_DATABASE_URL, max: 1 }),
);
try {
  const receipts = new EgressSendReceipts(state);
  await assert.rejects(
    receipts[method](...JSON.parse(serialized)),
    PostgresCommitOutcomeUnknownError,
  );
} finally {
  await state.close();
}
