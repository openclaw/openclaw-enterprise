import type {
  OpenShellGitMaterialReference,
  OpenShellGitRouteRecord,
  OpenShellGitRouteStore,
} from "../../apps/controller/src/drivers/egress-proxy/openshell-git-route-store.ts";

type FixtureRoute = {
  -readonly [Key in keyof OpenShellGitRouteRecord]: OpenShellGitRouteRecord[Key];
} & {
  workerInstance: string;
  operationFence: number;
  targetMaterial: OpenShellGitMaterialReference | undefined;
  retainedLaunchHash?: string;
};

type CountedOperation =
  "open" | "adopt" | "writing" | "cancelWriting" | "record" | "owns" | "block" | "withdraw";

type FixtureStore = OpenShellGitRouteStore & {
  rows: Map<string, FixtureRoute>;
  calls: Record<CountedOperation, number>;
};

async function unexpectedPersistentOperation(): Promise<never> {
  throw new Error("Unexpected persistent route operation");
}

// Adoption and write reservation move the fence. Only the reserving operation
// can settle its pending write, and blocking preserves unknown outcomes.
export function routeStore(): FixtureStore {
  const rows = new Map<string, FixtureRoute>();
  function held(revisionId: string, fence: number): FixtureRoute | undefined {
    const row = rows.get(revisionId);
    return row !== undefined && row.fence === fence && row.blocked === undefined ? row : undefined;
  }

  const calls = {
    open: 0,
    adopt: 0,
    writing: 0,
    cancelWriting: 0,
    record: 0,
    owns: 0,
    block: 0,
    withdraw: 0,
  };
  return {
    rows,
    calls,
    standing: unexpectedPersistentOperation,
    expire: unexpectedPersistentOperation,
    beginDetach: unexpectedPersistentOperation,
    confirmDetached: unexpectedPersistentOperation,
    async open(route, workerInstance) {
      calls.open += 1;
      if (rows.has(route.revisionId)) {
        throw new Error(`duplicate key value violates unique constraint: ${route.revisionId}`);
      }
      rows.set(route.revisionId, {
        ...route,
        fence: 1,
        operationFence: 1,
        targetMaterial: undefined,
        workerInstance,
        generation: undefined,
        material: undefined,
        observed: undefined,
        writePending: "bootstrap",
        blocked: undefined,
      });
    },
    async adopt(revisionId, workerInstance) {
      calls.adopt += 1;
      const row = rows.get(revisionId);
      if (row === undefined) {
        return undefined;
      }
      if (row.blocked === undefined) {
        row.fence += 1;
        row.workerInstance = workerInstance;
        row.blocked = "worker_replaced";
      }
      return structuredClone(row);
    },
    async writing(revisionId, fence, write, material) {
      calls.writing += 1;
      const row = held(revisionId, fence);
      if (
        row === undefined ||
        row.writePending !== undefined ||
        (write === "rotate" && material === undefined)
      ) {
        return undefined;
      }
      row.writePending = write;
      row.targetMaterial = structuredClone(material);
      row.fence += 1;
      row.operationFence = row.fence;
      return row.fence;
    },
    async cancelWriting(revisionId, fence) {
      calls.cancelWriting += 1;
      const row = held(revisionId, fence);
      if (row === undefined || row.writePending === undefined || row.operationFence !== fence) {
        return false;
      }
      row.writePending = undefined;
      row.targetMaterial = undefined;
      return true;
    },
    async record(revisionId, fence, snapshot) {
      calls.record += 1;
      const row = held(revisionId, fence);
      if (row === undefined) {
        return false;
      }
      const pending = row.writePending !== undefined;
      const expected = pending ? row.targetMaterial : row.material;
      if (
        (pending && row.operationFence !== fence) ||
        expected?.materialVersion !== snapshot.material?.materialVersion ||
        expected?.preparationAttemptId !== snapshot.material?.preparationAttemptId ||
        (snapshot.retainedLaunchHash !== undefined &&
          row.retainedLaunchHash !== undefined &&
          row.retainedLaunchHash !== snapshot.retainedLaunchHash)
      ) {
        return false;
      }
      const retainedLaunchHash = row.retainedLaunchHash ?? snapshot.retainedLaunchHash;
      Object.assign(row, structuredClone(snapshot), {
        writePending: undefined,
        targetMaterial: undefined,
      });
      if (retainedLaunchHash !== undefined) {
        row.retainedLaunchHash = retainedLaunchHash;
      }
      return true;
    },
    async owns(revisionId, fence) {
      calls.owns += 1;
      const row = rows.get(revisionId);
      return row !== undefined && row.fence === fence ? (row.blocked ?? true) : false;
    },
    async block(revisionId, fence, reason) {
      calls.block += 1;
      const row = held(revisionId, fence);
      if (row === undefined) {
        return false;
      }
      row.blocked = reason;
      return true;
    },
    async confirmPreviewBlocked(revisionId, workerInstance, fence, reason) {
      const row = rows.get(revisionId);
      if (!row) {
        throw new Error("Missing the OpenShell preview route to close.");
      }
      if (row.workerInstance !== workerInstance || row.fence !== fence) {
        return "superseded";
      }
      if (row.blocked !== undefined) {
        return row.blocked === reason ? "confirmed" : "superseded";
      }
      row.blocked = reason;
      return "confirmed";
    },
    async withdraw(selector) {
      calls.withdraw += 1;
      for (const row of rows.values()) {
        if (
          (row.blocked === undefined || row.blocked === "repository_expired") &&
          ("revisionId" in selector
            ? row.revisionId === selector.revisionId
            : row.namespaceId === selector.namespaceId)
        ) {
          row.blocked = "withdrawn";
        }
      }
    },
  };
}
