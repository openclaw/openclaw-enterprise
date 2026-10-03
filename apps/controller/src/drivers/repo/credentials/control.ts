import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { Clock } from "./backend-contracts.ts";
import type { SessionInput } from "./sessions.ts";
import { snapshotSessionInput, sameSessionInput, isBoundInput } from "./sessions.ts";
import type {
  SessionControl,
  ServiceConfig,
  SessionStatus,
  RepositoryCredentialBoundSessionInput,
  RepositoryDescriptions,
} from "./service-contracts.ts";
import { inspectRequestHead } from "./transport/request.ts";
import { RepositoryReceiptClient } from "./receipt-client.ts";

// A new correlation must be fresh; completed-session tombstones share this window.
const admissionWindowMs = 60_000;
// Refusals of the request itself; control answers them with 400 invalid-request.
const invalidAdmissionErrors: ReadonlySet<string> = new Set([
  "INVALID_ADMISSION",
  "ADMISSION_CONFLICT",
  "INVALID_BINDING",
  "INVALID_DEADLINE",
  "INVALID_PROFILE",
  "INVALID_DURATION",
  "BOUND_SESSION_REQUIRED",
]);

interface AdmissionRecord {
  readonly input: SessionInput;
  readonly sessionId: string | undefined;
  readonly forgetAt: number;
  readonly durable: boolean;
  ready: Promise<void>;
  // A durable admission's observed disposal; the service may evict the session.
  terminal: SessionStatus | undefined;
  // Bind failed and the reservation is not yet known to be fenced.
  unbound: boolean;
  saved: boolean;
  writing: Promise<void> | undefined;
  cancel(): void;
}

export function createControlAdmission(
  service: SessionControl,
  config: ServiceConfig,
  clock: Clock,
  durableRequired: boolean,
) {
  const records = new Map<string, AdmissionRecord>();
  const sessions = new Map<string, string>();
  // Sessions opened before their admission is recorded, with any disposal seen
  // meanwhile. Each holds a service slot, so service capacity bounds this map.
  const unrecorded = new Map<string, SessionStatus | undefined>();
  const operations = new Map<
    string,
    Promise<{ result: unknown; sessionId: string; created: boolean }>
  >();
  const journal = durableRequired
    ? new RepositoryReceiptClient(config.gateway.controlSocket, randomUUID())
    : undefined;
  let disposed = false;
  const startedWall = clock.wallNow();
  const startedMono = clock.monotonicNow();
  let latestWall = startedWall;
  const now = () => {
    latestWall = Math.max(
      latestWall,
      clock.wallNow(),
      startedWall + clock.monotonicNow() - startedMono,
    );
    return latestWall;
  };
  const sweep = () => {
    for (const [id, record] of records) {
      const status = record.sessionId === undefined ? undefined : service.status(record.sessionId);
      if (
        (status === undefined || status.state === "DISPOSED") &&
        (!record.durable || record.saved) &&
        clock.monotonicNow() >= record.forgetAt
      ) {
        record.cancel();
        records.delete(id);
        if (record.sessionId !== undefined) {
          sessions.delete(record.sessionId);
        }
      }
    }
  };
  // Fences a reservation no bearer was handed out for, then forgets its record so
  // the journal answers missing for retries and recovery.
  const fenced = async (id: string, record: AdmissionRecord) => {
    try {
      await journal!.fence(id, record.input as RepositoryCredentialBoundSessionInput);
    } catch {
      return false;
    }
    record.cancel();
    records.delete(id);
    if (record.sessionId !== undefined) {
      sessions.delete(record.sessionId);
    }
    return true;
  };
  const persist = async (id: string, record: AdmissionRecord, status: SessionStatus) => {
    if (!record.durable || record.saved) {
      return;
    }
    if (!journal || !isBoundInput(record.input)) {
      throw new Error("RECEIPT_UNAVAILABLE");
    }
    record.writing ??= (async () => {
      await record.ready;
      await journal.dispose(id, record.input as RepositoryCredentialBoundSessionInput, status);
      record.saved = true;
    })().finally(() => {
      record.writing = undefined;
    });
    return record.writing;
  };
  const observe = (status: SessionStatus) => {
    const id = sessions.get(status.sessionId);
    const record = id === undefined ? undefined : records.get(id);
    if (id !== undefined && record !== undefined) {
      if (record.durable) {
        record.terminal = status;
      }
      void persist(id, record, status).catch(() => {});
    } else if (unrecorded.has(status.sessionId)) {
      unrecorded.set(status.sessionId, status);
    }
  };
  // A later open evicts disposed sessions from the service, so a durable
  // admission falls back to the disposal it observed.
  const localStatus = (sessionId: string) => {
    const found = service.status(sessionId);
    if (found !== undefined) {
      return found;
    }
    const id = sessions.get(sessionId);
    return id === undefined ? undefined : records.get(id)?.terminal;
  };
  const readStatus = async (sessionId: string) => {
    const found = localStatus(sessionId);
    if (found?.state === "DISPOSED") {
      const id = sessions.get(sessionId);
      const record = id === undefined ? undefined : records.get(id);
      if (id !== undefined && record !== undefined) {
        await persist(id, record, found);
      }
    }
    if (found !== undefined) {
      return found;
    }
    return journal?.status(sessionId);
  };
  const performOpen = async (
    id: string,
    input: SessionInput & { recoverOnly?: true; durableAdmission?: true },
  ) => {
    if (disposed) {
      throw new Error("CONTROL_CLOSED");
    }
    const recoverOnly = input.recoverOnly === true;
    const snapshot = snapshotSessionInput(input);
    const admittedInput = isBoundInput(snapshot)
      ? snapshot
      : Object.freeze({
          durationSeconds: snapshot.durationSeconds,
          profile: snapshot.profile ?? config.sessionPolicy.defaultProfile,
        });
    if (isBoundInput(admittedInput) && (!journal || input.durableAdmission !== true)) {
      throw new Error("INVALID_ADMISSION");
    }
    sweep();
    const previous = records.get(id);
    if (previous) {
      if (!sameSessionInput(previous.input, admittedInput)) {
        throw new Error("ADMISSION_CONFLICT");
      }
      // A failed bind left the reservation unfenced, so retry the fence. If the bind
      // was recorded after all, the fence fails and only a recorded disposal is
      // reported; the session is never exposed while its receipt is unknown.
      if (previous.unbound && !previous.saved) {
        if (await fenced(id, previous)) {
          throw new Error("ADMISSION_MISSING");
        }
        const current = localStatus(previous.sessionId!);
        if (current?.state !== "DISPOSED") {
          throw new Error("RECEIPT_UNAVAILABLE");
        }
        await persist(id, previous, current);
        return { result: current, sessionId: current.sessionId, created: false };
      }
      const status =
        previous.sessionId === undefined ? undefined : await readStatus(previous.sessionId);
      if (!status) {
        throw new Error("ADMISSION_MISSING");
      }
      return { result: status, sessionId: previous.sessionId!, created: false };
    }
    const timestamp =
      /^([0-9]{13})-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.exec(id);
    const age = timestamp ? now() - Number(timestamp[1]) : -1;
    if (age < 0) {
      throw new Error("INVALID_ADMISSION");
    }
    if (records.size >= 2 * config.limits.sessions) {
      throw new Error("SESSION_CAPACITY");
    }
    let opened: ReturnType<SessionControl["open"]> | undefined;
    let early: SessionStatus | undefined;
    if (isBoundInput(admittedInput)) {
      const lookupOnly = recoverOnly || age >= admissionWindowMs;
      let refused: unknown;
      // Open before reserving. Only bind advances a reserved receipt, so an open
      // refused after reservation (capacity, shutdown) would strand it. Such a
      // refusal writes no receipt and the same admission may retry. Invalid input
      // keeps the journal-first answer; the unreserved session is never handed out.
      if (!lookupOnly) {
        try {
          opened = service.open(admittedInput);
        } catch (error) {
          if (!(error instanceof Error && invalidAdmissionErrors.has(error.message))) {
            throw error;
          }
          refused = error;
        }
      }
      const discard = () => {
        if (opened !== undefined && service.status(opened.session.sessionId) !== undefined) {
          service.close(opened.session.sessionId);
        }
      };
      if (opened !== undefined) {
        unrecorded.set(opened.session.sessionId, undefined);
      }
      let result: Awaited<ReturnType<RepositoryReceiptClient["admission"]>>;
      try {
        result = await journal!.admission(id, admittedInput, lookupOnly);
      } catch (error) {
        discard();
        throw error;
      } finally {
        // Nothing awaits between here and recording, so no disposal is missed.
        if (opened !== undefined) {
          early = unrecorded.get(opened.session.sessionId);
          unrecorded.delete(opened.session.sessionId);
        }
      }
      if (lookupOnly || result.kind !== "reserved") {
        discard();
      }
      if (result.kind === "disposed") {
        return { result: result.status, sessionId: result.status.sessionId, created: false };
      }
      if (result.kind === "missing") {
        throw new Error("ADMISSION_MISSING");
      }
      if (lookupOnly || result.kind !== "reserved") {
        throw new Error("RECEIPT_UNAVAILABLE");
      }
      if (refused !== undefined) {
        // Nothing will bind this reservation. Fence it so the admission answers missing.
        await journal!.fence(id, admittedInput).catch(() => {});
        throw refused;
      }
    } else if (age >= admissionWindowMs) {
      throw new Error("ADMISSION_MISSING");
    }
    const forgetAt = clock.monotonicNow() + Math.max(0, admissionWindowMs - age);
    if (recoverOnly) {
      const record: AdmissionRecord = {
        input: admittedInput,
        sessionId: undefined,
        forgetAt,
        durable: false,
        ready: Promise.resolve(),
        terminal: undefined,
        unbound: false,
        saved: false,
        writing: undefined,
        cancel: () => {},
      };
      records.set(id, record);
      record.cancel = clock.schedule(Math.max(0, admissionWindowMs - age), () =>
        records.delete(id),
      );
      throw new Error("ADMISSION_MISSING");
    }
    opened ??= service.open(admittedInput);
    const record: AdmissionRecord = {
      input: admittedInput,
      sessionId: opened.session.sessionId,
      forgetAt,
      durable: isBoundInput(admittedInput),
      ready: Promise.resolve(),
      terminal: early,
      unbound: false,
      saved: false,
      writing: undefined,
      cancel: () => {},
    };
    records.set(id, record);
    sessions.set(opened.session.sessionId, id);
    record.cancel = clock.schedule(
      Math.max(opened.session.deadlineWallMs - clock.wallNow(), admissionWindowMs - age, 0),
      sweep,
    );
    if (isBoundInput(admittedInput)) {
      const sessionId = opened.session.sessionId;
      record.ready = journal!.bind(id, admittedInput, opened.session);
      try {
        await record.ready;
      } catch (error) {
        if (service.status(sessionId) !== undefined) {
          service.close(sessionId);
        }
        // The bearer was never handed out. Fence the reservation so the admission
        // answers missing rather than unavailable.
        if (!(await fenced(id, record))) {
          // The bind may have been recorded after all, or the journal is away. A
          // retry fences again; otherwise the disposal follows a recorded bind.
          record.unbound = true;
          record.ready = Promise.resolve();
          const current = localStatus(sessionId);
          if (current?.state === "DISPOSED") {
            void persist(id, record, current).catch(() => {});
          }
        }
        throw error;
      }
      // Binding can outlive the session. Never hand out a bearer for a session
      // that reached cleanup while its durable admission was being recorded.
      const current = await readStatus(opened.session.sessionId);
      if (!current) {
        throw new Error("RECEIPT_UNAVAILABLE");
      }
      if (current.state !== "OPEN") {
        return { result: current, sessionId: current.sessionId, created: false };
      }
    }
    return { result: opened, sessionId: opened.session.sessionId, created: true };
  };
  const open = (
    id: string,
    input: SessionInput & { recoverOnly?: true; durableAdmission?: true },
  ): Promise<{ result: unknown; sessionId: string; created: boolean }> => {
    const existing = operations.get(id);
    if (existing) {
      return existing.then(() => open(id, input));
    }
    const running = performOpen(id, input);
    operations.set(id, running);
    return running.finally(() => operations.delete(id));
  };
  return {
    durableAdmission: journal !== undefined,
    open,
    status: readStatus,
    async close(sessionId: string) {
      const found = service.status(sessionId);
      if (!found) {
        return readStatus(sessionId);
      }
      const result = service.close(sessionId);
      if (result.state === "DISPOSED") {
        const id = sessions.get(sessionId);
        const record = id === undefined ? undefined : records.get(id);
        if (id !== undefined && record !== undefined) {
          await persist(id, record, result);
        }
      }
      sweep();
      return result;
    },
    observe,
    async flush() {
      // Service shutdown has settled every session; join their durable writes
      // before releasing the original broker process.
      await Promise.all(
        [...records].map(async ([id, record]) => {
          const status = record.sessionId === undefined ? undefined : localStatus(record.sessionId);
          if (status?.state === "DISPOSED") {
            await persist(id, record, status);
          }
        }),
      );
    },
    dispose() {
      disposed = true;
      for (const record of records.values()) {
        record.cancel();
      }
      records.clear();
      sessions.clear();
      unrecorded.clear();
    },
  };
}

function reply(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(body.length),
    "cache-control": "no-store",
    connection: "close",
  });
  response.end(body);
}

/** This handler is mounted only on the protected local Unix socket. */
export async function handleControl(
  request: IncomingMessage,
  response: ServerResponse,
  config: ServiceConfig,
  clock: Clock,
  admissions: ReturnType<typeof createControlAdmission>,
  repositoryDescriptions?: RepositoryDescriptions,
): Promise<void> {
  const inspected = inspectRequestHead(request, {
    authority: "localhost",
    receivedMonoMs: clock.monotonicNow(),
    headerBytes: config.limits.headerBytes,
    headerPairs: config.limits.headerPairs,
    targetBytes: config.limits.targetBytes,
  });
  if (
    inspected.kind === "denied" ||
    inspected.authorization !== undefined ||
    inspected.head.contentEncoding !== "identity" ||
    inspected.expectContinue
  ) {
    reply(response, 400, { error: "invalid-request" });
    return;
  }
  const { head } = inspected;
  if ((head.framing.bytes ?? 0) > Math.min(16384, config.limits.controlBodyBytes)) {
    reply(response, 413, { error: "invalid-request" });
    return;
  }
  const open = head.method === "POST" && head.rawTarget === "/v1/sessions";
  const descriptions = head.method === "POST" && head.rawTarget === "/v1/repository-descriptions";
  const health = head.method === "GET" && head.rawTarget === "/healthz";
  const capabilities = head.method === "GET" && head.rawTarget === "/v1/capabilities";
  const status = /^\/v1\/sessions\/([A-Za-z0-9_-]{1,128})$/.exec(head.rawTarget);
  const close = /^\/v1\/sessions\/([A-Za-z0-9_-]{1,128})\/close$/.exec(head.rawTarget);
  if (
    !open &&
    !descriptions &&
    !health &&
    !capabilities &&
    !(head.method === "GET" && status) &&
    !(head.method === "POST" && close)
  ) {
    reply(response, 404, { error: "not-found" });
    return;
  }
  const timer = clock.schedule(config.limits.inputMs, () => request.destroy());
  try {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      size += chunk.length;
      if (size > Math.min(16384, config.limits.controlBodyBytes)) {
        request.destroy();
        return;
      }
      chunks.push(Buffer.from(chunk));
    }
    if (open || descriptions) {
      if (head.headers["content-type"] !== "application/json") {
        reply(response, 400, { error: "invalid-request" });
        return;
      }
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        reply(response, 400, { error: "invalid-request" });
        return;
      }
      if (descriptions) {
        if (
          !repositoryDescriptions ||
          !body ||
          typeof body !== "object" ||
          Array.isArray(body) ||
          Object.keys(body).length !== 2 ||
          typeof (body as Record<string, unknown>).namespaceId !== "string" ||
          !Array.isArray((body as Record<string, unknown>).repositoryRefs)
        ) {
          reply(response, 400, { error: "invalid-request" });
          return;
        }
        reply(
          response,
          200,
          repositoryDescriptions.list(
            (body as { namespaceId: string }).namespaceId,
            (body as { repositoryRefs: string[] }).repositoryRefs,
          ),
        );
        return;
      }
      const input = snapshotSessionInput(body);
      const recoverOnly = (body as Record<string, unknown>).recoverOnly === true;
      const durableAdmission = (body as Record<string, unknown>).durableAdmission === true;
      const admission = await admissions.open(head.headers["x-admission-id"] ?? "", {
        ...input,
        ...(recoverOnly ? { recoverOnly: true as const } : {}),
        ...(durableAdmission ? { durableAdmission: true as const } : {}),
      });
      // Before handing bytes to the socket, nondelivery is certain. Once writes
      // begin, a lost response is ambiguous and must remain recoverable.
      if (response.destroyed || request.socket.destroyed) {
        if (admission.created) {
          await admissions.close(admission.sessionId);
        }
        return;
      }
      try {
        reply(response, admission.created ? 201 : 200, admission.result);
      } catch (error) {
        if (admission.created && !response.headersSent) {
          await admissions.close(admission.sessionId);
        }
        throw error;
      }
    } else {
      if (size !== 0) {
        reply(response, 400, { error: "invalid-request" });
        return;
      }
      if (health) {
        reply(response, 200, { ready: true, protocolVersion: 1 });
        return;
      }
      if (capabilities) {
        if (!admissions.durableAdmission) {
          reply(response, 404, { error: "not-found" });
        } else {
          reply(response, 200, { durableAdmissionVersion: 1 });
        }
        return;
      }
      const id = (status ?? close)![1]!;
      const found = await admissions.status(id);
      if (!found) {
        reply(response, 404, { error: "not-found" });
        return;
      }
      reply(response, 200, close ? await admissions.close(id) : found);
    }
  } catch (error) {
    if (!response.destroyed && !response.headersSent) {
      const invalid = error instanceof Error && invalidAdmissionErrors.has(error.message);
      let code = "unavailable";
      let status = 503;
      if (invalid) {
        code = "invalid-request";
        status = 400;
      } else if (error instanceof Error && error.message === "SESSION_CAPACITY") {
        code = "overloaded";
      } else if (error instanceof Error && error.message === "ADMISSION_MISSING") {
        code = "admission-missing";
        status = 404;
      }
      reply(response, status, { error: code });
    }
  } finally {
    timer();
  }
}
