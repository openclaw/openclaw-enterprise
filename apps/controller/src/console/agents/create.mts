import type {
  Agent,
  AgentCredentialSourceBinding,
  AgentDeploymentStatusWire,
  Configuration,
  CredentialSourceMetadata,
  CredentialSourceReference,
  CredentialSourceType,
  HarnessAuthBinding,
  InstallationCapabilities,
  Namespace,
  NamespaceCallerPermissionsResponse,
  PluginApprovers,
  PresetLaunchSettings,
  SecretBindings,
  SecretMetadata,
  SecretReference,
} from "@openclaw-enterprise/contracts";
import type { Static } from "typebox";
import { type RequestOptions, requestFailure, responseFields } from "../api-client.mjs";
import { sameValue } from "../carry.mjs";
import defaultCodexPreset from "../default-codex-preset.mjs";
import {
  button,
  element,
  field as formField,
  fieldError,
  jsonObjectProblem,
  setStatusTone,
  setText,
  statusBlock,
  validateFields,
} from "../dom.mjs";
import { WORKSPACE_DEFAULTS, WORKSPACE_DEFAULTS_ID } from "../workspace-defaults.mjs";
import { configuredHarnessId, harnessAuthDescription } from "./harness-auth.mjs";
import { type DeviceLogin, createDeviceLogin } from "./device-login.mjs";
import { createRepositoryFields } from "./repositories.mjs";
import { ensureCredentialOperateBinding } from "./credential-access.mjs";
import { createSecretReferenceField, secretMetadata } from "./secret-picker.mjs";
import { workspaceFileProblem } from "./workspace.mjs";
import { namespaceNameProblem } from "../namespaces.mjs";
import { createPresetFields } from "./presets.mjs";
import { provisioningJob } from "./provisioning-job.mjs";
import { createPluginDiscovery } from "./plugin-discovery.mjs";
import { createSlackApproverField } from "./slack-approvers.mjs";
import { renderChannels } from "../channels.mjs";
import {
  type AgentNavigation,
  GENERIC_CONFLICT,
  link,
  message,
  NAMESPACE_MISSING,
  NAMESPACE_RECHECK_MS,
  namespaceCreation,
  namespacePath,
  preAdmissionRefusal,
  rejectionMessage,
} from "./list.mjs";

type ApplyPreset = Parameters<typeof createPresetFields>[1];
type PresetOptions = Partial<Parameters<ApplyPreset>[1]>;
type Permissions = Static<typeof NamespaceCallerPermissionsResponse>["data"];
type CreateRequest = (
  path: string,
  options?: RequestOptions & { revalidate?: false; rereadOnResume?: true; readOnly?: true },
) => Promise<unknown>;
type CredentialReference = SecretReference | CredentialSourceReference;
type Repositories = ReturnType<typeof createRepositoryFields>;
type CredentialRegistration = Pick<CredentialSourceMetadata, "name" | "secrets" | "type">;
type RegisteredCredential = Pick<CredentialSourceMetadata, "id" | "state">;
type SavedAgent = Pick<Agent, "id" | "name" | "configurationId">;
type SavedConfiguration = Pick<Configuration, "id" | "secretBindings">;

export interface CreateAgentContext extends AgentNavigation {
  view: HTMLElement;
  operatorId: string;
  namespaceId: string;
  namespace: Namespace | undefined;
  namespaceMissing?: boolean;
  installationAdmin: boolean | null;
  permissions: Permissions | null | undefined;
  drafts: Parameters<typeof createPresetFields>[0]["drafts"];
  request: CreateRequest;
  isCurrent(): boolean;
  onExpired(): void;
  onResume?(resume: () => void): void;
  setTitle(title: string): void;
  setDiscardOnExit(discard: boolean): void;
  setDraftCapture(
    capture: (() => CreateAgentDraft) | null,
    unsaved?: (draft?: CreateAgentDraft) => boolean,
  ): void;
}

// Only fields this editor changes. Preserve other native configuration and model metadata.
type ModelSettings = Record<string, unknown>;
type ModelSelection = string | { primary?: string | undefined; fallbacks?: unknown[] };
type ProviderModel = Record<string, unknown> & { id: string; name?: string };
type LaunchValues = Record<string, unknown> & {
  agents?: {
    defaults?: {
      model?: ModelSelection | undefined;
      models?: Record<string, ModelSettings>;
    };
    entries?: Record<string, { model?: ModelSelection; models?: Record<string, ModelSettings> }>;
  };
  models?: { providers?: Record<string, { models?: ProviderModel[] }> };
  plugins?: { entries?: Record<string, unknown>; allow?: string[] };
};

function modelPrimary(selection: ModelSelection | undefined): string | undefined {
  return typeof selection === "string" ? selection : selection?.primary;
}

function configuredModelSelection(values: LaunchValues | undefined): ModelSelection | undefined {
  const defaults = values?.agents?.defaults?.model;
  return modelPrimary(defaults)
    ? defaults
    : (Object.values(values?.agents?.entries ?? {}).find((entry) => modelPrimary(entry?.model))
        ?.model ?? defaults);
}

export interface CreateAgentDraft {
  rendered: PresetLaunchSettings;
  presetOptions: PresetOptions;
  touched: boolean;
  inputs: Record<string, string>;
  edited: boolean;
  manualModel: boolean;
  pendingModelSettings: ModelSettings | undefined;
  pendingPrimaryModel: string | undefined;
  pendingModelSelections: Record<string, unknown> | undefined;
  configurationSecretBindings: SecretBindings;
  pluginApprovers: PluginApprovers | undefined;
  oauthLogin: DeviceLogin | null | undefined;
  modelCredentialSource: CredentialReference | null | undefined;
  modelCredentialSecret: SecretMetadata | CredentialSourceReference | null | undefined;
  repositoryAccess: ReturnType<Repositories["access"]>;
  stagedChannelSecrets: SecretMetadata[];
  savedSecret: SecretMetadata | undefined;
  savedCredentialSource: RegisteredCredential | undefined;
  savedConfiguration: SavedConfiguration | undefined;
}

interface ProvisioningAttempt {
  body: Record<string, unknown> & { requestId: string };
  acknowledged: boolean;
  statusUrl?: string | undefined;
}

type ProvisioningContext = Pick<CreateAgentContext, "request" | "namespaceId" | "isCurrent"> & {
  status: HTMLElement;
};
type ProvisioningJob = ReturnType<typeof provisioningJob>;
// The API's duplicate-name sentence. Other Agent conflicts reach the client as generic text,
// so only this one is shown as sent.
const AGENT_NAME_CONFLICT =
  "An Agent with this name already exists in this Namespace. Choose a different name.";
// The open Create Agent form rechecks its Namespace when the window regains focus. The page's own
// recheck skips any open form, because a reload would discard it (finding 2012).
let recheckOpenForm: (() => void) | null = null;
let refocusListening = false;
function onRefocus(recheck: () => void) {
  recheckOpenForm = recheck;
  if (refocusListening) {
    return;
  }
  refocusListening = true;
  window.addEventListener("focus", () => recheckOpenForm?.());
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      recheckOpenForm?.();
    }
  });
}

// TODO: This starter list is intentionally hardcoded for the initial Console release.
// Revisit catalog refresh and credential-aware discovery after the basic creation flow ships.
const MODEL_CHOICES = {
  openai: [
    "gpt-6-astra",
    "gpt-6-sol",
    "gpt-6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
  ],
  // Non-retired models as of 2026-09-24, including earlier and access-restricted releases.
  // Source: https://platform.claude.com/docs/en/about-claude/model-deprecations
  anthropic: [
    "claude-opus-5-5",
    "claude-fable-5-1",
    "claude-mythos-5-1",
    "claude-opus-5",
    "claude-fable-5",
    "claude-mythos-5",
    "claude-sonnet-5",
    "claude-haiku-4-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-opus-4-5-20251101",
    "claude-sonnet-4-6",
    "claude-sonnet-4-5-20250929",
    "claude-mythos-preview",
  ],
};

function field(label: string, input: HTMLElement, hint?: string, error?: HTMLElement) {
  const node = formField({ label, control: input, help: hint, className: "form-field" });
  if (error) {
    input.after(error);
  }
  return node;
}

function configurationTemplate(harnessId: string, nativeProvider: string, providerModel: string) {
  const providerId = harnessId === "codex" ? "codex" : nativeProvider;
  const modelReference = `${providerId}/${providerModel}`;
  let baseUrl =
    nativeProvider === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1";
  if (harnessId === "codex") {
    baseUrl = "http://127.0.0.1:9";
  }
  const provider = {
    [providerId]: {
      baseUrl,
      api: nativeProvider === "anthropic" ? "anthropic-messages" : "openai-responses",
      models: [
        {
          id: providerModel,
          name: providerModel,
          ...(harnessId === "openclaw" && nativeProvider === "openai"
            ? {
                contextWindow: 128000,
                maxTokens: 8192,
                reasoning: true,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              }
            : {}),
        },
      ],
    },
  };

  const { plugins, ...base } = structuredClone(defaultCodexPreset.template.configuration.values);
  return {
    ...base,
    ...(providerModel
      ? {
          agents: {
            defaults: {
              model: modelReference,
              models: { [modelReference]: { agentRuntime: { id: harnessId } } },
            },
          },
          models: { providers: provider },
        }
      : {}),
    // Codex model transport must use its authenticated app server, never direct HTTP.
    ...(harnessId === "codex" ? { plugins } : {}),
  };
}

function selectedHarnessAuth(
  method: string,
  source: CredentialReference | null | undefined,
): HarnessAuthBinding {
  if (method === "credential_source" && source?.kind === "credential_source") {
    return { method, sourceId: source.id };
  }
  if (method === "codex_pat" && source?.kind === "secret") {
    return { method, source };
  }
  if (method === "api_key" && source?.kind === "secret") {
    return { method, source };
  }
  throw new Error("Choose a model credential for the selected authentication method.");
}

// Both a create response and a later registration check must identify the source we requested.
// The name includes our unique request ID. A conflicting record under that name is not absence.
function credentialRegistrationResult(
  value: unknown,
  namespaceId: string,
  expected: CredentialRegistration,
): RegisteredCredential | null {
  const source = responseFields(value);
  if (source.name !== expected.name) {
    return null;
  }
  const { id, state } = source;
  if (
    typeof id !== "string" ||
    !id.trim() ||
    source.namespaceId !== namespaceId ||
    source.type !== expected.type ||
    !sameValue(source.config, {}) ||
    !sameValue(source.secrets, expected.secrets) ||
    !sameValue(source.ref, { kind: "credential_source", namespaceId, id }) ||
    (state !== "ready" && state !== "registering" && state !== "deleting")
  ) {
    throw new Error("The response did not identify the requested credential registration.");
  }
  return { id, state };
}

function createClientRequestId() {
  return `req_${crypto.randomUUID()}`;
}

function provisioningStatusText(status: string) {
  switch (status) {
    case "queued":
      return "Provisioning queued…";
    case "running":
      return "Provisioning Agent…";
    case "succeeded":
      return "Provisioning finished. Opening Agent details…";
    case "failed":
      return "Provisioning failed.";
    case "cancelled":
      return "Provisioning was cancelled.";
    default:
      return "Provisioning Agent…";
  }
}

// The server's own sentence for a refused request, unless it is a catch-all answer (finding
// 1609). Among 5xx answers only a 503 whose code the API sends before admission refuses the
// request (finding 1635); any other 5xx, including a 503 without such a code, leaves its
// outcome unknown.
function namedRefusal(cause: unknown) {
  const error = requestFailure(cause);
  const message = error.serverMessage;
  if (message === undefined) {
    return undefined;
  }
  if (error.status === 409) {
    return message === GENERIC_CONFLICT ? undefined : message;
  }
  return preAdmissionRefusal(error);
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Failed provisioning codes that a retry of the same job cannot fix: the worker rejected
// the request (a taken name, a scope or authorization rejection, a Namespace or Agent
// lifecycle change, an Installation Driver change the stored plan no longer passes, or a
// Secret Driver switch) or the job was cancelled. Every other code, including the worker's
// PROVISIONING_FAILED and PROVISIONING_WORK_NOT_FOUND, keeps Retry.
const PERMANENT_PROVISIONING_CODES = new Set(["PROVISIONING_REJECTED", "PROVISIONING_CANCELLED"]);

function canRetryFailedProvisioning(job: ProvisioningJob) {
  // A rejection after the job created its Agent (stopped, no versions) still owns that name;
  // only the job's retry can finish it.
  return (
    job.revisionId === undefined &&
    (!PERMANENT_PROVISIONING_CODES.has(job.error?.code ?? "") ||
      (job.error?.code === "PROVISIONING_REJECTED" && typeof job.agentId === "string"))
  );
}

// Stop and Delete are the only operations that cancel provisioning, and a Stop keeps the Agent
// and its name. So a cancelled job whose Agent is still there, and not being deleted, was
// stopped (finding 1376): "kept". A deleted Agent is "gone". When the Agent cannot be read, the
// console cannot tell which, so it claims neither: "unknown".
async function cancelledAgentState(request: CreateRequest, namespaceId: string, agentId?: string) {
  if (typeof agentId !== "string" || !agentId) {
    return "gone";
  }
  try {
    const agent = await request(
      `${namespacePath(namespaceId)}/agents/${encodeURIComponent(agentId)}`,
    );
    return responseFields(agent).status === "deleting" ? "gone" : "kept";
  } catch (error) {
    return requestFailure(error).status === 404 ? "gone" : "unknown";
  }
}

// First-deployment waits that someone must act on: a full Pod quota (finding 1617) and an image
// the nodes cannot pull (finding 1881). The deployment's own fixed sentence replaces the bare
// provisioning line. The deployment read needs read access to the Agent. Clear the reason if the
// deployment is no longer readable or names a different wait; keep it through a cancelled read
// or temporary outage (finding 1637).
const NAMED_DEPLOYMENT_WAITS = new Set([
  "NAMESPACE_POD_QUOTA_EXCEEDED",
  "REVISION_IMAGE_PULL_FAILED",
]);
// An outage, unlike the Installation's shape, needs no administrator change (finding 1624). Agent
// save and deploy answer 503 for every harness until the selected Sandbox Driver returns.
const SANDBOX_DRIVER_OUTAGE =
  "Agents cannot be created right now: this installation's Sandbox Driver is unavailable. Reload this page to check again, or ask an administrator if it persists.";
// The deployment read was refused (401, 403 or 404): the reader can't see its waits now.
const DEPLOYMENT_UNREADABLE = Symbol("deployment unreadable");

// The deployment's actionable wait (a sentence), none (null), DEPLOYMENT_UNREADABLE, or undefined
// when the read was cut off or temporarily unavailable.
async function namedDeploymentWait(
  request: CreateRequest,
  namespaceId: string,
  job: ProvisioningJob,
  signal: AbortSignal,
) {
  if (
    typeof job.agentId !== "string" ||
    !job.agentId ||
    typeof job.revisionId !== "string" ||
    !job.revisionId
  ) {
    return null;
  }
  try {
    const deployment = await request(
      `${namespacePath(namespaceId)}/agents/${encodeURIComponent(job.agentId)}/deployments/${encodeURIComponent(job.revisionId)}`,
      { signal },
    );
    const attempt = (deployment as AgentDeploymentStatusWire)?.progress?.lastAttempt;
    return NAMED_DEPLOYMENT_WAITS.has(attempt?.code ?? "") &&
      typeof attempt?.message === "string" &&
      attempt.message
      ? attempt.message
      : null;
  } catch (error) {
    return [401, 403, 404].includes(requestFailure(error).status ?? 0)
      ? DEPLOYMENT_UNREADABLE
      : undefined;
  }
}

// The wait a job past handoff names for its first deployment (finding 1690), as the deployment's
// status does: its fixed sentence after the provisioning line. A reader who can't read the
// deployment gets the job's own PROVISIONING_DEPLOYMENT_PENDING, which says no more than the
// provisioning line, so that line stays. A wait someone must act on stands alone, as above, and
// so does a stop, which provisioning no longer continues.
const STANDALONE_JOB_WAITS = new Set([...NAMED_DEPLOYMENT_WAITS, "AGENT_STOP_YIELDED"]);

function jobDeploymentWait(job: ProvisioningJob) {
  const attempt = job.progress?.lastAttempt;
  if (
    typeof attempt?.message !== "string" ||
    !attempt.message ||
    attempt.code === "PROVISIONING_DEPLOYMENT_PENDING"
  ) {
    return null;
  }
  return STANDALONE_JOB_WAITS.has(attempt.code)
    ? attempt.message
    : `${provisioningStatusText("running")} ${attempt.message}`;
}

async function waitForProvisioning({
  request,
  status,
  first,
  namespaceId,
  provisionPath,
  isCurrent,
}: ProvisioningContext & { first: ProvisioningJob; provisionPath: string }) {
  let current = first;
  // A started job goes back to queued between retries. Keep one label once it has started,
  // and write it only when it changes, since this rereads every second (finding 1424).
  let started = false;
  // The actionable wait the last fresh deployment read named. It fills in when a later read is
  // cut off or unavailable and the job names no wait, so the line doesn't flip back to the bare
  // text (finding 1637); a fresh answer or a refusal replaces it.
  let named: string | null = null;
  while (current?.status === "queued" || current?.status === "running") {
    started ||= current.status === "running";
    // Spend the interval between polls on optional detail. At the next poll, stop that read
    // even if only its headers arrived; the provisioning job remains the source of truth.
    const detail = new AbortController();
    const nextPoll = wait(1_000).then(() => detail.abort());
    const read = await namedDeploymentWait(request, namespaceId, current, detail.signal);
    let detailText;
    if (read === DEPLOYMENT_UNREADABLE) {
      // A refusal clears every detail, the job's too: the job was read before the refusal.
      named = null;
      detailText = null;
    } else if (read !== undefined) {
      // A fresh answer's actionable wait comes first; otherwise the job names the wait.
      named = read;
      detailText = read ?? jobDeploymentWait(current);
    } else {
      // Without a fresh answer, the job's wait is newer than the one kept from an earlier read.
      detailText = jobDeploymentWait(current) ?? named;
    }
    setText(status, detailText ?? provisioningStatusText(started ? "running" : current.status));
    await nextPoll;
    if (!isCurrent()) {
      throw new DOMException("View closed", "AbortError");
    }
    const next = await request(first.url);
    current = provisioningJob(next, provisionPath, first.requestId, first.url);
  }
  // A Stop during the first deployment (REVISION_STOPPED) or before it (PROVISIONING_CANCELLED)
  // is the owner's choice, not a failure to repair.
  const cancelledAgent =
    current?.status === "failed" && current.error?.code === "PROVISIONING_CANCELLED"
      ? await cancelledAgentState(request, namespaceId, current.agentId)
      : null;
  const stopped =
    current?.status === "failed" &&
    (current.error?.code === "REVISION_STOPPED" || cancelledAgent === "kept");
  status.textContent = stopped ? "Provisioning stopped." : provisioningStatusText(current?.status);
  if (current?.status !== "succeeded") {
    throw new ProvisioningFailure(current, stopped, cancelledAgent === "unknown");
  }
  if (typeof current.agentId !== "string" || !current.agentId) {
    throw new Error("Provisioning status did not include an Agent.");
  }
  if (typeof current.revisionId !== "string" || !current.revisionId) {
    throw new Error("Provisioning status did not include an AgentRevision.");
  }
  return { agentId: current.agentId, revisionId: current.revisionId };
}

class ProvisioningFailure extends Error {
  readonly job: ProvisioningJob;
  readonly stopped: boolean;
  readonly agentUnknown: boolean;
  readonly failed: boolean;
  readonly canRetry: boolean;

  constructor(job: ProvisioningJob, stopped: boolean, agentUnknown: boolean) {
    super(job.error?.message ?? "Provisioning did not complete.");
    this.job = job;
    this.stopped = stopped;
    this.agentUnknown = agentUnknown;
    this.failed = job.status === "failed";
    this.canRetry = this.failed && canRetryFailedProvisioning(job);
  }
}

async function finishProvisioningAttempt({
  request,
  status,
  namespaceId,
  attempt,
  isCurrent,
}: ProvisioningContext & { attempt: ProvisioningAttempt }) {
  status.textContent = "Submitting provisioning request…";
  const provisionPath = `${namespacePath(namespaceId)}/agents/provision`;
  const provisioned =
    attempt.statusUrl === undefined
      ? await request(provisionPath, {
          method: "POST",
          body: attempt.body,
        })
      : await request(`${attempt.statusUrl}/retry`, { method: "POST" });
  attempt.acknowledged = true;
  const accepted = provisioningJob(
    provisioned,
    provisionPath,
    attempt.body.requestId,
    attempt.statusUrl,
  );
  attempt.statusUrl = accepted.url;
  status.textContent = "Provisioning request accepted.";
  return waitForProvisioning({
    request,
    status,
    first: accepted,
    namespaceId,
    provisionPath,
    isCurrent,
  });
}

export function renderCreateAgent(context: CreateAgentContext, restored?: unknown) {
  // This scoped draft is written only by captureDraft below.
  const draft = restored as CreateAgentDraft | undefined;
  context.setTitle("Create Agent");
  if (draft) {
    renderAgentForm(context, draft.rendered, draft.presetOptions, draft);
    return;
  }
  context.setDiscardOnExit(false);
  context.setDraftCapture(null);
  // The permission answer refuses up front what the API would refuse at submit (finding 1521),
  // and so does a Namespace that takes no new Agent (finding 1895). Gating only: an unknown
  // answer keeps the start page, and the API still decides.
  const notReady = createNamespaceState(context);
  const unavailable =
    context.permissions?.agents?.create === false
      ? "Your access does not include creating Agents in this Namespace. Ask an administrator for access, or choose another Namespace."
      : notReady?.blocked
        ? notReady.note
        : null;
  if (unavailable) {
    context.view.replaceChildren(
      element(
        "section",
        { className: "state-panel" },
        element("h2", {}, "Creating Agents is not available"),
        unavailable === notReady?.note
          ? namespaceNote(notReady)
          : element("p", { role: "status" }, unavailable),
      ),
    );
    // Start over re-enters here from the form; keep focus on the page, not the document.
    if (document.activeElement === document.body && context.isCurrent()) {
      context.view.closest(".content")?.querySelector("h1")?.focus({ preventScroll: true });
    }
    return;
  }
  // Starting the form replaces the launch view, and with it the control that started it. Give
  // focus to the page heading instead of dropping it to the document (finding 1446).
  const startForm = (
    rendered: PresetLaunchSettings,
    options: PresetOptions,
    draft?: Partial<CreateAgentDraft>,
  ) => {
    renderAgentForm(context, rendered, options, draft);
    if (document.activeElement === document.body && context.isCurrent()) {
      context.view.closest(".content")?.querySelector("h1")?.focus({ preventScroll: true });
    }
  };
  const presets = createPresetFields(context, startForm);
  context.view.replaceChildren(
    // A provisioning Namespace accepts drafts; its status shows before any start (finding 1895).
    // replaceChildren would print a null child as the text "null".
    ...(notReady ? [namespaceNote(notReady)] : []),
    element(
      "section",
      { className: "launch-intro agent-card" },
      element("h2", {}, "Your next teammate"),
      element(
        "p",
        { className: "muted" },
        "Choose a model, connect repositories, and give your Agent a place to work.",
      ),
      element(
        "div",
        { className: "launch-actions" },
        presets.startDefault,
        button("Start without Preset", () => startForm({}, {})),
      ),
      presets.defaultHint,
    ),
    element(
      "section",
      { className: "agent-card launch-preset" },
      element("h2", {}, "Use a saved setup"),
      element(
        "p",
        { className: "muted" },
        "Start from a Preset to reuse your team's configuration.",
      ),
      presets.section,
    ),
  );
}

// A member's Agent reaches its Secrets through an Installation administrator's grant (UX plan A2).
const MEMBER_CREDENTIAL_ACCESS =
  "An Installation administrator then gives the new Agent access to its Secrets.";
const MEMBER_GRANT_REFUSED =
  "The Agent was created as a draft. Giving it access to its saved model and channel Secrets needs Installation administration access: open the saved Agent and ask an Installation administrator to grant it.";
const INSTALLATION_REFUSAL =
  "Creating an Agent needs Installation access that your account does not have. Ask an Installation administrator to create this Agent.";
// The Installation read was refused and the Namespace's permission answer is unknown (its read
// failed), so whether this account may create Agents here is not known (finding 2110).
const PERMISSIONS_UNREAD =
  "Your permissions in this Namespace could not be checked, and Installation-wide capabilities are not readable with your access. Retry the permission check before creating an Agent.";
// A refused Configuration create names the grants it needs, as a refused save does
// (SAVE_REFUSALS): one fixed text for every 403 (finding 2111).
const CONFIGURATION_CREATE_REFUSAL =
  "You do not have permission to create this Agent's Configuration. Ask an administrator for Configuration create access in this Namespace, plus Secret operate on each Secret it binds.";

// What Create Agent knows of its Namespace: missing from a list the form read (kept for Start
// over, which renders from the same context), otherwise its status.
function createNamespaceState(context: CreateAgentContext) {
  return context.namespaceMissing ? NAMESPACE_MISSING : namespaceCreation(context.namespace);
}

// A Namespace that is not ready keeps its note on the start page and the form, so the first
// sign is never a refused Secret or submit (findings 1895, 1990).
function namespaceNote(notReady: { note: string }) {
  return statusBlock("warning", null, notReady.note, [], { role: "status" });
}

// Takes the not-ready note's place on an open form once its Namespace is ready (finding 2024).
function namespaceReadyNote() {
  return statusBlock(
    "success",
    null,
    "Namespace status: Ready. Agents created here can be deployed now.",
    [],
    { role: "status" },
  );
}

function renderAgentForm(
  context: CreateAgentContext,
  rendered: PresetLaunchSettings,
  presetOptions: PresetOptions = {},
  draft: Partial<CreateAgentDraft> = {},
) {
  const { view, request, namespaceId } = context;
  // A recheck replaces it once the Namespace becomes ready (finding 2012).
  let notReady = createNamespaceState(context);
  let notReadyNote = notReady ? namespaceNote(notReady) : null;
  const agent: NonNullable<PresetLaunchSettings["agent"]> & { harnessAuth?: unknown } =
    rendered.agent ?? {};
  const isObject = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  const workspaceFileNames = Object.keys(WORKSPACE_DEFAULTS);
  const initialWorkspaceFiles = isObject(agent.initialWorkspaceFiles)
    ? agent.initialWorkspaceFiles
    : {};
  const hasRenderableWorkspaceFiles =
    agent.initialWorkspaceFiles === undefined ||
    (isObject(agent.initialWorkspaceFiles) &&
      Object.keys(agent.initialWorkspaceFiles).every((filename) =>
        workspaceFileNames.includes(filename),
      ));
  // Name the first field the form cannot use, so a Preset editor knows what to fix.
  const invalidField = (() => {
    if (agent.name !== undefined && typeof agent.name !== "string") {
      return "agent.name must be text";
    }
    if (
      agent.executionMode !== undefined &&
      agent.executionMode !== "embedded" &&
      agent.executionMode !== "dedicated"
    ) {
      return 'agent.executionMode must be "embedded" or "dedicated"';
    }
    if (agent.backendId != null && typeof agent.backendId !== "string") {
      return "agent.backendId must be text";
    }
    if (agent.plugins !== undefined && !isObject(agent.plugins)) {
      return "agent.plugins must be an object";
    }
    if (
      agent.pluginApprovers !== undefined &&
      (!Array.isArray(agent.pluginApprovers) ||
        !agent.pluginApprovers.every(
          (entry) =>
            isObject(entry) && typeof entry.channel === "string" && typeof entry.id === "string",
        ))
    ) {
      return "agent.pluginApprovers must list objects with text channel and id";
    }
    if (!hasRenderableWorkspaceFiles) {
      return `agent.initialWorkspaceFiles must be an object with only ${workspaceFileNames.join(", ")}`;
    }
    if (
      rendered.configuration?.secretBindings !== undefined &&
      !isObject(rendered.configuration.secretBindings)
    ) {
      return "configuration.secretBindings must be an object";
    }
    return undefined;
  })();
  if (invalidField) {
    throw new Error(
      `Rendered Preset contains invalid Agent fields or Secret bindings: ${invalidField}. Check the variables you entered, or ask a Preset editor to fix the template.`,
    );
  }
  const auth = responseFields(agent.harnessAuth);
  const method = auth.method;
  const keyMethod = method === "api_key" || method === "codex_pat" ? method : undefined;
  const passwordAuth = Object.hasOwn(auth, "secret");
  const authDefault = keyMethod && Object.keys(auth).length === 1 ? keyMethod : undefined;
  let binding: HarnessAuthBinding | undefined;
  if (passwordAuth) {
    if (
      !keyMethod ||
      typeof auth.secret !== "string" ||
      Object.keys(auth).some((key) => key !== "method" && key !== "secret")
    ) {
      throw new Error("Rendered Preset contains invalid password authentication.");
    }
  } else if (method === "runtime") {
    binding = { method };
  } else if (!authDefault && agent.harnessAuth != null) {
    const { kind, id, namespaceId: sourceNamespace } = responseFields(auth.source);
    if (sourceNamespace === namespaceId && typeof id === "string" && id && keyMethod) {
      if (kind === "secret") {
        binding = selectedHarnessAuth(keyMethod, { kind, id, namespaceId });
      } else if (kind === "service_account" && keyMethod === "codex_pat") {
        binding = { method: keyMethod, source: { kind, id, namespaceId } };
      }
    }
    if (!binding) {
      throw new Error(
        "Rendered Preset contains an invalid authentication source for this Namespace.",
      );
    }
  }
  const boundSource = binding && "source" in binding ? binding.source : undefined;
  const hasBoundModelCredential = boundSource !== undefined;
  const presetModelSecret = presetOptions.modelSecret;
  const presetExistingSecret =
    presetModelSecret?.kind === "existing" ? presetModelSecret.secret : undefined;
  if (
    presetExistingSecret &&
    (presetExistingSecret.namespaceId !== namespaceId ||
      presetExistingSecret.ref?.kind !== "secret" ||
      presetExistingSecret.ref.namespaceId !== namespaceId ||
      presetExistingSecret.ref.id !== presetExistingSecret.id ||
      boundSource?.kind !== "secret" ||
      boundSource.namespaceId !== namespaceId ||
      boundSource.id !== presetExistingSecret.id)
  ) {
    throw new Error("Rendered Preset selected a Secret outside this Namespace.");
  }

  const formId = "create-agent-form";
  // No maxlength: it counts UTF-16 code units, so an emoji would count twice. The API
  // counts characters (code points), and so does namespaceNameProblem.
  const name = element("input", {
    id: "agent-name",
    name: "name",
    required: "",
    "data-trim": "",
    autocomplete: "off",
  });
  // The API's Name rule: length and control characters, checked before any write, so a
  // refused name never leaves a saved Configuration behind (finding 2340).
  const checkName = () => name.setCustomValidity(namespaceNameProblem(name.value));
  const dedicatedOption = element("option", { value: "dedicated" }, "Dedicated");
  const embeddedOption = element("option", { value: "embedded" }, "Embedded");
  const mode = element("select", { id: "execution-mode" }, dedicatedOption, embeddedOption);
  const codexOption = element("option", { value: "codex" }, "Codex");
  const harness = element(
    "select",
    { id: "agent-harness", "aria-describedby": "agent-harness-hint" },
    codexOption,
    element("option", { value: "openclaw" }, "OpenClaw"),
  );
  const harnessHint = element("p", { id: "agent-harness-hint", className: "hint" });
  const nativeHarnessWarning = statusBlock(
    "warning",
    null,
    "Experimental: Dedicated OpenClaw requires a runtime build with native worker-inference support. Released OpenClaw images may not include it yet.",
    [],
    { role: "status", hidden: true },
  );
  // The Installation reports native worker support only when it can admit dedicated OpenClaw:
  // the runtime supports native workers and a Sandbox Driver can provision them (finding 1608).
  // Its absence does not say whether Embedded remains: any selected Sandbox Driver refuses
  // Embedded execution, so the copy names Codex and the condition (finding 1612).
  const nativeWorkersUnavailable = statusBlock(
    "danger",
    null,
    "Dedicated OpenClaw is unavailable: this installation has no Sandbox Driver that can provision it, or its OpenClaw runtime lacks native worker support. Choose the Codex harness, or Embedded execution if the installation selects no Sandbox Driver. Otherwise an administrator must select a Sandbox Driver that can provision dedicated OpenClaw, or a runtime with native worker support.",
    [],
    { hidden: true },
  );
  // The Installation lists the OpenClaw execution modes admission accepts (#2670). When the
  // selected mode is not one of them, say so here and keep Create disabled, before any write.
  const openclawModeUnavailable = statusBlock("danger", null, null, [], { hidden: true });
  const selectedModeUnavailable = () =>
    !nativeWorkersUnavailable.hidden || !openclawModeUnavailable.hidden;
  // Invalid JSON is reported under the field, never by the browser's bubble (finding 1903).
  const configuration = element("textarea", {
    id: "configuration-json",
    name: "configuration",
    "aria-required": "true",
    rows: "18",
    className: "configuration-editor",
    spellcheck: "false",
    "aria-describedby": "configuration-json-hint",
  });
  const configurationError = fieldError(configuration);
  const primary = configuredModelSelection(rendered.configuration?.values);
  const initialModel = modelPrimary(primary);
  const nativeProvider = element(
    "select",
    { id: "model-provider" },
    element("option", { value: "openai" }, "OpenAI"),
    element("option", { value: "anthropic" }, "Anthropic"),
  );
  nativeProvider.value = initialModel?.startsWith("anthropic/") ? "anthropic" : "openai";
  const modelChoices = (provider = nativeProvider.value) =>
    provider === "anthropic" ? MODEL_CHOICES.anthropic : MODEL_CHOICES.openai;
  const useModelChoices = !binding && typeof initialModel !== "string";
  const model = element("input", {
    id: useModelChoices ? "agent-model-manual" : "agent-model",
    required: !useModelChoices,
    autocomplete: "off",
    pattern: "\\S+",
  });
  model.value = initialModel?.split("/").slice(1).join("/") || "";
  const apiKey = element("input", {
    id: "provider-api-key",
    type: "password",
    required: Boolean(passwordAuth),
    autocomplete: "off",
    spellcheck: "false",
  });
  const apiKeyOption = element("option", { value: "api_key" }, "OpenAI API key");
  const patOption = element("option", { value: "codex_pat" }, "Service Accounts");
  const oauthOption = element(
    "option",
    { value: "credential_source" },
    "ChatGPT OAuth (Experimental)",
  );
  const authMethod = element(
    "select",
    { id: "agent-auth-method" },
    apiKeyOption,
    patOption,
    oauthOption,
  );
  authMethod.value = keyMethod ?? binding?.method ?? "api_key";
  if (passwordAuth && typeof auth.secret === "string") {
    apiKey.value = auth.secret;
    delete auth.secret;
    // The retained template must not turn a cleared password into an invalid saved binding.
    delete agent.harnessAuth;
  }
  let modelCredentialSource = draft.modelCredentialSource;
  let modelCredentialSecret = draft.modelCredentialSecret;
  const authMethodField = field("Authentication method", authMethod);
  const credentialLabel = element("label", { for: apiKey.id }, "API key");
  const credentialHelp = element("p", { className: "hint", id: "provider-credential-help" });
  apiKey.setAttribute("aria-describedby", credentialHelp.id);
  let manualModel = !useModelChoices;
  let pendingModelSettings = draft.pendingModelSettings;
  let pendingPrimaryModel = draft.pendingPrimaryModel;
  let pendingModelSelections = draft.pendingModelSelections;
  const modelSelections = (values: LaunchValues) => ({
    defaults: isObject(values.agents?.defaults)
      ? { model: values.agents.defaults.model }
      : values.agents?.defaults,
    entries: isObject(values.agents?.entries)
      ? Object.fromEntries(
          Object.entries(values.agents.entries).map(([id, entry]) => [
            id,
            isObject(entry) ? { model: entry.model } : entry,
          ]),
        )
      : values.agents?.entries,
  });
  function retainPendingModel(values: LaunchValues) {
    if (pendingModelSelections && !sameValue(pendingModelSelections, modelSelections(values))) {
      pendingModelSettings = undefined;
      pendingPrimaryModel = undefined;
      pendingModelSelections = undefined;
    }
  }
  const modelChoice = element(
    "select",
    { id: "agent-model" },
    element("option", { value: "" }, "Choose a model"),
    ...modelChoices().map((id) => element("option", { value: id }, id)),
  );
  const toggleModel = button("Enter model ID manually", () => {
    if (manualModel) {
      resetModelChoices(false, model.value);
    } else {
      manualModel = true;
      modelChoice.value = "";
      updateModelConfiguration();
      updateControls();
    }
    (manualModel ? model : modelChoice).focus();
  });
  const modelField = field("Model ID", model, "Enter a model ID available to this credential.");
  const choiceField = field(
    "Model",
    modelChoice,
    "Choose a model your credential can access, or enter another model ID manually.",
  );
  const modelSection = element(
    "section",
    { className: "model-selection" },
    ...(useModelChoices ? [choiceField, toggleModel] : []),
    modelField,
  );
  function resetModelChoices(resetTransport = false, selectedModel = "") {
    manualModel = !useModelChoices;
    model.value = modelChoices().includes(selectedModel) ? selectedModel : "";
    modelChoice.replaceChildren(
      element("option", { value: "" }, "Choose a model"),
      ...modelChoices().map((id) => element("option", { value: id }, id)),
    );
    modelChoice.value = model.value;
    updateModelConfiguration(resetTransport);
    updateControls();
  }
  if (useModelChoices) {
    modelChoice.addEventListener("change", () => {
      manualModel = false;
      model.value = modelChoice.value;
      updateModelConfiguration();
    });
  }
  const modelCredentialPicker = createSecretReferenceField({
    context,
    id: "provider-credential-secret",
    label: "Model credential Secret",
    getCurrentSource: () => modelCredentialSource,
    onSecretSelected(secret) {
      modelCredentialSource = secret.ref;
      modelCredentialSecret = secret;
      resetPluginDiscovery();
      feedback.textContent = "";
      updateControls();
    },
    createSecretName: () => {
      const agentName = name.value.trim();
      return `${agentName || "Agent"} model credential`;
    },
    createDialogTitle: "Create model credential Secret",
    metadataLabel: "View model credential Secret metadata",
    noSecretLabel: "Choose a model credential Secret",
    stagedHint: "Secret selected. Create Agent binds it.",
    required: !binding && !passwordAuth,
    disabled: Boolean(binding || passwordAuth),
  });
  const modelCredentialField = modelCredentialPicker.field;
  const oauthLogin = createDeviceLogin({
    context,
    initial: draft.oauthLogin,
    hint: "Sign in for this dedicated Codex Agent. The same saved login supports plugin browsing before deployment and when editing later versions.",
    onChange(source) {
      if (authMethod.value === "credential_source") {
        modelCredentialSource = source;
        modelCredentialSecret = source;
        resetPluginDiscovery();
        updateControls();
      }
    },
  });
  const transientCredentialField = element(
    "div",
    { className: "form-field" },
    credentialLabel,
    apiKey,
    credentialHelp,
    element(
      "p",
      { className: "hint" },
      passwordAuth
        ? "Stored as a Secret for this Agent. Credentials are never included in Configuration JSON."
        : "If no Secret is selected, enter a service account token to preview plugins. Agent creation uses the selected Secret; its value stays on the server.",
    ),
  );
  const pluginDiscoveryTokenDetails = element(
    "details",
    { id: "plugin-discovery-token", className: "form-field" },
    element("summary", {}, "Plugin discovery token (optional)"),
    transientCredentialField,
  );
  const authSection = element(
    "fieldset",
    { className: "harness-auth-fields" },
    element("legend", {}, "Model provider"),
    field("Provider", nativeProvider),
    field("Harness", harness),
    harnessHint,
    nativeHarnessWarning,
    nativeWorkersUnavailable,
    openclawModeUnavailable,
    binding
      ? element("p", {}, `Preset authentication: ${harnessAuthDescription(binding)}`)
      : authMethodField,
    binding
      ? element(
          "p",
          { className: "hint" },
          hasBoundModelCredential
            ? "This Preset's saved credential and provider are fixed. Start without a Preset to use a different provider."
            : "This Preset's saved authentication source is preserved.",
        )
      : null,
    ...(!binding
      ? [
          modelCredentialField,
          oauthLogin.section,
          passwordAuth ? transientCredentialField : pluginDiscoveryTokenDetails,
        ]
      : []),
    modelSection,
  );
  name.value = typeof agent.name === "string" ? agent.name : "";
  mode.value = agent.executionMode === "embedded" ? "embedded" : "dedicated";
  // Partial Presets keep the form default until they select a model Harness.
  harness.value =
    configuredHarnessId(rendered.configuration?.values) ??
    (mode.value === "dedicated" ? "codex" : "openclaw");
  if (["codex_pat", "credential_source"].includes(authMethod.value)) {
    nativeProvider.value = "openai";
    harness.value = "codex";
    mode.value = "dedicated";
  } else if (nativeProvider.value === "anthropic" || binding?.method === "runtime") {
    harness.value = "openclaw";
    mode.value = "embedded";
  }
  if (harness.value === "codex") {
    mode.value = "dedicated";
  }
  const currentTemplate = () =>
    JSON.stringify(
      configurationTemplate(harness.value, nativeProvider.value, model.value.trim()),
      null,
      2,
    );
  configuration.value =
    rendered.configuration?.values === undefined
      ? currentTemplate()
      : JSON.stringify(rendered.configuration.values, null, 2);
  let edited = draft.edited ?? false;
  const confirmDiscard = () => !edited || window.confirm("Discard your edited launch settings?");
  const reset = button("Reset template", () => {
    if (!confirmDiscard()) {
      return;
    }
    pendingModelSettings = undefined;
    pendingPrimaryModel = undefined;
    pendingModelSelections = undefined;
    configuration.value = currentTemplate();
    configurationError.clear();
    feedback.textContent = "";
    renderChannelEditor();
  });
  function updateModelConfiguration(resetTransport = false) {
    const values = parseObject(configuration);
    if (values === undefined) {
      return;
    }
    retainPendingModel(values);
    const next = configurationTemplate(harness.value, nativeProvider.value, model.value.trim());
    const previous = values.agents?.defaults?.model;
    const previousModel = modelPrimary(configuredModelSelection(values)) ?? pendingPrimaryModel;
    const modelSettings = { ...values.agents?.defaults?.models };
    const selectedModel = next.agents?.defaults.model;
    const selectedSettings = {
      ...((selectedModel && modelSettings[selectedModel]) ||
        (previousModel && modelSettings[previousModel]) ||
        pendingModelSettings),
      ...(selectedModel ? next.agents?.defaults.models[selectedModel] : {}),
    };
    pendingModelSettings = selectedModel ? undefined : selectedSettings;
    const nextModel =
      typeof previous === "object" && previous !== null
        ? { ...previous, primary: selectedModel }
        : selectedModel;
    // OCC requires one primary across the roster. Keep explicit selections in step with
    // the edited primary, without materializing inherited selections or losing local policy.
    const entries = values.agents?.entries;
    const defaultPrimary = modelPrimary(previous);
    // Only a shared, qualified primary is a bulk-edit basis. Pending state comes from
    // clearing this control; a JSON selection edit revokes it before reading new selections.
    const sharedPrimary =
      typeof previousModel === "string" &&
      previousModel.includes("/") &&
      !previousModel.startsWith("/") &&
      !previousModel.endsWith("/") &&
      (previous === undefined ||
        defaultPrimary === previousModel ||
        (defaultPrimary === undefined && pendingPrimaryModel === previousModel)) &&
      (entries === undefined ||
        (isObject(entries) &&
          Object.values(entries).every(
            (entry) =>
              isObject(entry) &&
              (entry.model === undefined
                ? defaultPrimary === previousModel || pendingPrimaryModel === previousModel
                : modelPrimary(entry.model as ModelSelection) === previousModel),
          )));
    const nextEntries =
      selectedModel && sharedPrimary && isObject(entries)
        ? Object.fromEntries(
            Object.entries(entries).map(([id, entry]) => {
              if (!isObject(entry)) {
                return [id, entry];
              }
              const selection = entry.model as ModelSelection | undefined;
              const localPolicy = isObject(entry.models)
                ? (entry.models[selectedModel] ??
                  (previousModel ? entry.models[previousModel] : undefined))
                : undefined;
              return [
                id,
                {
                  ...entry,
                  ...(selection === undefined
                    ? {}
                    : {
                        model:
                          typeof selection === "string"
                            ? selectedModel
                            : { ...selection, primary: selectedModel },
                      }),
                  ...(isObject(localPolicy)
                    ? {
                        models: {
                          ...entry.models,
                          [selectedModel]: {
                            ...localPolicy,
                            ...next.agents?.defaults.models[selectedModel],
                          },
                        },
                      }
                    : {}),
                },
              ];
            }),
          )
        : entries;
    const selections = [
      nextModel,
      ...(nextEntries && typeof nextEntries === "object" && !Array.isArray(nextEntries)
        ? Object.values(nextEntries).map((entry) => entry?.model)
        : []),
    ];
    const referencedModels = new Set(
      selections.flatMap((selection) =>
        typeof selection === "string"
          ? [selection]
          : [
              selection?.primary,
              ...(Array.isArray(selection?.fallbacks) ? selection.fallbacks : []),
            ],
      ),
    );
    if (previousModel && !referencedModels.has(previousModel)) {
      delete modelSettings[previousModel];
      if (nextEntries !== entries) {
        for (const entry of Object.values(nextEntries ?? {})) {
          if (isObject(entry?.models)) {
            delete entry.models[previousModel];
          }
        }
      }
    }
    values.agents = {
      ...values.agents,
      ...(nextEntries === undefined ? {} : { entries: nextEntries }),
      defaults: {
        ...values.agents?.defaults,
        model: nextModel,
        models: {
          ...modelSettings,
          ...(selectedModel ? { [selectedModel]: selectedSettings } : {}),
        },
      },
    };
    const providers = { ...values.models?.providers };
    const previousId =
      typeof previousModel === "string"
        ? previousModel.slice(previousModel.indexOf("/") + 1)
        : undefined;
    // Keep transport and model metadata while no model is selected.
    pendingPrimaryModel = !selectedModel && sharedPrimary ? previousModel : undefined;
    if (resetTransport) {
      delete providers.openai;
      delete providers.anthropic;
      delete providers.codex;
      Object.assign(providers, next.models?.providers);
    } else if (selectedModel) {
      const providerId = harness.value === "codex" ? "codex" : nativeProvider.value;
      const templateProvider = next.models?.providers[providerId];
      const existingProvider = providers[providerId] ?? templateProvider;
      const existingModels: ProviderModel[] = existingProvider?.models ?? [];
      const selectedId = model.value.trim();
      const retainPrevious = referencedModels.has(`${providerId}/${previousId}`);
      const namesModel = (entry: ProviderModel, id: string | undefined) =>
        entry.id === id || entry.id === `${providerId}/${id}`;
      if (!existingModels.some((entry) => namesModel(entry, selectedId))) {
        const previousEntry = existingModels.find((entry) => namesModel(entry, previousId));
        const selectedEntry = {
          ...(previousEntry ?? templateProvider?.models[0]),
          id: selectedId,
          name:
            previousEntry?.name && previousEntry.name !== previousId
              ? previousEntry.name
              : selectedId,
        };
        providers[providerId] = {
          ...existingProvider,
          models:
            previousEntry && !retainPrevious
              ? existingModels.map((entry) => (entry === previousEntry ? selectedEntry : entry))
              : [...existingModels, selectedEntry],
        };
      } else {
        providers[providerId] = {
          ...existingProvider,
          models: existingModels.filter(
            (entry) =>
              !namesModel(entry, previousId) || namesModel(entry, selectedId) || retainPrevious,
          ),
        };
      }
    }
    values.models = { ...values.models, providers };
    if (next.plugins) {
      values.plugins = {
        ...values.plugins,
        allow: [...new Set([...(values.plugins?.allow ?? []), ...next.plugins.allow])],
        entries: {
          ...values.plugins?.entries,
          codex: resetTransport
            ? next.plugins.entries.codex
            : (values.plugins?.entries?.codex ?? next.plugins.entries.codex),
        },
      };
    } else if (values.plugins?.entries?.codex) {
      delete values.plugins.entries.codex;
      if (Array.isArray(values.plugins.allow)) {
        values.plugins.allow = values.plugins.allow.filter((id) => id !== "codex");
      }
    }
    configuration.value = JSON.stringify(values, null, 2);
    // Snapshot the serialized selections, where an undefined primary is omitted. Unrelated
    // JSON edits keep catalog provenance; changed selections cannot borrow clear-state trust.
    pendingModelSelections =
      !selectedModel && sharedPrimary
        ? modelSelections(JSON.parse(configuration.value) as LaunchValues)
        : undefined;
    configuration.setCustomValidity("");
    feedback.textContent = "";
    renderChannelEditor();
  }
  function clearModelCredential() {
    apiKey.value = "";
    modelCredentialSource = null;
    modelCredentialSecret = undefined;
    modelCredentialPicker.refresh();
  }
  nativeProvider.addEventListener("change", () => {
    // Operator-managed Presets retain the embedded harness required by their fixed binding.
    harness.value =
      nativeProvider.value === "anthropic" || binding?.method === "runtime" ? "openclaw" : "codex";
    mode.value = harness.value === "codex" ? "dedicated" : "embedded";
    // A provider change must not send the previous provider's key to a different service.
    clearModelCredential();
    if (!binding) {
      authMethod.value = "api_key";
      resetModelChoices(true);
    } else {
      updateModelConfiguration(true);
    }
  });
  authMethod.addEventListener("change", () => {
    clearModelCredential();
    resetModelChoices();
  });
  model.addEventListener("change", () => updateModelConfiguration());
  harness.addEventListener("change", () => {
    // Embedded is OpenClaw's default because dedicated OpenClaw needs a provisioning
    // Sandbox Driver; operators opt into it through Execution mode. An Installation that
    // refuses Embedded preselects Dedicated when it accepts that (#2670).
    mode.value = harness.value === "codex" ? "dedicated" : defaultOpenClawMode();
    modeDefaulted = true;
    // Service account tokens cannot authenticate OpenClaw; require a new API key.
    if (
      !binding &&
      harness.value === "openclaw" &&
      ["codex_pat", "credential_source"].includes(authMethod.value)
    ) {
      authMethod.value = "api_key";
      clearModelCredential();
      resetModelChoices(true);
    } else {
      updateModelConfiguration(true);
    }
    updateControls();
  });
  mode.addEventListener("change", () => {
    modeDefaulted = false;
    const previousHarness = harness.value;
    if (mode.value === "embedded") {
      harness.value = "openclaw";
    }
    // Topology alone does not change the model policy or provider transport.
    if (harness.value !== previousHarness) {
      updateModelConfiguration(true);
    } else {
      renderChannelEditor();
    }
    updateControls();
  });
  configuration.addEventListener("input", () => {
    const previousProvider = nativeProvider.value;
    const previousHarness = harness.value;
    configurationError.clear();
    feedback.textContent = "";
    const values = parseObject(configuration);
    if (values) {
      retainPendingModel(values);
    }
    // A cleared Model ID stays cleared until the JSON changes a model selection: a roster entry
    // still names the previous primary, but the defaults no longer select it (finding 2342).
    const selected = pendingModelSelections ? undefined : configuredModelSelection(values);
    const ref = modelPrimary(selected);
    const selectedHarness = values && configuredHarnessId(values);
    if (typeof ref === "string" && selectedHarness) {
      harness.value = selectedHarness;
      if (selectedHarness === "codex") {
        mode.value = "dedicated";
      }
    }
    if (typeof ref === "string" && /^(openai|anthropic|codex)\//.test(ref)) {
      if (
        !savedSecret &&
        !savedCredentialSource &&
        !credentialRegistration &&
        !hasBoundModelCredential
      ) {
        const selectedProvider = ref.startsWith("anthropic/") ? "anthropic" : "openai";
        if (
          !binding &&
          (selectedProvider !== nativeProvider.value ||
            (harness.value === "openclaw" && authMethod.value === "codex_pat"))
        ) {
          authMethod.value = "api_key";
          clearModelCredential();
        }
        nativeProvider.value = selectedProvider;
        if (selectedProvider === "anthropic") {
          harness.value = "openclaw";
          mode.value = "embedded";
        }
      }
      model.value = ref.slice(ref.indexOf("/") + 1);
      if (useModelChoices) {
        manualModel = true;
        modelChoice.value = "";
      }
    }
    if (previousProvider !== nativeProvider.value || previousHarness !== harness.value) {
      resetPluginDiscovery();
    }
    renderChannelEditor();
  });

  const plugins = element("textarea", { id: "agent-plugins", rows: "4", spellcheck: "false" });
  plugins.value = JSON.stringify(agent.plugins ?? {}, null, 2);
  let pluginDiscoveryCredential: "none" | "required" | null = null;
  // Codex serves curated plugins only to ChatGPT logins; API-key Agents get them disabled.
  const apiKeyCodex = () =>
    harness.value === "codex" && (binding?.method ?? authMethod.value) === "api_key";
  function discoveryCredential() {
    if (apiKeyCodex()) {
      return null;
    }
    if (harness.value === "codex" && pluginDiscoveryCredential === "none") {
      return {};
    }
    if (
      nativeProvider.value !== "openai" ||
      harness.value !== "codex" ||
      !["codex_pat", "credential_source"].includes(binding?.method ?? authMethod.value)
    ) {
      return null;
    }
    const secretRef = boundSource ?? modelCredentialSource;
    if (secretRef?.kind === "credential_source") {
      return { credentialSource: secretRef };
    }
    if (secretRef?.kind === "secret") {
      return { secretRef };
    }
    return apiKey.value.trim() ? { accessToken: apiKey.value } : null;
  }
  let configurationSecretBindings = structuredClone(
    draft.configurationSecretBindings ??
      (rendered.configuration?.secretBindings as SecretBindings | undefined) ??
      {},
  );
  let directorySecretSource: SecretReference | null = null;
  const getDirectorySecretSource = () =>
    directorySecretSource ?? configurationSecretBindings.SLACK_BOT_TOKEN?.source;
  const getSlackBotSecretId = () => {
    const source = configurationSecretBindings.SLACK_BOT_TOKEN?.source;
    return source?.kind === "secret" && source.namespaceId === namespaceId ? source.id : null;
  };
  const getDirectorySecretId = () => {
    const source = getDirectorySecretSource();
    return source?.kind === "secret" && source.namespaceId === namespaceId ? source.id : null;
  };
  const pluginDiscovery = createPluginDiscovery({
    context,
    input: plugins,
    canDiscover: () => Boolean(discoveryCredential()),
    canPrefetch: () =>
      pluginDiscoveryCredential !== null &&
      ["codex_pat", "credential_source"].includes(binding?.method ?? authMethod.value) &&
      Boolean(boundSource ?? modelCredentialSource ?? apiKey.value.trim()),
    isPending: () => pending,
    requestBody: (body) => ({ ...discoveryCredential(), ...body }),
    unavailableMessage: () =>
      apiKeyCodex()
        ? "Codex plugins need a ChatGPT login. With an OpenAI API key, each selected plugin is disabled when the Agent deploys (PLUGIN_AUTH_REQUIRED). Choose Service Accounts or ChatGPT OAuth to browse and use plugins."
        : pluginDiscoveryCredential === "none"
          ? "Choose the Codex harness to browse this Installation's curated plugin catalog."
          : "For discovery, choose ChatGPT OAuth (Experimental) and sign in, or choose Service Accounts with the Codex harness and select a Secret or enter a preview token.",
    availableMessage: () =>
      pluginDiscoveryCredential === "none"
        ? "Load the installation's curated plugin catalog. Access and tool availability are checked separately."
        : "Load plugins available to the selected credential. Your plugin selections stay unchanged.",
    createApproverField: (options) =>
      createSlackApproverField({
        context,
        getSecretId: getSlackBotSecretId,
        ...options,
      }),
  });
  const pluginFields = pluginDiscovery.fields;
  const updatePluginDiscovery = pluginDiscovery.update;
  const resetPluginDiscovery = pluginDiscovery.reset;
  apiKey.addEventListener("input", resetPluginDiscovery);
  for (const control of [nativeProvider, authMethod, harness]) {
    control.addEventListener("change", resetPluginDiscovery);
  }
  let pluginApprovers = structuredClone(
    Object.hasOwn(draft, "pluginApprovers") ? draft.pluginApprovers : agent.pluginApprovers,
  );
  const directorySecret = createSecretReferenceField({
    context,
    id: "approver-directory-secret",
    label: "Slack bot token Secret for people search",
    getCurrentSource: getDirectorySecretSource,
    onSecretSelected: async (secret) => {
      directorySecretSource = secret.ref;
      defaultApprovers.refreshDirectory();
    },
    createSecretName: () => `${name.value.trim() || "Agent"} Slack bot token`,
    metadataLabel: "View Slack bot Secret metadata",
    stagedHint: "Ready to search.",
  });
  directorySecret.field.append(
    element(
      "p",
      { className: "hint" },
      "Choose a Slack bot token to search by name. This choice is only for search and does not configure the Agent's Slack channel.",
    ),
  );
  const defaultApprovers = createSlackApproverField({
    context,
    label: "Default plugin approvers",
    getSecretId: getDirectorySecretId,
    getValue: () => pluginApprovers,
    onChange: (value) => {
      pluginApprovers = value;
      edited = true;
    },
    inheritedLabel: "Existing OpenClaw approval routing (no Agent default set)",
    lazyNames: true,
    directorySetup: directorySecret.field,
  });
  defaultApprovers.hidden = true;
  pluginFields.section.insertBefore(
    defaultApprovers,
    pluginFields.section.querySelector(".plugin-json"),
  );
  const workspaceInputs = Object.entries(WORKSPACE_DEFAULTS).map(([filename, content]) => {
    const input = element("textarea", {
      id: `workspace-${filename.replace(".", "-")}`,
      rows: "8",
      spellcheck: "false",
    });
    const initial = initialWorkspaceFiles[filename];
    input.value = typeof initial === "string" ? initial : content;
    return [filename, input] as const;
  });
  const workspaceSection = element(
    "section",
    {},
    element("h2", {}, "Workspace files"),
    element(
      "p",
      { className: "muted" },
      "Customize the OpenClaw defaults for this Agent. These files are applied before its first deployment runs. Clearing a field creates an empty file. After deployment, edit them in Workspace files on the Agent.",
    ),
    ...workspaceInputs.map(([filename, input]) => field(filename, input)),
  );
  let capabilityDiscoveryDone = false;
  let capabilityDiscoveryFailed = false;
  let capabilityDiscoveryDenied = false;
  // The Installation read is refused, but the Namespace's permission answer grants Agent create
  // (UX plan A2, finding 1901). The form proceeds without the Installation's capabilities, so it
  // refuses no option the API might accept: the preflight and Agent create still decide, before
  // and when anything is saved. capabilityDiscoveryDone stays false, so no hint claims an outcome.
  let capabilitiesUnreadable = false;
  const capabilitiesSettled = () => capabilityDiscoveryDone || capabilitiesUnreadable;
  // The Namespace's permission answer this form decides with. A retry rereads it when the
  // console's read failed (finding 2110); the API still decides every write.
  let namespacePermissions = context.permissions;
  let permissionsUnknown = false;
  let permissionsReading = false;
  // Granting the saved Agent its credential access is Installation administration, which the API
  // refused this account: a retry cannot succeed, so the form offers none (finding 2109).
  let credentialGrantRefused = false;
  const provisionableExecutionModes = new Set();
  let nativeWorkersAvailable = false;
  // The OpenClaw execution modes the Installation admits, or undefined from a server that does
  // not report them; that keeps the earlier check, Dedicated from nativeWorkers only (#2670).
  let openclawExecutionModes: Set<string> | undefined;
  // The Installation's selected Sandbox Driver is unavailable right now, so it lists no OpenClaw
  // mode and refuses every Agent save (finding 1624).
  let sandboxDriverUnavailable = false;
  // Admission's refusal when the Sandbox Driver could provision Dedicated OpenClaw but its
  // settings refuse it; it names the setting to change (finding 2373).
  let dedicatedSettingRefusal: string | undefined;
  // Whether the form chose the execution mode, rather than the Preset, the draft or the user.
  let modeDefaulted =
    agent.executionMode === undefined && !Object.hasOwn(draft.inputs ?? {}, "mode");
  const openclawModeUsable = (value: string) =>
    openclawExecutionModes?.has(value) ?? (value === "embedded" || nativeWorkersAvailable);
  const defaultOpenClawMode = () =>
    capabilityDiscoveryDone && !openclawModeUsable("embedded") && openclawModeUsable("dedicated")
      ? "dedicated"
      : "embedded";
  // Anthropic and operator-managed Preset credentials fix OpenClaw to Embedded.
  const embeddedRequired = () =>
    nativeProvider.value === "anthropic" || binding?.method === "runtime";
  let credentialSourceTypes: readonly CredentialSourceType[] | undefined;
  // A draft kept after a refused Create resumes the resources that attempt saved (finding 1934).
  let savedCredentialSource = draft.savedCredentialSource;
  let credentialRegistration: CredentialRegistration | null = null;
  let failedCredentialSource: RegisteredCredential | null = null;
  let provisioningRequestId = createClientRequestId();
  // The API admitted (or may have admitted) a job under provisioningRequestId. Create Agent
  // must then resend the same plan: the API answers an edited one with 409 "different plan".
  let requestAdmitted = false;
  let provisioningAttempt: ProvisioningAttempt | null = null;
  const capabilityStatus = element(
    "p",
    { id: "create-agent-capability-status", className: "hint", role: "status" },
    "Checking installation capabilities…",
  );
  // Above the form, not mid-form: why a member's form offers what it does (UX plan A2).
  // Granting an Agent access to its Secrets is Installation administration, so the member learns
  // before Create that an administrator finishes that step.
  const namespaceName = context.namespace?.name ?? "this Namespace";
  const accessStatus = statusBlock(
    "info",
    "Your access",
    `${
      typeof presetOptions.presetName === "string"
        ? `You can create Agents in ${namespaceName}. Installation-wide capabilities are not readable with your access, so the options below come from this Namespace's Presets.`
        : `You can create Agents in ${namespaceName}. Installation-wide capabilities are not readable with your access, so Create Agent checks the Configuration with the server before saving it.`
    } ${MEMBER_CREDENTIAL_ACCESS}`,
    [],
    { id: "create-agent-access", hidden: true },
  );
  // The Preset this form started from (flows.md C8).
  const presetBadge =
    typeof presetOptions.presetName === "string"
      ? element(
          "p",
          { className: "create-agent-origin" },
          element("span", { className: "badge" }, `From Preset · ${presetOptions.presetName}`),
        )
      : null;
  let pending = false;
  // Create's own request. `pending` also covers the recovery controls' requests, which must not
  // mark Create busy (finding 1961).
  let createPending = false;
  let outcomeUnknown = false;
  let rejectedAgentAttempt:
    | { kind: "ordinary" }
    | { kind: "repository-scoped"; repositoryPolicy: "current" | "reloading" | "reload-required" }
    | undefined;
  let savedSecret = draft.savedSecret;
  let savedConfiguration = draft.savedConfiguration;
  let savedAgent: SavedAgent | undefined;
  let stagedChannelSecrets = draft.stagedChannelSecrets ?? [];
  const feedback = element("p", { className: "error", role: "alert" });
  const savedStatus = element("p", { className: "hint", role: "status" });
  // Create's refusals show in the danger status block (UX plan C1). The line above keeps its
  // markup so open changes to the lines around it still merge.
  setStatusTone(feedback, "danger");
  const submit = element(
    "button",
    { type: "submit", form: formId, className: "button button--primary" },
    "Create Agent",
  );
  const startOver = button("Start over", () => {
    if (!isTouched() || window.confirm("Discard this draft and start again?")) {
      context.drafts.forget("channels");
      renderCreateAgent(context);
    }
  });
  const retryProvisioning = button("Retry provisioning request", () => {
    if (!provisioningAttempt || pending) {
      return;
    }
    void submitProvisioningAttempt(provisioningAttempt);
  });
  const checkCredentialRegistration = button("Check credential registration", async () => {
    if (!credentialRegistration || pending) {
      return;
    }
    pending = true;
    updateControls();
    try {
      const sources = await request(`${namespacePath(namespaceId)}/credential-sources`);
      if (!context.isCurrent()) {
        return;
      }
      if (!Array.isArray(sources)) {
        throw new Error("The credential registration list could not be read.");
      }
      const expected = credentialRegistration;
      const source = sources
        .map((item: unknown) => credentialRegistrationResult(item, namespaceId, expected))
        .find((item) => item !== null);
      if (!source) {
        failedCredentialSource = null;
        // Reuse the frozen, unique Source name: an earlier request that commits
        // later conflicts before gateway effects, rather than registering a copy.
        outcomeUnknown = false;
        feedback.textContent =
          "No credential registration is visible. Select Create Agent to retry the same registration.";
      } else if (source.state === "ready") {
        failedCredentialSource = null;
        savedCredentialSource = source;
        credentialRegistration = null;
        outcomeUnknown = false;
        feedback.textContent = "Credential Source is ready. Select Create Agent to continue.";
        showSavedStatus();
      } else {
        failedCredentialSource = source;
        feedback.textContent = `Credential Source ${source.id} is ${source.state}. Remove the failed registration before retrying; the model Secret remains saved.`;
      }
    } catch (error) {
      if (context.isCurrent()) {
        feedback.textContent = message(error);
      }
    } finally {
      if (context.isCurrent()) {
        pending = false;
        updateControls();
      }
    }
  });
  const removeCredentialRegistration = button(
    "Remove failed credential registration",
    async () => {
      if (!failedCredentialSource || pending) {
        return;
      }
      pending = true;
      updateControls();
      try {
        await request(
          `${namespacePath(namespaceId)}/credential-sources/${encodeURIComponent(failedCredentialSource.id)}`,
          { method: "DELETE", expectedStatus: 204 },
        );
        if (!context.isCurrent()) {
          return;
        }
        failedCredentialSource = null;
        credentialRegistration = null;
        outcomeUnknown = false;
        feedback.textContent =
          "Failed credential registration removed. Select Create Agent to retry with the saved model Secret.";
      } catch (error) {
        if (context.isCurrent()) {
          feedback.textContent = `${message(error)} Retry removal when the Credential Gateway is available; the model Secret remains saved.`;
        }
      } finally {
        if (context.isCurrent()) {
          pending = false;
          updateControls();
        }
      }
    },
    { tone: "danger" },
  );
  const retryCapabilityDiscovery = button("Retry capability check", () => {
    // A refused Installation read stays refused: reread only the permission answer.
    void (capabilityDiscoveryDenied ? rereadPermissions() : loadInstallationCapabilities());
  });
  const recoveryMessage = element("p", { className: "muted" });
  const requireRepositoryReload = () => {
    rejectedAgentAttempt = { kind: "repository-scoped", repositoryPolicy: "reload-required" };
  };
  const repositoryRetryLocked = () =>
    rejectedAgentAttempt?.kind === "repository-scoped" &&
    rejectedAgentAttempt.repositoryPolicy !== "current";
  const requiresRepositories = () => rejectedAgentAttempt?.kind === "repository-scoped";
  const reloadRepositories = button("Reload repository choices", async () => {
    if (rejectedAgentAttempt?.kind !== "repository-scoped" || !savedConfiguration) {
      return;
    }
    pending = true;
    rejectedAgentAttempt = { kind: "repository-scoped", repositoryPolicy: "reloading" };
    updateControls();
    feedback.textContent = "";
    try {
      const outcome = await repositories.reload();
      switch (outcome.kind) {
        case "obsolete":
        case "expired":
          return;
        case "success":
          rejectedAgentAttempt = { kind: "repository-scoped", repositoryPolicy: "current" };
          recovery.hidden = false;
          recoveryMessage.textContent =
            "Select at least one current repository and an authorization level to retry this Agent. To continue without repository access, start a new draft; the saved Configuration will remain available.";
          savedStatus.textContent = `Repository choices reloaded. Configuration ${savedConfiguration.id} remains saved and will be reused if you retry Agent creation.`;
          return;
        case "denied":
          requireRepositoryReload();
          recovery.hidden = false;
          feedback.textContent = `Repository choices could not be reloaded because Agent creation is denied. Configuration ${savedConfiguration.id} remains saved. Retry the reload or start a new draft.`;
          return;
        case "conflict":
          requireRepositoryReload();
          recovery.hidden = false;
          feedback.textContent = `Repository choices could not be reloaded because this Namespace no longer accepts new Agents. Configuration ${savedConfiguration.id} remains saved. Start a new draft only after the Namespace can accept Agents again.`;
          return;
        case "unavailable":
          requireRepositoryReload();
          recovery.hidden = false;
          feedback.textContent = `Repository choices could not be reloaded. Configuration ${savedConfiguration.id} remains saved. Retry the reload or start a new draft.`;
          return;
      }
    } finally {
      if (context.isCurrent()) {
        pending = false;
        updateControls();
      }
    }
  });
  const startNewDraft = button("Start a new draft", () => {
    if (
      savedConfiguration &&
      window.confirm(
        `Configuration ${savedConfiguration.id} will remain saved. Start a new Agent draft?`,
      )
    ) {
      context.drafts.forget("channels");
      renderCreateAgent(context);
    }
  });
  const recovery = element(
    "section",
    { className: "agent-card", hidden: true, "aria-labelledby": "create-recovery-title" },
    element("h2", { id: "create-recovery-title" }, "Recover from a rejected Agent save"),
    recoveryMessage,
    element("div", { className: "form-actions" }, reloadRepositories, startNewDraft),
  );
  const actions = element(
    "div",
    { className: "form-actions" },
    // Cancel is the explicit discard; other exits keep the draft (finding 1902).
    button("Cancel", () => {
      if (!isTouched() || window.confirm("Discard this draft?")) {
        context.setDiscardOnExit(true);
        context.navigate("agents");
      }
    }),
    startOver,
    retryProvisioning,
    checkCredentialRegistration,
    removeCredentialRegistration,
    submit,
  );
  const channelEditor = element("div", { className: "create-channels" });
  // The collapsed Runtime details still name the selected execution mode.
  const runtimeModeSummary = element("span", { className: "muted" });
  let repositories: Repositories;
  const form = element(
    "form",
    { id: formId, className: "agent-form agent-card", novalidate: "" },
    ...(presetBadge ? [presetBadge] : []),
    field("Agent name", name, "Unique within this Namespace."),
    authSection,
    capabilityStatus,
    retryCapabilityDiscovery,
    element(
      "details",
      { className: "launch-runtime" },
      element("summary", {}, "Runtime details", runtimeModeSummary),
      field(
        "Execution mode",
        mode,
        "Codex uses Dedicated execution. OpenClaw uses Dedicated execution with a Sandbox Driver that provisions it, and Embedded execution without a Sandbox Driver. Slack requires Dedicated execution.",
      ),
    ),
    (repositories = createRepositoryFields(
      context,
      (changed) => {
        if (changed) {
          edited = true;
        }
        feedback.textContent = "";
        updateControls();
      },
      { ...agent, ...(draft.repositoryAccess ? { repositoryAccess: draft.repositoryAccess } : {}) },
    )).section,
    pluginFields.section,
    element(
      "details",
      { className: "launch-advanced" },
      element("summary", {}, "Advanced settings"),
      element(
        "p",
        { className: "hint" },
        "Defaults are ready to use. Customize configuration or initial workspace files when needed.",
      ),
      field(
        "Configuration JSON",
        configuration,
        "Provider and model selections update this JSON. Supported Dedicated runtimes provision and deploy from this form. Embedded and unsupported runtimes save a draft for later deployment. Slack token Secrets can be selected or created from the channel editor.",
        configurationError.node,
      ),
      reset,
      workspaceSection,
    ),
  );
  form.addEventListener("input", (event) => {
    edited = true;
    const control = event.target;
    if (
      control instanceof HTMLInputElement ||
      control instanceof HTMLSelectElement ||
      control instanceof HTMLTextAreaElement
    ) {
      control.setCustomValidity("");
    }
    if (event.target === name) {
      checkName();
    }
  });
  form.addEventListener("change", () => {
    edited = true;
  });
  const draftInputs = {
    name,
    mode,
    harness,
    nativeProvider,
    authMethod,
    model,
    modelChoice,
    configuration,
    plugins,
    ...Object.fromEntries(workspaceInputs),
  };
  if (draft.inputs && useModelChoices) {
    modelChoice.replaceChildren(
      element("option", { value: "" }, "Choose a model"),
      ...modelChoices(draft.inputs.nativeProvider).map((id) =>
        element("option", { value: id }, id),
      ),
    );
  }
  for (const [key, input] of Object.entries(draftInputs)) {
    const value = draft.inputs?.[key];
    if (value !== undefined) {
      input.value = value;
    }
  }
  manualModel = draft.manualModel ?? manualModel;
  // Whether the reader changed the form or its Preset variables: Cancel then asks first, and a
  // reload or tab close warns. Restoring a draft and the form's own updates fire no trusted event.
  let touched = Boolean(draft.touched);
  const markTouched = (event: Event) => {
    touched ||= event.isTrusted;
  };
  for (const node of [form, channelEditor]) {
    node.addEventListener("input", markTouched);
    node.addEventListener("change", markTouched);
  }
  toggleModel.addEventListener("click", markTouched);
  // Repository edits and other button-only changes set `edited`.
  const isTouched = () => touched || edited;
  const captureDraft = (): CreateAgentDraft => ({
    touched: isTouched(),
    rendered,
    presetOptions,
    // Keep raw editor text, including invalid JSON. Password controls are deliberately excluded.
    inputs: Object.fromEntries(
      Object.entries(draftInputs).map(([key, input]) => [key, input.value]),
    ),
    manualModel,
    pluginApprovers,
    edited,
    pendingModelSettings,
    pendingPrimaryModel,
    pendingModelSelections,
    configurationSecretBindings,
    stagedChannelSecrets,
    modelCredentialSource,
    modelCredentialSecret,
    oauthLogin: oauthLogin.capture(),
    repositoryAccess: repositories.access(),
    savedSecret,
    savedCredentialSource,
    savedConfiguration,
    // A restored form has no password field (it is never kept), so the Secret this form saved
    // from it becomes the chosen model credential (finding 1934).
    ...(passwordAuth && savedSecret
      ? { modelCredentialSource: savedSecret.ref, modelCredentialSecret: savedSecret }
      : {}),
  });
  // A changed form, or one holding resources a refused Create saved, would lose work on reload.
  const unsavedDraft = (captured?: CreateAgentDraft) =>
    Boolean(
      captured?.touched ||
      captured?.savedSecret ||
      captured?.savedCredentialSource ||
      captured?.savedConfiguration,
    );
  // A refused Create leaves the form to fix and retry, so it is a draft again: the reload warning
  // and the kept form survive it (finding 1934). A draft restores only the saved resources, so an
  // uncertain outcome, a pending registration, an admitted provisioning job or a repository
  // policy refusal (which locks the retry until a reload) keeps the form uncaptured, as an Agent
  // that may exist does.
  function keepDraftAfterRefusal() {
    if (
      !savedAgent &&
      !outcomeUnknown &&
      !requestAdmitted &&
      !provisioningAttempt &&
      !credentialRegistration &&
      !failedCredentialSource &&
      rejectedAgentAttempt?.kind !== "repository-scoped"
    ) {
      context.setDraftCapture(captureDraft, unsavedDraft);
    }
  }
  function parseObject<T extends Record<string, unknown> = LaunchValues>(
    input: HTMLTextAreaElement,
    reportInvalid = false,
  ): T | undefined {
    const problem = jsonObjectProblem(input.value);
    if (problem === undefined) {
      return JSON.parse(input.value);
    }
    if (reportInvalid && input === configuration) {
      configurationError.show(problem);
      focusConfiguration();
    } else if (reportInvalid) {
      const details = input.closest("details");
      if (details) {
        details.open = true;
      }
      input.setCustomValidity("Enter a valid JSON object.");
      validateFields([input]);
    }
    return undefined;
  }
  // The JSON is the thing to fix: open its section and put the caret there (finding 1903).
  function focusConfiguration() {
    const details = configuration.closest("details");
    if (details) {
      details.open = true;
    }
    configuration.focus();
  }
  function hasEnabledChannel(values: LaunchValues) {
    const channels = values.channels;
    if (channels === null || typeof channels !== "object" || Array.isArray(channels)) {
      return false;
    }
    return ["slack", "msteams"].some((id) => {
      const config = responseFields(channels)[id];
      return (
        config !== null &&
        typeof config === "object" &&
        !Array.isArray(config) &&
        responseFields(config).enabled !== false
      );
    });
  }
  async function grantConfigurationSecretAccess(
    agent: Pick<Agent, "servicePrincipalId">,
    secrets: SecretMetadata[],
    configuration: SavedConfiguration,
  ) {
    const bindings = Object.values(configuration.secretBindings ?? {});
    const seen = new Set();
    for (const secret of secrets) {
      if (
        secret.namespaceId !== namespaceId ||
        seen.has(secret.id) ||
        !bindings.some(
          (binding) =>
            binding?.source?.kind === "secret" &&
            binding.source.namespaceId === namespaceId &&
            binding.source.id === secret.id &&
            binding.delivery?.type === "env",
        )
      ) {
        continue;
      }
      seen.add(secret.id);
      if (!context.isCurrent()) {
        throw new Error("This view has changed. Reopen Agent creation before binding Secrets.");
      }
      await ensureCredentialOperateBinding(context, agent, secret);
    }
  }
  function renderChannelEditor() {
    const values = parseObject(configuration);
    if (values === undefined) {
      channelEditor.replaceChildren(
        element(
          "section",
          { className: "channels-section" },
          element("div", { className: "channel-heading" }, element("h2", {}, "Channels")),
          statusBlock(
            "danger",
            null,
            "Enter a valid Configuration JSON object before configuring channels.",
            [],
            { role: null },
          ),
        ),
      );
      return;
    }
    const channels = renderChannels({
      values,
      executionMode: mode.value,
      readOnly: Boolean(savedConfiguration),
      drawerContext: {
        drafts: context.drafts,
        baseline: JSON.stringify([values, configurationSecretBindings]),
        operatorId: context.operatorId,
        ...(context.installationAdmin == null
          ? {}
          : { installationAdmin: context.installationAdmin }),
        namespaceId,
        request,
        agentName: () => name.value,
        creating: true,
        secretBindings: configurationSecretBindings,
        isCurrent: context.isCurrent,
        onExpired: context.onExpired,
      },
      copy: {
        editableDescription:
          "Stage Slack settings into this Configuration JSON. They are saved when you create the Agent.",
        drawerNotice:
          "Channel and Secret binding settings apply to this form’s Configuration JSON.",
        drawerFootnote:
          "Channel settings and selected bindings are not persisted until you create the Agent. Secrets created from the modal are stored immediately in the Namespace.",
        saveLabel: "Apply channel settings",
        readOnlyDescription:
          "This saved initial Configuration is fixed for this create form." +
          (credentialGrantRefused
            ? ""
            : " Retrying Agent creation will reuse these channel settings."),
        readOnlyCardMessage: "This saved initial Configuration cannot be edited from this form.",
      },
      onSave: async (updatedValues, options = {}) => {
        if (!context.isCurrent() || pending || outcomeUnknown || savedConfiguration) {
          throw new Error("This view has changed. Reopen Agent creation before applying channels.");
        }
        context.drafts.forget("channels");
        edited = true;
        configuration.value = JSON.stringify(updatedValues, null, 2);
        if (options.secretBindings !== undefined) {
          configurationSecretBindings = structuredClone(options.secretBindings);
          stagedChannelSecrets = [...stagedChannelSecrets, ...(options.changedSecrets ?? [])];
          directorySecret.refresh();
          defaultApprovers.refreshDirectory();
          pluginDiscovery.update();
        }
        configurationError.clear();
        setTimeout(() => {
          if (context.isCurrent()) {
            renderChannelEditor();
          }
        }, 0);
      },
    });
    const modeWarning =
      mode.value === "embedded" && hasEnabledChannel(values)
        ? statusBlock(
            "danger",
            null,
            "Channels require Dedicated execution. Select Dedicated under Runtime details or disable configured channels before creating the Agent.",
            [],
            { role: null },
          )
        : null;
    channelEditor.replaceChildren(channels, ...(modeWarning ? [modeWarning] : []));
    updateControls();
  }
  // Device-login sources keep their create-then-deploy flow; API-key and PAT
  // registration can hand their exact source to guided provisioning.
  const shouldProvision = () =>
    (binding?.method ?? authMethod.value) !== "credential_source" &&
    mode.value === "dedicated" &&
    provisionableExecutionModes.has(mode.value);
  function modelSourceType() {
    const candidates = (credentialSourceTypes ?? []).filter(
      (type) =>
        type.harnessAuth?.modelProvider === nativeProvider.value &&
        type.harnessAuth.loginMode === (binding?.method ?? authMethod.value) &&
        !type.config.some((field) => field.required) &&
        type.secrets.length === 1 &&
        type.secrets[0]?.required,
    );
    return candidates.length === 1 ? candidates[0] : null;
  }
  // Every step of a provisioning plan needs a ready Namespace, so the API would refuse it; a
  // draft plan still saves (finding 2007, #2867).
  const provisioningWaitsForNamespace = () => Boolean(notReady) && shouldProvision();
  // A Namespace that takes no new Agent, draft or not: an adopted one still provisioning, which
  // becomes ready by waiting, or one that turned failed or deleting, or went missing, while the
  // form was open, which never does (finding 2022). A refocus still rechecks it.
  const namespaceRefusesAgents = () => Boolean(notReady?.blocked);
  const namespaceEnded = () =>
    Boolean(notReady?.missing) ||
    (namespaceRefusesAgents() && ["failed", "deleting"].includes(context.namespace?.status ?? ""));
  // The Namespace can become ready while the form is open. Reread only its status, on refocus
  // and while Create Agent waits for it, and update just the note and the gate: the draft,
  // focus and field values stay (finding 2012). A failed read keeps the 10 s wait going
  // (finding 2021); a form that Start over replaced stops for good.
  let namespaceTimer: number | undefined;
  let namespaceReading = false;
  const namespaceGateShown = () =>
    !savedAgent &&
    !provisioningAttempt &&
    !namespaceEnded() &&
    (provisioningWaitsForNamespace() || namespaceRefusesAgents());
  const recheckNamespace = async () => {
    clearTimeout(namespaceTimer);
    namespaceTimer = undefined;
    if (!context.isCurrent() || !form.isConnected) {
      if (recheckOpenForm === recheckNamespace) {
        recheckOpenForm = null;
      }
      return;
    }
    if (!notReady || namespaceReading || document.hidden) {
      return;
    }
    namespaceReading = true;
    let namespace;
    let read = false;
    try {
      const namespaces = (await request("/namespaces", {
        revalidate: false,
        rereadOnResume: true,
      })) as Namespace[];
      namespace = namespaces.find((item) => item.id === namespaceId);
      read = true;
    } catch {
      // A failed read changes nothing on screen; the next check comes at the usual cadence.
    } finally {
      namespaceReading = false;
    }
    if (!context.isCurrent() || !form.isConnected) {
      return;
    }
    if (!read) {
      waitForNamespace();
      return;
    }
    // Start over renders from this context again. A complete list without the Namespace is an
    // answer too: it stops the wait instead of leaving the last status shown.
    if (namespace) {
      context.namespace = namespace;
    }
    context.namespaceMissing = !namespace;
    const next = createNamespaceState(context);
    if (next?.note !== notReady?.note) {
      notReady = next;
      // Swap the note in place and keep its height, so the field being edited below it does not
      // jump mid-edit (finding 2024). A ready Namespace says so where the warning was.
      const replacement = next ? namespaceNote(next) : namespaceReadyNote();
      if (notReadyNote) {
        replacement.style.minHeight = `${notReadyNote.getBoundingClientRect().height}px`;
        // A new width reflows the form anyway; the reserved space would then only stay empty.
        window.addEventListener("resize", () => replacement.style.removeProperty("min-height"), {
          once: true,
        });
        notReadyNote.replaceWith(replacement);
      }
      notReadyNote = replacement;
      updateControls();
    }
    waitForNamespace();
  };
  const waitForNamespace = () => {
    if (namespaceTimer === undefined && !namespaceReading && namespaceGateShown()) {
      namespaceTimer = setTimeout(() => {
        namespaceTimer = undefined;
        if (namespaceGateShown()) {
          void recheckNamespace();
        }
      }, NAMESPACE_RECHECK_MS);
    }
  };
  if (notReady) {
    onRefocus(recheckNamespace);
    // A retained form comes back with its timer stopped: recheck as on a refocus.
    context.onResume?.(() => {
      onRefocus(recheckNamespace);
      void recheckNamespace();
    });
  }
  const credentialSourceRefused = () =>
    credentialSourceTypes !== undefined &&
    (binding?.method ?? authMethod.value) !== "credential_source" &&
    (!shouldProvision() || !modelSourceType());
  const updateControls = () => {
    const saved = Boolean(savedConfiguration || savedAgent || provisioningAttempt);
    const planLocked =
      pending ||
      Boolean(savedAgent) ||
      Boolean(provisioningAttempt) ||
      outcomeUnknown ||
      requestAdmitted;
    for (const node of form.querySelectorAll<
      HTMLInputElement | HTMLSelectElement | HTMLButtonElement | HTMLTextAreaElement
    >("button, input, select, textarea")) {
      if (repositories?.section.contains(node)) {
        continue;
      }
      node.disabled = planLocked;
    }
    // Unsaved Agent fields remain editable after a known rejection; reuse the saved Configuration.
    for (const node of [
      configuration,
      nativeProvider,
      authMethod,
      model,
      modelChoice,
      harness,
      mode,
      reset,
    ]) {
      node.disabled ||= Boolean(savedConfiguration);
    }
    for (const node of actions.querySelectorAll("button")) {
      node.disabled = pending;
    }
    updatePluginDiscovery();
    pluginFields.setDisabled(planLocked);
    channelEditor.toggleAttribute("inert", planLocked || saved);
    channelEditor.setAttribute("aria-busy", pending ? "true" : "false");
    const usesPat = (binding?.method ?? authMethod.value) === "codex_pat";
    const usesOAuth = (binding?.method ?? authMethod.value) === "credential_source";
    if (usesOAuth && !binding) {
      modelCredentialSource = oauthLogin.source;
      modelCredentialSecret = oauthLogin.source;
    }
    oauthLogin.setActive(usesOAuth && !binding);
    oauthLogin.setDisabled(planLocked || saved);
    mode.disabled ||=
      harness.value === "codex" ||
      nativeProvider.value === "anthropic" ||
      binding?.method === "runtime";
    // Why the harness choice is locked, without the request in flight: the hint must not change
    // while Create is pending, or it shifts the refusal the form just scrolled into view.
    const harnessChoiceLocked =
      saved ||
      outcomeUnknown ||
      requestAdmitted ||
      binding?.method === "runtime" ||
      (usesPat && Boolean(binding || savedSecret));
    harness.disabled ||= pending || harnessChoiceLocked;
    const dedicatedRefused = capabilityDiscoveryDone && !openclawModeUsable("dedicated");
    const nativeRefused = dedicatedRefused && harness.value === "openclaw";
    const embeddedRefused = capabilityDiscoveryDone && !openclawModeUsable("embedded");
    const openclawEmbeddedRefused = embeddedRefused && harness.value === "openclaw";
    const noOpenClawMode = nativeRefused && openclawEmbeddedRefused;
    const sandboxDriverOutage = capabilityDiscoveryDone && sandboxDriverUnavailable;
    dedicatedOption.disabled = nativeRefused;
    embeddedOption.disabled = embeddedRefused;
    nativeWorkersUnavailable.hidden =
      !nativeRefused || noOpenClawMode || mode.value !== "dedicated";
    // A setting refusal names the setting to change, not another Sandbox Driver (finding 2373).
    const dedicatedRefusalReason = dedicatedSettingRefusal
      ? `its settings refuse Dedicated OpenClaw. ${dedicatedSettingRefusal}`
      : "it cannot run Dedicated OpenClaw.";
    const modeRefusal = sandboxDriverOutage
      ? SANDBOX_DRIVER_OUTAGE
      : noOpenClawMode
        ? binding?.method === "runtime"
          ? `OpenClaw is unavailable on this installation: its selected Sandbox Driver refuses Embedded execution, and ${dedicatedRefusalReason} This Preset's operator-managed credentials require OpenClaw. Ask an administrator, or start without a Preset.`
          : `OpenClaw is unavailable on this installation: its selected Sandbox Driver refuses Embedded execution, and ${dedicatedRefusalReason}${dedicatedSettingRefusal ? "" : " Choose OpenAI with the Codex harness, or ask an administrator to select a Sandbox Driver that can provision dedicated OpenClaw, with a runtime that has native worker support."}`
        : openclawEmbeddedRefused && mode.value === "embedded"
          ? binding?.method === "runtime"
            ? "This Preset's operator-managed credentials require Embedded OpenClaw, which this installation refuses because it selects a Sandbox Driver. Ask an administrator, or start without a Preset."
            : nativeProvider.value === "anthropic"
              ? "Anthropic uses Embedded OpenClaw, which this installation refuses because it selects a Sandbox Driver. Choose OpenAI to use Dedicated execution."
              : "Embedded OpenClaw is unavailable: this installation selects a Sandbox Driver, which requires Dedicated execution. Select Dedicated under Runtime details."
          : "";
    if (openclawModeUnavailable.textContent !== modeRefusal) {
      openclawModeUnavailable.textContent = modeRefusal;
    }
    openclawModeUnavailable.hidden = !modeRefusal;
    const modeUnavailable = selectedModeUnavailable();
    runtimeModeSummary.textContent = modeUnavailable
      ? " · Execution mode unavailable"
      : ` · ${mode.value === "dedicated" ? "Dedicated" : "Embedded"}`;
    const modeHint = form.querySelector("#execution-mode-hint");
    if (modeHint) {
      modeHint.textContent = sandboxDriverOutage
        ? "Codex and OpenClaw are unavailable while this installation's Sandbox Driver is unavailable."
        : embeddedRefused && dedicatedRefused
          ? "Codex uses Dedicated execution. OpenClaw is unavailable on this installation. Slack requires Codex."
          : nativeRefused
            ? "Codex uses Dedicated execution. Dedicated OpenClaw is unavailable because this installation has no Sandbox Driver that can provision it, or its OpenClaw runtime lacks native worker support. Embedded OpenClaw works only when the installation selects no Sandbox Driver. Slack requires Codex."
            : embeddedRefused
              ? "Codex uses Dedicated execution. This installation selects a Sandbox Driver, so OpenClaw uses Dedicated execution too. Slack requires Dedicated execution."
              : "Codex uses Dedicated execution. OpenClaw uses Dedicated execution with a Sandbox Driver that provisions it, and Embedded execution without a Sandbox Driver. Slack requires Dedicated execution.";
    }
    if (capabilitiesSettled()) {
      let nextStatus = "";
      if (!savedAgent && namespaceRefusesAgents()) {
        nextStatus = notReady?.missing
          ? "Create Agent is unavailable until you choose another Namespace."
          : namespaceEnded()
            ? "This Namespace cannot hold new Agents, so Create Agent is unavailable."
            : "Create Agent is unavailable until this Namespace is ready.";
      } else if (!modeUnavailable) {
        nextStatus = shouldProvision()
          ? notReady
            ? "Dedicated Agents are provisioned and deployed when created, so this Namespace must be ready first. Create Agent is unavailable until then."
            : "Dedicated Agents are provisioned and deployed when created."
          : capabilitiesUnreadable
            ? // Without the Installation's capabilities, deploying may need an administrator.
              "Agents you create here are saved as drafts for later deployment."
            : mode.value === "embedded"
              ? "Embedded Agents are saved as drafts. Deploy them from the Agent page after creation."
              : "This installation creates draft Agents for later deployment.";
      }
      if (capabilityStatus.textContent !== nextStatus) {
        capabilityStatus.textContent = nextStatus;
      }
    }
    // The harness hint states what this Agent will run; Runtime details keep the installation's
    // conditions (finding 1904).
    const harnessOutcome = () => {
      const anthropic = nativeProvider.value === "anthropic";
      if (harness.value === "codex") {
        // "Will run" only once the Installation's capabilities are known.
        return anthropic
          ? "This Agent cannot run Codex: Codex requires OpenAI."
          : capabilityDiscoveryDone
            ? "This Agent will run Codex with Dedicated execution."
            : "Codex requires OpenAI and Dedicated execution.";
      }
      if (!capabilityDiscoveryDone) {
        return "OpenClaw is available for both providers. With OpenAI its execution mode depends on the installation's Sandbox Driver; Anthropic uses Embedded OpenClaw.";
      }
      if (noOpenClawMode) {
        return dedicatedSettingRefusal
          ? "OpenClaw is unavailable on this installation: its selected Sandbox Driver refuses Embedded execution, and its settings refuse Dedicated OpenClaw."
          : "OpenClaw is unavailable on this installation: its selected Sandbox Driver refuses Embedded execution, and it cannot run Dedicated OpenClaw.";
      }
      const runtime = `${mode.value === "dedicated" ? "Dedicated" : "Embedded"} execution`;
      if (anthropic && mode.value !== "embedded") {
        return `This Agent cannot run OpenClaw with ${runtime}: Anthropic requires Embedded OpenClaw.`;
      }
      if (modeUnavailable) {
        return `This Agent cannot run OpenClaw with ${runtime} on this installation.`;
      }
      // Name Codex only when the reader can still choose it.
      const reason = anthropic
        ? " Anthropic requires Embedded OpenClaw."
        : nativeRefused && !harnessChoiceLocked
          ? " Choose Codex for Dedicated execution."
          : "";
      return `This Agent will run OpenClaw with ${runtime}.${reason}`;
    };
    nativeHarnessWarning.hidden =
      harness.value !== "openclaw" || mode.value !== "dedicated" || nativeRefused;
    codexOption.hidden = nativeProvider.value === "anthropic";
    codexOption.disabled = nativeProvider.value === "anthropic";
    harnessHint.textContent =
      harnessChoiceLocked && usesPat
        ? "This saved service account token requires Codex. Create a new draft without a Preset to use OpenClaw with an API key."
        : sandboxDriverOutage
          ? "Codex and OpenClaw are unavailable right now: this installation's Sandbox Driver is unavailable."
          : harnessOutcome();
    if (binding?.method === "runtime") {
      harnessHint.textContent =
        "This Preset's operator-managed credentials require the OpenClaw harness.";
    }
    nativeProvider.disabled ||=
      Boolean(savedSecret || savedCredentialSource || credentialRegistration) ||
      hasBoundModelCredential;
    authMethod.disabled ||= Boolean(savedSecret || savedCredentialSource || credentialRegistration);
    apiKeyOption.textContent =
      nativeProvider.value === "anthropic" ? "Anthropic API key" : "OpenAI API key";
    patOption.hidden = harness.value !== "codex";
    patOption.disabled = harness.value !== "codex";
    oauthOption.hidden = harness.value !== "codex";
    oauthOption.disabled = harness.value !== "codex";
    credentialLabel.textContent = passwordAuth
      ? usesPat
        ? "Service account token"
        : "API key"
      : "Token for plugin discovery";
    modelCredentialField.hidden = Boolean(binding || passwordAuth || usesOAuth);
    transientCredentialField.hidden = usesOAuth;
    pluginDiscoveryTokenDetails.hidden = Boolean(
      binding || passwordAuth || !usesPat || pluginDiscoveryCredential === "none",
    );
    if (pluginDiscoveryTokenDetails.hidden) {
      pluginDiscoveryTokenDetails.open = false;
    }
    modelCredentialField.querySelector("label")!.textContent = usesPat
      ? "Service account token Secret"
      : "API key Secret";
    modelCredentialPicker.setRequired(!binding && !passwordAuth && !usesOAuth);
    modelCredentialPicker.setDisabled(
      planLocked ||
        Boolean(
          binding ||
          passwordAuth ||
          usesOAuth ||
          savedConfiguration ||
          savedCredentialSource ||
          // A restored password-Preset form names the Secret it saved; a retry must use it.
          savedSecret ||
          credentialRegistration,
        ),
    );
    if (usesPat) {
      apiKey.placeholder = "at-…";
      credentialHelp.replaceChildren(
        "Use a workspace service account token for dedicated Codex. In ",
        element(
          "a",
          { href: "https://admin.openai.com/", target: "_blank", rel: "noopener noreferrer" },
          "OpenAI admin",
        ),
        ", choose your workspace, open Service accounts, and create a token with Codex scope.",
      );
    } else if (nativeProvider.value === "openai") {
      apiKey.placeholder = "sk-…";
      credentialHelp.replaceChildren(
        "Use an OpenAI API key with API billing. ",
        element(
          "a",
          {
            href: "https://platform.openai.com/api-keys",
            target: "_blank",
            rel: "noopener noreferrer",
          },
          "Create an API key",
        ),
        ".",
      );
    } else {
      apiKey.placeholder = "sk-ant-…";
      credentialHelp.textContent = "Use an Anthropic API key for embedded OpenClaw.";
    }
    if (credentialSourceTypes !== undefined && !usesOAuth) {
      credentialHelp.textContent = credentialSourceRefused()
        ? "This installation requires a supported model Credential Source and Dedicated provisioning. Choose an authentication method offered by its Credential Gateway."
        : "The selected Secret is registered with this installation's Credential Gateway before deployment. The Harness receives a placeholder instead of the real model key.";
      credentialHelp.hidden = false;
      if (credentialHelp.parentElement !== authSection) {
        authSection.append(credentialHelp);
      }
    }
    apiKey.required = Boolean(passwordAuth && !usesOAuth);
    apiKey.disabled ||= Boolean(savedSecret || binding || usesOAuth || (!passwordAuth && !usesPat));
    startOver.disabled =
      pending ||
      outcomeUnknown ||
      saved ||
      Boolean(savedSecret || savedCredentialSource || credentialRegistration);
    if (useModelChoices) {
      choiceField.hidden = manualModel;
      modelField.hidden = !manualModel;
      model.required = manualModel;
      modelChoice.required = !manualModel;
      toggleModel.textContent = manualModel
        ? "Choose a model from the list"
        : "Enter model ID manually";
      toggleModel.disabled ||= Boolean(savedConfiguration);
    }
    reloadRepositories.disabled = pending || outcomeUnknown;
    startNewDraft.disabled = pending || outcomeUnknown;
    repositories.setDisabled(planLocked || repositoryRetryLocked());
    submit.disabled =
      (!savedAgent &&
        (repositoryRetryLocked() ||
          (requiresRepositories() && !repositories.hasValidSelection()) ||
          !repositories.isSettled() ||
          repositories.blocksCreate())) ||
      pending ||
      outcomeUnknown ||
      !capabilitiesSettled() ||
      permissionsReading ||
      credentialGrantRefused ||
      selectedModeUnavailable() ||
      credentialSourceRefused() ||
      (!savedAgent && (provisioningWaitsForNamespace() || namespaceRefusesAgents())) ||
      Boolean(provisioningAttempt);
    // Create Agent names why it waits: the status line above says so (finding 2007).
    if (
      !savedAgent &&
      capabilitiesSettled() &&
      (namespaceRefusesAgents() || (!selectedModeUnavailable() && provisioningWaitsForNamespace()))
    ) {
      submit.setAttribute("aria-describedby", capabilityStatus.id);
    } else {
      submit.removeAttribute("aria-describedby");
    }
    checkCredentialRegistration.hidden = !credentialRegistration;
    checkCredentialRegistration.disabled = pending;
    removeCredentialRegistration.hidden = !failedCredentialSource;
    removeCredentialRegistration.disabled = pending;
    retryProvisioning.hidden = !provisioningAttempt;
    retryProvisioning.disabled = pending || !provisioningAttempt;
    retryCapabilityDiscovery.hidden =
      !capabilityDiscoveryFailed || (capabilityDiscoveryDenied && !permissionsUnknown);
    retryCapabilityDiscovery.disabled = pending || permissionsReading;
    retryCapabilityDiscovery.textContent = capabilityDiscoveryDenied
      ? "Retry permission check"
      : "Retry capability check";
    submit.hidden = credentialGrantRefused;
    submit.textContent = savedAgent ? "Retry credential access" : "Create Agent";
    submit.setAttribute("aria-busy", createPending ? "true" : "false");
    waitForNamespace();
  };
  // Every way Create's request ends clears its busy state, a navigation away included: the view
  // it leaves may still show as an inert preview.
  const endCreate = () => {
    createPending = false;
    submit.setAttribute("aria-busy", "false");
  };
  // The pressed control disables while its request runs. Keep focus on the line that reports
  // progress, then on the outcome, rather than drop it to the page (finding 1490). Focus the
  // reader moved elsewhere stays there. The line sits below a long form, so bring it into view
  // too: a focused refusal under the fold read as progress (finding 1862).
  function focusFeedbackLine(line: HTMLElement) {
    const active = document.activeElement;
    if (
      line.textContent &&
      (!active ||
        active === document.body ||
        ("disabled" in active && active.disabled) ||
        active === savedStatus ||
        active === feedback)
    ) {
      line.tabIndex = -1;
      line.focus({ preventScroll: true });
      line.scrollIntoView({ block: "nearest" });
    }
  }
  function showSavedStatus() {
    savedStatus.replaceChildren(
      ...[
        [
          savedSecret ? `Secret saved: ${savedSecret.id}.` : "",
          savedCredentialSource ? `Credential Source saved: ${savedCredentialSource.id}.` : "",
          savedConfiguration ? `Configuration saved: ${savedConfiguration.id}.` : "",
          savedAgent ? `Agent saved: ${savedAgent.id}.` : "",
          credentialGrantRefused ? "" : "Retries reuse these resources.",
          "Saved provider and Configuration settings are fixed.",
        ]
          .filter(Boolean)
          .join(" "),
        savedAgent
          ? link(" Open saved Agent", `agents/${savedAgent.id}?revision=draft`, context)
          : null,
      ].filter((node) => node !== null),
    );
  }
  if (savedSecret || savedCredentialSource || savedConfiguration) {
    showSavedStatus();
  }
  renderChannelEditor();
  async function loadInstallationCapabilities() {
    capabilityDiscoveryDone = false;
    capabilityDiscoveryFailed = false;
    capabilityDiscoveryDenied = false;
    capabilitiesUnreadable = false;
    permissionsUnknown = false;
    accessStatus.hidden = true;
    updateControls();
    try {
      const installation = (await request("/installation")) as {
        capabilities?: InstallationCapabilities;
      };
      if (!context.isCurrent()) {
        return;
      }
      pluginDiscoveryCredential =
        installation.capabilities?.pluginDiscovery?.credential ?? "required";
      pluginFields.setCapabilities(installation.capabilities?.pluginPolicies ?? null);
      defaultApprovers.hidden =
        installation.capabilities?.pluginPolicies?.approvers?.agent !== true;
      if (!defaultApprovers.hidden) {
        defaultApprovers.refreshNames();
      }
      nativeWorkersAvailable = installation.capabilities?.nativeWorkers !== undefined;
      const openclawModes = installation.capabilities?.openclaw?.executionModes;
      openclawExecutionModes = Array.isArray(openclawModes) ? new Set(openclawModes) : undefined;
      sandboxDriverUnavailable =
        installation.capabilities?.openclaw?.sandboxDriverUnavailable === true;
      const settingRefusal = installation.capabilities?.openclaw?.settingRefusals?.dedicated;
      dedicatedSettingRefusal =
        typeof settingRefusal === "string" && settingRefusal ? settingRefusal : undefined;
      credentialSourceTypes = installation.capabilities?.credentialSources?.types;
      provisionableExecutionModes.clear();
      for (const executionMode of installation.capabilities?.agentProvisioning?.executionModes ??
        []) {
        provisionableExecutionModes.add(executionMode);
      }
      capabilityDiscoveryDone = true;
      // A mode the form chose but the Installation refuses becomes the usable one, if any.
      if (
        openclawExecutionModes !== undefined &&
        modeDefaulted &&
        harness.value === "openclaw" &&
        !embeddedRequired() &&
        !savedConfiguration &&
        !openclawModeUsable(mode.value) &&
        openclawModeUsable(defaultOpenClawMode())
      ) {
        mode.value = defaultOpenClawMode();
        renderChannelEditor();
      }
    } catch (error) {
      if (!context.isCurrent()) {
        return;
      }
      const { status } = requestFailure(error);
      if (status === 401) {
        context.onExpired();
        return;
      }
      capabilityDiscoveryFailed = true;
      // A denial is permanent for this account, so retrying the read cannot help.
      capabilityDiscoveryDenied = status === 403;
      if (capabilityDiscoveryDenied) {
        settleRefusedCapabilities();
        return;
      }
      capabilityStatus.textContent = `Installation capabilities unavailable. ${message(error)} Retry before creating an Agent.`;
    } finally {
      if (context.isCurrent()) {
        updateControls();
      }
    }
  }
  // After a refused Installation read, the permission answer decides. A member the Namespace lets
  // create Agents goes on without the Installation's capabilities (UX plan A2); only an explicit
  // grant does. A known denial keeps the refusal; an unknown answer says the check failed and
  // offers a retry of it (finding 2110).
  function settleRefusedCapabilities() {
    const create = namespacePermissions?.agents?.create;
    permissionsUnknown = typeof create !== "boolean";
    if (create === true) {
      capabilitiesUnreadable = true;
      accessStatus.hidden = false;
      return;
    }
    capabilityStatus.textContent = permissionsUnknown ? PERMISSIONS_UNREAD : INSTALLATION_REFUSAL;
  }
  async function rereadPermissions() {
    permissionsReading = true;
    capabilityStatus.textContent = "Checking your permissions in this Namespace…";
    updateControls();
    try {
      namespacePermissions = (await request(
        `${namespacePath(namespaceId)}/permissions`,
      )) as Permissions;
      // Start over renders from this context: it keeps the answer instead of asking again.
      context.permissions = namespacePermissions;
    } catch (error) {
      if (context.isCurrent() && requestFailure(error).status === 401) {
        context.onExpired();
        return;
      }
    } finally {
      permissionsReading = false;
    }
    if (!context.isCurrent()) {
      return;
    }
    settleRefusedCapabilities();
    updateControls();
    // The retry hides once answered: its outcome takes focus rather than the page.
    const active = document.activeElement;
    if (
      retryCapabilityDiscovery.hidden &&
      (!active || active === document.body || active === retryCapabilityDiscovery)
    ) {
      const outcome = accessStatus.hidden ? capabilityStatus : accessStatus;
      outcome.tabIndex = -1;
      outcome.focus({ preventScroll: true });
      outcome.scrollIntoView({ block: "nearest" });
    }
  }
  void loadInstallationCapabilities();
  async function submitProvisioningAttempt(attempt: ProvisioningAttempt) {
    // A retry of a job known to have failed. Read before the request: an admitted first
    // attempt also gains a retry URL, and after an unknown outcome the job may have
    // succeeded (recovering), so a refusal there must keep the request ID to recover it.
    const viaRetry = attempt.statusUrl !== undefined;
    const retrying = viaRetry && !outcomeUnknown;
    const recovering = viaRetry && outcomeUnknown;
    pending = true;
    outcomeUnknown = false;
    updateControls();
    feedback.textContent = "";
    let mutationStarted = false;
    try {
      mutationStarted = true;
      const finishing = finishProvisioningAttempt({
        request,
        status: savedStatus,
        namespaceId,
        attempt,
        isCurrent: context.isCurrent,
      });
      focusFeedbackLine(savedStatus);
      const { agentId, revisionId } = await finishing;
      if (!context.isCurrent()) {
        return;
      }
      provisioningAttempt = null;
      repositories.recordSuccessfulSave();
      context.navigate(`agents/${agentId}?revision=${revisionId}&tab=configuration`);
    } catch (cause) {
      const error = {
        ...requestFailure(cause),
        message: cause instanceof Error ? cause.message : "",
      };
      const terminal = cause instanceof ProvisioningFailure ? cause : undefined;
      if (!context.isCurrent()) {
        return;
      }
      if (error.status === 401) {
        context.onExpired();
        return;
      }
      outcomeUnknown =
        mutationStarted && !terminal && ![400, 403, 404, 409, 429].includes(error.status ?? 0);
      // A refused request that names its reason is shown as sent. An outage keeps Retry, since
      // the same request ID cannot duplicate the job, but leads with the reason instead of
      // "Outcome unknown" (finding 1609).
      const reason = namedRefusal(error);
      // The API refuses to retry a job whose Namespace or Agent lifecycle changed, that was
      // cancelled or handed off, or whose Secret was deleted; that job can never finish. A
      // refusal that names its reason is shown as sent; a race in the store can still
      // answer with the generic conflict text, which keeps the fixed sentence.
      const retryRefused = retrying && error.status === 409;
      const retryRefusal =
        error.serverMessage !== undefined && error.serverMessage !== GENERIC_CONFLICT
          ? error.serverMessage
          : "The provisioning job can no longer be retried.";
      let detail;
      if (outcomeUnknown && attempt.statusUrl) {
        detail =
          "Outcome unknown after provisioning admission. Retry resumes the accepted provisioning job, or retries it if it failed. If the API refuses because the job finished, select Create Agent to resend the same request ID.";
      } else if (outcomeUnknown) {
        detail = `${reason ?? "Outcome unknown."} Retry resubmits the same request ID and saved references.`;
      } else if (terminal?.canRetry) {
        detail = `${error.message} Retry uses the accepted provisioning job.`;
      } else if (terminal?.stopped) {
        // A stopped Agent keeps its name and needs a deployment, not a repair or a new Agent.
        detail = `${error.message} Open this Agent and deploy ${terminal.job.revisionId ? "a new version" : "a version"} when you want it running.`;
      } else if (terminal?.agentUnknown) {
        // A Stop keeps the name, so do not only point at a new Agent.
        detail = `${error.message} If the Agent still exists, open it and deploy a version; otherwise select Create Agent to submit a new request.`;
      } else if (terminal?.job.revisionId) {
        detail = `${error.message} Open this Agent, correct the cause and deploy a new version.`;
      } else if (terminal?.failed) {
        detail = `${error.message} Select Create Agent to submit a new request.`;
      } else if (retryRefused) {
        detail = `${retryRefusal} Select Create Agent to submit a new request.`;
      } else if (error.status === undefined && error.message) {
        detail = error.message;
      } else if (recovering && error.status === 409) {
        detail =
          "The provisioning job can no longer be retried; it may have finished. Select Create Agent to resend the same request ID and open its result.";
      } else if (reason !== undefined && error.code !== "NAMESPACE_NOT_READY") {
        detail = reason;
      } else {
        detail = rejectionMessage(cause, mutationStarted);
      }
      const feedbackText = detail + (error.requestId ? ` Request ID: ${error.requestId}` : "");
      // A job that ended keeps its final status; any other progress line spoke for the request
      // that just ended (finding 1490).
      if (!terminal) {
        if (savedSecret || savedConfiguration || savedAgent) {
          showSavedStatus();
        } else {
          savedStatus.textContent = "";
        }
      }
      if (terminal?.stopped) {
        // Not an error: keep the guidance out of the error colour. Later messages replace the span.
        feedback.replaceChildren(
          element("span", { className: "provisioning-stopped" }, feedbackText),
        );
      } else {
        feedback.textContent = feedbackText;
      }
      if (terminal?.job.revisionId && terminal.job.agentId) {
        feedback.append(
          link(
            " Open Agent and deployment details",
            `agents/${terminal.job.agentId}?revision=${terminal.job.revisionId}`,
            context,
          ),
        );
      } else if ((terminal?.stopped || terminal?.agentUnknown) && terminal.job.agentId) {
        feedback.append(link(" Open Agent", `agents/${terminal.job.agentId}`, context));
      }
      focusFeedbackLine(feedback);
      // A 400 to an unacknowledged request means the API never admitted it: a resend of
      // an admitted request returns that job before validation.
      requestAdmitted =
        attempt.acknowledged || outcomeUnknown || (requestAdmitted && error.status !== 400);
      if (!outcomeUnknown && !terminal?.canRetry) {
        provisioningAttempt = null;
        if (terminal?.failed || retryRefused) {
          // The failed job keeps this request ID; an edited form needs a new one.
          provisioningRequestId = createClientRequestId();
          requestAdmitted = false;
        }
      }
      // A job that names its Agent created one, which a kept draft must not create again.
      if (!terminal?.job.agentId) {
        keepDraftAfterRefusal();
      }
    } finally {
      if (context.isCurrent()) {
        pending = false;
        updateControls();
      }
    }
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    // A restored draft sets the name and files without an input event.
    checkName();
    // The Workspace tab's check, naming the file; validateFields opens Advanced settings to it
    // (finding 2341).
    for (const [filename, input] of workspaceInputs) {
      input.setCustomValidity(workspaceFileProblem(filename, input.value));
    }
    if (
      pending ||
      outcomeUnknown ||
      provisioningAttempt ||
      credentialGrantRefused ||
      (!savedAgent && repositoryRetryLocked()) ||
      !capabilitiesSettled() ||
      selectedModeUnavailable() ||
      credentialSourceRefused() ||
      (!savedAgent && (provisioningWaitsForNamespace() || namespaceRefusesAgents())) ||
      // The console's own errors under each field, not the browser's bubble (UX plan C3).
      !validateFields([...form.elements])
    ) {
      return;
    }
    const values = parseObject(configuration, true);
    // Stop at the Configuration JSON message so the plugin field's bubble cannot take its focus.
    if (values === undefined) {
      return;
    }
    const desiredPlugins = parseObject<Record<string, unknown>>(plugins, true);
    const bindings = configurationSecretBindings;
    if (values === undefined || desiredPlugins === undefined) {
      return;
    }
    if (!savedAgent && !repositories.validate({ required: requiresRepositories() })) {
      return;
    }
    if (!model.value.trim()) {
      feedback.textContent =
        "Choose an available model or enter a model ID before creating the Agent.";
      return;
    }
    const selected = configuredModelSelection(values);
    const primaryModel = modelPrimary(selected);
    const fallbackPrefixes =
      harness.value === "codex" ? ["openai/", "codex/"] : [`${nativeProvider.value}/`];
    // Bound Codex Presets may use either supported provider prefix; OpenClaw keeps its provider.
    const primaryPrefixes = hasBoundModelCredential
      ? fallbackPrefixes
      : [harness.value === "codex" ? "codex/" : `${nativeProvider.value}/`];
    if (
      (!binding || hasBoundModelCredential) &&
      !primaryPrefixes.some((prefix) => primaryModel === `${prefix}${model.value.trim()}`)
    ) {
      feedback.textContent =
        "Configuration must use the selected provider and model. Update the JSON or reset the template before saving.";
      focusConfiguration();
      return;
    }
    if (
      (!binding || hasBoundModelCredential) &&
      typeof selected === "object" &&
      Array.isArray(selected.fallbacks) &&
      selected.fallbacks.some(
        (ref) =>
          typeof ref !== "string" ||
          !fallbackPrefixes.some((value) => ref.startsWith(value) && ref.length > value.length),
      )
    ) {
      feedback.textContent =
        "Fallback models must use the selected provider and execution mode. Update the Configuration JSON or reset the template before saving.";
      focusConfiguration();
      return;
    }
    if (
      ["codex_pat", "credential_source"].includes(binding?.method ?? authMethod.value) &&
      (nativeProvider.value !== "openai" || harness.value !== "codex" || mode.value !== "dedicated")
    ) {
      feedback.textContent =
        "Service account tokens and ChatGPT OAuth (Experimental) require OpenAI with the Codex harness and Dedicated execution. Update the Configuration JSON or reset the template before saving.";
      return;
    }
    if (nativeProvider.value === "anthropic" && mode.value !== "embedded") {
      feedback.textContent =
        "Anthropic requires Embedded execution. Update the execution mode or choose OpenAI.";
      return;
    }
    if (mode.value === "embedded" && hasEnabledChannel(values)) {
      feedback.textContent =
        "Channels require Dedicated execution. Select Dedicated under Runtime details or disable configured channels before creating the Agent.";
      return;
    }
    const repositoryBindings = repositories.bindings();
    const body = {
      name: name.value.trim(),
      executionMode: mode.value,
      initialWorkspaceFiles: Object.fromEntries(
        workspaceInputs.map(([filename, input]) => [filename, input.value]),
      ),
      workspaceDefaultsId: WORKSPACE_DEFAULTS_ID,
      repositoryAccess: repositories.access(),
      ...(Object.keys(desiredPlugins).length ? { plugins: desiredPlugins } : {}),
      ...(pluginApprovers === undefined ? {} : { pluginApprovers }),
      ...(agent.backendId ? { backendId: agent.backendId } : {}),
    };
    const usesOAuth = (binding?.method ?? authMethod.value) === "credential_source";
    if (
      !binding &&
      (!passwordAuth || usesOAuth) &&
      modelCredentialSource?.kind !== (usesOAuth ? "credential_source" : "secret")
    ) {
      feedback.textContent = usesOAuth
        ? "Complete ChatGPT sign-in before creating the Agent."
        : "Choose a model credential Secret before creating the Agent.";
      return;
    }
    pending = true;
    createPending = true;
    updateControls();
    feedback.textContent = "";
    // Before anything is saved, ask the API whether Agent create would refuse these plugin
    // selections or initial workspace files with this Configuration. A refusal then leaves the
    // whole form editable, the Configuration included, instead of a saved Configuration this
    // form can no longer change (finding 1863). Provisioning admits its plan in one request
    // before it saves a Configuration, with its own rules, so it needs no preflight.
    if (!shouldProvision() && !savedConfiguration && !savedAgent) {
      try {
        await request(`${namespacePath(namespaceId)}/agents/validate`, {
          method: "POST",
          expectedStatus: 204,
          body: {
            configuration: { kind: "agent", values },
            executionMode: body.executionMode,
            initialWorkspaceFiles: body.initialWorkspaceFiles,
            ...(body.plugins ? { plugins: body.plugins } : {}),
            ...(body.pluginApprovers ? { pluginApprovers: body.pluginApprovers } : {}),
          },
        });
      } catch (error) {
        endCreate();
        if (!context.isCurrent()) {
          return;
        }
        const failure = requestFailure(error);
        if (failure.status === 401) {
          context.onExpired();
        } else {
          const detail =
            error instanceof Error && error.name === "TimeoutError"
              ? "The configuration check timed out. Your entries are still here. Try Create Agent again."
              : rejectionMessage(error);
          feedback.textContent =
            detail + (failure.requestId ? ` Request ID: ${failure.requestId}` : "");
          // While the pressed control is still disabled, as after a save.
          focusFeedbackLine(feedback);
        }
        pending = false;
        updateControls();
        return;
      }
      if (!context.isCurrent()) {
        endCreate();
        return;
      }
    }
    context.setDraftCapture(null);
    let mutationStarted = false;
    let creatingSecret = false;
    try {
      if (passwordAuth && !usesOAuth && !savedSecret) {
        mutationStarted = true;
        creatingSecret = true;
        const result = await request(`${namespacePath(namespaceId)}/secrets`, {
          method: "POST",
          expectedStatus: 201,
          body: { name: body.name, value: apiKey.value },
        });
        apiKey.value = "";
        const secret = secretMetadata(result, namespaceId, body.name);
        if (!secret) {
          throw new Error("The create response did not identify the requested Secret.");
        }
        savedSecret = secret;
        creatingSecret = false;
        apiKey.required = false;
        if (!context.isCurrent()) {
          return;
        }
        showSavedStatus();
      }
      const selectedCredentialSource =
        passwordAuth && !usesOAuth ? savedSecret?.ref : modelCredentialSource;
      let harnessAuth = binding ?? selectedHarnessAuth(authMethod.value, selectedCredentialSource);
      if (credentialSourceTypes !== undefined && !usesOAuth) {
        if (!savedCredentialSource) {
          const type = modelSourceType();
          const secret = "source" in harnessAuth ? harnessAuth.source : undefined;
          const field = type?.secrets[0]?.name;
          if (!type || !field || secret?.kind !== "secret") {
            throw new Error(
              "Choose a supported model credential Secret before creating the Agent.",
            );
          }
          credentialRegistration ??= {
            name: `${body.name.slice(0, 150)} model ${provisioningRequestId}`,
            type: type.type,
            secrets: { [field]: secret },
          };
          mutationStarted = true;
          const result = await request(`${namespacePath(namespaceId)}/credential-sources`, {
            method: "POST",
            expectedStatus: 201,
            body: credentialRegistration,
          });
          if (!context.isCurrent()) {
            return;
          }
          const source = credentialRegistrationResult(result, namespaceId, credentialRegistration);
          if (source?.state !== "ready") {
            throw new Error(
              "The response did not confirm that the requested Credential Source is ready.",
            );
          }
          savedCredentialSource = source;
          credentialRegistration = null;
          failedCredentialSource = null;
          showSavedStatus();
        }
        harnessAuth = { method: "credential_source", sourceId: savedCredentialSource.id };
      }
      if (shouldProvision()) {
        provisioningAttempt = {
          acknowledged: false,
          body: {
            requestId: provisioningRequestId,
            ...body,
            harnessAuth,
            configuration: {
              kind: "agent",
              values,
              ...(Object.keys(bindings).length ? { secretBindings: bindings } : {}),
            },
          },
        };
        await submitProvisioningAttempt(provisioningAttempt);
        return;
      }
      let credentialSources = agent.credentialSources as
        readonly AgentCredentialSourceBinding[] | undefined;
      if (harnessAuth.method === "credential_source") {
        const { sourceId } = harnessAuth;
        if (!credentialSources?.some((source) => source.sourceId === sourceId)) {
          credentialSources = [...(credentialSources ?? []), { sourceId }];
        }
      }
      if (!savedConfiguration) {
        mutationStarted = true;
        // Compare the values JSON can transmit, including -0 serialized as 0.
        const submittedValues: unknown = JSON.parse(JSON.stringify(values));
        const result = await request(`${namespacePath(namespaceId)}/configurations`, {
          method: "POST",
          expectedStatus: 201,
          body: {
            kind: "agent",
            values: submittedValues,
            ...(Object.keys(bindings).length ? { secretBindings: bindings } : {}),
          },
        }).catch((error: unknown) => {
          if (requestFailure(error).status === 403) {
            responseFields(error).refusal = CONFIGURATION_CREATE_REFUSAL;
          }
          throw error;
        });
        if (!context.isCurrent()) {
          return;
        }
        const created = responseFields(result);
        // The API stores these values unchanged and makes the default Secret delivery explicit.
        const secretBindings = Object.fromEntries(
          Object.entries(bindings).map(([key, binding]) => [
            key,
            { ...binding, delivery: binding.delivery ?? { type: "env" as const } },
          ]),
        );
        if (
          typeof created.id !== "string" ||
          !created.id.trim() ||
          created.namespaceId !== namespaceId ||
          created.kind !== "agent" ||
          created.generation !== 1 ||
          !sameValue(created.values, submittedValues) ||
          !sameValue(created.secretBindings ?? {}, secretBindings)
        ) {
          throw new Error("The create response did not confirm the submitted Configuration.");
        }
        savedConfiguration = { id: created.id, secretBindings };
        showSavedStatus();
        renderChannelEditor();
      }
      let createdServicePrincipalId: string | undefined;
      if (!savedAgent) {
        mutationStarted = true;
        const created = responseFields(
          await request(`${namespacePath(namespaceId)}/agents`, {
            method: "POST",
            expectedStatus: 201,
            body: {
              ...body,
              harnessAuth,
              credentialSources,
              configurationId: savedConfiguration.id,
            },
          }),
        );
        // The next step grants this principal access to the selected Secrets. Confirm the
        // response belongs to this create before using it, and leave an uncertain write locked.
        const { id, servicePrincipalId } = created;
        if (
          created.namespaceId !== namespaceId ||
          created.name !== body.name ||
          created.configurationId !== savedConfiguration.id ||
          typeof id !== "string" ||
          !id.trim() ||
          typeof servicePrincipalId !== "string" ||
          !servicePrincipalId.trim()
        ) {
          throw new Error("The Agent creation response did not identify the expected Agent.");
        }
        savedAgent = { id, name: body.name, configurationId: savedConfiguration.id };
        createdServicePrincipalId = servicePrincipalId;
        repositories.recordSuccessfulSave();
        if (!context.isCurrent()) {
          return;
        }
        showSavedStatus();
      }
      // Grant retries reread exact bindings, so uncertain model or channel grants never recreate the Agent.
      mutationStarted = false;
      const credential =
        savedSecret ??
        modelCredentialSecret ??
        presetExistingSecret ??
        (boundSource?.kind === "secret" ? boundSource : undefined);
      const modelSecret = credential && "ref" in credential ? credential.ref : credential;
      const modelGrant: CredentialReference | undefined =
        harnessAuth.method === "credential_source"
          ? { kind: "credential_source", namespaceId, id: harnessAuth.sourceId }
          : modelSecret?.kind === "secret"
            ? modelSecret
            : undefined;
      const needsCredentialAccess =
        modelGrant ||
        Object.values(savedConfiguration.secretBindings ?? {}).some(
          (binding) => binding?.source?.kind === "secret",
        );
      if (needsCredentialAccess) {
        if (context.installationAdmin === false) {
          credentialGrantRefused = true;
          feedback.textContent = MEMBER_GRANT_REFUSED;
          focusFeedbackLine(feedback);
          return;
        }
        // IAM binds a credential to a principal, not to an Agent ID. Confirm the principal on
        // the saved Agent before granting access. An explicit retry reads that same Agent again;
        // it never reuses a principal from a create response we could not confirm.
        const agentPath = `${namespacePath(namespaceId)}/agents/${encodeURIComponent(savedAgent.id)}`;
        const current = responseFields(await request(agentPath, { expectedStatus: 200 }));
        if (!context.isCurrent()) {
          return;
        }
        const { servicePrincipalId } = current;
        if (
          current.id !== savedAgent.id ||
          current.namespaceId !== namespaceId ||
          current.name !== savedAgent.name ||
          current.configurationId !== savedAgent.configurationId ||
          current.status !== "active" ||
          typeof servicePrincipalId !== "string" ||
          !servicePrincipalId.trim() ||
          (createdServicePrincipalId !== undefined &&
            servicePrincipalId !== createdServicePrincipalId)
        ) {
          feedback.textContent =
            "The Agent was saved, but its service principal could not be confirmed. This attempt did not grant credential access. Select Retry credential access to check the saved Agent again.";
          focusFeedbackLine(feedback);
          return;
        }
        const grantAgent = { servicePrincipalId };
        if (modelGrant) {
          await ensureCredentialOperateBinding(context, grantAgent, modelGrant);
        }
        await grantConfigurationSecretAccess(grantAgent, stagedChannelSecrets, savedConfiguration);
      }
      if (context.isCurrent()) {
        context.navigate(`agents/${savedAgent.id}?revision=draft`);
      }
    } catch (cause) {
      const error = requestFailure(cause);
      const knownRejection = [400, 403, 404, 409, 429].includes(error.status ?? 0);
      outcomeUnknown = mutationStarted && !knownRejection && error.status !== 401;
      if (creatingSecret && (outcomeUnknown || !context.isCurrent() || error.status === 401)) {
        apiKey.value = "";
      }
      if (!context.isCurrent()) {
        return;
      }
      if (error.status === 401) {
        context.onExpired();
        return;
      }
      const registrationProblem = error.status && error.status >= 400 ? ` ${message(cause)}` : "";
      const detail = credentialRegistration
        ? `Credential Source registration could not be confirmed.${registrationProblem} Check credential registration before retrying; the selected Secret remains saved.`
        : savedAgent
          ? `The Agent was created, but credential access is not confirmed. ${message(cause)} Retry credential access, or open the saved Agent and ask an administrator to check access to its saved model and channel Secrets.`
          : error.status === 409 && creatingSecret && error.code !== "NAMESPACE_NOT_READY"
            ? `A Secret named "${body.name}" already exists in this Namespace, possibly from an earlier Agent with this name. Choose another Agent name, delete that Secret, or select Start over, choose the Preset again, and set its Secret source to Use existing Secret.`
            : error.status === 409 && savedConfiguration && error.code !== "NAMESPACE_NOT_READY"
              ? error.serverMessage === AGENT_NAME_CONFLICT
                ? AGENT_NAME_CONFLICT
                : "Agent creation conflicts with the saved state. Check the Agent name and selections, then try again."
              : rejectionMessage(cause, mutationStarted);
      if (!savedAgent && savedConfiguration && knownRejection) {
        if (repositoryBindings.length) {
          requireRepositoryReload();
        } else {
          rejectedAgentAttempt = { kind: "ordinary" };
        }
        if (rejectedAgentAttempt?.kind === "repository-scoped") {
          recoveryMessage.textContent = `Repository-scoped Agent creation returned a known rejection. Configuration ${savedConfiguration.id} remains saved. Reload current repository choices to refresh policy before retrying, or start a new draft. Starting a new draft does not delete this Configuration.`;
          recovery.hidden = false;
        } else {
          recovery.hidden = true;
        }
      } else if (outcomeUnknown) {
        rejectedAgentAttempt = undefined;
        recovery.hidden = true;
      }
      // A plugin refusal's own fixes edit the Configuration or move the Agent, and this form can
      // no longer edit the Configuration it saved. Name the fix that works here (finding 1863).
      const refusedPlugin =
        !savedAgent && savedConfiguration && error.status === 400 && error.serverMessage
          ? Object.keys(body.plugins ?? {})
              .filter((id) => error.serverMessage?.includes(`plugin ${id}`))
              .sort((a, b) => b.length - a.length)[0]
          : undefined;
      const guidance =
        savedConfiguration && refusedPlugin
          ? ` This form cannot edit saved Configuration ${savedConfiguration.id}. Deselect plugin ${refusedPlugin} under Plugins and select Create Agent again; to use the plugin, fix the setting on the new Agent's Configuration tab, then select the plugin on its Plugins tab.`
          : "";
      // A member's grant of the new Agent's credential access is refused as Installation
      // administration: name who finishes it (UX plan A2), and offer no retry of it (finding 2109).
      const memberGrantRefused =
        Boolean(savedAgent) &&
        !credentialRegistration &&
        capabilitiesUnreadable &&
        error.status === 403;
      credentialGrantRefused ||= memberGrantRefused;
      feedback.textContent =
        (memberGrantRefused ? MEMBER_GRANT_REFUSED : detail) +
        guidance +
        (error.requestId ? ` Request ID: ${error.requestId}` : "");
      focusFeedbackLine(feedback);
      keepDraftAfterRefusal();
    } finally {
      endCreate();
      if (context.isCurrent()) {
        pending = false;
        if (credentialGrantRefused) {
          showSavedStatus();
          renderChannelEditor();
        }
        updateControls();
      }
    }
  });
  view.replaceChildren(
    ...(notReadyNote ? [notReadyNote] : []),
    element(
      "p",
      { className: "muted" },
      "Choose a model and repository access. Add Slack when you want this Agent to work with your team.",
    ),
    accessStatus,
    form,
    channelEditor,
    // The outcome leads; the saved-resources line identifies what was kept (finding 1862).
    feedback,
    savedStatus,
    recovery,
    actions,
  );
  context.setDraftCapture(captureDraft, unsavedDraft);
  context.drafts.forget("preset");
  context.setDiscardOnExit(false);
}
