import type { AgentRevision } from "@openclaw-enterprise/contracts";
import { immutableCopy } from "@openclaw-enterprise/utils";
import { ResourceConflictError, ScopeViolationError } from "../errors.ts";
import type {
  RepositoryRevisionOwner,
  RepositorySessionAttempt,
  RepositoryBrokerReceipt,
  RepositorySessionPhase,
  RepositorySessionRepository,
} from "../ports/repository-sessions.ts";

const identifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && identifier.exec(value)?.[0] === value;
}

const transitions: Readonly<Record<RepositorySessionPhase, readonly RepositorySessionPhase[]>> = {
  opening: ["open", "closing", "invalidated"],
  open: ["closing", "invalidated"],
  closing: ["closing", "disposed", "invalidated"],
  disposed: [],
  invalidated: [],
};

function timestamp(value: string): string {
  const date = new Date(value);
  if (typeof value !== "string" || !Number.isFinite(date.getTime())) {
    throw new ScopeViolationError("The repository session timestamp is invalid.");
  }
  return date.toISOString();
}

function sameOwner(attempt: RepositorySessionAttempt, owner: RepositoryRevisionOwner): boolean {
  return (
    attempt.namespaceId === owner.namespaceId &&
    attempt.agentId === owner.agentId &&
    attempt.revisionId === owner.revisionId
  );
}

/** The process-local adapter mirrors the database's constrained attempt lifecycle. */
export function memoryRepositorySessions(
  attempts: Map<string, Readonly<RepositorySessionAttempt>>,
  receipts: Map<string, Readonly<RepositoryBrokerReceipt>>,
  findRevision: (owner: RepositoryRevisionOwner) => Readonly<AgentRevision> | undefined,
  ownerAcceptsAdmission: (owner: RepositoryRevisionOwner) => boolean,
): RepositorySessionRepository {
  const list = (matches: (attempt: RepositorySessionAttempt) => boolean) =>
    Object.freeze(
      Array.from(attempts.values())
        .filter(matches)
        .sort((left, right) => {
          const byTime = Date.parse(left.createdAt) - Date.parse(right.createdAt);
          return byTime === 0 ? left.admissionId.localeCompare(right.admissionId) : byTime;
        })
        .map((attempt) => immutableCopy(attempt)),
    );

  function assertUnique(attempt: RepositorySessionAttempt): void {
    for (const current of attempts.values()) {
      if (current.admissionId === attempt.admissionId) {
        continue;
      }
      if (attempt.sessionId !== undefined && current.sessionId === attempt.sessionId) {
        throw new ResourceConflictError("The repository session already belongs to an attempt.");
      }
      if (
        (attempt.phase === "opening" || attempt.phase === "open") &&
        (current.phase === "opening" || current.phase === "open") &&
        sameOwner(current, attempt) &&
        current.repositoryRef === attempt.repositoryRef
      ) {
        throw new ResourceConflictError("The revision repository already has an active attempt.");
      }
    }
  }

  return {
    lockAttempt: async (admissionId) => {
      const attempt = attempts.get(admissionId);
      return attempt === undefined ? undefined : immutableCopy(attempt);
    },
    findBrokerReceipt: async (admissionId) => {
      const receipt = receipts.get(admissionId);
      return receipt === undefined ? undefined : immutableCopy(receipt);
    },
    findBrokerReceiptBySession: async (sessionId) => {
      const receipt = Array.from(receipts.values()).find(
        (candidate) => candidate.sessionId === sessionId,
      );
      return receipt === undefined ? undefined : immutableCopy(receipt);
    },
    createBrokerReceipt: async (input) => {
      const attempt = attempts.get(input.admissionId);
      if (
        !attempt ||
        attempt.brokerProtocol !== 1 ||
        ["invalidated", "disposed"].includes(attempt.phase) ||
        receipts.has(input.admissionId) ||
        (input.state === "reserved" && (attempt.phase !== "opening" || !input.generation)) ||
        (input.state === "fenced" &&
          (input.generation !== undefined ||
            attempt.phase === "open" ||
            attempt.sessionId !== undefined))
      ) {
        throw new ScopeViolationError("The broker admission cannot be reserved or fenced.");
      }
      const receipt = immutableCopy(input);
      receipts.set(input.admissionId, receipt);
      return immutableCopy(receipt);
    },
    advanceBrokerReceipt: async (input) => {
      const attempt = attempts.get(input.admissionId);
      const current = receipts.get(input.admissionId);
      if (
        !current ||
        current.state !== input.expectedState ||
        current.generation !== input.generation
      ) {
        return undefined;
      }
      if (
        !attempt ||
        attempt.brokerProtocol !== 1 ||
        ["invalidated", "disposed"].includes(attempt.phase) ||
        !validIdentifier(input.sessionId) ||
        !Number.isSafeInteger(input.deadlineWallMs) ||
        input.deadlineWallMs <= 0 ||
        input.deadlineWallMs > attempt.deadlineWallMs ||
        (attempt.sessionId !== undefined && attempt.sessionId !== input.sessionId) ||
        (current.sessionId !== undefined && current.sessionId !== input.sessionId) ||
        (current.deadlineWallMs !== undefined && current.deadlineWallMs !== input.deadlineWallMs) ||
        !(
          (current.state === "reserved" &&
            input.state === "active" &&
            input.revoked === undefined &&
            input.expired === undefined) ||
          (current.state === "active" &&
            input.state === "disposed" &&
            typeof input.revoked === "number" &&
            Number.isSafeInteger(input.revoked) &&
            input.revoked >= 0 &&
            typeof input.expired === "number" &&
            Number.isSafeInteger(input.expired) &&
            input.expired >= 0)
        ) ||
        Array.from(receipts.values()).some(
          (other) => other.admissionId !== input.admissionId && other.sessionId === input.sessionId,
        )
      ) {
        throw new ScopeViolationError("The broker receipt transition is invalid.");
      }
      const receipt = immutableCopy({
        admissionId: input.admissionId,
        state: input.state,
        generation: input.generation,
        sessionId: input.sessionId,
        deadlineWallMs: input.deadlineWallMs,
        ...(input.revoked === undefined ? {} : { revoked: input.revoked }),
        ...(input.expired === undefined ? {} : { expired: input.expired }),
      });
      receipts.set(input.admissionId, receipt);
      return immutableCopy(receipt);
    },
    fenceBrokerReceipt: async (input) => {
      const attempt = attempts.get(input.admissionId);
      const current = receipts.get(input.admissionId);
      if (!current || current.state !== "reserved" || current.generation !== input.generation) {
        return undefined;
      }
      if (
        !attempt ||
        attempt.brokerProtocol !== 1 ||
        ["invalidated", "disposed", "open"].includes(attempt.phase) ||
        attempt.sessionId !== undefined
      ) {
        throw new ScopeViolationError("The broker receipt transition is invalid.");
      }
      const receipt = immutableCopy({
        admissionId: input.admissionId,
        state: "fenced" as const,
        generation: input.generation,
      });
      receipts.set(input.admissionId, receipt);
      return immutableCopy(receipt);
    },
    findAttempt: async (admissionId) => {
      const attempt = attempts.get(admissionId);
      return attempt === undefined ? undefined : immutableCopy(attempt);
    },
    listRevisionAttempts: async (owner) => list((attempt) => sameOwner(attempt, owner)),
    listNamespaceAttempts: async (namespaceId) =>
      list((attempt) => attempt.namespaceId === namespaceId),
    createAttempt: async (input) => {
      const revision = findRevision(input);
      const admitted = revision?.repositoryCredentials;
      const binding = admitted?.bindings.find(
        (candidate) => candidate.repositoryRef === input.repositoryRef,
      );
      if (
        !ownerAcceptsAdmission(input) ||
        admitted === undefined ||
        admitted.deadlineWallMs !== input.deadlineWallMs ||
        binding === undefined
      ) {
        throw new ScopeViolationError(
          "The repository session does not match its admitted revision.",
        );
      }
      if (
        !validIdentifier(input.admissionId) ||
        !validIdentifier(input.repositoryRef) ||
        !Number.isSafeInteger(input.durationSeconds) ||
        input.durationSeconds <= 0 ||
        !Number.isSafeInteger(input.deadlineWallMs) ||
        input.deadlineWallMs <= 0
      ) {
        throw new ScopeViolationError("The repository session input is invalid.");
      }
      if (attempts.has(input.admissionId)) {
        throw new ResourceConflictError("The repository session admission already exists.");
      }
      const createdAt = timestamp(input.createdAt);
      const attempt: RepositorySessionAttempt = {
        namespaceId: input.namespaceId,
        agentId: input.agentId,
        revisionId: input.revisionId,
        liveRevisionId: input.revisionId,
        cleanupContext: { driver: admitted.driver, binding },
        repositoryRef: input.repositoryRef,
        admissionId: input.admissionId,
        durationSeconds: input.durationSeconds,
        deadlineWallMs: input.deadlineWallMs,
        phase: "opening",
        brokerProtocol: input.brokerProtocol ?? 0,
        createdAt,
        updatedAt: createdAt,
      };
      assertUnique(attempt);
      const saved = immutableCopy(attempt);
      attempts.set(saved.admissionId, saved);
      return immutableCopy(saved);
    },
    advanceAttempt: async (input) => {
      const current = attempts.get(input.admissionId);
      if (current === undefined || current.phase !== input.expectedPhase) {
        return undefined;
      }
      const sessionId = input.sessionId === undefined ? current.sessionId : input.sessionId;
      const updatedAt = timestamp(input.updatedAt);
      const receipt = receipts.get(input.admissionId);
      if (
        (receipt?.sessionId !== undefined &&
          sessionId !== undefined &&
          receipt.sessionId !== sessionId) ||
        (current.brokerProtocol === 1 &&
          input.phase === "disposed" &&
          (receipt?.state !== "disposed" || receipt.sessionId !== sessionId))
      ) {
        throw new ScopeViolationError("The repository session does not match its broker receipt.");
      }
      if (
        !transitions[current.phase].includes(input.phase) ||
        (sessionId !== undefined && !validIdentifier(sessionId)) ||
        (current.sessionId !== undefined && current.sessionId !== sessionId) ||
        ((input.phase === "open" || input.phase === "disposed") && sessionId === undefined) ||
        Date.parse(updatedAt) < Date.parse(current.createdAt)
      ) {
        throw new ScopeViolationError("The repository session transition is invalid.");
      }
      const saved = immutableCopy({
        ...current,
        phase: input.phase,
        ...(sessionId === undefined ? {} : { sessionId }),
        updatedAt,
      });
      assertUnique(saved);
      attempts.set(saved.admissionId, saved);
      return immutableCopy(saved);
    },
  };
}
