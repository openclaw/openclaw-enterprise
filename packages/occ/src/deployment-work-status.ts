import { immutableCopy } from "@openclaw-enterprise/utils";

import {
  controllerWorkLeaseActive,
  type ControllerWork,
  type ControllerWorkAttempt,
  type DeploymentStatus,
  type DeploymentStatusError,
  type DeploymentStatusResult,
  type PluginDeploymentWarning,
} from "./controller-work.ts";
import { validateFailureData, validateSuccessResultData } from "./controller-work-result.ts";
import { repositoryExecutionRedeployMessage } from "./deployment-repository-access.ts";
import { SandboxRepositoryRecipientUnverifiedError } from "./errors.ts";

const FAILURE_CODE = /^[A-Z0-9_]{1,64}$/u;

/** Public pending explanations never include arbitrary Driver or provider text. */
export function deploymentProgressForWork(
  work: Readonly<Pick<ControllerWork, "state" | "availableAt">>,
  attempt: ControllerWorkAttempt | undefined,
): DeploymentStatusResult["progress"] {
  if (work.state === "succeeded" || work.state === "failed_permanent") {
    return null;
  }
  let code = "RECONCILIATION_PENDING";
  let message = "Deployment has not completed. Another reconciliation is pending.";
  switch (attempt?.code) {
    case "REVISION_INCOMPLETE":
      code = attempt.code;
      message = "Waiting for the runtime to become ready.";
      break;
    case "REVISION_UNSCHEDULABLE":
      code = attempt.code;
      message =
        "The cluster has no room for this Agent's Pods yet; they are waiting to be scheduled.";
      break;
    case "REVISION_IMAGE_PULL_FAILED":
      // Fixed copy: never the image reference or the registry's response.
      code = attempt.code;
      message =
        "Kubernetes cannot pull a container image for this Agent and keeps retrying. Ask an Installation administrator to check the runtime image reference and that the cluster's nodes can pull from its registry.";
      break;
    case "NAMESPACE_POD_QUOTA_EXCEEDED":
      // Fixed copy: never the quota's numbers or name (finding 1617).
      code = attempt.code;
      message =
        "The Namespace's Pod quota is full. Stop or delete an Agent, or ask an Installation administrator to raise the quota.";
      break;
    case "WORKSPACE_NODE_PENDING":
      code = attempt.code;
      message = "Workloads are ready; waiting for the workspace node to connect to the Gateway.";
      break;
    case "WORKSPACE_SETUP_RETRYING":
      code = attempt.code;
      message =
        "Workspace setup failed; Kubernetes is retrying it. If it keeps failing, ask an Installation administrator to check the Agent's workspace storage and runtime image.";
      break;
    case "WORKSPACE_NODE_BINDING_PENDING":
      code = attempt.code;
      message = "Workloads are ready; waiting for the Gateway to apply the workspace node.";
      break;
    case "REPOSITORY_GIT_MATERIAL_PENDING":
      // Fixed copy, like REPOSITORY_GIT_ROUTE_PENDING (finding 1045).
      code = attempt.code;
      message =
        "Workloads are ready; waiting for this version's repository Git credential: GitHub must issue its first token and, with a Sandbox, the Sandbox must install it. If this persists, check the worker log for repository credential (PREPARED_GITHUB_RECOVERY_REQUIRED) or OpenShell gateway errors.";
      break;
    case "WORKSPACE_NODE_RECONNECT_PENDING":
      code = attempt.code;
      message =
        "Workloads are ready; waiting for the workspace node to reconnect after the repository Git credential was installed.";
      break;
    case "HARNESS_CREDENTIAL_BOOTSTRAP_PENDING":
      code = attempt.code;
      message = "Waiting for harness credential initialization to finish.";
      break;
    case "REPOSITORY_GIT_ROUTE_PENDING":
      // Fixed copy: never the repository, grant or the gateway's answer (finding 1045).
      code = attempt.code;
      message =
        "Workloads are ready; waiting for the controller to verify this version's repository Git access. If this persists, check the worker log for repository credential or OpenShell gateway errors.";
      break;
    case "DEPENDENCY_UNAVAILABLE":
      code = attempt.code;
      message = "A dependency was unavailable. The controller will retry.";
      break;
    case "EXECUTION_ADMISSION_WITHDRAWAL_PENDING":
      code = attempt.code;
      message =
        "This version can no longer run with its admitted access. The controller will keep checking that access is closed and the workload has stopped.";
      break;
    case "REFUSED_CANDIDATE_STOP_PENDING":
      // The refusal is the code this deployment's `error` carries once the stop succeeds,
      // unless a newer revision supersedes it first.
      code = attempt.code;
      // A refusal that lifted after the convergence deadline waits to publish the deadline.
      message =
        attempt.refusal === "CONVERGENCE_DEADLINE_EXCEEDED"
          ? "Deployment missed its convergence deadline; stopping the candidate before recording the failure. The controller will retry."
          : `Deployment refused${
              attempt.refusal !== undefined && FAILURE_CODE.test(attempt.refusal)
                ? ` (${attempt.refusal})`
                : ""
            }; stopping the refused version before recording the failure. The controller will retry.`;
      break;
    case "PREDECESSOR_STOP_YIELDED":
      // Exclusive replacement: the serving version's gateway drains before this one starts.
      code = attempt.code;
      message =
        "Waiting for the previous version's gateway to finish its active work before this version starts.";
      break;
    case "SUPERSEDED_STOP_YIELDED":
      // A newer version superseded this one before it became current: its own stop waits for
      // its gateway's drain before the deployment ends superseded (finding 3080).
      code = attempt.code;
      message =
        "A newer version replaced this one; its gateway is finishing active work before this version stops.";
      break;
    case "AGENT_STOP_YIELDED":
      // The Agent stopped during this deployment: its stop waits for a gateway drain, and the
      // deployment then ends stopped (finding 1106).
      code = attempt.code;
      message =
        "The Agent was stopped; its gateway is finishing active work before the stop completes.";
      break;
    case "AGENT_GATEWAY_UNAVAILABLE":
      code = attempt.code;
      message =
        "The Agent Gateway was not reachable through its route yet. The controller will retry until the deployment deadline.";
      break;
    case "KUBERNETES_API_UNAVAILABLE":
      code = attempt.code;
      message =
        "The Kubernetes API was unavailable. The controller will retry until the deployment deadline.";
      break;
    case "SANDBOX_ADMISSION_LIMIT_REACHED":
      code = attempt.code;
      message =
        "The Sandbox gateway refuses new requests from the controller until its request admissions free up. The controller will retry until the deployment deadline.";
      break;
    case "SANDBOX_GATEWAY_UNAVAILABLE":
      code = attempt.code;
      message =
        "The Sandbox gateway did not answer the controller yet. The controller will retry until the deployment deadline.";
      break;
    case "ACTIVE_REVISION_CHANGED":
      code = attempt.code;
      message = "The selected version changed. The controller will reconcile again.";
      break;
    case "LEASE_EXPIRED":
      code = attempt.code;
      // A claim lost while stopping a refused candidate keeps that refusal (finding 1021).
      message =
        attempt.refusal !== undefined && FAILURE_CODE.test(attempt.refusal)
          ? `Deployment refused (${attempt.refusal}); the previous worker claim expired before the refused version was stopped. The controller will retry.`
          : "The previous worker claim expired. Reconciliation will resume.";
      break;
    case "ACTIVE_REVISION_RECOVERY":
      code = attempt.code;
      message =
        "The previous worker claim expired after this version was published. The controller will finish activating it.";
      break;
    case "PREDECESSOR_STOP_RECOVERY":
      // Its predecessor stop had started; failing without a pass would leave it half stopped
      // (finding 1107).
      code = attempt.code;
      message =
        "The last attempt ended while the previous version was stopping. The controller will try once more.";
      break;
  }
  return Object.freeze({
    lastAttempt:
      attempt === undefined
        ? null
        : Object.freeze({
            at: attempt.at.toISOString(),
            code,
            message,
          }),
    nextAttemptAt: work.state === "queued" ? work.availableAt.toISOString() : null,
  });
}

export function deploymentErrorForWork(
  work: Readonly<Pick<ControllerWork, "state" | "reasonCode" | "resultData" | "agentId">>,
): DeploymentStatusError | null {
  if (work.state !== "failed_permanent" && !completedWithoutActivation(work)) {
    return null;
  }
  const code = work.reasonCode ?? "UNKNOWN_FAILURE";
  const data =
    work.resultData === undefined
      ? undefined
      : validateFailureData(code, immutableCopy(work.resultData));
  return Object.freeze({
    code,
    message: deploymentErrorMessage(code, work.agentId ?? "AGENT_ID"),
    ...(data === undefined ? {} : { data }),
  });
}

/**
 * The fixed codes that name the guidance for a refusal whose next step does not depend on the
 * operation. A stop, deletion or credential withdrawal the Sandbox gateway refused has no status
 * of its own, so the worker logs the code with the failed work (finding 1694); the deployment
 * status shows the same guidance as text, and the Sandbox Driver reference spells it out. The
 * log carries the code, not the sentence, because the log sanitizer keeps no free text.
 */
export const OPERATION_REFUSAL_HINT_CODES = Object.freeze({
  SANDBOX_GATEWAY_UNAUTHORIZED: "sandbox-gateway-identity",
} as const);

export type OperationRefusalHintCode =
  (typeof OPERATION_REFUSAL_HINT_CODES)[keyof typeof OPERATION_REFUSAL_HINT_CODES];

/** The guidance code a refusal with this result code logs, if any. */
export function operationRefusalHintCode(code: string): OperationRefusalHintCode | undefined {
  return Object.hasOwn(OPERATION_REFUSAL_HINT_CODES, code)
    ? OPERATION_REFUSAL_HINT_CODES[code as keyof typeof OPERATION_REFUSAL_HINT_CODES]
    : undefined;
}

export function deploymentWarningsForWork(
  work: Readonly<ControllerWork>,
): readonly PluginDeploymentWarning[] {
  if (work.state !== "succeeded" || work.resultData === undefined) {
    return Object.freeze([]);
  }
  return validateSuccessResultData(immutableCopy(work.resultData))?.warnings ?? Object.freeze([]);
}

export function controllerWorkDeploymentStatus(
  work: Readonly<ControllerWork>,
  now: Date = new Date(),
): DeploymentStatus {
  if (work.state === "succeeded") {
    return completedWithoutActivation(work) ? "failed" : "succeeded";
  }
  if (work.state === "failed_permanent") {
    return "failed";
  }
  if (controllerWorkLeaseActive(work, now)) {
    return "running";
  }
  return "queued";
}

/**
 * The status a deployment's record reports for its work, and for its revision cleanup. Once a
 * worker has claimed the work, it stays `running` until it records a result: a deferral between
 * attempts, a retry or an expired claim queues the work again, but reporting `queued` then read
 * as the deploy or cleanup stepping back (findings 2456, 2466). `attempt` is the latest evidence
 * bound to this work; a deferral that refunds its attempt still records evidence, so claimed
 * work always has one or the other. Callers can skip reading it when `attemptCount` is non-zero.
 */
export function deploymentStatusForWork(
  work: Readonly<ControllerWork>,
  attempt: ControllerWorkAttempt | undefined,
  now: Date = new Date(),
): DeploymentStatus {
  const status = controllerWorkDeploymentStatus(work, now);
  if (
    status === "queued" &&
    (work.state === "claimed" || work.attemptCount > 0 || attempt !== undefined)
  ) {
    return "running";
  }
  return status;
}

function completedWithoutActivation(
  work: Readonly<Pick<ControllerWork, "state" | "reasonCode">>,
): boolean {
  return (
    work.state === "succeeded" &&
    work.reasonCode !== "REVISION_ACTIVATED" &&
    work.reasonCode !== "REVISION_ALREADY_ACTIVE"
  );
}

// Each message names the cause and the next step. Every client (console, occ, HTTP API) shows
// this text as is, so the guidance lives here only; the console adds just a link to the page
// that holds the setting (finding 1393). `deployment-failure-steps.ts` records which kind of
// step each code leads to, so clients choose their actions without parsing this text: keep the
// two in step.
function deploymentErrorMessage(code: string, agentId: string): string {
  switch (code) {
    case "CONVERGENCE_DEADLINE_EXCEEDED":
      return "Deployment convergence deadline exceeded: the version did not become ready in time. Check its logs and runtime diagnostics, correct the cause if there is one, then deploy a new version.";
    case "HARNESS_CREDENTIAL_BOOTSTRAP_FAILED":
      return "Harness credential initialization failed. Correct the cause and deploy again.";
    case "HARNESS_CREDENTIAL_BOOTSTRAP_TIMEOUT":
      return "Harness credential initialization exceeded its deadline. Correct the cause and deploy again.";
    case "RUNTIME_AUTHENTICATION_FAILED":
      return "The model provider rejected this version's credential (HTTP 401 or 403). Check that the key or token is valid and can use the selected model, update or replace the Agent's model credential, then deploy a new version.";
    case "RUNTIME_CPU_STARVED":
      return "Deployment runtime did not get enough CPU to finish its startup model check, because of a CPU limit below one core or a busy node. Ask an Installation administrator to raise the limit, or an operator to free node capacity, then deploy a new version.";
    // Model-probe codes come from the runtime wrapper's startup model check
    // (`runtime-entrypoints.ts`). OpenClaw classifies transport errors (refused connection,
    // DNS failure, "fetch failed") as a timeout; Codex reports them as
    // RUNTIME_MODEL_PROBE_FAILED unless the connection hangs until its cap.
    case "RUNTIME_MODEL_PROBE_TIMEOUT":
      return "The startup model check got no reply from the provider in time. With OpenClaw this includes an unreachable provider (refused connection or unknown host). Check egress, proxy or a custom baseUrl and that the provider responds, then deploy a new version.";
    case "RUNTIME_MODEL_PROBE_FAILED":
      return "The startup model check failed, but not for a rejected credential: for example an unknown model, bad provider settings, a TLS error, a rate limit, or, with Codex, an unreachable provider. Check these and the provider account, then deploy a new version.";
    case "RUNTIME_LOGIN_FAILED":
      return "Deployment runtime could not sign in to the model provider. Check the Agent's model credential (for an OAuth login, sign in again) and that the runtime can reach the provider, then deploy a new version.";
    case "RUNTIME_CODEX_REQUIREMENTS_TOO_LARGE":
      return "The Codex runtime’s managed requirements reply exceeds OCE’s 1 MiB limit. Ask the policy owner to reduce the requirements document, then deploy a new version.";
    case "RUNTIME_CODEX_PERMISSION_POLICY_INCOMPATIBLE":
      return "This Codex runtime’s managed permission policy does not allow the sandbox mode, named profile or human reviewer required by OpenShell. Ask the policy owner to verify compatibility, then deploy a new version.";
    case "RUNTIME_STARTUP_FAILED":
      return "Deployment runtime failed a startup check. Check this version's logs for the failed check and correct its cause, then deploy a new version.";
    // The runtime holds unready on check `gateway-state-lock`; its log names the holder. The
    // record does not say which workload holds, so the text names both log sources.
    case "RUNTIME_STATE_LOCK_UNVERIFIED":
      return `Startup check gateway-state-lock failed: the runtime cannot verify that its state lock holder stopped. See it with 'occ agent logs ${agentId} --source gateway' (Harness: --source agent), then follow the troubleshooting guide.`;
    case "EXECUTION_ADMISSION_WITHDRAWN":
      return "This version can no longer run with its admitted access. The controller closed that access and observed the workload stopped. Deploy a new version to use the current installation.";
    case "REVISION_SUPERSEDED":
      return "Deployment was superseded by a newer revision.";
    case "REVISION_STOPPED":
      return "Deployment ended because the Agent was stopped.";
    case "REPOSITORY_REVISION_SUPERSEDED":
      return "Deployment was superseded by a newer revision.";
    case "REPOSITORY_REVISION_STOPPED":
      return "Deployment ended because the Agent was stopped or its Namespace is no longer ready. To run the Agent, deploy again once its Namespace is ready.";
    // Repository credential refusals (finding 1045). Like the refusals below, the status never
    // names a repository, grant or Driver.
    case "REPOSITORY_RUNTIME_UNSUPPORTED":
      return "This revision lost repository credentials: they need an embedded OpenClaw or dedicated Codex runtime, no Sandbox Driver, and a Compute Driver set up for them. Ask an Installation administrator to restore that or remove repository access, then deploy again.";
    case "REPOSITORY_BINDING_UNAVAILABLE":
      return "A repository this revision binds, or its access level, is no longer approved for the Agent's Namespace. Choose approved repository access on the Agent, or ask an Installation administrator to approve it again, then deploy again.";
    case "REPOSITORY_BINDING_CHANGED":
      return "The approval behind a repository this revision binds changed since admission, for example the access levels or push rules approved for the Agent's Namespace. Deploy again to admit a revision with the current approval.";
    case "REPOSITORY_DRIVER_MISMATCH":
      return "The Installation no longer selects the repository credential Driver admitted with this revision. Deploy again, choosing approved repository access if refused. If it selects none, remove repository access or ask an Installation administrator to select one.";
    case "REPOSITORY_GIT_ROUTE_BLOCKED":
      return "The controller closed this version's repository Git access: its Sandbox or supervisor was replaced, a credential write's outcome is unknown, or the access was withdrawn (worker log: OPENSHELL_GIT_RECONCILIATION_REQUIRED). Deploy a new version.";
    case "REPOSITORY_GIT_TOKEN_QUARANTINED":
      return "GitHub issued no repository Git token for this version: it rejected the App key or registry, or was unreachable. An Agent that ran before keeps this version running without Git. Ask an Installation administrator to fix it, then deploy a new version.";
    case "REPOSITORY_GIT_TOKEN_PENDING":
      return "GitHub issued no repository Git token for this version in time. The Agent keeps this version running without Git, which it gets if the token arrives. Ask an Installation administrator to check the GitHub App key, then deploy a new version.";
    case "REPOSITORY_GIT_SENDER_UNQUALIFIED":
      return "This version's repository Git delivery needs the git-write profile, and no OpenShell release is qualified for it, so it cannot start. Remove the binding, select a qualified installed sender, or use native prepared Git without a Sandbox, then deploy again.";
    case "REPOSITORY_GIT_PROFILE_UNSUPPORTED":
      return "This version's Git delivery has no supported profile, so it cannot start. A Credential Proxy delivers github-repository bindings, or one git-write or github-installation binding. Change the bindings or use native prepared Git, then deploy again.";
    case "REPOSITORY_CREDENTIAL_DEADLINE_EXCEEDED":
      return "This revision's repository access deadline, fixed when the revision was admitted, has passed. Deploy again to admit a revision with a new deadline.";
    // Refusals the worker decides again on every pass (finding 1039). The status never names
    // the principal or the resource the decision was about.
    case "AUTHORIZATION_DENIED":
      return "The deploying account, or the Agent's own identity, lost a permission the revision needs: Agent deploy, Configuration read, or use of a bound Secret, credential source or ServiceAccount. Ask an Installation administrator to grant it, then deploy again.";
    case "ACTOR_REVOKED":
      return "The account that requested this deployment is no longer an active account in the Installation. Deploy again from an account with deploy access to the Agent.";
    case "HARNESS_AUTH_REQUIRED":
      return "This revision has no Harness authentication method. Set one on the Agent, then deploy again.";
    case "BACKEND_UNAVAILABLE":
      return "The Backend this revision was admitted with is no longer configured on the Installation. Ask an Installation administrator to restore it, or move the Agent to a configured Backend, then deploy again.";
    case "HARNESS_AUTH_SOURCE_CHANGED":
      return "The ServiceAccount this revision authenticates with is missing, has no access token, or its credential changed since admission. Bind an available ServiceAccount, or deploy again to admit a revision with its current credential.";
    case "SECRET_BINDING_UNAVAILABLE":
      return "A Secret this revision binds is missing or no longer belongs to the selected Secret Driver. Bind available Secrets, then deploy again.";
    case "NAMESPACE_NOT_READY":
      return "The Agent's Namespace was not ready when the controller ran this deployment, for example while it is being deleted. Deploy again once the Namespace is ready.";
    case "WORKSPACE_SETUP_REFUSED":
      return "Initial workspace setup refused this version, and retries would too: its files, setup record or runtime defaults differ from the Agent's originals. Ask an Installation administrator to check workspace storage and the runtime image; keep the setup record.";
    case "WORKSPACE_SETUP_UNSUPPORTED":
      return "The Agent was created with initial workspace files, which the Installation's Compute Driver cannot set up. Ask an Installation administrator to select a Compute Driver that supports them, then deploy again, or create the Agent without them.";
    case "DEPENDENCY_UNAVAILABLE":
      return "A dependency the controller needs stayed unavailable through every attempt. Deploy again; if it keeps failing, ask an Installation administrator to check the controller worker log.";
    case "LEASE_EXPIRED":
      return "The controller worker stopped or lost its claim during this deployment's last attempt. Deploy again.";
    case "AGENT_GATEWAY_UNAVAILABLE":
      return "The Agent Gateway was still not reachable through its route at the deployment deadline. Deploy again; if it keeps failing, ask an operator to check the gateway route and the Agent's Pods.";
    case "AGENT_GATEWAY_UNAUTHORIZED":
      return "The Agent Gateway refused its own CLI as unauthorized. Check that the Agent's Configuration sets gateway.auth.password to OPENCLAW_GATEWAY_PASSWORD (Enable gateway password access), then deploy again.";
    case "KUBERNETES_API_UNAVAILABLE":
      return "The Kubernetes API was still unavailable at the deployment deadline. Deploy again; if it keeps failing, ask an operator to check the cluster's API server.";
    case "KUBERNETES_SECRET_WRITE_FORBIDDEN":
      return "Kubernetes refused access to a Secret this version needs (HTTP 403 Forbidden), so the controller did not retry. Ask a platform operator to check the worker's tenant RoleBindings for secrets and any admission policy or ResourceQuota, then deploy again.";
    case "SANDBOX_REPOSITORY_RECIPIENT_UNVERIFIED":
      return SandboxRepositoryRecipientUnverifiedError.description;
    case "SANDBOX_SECRET_ENVIRONMENT_UNSUPPORTED":
      return "The Sandbox Driver cannot deliver Secret-backed environment variables to the Harness. Use credential sources instead of Secret bindings, or ask an Installation administrator for a Sandbox Driver that supports them, then deploy again.";
    case "SANDBOX_HARNESS_UNSUPPORTED":
      return "The Sandbox Driver does not support this revision's Harness settings, such as plugins, network policy additions or ServiceAccount credentials. Change them, or ask an Installation administrator for a Driver that supports them, then deploy again.";
    case "SANDBOX_GATEWAY_UNAUTHORIZED":
      return "The Sandbox gateway refused the controller's identity, or the Workspace is gone, so cleanup is unconfirmed. Check the identity's token file and Workspace role and the gateway's signing-key refresh, then deploy, stop, delete or withdraw again.";
    case "SANDBOX_WORKLOAD_IMMUTABLE":
      return "The requested workload differs from the retained Sandbox’s immutable settings. Ask an administrator to restore its original resource requests, limits and other workload settings, then deploy again.";
    case "SANDBOX_RECREATION_REQUIRED":
      return "The retained Sandbox uses an unsupported workload configuration. Preserve its files, create a replacement Agent and restore the files before deleting the original Agent.";
    case "SANDBOX_POD_LABELS_NOT_PERMITTED":
      return "The Sandbox gateway refuses this revision's Harness Pod labels. Ask an admin to allow them in the gateway configuration, then deploy again.";
    case "CREDENTIAL_SOURCE_ENVIRONMENT_CONFLICT":
      return "Two credential sources the Agent binds use the same environment variable. Bind only one source per variable, for example one openai source and bearer-token sources with distinct env_var values, then deploy again.";
    case "CREDENTIAL_WITHDRAWN":
      return "The Harness credential source was withdrawn from this revision, so the revision cannot start. Bind a replacement source or another authentication method, then deploy again.";
    case "CREDENTIAL_GATEWAY_MISMATCH":
      return "The Installation no longer selects the Credential Gateway this revision was admitted with. Bind sources registered through the selected gateway, or remove them and change harnessAuth, then deploy again.";
    case "HARNESS_AUTH_SOURCE_UNAVAILABLE":
      return "The Harness authentication source this revision was admitted with is missing, being deleted, or changed since admission. Bind an available source, then deploy again.";
    case "EGRESS_PROVIDER_UNAVAILABLE":
      return "The protected egress provider this revision's Harness source was admitted with is no longer selected or available. Ask an Installation administrator to reselect it, or bind a source admitted under the selected provider, then deploy again.";
    case "CREDENTIAL_SOURCE_UNAVAILABLE":
      return "A credential source this revision lists is missing, being deleted, or changed since admission. Bind available sources, then deploy again.";
    case "PLUGIN_DRIVER_MISMATCH":
      return "This revision's Plugin Driver is unavailable for its Harness. Enable the matching Driver or update the Agent's selections, then deploy again.";
    case "SECRET_DRIVER_MISMATCH":
      return "The Installation no longer selects the Secret Driver this revision was admitted with. Bind Secrets created through the selected Secret Driver, or remove the old Secret bindings, then deploy again.";
    case "COMPUTE_DRIVER_MISMATCH":
      return "The Installation no longer selects the Compute Driver this revision was admitted with. Deploy again to admit a revision for the selected driver.";
    case "HARNESS_DESCRIPTOR_MISMATCH":
      return "This revision's Harness or Harness version is no longer approved, for example after a controller upgrade. Deploy again to admit a revision with the approved version.";
    case "SERVICE_ACCOUNT_BACKEND_MISMATCH":
      return "The ServiceAccount's Backend binding no longer matches the Agent's Backend, or its credential is no longer issued. Bind a ServiceAccount created and issued under the Agent's current Backend, then deploy again.";
    case "SANDBOX_ADMISSION_LIMIT_REACHED":
      return "The Sandbox gateway still refused new controller requests (request admission limit reached) at the deployment deadline. Deploy again once other Sandbox work has finished; if it keeps failing, ask an operator to check the gateway's request limit.";
    case "SANDBOX_GATEWAY_UNAVAILABLE":
      return "The Sandbox gateway still did not answer the controller at the deployment deadline. Deploy again; if it keeps failing, ask an operator to check the Sandbox gateway.";
    // These codes used to fall through to the fallback below, which named no step (finding 2537).
    case "INVALID_HARNESS_AUTH":
      return "This version's Harness authentication cannot be used: its Secret or ServiceAccount is outside the Agent's Namespace, or its method is not supported. Choose the Harness authentication again in the Agent's Credentials, then deploy a new version.";
    case "INVALID_AGENT_PRINCIPAL":
      return "The Agent's own identity, which this version runs as, is missing from the Installation, so the controller did not start the version. Ask an Installation administrator to check the Agent and the controller worker log.";
    case "INVALID_SECRET_BINDINGS":
      return "The Secret bindings stored with this version are not valid, so the controller did not start it. Deploy again to admit a version with the Agent's current Secret bindings; if the deploy is refused, bind the Agent's Secrets again first.";
    case "EXECUTION_ADMISSION_UNAVAILABLE":
      return "This version was admitted for protected execution that the Installation can no longer provide, for example after its Credential Proxy changed. Deploy again; if the deploy is refused, ask an Installation administrator to check the Credential Proxy.";
    case "INVALID_TARGET":
    case "INVALID_REVISION_OWNER":
    case "INVALID_ADMITTED_REVISION":
    case "INVALID_ACTIVE_REVISION":
      return "The stored records for this version are inconsistent with its Agent or Namespace, so the controller did not start it and it has no runtime logs. Ask an Installation administrator to check the controller worker log for this deployment.";
    case "INVALID_DRIVER_OBSERVATION":
      return "The Compute Driver reported this version's state in a form the controller rejects, so it stopped the deployment. Check this version's logs, then deploy a new version; if it fails again, ask an operator whether the Compute Driver matches this controller.";
    case "INVALID_REPOSITORY_DRIVER_OBSERVATION":
      return "The repository credential Driver reported a session in a form the controller rejects, so it stopped the deployment. Check this version's logs, then deploy a new version; if it fails again, ask an operator to check the repository credential Driver.";
    case "INVALID_REPOSITORY_ATTEMPT_OWNER":
      return "A repository session stored for this version does not match the repository access it binds, so the controller stopped the deployment. Its runtime logs cannot show why: ask an Installation administrator to check the controller worker log.";
    case "REPOSITORY_POLICY_HISTORY_INCOMPATIBLE":
      return "This Agent has deployment history without a repository network policy. Save the policy for a new Agent before its first deployment.";
    case "REPOSITORY_POLICY_PLACEMENT_UNSUPPORTED":
      return "The selected execution placement cannot enforce this version's repository network policy. Ask an Installation administrator for a placement that supports the policy, then deploy again.";
    case "REPOSITORY_PROXY_ADMISSION_MISMATCH":
      return "This version's repository access no longer matches the Credential Proxy delivery it was admitted with. Deploy again to admit a version with the current repository access.";
    case "REPOSITORY_PREPARED_ADMISSION_UNAVAILABLE":
      return "The Installation's repository credential Driver cannot keep the session records this version's repository access needs. Ask an Installation administrator for a Driver that supports them, or remove the Agent's repository access, then deploy again.";
    case "REPOSITORY_EXECUTION_CLOSED":
      return "This version's standing repository access was closed, and the controller does not reopen it for the same version. Deploy again to restore repository access.";
    case "REPOSITORY_EXECUTION_REDEPLOY_REQUIRED":
      return repositoryExecutionRedeployMessage;
    case "REPOSITORY_EXECUTION_CHANGED":
    case "REPOSITORY_EXECUTION_REPLACED":
      return "This version's runtime was replaced after the controller checked it for repository access, so the controller closed that access. Deploy again to restore repository access.";
    case "REPOSITORY_EXECUTION_UNVERIFIED":
      return "The controller could not confirm that the runtime holding this version's standing repository access is the one it recorded, so it did not grant that access. Deploy again to restore repository access.";
    case "REPOSITORY_SESSION_RECOVERY_UNSAFE":
      return "A repository session this version opened ended in an unknown state and may still hold a credential, so the controller opens no other for it. Deploy again; if repository access still fails, ask an Installation administrator to check for open sessions.";
    case "REPOSITORY_SESSION_NO_LONGER_CURRENT":
      return "This version's repository session ended or expired before the controller confirmed it. Deploy again to open a new session.";
    case "REPOSITORY_STANDING_APPROVAL_REMOVED":
      return "The standing repository approval this version was admitted with was removed or replaced. Approve the repository access again, or remove the Agent's repository access, then deploy again.";
    case "REPOSITORY_STANDING_POLICY_CHANGED":
      return "The Namespace's repository policy changed since this version's standing repository approval, so the approval no longer covers it. Approve the repository access again under the current policy, or remove the Agent's repository access, then deploy again.";
    case "UNKNOWN_FAILURE":
      return "The deployment failed without a recorded reason. Check this version's logs; if they show nothing, ask an Installation administrator to check the controller worker log, then deploy a new version.";
    default:
      return "Deployment failed. Check this version's logs; if they show nothing, ask an Installation administrator to check the controller worker log for this code.";
  }
}
