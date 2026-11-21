// The test reads the node-side journal of its own disposable Harness. The
// schema and result vocabulary belong to this packaged OpenClaw revision.
export const nativeWorkerJournalSource = "82b682c627ba8bfc2c2bd51cf46ad8f51c583857";

// Self-contained because the fixture sends this program to the Harness over stdin.
export async function readNativeWorkerJournal(path, binding) {
  const { realpathSync } = await import("node:fs");
  const { DatabaseSync } = await import("node:sqlite");
  const { gatewayNamespace, environmentId, sessionId, ownerEpoch, generation, runId } = binding;
  const identifier = (value) =>
    typeof value === "string" && value.length > 0 && value.length <= 256 && !value.includes("\0");
  if (
    !/^gateway-[a-f0-9]{32}$/.test(gatewayNamespace) ||
    ![environmentId, sessionId, runId].every(identifier) ||
    !Number.isSafeInteger(ownerEpoch) ||
    ownerEpoch < 1 ||
    !Number.isSafeInteger(generation) ||
    generation < 0 ||
    realpathSync(path) !== path
  ) {
    return { nodeJournal: "unavailable" };
  }
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    // The first turn has both a logical receipt and its physical launch.
    // Use the turn when they share that launch and run. Separate attempts
    // can leave more than one receipt, so refuse to choose by timestamp.
    const rows = db
      .prepare(
        `WITH owned AS (
           SELECT launch_id, run_id, state, result_json FROM node_worker_launches
           WHERE gateway_namespace = ? AND environment_id = ? AND session_id = ?
             AND owner_epoch = ? AND placement_generation = ?
         ), receipts AS (
           SELECT 'launch' AS record, owned.state, owned.result_json
           FROM owned WHERE owned.run_id = ? AND NOT EXISTS (
             SELECT 1 FROM node_worker_turns AS turn
             WHERE turn.owner_launch_id = owned.launch_id AND turn.run_id = owned.run_id
           )
           UNION ALL
           SELECT 'turn', CASE WHEN turn.state = 'running' AND owned.state = 'pending'
                               THEN 'pending' ELSE turn.state END, turn.result_json
           FROM node_worker_turns AS turn
           JOIN owned ON turn.owner_launch_id = owned.launch_id WHERE turn.run_id = ?
           LIMIT 2
         )
         SELECT record, state, json_extract(result_json, '$.status') AS result,
                json_extract(result_json, '$.reason') AS reason
         FROM receipts`,
      )
      .all(gatewayNamespace, environmentId, sessionId, ownerEpoch, generation, runId, runId);
    if (rows.length !== 1) {
      return { nodeJournal: rows.length === 0 ? "not-observed" : "ambiguous" };
    }
    const { record, state, result, reason } = rows[0];
    const reasons = {
      "not-started": ["admission-deadline"],
      fenced: ["credential-replaced", "owner-epoch-mismatch"],
      failed: ["turn-failed", "node-lost"],
      completed: [],
    };
    return {
      nodeJournal: "observed",
      nodeJournalRecord: record,
      nodeJournalState: state,
      ...(state === "completed" &&
        typeof result === "string" &&
        Object.hasOwn(reasons, result) && {
          nodeJournalResult: result,
          ...(reasons[result].includes(reason) && { nodeJournalReason: reason }),
        }),
    };
  } finally {
    db.close();
  }
}

// The source check runs in each selected container before either diagnostic.
export async function requireNativeWorkerJournalSource(commit) {
  const { readFile } = await import("node:fs/promises");
  const provenance = JSON.parse(await readFile("/opt/oce/runtime/provenance.json", "utf8"));
  if (provenance.commit !== commit) {
    throw new Error("Native worker journal requires the pinned runtime");
  }
}

export async function readNativeWorkerGatewayNamespace(expectedBootId) {
  const { execFile } = await import("node:child_process");
  const { createHash } = await import("node:crypto");
  const { promisify } = await import("node:util");
  const port = Number(process.env.OPENCLAW_GATEWAY_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !expectedBootId) {
    throw new Error("Native worker journal requires the selected Gateway listener");
  }
  const response = await fetch(`http://127.0.0.1:${port}/startupz`, {
    headers: { "x-openclaw-startup-boot-id": "1" },
    redirect: "error",
    signal: AbortSignal.timeout(2_000),
  });
  // A Gateway and its replacement can share a device identity. Bind the
  // observed process to the routed hello that actually acknowledged the turn.
  if (!response.ok || (await response.json()).gatewayBootId !== expectedBootId) {
    throw new Error("Native worker journal Gateway boot changed");
  }
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["/app/openclaw.mjs", "node", "identity", "--identity", "primary", "--json"],
    { timeout: 4_000, maxBuffer: 4_096 },
  );
  const { deviceId } = JSON.parse(stdout);
  if (typeof deviceId !== "string" || !/^[a-f0-9]{64}$/.test(deviceId)) {
    throw new Error("Native worker journal requires the Gateway device identity");
  }
  return `gateway-${createHash("sha256").update(deviceId).digest("hex").slice(0, 32)}`;
}
