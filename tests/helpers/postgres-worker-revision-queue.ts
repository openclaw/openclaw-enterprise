import assert from "node:assert/strict";
import type { Pool, QueryResult } from "pg";
import { waitFor } from "./wait-for.mjs";

type WorkPool = Pick<Pool, "query">;
type WorkParameter = string | string[];
type WorkFilters = {
  key?: string;
  keys?: string[];
  keyLike?: string;
  namespaceId?: string;
  revisionId?: string | undefined;
  agentTarget?: string;
  state?: string;
  claimToken?: string;
};
type WorkMatch = string | string[] | WorkFilters;

interface WorkIdentity {
  idempotencyKey: string;
}

interface RevisionIdentity {
  id: string;
}

interface AgentRevisionIdentity extends RevisionIdentity {
  agentId: string;
}

interface ObserverFixture {
  observerPool: WorkPool;
}

interface RevisionQueueFixture<Revision extends RevisionIdentity> extends ObserverFixture {
  advanceMaintenance(revision: Revision): Promise<unknown>;
}

interface WorkStateRow {
  state: string;
}

interface MaintenanceBusyRow {
  busy: boolean;
}

interface WorkEvent {
  event?: string;
  workId?: string;
}

interface WorkOutcomeEvent extends WorkEvent {
  outcome?: string;
}

type WaitDescription = Parameters<typeof waitFor>[0];
type WaitOptions = Parameters<typeof waitFor>[2];
type WaitReader<Value> = Parameters<typeof waitFor<Value>>[1];

// The worker emits worker.completed after its queue transaction commits, so another
// connection can see the committed Work state first. Wait for the event instead of
// reading the event list once.
export function completion<Event>(
  events: readonly Event[],
  description: WaitDescription,
  predicate: (event: Event, index: number, events: readonly Event[]) => unknown,
) {
  return waitFor(description, async () => events.find(predicate));
}

// The database can say a work item ended before its worker.completed event arrives (finding
// 1607). Wait for the work's first pass with `outcome`, check it is the last pass observed, and
// return every pass of the work. A revision pass whose pointer commit lost a race logs the
// retry it committed (`ACTIVE_REVISION_CHANGED`, finding 1611), so its later pass is the end.
export async function completedPasses<Event extends WorkOutcomeEvent>(
  events: readonly Event[],
  work: WorkIdentity,
  outcome = "success",
) {
  const ended = await completion(
    events,
    `work ${work.idempotencyKey} to end with outcome ${outcome}`,
    (event) =>
      event.event === "worker.completed" &&
      event.workId === work.idempotencyKey &&
      event.outcome === outcome,
  );
  const passes = events.filter(
    ({ event, workId }) => event === "worker.completed" && workId === work.idempotencyKey,
  );
  assert.equal(passes.at(-1), ended);
  return passes;
}

// Work due-time and lease helpers. Tests move a Work item's due time or lease end instead of
// waiting out a cadence, backoff or lease; the worker still claims and runs each pass. `match`
// names the rows exactly as the caller would in SQL, and every filter must hold:
//   "key"             idempotency_key = key
//   ["key", ...]      idempotency_key = ANY(keys)
//   { key, keys, keyLike, namespaceId, revisionId, agentTarget, state, claimToken }
// An empty filter object, an unknown filter or an undefined value is refused, so a helper never
// updates more rows than its caller names.
const workColumns: Partial<Record<string, (parameter: number) => string>> = {
  key: (n) => `idempotency_key = $${n}`,
  keys: (n) => `idempotency_key = ANY($${n}::text[])`,
  keyLike: (n) => `idempotency_key LIKE $${n}`,
  namespaceId: (n) => `namespace_id = $${n}`,
  revisionId: (n) => `revision_id = $${n}`,
  agentTarget: (n) => `agent_target = $${n}`,
  state: (n) => `state = $${n}`,
  claimToken: (n) => `claim_token = $${n}::uuid`,
};

function updateWork(
  pool: WorkPool,
  set: string,
  match: WorkMatch,
  setParams: WorkParameter[] = [],
) {
  const filters: WorkFilters =
    typeof match === "string" ? { key: match } : Array.isArray(match) ? { keys: match } : match;
  if (filters === null || typeof filters !== "object") {
    throw new Error(`Unsupported Work match ${match}`);
  }
  const params = [...setParams];
  const where = Object.entries<WorkParameter | undefined>(filters).map(([name, value]) => {
    const column = workColumns[name];
    if (column === undefined || value === undefined) {
      throw new Error(`Unsupported Work match ${name}=${value}`);
    }
    params.push(value);
    return column(params.length);
  });
  if (where.length === 0) {
    throw new Error("A Work match needs at least one filter");
  }
  return pool.query<never>(
    `UPDATE occ.controller_work SET ${set} WHERE ${where.join(" AND ")}`,
    params,
  );
}

// Make the matched Work due now.
export function makeWorkDue(pool: WorkPool, match: WorkMatch) {
  return updateWork(pool, "available_at = clock_timestamp()", match);
}

// Make the matched Work due `delay` (an interval such as "1 hour") from now.
export function deferWork(pool: WorkPool, match: WorkMatch, delay = "1 hour") {
  return updateWork(pool, "available_at = clock_timestamp() + $1::interval", match, [delay]);
}

// End the matched Work's lease a second ago, as if its worker had died, so another worker can
// reclaim it without waiting out the lease.
export function expireWorkLease(pool: WorkPool, match: WorkMatch) {
  return updateWork(pool, "lease_expires_at = clock_timestamp() - interval '1 second'", match);
}

// Make the queued Work whose idempotency key matches `keys` (a LIKE pattern) due now, for
// tests that wait on a pass but not on its cadence or backoff. Only due times change: claims
// stay real, and the worker still claims and runs each pass.
export async function makeQueuedWorkDue(fixture: ObserverFixture, keys: string) {
  await makeWorkDue(fixture.observerPool, { state: "queued", keyLike: keys });
}

// Model the next cleanup interval without waiting an hour for the boundary
// Driver. Change only this revision's queued due times; claims remain real.
export async function advanceCleanupRetries(fixture: ObserverFixture, revision: RevisionIdentity) {
  await makeQueuedWorkDue(fixture, `agent_revision:${revision.id}:repository_cleanup:%`);
}

// Make this revision's queued maintenance and cleanup passes due now, for tests that wait on
// a pass but not on its cadence. The worker still claims and runs each pass. A pass that runs
// early schedules the next one a full interval later, so later waits on these cadences must
// advance them too.
export async function advanceRevisionQueue<Revision extends RevisionIdentity>(
  fixture: RevisionQueueFixture<Revision>,
  revision: Revision,
) {
  await fixture.advanceMaintenance(revision);
  await advanceCleanupRetries(fixture, revision);
}

// Polls like waitFor, making this revision's queued passes due after each miss.
export function waitForRevisionPass<Revision extends RevisionIdentity, Value>(
  description: WaitDescription,
  fixture: RevisionQueueFixture<Revision>,
  revision: Revision,
  read: WaitReader<Value>,
  options?: WaitOptions,
) {
  return waitAdvancing(description, read, () => advanceRevisionQueue(fixture, revision), options);
}

// Polls like waitFor, making `work`'s own queued retry due after each miss, for waits on its
// retries (a refused candidate's stop, a dependency outage) but not on their backoff.
export function waitForWorkPass<Value>(
  description: WaitDescription,
  fixture: ObserverFixture,
  work: WorkIdentity,
  read: WaitReader<Value>,
  options?: WaitOptions,
) {
  return waitAdvancing(
    description,
    read,
    () => makeQueuedWorkDue(fixture, work.idempotencyKey),
    options,
  );
}

// Waits like the fixture's work() for `work` to reach `state`, making its queued retries due.
export function waitForWorkStateDue(
  fixture: ObserverFixture,
  work: WorkIdentity,
  state: string,
  timeoutMs: WaitOptions = 30_000,
) {
  return waitForWorkPass(
    `work ${work.idempotencyKey} to become ${state}`,
    fixture,
    work,
    async () => {
      const { rows } = await fixture.observerPool.query<WorkStateRow>(
        "SELECT state FROM occ.controller_work WHERE idempotency_key = $1",
        [work.idempotencyKey],
      );
      return rows[0]?.state === state ? rows[0] : undefined;
    },
    timeoutMs,
  );
}

function waitAdvancing<Value>(
  description: WaitDescription,
  read: WaitReader<Value>,
  advance: () => Promise<void>,
  options?: WaitOptions,
) {
  return waitFor(
    description,
    async () => {
      const value = await read();
      if (value === undefined) {
        await advance();
      }
      return value;
    },
    options,
  );
}

// For a test that changes authority between worker passes rather than during one. A pass
// checks authority before it prepares, so a pass already running when the change commits may
// still prepare after it. That is safe: later Git use is authorized per request, and claims are
// serial per Agent, so the cleanup that reduces access runs after that pass. Stopping the worker
// also drains passes; this keeps it running. Defer this revision's queued maintenance and wait
// until no pass of its Agent is claimed and neither of its preparing passes (reconcile,
// maintenance) is due. waitForRevisionPass or advanceRevisionQueue makes the deferred pass due.
export async function settleRevisionMaintenance(
  fixture: ObserverFixture,
  revision: AgentRevisionIdentity,
  options: WaitOptions = 25_000,
) {
  const maintenance = `agent_revision:${revision.id}:maintenance:%`;
  await waitFor(
    "no worker pass in flight for the Agent and its maintenance deferred",
    async () => {
      await deferWork(fixture.observerPool, {
        revisionId: revision.id,
        state: "queued",
        keyLike: maintenance,
      });
      // One snapshot: a pass that ended before it left only deferred maintenance behind.
      // SELECT EXISTS always returns exactly one row.
      const {
        rows: [{ busy }],
      } = (await fixture.observerPool.query<MaintenanceBusyRow>(
        `SELECT EXISTS (
           SELECT 1 FROM occ.controller_work
           WHERE (state = 'claimed' AND agent_id = $4)
              OR (revision_id = $1 AND state = 'queued'
                  AND (idempotency_key LIKE $2 OR idempotency_key = $3)
                  AND available_at < clock_timestamp() + interval '30 minutes')
         ) AS busy`,
        [revision.id, maintenance, `agent_revision:${revision.id}:reconcile`, revision.agentId],
      )) as QueryResult<MaintenanceBusyRow> & { rows: [MaintenanceBusyRow] };
      return busy ? undefined : true;
    },
    options,
  );
}

// After settleRevisionMaintenance and then the authority change, make this revision's deferred
// maintenance due and wait until one of its passes ends. Given that order, the pass started
// after the change, so a test can then check it did not prepare. `events` collects the worker's
// emitted events.
export function nextMaintenancePass<Revision extends RevisionIdentity, Event extends WorkEvent>(
  fixture: RevisionQueueFixture<Revision>,
  revision: Revision,
  events: readonly Event[],
  options: WaitOptions = 25_000,
) {
  const maintenance = `agent_revision:${revision.id}:maintenance:`;
  const seen = events.length;
  return waitForRevisionPass(
    "a maintenance pass that started after the change to end",
    fixture,
    revision,
    async () =>
      events
        .slice(seen)
        .find(
          ({ event, workId }) =>
            event === "worker.completed" &&
            typeof workId === "string" &&
            workId.startsWith(maintenance),
        ),
    options,
  );
}

// Only after every fixture worker has stopped: a pass that stop interrupted keeps its claim
// until the lease ends. Expire this revision's claims instead of waiting out the lease.
export async function expireStoppedClaims(fixture: ObserverFixture, revision: RevisionIdentity) {
  await expireWorkLease(fixture.observerPool, { state: "claimed", revisionId: revision.id });
}
