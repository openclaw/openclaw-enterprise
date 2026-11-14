import { setTimeout as delay } from "node:timers/promises";
import type { ControlRequest } from "../../../apps/controller/src/drivers/repo/access/control-contracts.ts";

export type ResourceCleanup = (signal?: AbortSignal) => Promise<void>;

type CleanupRequest =
  | { method: "GET" | "DELETE"; path: string; body?: never }
  | { method: "PATCH"; path: string; body: { state: "closed" } };

type ResourceCleanupOptions = {
  request: (request: CleanupRequest, signal?: AbortSignal) => Promise<unknown>;
  repository: string;
  marker: string;
  head?: string | undefined;
} & ({ kind: "issues" | "pulls"; issueNumber?: number } | { kind: "comment"; issueNumber: number });

type CleanupCandidate = {
  body?: unknown;
  pull_request?: unknown;
  head?: { ref?: unknown };
  id?: unknown;
  number?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

class ResourceCleanupError extends Error {}

// Register before dispatch: a missing creation response never proves that the
// provider did not accept the write. These reads stay inside the admitted repo.
export function registerResourceCleanup(
  cleanups: ResourceCleanup[],
  { request, repository, kind, marker, head, issueNumber }: ResourceCleanupOptions,
) {
  const prefix = `repos/${repository}`;
  const collection = kind === "comment" ? `issues/${issueNumber}/comments` : kind;
  const reconcile = async (signal?: AbortSignal) => {
    const matches: CleanupCandidate[] = [];
    let complete = false;
    for (let page = 1; page <= 5; page++) {
      signal?.throwIfAborted();
      const query = new URLSearchParams({ per_page: "100", page: String(page) });
      if (kind !== "comment") {
        query.set("state", "all");
        query.set("sort", "created");
        query.set("direction", "desc");
      }
      if (head) {
        query.set("head", `${repository.split("/")[0]}:${head}`);
      }
      const values = await request(
        { method: "GET", path: `${prefix}/${collection}?${query}` },
        signal,
      );
      if (!Array.isArray(values)) {
        throw new ResourceCleanupError(`unresolved ${kind} identity: ${marker}`);
      }
      matches.push(
        ...(values as CleanupCandidate[]).filter(
          (value) =>
            typeof value.body === "string" &&
            value.body.split("\n").includes(marker) &&
            (kind !== "issues" || !value.pull_request) &&
            (!head || value.head?.ref === head),
        ),
      );
      if (values.length < 100) {
        complete = true;
        break;
      }
    }
    // Absence after a lost response remains unresolved: provider visibility may
    // lag. Multiple matches or a truncated search also cannot establish ownership.
    const [value] = matches;
    if (!complete || matches.length !== 1 || !value) {
      throw new ResourceCleanupError(`unresolved ${kind} identity: ${marker}`);
    }
    const id = kind === "comment" ? value.id : value.number;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
      throw new ResourceCleanupError(`unresolved ${kind} identity: ${marker}`);
    }
    const path = `${prefix}/${kind === "comment" ? "issues/comments" : kind}/${id}`;
    if (kind === "comment") {
      await request({ method: "DELETE", path }, signal);
    } else {
      await request({ method: "PATCH", path, body: { state: "closed" } }, signal);
      const closed = await request({ method: "GET", path }, signal);
      if (!isRecord(closed) || closed.number !== id || closed.state !== "closed") {
        throw new ResourceCleanupError(`unresolved ${kind} closure: ${marker}`);
      }
    }
  };
  cleanups.push(async (signal) => {
    try {
      await reconcile(signal);
    } catch (error) {
      if (error instanceof ResourceCleanupError) {
        throw error;
      }
      throw new ResourceCleanupError(`unresolved ${kind} cleanup: ${marker}`);
    }
  });
}

export async function closeAndDispose(
  callControl: (socket: string, request: ControlRequest) => Promise<unknown>,
  socket: string,
  sessionId: string,
  {
    timeoutMs = 10000,
    pollMs = 100,
    signal,
  }: {
    timeoutMs?: number;
    pollMs?: number;
    signal?: AbortSignal;
  } = {},
) {
  const deadline = performance.now() + timeoutMs;
  let locallyClosed = false;
  const control = async (request: ControlRequest) => {
    try {
      return await callControl(socket, request);
    } catch {
      throw new Error(
        `session cleanup failed: local closure ${locallyClosed ? "confirmed" : "unconfirmed"}; disposal unconfirmed`,
      );
    }
  };
  const inspect = (status: unknown) => {
    if (
      !isRecord(status) ||
      "error" in status ||
      status.sessionId !== sessionId ||
      (status.state !== "CLOSED" && status.state !== "DISPOSED")
    ) {
      throw new Error(
        `session cleanup failed: local closure ${locallyClosed ? "confirmed" : "unconfirmed"}`,
      );
    }
    locallyClosed = true;
    const { cleanup } = status;
    return (
      status.state === "DISPOSED" &&
      status.activeUses === 0 &&
      isRecord(cleanup) &&
      cleanup.active === 0 &&
      cleanup.pending === 0 &&
      cleanup.uncertain === 0 &&
      cleanup.auxiliaryPending === false
    );
  };
  signal?.throwIfAborted();
  inspect(
    await control({
      method: "POST",
      path: `/v1/sessions/${sessionId}/close`,
    }),
  );
  // Always read status, even if close claims immediate disposal.
  while (performance.now() < deadline) {
    signal?.throwIfAborted();
    const status = await control({ method: "GET", path: `/v1/sessions/${sessionId}` });
    if (inspect(status) && performance.now() <= deadline) {
      return { localClosure: "confirmed", disposal: "confirmed" };
    }
    await delay(Math.min(pollMs, Math.max(0, deadline - performance.now())), undefined, { signal });
  }
  throw new Error("session cleanup unresolved: local closure confirmed; disposal pending");
}
