import { randomUUID } from "node:crypto";
import type {
  AdmittedRepositoryBinding,
  AgentRevision,
  RepoDriver,
  RepositoryCredentialMaterialRef,
  RepositoryCredentialRuntimeBinding,
  RepositoryCredentialSessionStatus,
} from "@openclaw-enterprise/contracts";
import {
  isRepositoryCleanupWork,
  WorkClaimLostError,
  type ClaimedWork,
  type PlatformUnitOfWork,
  type PostgresPlatformState,
  type PostgresWorkQueue,
  type PostgresWorkQueueOptions,
  type RepositorySessionAttempt,
  type RepositorySessionPhase,
} from "@openclaw-enterprise/occ";

type Queue = Pick<PostgresWorkQueue, keyof PostgresWorkQueue>;
type Attempt = Readonly<RepositorySessionAttempt>;
type Revision = Readonly<AgentRevision>;

export class RepositoryCredentialAuthorityError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "RepositoryCredentialAuthorityError";
  }
}

interface Dependencies {
  readonly state: PostgresPlatformState;
  readonly queueOptions: PostgresWorkQueueOptions;
  readonly driver: RepoDriver | undefined;
  readonly authorize: (claim: ClaimedWork, revision: Revision) => Promise<void>;
  readonly effect: <T>(
    claim: ClaimedWork,
    operation: (signal: AbortSignal) => Promise<T>,
  ) => Promise<T>;
}

function owner(revision: Revision) {
  return {
    namespaceId: revision.namespaceId,
    agentId: revision.agentId,
    revisionId: revision.id,
  };
}

function sameGrant(
  left: AdmittedRepositoryBinding["grant"],
  right: AdmittedRepositoryBinding["grant"],
): boolean {
  return (
    left.providerInstanceId === right.providerInstanceId &&
    left.repositoryId === right.repositoryId &&
    left.grantId === right.grantId
  );
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
    const driver = this.driver(revision);
    if (Date.now() >= snapshot.deadlineWallMs) {
      throw new RepositoryCredentialAuthorityError("REPOSITORY_CREDENTIAL_DEADLINE_EXCEEDED");
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
          !sameGrant(selected.grant, binding.grant)
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
        const closed = await this.closeAttempt(claim, revision, attempt);
        if (!closed.authorityClosed) {
          throw new Error("REPOSITORY_CLEANUP_PENDING");
        }
      }
      if (closingAttempts.length > 0) {
        attempts = await this.dependencies.state.read((view) =>
          view.repositorySessions.listRevisionAttempts(owner(revision)),
        );
      }
      if (
        attempts.some(
          (attempt) =>
            attempt.repositoryRef === binding.repositoryRef &&
            attempt.sessionId !== undefined &&
            attempt.phase === "invalidated",
        )
      ) {
        throw new RepositoryCredentialAuthorityError("REPOSITORY_SESSION_RECOVERY_UNSAFE");
      }
      if (
        attempts.some(
          (attempt) =>
            attempt.repositoryRef === binding.repositoryRef && attempt.phase === "closing",
        )
      ) {
        throw new Error("REPOSITORY_CLEANUP_PENDING");
      }
      const existing = attempts.find(
        (attempt) =>
          attempt.repositoryRef === binding.repositoryRef &&
          (attempt.phase === "opening" || attempt.phase === "open"),
      );
      if (existing?.phase === "open" && existing.sessionId !== undefined) {
        const status = await this.dependencies.effect(claim, (signal) =>
          this.driver(revision).status(existing.sessionId!, signal),
        );
        if (status === undefined) {
          await this.advance(claim, existing, "invalidated");
        } else {
          this.validateStatus(status, existing, binding);
          if (status.state === "OPEN" && status.deadlineWallMs > Date.now()) {
            await this.authorize(claim, revision);
            prepared.push({
              kind: "retained",
              repositoryRef: binding.repositoryRef,
              sessionId: status.sessionId,
              deadlineWallMs: status.deadlineWallMs,
            });
            continue;
          }
          const closing = await this.markAttemptClosing(claim, revision, existing);
          const closed = await this.closeAttempt(claim, revision, closing, status);
          if (!closed.authorityClosed) {
            throw new Error("REPOSITORY_CLEANUP_PENDING");
          }
        }
      } else if (existing !== undefined) {
        // No bearer survives recovery. Lookup also fences a delayed first request.
        const closing = await this.markAttemptClosing(claim, revision, existing);
        const closed = await this.closeAttempt(claim, revision, closing);
        if (!closed.authorityClosed) {
          throw new Error("REPOSITORY_CLEANUP_PENDING");
        }
      }
      prepared.push(await this.open(claim, revision, binding));
    }
    return Object.freeze(prepared);
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
      const closed = await this.closeAttempt(claim, revision, closing);
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

  async closeRevision(claim: ClaimedWork, revision: Revision): Promise<boolean> {
    await this.dependencies.state.transactWithQueue(async (unit, queue) => {
      await this.heartbeat(queue, claim);
      const namespace = await unit.namespaces.lockNamespace(revision.namespaceId, {
        includeDeleted: true,
      });
      const agent = await unit.agents.lockAgent(revision.namespaceId, revision.agentId);
      await this.heartbeat(queue, claim);
      const beforeSource = Date.parse(revision.createdAt) <= claim.createdAt.getTime();
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
    return this.cleanup(claim, revision);
  }

  async cleanup(
    claim: ClaimedWork,
    revision: Revision,
    options: { readonly retireRuntime?: boolean } = {},
  ): Promise<boolean> {
    if (options.retireRuntime) {
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
    let complete = !attempts.some((attempt) => attempt.phase === "invalidated");
    for (const attempt of attempts.filter((candidate) => candidate.phase === "closing")) {
      try {
        const closed = await this.closeAttempt(claim, revision, attempt);
        complete = closed.settled && complete;
      } catch (error) {
        if (error instanceof WorkClaimLostError) {
          throw error;
        }
        complete = false;
      }
    }
    return complete;
  }

  private driver(revision: Revision): RepoDriver {
    const driver = this.dependencies.driver;
    const selected = revision.repositoryCredentials?.driver;
    if (
      driver === undefined ||
      selected === undefined ||
      driver.capability !== "repo" ||
      driver.id !== selected.id ||
      driver.implementation !== selected.implementation
    ) {
      throw new RepositoryCredentialAuthorityError("REPOSITORY_DRIVER_MISMATCH");
    }
    return driver;
  }

  private async authorize(claim: ClaimedWork, revision: Revision): Promise<void> {
    this.validate(revision);
    await this.dependencies.authorize(claim, revision);
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
      return operation(unit, queue);
    }, this.dependencies.queueOptions);
  }

  private async open(
    claim: ClaimedWork,
    revision: Revision,
    binding: AdmittedRepositoryBinding,
  ): Promise<RepositoryCredentialRuntimeBinding> {
    const attempt = await this.authorizedTransaction(claim, revision, async (unit) => {
      const attempts = await unit.repositorySessions.listRevisionAttempts(owner(revision));
      // A known session may have exposed material. Authority closure alone does
      // not settle its provider obligations or make replacement safe.
      if (
        attempts.some(
          (prior) =>
            prior.repositoryRef === binding.repositoryRef &&
            prior.sessionId !== undefined &&
            prior.phase === "invalidated",
        )
      ) {
        throw new RepositoryCredentialAuthorityError("REPOSITORY_SESSION_RECOVERY_UNSAFE");
      }
      if (
        attempts.some(
          (prior) => prior.repositoryRef === binding.repositoryRef && prior.phase === "closing",
        )
      ) {
        throw new Error("REPOSITORY_CLEANUP_PENDING");
      }
      const deadlineWallMs = revision.repositoryCredentials!.deadlineWallMs;
      const durationSeconds = Math.min(
        this.validate(revision)!,
        Math.floor((deadlineWallMs - Date.now()) / 1000),
      );
      if (durationSeconds < 1) {
        throw new RepositoryCredentialAuthorityError("REPOSITORY_CREDENTIAL_DEADLINE_EXCEEDED");
      }
      return unit.repositorySessions.createAttempt({
        ...owner(revision),
        repositoryRef: binding.repositoryRef,
        admissionId: `${Date.now()}-${randomUUID()}`,
        durationSeconds,
        deadlineWallMs,
        createdAt: new Date().toISOString(),
      });
    });
    await this.authorize(claim, revision);
    const opened = await this.dependencies.effect(claim, (signal) =>
      this.driver(revision).open(this.input(attempt, binding), signal),
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
      await this.closeAttempt(claim, revision, closing, opened.status);
      throw new Error("REPOSITORY_ADMISSION_RECOVERED");
    }
    this.validateStatus(opened.session, attempt, binding);
    if (opened.session.state !== "OPEN" || opened.session.deadlineWallMs <= Date.now()) {
      const closing = await this.markAttemptClosing(
        claim,
        revision,
        attempt,
        opened.session.sessionId,
      );
      await this.closeAttempt(claim, revision, closing, opened.session);
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
        await this.closeAttempt(claim, revision, closing).catch(() => {});
      }
      // The original admission remains recoverable even when the claim was lost.
      throw error;
    }
    return {
      kind: "new",
      repositoryRef: binding.repositoryRef,
      sessionId: opened.session.sessionId,
      deadlineWallMs: opened.session.deadlineWallMs,
      files: opened.files,
    };
  }

  private input(attempt: Attempt, binding: AdmittedRepositoryBinding) {
    return {
      namespaceId: attempt.namespaceId,
      admissionId: attempt.admissionId,
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
      !sameGrant(status.binding, binding.grant)
    ) {
      throw new RepositoryCredentialAuthorityError("INVALID_REPOSITORY_DRIVER_OBSERVATION");
    }
  }

  private async closeAttempt(
    claim: ClaimedWork,
    revision: Revision,
    attempt: Attempt,
    observedStatus?: RepositoryCredentialSessionStatus,
  ) {
    const binding = revision.repositoryCredentials?.bindings.find(
      (candidate) => candidate.repositoryRef === attempt.repositoryRef,
    );
    if (binding === undefined) {
      throw new RepositoryCredentialAuthorityError("INVALID_REPOSITORY_ATTEMPT_OWNER");
    }
    const driver = this.driver(revision);
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
    return { settled: false, authorityClosed: status.state === "CLOSED" };
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
