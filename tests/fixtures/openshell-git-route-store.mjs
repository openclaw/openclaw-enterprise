// An in-memory OpenShellGitRouteStore with the Postgres store's fencing semantics (finding
// 2128, migration 0060): one row per revision, adopt() moves the fence, every fenced write
// answers false for a stale fence, a blocked row is never re-fenced. `fault` makes every
// call throw (a store that does not answer); `calls` counts them.
export function routeStore() {
  const rows = new Map();
  const calls = { open: 0, adopt: 0, writing: 0, record: 0, owns: 0, block: 0, withdraw: 0 };
  const store = {
    rows,
    calls,
    fault: undefined,
    async open(route, workerInstance) {
      calls.open += 1;
      store.check();
      if (rows.has(route.revisionId)) {
        throw new Error(`duplicate key value violates unique constraint: ${route.revisionId}`);
      }
      rows.set(route.revisionId, {
        ...route,
        fence: 1,
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
      store.check();
      const row = rows.get(revisionId);
      if (row === undefined) {
        return undefined;
      }
      if (row.blocked === undefined) {
        row.fence += 1;
        row.workerInstance = workerInstance;
      }
      return structuredClone(row);
    },
    async writing(revisionId, fence, write) {
      calls.writing += 1;
      store.check();
      const row = store.held(revisionId, fence);
      if (row === undefined) {
        return false;
      }
      row.writePending = write;
      return true;
    },
    async record(revisionId, fence, snapshot) {
      calls.record += 1;
      store.check();
      const row = store.held(revisionId, fence);
      if (row === undefined) {
        return false;
      }
      Object.assign(row, structuredClone(snapshot), { writePending: undefined });
      return true;
    },
    async owns(revisionId, fence) {
      calls.owns += 1;
      store.check();
      return store.held(revisionId, fence) !== undefined;
    },
    async block(revisionId, fence, reason) {
      calls.block += 1;
      store.check();
      const row = store.held(revisionId, fence);
      if (row === undefined) {
        return false;
      }
      row.blocked = reason;
      row.writePending = undefined;
      return true;
    },
    async withdraw(selector) {
      calls.withdraw += 1;
      store.check();
      for (const row of rows.values()) {
        if (
          row.blocked === undefined &&
          ("revisionId" in selector
            ? row.revisionId === selector.revisionId
            : row.namespaceId === selector.namespaceId)
        ) {
          row.blocked = "withdrawn";
          row.writePending = undefined;
        }
      }
    },
    check() {
      if (store.fault !== undefined) {
        throw store.fault;
      }
    },
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
