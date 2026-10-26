// The kind of next step each failed deployment's code leads to. The deployment status message
// (`state/controller-work.ts`) states the step in words; clients choose their actions from this
// table instead of parsing that text (finding 2537). The Console also serves this module
// (`console-assets.ts`): keep it free of imports and of TypeScript syntax that type stripping
// cannot erase.
//
// - "deploy-again": deploying the Agent again can clear the failure, so a client may offer it.
// - "logs": the version's runtime ran, and its logs can show the cause.
// - "change": a setting, grant or record must change first, and no runtime started, so its logs
//   cannot help.
export type DeploymentFailureStep = "deploy-again" | "logs" | "change";

export const DEPLOYMENT_FAILURE_STEPS: Readonly<Record<string, DeploymentFailureStep>> =
  Object.freeze({
    ACTOR_REVOKED: "deploy-again",
    AGENT_GATEWAY_UNAVAILABLE: "deploy-again",
    COMPUTE_DRIVER_MISMATCH: "deploy-again",
    DEPENDENCY_UNAVAILABLE: "deploy-again",
    EXECUTION_ADMISSION_UNAVAILABLE: "deploy-again",
    EXECUTION_ADMISSION_WITHDRAWN: "deploy-again",
    HARNESS_AUTH_SOURCE_CHANGED: "deploy-again",
    HARNESS_DESCRIPTOR_MISMATCH: "deploy-again",
    INVALID_SECRET_BINDINGS: "deploy-again",
    KUBERNETES_API_UNAVAILABLE: "deploy-again",
    LEASE_EXPIRED: "deploy-again",
    NAMESPACE_NOT_READY: "deploy-again",
    REPOSITORY_BINDING_CHANGED: "deploy-again",
    REPOSITORY_CREDENTIAL_DEADLINE_EXCEEDED: "deploy-again",
    REPOSITORY_DRIVER_MISMATCH: "deploy-again",
    REPOSITORY_EXECUTION_CHANGED: "deploy-again",
    REPOSITORY_EXECUTION_CLOSED: "deploy-again",
    REPOSITORY_EXECUTION_REPLACED: "deploy-again",
    REPOSITORY_EXECUTION_UNVERIFIED: "deploy-again",
    REPOSITORY_GIT_ROUTE_BLOCKED: "deploy-again",
    REPOSITORY_PROXY_ADMISSION_MISMATCH: "deploy-again",
    REPOSITORY_REVISION_STOPPED: "deploy-again",
    REPOSITORY_SESSION_NO_LONGER_CURRENT: "deploy-again",
    REPOSITORY_SESSION_RECOVERY_UNSAFE: "deploy-again",
    SANDBOX_ADMISSION_LIMIT_REACHED: "deploy-again",
    SANDBOX_GATEWAY_UNAVAILABLE: "deploy-again",

    AGENT_GATEWAY_UNAUTHORIZED: "logs",
    CONVERGENCE_DEADLINE_EXCEEDED: "logs",
    HARNESS_CREDENTIAL_BOOTSTRAP_FAILED: "logs",
    HARNESS_CREDENTIAL_BOOTSTRAP_TIMEOUT: "logs",
    INVALID_DRIVER_OBSERVATION: "logs",
    INVALID_REPOSITORY_DRIVER_OBSERVATION: "logs",
    RUNTIME_AUTHENTICATION_FAILED: "logs",
    RUNTIME_CPU_STARVED: "logs",
    RUNTIME_LOGIN_FAILED: "logs",
    RUNTIME_MODEL_PROBE_FAILED: "logs",
    RUNTIME_MODEL_PROBE_TIMEOUT: "logs",
    RUNTIME_STARTUP_FAILED: "logs",
    UNKNOWN_FAILURE: "logs",

    AUTHORIZATION_DENIED: "change",
    BACKEND_UNAVAILABLE: "change",
    CREDENTIAL_GATEWAY_MISMATCH: "change",
    CREDENTIAL_SOURCE_ENVIRONMENT_CONFLICT: "change",
    CREDENTIAL_SOURCE_UNAVAILABLE: "change",
    CREDENTIAL_WITHDRAWN: "change",
    EGRESS_PROVIDER_UNAVAILABLE: "change",
    HARNESS_AUTH_REQUIRED: "change",
    HARNESS_AUTH_SOURCE_UNAVAILABLE: "change",
    INVALID_ACTIVE_REVISION: "change",
    INVALID_ADMITTED_REVISION: "change",
    INVALID_AGENT_PRINCIPAL: "change",
    INVALID_HARNESS_AUTH: "change",
    INVALID_REPOSITORY_ATTEMPT_OWNER: "change",
    INVALID_REVISION_OWNER: "change",
    INVALID_TARGET: "change",
    KUBERNETES_SECRET_WRITE_FORBIDDEN: "change",
    REPOSITORY_BINDING_UNAVAILABLE: "change",
    REPOSITORY_GIT_PROFILE_UNSUPPORTED: "change",
    REPOSITORY_GIT_SENDER_UNQUALIFIED: "change",
    REPOSITORY_PREPARED_ADMISSION_UNAVAILABLE: "change",
    REPOSITORY_RUNTIME_UNSUPPORTED: "change",
    REPOSITORY_STANDING_APPROVAL_REMOVED: "change",
    REPOSITORY_STANDING_POLICY_CHANGED: "change",
    SANDBOX_GATEWAY_UNAUTHORIZED: "change",
    SANDBOX_HARNESS_UNSUPPORTED: "change",
    SANDBOX_REPOSITORY_RECIPIENT_UNVERIFIED: "change",
    SANDBOX_SECRET_ENVIRONMENT_UNSUPPORTED: "change",
    SECRET_BINDING_UNAVAILABLE: "change",
    SECRET_DRIVER_MISMATCH: "change",
    SERVICE_ACCOUNT_BACKEND_MISMATCH: "change",
    WORKSPACE_SETUP_REFUSED: "change",
    WORKSPACE_SETUP_UNSUPPORTED: "change",
  });

/**
 * The next step for a failed deployment's code. A code this table does not list gets the
 * fallback message, which sends the reader to the version's logs.
 */
export function deploymentFailureStep(code: string | null | undefined): DeploymentFailureStep {
  return typeof code === "string" && Object.hasOwn(DEPLOYMENT_FAILURE_STEPS, code)
    ? DEPLOYMENT_FAILURE_STEPS[code]!
    : "logs";
}
