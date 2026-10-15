import type {
  RepositoryBrokerReceipt,
  RepositorySessionAttempt,
  PlatformStateStore,
} from "@openclaw-enterprise/occ";
import type {
  RepositoryCredentialBoundSessionInput,
  SessionStatus,
} from "../../drivers/repo/credentials/service-contracts.ts";
import { sameBinding } from "../../drivers/repo/credentials/sessions.ts";

/** Only the worker owns State; the detached broker receives this narrow journal. */
export class RepositoryReceiptStore {
  private readonly state: PlatformStateStore;
  private readonly owner: Readonly<{ driverId: string; implementation: string; backendId: string }>;

  constructor(
    state: PlatformStateStore,
    owner: Readonly<{ driverId: string; implementation: string; backendId: string }>,
  ) {
    this.state = state;
    this.owner = owner;
  }

  private matches(
    attempt: Readonly<RepositorySessionAttempt>,
    input: RepositoryCredentialBoundSessionInput,
  ): boolean {
    const { binding, driver } = attempt.cleanupContext;
    return (
      attempt.brokerProtocol === 1 &&
      attempt.namespaceId === input.namespaceId &&
      attempt.repositoryRef === input.repositoryRef &&
      attempt.durationSeconds === input.durationSeconds &&
      attempt.deadlineWallMs === input.deadlineWallMs &&
      binding.profile === input.profile &&
      binding.backendId === this.owner.backendId &&
      driver.id === this.owner.driverId &&
      driver.implementation === this.owner.implementation &&
      sameBinding(binding.grant, input.expectedBinding)
    );
  }

  private eligible(attempt: Readonly<RepositorySessionAttempt>): boolean {
    return (
      attempt.brokerProtocol === 1 &&
      attempt.phase !== "invalidated" &&
      attempt.cleanupContext.binding.backendId === this.owner.backendId &&
      attempt.cleanupContext.driver.id === this.owner.driverId &&
      attempt.cleanupContext.driver.implementation === this.owner.implementation
    );
  }

  private terminal(
    attempt: Readonly<RepositorySessionAttempt>,
    receipt: Readonly<RepositoryBrokerReceipt>,
  ): SessionStatus {
    if (
      !this.eligible(attempt) ||
      receipt.state !== "disposed" ||
      receipt.sessionId === undefined ||
      receipt.deadlineWallMs === undefined ||
      receipt.revoked === undefined ||
      receipt.expired === undefined ||
      (attempt.sessionId !== undefined && attempt.sessionId !== receipt.sessionId)
    ) {
      throw new Error("RECEIPT_UNAVAILABLE");
    }
    return Object.freeze({
      sessionId: receipt.sessionId,
      state: "DISPOSED",
      deadlineWallMs: receipt.deadlineWallMs,
      binding: attempt.cleanupContext.binding.grant,
      activeUses: 0,
      cleanup: Object.freeze({
        active: 0,
        pending: 0,
        uncertain: 0,
        auxiliaryPending: false,
        revoked: receipt.revoked,
        expired: receipt.expired,
      }),
    });
  }

  async admission(
    admissionId: string,
    input: RepositoryCredentialBoundSessionInput,
    generation: string,
    recoverOnly: boolean,
  ) {
    return this.state.transact(async (unit) => {
      const attempt = await unit.repositorySessions.lockAttempt(admissionId);
      if (!attempt || !this.matches(attempt, input) || attempt.phase === "invalidated") {
        throw new Error("RECEIPT_UNAVAILABLE");
      }
      const current = await unit.repositorySessions.findBrokerReceipt(admissionId);
      if (current?.state === "disposed") {
        return { kind: "disposed" as const, status: this.terminal(attempt, current) };
      }
      if (current?.state === "fenced") {
        return { kind: "missing" as const };
      }
      if (current !== undefined || attempt.phase === "disposed") {
        throw new Error("RECEIPT_UNAVAILABLE");
      }
      if (recoverOnly) {
        if (attempt.sessionId !== undefined || attempt.phase === "open") {
          throw new Error("RECEIPT_UNAVAILABLE");
        }
        await unit.repositorySessions.createBrokerReceipt({ admissionId, state: "fenced" });
        return { kind: "missing" as const };
      }
      if (attempt.phase !== "opening") {
        throw new Error("RECEIPT_UNAVAILABLE");
      }
      await unit.repositorySessions.createBrokerReceipt({
        admissionId,
        state: "reserved",
        generation,
      });
      return { kind: "reserved" as const };
    });
  }

  async bind(
    admissionId: string,
    input: RepositoryCredentialBoundSessionInput,
    generation: string,
    status: SessionStatus,
  ) {
    await this.state.transact(async (unit) => {
      const attempt = await unit.repositorySessions.lockAttempt(admissionId);
      if (
        !attempt ||
        !this.matches(attempt, input) ||
        !this.eligible(attempt) ||
        status.state !== "OPEN" ||
        !sameBinding(status.binding, input.expectedBinding) ||
        status.deadlineWallMs > input.deadlineWallMs
      ) {
        throw new Error("RECEIPT_UNAVAILABLE");
      }
      const current = await unit.repositorySessions.findBrokerReceipt(admissionId);
      if (
        current?.state === "active" &&
        current.generation === generation &&
        current.sessionId === status.sessionId &&
        current.deadlineWallMs === status.deadlineWallMs
      ) {
        return;
      }
      const bound = await unit.repositorySessions.advanceBrokerReceipt({
        admissionId,
        generation,
        expectedState: "reserved",
        state: "active",
        sessionId: status.sessionId,
        deadlineWallMs: status.deadlineWallMs,
      });
      if (!bound) {
        throw new Error("RECEIPT_UNAVAILABLE");
      }
    });
  }

  /** The reserving broker never handed out a session; retries and recovery answer missing. */
  async fence(
    admissionId: string,
    input: RepositoryCredentialBoundSessionInput,
    generation: string,
  ) {
    await this.state.transact(async (unit) => {
      const attempt = await unit.repositorySessions.lockAttempt(admissionId);
      if (!attempt || !this.matches(attempt, input) || !this.eligible(attempt)) {
        throw new Error("RECEIPT_UNAVAILABLE");
      }
      const current = await unit.repositorySessions.findBrokerReceipt(admissionId);
      if (current?.state === "fenced" && current.generation === generation) {
        return;
      }
      const fenced = await unit.repositorySessions.fenceBrokerReceipt({ admissionId, generation });
      if (!fenced) {
        throw new Error("RECEIPT_UNAVAILABLE");
      }
    });
  }

  async dispose(
    admissionId: string,
    input: RepositoryCredentialBoundSessionInput,
    generation: string,
    status: SessionStatus,
  ) {
    await this.state.transact(async (unit) => {
      const attempt = await unit.repositorySessions.lockAttempt(admissionId);
      if (
        !attempt ||
        !this.matches(attempt, input) ||
        !this.eligible(attempt) ||
        status.state !== "DISPOSED" ||
        status.activeUses !== 0 ||
        status.cleanup.active !== 0 ||
        status.cleanup.pending !== 0 ||
        status.cleanup.uncertain !== 0 ||
        status.cleanup.auxiliaryPending ||
        !sameBinding(status.binding, input.expectedBinding)
      ) {
        throw new Error("RECEIPT_UNAVAILABLE");
      }
      const current = await unit.repositorySessions.findBrokerReceipt(admissionId);
      if (
        current?.state === "disposed" &&
        current.generation === generation &&
        current.sessionId === status.sessionId &&
        current.deadlineWallMs === status.deadlineWallMs &&
        current.revoked === status.cleanup.revoked &&
        current.expired === status.cleanup.expired
      ) {
        return;
      }
      const saved = await unit.repositorySessions.advanceBrokerReceipt({
        admissionId,
        generation,
        expectedState: "active",
        state: "disposed",
        sessionId: status.sessionId,
        deadlineWallMs: status.deadlineWallMs,
        revoked: status.cleanup.revoked,
        expired: status.cleanup.expired,
      });
      if (!saved) {
        throw new Error("RECEIPT_UNAVAILABLE");
      }
    });
  }

  async status(sessionId: string): Promise<SessionStatus | undefined> {
    return this.state.read(async (view) => {
      const receipt = await view.repositorySessions.findBrokerReceiptBySession(sessionId);
      if (!receipt) {
        return undefined;
      }
      const attempt = await view.repositorySessions.findAttempt(receipt.admissionId);
      if (!attempt) {
        throw new Error("RECEIPT_UNAVAILABLE");
      }
      return this.terminal(attempt, receipt);
    });
  }
}
