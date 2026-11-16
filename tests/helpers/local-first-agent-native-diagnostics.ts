import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";

import type {
  RuntimeLogContainerSourceId,
  RuntimeLogSourceId,
} from "../../packages/contracts/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";

const workStatuses = new Set(["queued", "running", "succeeded", "failed"] as const);
const provisioningPhases = new Set(["admitted", "configuration", "transport", "handoff"] as const);
// A narrow subset of deploymentProgressForWork's public codes; never print arbitrary peer text.
const deploymentProgressCodes = new Set([
  "REVISION_INCOMPLETE",
  "REVISION_UNSCHEDULABLE",
  "REVISION_IMAGE_PULL_FAILED",
  "WORKSPACE_NODE_PENDING",
  "WORKSPACE_NODE_BINDING_PENDING",
  "REPOSITORY_GIT_MATERIAL_PENDING",
  "WORKSPACE_NODE_RECONNECT_PENDING",
  "WORKSPACE_SETUP_RETRYING",
  "HARNESS_CREDENTIAL_BOOTSTRAP_PENDING",
  "LEASE_EXPIRED",
] as const);

// The API can return other error codes or peer-supplied text. Report only these public categories.
const runtimeFailureCodes = new Set([
  "RUNTIME_AUTHENTICATION_FAILED",
  "RUNTIME_CPU_STARVED",
  "RUNTIME_MODEL_PROBE_TIMEOUT",
  "RUNTIME_MODEL_PROBE_FAILED",
  "RUNTIME_LOGIN_FAILED",
  "RUNTIME_STARTUP_FAILED",
  "WORKSPACE_SETUP_REFUSED",
  "CONVERGENCE_DEADLINE_EXCEEDED",
  "PROVISIONING_DEPLOYMENT_FAILED",
] as const);
// The fixed values the runtime wrapper logs on `openclaw.model_probe` (runtime-entrypoints.ts):
// its result code and a provider error code from its closed list or classified upfront 401.
const modelProbeCodes = new Set([
  "READY",
  "AUTHENTICATION_FAILED",
  "MODEL_PROBE_FAILED",
  "MODEL_PROBE_TIMEOUT",
  "MODEL_PROBE_CPU_STARVED",
  "UNAVAILABLE",
] as const);
const providerCodes = new Set([
  "usage_limit_reached",
  "rate_limit_exceeded",
  "rate_limit_error",
  "insufficient_quota",
  "invalid_api_key",
  "model_not_found",
  "server_error",
  "overloaded_error",
  "missing_api_key",
  "insufficient_permissions",
] as const);
// Which response header names the upfront 401 carried (names only, no origin claim).
// "none" is a real value here, so an absent field prints "absent" instead.
const responseHeaderMarkers = new Set([
  "none",
  "provider-like",
  "openshell-policy",
  "mixed",
] as const);
// The upfront 401 body's form and its error.code and error.type, each from a closed
// set ("other" off-set); the message never reaches the log. They mirror the sets in
// runtime-entrypoints.ts; runtime-model-probe-settlement.test.ts pins that.
export const bodyShapes = new Set([
  "json-error-code",
  "json-error-no-code",
  "json-no-error",
  "non-json",
  "empty",
] as const);
export const providerErrorCodes = new Set([
  "invalid_api_key",
  "insufficient_permissions",
  "invalid_organization",
  "mismatched_organization",
  "no_organization",
  "invalid_project",
  "mismatched_project",
  "account_deactivated",
  "deactivated_workspace",
  "ip_not_authorized",
  "other",
] as const);
export const providerErrorTypes = new Set([
  "invalid_request_error",
  "authentication_error",
  "permission_error",
  "other",
] as const);

type Vocabulary<T> = T extends ReadonlySet<infer Value> ? Value : never;
type WorkStatus = Vocabulary<typeof workStatuses>;
type WorkStatusRecord = Record<string, unknown> & { status: WorkStatus };
type AgentRevisionRecord = Record<string, unknown> & { activeRevisionId?: string };
type FailureCode = Vocabulary<typeof runtimeFailureCodes> | "unrecognized";
type ProgressCode = Vocabulary<typeof deploymentProgressCodes> | "unknown";
type ReadDiagnostic = (
  method: "GET",
  path: string,
  body?: undefined,
  signal?: AbortSignal,
) => Promise<unknown>;

interface RevisionIds {
  namespaceId: string;
  agentId: string;
  revisionId: string;
}

interface RevisionBinding {
  namespaceId: `ns_${string}`;
  agentId: `agt_${string}`;
  revisionId: `rev_${string}`;
  deploymentPath: string;
}

type ReadProbePod = (revision: RevisionBinding, signal: AbortSignal) => Promise<string>;

interface ProvisioningDiagnostics {
  request: ReadDiagnostic;
  namespaceId: string;
  provisioningPath: string;
  provisioned: unknown;
  signal: AbortSignal;
  readProbePod?: ReadProbePod | undefined;
}

interface RedeployContext extends RevisionIds {
  request: ReadDiagnostic;
  signal: AbortSignal;
  timeoutMs?: number;
  pollMs?: number;
}

interface DeploymentObservation {
  status: WorkStatus | "unknown";
  lastAttemptCode: ProgressCode | "none";
  errorCode?: FailureCode | "none";
}

interface FailureObservation {
  provisioning?: ReturnType<typeof observedProvisioning> & {
    errorCode: FailureCode | "none";
  };
  deployment?: DeploymentObservation | "unavailable";
  modelProbe?: ReturnType<typeof modelProbeObservation> | "unavailable";
  probePodImage?: { digest: string; podUid: string } | "unavailable";
}

function isArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function isKnown<T extends string>(known: ReadonlySet<T>, value: unknown): value is T {
  const strings: ReadonlySet<string> = known;
  return typeof value === "string" && strings.has(value);
}

function absentOr<T>(value: unknown, observe: (present: unknown) => T): T | "none" {
  return value == null ? "none" : observe(value);
}

// For fields where "none" is a real value: absent prints "absent", off-set "other".
function markerOrAbsent<T extends string>(value: unknown, known: ReadonlySet<T>) {
  if (value == null) {
    return "absent";
  }
  return isKnown(known, value) ? value : "other";
}

const failureCategory = (code: unknown): FailureCode =>
  isKnown(runtimeFailureCodes, code) ? code : "unrecognized";
const progressCode = (code: unknown): ProgressCode =>
  isKnown(deploymentProgressCodes, code) ? code : "unknown";
const errorCode = (record: Record<string, unknown> | undefined) => asRecord(record?.error)?.code;
const lastAttemptCode = (record: Record<string, unknown>) =>
  asRecord(asRecord(record.progress)?.lastAttempt)?.code;

// The deployment failure each held model-check code becomes (worker.ts HELD_RUNTIME_FAILURE_CODES).
const probeCodeForFailure = new Map<FailureCode, Vocabulary<typeof modelProbeCodes>>([
  ["RUNTIME_AUTHENTICATION_FAILED", "AUTHENTICATION_FAILED"],
  ["RUNTIME_MODEL_PROBE_FAILED", "MODEL_PROBE_FAILED"],
]);

function readRuntimeLogPage(value: unknown, revisionId: string, source: RuntimeLogSourceId) {
  const page = asRecord(value);
  if (page?.revisionId !== revisionId || page.source !== source || !isArray(page.records)) {
    return undefined;
  }
  return { records: page.records, stream: page.stream };
}

function modelProbeObservation(fields: Record<string, unknown> | undefined, probes: number) {
  return {
    probes,
    code: absentOr(fields?.code, (code) => (isKnown(modelProbeCodes, code) ? code : "other")),
    providerStatus: absentOr(fields?.providerStatus, (status) =>
      typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599
        ? status
        : "other",
    ),
    providerCode: absentOr(fields?.providerCode, (code) =>
      isKnown(providerCodes, code) ? code : "other",
    ),
    responseHeaderMarker: markerOrAbsent(fields?.responseHeaderMarker, responseHeaderMarkers),
    bodyShape: markerOrAbsent(fields?.bodyShape, bodyShapes),
    providerErrorCode: markerOrAbsent(fields?.providerErrorCode, providerErrorCodes),
    providerErrorType: markerOrAbsent(fields?.providerErrorType, providerErrorTypes),
  };
}

// The latest failed model check (else the latest check) in the exact revision's agent log
// page, as fixed values only.
async function observeModelProbe(
  observation: FailureObservation,
  value: unknown,
  revision: RevisionBinding,
  expectedProbeCode: Vocabulary<typeof modelProbeCodes>,
  readProbePod: ReadProbePod | undefined,
  signal: AbortSignal,
) {
  const logs = readRuntimeLogPage(value, revision.revisionId, "agent");
  if (!logs) {
    return;
  }
  const records = logs.records.map(asRecord);
  const probes = records
    .filter(
      (record): record is Record<string, unknown> =>
        record?.type === "line" &&
        record.kind === "wrapper" &&
        record.message === "openclaw.model_probe",
    )
    .map((record) => ({ fields: asRecord(record.fields), stream: record.stream }));
  // A later READY must preserve the failure the deployment is holding.
  const failed = probes.filter((record) => record.fields?.code !== "READY");
  const probe = failed.at(-1) ?? probes.at(-1);
  observation.modelProbe = modelProbeObservation(probe?.fields, probes.length);
  if (!readProbePod) {
    return;
  }

  // Match one failed check to the exact container instance. A replacement gap or a
  // mixed-stream page prevents attribution even when the Pod still has the same name.
  observation.probePodImage = "unavailable";
  const stream = asRecord(probe?.stream);
  if (
    failed.length !== 1 ||
    probe?.fields?.code !== expectedProbeCode ||
    stream?.source !== "agent" ||
    stream.container !== "agent" ||
    !hasIdentifier(stream.pod) ||
    typeof stream.podUid !== "string" ||
    !uuidV4.test(stream.podUid) ||
    !isNonnegativeInteger(stream.restartCount) ||
    !isDeepStrictEqual(stream, logs.stream) ||
    records.some(
      (record) =>
        (record?.type === "gap" && record.reason === "stream_replaced") ||
        (record?.stream !== undefined && !isDeepStrictEqual(record.stream, logs.stream)),
    )
  ) {
    return;
  }
  signal.throwIfAborted();
  const output: unknown = await readProbePod(revision, signal);
  signal.throwIfAborted();
  if (typeof output !== "string") {
    return;
  }
  const [pod, podUid, restartCount, imageId, extra] = output.trim().split(/\s+/);
  if (
    pod !== stream.pod ||
    podUid !== stream.podUid ||
    restartCount !== String(stream.restartCount) ||
    imageId === undefined ||
    extra !== undefined
  ) {
    return;
  }
  const digest = /^(?:[^\s@]+@|[a-z-]+:\/\/)?(sha256:[0-9a-f]{64})$/.exec(imageId)?.[1];
  if (digest) {
    observation.probePodImage = { digest, podUid };
  }
}

// Codes from the provisioning record, its exact deployment and, for a held model-check
// failure, that check's log event and the image observed for its exact container instance.
async function observeNativeFailure(diagnostics: ProvisioningDiagnostics | undefined) {
  const provisioned = asRecord(diagnostics?.provisioned);
  const provisioning = {
    ...observedProvisioning(provisioned),
    errorCode: absentOr(errorCode(provisioned), failureCategory),
  };
  const observation: FailureObservation = { provisioning };
  if (!diagnostics || !provisioning.agentIdPresent || !provisioning.revisionIdPresent) {
    return observation;
  }
  observation.deployment = "unavailable";
  const revision = readProvisionedRevision(diagnostics, provisioned);
  if (revision) {
    try {
      const diagnosticSignal = diagnosticBudget(diagnostics.signal);
      const deployment = await readEvidence(
        diagnostics.request,
        revision.deploymentPath,
        diagnosticSignal,
      );
      await observeDeployment(
        observation,
        deployment,
        revision,
        diagnostics.request,
        diagnosticSignal,
        diagnostics.readProbePod,
      );
    } catch {
      // Diagnostic failures cannot replace the terminal failure or reveal peer errors.
    }
  }
  return observation;
}

function diagnosticBudget(signal: AbortSignal) {
  return AbortSignal.any([signal, AbortSignal.timeout(5_000)]);
}

async function readEvidence(request: ReadDiagnostic, path: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const value = await request("GET", path, undefined, signal);
  signal.throwIfAborted();
  return value;
}

function hasWorkStatus(value: Record<string, unknown>): value is WorkStatusRecord {
  return isKnown(workStatuses, value.status);
}

function hasAgentRevision(value: Record<string, unknown>): value is AgentRevisionRecord {
  return value.activeRevisionId === undefined || typeof value.activeRevisionId === "string";
}

function readBoundAgent(value: unknown, revision: RevisionIds): AgentRevisionRecord {
  const agent = asRecord(value);
  assert.ok(
    agent && agent.id === revision.agentId && agent.namespaceId === revision.namespaceId,
    "The native deployment returned a mismatched Agent binding",
  );
  assert.ok(hasAgentRevision(agent), "The native deployment returned an invalid active revision");
  return agent;
}

function boundDeployment(value: unknown, revision: RevisionIds) {
  const deployment = asRecord(value);
  return deployment?.namespaceId === revision.namespaceId &&
    deployment.agentId === revision.agentId &&
    deployment.deploymentId === revision.revisionId
    ? deployment
    : undefined;
}

function nativeDeploymentForRevision(
  value: unknown,
  revision: RevisionIds,
  operation: "deploy" | "redeploy",
) {
  const deployment = boundDeployment(value, revision);
  assert.ok(deployment, `The native ${operation} returned a mismatched deployment binding`);
  assert.ok(hasWorkStatus(deployment), `The native ${operation} returned an invalid status`);
  return deployment;
}

// Record the exact revision's status before requesting any optional model check evidence.
async function observeDeployment(
  observation: FailureObservation,
  value: unknown,
  revision: RevisionBinding,
  request: ReadDiagnostic,
  signal: AbortSignal,
  readProbePod?: ReadProbePod,
) {
  const deployment = boundDeployment(value, revision);
  if (!deployment) {
    return;
  }
  const code = errorCode(deployment);
  observation.deployment = {
    status: observedStatus(deployment.status),
    errorCode: absentOr(code, failureCategory),
    lastAttemptCode: absentOr(lastAttemptCode(deployment), progressCode),
  };
  const expectedProbeCode = isKnown(runtimeFailureCodes, code)
    ? probeCodeForFailure.get(code)
    : undefined;
  if (deployment.status === "failed" && expectedProbeCode) {
    observation.modelProbe = "unavailable";
    const logs = await readEvidence(
      request,
      `${revision.deploymentPath}/runtime/logs?source=agent&tailLines=1000`,
      signal,
    );
    await observeModelProbe(observation, logs, revision, expectedProbeCode, readProbePod, signal);
  }
}

// CI keeps only the start of this message. Lead with the probe; its 401 response
// does not tell us whether credentials were attached when the request was made.
function failNativeWork(
  expectation: string,
  code: unknown,
  { modelProbe, probePodImage, ...work }: FailureObservation,
): never {
  const observation = {
    modelProbe,
    credentialAttachment:
      modelProbe !== "unavailable" && modelProbe?.providerStatus === 401
        ? "not observed"
        : undefined,
    probePodImage,
    ...work,
  };
  assert.fail(`${expectation}: ${failureCategory(code)} ${JSON.stringify(observation)}`);
}

export async function assertNativeWorkNotFailed(
  response: unknown,
  expectation: string,
  diagnostics?: ProvisioningDiagnostics,
) {
  const work = asRecord(response);
  assert.ok(work && hasWorkStatus(work), "Native work returned an invalid status");
  if (work.status === "failed") {
    const observation = await observeNativeFailure(diagnostics);
    failNativeWork(expectation, errorCode(work), observation);
  }
}

// A failed redeploy reports evidence for the replacement revision within one diagnostic budget.
async function failNativeRedeploy(
  deployment: Record<string, unknown>,
  revision: RevisionBinding,
  request: ReadDiagnostic,
  signal: AbortSignal,
): Promise<never> {
  const observation: FailureObservation = { deployment: "unavailable" };
  try {
    await observeDeployment(observation, deployment, revision, request, diagnosticBudget(signal));
  } catch {
    // Diagnostic failures cannot replace the terminal failure or reveal peer errors.
  }
  return failNativeWork(
    "Redeployment with the retained native workspace must succeed",
    errorCode(deployment),
    observation,
  );
}

// Bind every deployment read before interpreting its status or reading the Agent.
export async function waitForNativeRedeploy({
  request,
  namespaceId,
  agentId,
  revisionId,
  signal,
  timeoutMs = 8 * 60_000,
  pollMs = 2_000,
}: RedeployContext) {
  const ids = readRevisionBinding(namespaceId, agentId, revisionId);
  assert.ok(ids, "The native redeploy returned an invalid binding");
  const agentPath = `/namespaces/${namespaceId}/agents/${agentId}`;
  const deadline = Date.now() + timeoutMs;
  let deployment: WorkStatusRecord | undefined;
  let agent: AgentRevisionRecord | undefined;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const currentDeployment = nativeDeploymentForRevision(
      await request("GET", ids.deploymentPath),
      ids,
      "redeploy",
    );
    if (currentDeployment.status === "failed") {
      await failNativeRedeploy(currentDeployment, ids, request, signal);
    }
    signal.throwIfAborted();
    if (Date.now() >= deadline) {
      break;
    }
    const currentAgent = await request("GET", agentPath);
    signal.throwIfAborted();
    if (Date.now() >= deadline) {
      break;
    }
    deployment = currentDeployment;
    agent = readBoundAgent(currentAgent, ids);
    if (deployment.status === "succeeded" && agent.activeRevisionId === revisionId) {
      break;
    }
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now()))),
    );
  }
  return { deployment, agent };
}

const hasIdentifier = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;
const isNonnegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const observedStatus = (status: unknown): WorkStatus | "unknown" =>
  isKnown(workStatuses, status) ? status : "unknown";
const isPending = (status: unknown) => status === "queued" || status === "running";
const isTerminal = (status: unknown) => status === "succeeded" || status === "failed";
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const isResourceId = <Prefix extends "ns" | "agt" | "rev">(
  value: unknown,
  prefix: Prefix,
): value is `${Prefix}_${string}` =>
  typeof value === "string" &&
  value.startsWith(`${prefix}_`) &&
  uuidV4.test(value.slice(prefix.length + 1));

function readProvisioningPath(
  namespaceId: string,
  provisioning: Record<string, unknown> | undefined,
) {
  const workId = provisioning?.workId;
  if (
    !isResourceId(namespaceId, "ns") ||
    typeof workId !== "string" ||
    !/^[A-Za-z0-9._~:@/-]{1,200}$/.test(workId) ||
    workId === "." ||
    workId === ".."
  ) {
    return undefined;
  }
  const path = `/namespaces/${namespaceId}/agents/provision/${encodeURIComponent(workId)}`;
  return provisioning?.url === path ? path : undefined;
}

export function nativeProvisioningPath(namespaceId: string, provisioning: unknown) {
  const path = readProvisioningPath(namespaceId, asRecord(provisioning));
  assert.ok(path, "Guided native provisioning returned an invalid binding");
  return path;
}

function readRevisionBinding(
  namespaceId: string,
  agentId: unknown,
  revisionId: unknown,
): RevisionBinding | undefined {
  if (
    !isResourceId(namespaceId, "ns") ||
    !isResourceId(agentId, "agt") ||
    !isResourceId(revisionId, "rev")
  ) {
    return undefined;
  }
  return {
    namespaceId,
    agentId,
    revisionId,
    deploymentPath: `/namespaces/${namespaceId}/agents/${agentId}/deployments/${revisionId}`,
  };
}

function readProvisionedRevision(
  {
    namespaceId,
    provisioningPath,
  }: Pick<ProvisioningDiagnostics, "namespaceId" | "provisioningPath">,
  provisioned: Record<string, unknown> | undefined,
) {
  if (!provisioned || readProvisioningPath(namespaceId, provisioned) !== provisioningPath) {
    return undefined;
  }
  return readRevisionBinding(namespaceId, provisioned.agentId, provisioned.revisionId);
}

// The installer can proceed only after these three reads agree before the deadline.
export async function waitForNativeProvisioning(
  context: Omit<ProvisioningDiagnostics, "provisioned">,
) {
  const { namespaceId, provisioningPath, request, signal } = context;
  const deadline = Date.now() + 8 * 60_000;
  let provisioned: Record<string, unknown> | undefined;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    provisioned = asRecord(await request("GET", provisioningPath));
    assert.ok(
      provisioned && readProvisioningPath(namespaceId, provisioned) === provisioningPath,
      "Guided native provisioning returned an invalid binding",
    );
    const diagnostics = { ...context, provisioned };
    await assertNativeWorkNotFailed(
      provisioned,
      "Guided native provisioning must succeed",
      diagnostics,
    );
    if (provisioned.status === "succeeded") {
      const revision = readRevisionBinding(
        namespaceId,
        provisioned.agentId,
        provisioned.revisionId,
      );
      assert.ok(revision, "Guided native provisioning returned an invalid revision binding");
      if (Date.now() >= deadline) {
        break;
      }
      const deployment = nativeDeploymentForRevision(
        await request("GET", revision.deploymentPath),
        revision,
        "deploy",
      );
      await assertNativeWorkNotFailed(
        deployment,
        "The admitted native revision must become ready",
        diagnostics,
      );
      if (Date.now() >= deadline) {
        break;
      }
      const value = await request("GET", `/namespaces/${namespaceId}/agents/${revision.agentId}`);
      signal.throwIfAborted();
      if (Date.now() >= deadline) {
        break;
      }
      const nativeAgent = readBoundAgent(value, revision);
      if (
        deployment.status === "succeeded" &&
        nativeAgent.activeRevisionId === revision.revisionId
      ) {
        return { nativeAgent, revisionId: revision.revisionId };
      }
    }
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(2_000, Math.max(1, deadline - Date.now()))),
    );
  }
  return failNativeProvisioningDeadline({ ...context, provisioned });
}

function observedProvisioning(provisioning: Record<string, unknown> | undefined) {
  const attemptCount = provisioning?.attemptCount;
  const phase = provisioning?.phase;
  return {
    status: observedStatus(provisioning?.status),
    phase: isKnown(provisioningPhases, phase) ? phase : "unknown",
    attemptCount: isNonnegativeInteger(attemptCount) ? attemptCount : "unknown",
    agentIdPresent: hasIdentifier(provisioning?.agentId),
    configurationIdPresent: hasIdentifier(provisioning?.configurationId),
    revisionIdPresent: hasIdentifier(provisioning?.revisionId),
  };
}

const podPhases = new Set(["Pending", "Running", "Succeeded", "Failed", "Unknown"] as const);
type PodReadiness =
  | { count: "zero" | "multiple" }
  | { count: "one"; phase: Vocabulary<typeof podPhases>; ready: boolean };

// Count non-terminating Pods observed for each role of this dedicated revision.
function observedPodReadiness(value: unknown, revisionId: string) {
  const runtime = asRecord(value);
  if (runtime?.revisionId !== revisionId || !isArray(runtime.pods)) {
    return "unavailable";
  }
  const summary: Record<RuntimeLogContainerSourceId, PodReadiness> = {
    gateway: { count: "zero" },
    agent: { count: "zero" },
  };
  for (const value of runtime.pods) {
    const { role, phase, ready } = asRecord(value) ?? {};
    if (
      (role !== "gateway" && role !== "agent") ||
      !isKnown(podPhases, phase) ||
      typeof ready !== "boolean"
    ) {
      return "unavailable";
    }
    summary[role] =
      summary[role].count === "zero" ? { count: "one", phase, ready } : { count: "multiple" };
  }
  return summary;
}

// The runtime wrapper's fixed event names; the sanitizer keeps only these as `wrapper` lines.
const wrapperEvents = new Set([
  "runtime.startup_phase",
  "openclaw.model_probe",
  "codex.model_probe",
  "runtime.workspace_node",
  "runtime.gateway_settings_overridden",
] as const);
export const runtimeLogSources = Object.freeze([
  "agent",
  "sandbox",
  "gateway",
] as const satisfies readonly RuntimeLogSourceId[]);

// CI receives counts, not the contents of an authorized runtime log page. Even sanitized
// fields can contain peer-selected values that are inappropriate for an assertion message.
function observedRuntimeOutput(value: unknown, revisionId: string, source: RuntimeLogSourceId) {
  const logs = readRuntimeLogPage(value, revisionId, source);
  if (!logs) {
    return "unavailable";
  }
  const events: Partial<Record<Vocabulary<typeof wrapperEvents>, number>> = {};
  const decisions: Partial<Record<"ALLOWED" | "DENIED" | "other", number>> = {};
  for (const value of logs.records) {
    const record = asRecord(value);
    if (record?.type !== "line") {
      continue;
    }
    if (record.kind === "wrapper" && isKnown(wrapperEvents, record.message)) {
      const event = record.message;
      events[event] = (events[event] ?? 0) + 1;
    } else if (record.kind === "sandbox") {
      const action = asRecord(record.fields)?.action;
      if (action !== undefined) {
        const decision = action === "ALLOWED" || action === "DENIED" ? action : "other";
        decisions[decision] = (decisions[decision] ?? 0) + 1;
      }
    }
  }
  return { records: logs.records.length, events, decisions };
}

interface DeadlineObservation {
  provisioning: ReturnType<typeof observedProvisioning>;
  deployment?: Pick<DeploymentObservation, "status" | "lastAttemptCode"> | "unavailable";
  provisioningAfterDeployment?: ReturnType<typeof observedProvisioning> | "unavailable";
  runtimeAfterDeadline?: ReturnType<typeof observedPodReadiness>;
  runtimeOutput?: Partial<Record<RuntimeLogSourceId, ReturnType<typeof observedRuntimeOutput>>>;
}

async function observeRuntimeAfterDeadline(
  observation: DeadlineObservation,
  revision: RevisionBinding,
  request: ReadDiagnostic,
  signal: AbortSignal,
) {
  observation.runtimeAfterDeadline = "unavailable";
  const runtime = await readEvidence(request, `${revision.deploymentPath}/runtime`, signal);
  const pods = observedPodReadiness(runtime, revision.revisionId);
  observation.runtimeAfterDeadline = pods;
  // One ready Pod per role makes these log pages useful within the original budget.
  if (
    pods === "unavailable" ||
    pods.gateway.count !== "one" ||
    !pods.gateway.ready ||
    pods.agent.count !== "one" ||
    !pods.agent.ready
  ) {
    return;
  }
  const output: NonNullable<DeadlineObservation["runtimeOutput"]> = {};
  observation.runtimeOutput = output;
  for (const source of runtimeLogSources) {
    if (signal.aborted) {
      break;
    }
    output[source] = "unavailable";
    try {
      const logs = await readEvidence(
        request,
        `${revision.deploymentPath}/runtime/logs?source=${source}&tailLines=1000`,
        signal,
      );
      output[source] = observedRuntimeOutput(logs, revision.revisionId, source);
    } catch {
      // A failed log read cannot hide Pod readiness or replace the deadline failure.
    }
  }
}

async function observeDeadline(
  observation: DeadlineObservation,
  revision: RevisionBinding,
  { request, provisioningPath, signal }: ProvisioningDiagnostics,
) {
  const diagnosticSignal = diagnosticBudget(signal);
  const deployment = boundDeployment(
    await readEvidence(request, revision.deploymentPath, diagnosticSignal),
    revision,
  );
  if (!deployment) {
    return;
  }
  const code = lastAttemptCode(deployment);
  observation.deployment = {
    status: observedStatus(deployment.status),
    lastAttemptCode: progressCode(code),
  };
  if (!isPending(observation.provisioning.status)) {
    return;
  }
  if (isTerminal(deployment.status)) {
    observation.provisioningAfterDeployment = "unavailable";
    const after = asRecord(await readEvidence(request, provisioningPath, diagnosticSignal));
    if (
      after?.agentId === revision.agentId &&
      after.revisionId === revision.revisionId &&
      readProvisioningPath(revision.namespaceId, after) === provisioningPath
    ) {
      observation.provisioningAfterDeployment = observedProvisioning(after);
    }
  } else if (
    observation.provisioning.phase === "handoff" &&
    isPending(deployment.status) &&
    (code === "REVISION_INCOMPLETE" || code === "WORKSPACE_NODE_PENDING")
  ) {
    await observeRuntimeAfterDeadline(observation, revision, request, diagnosticSignal);
  }
}

export async function failNativeProvisioningDeadline(
  diagnostics: ProvisioningDiagnostics,
): Promise<never> {
  const provisioned = asRecord(diagnostics.provisioned);
  const provisioning = observedProvisioning(provisioned);
  const observation: DeadlineObservation = { provisioning };
  if (provisioning.agentIdPresent && provisioning.revisionIdPresent) {
    observation.deployment = "unavailable";
    const revision = readProvisionedRevision(diagnostics, provisioned);
    if (revision) {
      try {
        await observeDeadline(observation, revision, diagnostics);
      } catch {
        // Diagnostic failures cannot replace the deadline failure or reveal peer errors.
      }
    }
  }
  assert.fail(
    `Guided native provisioning did not become ready before the deadline: ${JSON.stringify(observation)}`,
  );
}
