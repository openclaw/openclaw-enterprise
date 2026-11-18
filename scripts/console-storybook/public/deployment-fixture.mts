import type {
  AgentDeploymentStatusWire,
  ComputePreparationFailureEvidence,
  RuntimeFailureCause,
} from "@openclaw-enterprise/contracts";

// Use the domain type for preparation: the wire schema builds several literal unions from arrays.
type DeploymentError =
  | NonNullable<AgentDeploymentStatusWire["error"]>
  | {
      code: "HARNESS_CREDENTIAL_BOOTSTRAP_FAILED";
      message: string;
      data: { preparation: ComputePreparationFailureEvidence };
    };

type DeploymentFailureOptions = {
  bootstrapFailure?: boolean;
  candidateSuperseded?: boolean;
  candidateStopped?: boolean;
  candidateCredentialRejected?: boolean;
  candidateModelProbeCause?: RuntimeFailureCause;
  candidateFailure?: DeploymentError;
  candidateDependencyUnavailable?: boolean;
  candidateSelected?: boolean;
};

// These messages are also used when creating the first deployment.
export const deploymentFailureMessages = {
  bootstrap: "Harness credential initialization failed. Correct the cause and deploy again.",
  stopped: "Deployment ended because the Agent was stopped.",
  dependencyUnavailable:
    "A dependency the controller needs stayed unavailable through every attempt. Deploy again; if it keeps failing, ask an Installation administrator to check the controller worker log.",
} as const;

export function initialDeploymentProgress(
  status: AgentDeploymentStatusWire["status"],
  createdAt: string,
): AgentDeploymentStatusWire["progress"] {
  if (status !== "queued" && status !== "running") {
    return null;
  }
  return { lastAttempt: null, nextAttemptAt: status === "queued" ? createdAt : null };
}

export function candidateDeploymentError(
  scenario: DeploymentFailureOptions,
  checkedAt: string,
): DeploymentError {
  if (scenario.bootstrapFailure) {
    return {
      code: "HARNESS_CREDENTIAL_BOOTSTRAP_FAILED",
      message: deploymentFailureMessages.bootstrap,
      data: {
        preparation: {
          workload: {
            kind: "Job",
            name: "oauth-bootstrap-demo",
            uid: "job-demo-uid",
            namespace: "oce-tenant-demo",
          },
          reason: "retry_limit",
          observedAt: checkedAt,
          startedAt: checkedAt,
          finishedAt: checkedAt,
          pods: [
            {
              name: "oauth-bootstrap-demo-pod",
              uid: "bootstrap-demo-uid",
              phase: "Failed",
              scheduling: "scheduled",
              containers: [
                {
                  name: "prepare-oauth-home",
                  kind: "init",
                  state: "terminated",
                  reason: "Completed",
                  exitCode: 0,
                  startedAt: checkedAt,
                  finishedAt: checkedAt,
                },
                {
                  name: "oauth-bootstrap",
                  kind: "main",
                  state: "terminated",
                  reason: "Error",
                  exitCode: 1,
                  startedAt: checkedAt,
                  finishedAt: checkedAt,
                },
              ],
            },
          ],
        },
      },
    };
  }
  if (scenario.candidateSuperseded) {
    return {
      code: "REVISION_SUPERSEDED",
      message: "Deployment was superseded by a newer revision.",
    };
  }
  if (scenario.candidateStopped) {
    return {
      code: "REVISION_STOPPED",
      message: deploymentFailureMessages.stopped,
    };
  }
  // Deployment error messages copy deploymentErrorMessage in
  // packages/occ/src/state/controller-work.ts; keep them in step.
  if (scenario.candidateCredentialRejected) {
    return {
      code: "RUNTIME_AUTHENTICATION_FAILED",
      message:
        "The model provider rejected this version's credential (HTTP 401 or 403). Check that the key or token is valid and can use the selected model, update or replace the Agent's model credential, then deploy a new version.",
    };
  }
  if (scenario.candidateModelProbeCause) {
    return {
      code: "RUNTIME_MODEL_PROBE_FAILED",
      message:
        "The startup model check failed, but not for a rejected credential: for example an unknown model, bad provider settings, a TLS error, a rate limit, or, with Codex, an unreachable provider. Check these and the provider account, then deploy a new version.",
      data: {
        runtimeFailure: {
          component: "gateway",
          check: "model-probe",
          code: "MODEL_PROBE_FAILED",
          checkedAt,
          cause: scenario.candidateModelProbeCause,
        },
      },
    };
  }
  // A scenario can name any failure code with the message OCC returns for it.
  if (scenario.candidateFailure) {
    return scenario.candidateFailure;
  }
  if (scenario.candidateDependencyUnavailable) {
    return {
      code: "DEPENDENCY_UNAVAILABLE",
      message: deploymentFailureMessages.dependencyUnavailable,
    };
  }
  if (scenario.candidateSelected) {
    return {
      code: "REVISION_FINALIZATION_INCOMPLETE",
      message:
        "Deployment failed. Check this version's logs; if they show nothing, ask an Installation administrator to check the controller worker log for this code.",
    };
  }
  return {
    code: "CONVERGENCE_DEADLINE_EXCEEDED",
    message:
      "Deployment convergence deadline exceeded: the version did not become ready in time. Check its logs and runtime diagnostics, correct the cause if there is one, then deploy a new version.",
    data: {
      timeoutMs: 60000,
      runtimeFailure: { component: "harness", check: "readiness", code: "TIMEOUT", checkedAt },
    },
  };
}
