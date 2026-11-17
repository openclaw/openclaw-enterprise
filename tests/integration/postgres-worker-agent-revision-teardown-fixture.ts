import assert from "node:assert/strict";
import type { ControllerWorkerOptions } from "../../apps/controller/src/worker.ts";
import type { createWorkerRevisionFixtures } from "../helpers/postgres-worker-revision-fixture.mjs";

export type RevisionSetup = ReturnType<typeof createWorkerRevisionFixtures>["setup"];

type EmittedEvent = Parameters<NonNullable<ControllerWorkerOptions["emit"]>>[0];
export type WorkerEvent = EmittedEvent & {
  readonly event?: string;
  readonly workId?: string;
  readonly revisionId?: string;
  readonly outcome?: string;
  readonly code?: string;
  readonly cause?: string;
};

export function readWorkerEvent(event: EmittedEvent): WorkerEvent {
  for (const key of ["event", "workId", "revisionId", "outcome", "code", "cause"]) {
    assert.ok(
      event[key] === undefined || typeof event[key] === "string",
      `invalid worker event field ${key}`,
    );
  }
  return event;
}

export function required<T>(value: T | undefined, description: string): T {
  assert.ok(value !== undefined, `expected ${description}`);
  return value;
}
