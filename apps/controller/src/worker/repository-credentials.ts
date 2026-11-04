import { sameBinding } from "../drivers/repo/credentials/grant-identity.ts";
import { protectedRepositoryGitAdmission } from "@openclaw-enterprise/contracts";
import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import type {
  AdmittedRepositoryBinding,
  AgentRevision,
  RepositoryPolicyDriver,
  NativeRepositorySender,
  RepositoryCredentialMaterialRef,
  RepositoryCredentialRuntimeBinding,
  RepositoryCredentialSessionStatus,
  RepositoryExecutionIdentity,
} from "@openclaw-enterprise/contracts";
import { isInstallationRepositoryProfile } from "@openclaw-enterprise/contracts";
import {
  eligibleRepositoryApprovalScope,
  isRepositoryCleanupWork,
  repositoryApprovalFingerprint,
  revisionAdmittedBeforeWork,
  WorkClaimLostError,
  type ClaimedWork,
  type PlatformUnitOfWork,
  type PlatformReadView,
  type PostgresPlatformState,
  type PostgresWorkQueue,
  type PostgresWorkQueueOptions,
  type RepositorySessionAttempt,
  type RepositorySessionPhase,
} from "@openclaw-enterprise/occ";

type Queue = Pick<PostgresWorkQueue, keyof PostgresWorkQueue>;
type Attempt = Readonly<RepositorySessionAttempt>;
type Revision = Readonly<AgentRevision>;
type RevisionIdentity = Pick<Revision, "id" | "namespaceId" | "agentId">;
type CleanupContext = Attempt["cleanupContext"];

export class RepositoryCredentialAuthorityError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "RepositoryCredentialAuthorityError";
  }
}

/** Authority is closed. The existing cleanup owner still has to confirm disposal. */
export class StandingRepositorySessionDisposingError extends Error {}

interface Dependencies {
  readonly state: PostgresPlatformState;
  readonly queueOptions: PostgresWorkQueueOptions;
  readonly driver: RepositoryPolicyDriver | undefined;
  readonly nativeSender?: NativeRepositorySender | undefined;
  readonly verifyExecution?: (
    claim: ClaimedWork,
    revision: Revision,
  ) => Promise<RepositoryExecutionIdentity | undefined>;
  readonly authorize: (claim: ClaimedWork, revision: Revision) => Promise<void>;
  readonly effect: <T>(
    claim: ClaimedWork,
    operation: (signal: AbortSignal) => Promise<T>,
  ) => Promise<T>;
}

function owner(revision: RevisionIdentity) {
  return {
    namespaceId: revision.namespaceId,
    agentId: revision.agentId,
    revisionId: revision.id,
  };
}

function assertRepositorySessionCanOpen(attempts: readonly Attempt[], repositoryRef: string): void {
  // A known session may have exposed material. Authority closure alone does
  // not settle its provider obligations or make replacement safe.
  if (
    attempts.some(
      (attempt) =>
        attempt.repositoryRef === repositoryRef &&
        attempt.sessionId !== undefined &&
        attempt.phase === "invalidated",
    )
  ) {
    throw new RepositoryCredentialAuthorityError("REPOSITORY_SESSION_RECOVERY_UNSAFE");
  }
  if (
    attempts.some(
      (attempt) => attempt.repositoryRef === repositoryRef && attempt.phase === "closing",
    )
  ) {
    throw new Error("REPOSITORY_CLEANUP_PENDING");
  }
}

/** Whether repository cleanup settled and, when it is stuck rather than waiting, why. */
export interface RepositoryCleanupOutcome {
  readonly settled: boolean;
  /**
   * Set when another pass cannot settle cleanup on its own: an `invalidated` attempt (it has no
   * outgoing transition) or a cleanup error. A `closing` session awaiting disposal has none.
   */
  readonly cause?: string;
}

const CLEANUP_CAUSE = /^[A-Z][A-Z0-9_]{0,63}$/u;

/** A loggable code for a cleanup failure, never provider text. */
export function repositoryCleanupFailureCode(error: unknown): string {
  if (error instanceof RepositoryCredentialAuthorityError) {
    return error.code;
  }
  const code = (error as { readonly code?: unknown } | null)?.code;
  if (typeof code === "string" && CLEANUP_CAUSE.test(code)) {
    return code;
  }
  if (error instanceof Error && CLEANUP_CAUSE.test(error.message)) {
    return error.message;
  }
  return "REPOSITORY_CLEANUP_FAILED";
}

function settleCleanup(attempts: readonly Readonly<RepositorySessionAttempt>[]): {
  settled: boolean;
  cause?: string;
} {
  return attempts.some((attempt) => attempt.phase === "invalidated")
    ? { settled: false, cause: "REPOSITORY_ATTEMPT_INVALIDATED" }
    : { settled: true };
}

/** Owns only persisted session correlations; material remains ephemeral until Compute accepts it. */
export class RepositoryCredentialLifecycle {
  private readonly dependencies: Dependencies;

  constructor(dependencies: Dependencies) {
    this.dependencies = dependencies;
  }

  validate(revision: Revision): number | undefined {
    const snapshot = revision.repositoryCredentials;
    if (snapshot === undefined) {
      return undefined;
    }
    const protectedGit = protectedRepositoryGitAdmission(revision.executionAdmission);
    if (
      (!protectedGit &&
        snapshot.bindings.some((binding) => isInstallationRepositoryProfile(binding.profile))) ||
      (protectedGit && !isDeepStrictEqual(revision.egressPlan?.repositoryGit, snapshot))
    ) {
      throw new RepositoryCredentialAuthorityError("REPOSITORY_PROXY_ADMISSION_MISMATCH");
    }
    const driver = this.driver(revision);
    if (snapshot.standingApprovalId === undefined && Date.now() >= snapshot.deadlineWallMs) {
      throw new RepositoryCredentialAuthorityError("REPOSITORY_CREDENTIAL_DEADLINE_EXCEEDED");
    }
    if (snapshot.standingApprovalId !== undefined) {
      const binding = snapshot.bindings[0];
      const scope =
        binding &&
        eligibleRepositoryApprovalScope(driver, { namespaceId: revision.namespaceId, binding });
      if (
        !binding ||
        snapshot.bindings.length !== 1 ||
        !scope ||
        snapshot.standingApprovalScopeFingerprint !==
          repositoryApprovalFingerprint({
            namespaceId: revision.namespaceId,
            agentId: revision.agentId,
            binding,
            scope,
          })
      ) {
        throw new RepositoryCredentialAuthorityError("REPOSITORY_STANDING_POLICY_CHANGED");
      }
    }
    let resolved;
    try {
      resolved = driver.resolve({
        namespaceId: revision.namespaceId,
        bindings: snapshot.bindings.map(({ repositoryRef, profile }) => ({
          repositoryRef,
          profile,
        })),
      });
    } catch {
      throw new RepositoryCredentialAuthorityError("REPOSITORY_BINDING_UNAVAILABLE");
    }
    if (
      !Number.isSafeInteger(resolved.sessionDurationSeconds) ||
      resolved.sessionDurationSeconds <= 0 ||
      resolved.bindings.length !== snapshot.bindings.length ||
      snapshot.bindings.some((binding) => {
        const matches = resolved.bindings.filter(
          (candidate) => candidate.repositoryRef === binding.repositoryRef,
        );
        const selected = matches[0];
        return (
          matches.length !== 1 ||
          selected === undefined ||
          selected.profile !== binding.profile ||
          selected.backendId !== binding.backendId ||
          !sameBinding(selected.grant, binding.grant)
        );
      })
    ) {
      throw new RepositoryCredentialAuthorityError("REPOSITORY_BINDING_CHANGED");
    }
    return resolved.sessionDurationSeconds;
  }

  async prepare(
    claim: ClaimedWork,
    revision: Revision,
    selectedRefs?: ReadonlySet<string>,
  ): Promise<readonly RepositoryCredentialRuntimeBinding[]> {
    if (revision.repositoryCredentials === undefined) {
      return [];
    }
    await this.authorize(claim, revision);
    const prepared: RepositoryCredentialRuntimeBinding[] = [];
    for (const binding of revision.repositoryCredentials.bindings) {
      if (selectedRefs !== undefined && !selectedRefs.has(binding.repositoryRef)) {
        continue;
      }
      let attempts = await this.dependencies.state.read((view) =>
        view.repositorySessions.listRevisionAttempts(owner(revision)),
      );
      const closingAttempts = attempts.filter(
        (candidate) =>
          candidate.repositoryRef === binding.repositoryRef && candidate.phase === "closing",
      );
      for (const attempt of closingAttempts) {
        const closed = await this.closeAttempt(claim, attempt);
        if (revision.repositoryCredentials.standingApprovalId && closed.disposalPending) {
          throw new StandingRepositorySessionDisposingError();
        }
        if (!closed.authorityClosed) {
          throw new Error("REPOSITORY_CLEANUP_PENDING");
        }
      }
      if (closingAttempts.length > 0) {
        attempts = await this.dependencies.state.read((view) =>
          view.repositorySessions.listRevisionAttempts(owner(revision)),
        );
      }
      assertRepositorySessionCanOpen(attempts, binding.repositoryRef);
      const existing = attempts.find(
        (attempt) =>
          attempt.repositoryRef === binding.repositoryRef &&
          (attempt.phase === "opening" || attempt.phase === "open"),
      );
      if (existing?.phase === "open" && existing.sessionId !== undefined) {
        const status =
          existing.brokerProtocol === 2
            ? {
                state: "OPEN" as const,
                sessionId: existing.sessionId,
                binding: binding.grant,
                deadlineWallMs: existing.deadlineWallMs,
              }
            : await this.dependencies.effect(claim, (signal) =>
                this.driverFor(revision.repositoryCredentials?.driver).status(
                  existing.sessionId!,
                  signal,
                ),
              );
        if (status === undefined) {
          await this.advance(claim, existing, "invalidated");
        } else {
          this.validateStatus(status, existing, binding);
          const duration = this.validate(revision)!;
          const renewBeforeMs = Math.min(60_000, duration * 200);
          const renew =
            revision.repositoryCredentials.standingApprovalId !== undefined &&
            status.deadlineWallMs - Date.now() <= renewBeforeMs;
          if (renew) {
            await this.captureExecution(claim, revision, true);
          }
          if (status.state === "OPEN" && status.deadlineWallMs > Date.now() && !renew) {
            await this.authorize(claim, revision);
            prepared.push({
              kind: "retained",
              repositoryRef: binding.repositoryRef,
              sessionId: status.sessionId,
              deadlineWallMs: status.deadlineWallMs,
              admissionId: existing.admissionId,
            });
            continue;
          }
          const closing = await this.markAttemptClosing(claim, revision, existing);
          const closed = await this.closeAttempt(claim, closing, status);
          if (renew && closed.disposalPending) {
            throw new StandingRepositorySessionDisposingError();
          }
          if (!closed.authorityClosed) {
            throw new Error("REPOSITORY_CLEANUP_PENDING");
          }
        }
      } else if (existing !== undefined) {
        // No bearer survives recovery. Lookup also fences a delayed first request.
        const closing = await this.markAttemptClosing(claim, revision, existing);
        const closed = await this.closeAttempt(claim, closing);
        if (!closed.authorityClosed) {
          throw new Error("REPOSITORY_CLEANUP_PENDING");
        }
      }
      prepared.push(await this.open(claim, revision, binding));
    }
    return Object.freeze(prepared);
  }

  /** An observation, not a lease: the broker still authorizes each later Git exchange. */
  async verifyRelease(
    claim: ClaimedWork,
    revision: Revision,
    binding: RepositoryCredentialMaterialRef & { readonly deadlineWallMs: number },
  ): Promise<void> {
    await this.authorizedTransaction(claim, revision, async ({ repositorySessions }) => {
      if (protectedRepositoryGitAdmission(revision.executionAdmission)) {
        const { sessionId, repositoryRef, deadlineWallMs } = binding;
        const [attempt] = (await repositorySessions.listRevisionAttempts(owner(revision))).filter(
          (a) =>
            a.phase === "open" &&
            a.brokerProtocol === 2 &&
            a.sessionId === sessionId &&
            a.repositoryRef === repositoryRef &&
            a.deadlineWallMs === deadlineWallMs,
        );
        if (!attempt || deadlineWallMs <= Date.now()) {
          throw new RepositoryCredentialAuthorityError("REPOSITORY_SESSION_NO_LONGER_CURRENT");
        }
        return;
      }
      const receipt = await repositorySessions.findBrokerReceiptBySession(binding.sessionId);
      const attempt = receipt && (await repositorySessions.findAttempt(receipt.admissionId));
      if (
        receipt?.state !== "active" ||
        receipt.sessionId !== binding.sessionId ||
        receipt.deadlineWallMs !== binding.deadlineWallMs ||
        binding.deadlineWallMs <= Date.now() ||
        attempt?.phase !== "open" ||
        attempt.liveRevisionId !== revision.id ||
        attempt.namespaceId !== revision.namespaceId ||
        attempt.agentId !== revision.agentId ||
        attempt.brokerProtocol !== 3 ||
        attempt.repositoryRef !== binding.repositoryRef ||
        attempt.sessionId !== binding.sessionId
      ) {
        throw new RepositoryCredentialAuthorityError("REPOSITORY_SESSION_NO_LONGER_CURRENT");
      }
    });
  }

  async repair(
    claim: ClaimedWork,
    revision: Revision,
    bindings: readonly RepositoryCredentialRuntimeBinding[],
    missing: readonly RepositoryCredentialMaterialRef[],
  ): Promise<readonly RepositoryCredentialRuntimeBinding[]> {
    const refs = new Set<string>();
    if (
      missing.length === 0 ||
      missing.some((entry) => {
        if (
          refs.has(entry.repositoryRef) ||
          !bindings.some(
            (binding) =>
              binding.repositoryRef === entry.repositoryRef &&
              binding.sessionId === entry.sessionId,
          )
        ) {
          return true;
        }
        refs.add(entry.repositoryRef);
        return false;
      })
    ) {
      throw new RepositoryCredentialAuthorityError("INVALID_DRIVER_OBSERVATION");
    }
    await this.authorize(claim, revision);
    const attempts = await this.dependencies.state.read((view) =>
      view.repositorySessions.listRevisionAttempts(owner(revision)),
    );
    for (const missingRef of missing) {
      const attempt = attempts.find(
        (candidate) =>
          candidate.repositoryRef === missingRef.repositoryRef &&
          candidate.sessionId === missingRef.sessionId &&
          candidate.phase === "open",
      );
      if (attempt === undefined) {
        throw new RepositoryCredentialAuthorityError("INVALID_DRIVER_OBSERVATION");
      }
      const closing = await this.markAttemptClosing(claim, revision, attempt);
      const closed = await this.closeAttempt(claim, closing);
      if (!closed.authorityClosed) {
        throw new Error("REPOSITORY_CLEANUP_PENDING");
      }
    }
    const replacements = await this.prepare(claim, revision, refs);
    return Object.freeze([
      ...bindings.filter((binding) => !refs.has(binding.repositoryRef)),
      ...replacements,
    ]);
  }

  async closeRevision(
    claim: ClaimedWork,
    revision: Revision,
    options: { readonly awaitCleanup?: boolean } = {},
  ): Promise<boolean> {
    await this.dependencies.state.transactWithQueue(async (unit, queue) => {
      await this.heartbeat(queue, claim);
      const namespace = await unit.namespaces.lockNamespace(revision.namespaceId, {
        includeDeleted: true,
      });
      const agent = await unit.agents.lockAgent(revision.namespaceId, revision.agentId);
      await this.heartbeat(queue, claim);
      const beforeSource = revisionAdmittedBeforeWork(revision, claim);
      let closeLive = claim.revisionId !== undefined;
      if (claim.agentTarget === "stopped") {
        closeLive = agent?.desiredRuntimeState === "stopped" && beforeSource;
      } else if (claim.agentTarget === "deleted") {
        closeLive =
          agent?.status === "deleting" && agent.desiredRuntimeState === "stopped" && beforeSource;
      } else if (claim.namespaceTarget === "deleted") {
        closeLive = namespace?.status === "deleting" && beforeSource;
      }
      const attempts = await unit.repositorySessions.listRevisionAttempts(owner(revision));
      for (const attempt of attempts) {
        if (closeLive && (attempt.phase === "opening" || attempt.phase === "open")) {
          await this.advanceIn(unit, attempt, "closing");
        }
      }
      // Registration validates exact claim/owner scope; rejection rolls back phase changes.
      await queue.enqueueRepositoryCleanup(claim, owner(revision));
    }, this.dependencies.queueOptions);
    if (options.awaitCleanup === false) {
      return false;
    }
    return (await this.cleanup(claim, revision)).settled;
  }

  async cleanup(
    claim: ClaimedWork,
    revision: RevisionIdentity,
    options: { readonly closeLiveSessions?: boolean } = {},
  ): Promise<RepositoryCleanupOutcome> {
    if (options.closeLiveSessions) {
      await this.dependencies.state.transactWithQueue(async (unit, queue) => {
        await this.heartbeat(queue, claim);
        await unit.namespaces.lockNamespace(revision.namespaceId, { includeDeleted: true });
        await unit.agents.lockAgent(revision.namespaceId, revision.agentId);
        await this.heartbeat(queue, claim);
        const attempts = await unit.repositorySessions.listRevisionAttempts(owner(revision));
        for (const attempt of attempts) {
          if (attempt.phase === "opening" || attempt.phase === "open") {
            await this.advanceIn(unit, attempt, "closing");
          }
        }
      }, this.dependencies.queueOptions);
    }
    const attempts = await this.dependencies.state.read((view) =>
      view.repositorySessions.listRevisionAttempts(owner(revision)),
    );
    return this.cleanupRetained(claim, attempts);
  }

  async cleanupRetained(
    claim: ClaimedWork,
    attempts: readonly Readonly<RepositorySessionAttempt>[],
  ): Promise<RepositoryCleanupOutcome> {
    const outcome = settleCleanup(attempts);
    for (const attempt of attempts.filter((candidate) => candidate.phase === "closing")) {
      try {
        const closed = await this.closeAttempt(claim, attempt);
        outcome.settled = closed.settled && outcome.settled;
      } catch (error) {
        if (error instanceof WorkClaimLostError) {
          throw error;
        }
        outcome.settled = false;
        outcome.cause ??= repositoryCleanupFailureCode(error);
      }
    }
    return outcome;
  }

  private driver(revision: Revision): RepositoryPolicyDriver {
    const driver = this.dependencies.driver;
    const selected = revision.repositoryCredentials?.driver;
    if (
      !driver ||
      !selected ||
      driver.id !== selected.id ||
      driver.implementation !== selected.implementation
    ) {
      throw new RepositoryCredentialAuthorityError("REPOSITORY_DRIVER_MISMATCH");
    }
    return driver;
  }

  private driverFor(selected: CleanupContext["driver"] | undefined): NativeRepositorySender {
    const driver = this.dependencies.nativeSender;
    if (
      driver === undefined ||
      selected === undefined ||
      driver.id !== selected.id ||
      driver.implementation !== selected.implementation
    ) {
      throw new RepositoryCredentialAuthorityError("REPOSITORY_DRIVER_MISMATCH");
    }
    return driver;
  }

  /** Pins only a fresh observation of the active execution; never creates or repairs Compute. */
  async captureExecution(
    claim: ClaimedWork,
    revision: Revision,
    required = false,
  ): Promise<RepositoryExecutionIdentity | undefined> {
    if (!revision.repositoryCredentials?.standingApprovalId) {
      return;
    }
    const active = await this.dependencies.state.read((v) =>
      v.agents.findAgent(revision.namespaceId, revision.agentId),
    );
    if (active?.activeRevisionId !== revision.id) {
      if (required) {
        throw new RepositoryCredentialAuthorityError("REPOSITORY_EXECUTION_UNVERIFIED");
      }
      return;
    }
    const execution = await this.dependencies.verifyExecution?.(claim, revision);
    if (!execution || !execution.executionId || !/^[a-f0-9]{64}$/.test(execution.fingerprint)) {
      if (required) {
        throw new RepositoryCredentialAuthorityError("REPOSITORY_EXECUTION_UNVERIFIED");
      }
      return;
    }
    await this.authorizedTransaction(claim, revision, (u) =>
      u.repositorySessions.recordStandingExecution(owner(revision), execution),
    );
    return execution;
  }

  private async validateStanding(revision: Revision, unit?: PlatformUnitOfWork): Promise<void> {
    const snapshot = revision.repositoryCredentials;
    if (snapshot?.standingApprovalId === undefined) {
      return;
    }
    const read = (view: Pick<PlatformReadView, "repositorySessions">) =>
      view.repositorySessions.findStandingApproval(
        revision.namespaceId,
        revision.agentId,
        snapshot.bindings[0]!.repositoryRef,
      );
    const approval = unit ? await read(unit) : await this.dependencies.state.read(read);
    if (
      !approval ||
      approval.id !== snapshot.standingApprovalId ||
      approval.generation !== snapshot.standingApprovalGeneration ||
      approval.scopeFingerprint !== snapshot.standingApprovalScopeFingerprint
    ) {
      throw new RepositoryCredentialAuthorityError("REPOSITORY_STANDING_APPROVAL_REMOVED");
    }
  }

  async authorize(claim: ClaimedWork, revision: Revision): Promise<void> {
    this.validate(revision);
    await this.dependencies.authorize(claim, revision);
    await this.validateStanding(revision);
    if (revision.repositoryCredentials?.standingApprovalId) {
      const recorded = await this.dependencies.state.read((v) =>
        v.repositorySessions.findStandingExecution(owner(revision)),
      );
      if (recorded) {
        if (recorded.closed) {
          throw new RepositoryCredentialAuthorityError("REPOSITORY_EXECUTION_CLOSED");
        }
        const observed = await this.dependencies.verifyExecution?.(claim, revision);
        if (!observed || !observed.executionId || !/^[a-f0-9]{64}$/.test(observed.fingerprint)) {
          throw new RepositoryCredentialAuthorityError("REPOSITORY_EXECUTION_UNVERIFIED");
        }
        if (
          observed.executionId !== recorded.executionId ||
          observed.fingerprint !== recorded.fingerprint
        ) {
          throw new RepositoryCredentialAuthorityError("REPOSITORY_EXECUTION_REPLACED");
        }
      } else if (Date.now() >= revision.repositoryCredentials.deadlineWallMs) {
        throw new RepositoryCredentialAuthorityError("REPOSITORY_EXECUTION_UNVERIFIED");
      }
    }
    this.validate(revision);
  }

  private async authorizedTransaction<T>(
    claim: ClaimedWork,
    revision: Revision,
    operation: (unit: PlatformUnitOfWork, queue: Queue) => Promise<T>,
  ): Promise<T> {
    await this.authorize(claim, revision);
    return this.dependencies.state.transactWithQueue(async (unit, queue) => {
      await this.heartbeat(queue, claim);
      const namespace = await unit.namespaces.lockNamespace(revision.namespaceId);
      const agent = await unit.agents.lockAgent(revision.namespaceId, revision.agentId);
      await this.heartbeat(queue, claim);
      if (
        namespace?.status !== "ready" ||
        agent?.desiredRuntimeState !== "running" ||
        agent.servicePrincipalId !== revision.servicePrincipalId
      ) {
        throw new RepositoryCredentialAuthorityError("REPOSITORY_REVISION_STOPPED");
      }
      if (agent.activeRevisionId !== undefined && agent.activeRevisionId !== revision.id) {
        const active = await unit.revisions.findRevision(
          revision.namespaceId,
          revision.agentId,
          agent.activeRevisionId,
        );
        if (active === undefined || active.revision >= revision.revision) {
          throw new RepositoryCredentialAuthorityError("REPOSITORY_REVISION_SUPERSEDED");
        }
      }
      this.validate(revision);
      await this.validateStanding(revision, unit);
      return operation(unit, queue);
    }, this.dependencies.queueOptions);
  }

  private async open(
    claim: ClaimedWork,
    revision: Revision,
    binding: AdmittedRepositoryBinding,
  ): Promise<RepositoryCredentialRuntimeBinding> {
    const proxy = protectedRepositoryGitAdmission(revision.executionAdmission);
    const driver = proxy ? undefined : this.driverFor(revision.repositoryCredentials?.driver);
    if (driver && driver.durableBrokerReceipts !== true) {
      throw new RepositoryCredentialAuthorityError("REPOSITORY_PREPARED_ADMISSION_UNAVAILABLE");
    }
    if (driver && driver.checkAdmissionReady !== undefined) {
      await this.dependencies.effect(claim, (signal) =>
        driver.checkAdmissionReady!(AbortSignal.any([signal, AbortSignal.timeout(2000)])),
      );
    }
    const standing = revision.repositoryCredentials?.standingApprovalId !== undefined;
    const predecessor = standing
      ? await this.dependencies.state.read(async (v) =>
          (await v.repositorySessions.listRevisionAttempts(owner(revision)))
            .filter((a) => a.repositoryRef === binding.repositoryRef)
            .at(-1),
        )
      : undefined;
    const execution = predecessor ? await this.captureExecution(claim, revision, true) : undefined;
    const attempt = await this.authorizedTransaction(claim, revision, async (unit) => {
      const attempts = await unit.repositorySessions.listRevisionAttempts(owner(revision));
      assertRepositorySessionCanOpen(attempts, binding.repositoryRef);
      const openedAt = Date.now();
      const deadlineWallMs = predecessor
        ? openedAt + this.validate(revision)! * 1000
        : revision.repositoryCredentials!.deadlineWallMs;
      const durationSeconds = predecessor
        ? this.validate(revision)!
        : Math.min(this.validate(revision)!, Math.floor((deadlineWallMs - Date.now()) / 1000));
      if (durationSeconds < 1) {
        throw new RepositoryCredentialAuthorityError("REPOSITORY_CREDENTIAL_DEADLINE_EXCEEDED");
      }
      const attempt = await unit.repositorySessions.createAttempt({
        ...owner(revision),
        ...(predecessor
          ? {
              predecessorAdmissionId: predecessor.admissionId,
              executionFingerprint: execution!.fingerprint,
            }
          : {}),
        repositoryRef: binding.repositoryRef,
        admissionId: `${Date.now()}-${randomUUID()}`,
        durationSeconds,
        deadlineWallMs,
        createdAt: new Date(openedAt).toISOString(),
        brokerProtocol: proxy ? 2 : 3,
      });
      // OCC creates the opaque session ID and commits both states together. No secret exists
      // here. Preparation requires the active execution and the verified installation separately.
      return proxy ? this.advanceIn(unit, attempt, "open", randomUUID()) : attempt;
    });
    if (proxy) {
      return {
        kind: "retained",
        repositoryRef: binding.repositoryRef,
        sessionId: attempt.sessionId!,
        deadlineWallMs: attempt.deadlineWallMs,
        admissionId: attempt.admissionId,
      };
    }
    await this.authorize(claim, revision);
    const opened = await this.dependencies.effect(claim, (signal) =>
      driver!.open(this.input(attempt, binding), signal),
    );
    if (opened.kind === "missing") {
      await this.advance(claim, attempt, "invalidated");
      throw new Error("REPOSITORY_ADMISSION_MISSING");
    }
    if (opened.kind === "recovered") {
      this.validateStatus(opened.status, attempt, binding);
      const closing = await this.markAttemptClosing(
        claim,
        revision,
        attempt,
        opened.status.sessionId,
      );
      await this.closeAttempt(claim, closing, opened.status);
      throw new Error("REPOSITORY_ADMISSION_RECOVERED");
    }
    if (predecessor) {
      const current = await this.captureExecution(claim, revision, true);
      if (current!.fingerprint !== execution!.fingerprint) {
        throw new RepositoryCredentialAuthorityError("REPOSITORY_EXECUTION_CHANGED");
      }
    }
    this.validateStatus(opened.session, attempt, binding);
    if (opened.session.state !== "OPEN" || opened.session.deadlineWallMs <= Date.now()) {
      const closing = await this.markAttemptClosing(
        claim,
        revision,
        attempt,
        opened.session.sessionId,
      );
      await this.closeAttempt(claim, closing, opened.session);
      throw new Error("REPOSITORY_SESSION_NOT_OPEN");
    }
    try {
      await this.authorizedTransaction(claim, revision, (unit) =>
        this.advanceIn(unit, attempt, "open", opened.session.sessionId),
      );
    } catch (error) {
      if (!(error instanceof WorkClaimLostError)) {
        const closing = await this.markAttemptClosing(
          claim,
          revision,
          attempt,
          opened.session.sessionId,
        );
        await this.closeAttempt(claim, closing).catch(() => {});
      }
      // The original admission remains recoverable even when the claim was lost.
      throw error;
    }
    return {
      kind: "new",
      repositoryRef: binding.repositoryRef,
      sessionId: opened.session.sessionId,
      deadlineWallMs: opened.session.deadlineWallMs,
      admissionId: attempt.admissionId,
      files: opened.files,
    };
  }

  private input(attempt: Attempt, binding: AdmittedRepositoryBinding) {
    return {
      namespaceId: attempt.namespaceId,
      admissionId: attempt.admissionId,
      ...(attempt.brokerProtocol === 3 ? { preparedOnly: true as const } : {}),
      binding,
      durationSeconds: attempt.durationSeconds,
      deadlineWallMs: attempt.deadlineWallMs,
    };
  }

  private validateStatus(
    status: RepositoryCredentialSessionStatus,
    attempt: Attempt,
    binding: AdmittedRepositoryBinding,
  ): void {
    if (
      typeof status.sessionId !== "string" ||
      status.sessionId.length === 0 ||
      (attempt.sessionId !== undefined && status.sessionId !== attempt.sessionId) ||
      !["OPEN", "CLOSED", "DISPOSED"].includes(status.state) ||
      !Number.isSafeInteger(status.deadlineWallMs) ||
      status.deadlineWallMs <= 0 ||
      status.deadlineWallMs > attempt.deadlineWallMs ||
      !sameBinding(status.binding, binding.grant)
    ) {
      throw new RepositoryCredentialAuthorityError("INVALID_REPOSITORY_DRIVER_OBSERVATION");
    }
  }

  private async closeAttempt(
    claim: ClaimedWork,
    attempt: Attempt,
    observedStatus?: RepositoryCredentialSessionStatus,
  ) {
    const context = attempt.cleanupContext;
    if (context.binding.repositoryRef !== attempt.repositoryRef) {
      throw new RepositoryCredentialAuthorityError("INVALID_REPOSITORY_ATTEMPT_OWNER");
    }
    const binding = context.binding;
    if (attempt.brokerProtocol === 2) {
      // This disposes only the local session. The prepared owner retains every unsettled token,
      // and a successor cannot prepare until overlapping material has a known terminal disposition.
      await this.advance(claim, attempt, "disposed");
      return { settled: true, authorityClosed: true, disposalPending: false };
    }
    const driver = this.driverFor(context.driver);
    let closing = attempt;
    let status = observedStatus;
    if (closing.sessionId === undefined) {
      const recovered = await this.dependencies.effect(claim, (signal) =>
        driver.open({ ...this.input(closing, binding), recoverOnly: true }, signal),
      );
      if (recovered.kind === "created") {
        throw new RepositoryCredentialAuthorityError("INVALID_REPOSITORY_DRIVER_OBSERVATION");
      }
      if (recovered.kind === "missing") {
        await this.advance(claim, closing, "invalidated");
        return { settled: false, authorityClosed: true };
      }
      this.validateStatus(recovered.status, closing, binding);
      closing = await this.advance(claim, closing, "closing", recovered.status.sessionId);
      status = recovered.status;
    }
    // Preserve confirmed disposal even if a later service admission prunes its
    // terminal inventory. Missing inventory alone never establishes disposal.
    if (status?.state !== "DISPOSED") {
      status = await this.dependencies.effect(claim, (signal) =>
        driver.close(closing.sessionId!, signal),
      );
    }
    if (status === undefined) {
      await this.advance(claim, closing, "invalidated");
      return { settled: false, authorityClosed: true };
    }
    this.validateStatus(status, closing, binding);
    if (status.state === "DISPOSED") {
      await this.advance(claim, closing, "disposed");
      return { settled: true, authorityClosed: true };
    }
    const disposalPending = status.state === "CLOSED";
    return { settled: false, authorityClosed: disposalPending, disposalPending };
  }

  private async markAttemptClosing(
    claim: ClaimedWork,
    revision: Revision,
    attempt: Attempt,
    sessionId?: string,
  ): Promise<Attempt> {
    return this.dependencies.state.transactWithQueue(async (unit, queue) => {
      await this.heartbeat(queue, claim);
      await unit.namespaces.lockNamespace(revision.namespaceId, { includeDeleted: true });
      await unit.agents.lockAgent(revision.namespaceId, revision.agentId);
      await this.heartbeat(queue, claim);
      const closing = await this.advanceIn(unit, attempt, "closing", sessionId);
      await queue.enqueueRepositoryCleanup(claim, owner(revision));
      return closing;
    }, this.dependencies.queueOptions);
  }

  private async advance(
    claim: ClaimedWork,
    attempt: Attempt,
    phase: RepositorySessionPhase,
    sessionId?: string,
  ): Promise<Attempt> {
    return this.dependencies.state.transactWithQueue(async (unit, queue) => {
      await this.heartbeat(queue, claim);
      await unit.namespaces.lockNamespace(attempt.namespaceId, { includeDeleted: true });
      await unit.agents.lockAgent(attempt.namespaceId, attempt.agentId);
      await this.heartbeat(queue, claim);
      const advanced = await this.advanceIn(unit, attempt, phase, sessionId);
      if (phase === "invalidated" && !isRepositoryCleanupWork(claim)) {
        await queue.enqueueRepositoryCleanup(claim, attempt);
      }
      return advanced;
    }, this.dependencies.queueOptions);
  }

  private async advanceIn(
    unit: PlatformUnitOfWork,
    attempt: Attempt,
    phase: RepositorySessionPhase,
    sessionId?: string,
  ): Promise<Attempt> {
    const advanced = await unit.repositorySessions.advanceAttempt({
      admissionId: attempt.admissionId,
      expectedPhase: attempt.phase,
      phase,
      ...(sessionId === undefined ? {} : { sessionId }),
      updatedAt: new Date().toISOString(),
    });
    if (advanced === undefined) {
      throw new WorkClaimLostError();
    }
    return advanced;
  }

  private async heartbeat(queue: Queue, claim: ClaimedWork): Promise<void> {
    if ((await queue.heartbeat(claim)) === undefined) {
      throw new WorkClaimLostError();
    }
  }
}
