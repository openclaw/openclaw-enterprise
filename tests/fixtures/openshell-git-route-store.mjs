/** @import {OpenShellGitMaterialReference, OpenShellGitRouteIdentity, OpenShellGitRouteRecord, OpenShellGitRouteSnapshot, OpenShellGitRouteWithdrawal, OpenShellGitRouteWrite} from "../../apps/controller/src/drivers/egress-proxy/openshell-git-route-store.ts" */
/** @import {OpenShellGitRouteBlockReason} from "../../apps/controller/src/drivers/egress-proxy/openshell-git-runtime.ts" */
/**
 * @typedef {{ -readonly [Key in keyof OpenShellGitRouteRecord]: OpenShellGitRouteRecord[Key] } & {
 *   workerInstance: string,
 *   operationFence: number,
 *   targetMaterial: OpenShellGitMaterialReference | undefined,
 *   retainedLaunchHash?: string,
 * }} FixtureRoute
 */

// An in-memory OpenShellGitRouteStore with the Postgres store's fencing semantics (finding
// 2128, migration 0062): adoption and write reservation move the fence. Only the
// reserving operation can settle a pending write; blocking preserves unknown outcomes. `fault` makes every
// call throw (a store that does not answer); `calls` counts them.
export function routeStore() {
  /** @type {Map<string, FixtureRoute>} */
  const rows = new Map();
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
  const store = {
    rows,
    calls,
    /** @type {unknown} */
    fault: undefined,
    /** @param {OpenShellGitRouteIdentity} route @param {string} workerInstance */
    async open(route, workerInstance) {
      calls.open += 1;
      store.check();
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
    /** @param {string} revisionId @param {string} workerInstance */
    async adopt(revisionId, workerInstance) {
      calls.adopt += 1;
      store.check();
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
    /**
     * @param {string} revisionId
     * @param {number} fence
     * @param {OpenShellGitRouteWrite} write
     * @param {OpenShellGitMaterialReference} [material]
     */
    async writing(revisionId, fence, write, material) {
      calls.writing += 1;
      store.check();
      const row = store.held(revisionId, fence);
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
    /** @param {string} revisionId @param {number} fence */
    async cancelWriting(revisionId, fence) {
      calls.cancelWriting += 1;
      store.check();
      const row = store.held(revisionId, fence);
      if (row === undefined || row.writePending === undefined || row.operationFence !== fence) {
        return false;
      }
      row.writePending = undefined;
      row.targetMaterial = undefined;
      return true;
    },
    /** @param {string} revisionId @param {number} fence @param {OpenShellGitRouteSnapshot} snapshot */
    async record(revisionId, fence, snapshot) {
      calls.record += 1;
      store.check();
      const row = store.held(revisionId, fence);
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
    /** @param {string} revisionId @param {number} fence */
    async owns(revisionId, fence) {
      calls.owns += 1;
      store.check();
      const row = rows.get(revisionId);
      return row !== undefined && row.fence === fence ? (row.blocked ?? true) : false;
    },
    /** @param {string} revisionId @param {number} fence @param {OpenShellGitRouteBlockReason} reason */
    async block(revisionId, fence, reason) {
      calls.block += 1;
      store.check();
      const row = store.held(revisionId, fence);
      if (row === undefined) {
        return false;
      }
      row.blocked = reason;
      return true;
    },
    /**
     * @param {string} revisionId
     * @param {string} workerInstance
     * @param {number} fence
     * @param {OpenShellGitRouteBlockReason} reason
     * @returns {Promise<"confirmed" | "superseded">}
     */
    async confirmPreviewBlocked(revisionId, workerInstance, fence, reason) {
      store.check();
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
    /** @param {OpenShellGitRouteWithdrawal} selector */
    async withdraw(selector) {
      calls.withdraw += 1;
      store.check();
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
    check() {
      if (store.fault !== undefined) {
        throw store.fault;
      }
    },
    /** @param {string} revisionId @param {number} fence */
    held(revisionId, fence) {
      const row = rows.get(revisionId);
      return row !== undefined && row.fence === fence && row.blocked === undefined
        ? row
        : undefined;
    },
    /** Everything the store holds, as a string, to prove no token is in it. */
    dump() {
      return JSON.stringify([...rows.values()]);
    },
  };
  return store;
}
