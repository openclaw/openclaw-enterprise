import assert from "node:assert/strict";
import type { ComputeDriver } from "../../packages/contracts/src/index.ts";
import type { ControllerWorkerOptions } from "../../apps/controller/src/worker.ts";
import type { createWorkerRevisionFixtures } from "./postgres-worker-revision-fixture.mjs";
import {
  denyDeploy as denyDeployFixture,
  refusedStopWaits as refusedStopWaitsFixture,
  startRefusedCandidate as startRefusedCandidateFixture,
} from "./postgres-worker-refused-candidate.mjs";

type RevisionFixture = Awaited<
  ReturnType<ReturnType<typeof createWorkerRevisionFixtures>["setup"]>
>;
type WorkerEvent = Parameters<NonNullable<ControllerWorkerOptions["emit"]>>[0];
type Revision = Parameters<ComputeDriver["stopRevision"]>[0];
type WorkIdentity = { id: string; idempotencyKey: string };
type OwnerIdentity = { id: string };
type ComputeOperations = Pick<ComputeDriver, "prepareRevision" | "stopRevision" | "retireRevision">;
type RefusedOptions = Pick<
  NonNullable<Parameters<typeof startRefusedCandidateFixture>[2]>,
  "refuse"
> & {
  stopRevision?: (revision: Revision) => Promise<void> | undefined;
  ready?: (revision: Revision) => boolean;
  emit?: NonNullable<ControllerWorkerOptions["emit"]>;
  refusing?: () => boolean;
  candidateReady?: () => boolean;
  startOptions?: Pick<NonNullable<Parameters<RevisionFixture["start"]>[1]>, "transformDrivers"> &
    Pick<ControllerWorkerOptions, "convergenceTimeoutMs">;
};

// The JavaScript fixture supports these callbacks but infers narrower types from its defaults.
const startFixture = startRefusedCandidateFixture as (
  fixture: RevisionFixture,
  label: string,
  options?: RefusedOptions,
) => Promise<unknown>;

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function workIdentity(value: unknown): WorkIdentity {
  const work = record(value);
  assert.equal(typeof work.id, "string");
  assert.equal(typeof work.idempotencyKey, "string");
  return value as WorkIdentity;
}

function computeOperations(value: unknown): ComputeOperations {
  const compute = record(value);
  for (const method of ["prepareRevision", "stopRevision", "retireRevision"] as const) {
    assert.equal(typeof compute[method], "function", `Missing fixture Compute method ${method}`);
  }
  return value as ComputeOperations;
}

export async function startRefusedCandidate(
  fixture: RevisionFixture,
  label: string,
  options?: RefusedOptions,
) {
  const result = record(await startFixture(fixture, label, options));
  const owner = record(result.owner);
  assert.equal(typeof owner.id, "string");
  const driver = record(result.driver);
  const { running, count, preparations } = driver;
  assert.ok(running instanceof Set && [...running].every((id: unknown) => typeof id === "string"));
  assert.ok(typeof count === "function" && typeof preparations === "function");
  const admittedAt = result.admittedAt;
  assert.ok(typeof admittedAt === "number");
  return {
    // Fixture callers use the original owner and work objects, including fields they own.
    owner: owner as OwnerIdentity,
    first: workIdentity(result.first),
    replacement: workIdentity(result.replacement),
    compute: computeOperations(result.compute),
    driver: {
      running: running as ReadonlySet<string>,
      compute: computeOperations(driver.compute),
      count(revision: OwnerIdentity): number {
        const value: unknown = count(revision);
        assert.ok(typeof value === "number");
        return value;
      },
      preparations(revision: OwnerIdentity): number {
        const value: unknown = preparations(revision);
        assert.ok(typeof value === "number");
        return value;
      },
    },
    admittedAt,
  };
}

export const denyDeploy: (fixture: RevisionFixture, owner: OwnerIdentity) => Promise<unknown> =
  denyDeployFixture;

export function refusedStopWaits(events: WorkerEvent[], candidate: WorkIdentity): WorkerEvent[] {
  const waits: unknown = refusedStopWaitsFixture(events, candidate);
  assert.ok(
    Array.isArray(waits) &&
      waits.every((value: unknown): value is WorkerEvent =>
        events.some((event) => event === value),
      ),
  );
  return waits;
}
