import { servePrivateRepositoryRequest } from "./private-request-server.ts";
import type { PlatformStateStore } from "@openclaw-enterprise/occ";
import { isBoundInput, snapshotSessionInput } from "../../drivers/repo/credentials/sessions.ts";
import type { SessionStatus } from "../../drivers/repo/credentials/service-contracts.ts";
import { RepositoryReceiptStore } from "./receipt-store.ts";

const admissionPattern =
  /^[0-9]{13}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const generationPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sessionPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(value, field))
  ) {
    throw new Error("INVALID_RECEIPT_REQUEST");
  }
  return value as Record<string, unknown>;
}

function status(value: unknown): SessionStatus {
  const input = object(value, [
    "sessionId",
    "state",
    "deadlineWallMs",
    "binding",
    "activeUses",
    "cleanup",
  ]);
  const binding = object(input.binding, ["providerInstanceId", "repositoryId", "grantId"]);
  const cleanup = object(input.cleanup, [
    "active",
    "pending",
    "revoked",
    "expired",
    "uncertain",
    "auxiliaryPending",
  ]);
  const counter = (entry: unknown): number => {
    if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry < 0) {
      throw new Error("INVALID_RECEIPT_REQUEST");
    }
    return entry;
  };
  const identity = (entry: unknown): string => {
    if (
      typeof entry !== "string" ||
      entry.length === 0 ||
      Buffer.byteLength(entry) > 512 ||
      [...entry].some((character) => {
        const code = character.charCodeAt(0);
        return code <= 31 || code === 127;
      })
    ) {
      throw new Error("INVALID_RECEIPT_REQUEST");
    }
    return entry;
  };
  if (
    typeof input.sessionId !== "string" ||
    !sessionPattern.test(input.sessionId) ||
    !["OPEN", "CLOSED", "DISPOSED"].includes(String(input.state)) ||
    typeof cleanup.auxiliaryPending !== "boolean"
  ) {
    throw new Error("INVALID_RECEIPT_REQUEST");
  }
  return {
    sessionId: input.sessionId,
    state: input.state as SessionStatus["state"],
    deadlineWallMs: counter(input.deadlineWallMs),
    binding: {
      providerInstanceId: identity(binding.providerInstanceId),
      repositoryId: identity(binding.repositoryId),
      grantId: identity(binding.grantId),
    },
    activeUses: counter(input.activeUses),
    cleanup: {
      active: counter(cleanup.active),
      pending: counter(cleanup.pending),
      revoked: counter(cleanup.revoked),
      expired: counter(cleanup.expired),
      uncertain: counter(cleanup.uncertain),
      auxiliaryPending: cleanup.auxiliaryPending,
    },
  };
}

/** Worker-local durable receipt listener. No credentials are accepted or returned. */
export async function startRepositoryReceiptServer(options: {
  readonly controlSocket: string;
  readonly state: PlatformStateStore;
  readonly driverId: string;
  readonly implementation: string;
  readonly backendId: string;
}) {
  const store = new RepositoryReceiptStore(options.state, options);
  return servePrivateRepositoryRequest(options.controlSocket, "receipt", async (parsed) => {
    if (parsed.kind === "status") {
      const input = object(parsed, ["kind", "sessionId"]);
      if (typeof input.sessionId !== "string" || !sessionPattern.test(input.sessionId)) {
        throw new Error("INVALID_RECEIPT_REQUEST");
      }
      const found = await store.status(input.sessionId);
      return found ? { kind: "disposed", status: found } : { kind: "missing" };
    }
    const fields =
      parsed.kind === "bind" || parsed.kind === "dispose"
        ? ["kind", "admissionId", "generation", "input", "status"]
        : parsed.kind === "authorize-standing"
          ? ["kind", "admissionId", "generation", "input", "sessionId"]
          : ["kind", "admissionId", "generation", "input"];
    const command = object(parsed, fields);
    if (
      !["reserve", "recover", "bind", "dispose", "fence", "authorize-standing"].includes(
        String(command.kind),
      ) ||
      typeof command.admissionId !== "string" ||
      !admissionPattern.test(command.admissionId) ||
      typeof command.generation !== "string" ||
      !generationPattern.test(command.generation)
    ) {
      throw new Error("INVALID_RECEIPT_REQUEST");
    }
    const input = snapshotSessionInput(command.input);
    if (!isBoundInput(input)) {
      throw new Error("INVALID_RECEIPT_REQUEST");
    }
    if (command.kind === "reserve" || command.kind === "recover") {
      return store.admission(
        command.admissionId,
        input,
        command.generation,
        command.kind === "recover",
      );
    }
    if (command.kind === "fence") {
      await store.fence(command.admissionId, input, command.generation);
      return { kind: "acknowledged" };
    }
    if (command.kind === "authorize-standing") {
      if (typeof command.sessionId !== "string" || !sessionPattern.test(command.sessionId)) {
        throw new Error("INVALID_RECEIPT_REQUEST");
      }
      await store.authorizeStanding(
        command.admissionId,
        input,
        command.generation,
        command.sessionId,
      );
      return { kind: "authorized" };
    }
    const observed = status(command.status);
    if (command.kind === "bind") {
      await store.bind(command.admissionId, input, command.generation, observed);
    } else {
      await store.dispose(command.admissionId, input, command.generation, observed);
    }
    return { kind: "acknowledged" };
  });
}
