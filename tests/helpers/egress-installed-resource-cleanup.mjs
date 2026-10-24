import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { assertConnectedResponse } from "./egress-connected-inputs.mjs";

// The API deliberately closes internal failures. Preserve its status and only known error codes,
// never its arbitrary message, resource identifiers, or the values that failed an assertion.
// CREDENTIAL_TOKEN_UNSETTLED is recorded, not retried: the API's retry time can reach the token lifetime.
const cleanupCodes = new Set([
  "CREDENTIAL_TOKEN_UNSETTLED",
  "CREDENTIAL_WITHDRAWAL_IN_PROGRESS",
  "DEPENDENCY_UNAVAILABLE",
  "FORBIDDEN",
  "INTERNAL_ERROR",
  "NOT_FOUND",
  "RESOURCE_CONFLICT",
]);

export async function deleteInstalledResource({ remove, record, prepared }) {
  const removeOnce = async (details = {}) => {
    // Started does not mean sent. If the transport or this process stops here, never replay it.
    await record({ ...details, observation: "delete-started-result-not-yet-known" });
    let status = null;
    try {
      const response = await remove();
      status = response.status;
      const { code } = assertConnectedResponse(response, status) ?? {};
      const reason = cleanupCodes.has(code) ? code : "unclassified-response";
      return { status, reason: status === 204 ? "deleted" : reason };
    } catch {
      return { status, reason: status === null ? "response-not-confirmed" : "invalid-response" };
    }
  };
  const removed = ({ status, reason }) =>
    (status === 204 && reason === "deleted") || (status === 404 && reason === "NOT_FOUND");
  const first = await removeOnce();
  await record(first);
  if (removed(first)) {
    return true;
  }
  if (first.status !== 500 || first.reason !== "INTERNAL_ERROR" || !prepared) {
    return false;
  }

  // A foreground withdrawal can lose the retirement claim to the worker. Observe, never drive,
  // that retirement. Retry only the documented caller-retried *source* DELETE, after proving
  // the exact deleting source has a disabled family and every attempt is terminal. A missing,
  // unknown, or still revoking attempt is not confirmation. No issuer operation is available here.
  if (!(await observePreparedRetirement(prepared, record))) {
    return false;
  }
  const afterConfirmedRetirement = { afterConfirmedRetirement: true };
  const final = await removeOnce(afterConfirmedRetirement);
  await record({ ...final, ...afterConfirmedRetirement });
  return removed(final);
}

async function observePreparedRetirement({ databaseUrl, namespaceId, sourceId }, record) {
  // The earlier observation pool has already closed when Node runs this after-hook.
  const client = new pg.Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 2_000,
    statement_timeout: 2_000,
    query_timeout: 3_000,
  });
  try {
    await client.connect();
    const until = Date.now() + 5_000;
    for (;;) {
      // Query only closed custody labels and counts. Match the full enrolled source, not just its ID.
      const { rows } = await client.query(
        `SELECT a.custody, count(*)::integer AS attempts
           FROM occ.credential_sources s
           JOIN occ.prepared_github_families f ON f.source_id=s.id AND f.source=s.egress
           JOIN occ.prepared_github_attempts a ON a.source_id=f.source_id
          WHERE s.namespace_id=$1 AND s.id=$2 AND s.state='deleting' AND NOT f.enabled
          GROUP BY a.custody`,
        [namespaceId, sourceId],
      );
      if (rows.length === 0) {
        await record({ observation: "no-matching-prepared-custody-observed" });
        return false;
      }
      const custody = Object.fromEntries(rows.map(({ custody, attempts }) => [custody, attempts]));
      await record({ observation: "deleting-source-disabled-family", custody });
      if (rows.length === 1 && custody.revoked > 0) {
        return true;
      }
      if (
        !custody.revoking ||
        rows.some(({ custody }) => !["revoked", "revoking"].includes(custody)) ||
        Date.now() >= until
      ) {
        return false;
      }
      await delay(500);
    }
  } catch {
    await record({ observation: "prepared-custody-not-confirmed" });
    return false;
  } finally {
    await client.end();
  }
}
