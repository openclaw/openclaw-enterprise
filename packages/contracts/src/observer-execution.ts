export type ObserverTargetRole = "agent" | "gateway";

export interface ObserverImageIdentity {
  readonly reference: string;
  readonly digest: string;
  readonly qualificationId: string;
}

export interface ObserverObservationScope {
  readonly kind: "dns";
  readonly interfaceName: string;
  readonly filterIdentity: string;
}

export interface ObserverInvocationLimits {
  readonly maximumDurationMs: number;
  readonly maximumCapturedRecords: number;
  readonly maximumEncodedOutputBytes: number;
}

export interface ObserverCancellationContract {
  readonly kind: "claim_abort";
  readonly gracePeriodMs: number;
}

export interface ObserverEvidenceDestination {
  readonly contractId: string;
  readonly destinationId: string;
}

export interface ObserverSecurityProfile {
  readonly profileId: string;
  readonly capabilities: readonly [];
  readonly privileged: false;
}

export interface ObserverInvocationPlanInput {
  readonly backendVersion: string;
  readonly image: Readonly<ObserverImageIdentity>;
  readonly observationScope: Readonly<ObserverObservationScope>;
  readonly limits: Readonly<ObserverInvocationLimits>;
  readonly cancellation: Readonly<ObserverCancellationContract>;
  readonly evidenceDestination: Readonly<ObserverEvidenceDestination>;
  readonly cleanupPolicy: "observer_first";
  readonly securityProfile: Readonly<ObserverSecurityProfile>;
}

export interface ObserverInvocationPlan extends ObserverInvocationPlanInput {
  readonly qualificationId: string;
}

export interface ObserverTargetResolutionEvidence {
  readonly targetContainerId: string;
  readonly namespaceNetworkId: string;
  readonly targetIdentity: string;
  readonly observedAt: string;
}

export interface ObserverCreateDispatchEvidence {
  readonly invocationId: string;
  readonly dispatchedAt: string;
}

export interface ObserverContainerEvidence {
  readonly observerContainerId: string;
  readonly createdAt: string;
}

export type ObserverCreationReconciliation =
  | Readonly<{ outcome: "created"; observer: Readonly<ObserverContainerEvidence> }>
  | Readonly<{ outcome: "unresolved" }>;

export interface ObserverReadinessEvidence {
  readonly targetContainerId: string;
  readonly interfaceName: string;
  readonly filterIdentity: string;
  readonly readyAt: string;
}

export type ObserverInvocationOutcome = "succeeded" | "failed" | "cancelled" | "timed_out";

export type ObserverBoundReached = "duration" | "record_count" | "encoded_output";

export interface ObserverTerminalEvidence {
  readonly startedAt: string;
  readonly captureDeadlineAt: string;
  readonly captureStoppedAt: string;
  readonly terminalCompletedAt: string;
  readonly startOutcome: ObserverInvocationOutcome;
  readonly stopOutcome: ObserverInvocationOutcome;
  readonly boundsReached: readonly ObserverBoundReached[];
  readonly capturedRecordCount: number;
  readonly encodedOutputBytes: number;
}

export interface ObserverAbsenceEvidence {
  readonly reason: "observer_not_created";
  readonly absenceVerifiedAt: string;
  readonly targetTeardownAuthorized: true;
}

export interface ObserverCleanupEvidence {
  readonly terminationRequestedAt: string;
  readonly graceDeadline: string;
  readonly forceRemovalOutcome: "not_required" | "removed";
  readonly removalCompletedAt?: string;
  readonly absenceVerifiedAt: string;
  readonly targetTeardownAuthorized: true;
}

export interface ObserverExecutionContext {
  readonly workId: string;
  readonly namespaceId: string;
  readonly agentId: string;
  readonly revisionId: string;
  readonly targetRole: ObserverTargetRole;
  readonly plan: Readonly<ObserverInvocationPlan>;
}

export interface ObserverExecutor {
  readonly backendVersion: string;

  resolveTarget(
    context: Readonly<ObserverExecutionContext>,
    signal: AbortSignal,
  ): Promise<Readonly<ObserverTargetResolutionEvidence>>;

  createObserver(
    context: Readonly<ObserverExecutionContext>,
    target: Readonly<ObserverTargetResolutionEvidence>,
    signal: AbortSignal,
  ): Promise<Readonly<ObserverContainerEvidence>>;

  reconcileObserverCreation(
    context: Readonly<ObserverExecutionContext>,
    target: Readonly<ObserverTargetResolutionEvidence>,
    dispatch: Readonly<ObserverCreateDispatchEvidence>,
    signal: AbortSignal,
  ): Promise<Readonly<ObserverCreationReconciliation>>;

  awaitReadiness(
    context: Readonly<ObserverExecutionContext>,
    target: Readonly<ObserverTargetResolutionEvidence>,
    observer: Readonly<ObserverContainerEvidence>,
    signal: AbortSignal,
  ): Promise<Readonly<ObserverReadinessEvidence>>;

  observe(
    context: Readonly<ObserverExecutionContext>,
    target: Readonly<ObserverTargetResolutionEvidence>,
    observer: Readonly<ObserverContainerEvidence>,
    readiness: Readonly<ObserverReadinessEvidence>,
    signal: AbortSignal,
  ): Promise<Readonly<ObserverTerminalEvidence>>;

  cleanup(
    context: Readonly<ObserverExecutionContext>,
    target: Readonly<ObserverTargetResolutionEvidence> | undefined,
    observer: Readonly<ObserverContainerEvidence> | undefined,
    signal: AbortSignal,
  ): Promise<Readonly<ObserverCleanupEvidence | ObserverAbsenceEvidence>>;
}
