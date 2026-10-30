import { createHash, randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { asRecord } from "@openclaw-enterprise/utils";
import type {
  EgressInstallation,
  ProxyRevisionContext,
  RepositoryGitRecipient,
} from "@openclaw-enterprise/contracts";
import type {
  OpenShellGatewayClient,
  OpenShellSandboxResponse,
} from "../sandbox/openshell-gateway-client.ts";
import type { OpenShellPreparedGitInstalled } from "./openshell-prepared-git-provider.ts";
import type { OpenShellOnlineHttpRequest } from "./openshell-online-authority.ts";
import { wirePolicy } from "./openshell-wire-policy.ts";

export const observedRequestHook = "request-hook-observed" as const;
export const observedHookPath = "/oce-observe-request/";
type Hook = NonNullable<RepositoryGitRecipient["observedHook"]>;

interface Selection {
  readonly mandatory?: true;
  readonly client: OpenShellGatewayClient;
  readonly sandbox: OpenShellSandboxResponse;
  readonly observed: OpenShellPreparedGitInstalled;
  readonly registration: string;
  readonly audience: string;
  readonly modelProvider: string;
  readonly gitRule: { name: string; endpoints: readonly Record<string, unknown>[] };
  readonly workload: (sandboxId: string, signal: AbortSignal) => Promise<string | undefined>;
  readonly signal: AbortSignal;
}

/** A stock provider adds its rule after source admission. Check the effective Git rule and
 * every other reachable host. The authenticated generation also covers fields outside this projection. */
function expectedPolicy(
  source: Record<string, unknown>,
  effective: Record<string, unknown>,
  git: Selection["gitRule"],
  modelProvider: string,
  runtimeProvider: string,
) {
  const { network_policies: desired, ...staticPolicy } = source;
  const { network_policies: network, ...applied } = effective;
  if (!isDeepStrictEqual(wirePolicy(staticPolicy), wirePolicy(applied))) {
    return false;
  }
  const { [git.name]: rule, ...others } = asRecord(network) ?? {};
  // Stock 0.1.5 retains the imported port and marks each endpoint provider_credentialed.
  // Compare the entire rule; accepting another rule because it names port 443 is not enough.
  if (!rule || !isDeepStrictEqual(wirePolicy(rule), wirePolicy(git))) {
    return false;
  }
  // Only literal non-Git hosts, including the independently admitted model provider.
  // A wildcard, numeric address, L4 default route or another Git-capable rule refuses preview.
  const modelName = "_provider_" + modelProvider.replaceAll("-", "_");
  // Even the endpointless runtime-files provider gets a named, empty rule in stock 0.1.5.
  const runtimeName = "_provider_" + runtimeProvider.replaceAll("-", "_");
  const { [modelName]: model, [runtimeName]: runtime, ...sourceRules } = others;
  if (
    !model ||
    !isDeepStrictEqual(wirePolicy(runtime), { name: runtimeName }) ||
    !isDeepStrictEqual(wirePolicy(sourceRules), wirePolicy(desired ?? {}))
  ) {
    return false;
  }
  for (const raw of Object.values(others)) {
    const endpoints = asRecord(raw)?.endpoints ?? [];
    if (
      !Array.isArray(endpoints) ||
      endpoints.some((raw) => {
        const e = asRecord(raw);
        const host = e?.host;
        return (
          typeof host !== "string" ||
          !/^[a-z0-9-]+(?:[.][a-z0-9-]+)+$/i.test(host) ||
          !/[a-z]/i.test(host.split(".").at(-1)!) ||
          /(?:^|[.])github[.]com$/i.test(host) ||
          (Array.isArray(e?.allowed_ips) && e.allowed_ips.length > 0)
        );
      })
    ) {
      return false;
    }
  }
  return true;
}

/** The operator must actually isolate the gateway and all sandbox/provider writers. Neither
 * an empty membership list nor any observation below is a lock against an operator change. */
export async function previewPolicyAndRecipient({
  client,
  sandbox,
  observed: o,
  registration,
  audience,
  gitRule,
  modelProvider,
  workload,
  signal,
  mandatory,
}: Selection): Promise<string | undefined> {
  const admission = sandbox.configurationAdmission;
  const started = sandbox.mainProcessStartedAt;
  if (
    !admission ||
    !started ||
    !Number.isFinite(Date.parse(started)) ||
    !sandbox.id ||
    sandbox.workspace !== o.workspace ||
    sandbox.id !== o.sandboxId ||
    sandbox.mainProcessInstanceId !== o.networkInstanceId ||
    admission.state !== 2 ||
    admission.error ||
    !admission.instance_id ||
    admission.policy_hash !== o.policyHash ||
    admission.config_revision !== o.configRevision ||
    admission.provider_env_revision !== o.providerEnvRevision ||
    (!mandatory && !(await client.readExclusivePreviewWorkspace?.(o.workspace, sandbox.id, signal)))
  ) {
    return;
  }
  const c = await client.getSandboxConfig?.(o.workspace, sandbox.name, signal);
  const policy = asRecord(c?.policy);
  const source = asRecord(sandbox.spec?.policy);
  // The paired Sandbox already verified this entire spec. Select only its actual model,
  // endpointless runtime files, and revision-private Git provider, in their emitted order.
  const providers = sandbox.spec?.providers;
  if (!Array.isArray(providers) || providers.length !== 3) {
    return;
  }
  const [modelProviderName, runtimeProvider, gitProvider] = providers;
  if (
    modelProviderName !== modelProvider ||
    gitProvider !== o.provider ||
    typeof runtimeProvider !== "string" ||
    !/^oce-runtime-[a-f0-9]{16}$/.test(runtimeProvider) ||
    !c ||
    !policy ||
    !source ||
    !expectedPolicy(source, policy, gitRule, modelProvider, runtimeProvider) ||
    c.version !== admission.policy_version ||
    c.workspace !== o.workspace ||
    c.configuration_instance_id !== admission.instance_id ||
    c.policy_source !== 1 ||
    c.global_policy_version ||
    c.configuration_admitted !== true ||
    c.configuration_error ||
    c.policy_validation_failure_mode !== "fail_closed" ||
    c.extension_authentication_enabled !== true ||
    c.provider_attachment_epoch !== o.attachmentEpoch ||
    sandbox.spec?.provider_attachment_epoch !== o.attachmentEpoch ||
    c.policy_hash !== o.policyHash ||
    c.config_revision !== o.configRevision ||
    c.provider_env_revision !== o.providerEnvRevision
  ) {
    return;
  }
  const services = c.supervisor_middleware_services;
  const selected = Array.isArray(services)
    ? services.filter((s) => asRecord(s)?.name === registration)
    : [];
  const service = selected.length === 1 && asRecord(selected[0]);
  // Legacy observed-only registrations omit both fields. Absence proves no mandatory
  // support: strict grants never use it, and explicit/partial values cannot fall back.
  // The recipient fingerprint below fences changes after the registration is witnessed.
  const legacyObserved =
    !mandatory &&
    service &&
    !Object.hasOwn(service, "binding_policy") &&
    !Object.hasOwn(service, "bindings");
  // Stock defaults to 500 ms: enough for the deliberate denial, not for the full
  // per-request recheck. Qualify the operator's five-second RPC timeout; OCE still caps
  // its decision at three seconds and never retries a possible authorization commitment.
  const timeout = asRecord(service && service.request_timeout);
  if (
    !service ||
    (!legacyObserved &&
      (![2, 3].includes(service.binding_policy as number) ||
        !Array.isArray(service.bindings) ||
        service.bindings.length !== 1 ||
        service.bindings[0] !== 1)) ||
    service.name !== registration ||
    service.allow_insecure_transport ||
    timeout?.seconds !== "5" ||
    timeout.nanos ||
    service.audience !== audience ||
    !String(service.grpc_endpoint).startsWith("https://")
  ) {
    return;
  }
  const pods = await workload(sandbox.id, signal);
  if (!pods) {
    return;
  }
  // Omit only the three fields necessarily changed by installing the token. Everything else,
  // including process, network, supervisor session, loaded effective policy, configuration
  // instance, actual Pod UIDs/container IDs, and admitted extension registration, must stay.
  const {
    providerEnvRevision: _env,
    providerResourceVersion: _version,
    credentialState: _state,
    observedHook: _hook,
    ...identity
  } = o;
  return createHash("sha256")
    .update(
      JSON.stringify([
        identity,
        started,
        admission.instance_id,
        wirePolicy(policy),
        wirePolicy(service),
        pods,
      ]),
    )
    .digest("hex");
}

/** A one-use challenge can return only a denial. The response secret is not given to the
 * launcher or put on the wire until the authenticated middleware presents the exact request. */
export class ObservedHookPreview {
  readonly workspace: string;
  readonly bindingId: string;
  readonly opened = Date.now();
  private armed?: {
    startupId: string;
    path: string;
    reason: string;
    until: number;
    requestId?: string;
  };
  hook?: Hook;
  recipient?: string;
  bootstrapRevision?: string;
  /** A local deadline to stop and retire, never a lease or an authorization deadline. */
  verifyInstallBy?: number | undefined;
  release?: "sending" | "acknowledged";

  private modelOperation?: { revision: string; id?: string; complete?: true };

  /** Establish the independent model observation only in the route owner, never in verification.
   * Stock may complete the operation on this request. The launch witness reads it only afterward. */
  async completedModelReceipt(
    client: OpenShellGatewayClient,
    git: OpenShellPreparedGitInstalled,
    model: string,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    if (this.modelOperation?.revision !== git.providerEnvRevision) {
      this.modelOperation = { revision: git.providerEnvRevision };
    }
    const op = this.modelOperation;
    if (!op.complete) {
      const status = await client.getSandboxProviderStatus(
        git.workspace,
        git.sandbox,
        model,
        signal,
        op.id,
      );
      const id = status.receipt?.receiptId;
      if (
        !id ||
        (op.id && op.id !== id) ||
        status.receipt?.kind !== "PROVIDER_MUTATION_KIND_OBSERVE" ||
        status.receipt.desired?.providerEnvRevision !== op.revision
      ) {
        return;
      }
      op.id = id;
      if (status.completedOperationId !== id) {
        return;
      }
      op.complete = true;
    }
    return op.id;
  }

  readonly mandatory: boolean;
  constructor(workspace: string, bindingId: string, mandatory = false) {
    this.mandatory = mandatory;
    this.workspace = workspace;
    this.bindingId = bindingId;
  }
  arm(startupId: string) {
    if (this.armed || !this.recipient || !this.bootstrapRevision) {
      throw new Error("Preview challenge is not fresh.");
    }
    const path = observedHookPath + randomBytes(16).toString("hex") + ".git/info/refs";
    this.armed = {
      startupId,
      path,
      reason: "oce_hook_" + randomBytes(18).toString("hex"),
      until: Date.now() + 30_000,
    };
    return path;
  }
  deny(q: OpenShellOnlineHttpRequest, sandboxId: string) {
    const a = this.armed;
    const t = q.target;
    if (
      !a ||
      a.requestId ||
      Date.now() >= a.until ||
      q.sandboxId !== sandboxId ||
      q.workspace !== this.workspace ||
      q.bindingId !== this.bindingId ||
      t.reportedScheme !== "https" ||
      t.host !== "github.com" ||
      t.port !== 443 ||
      t.method !== "GET" ||
      t.path !== a.path ||
      t.query !== "service=git-upload-pack" ||
      q.body.length ||
      q.headers.some(([k]) =>
        ["authorization", "proxy-authorization", "cookie"].includes(k.toLowerCase()),
      )
    ) {
      return;
    }
    a.requestId = q.requestId;
    return a.reason;
  }
  confirm(result: unknown) {
    const a = this.armed;
    const r = asRecord(result);
    if (
      this.hook ||
      !a?.requestId ||
      Date.now() >= a.until ||
      r?.startupId !== a.startupId ||
      r.probePath !== a.path ||
      r.reasonCode !== a.reason
    ) {
      throw new Error("The held launcher did not receive its exact middleware denial.");
    }
    this.hook = {
      startupId: a.startupId,
      observationId: createHash("sha256")
        .update(JSON.stringify([this.bindingId, this.recipient, this.bootstrapRevision, a]))
        .digest("hex"),
    };
  }
  enforcement(
    context: ProxyRevisionContext,
    i: OpenShellPreparedGitInstalled,
  ): EgressInstallation["enforcement"] | undefined {
    const { hook, recipient } = this;
    if (
      !hook ||
      !recipient ||
      context.plan.repositoryGitAuthorization !== observedRequestHook ||
      context.plan.execution.executionId !== this.bindingId ||
      i.workspace !== this.workspace ||
      !isDeepStrictEqual(hook, i.observedHook)
    ) {
      return;
    }
    const { providerId, attachmentEpoch, processInstanceId, networkInstanceId } = i;
    return {
      instanceId: networkInstanceId,
      policyHash: i.policyHash,
      authorityScope: "execution",
      configurationId: recipient,
      repositoryGitRecipient: {
        providerId,
        attachmentEpoch,
        processInstanceId,
        networkInstanceId,
        authorization: observedRequestHook,
        observedHook: hook,
        deliveryProfile: "github_installation",
      },
    };
  }
}
