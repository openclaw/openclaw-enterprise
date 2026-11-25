import { gatewayRoutingHostname } from "../compute/kubernetes/gateway-routing-hostname.ts";
import { managedNamespaceName } from "../compute/kubernetes/namespace-name.ts";
import type {
  KubernetesGatewayRoutingOptions,
  KubernetesWorkloadPeer,
} from "../compute/kubernetes/index.ts";
import { lookup } from "node:dns/promises";
import {
  executionRelease,
  launcherStatus,
  type Readiness,
  verifyExecutionRelease,
} from "./strands-box-release.ts";
import { observedMaterialVersion } from "../credential-proxy/strands-box.ts";
import { X509Certificate } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { checkServerIdentity } from "node:tls";
import { isDeepStrictEqual } from "node:util";
import { createKubernetesClientConfiguration } from "../kubernetes/client.ts";
import { networkPolicyToSdk } from "../kubernetes/network-policy.ts";
import type { KubernetesAuthentication } from "../kubernetes/authentication.ts";
import { requireWorkspaceSetupConfiguration } from "../compute/workspace-setup-runtime.ts";
import { withComputeAbortSignal } from "../compute/operation-context.ts";
import {
  stockModelDelivery,
  STOCK_RESPONSES_POLICY,
  validateStockRevision,
  validStockConfiguration,
} from "./strands-box-model.ts";
import {
  strandsBoxResources,
  strandsBoxService,
  STRANDS_STATUS_PORT,
} from "./strands-box-resources.ts";
import { KubernetesObjectApi, PatchStrategy, type KubernetesObject } from "@kubernetes/client-node";
import { isIP } from "node:net";
import { requireConfiguration } from "@openclaw-enterprise/contracts";
import type {
  AgentRevision,
  CredentialDeploymentContext,
  CredentialDeploymentConfiguration,
  CredentialDeploymentTarget,
  CredentialProjection,
  ErrorDetail,
  OpenClawConfigurationDocument,
  RevisionHarnessDescriptor,
  SandboxDriver,
  SandboxHarnessContext,
  SandboxHarnessEndpoint,
  SandboxHarnessObservation,
  SandboxHarnessStatus,
  SandboxHarnessStatusContext,
  SandboxLogContext,
  SandboxNamespaceContext,
  SandboxPolicyObservation,
  SandboxPolicySnapshot,
  SandboxResourceRef,
} from "@openclaw-enterprise/contracts";
import {
  ActivationPendingError,
  DependencyUnavailableError,
  SandboxRevisionUnsupportedError,
  SandboxWorkspaceSetupRefusedError,
  TransientDependencyError,
} from "@openclaw-enterprise/occ";
import {
  asRecord,
  sha256Hex,
  immutableCopy,
  validateWorkspaceNodeSetupSecret,
} from "@openclaw-enterprise/utils";
import { setTimeout as delay } from "node:timers/promises";

export interface StrandsBoxOptions {
  readonly kubernetes: {
    readonly seccompProfile: string;
    readonly stockLauncher?: {
      readonly namespace: string;
      readonly agentGrants?: readonly {
        readonly profile: "openai-responses";
        readonly agentId: string;
        readonly sourceId: string;
      }[];
    };
    readonly nodeSelector: Readonly<Record<string, string>>;
    readonly controlPlanePeer: {
      readonly namespace: string;
      readonly podLabels: Readonly<Record<string, string>>;
    };
  };
  readonly policy: {
    readonly network: {
      readonly endpoints: readonly { readonly host: string; readonly ports: readonly number[] }[];
    };
  };
}

export const configurationSchema = Object.freeze({
  type: "object",
  required: ["kubernetes", "policy"],
  additionalProperties: false,
  properties: {
    kubernetes: {
      type: "object",
      required: ["seccompProfile", "nodeSelector", "controlPlanePeer"],
      additionalProperties: false,
      properties: {
        stockLauncher: {
          type: "object",
          additionalProperties: false,
          required: ["namespace"],
          properties: {
            namespace: { type: "string", minLength: 1, maxLength: 63 },
            agentGrants: {
              type: "array",
              minItems: 1,
              maxItems: 1,
              items: {
                type: "object",
                required: ["profile", "agentId", "sourceId"],
                additionalProperties: false,
                properties: {
                  profile: { type: "string", enum: ["openai-responses"] },
                  agentId: { type: "string", minLength: 1 },
                  sourceId: { type: "string", minLength: 1 },
                },
              },
            },
          },
        },
        seccompProfile: { type: "string", minLength: 1, maxLength: 240 },
        controlPlanePeer: {
          type: "object",
          required: ["namespace", "podLabels"],
          additionalProperties: false,
          properties: {
            namespace: { type: "string", minLength: 1 },
            podLabels: {
              type: "object",
              minProperties: 1,
              additionalProperties: { type: "string", minLength: 1 },
            },
          },
        },
        nodeSelector: {
          type: "object",
          minProperties: 1,
          additionalProperties: { type: "string", minLength: 1 },
        },
      },
    },
    policy: {
      type: "object",
      required: ["network"],
      additionalProperties: false,
      properties: {
        network: {
          type: "object",
          required: ["endpoints"],
          additionalProperties: false,
          properties: {
            endpoints: {
              type: "array",
              maxItems: 32,
              items: {
                type: "object",
                required: ["host", "ports"],
                additionalProperties: false,
                properties: {
                  host: {
                    type: "string",
                    minLength: 1,
                    maxLength: 253,
                    pattern: "^[a-z0-9]+(?:[.-][a-z0-9]+)*$",
                  },
                  ports: {
                    type: "array",
                    minItems: 1,
                    maxItems: 16,
                    uniqueItems: true,
                    items: { type: "integer", minimum: 1, maximum: 65535 },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
});

export function validateConfiguration(input: Readonly<StrandsBoxOptions>): readonly ErrorDetail[] {
  const errors: ErrorDetail[] = [];
  if (input.kubernetes?.stockLauncher !== undefined && !validStockConfiguration(input)) {
    errors.push({
      path: "/kubernetes/stockLauncher",
      code: "INVALID_VALUE",
      message:
        "Stock Box requires a tenant namespace, oce-strands-box-v0.3.1.json and only api.openai.com:443.",
    });
  }
  const profile = input.kubernetes?.seccompProfile;
  if (
    typeof profile !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/u.test(profile) ||
    profile.split("/").some((part) => ["", ".", ".."].includes(part))
  ) {
    errors.push({
      path: "/kubernetes/seccompProfile",
      code: "INVALID_VALUE",
      message: "Use an exact node-local relative profile path without traversal.",
    });
  }
  if (input.kubernetes?.nodeSelector?.["kubernetes.io/arch"] !== "arm64") {
    errors.push({
      path: "/kubernetes/nodeSelector",
      code: "INVALID_VALUE",
      message: "Select explicitly qualified ARM64 nodes.",
    });
  }
  return errors;
}

const MANAGED = "openclaw.dev/strands-box";
const OWNER = "openclaw.dev/namespace";
const AGENT = "openclaw.dev/agent";
const REVISION = "openclaw.dev/revision";
const HASH = "openclaw.dev/strands-box-input-sha256";

function isPodUid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f-]{36}$/u.test(value);
}

type ExecutionContext = SandboxNamespaceContext & { readonly revision: Readonly<AgentRevision> };
function podReady(pod: unknown): boolean {
  const status = asRecord(asRecord(pod)?.status);
  const conditions = Array.isArray(status?.conditions) ? status.conditions : [];
  return conditions.some(
    (condition) => asRecord(condition)?.type === "Ready" && asRecord(condition)?.status === "True",
  );
}

function awaitingLauncher(): never {
  throw new ActivationPendingError(
    "CREDENTIAL_ACTIVATION_PENDING",
    "Waiting for the held Box launcher.",
  );
}

function listenerState(statuses: unknown = []): Record<string, unknown> | undefined {
  if (!Array.isArray(statuses)) {
    throw new DependencyUnavailableError("Invalid Strands init container statuses.");
  }
  let state: Record<string, unknown> | undefined;
  for (const entry of statuses) {
    const container = asRecord(entry);
    if (typeof container?.name !== "string" || !container.name) {
      throw new DependencyUnavailableError("Invalid Strands init container statuses.");
    }
    if (container.name === "initialize-listener") {
      const current = asRecord(container.state);
      if (state || !current || Object.keys(current).length !== 1) {
        throw new DependencyUnavailableError("Invalid Strands listener state.");
      }
      state = current;
    }
  }
  return state;
}

function api(context: SandboxNamespaceContext): KubernetesObjectApi {
  if (!(context.kubernetes instanceof KubernetesObjectApi)) {
    throw new Error("Strands Box requires Compute's Kubernetes object client.");
  }
  context.signal.throwIfAborted();
  return context.kubernetes;
}
function missing(error: unknown): boolean {
  const value = asRecord(error);
  return [value?.code, value?.statusCode, asRecord(value?.response)?.statusCode].includes(404);
}
async function read(
  context: SandboxNamespaceContext,
  ref: KubernetesObject,
): Promise<KubernetesObject | undefined> {
  try {
    if (!ref.metadata?.name || !ref.apiVersion || !ref.kind) {
      throw new Error("Invalid resource reference.");
    }
    return await api(context).read({
      apiVersion: ref.apiVersion,
      kind: ref.kind,
      metadata: {
        name: ref.metadata.name,
        ...(ref.metadata.namespace ? { namespace: ref.metadata.namespace } : {}),
      },
    });
  } catch (error) {
    if (missing(error)) {
      return undefined;
    }
    throw error;
  }
}
function name(namespaceId: string, agentId: string, revisionId: string): string {
  return `strands-${sha256Hex(JSON.stringify([namespaceId, agentId, revisionId]), 32)}`;
}
function owned(resource: KubernetesObject, namespaceId: string, driverId: string): void {
  const labels = resource.metadata?.labels;
  if (
    labels?.[MANAGED] !== sha256Hex(driverId, 20) ||
    labels?.[OWNER] !== namespaceId ||
    !labels?.[AGENT] ||
    !labels?.[REVISION]
  ) {
    throw new Error("Strands Box resource ownership does not match the requested scope.");
  }
  const expected = name(namespaceId, labels[AGENT], labels[REVISION]);
  if (
    resource.metadata?.name !== expected &&
    !(resource.kind === "Service" && resource.metadata?.name === `${expected}-status`) &&
    !(resource.kind === "Secret" && resource.metadata?.name === `${expected}-material`) &&
    !(
      resource.kind === "ConfigMap" &&
      [`${expected}-listener`, `${expected}-release`].includes(resource.metadata?.name ?? "")
    )
  ) {
    throw new Error("Strands Box resource ownership does not match the requested scope.");
  }
}

export class StrandsBoxSandboxDriver implements SandboxDriver {
  static readonly configurationSchema = configurationSchema;
  static readonly validateConfiguration = validateConfiguration;
  readonly capability = "sandbox" as const;
  readonly facets = Object.freeze(["networking", "filesystem", "process"] as const);
  readonly supportsHarnessExecutionMode = Object.freeze({
    openclaw: Object.freeze({
      embedded: Object.freeze({
        supported: false,
        reason: "Strands Box requires dedicated Codex.",
      }),
      dedicated: Object.freeze({
        supported: false,
        reason: "Strands Box requires dedicated Codex.",
      }),
    }),
  });
  readonly implementation = "strands-box";
  readonly maintenanceIntervalMs = 60_000;
  readonly harnessHome = "/home/node";
  readonly id: string;
  private readonly options: StrandsBoxOptions;
  private readonly routing: KubernetesGatewayRoutingOptions;
  private readonly dns: KubernetesWorkloadPeer;
  private readonly authentication: KubernetesAuthentication;
  private observer?: Promise<KubernetesObjectApi>;
  readonly networkPolicy?: NonNullable<SandboxDriver["networkPolicy"]>;
  readonly admitNetworkPolicy?: NonNullable<SandboxDriver["admitNetworkPolicy"]>;
  readonly observeNetworkPolicy?: NonNullable<SandboxDriver["observeNetworkPolicy"]>;

  get agentResponsesGrant() {
    const launcher = this.options.kubernetes.stockLauncher;
    const grant = launcher?.agentGrants?.[0];
    return (
      grant && { namespace: launcher.namespace, agentId: grant.agentId, sourceId: grant.sourceId }
    );
  }

  constructor(
    options: StrandsBoxOptions,
    selection: {
      readonly id: string;
      readonly authentication: KubernetesAuthentication;
      readonly dns: KubernetesWorkloadPeer;
      readonly routing: KubernetesGatewayRoutingOptions;
    },
  ) {
    requireConfiguration(StrandsBoxSandboxDriver, options);
    this.options = immutableCopy(options);
    this.routing = immutableCopy(selection.routing);
    this.dns = immutableCopy(selection.dns);
    this.id = selection.id;
    this.authentication = immutableCopy(selection.authentication);
    if (this.agentResponsesGrant) {
      this.networkPolicy = Object.freeze({ wildcards: false, portRanges: false, live: false });
      this.admitNetworkPolicy = (additions, version, defaults = {}) => {
        if (
          additions.length ||
          Object.keys(defaults).length ||
          !Number.isSafeInteger(version) ||
          version < 1
        ) {
          throw new Error("Staged Box admits only its configured whole-Agent profile.");
        }
        return immutableCopy({
          driverId: this.id,
          implementation: this.implementation,
          version,
          defaults,
          additions,
        });
      };
      this.observeNetworkPolicy = (context, snapshot) =>
        this.stagedNetworkPolicy(context, snapshot);
    }
  }

  configureAgent(
    configuration: Readonly<OpenClawConfigurationDocument>,
    harness: Readonly<RevisionHarnessDescriptor>,
  ): OpenClawConfigurationDocument {
    this.requireHarness(harness);
    function object(value: unknown): Record<string, unknown> {
      if (value === undefined) {
        return {};
      }
      const record = asRecord(value);
      if (!record) {
        throw new SandboxRevisionUnsupportedError(
          "SANDBOX_HARNESS_UNSUPPORTED",
          "Strands Box requires object-shaped Codex configuration.",
        );
      }
      return record;
    }
    const plugins = object(configuration.plugins);
    const entries = object(plugins.entries);
    const codex = object(entries.codex);
    const config = object(codex.config);
    const { networkProxy: _networkProxy, ...appServer } = object(config.appServer);
    // Box owns process, filesystem and network isolation. A native proxy or
    // workspace-write profile would require a second, unavailable sandbox.
    // Preserve the admitted approval policy and keep its reviewer human-owned.
    return immutableCopy({
      ...configuration,
      plugins: {
        ...plugins,
        entries: {
          ...entries,
          codex: {
            ...codex,
            enabled: true,
            config: {
              ...config,
              appServer: {
                ...appServer,
                tlsPeerCertificate: "${OPENCLAW_HARNESS_TLS_PEER_CERTIFICATE}",
                sandbox: "danger-full-access",
                approvalsReviewer: "user",
              },
            },
          },
        },
      },
    });
  }

  private requireHarness(harness: Readonly<RevisionHarnessDescriptor>): void {
    if (harness.id !== "codex" || harness.mode !== "dedicated") {
      throw new SandboxRevisionUnsupportedError(
        "SANDBOX_HARNESS_UNSUPPORTED",
        "Strands Box currently requires dedicated Codex.",
      );
    }
  }

  harnessResource(
    context: Pick<SandboxHarnessContext, "namespace" | "revision">,
  ): SandboxResourceRef {
    if (
      context.revision.namespaceId !== context.namespace.id ||
      context.revision.sandboxDriverId !== this.id
    ) {
      throw new Error("Strands Box revision ownership does not match.");
    }
    return {
      namespaceName: context.namespace.name,
      resourceName: name(context.namespace.id, context.revision.agentId, context.revision.id),
      agentId: context.revision.agentId,
      revisionId: context.revision.id,
    };
  }

  private observerClient() {
    this.observer ??= createKubernetesClientConfiguration(
      this.authentication,
      (message) => new Error(message),
    ).then(({ sdk, clientConfiguration }) => new sdk.KubernetesObjectApi(clientConfiguration));
    return this.observer;
  }

  async stagedScope(namespaceId: string) {
    // A changed installation grant does not move previously delivered copies.
    if (!namespaceId?.trim()) {
      throw new Error("Missing staged Box Namespace ID.");
    }
    const namespace = managedNamespaceName(namespaceId);
    return {
      namespace,
      labels: { [MANAGED]: sha256Hex(this.id, 20), [OWNER]: namespaceId },
      client: await this.observerClient(),
    };
  }

  async observeHarness(context: SandboxLogContext): Promise<SandboxHarnessObservation> {
    this.harnessResource(context);
    const client = await this.observerClient();
    context.signal.throwIfAborted();
    const selector = Object.entries(this.labels(context))
      .map(([key, value]) => `${key}=${value}`)
      .join(",");
    const list = (version: string, kind: string) =>
      withComputeAbortSignal(context.signal, () =>
        client.list(
          version,
          kind,
          context.namespace.name,
          undefined,
          undefined,
          undefined,
          undefined,
          selector,
        ),
      );
    const deployments = await list("apps/v1", "Deployment");
    context.signal.throwIfAborted();
    if (deployments.items.length === 0) {
      return { state: "lost", code: "SANDBOX_MISSING" };
    }
    if (deployments.items.length !== 1) {
      throw new Error("Ambiguous Strands Box revision resources.");
    }
    owned(deployments.items[0]!, context.namespace.id, this.id);
    if (deployments.items[0]!.metadata?.deletionTimestamp) {
      return { state: "lost", code: "SANDBOX_DELETING" };
    }
    const pods = await list("v1", "Pod");
    context.signal.throwIfAborted();
    if (pods.items.length !== 1) {
      return { state: "starting" };
    }
    return podReady(pods.items[0]) ? { state: "running" } : { state: "starting" };
  }

  async workspaceNodePeerLabels(
    context: SandboxNamespaceContext & { readonly revision: Readonly<AgentRevision> },
  ): Promise<Readonly<Record<string, string>> | undefined> {
    const ref = this.harnessResource(context);
    const deployment = await read(context, {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { namespace: ref.namespaceName, name: ref.resourceName },
    });
    if (!deployment) {
      return undefined;
    }
    owned(deployment, context.namespace.id, this.id);
    return this.labels(context);
  }

  async harnessPeerLabels(
    context: SandboxNamespaceContext & { readonly revision: Readonly<AgentRevision> },
  ): Promise<Readonly<Record<string, string>> | undefined> {
    return this.workspaceNodePeerLabels(context);
  }

  private labels(
    context: Pick<SandboxHarnessContext, "namespace" | "revision">,
  ): Readonly<Record<string, string>> {
    return {
      [MANAGED]: sha256Hex(this.id, 20),
      [OWNER]: context.namespace.id,
      [AGENT]: context.revision.agentId,
      [REVISION]: context.revision.id,
      "openclaw.dev/workload-role": "agent",
    };
  }

  validateWorkspaceSetup(
    harness: Readonly<RevisionHarnessDescriptor>,
    configuration: Readonly<OpenClawConfigurationDocument>,
  ): void {
    this.requireHarness(harness);
    requireWorkspaceSetupConfiguration(
      configuration,
      ["/home/node/.openclaw/workspace", "/home/node/workspace"],
      () =>
        new SandboxWorkspaceSetupRefusedError("Strands Box requires the prepared main workspace."),
    );
  }

  async provisionHarness(context: SandboxHarnessContext): Promise<SandboxResourceRef> {
    if (context.revision.credentialDeployment || this.agentResponsesGrant) {
      throw new Error("Staged Box requires a held deployment.");
    }
    return this.provision(context);
  }

  async provisionStagedHarness(
    context: SandboxHarnessContext,
  ): Promise<CredentialDeploymentTarget> {
    this.requireStaged(context);
    await this.provision(context);
    return (await this.stagedConfiguration(context)).targetRef;
  }

  requireStaged(context: CredentialDeploymentContext) {
    const grant = this.agentResponsesGrant;
    const { revision, namespace } = context;
    this.harnessResource(context);
    const staged = validateStockRevision(revision);
    if (
      !grant ||
      grant.namespace !== namespace.name ||
      grant.agentId !== revision.agentId ||
      grant.sourceId !== staged.sourceId
    ) {
      throw new Error("Strands Box has no whole-Agent grant for this target.");
    }
    return grant;
  }

  private async stagedConfiguration(
    context: ExecutionContext,
  ): Promise<CredentialDeploymentConfiguration> {
    this.requireStaged(context);
    const ref = this.harnessResource(context);
    const deployment = await read(context, {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: ref.resourceName, namespace: ref.namespaceName },
    });
    if (
      !deployment?.metadata?.uid ||
      deployment.metadata.deletionTimestamp ||
      asRecord(asRecord(deployment)?.spec)?.replicas !== 1
    ) {
      throw new Error("Strands Box requires a single retained execution.");
    }
    owned(deployment, context.namespace.id, this.id);
    return {
      targetRef: {
        namespaceId: context.namespace.id,
        agentId: ref.agentId,
        revisionId: ref.revisionId,
        sandboxId: deployment.metadata.uid,
      },
      configurationId: context.revision.configurationId,
    };
  }

  /** Read-only. Never pin or adopt a replacement to answer a delivery/status request. */
  async stagedTarget(
    context: CredentialDeploymentContext,
    expected: CredentialDeploymentConfiguration,
  ) {
    const placed = { ...context, kubernetes: await this.observerClient() };
    if (!expected?.targetRef?.sandboxId) {
      throw new Error("Missing retained Box execution.");
    }
    return this.inspectLauncher(placed, expected);
  }

  private async inspectLauncher(
    context: ExecutionContext,
    expected?: CredentialDeploymentConfiguration,
  ) {
    const current = await this.stagedConfiguration(context);
    if (
      expected &&
      (current.configurationId !== expected.configurationId ||
        !isDeepStrictEqual(current.targetRef, expected.targetRef))
    ) {
      throw new Error("Strands Box credential target changed.");
    }
    const ref = this.harnessResource(context);
    const certificate = await this.listenerCertificate(context, true);
    const pod = await this.livePod(context, current.targetRef.sandboxId);
    if (!pod.metadata.name || certificate.subject !== "CN=" + pod.metadata.uid) {
      throw new Error("A replacement Pod cannot inherit Box credentials.");
    }
    const config = await read(context, {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name: ref.resourceName, namespace: ref.namespaceName },
    });
    const data = asRecord(asRecord(config)?.data);
    const policy = STOCK_RESPONSES_POLICY;
    if (
      !config ||
      config.metadata?.deletionTimestamp ||
      asRecord(config)?.immutable !== true ||
      data?.["policy.dw"] !== policy ||
      typeof data["box.toml"] !== "string" ||
      typeof data.transportRef !== "string"
    ) {
      throw new Error("Staged Box inputs differ from the reviewed policy.");
    }
    owned(config, context.namespace.id, this.id);
    const tokenRef = asRecord(JSON.parse(data.transportRef));
    if (typeof tokenRef?.name !== "string" || tokenRef.key !== "app-server-token") {
      throw new Error("Missing staged transport reference.");
    }
    const transportToken = await this.transportCredential(context, tokenRef.name, tokenRef.key);
    const address = await this.harnessServiceAddress(context, true);
    const report = await StrandsBoxSandboxDriver.readiness(
      { ...context, transportToken },
      certificate,
      address,
    ).catch((error: unknown) => {
      if (error instanceof TransientDependencyError) {
        awaitingLauncher();
      }
      throw error;
    });
    const status = launcherStatus(
      report,
      this.agentResponsesGrant!.sourceId,
      policy,
      data["box.toml"],
    );
    return {
      client: api(context),
      configuration: current,
      serving: report.state === "serving" && podReady(pod),
      hash: config.metadata?.annotations?.[HASH],
      port:
        typeof data["workload.json"] === "string"
          ? asRecord(JSON.parse(data["workload.json"]))?.port
          : undefined,
      name: ref.resourceName,
      namespace: ref.namespaceName,
      labels: this.labels(context),
      podName: pod.metadata.name,
      podUid: pod.metadata.uid,
      status,
    };
  }

  private async stagedNetworkPolicy(
    context: SandboxLogContext,
    snapshot: SandboxPolicySnapshot,
  ): Promise<SandboxPolicyObservation> {
    if (!isDeepStrictEqual(snapshot, context.revision.sandboxPolicy)) {
      throw new Error("Strands Box network policy changes require redeployment.");
    }
    const placed = { ...context, kubernetes: await this.observerClient() };
    const { status, configuration } = await this.inspectLauncher(placed);
    // Desired policy matched the immutable configuration. It is applied only
    // after the pinned launcher reports the measured contents of both files.
    return {
      matches: true,
      state: status ? "applied" : "pending",
      policyVersion: String(snapshot.version),
      resourceVersion: configuration.targetRef.sandboxId,
    };
  }

  /** Compute alone writes the release, after its authority check. The pinned
   * diagnostic port can report a challenge but never accepts a release. */
  private async preparedRelease(
    context: ExecutionContext,
    retained?: CredentialDeploymentConfiguration,
  ) {
    const target = await this.inspectLauncher(context, retained);
    const expected = target.configuration;
    if (!target.status || !(await observedMaterialVersion(context, expected, target))) {
      awaitingLauncher();
    }
    const resource = executionRelease(target, target.status);
    const existing = await read(context, resource);
    if (existing) {
      owned(existing, context.namespace.id, this.id);
      verifyExecutionRelease(existing, resource);
    } else if (target.status.released) {
      throw new Error("Strands Box is missing its execution release.");
    }
    return { target, resource, existing };
  }

  /** Maintenance may refresh DNS on the owned policy. It cannot create resources or release a held launcher. */
  async maintainStagedHarness(
    context: ExecutionContext,
    expected: CredentialDeploymentConfiguration,
  ): Promise<boolean> {
    const { target, existing } = await this.preparedRelease(context, expected);
    if (
      !existing ||
      !target.serving ||
      !target.status?.released ||
      !target.hash ||
      typeof target.port !== "number"
    ) {
      return false;
    }
    await this.harnessServiceAddress(context, false, target.port);
    await this.refreshEndpointPolicy(context, this.harnessResource(context), target.hash);
    return true;
  }

  async prepareStagedHarness(
    context: SandboxHarnessContext,
    projections: readonly CredentialProjection[],
  ): Promise<void> {
    this.requireStaged(context);
    const binding = context.revision.credentialDeployment!.bindings[0]!;
    if (
      !isDeepStrictEqual(projections, [
        {
          bindingRef: binding.bindingRef,
          environment: binding.projection.environment,
          placeholder: { kind: "runtime" },
        },
      ])
    ) {
      throw new Error("Box requires its own credential placeholder.");
    }
    await this.preparedRelease(context);
  }

  async activateStagedHarness(context: ExecutionContext): Promise<void> {
    const { resource, existing } = await this.preparedRelease(context);
    if (!existing) {
      // Create only. A lost reply is reconciled by the next activation pass.
      await api(context).create(resource);
    }
  }

  private async provision(context: SandboxHarnessContext): Promise<SandboxResourceRef> {
    this.requireHarness(context.revision.harness);
    const ref = this.harnessResource(context);
    if (
      context.revision.egressPlan !== undefined ||
      context.requirements.proxyWiring !== undefined ||
      context.requirements.credentialAttachments.length !== 0
    ) {
      throw new SandboxRevisionUnsupportedError(
        "SANDBOX_HARNESS_UNSUPPORTED",
        "This Strands Box driver supports ordinary dedicated Codex revisions only.",
      );
    }
    // Recheck the revision and tenant before adopting an existing deployment.
    stockModelDelivery(context, this.options);
    const hash = sha256Hex(
      JSON.stringify([4, context.requirements, this.options, this.dns, this.routing]),
    );
    // A completed preparation is immutable, including its exact input identity.
    // Do not re-read an enrollment Secret that Compute may already have retired.
    const existing = await read(context, {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { namespace: ref.namespaceName, name: ref.resourceName },
    });
    if (existing) {
      owned(existing, context.namespace.id, this.id);
      if (existing.metadata?.annotations?.[HASH] !== hash || existing.metadata.deletionTimestamp) {
        throw new Error("Strands Box revision Pod is not adoptable.");
      }
      await this.refreshEndpointPolicy(context, ref, hash);
      await this.ensureDiagnosticService(context, ref, hash);
      return ref;
    }
    if (context.existingHarnessOnly) {
      throw new DependencyUnavailableError(
        "Strands Box maintenance cannot recreate a missing revision workload.",
      );
    }
    const transportHash = await this.transportVerifier(context);
    const gateway = await this.gatewayRoute(context);
    const cidrs = await this.endpointAddresses(context.signal);
    const resources = strandsBoxResources(
      context,
      this.options,
      ref.resourceName,
      this.labels(context),
      hash,
      transportHash,
      this.dns,
      gateway,
      cidrs,
    );
    // Preflight all names before creating any object. An ownership collision
    // must not partially overwrite an unrelated workload's configuration.
    for (const resource of resources) {
      const current = await read(context, resource);
      if (current) {
        owned(current, context.namespace.id, this.id);
        if (current.metadata?.annotations?.[HASH] !== hash) {
          throw new Error("Strands Box immutable inputs differ.");
        }
      }
    }
    for (const resource of resources) {
      if (await read(context, resource)) {
        continue;
      }
      try {
        await api(context).create(networkPolicyToSdk(resource));
      } catch (error) {
        const current = await read(context, resource);
        if (!current) {
          throw error;
        }
        owned(current, context.namespace.id, this.id);
        if (current.metadata?.annotations?.[HASH] !== hash) {
          throw error;
        }
      }
    }
    return ref;
  }

  private async endpointAddresses(signal: AbortSignal): Promise<{ cidr: string; port: number }[]> {
    const addresses = new Map<string, { cidr: string; port: number }>();
    for (const endpoint of this.options.policy.network.endpoints) {
      signal.throwIfAborted();
      const resolved = await lookup(endpoint.host, { all: true });
      signal.throwIfAborted();
      if (resolved.length === 0) {
        throw new Error("Strands Box endpoint has no resolved addresses.");
      }
      for (const address of resolved) {
        if (!isIP(address.address) || ![4, 6].includes(address.family)) {
          throw new Error("Strands Box endpoint returned an invalid address.");
        }
        for (const port of endpoint.ports) {
          const cidr = `${address.address}/${address.family === 4 ? 32 : 128}`;
          addresses.set(`${cidr}:${port}`, { cidr, port });
        }
      }
    }
    return [...addresses.values()].sort((a, b) => a.cidr.localeCompare(b.cidr) || a.port - b.port);
  }

  private async refreshEndpointPolicy(
    context: ExecutionContext,
    ref: SandboxResourceRef,
    hash: string,
  ): Promise<void> {
    const policy = await read(context, {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: { namespace: ref.namespaceName, name: ref.resourceName },
    });
    if (!policy) {
      throw new Error("Strands Box revision NetworkPolicy is missing.");
    }
    owned(policy, context.namespace.id, this.id);
    const metadata = policy.metadata!;
    // SDK models carry prototypes and absent fields; compare their JSON wire shape.
    const spec = asRecord(JSON.parse(JSON.stringify(asRecord(policy)?.spec)));
    if (
      metadata.annotations?.[HASH] !== hash ||
      !metadata.uid ||
      !metadata.resourceVersion ||
      metadata.deletionTimestamp ||
      !Array.isArray(spec?.egress) ||
      !isDeepStrictEqual(spec.podSelector, { matchLabels: this.labels(context) }) ||
      !isDeepStrictEqual(spec.policyTypes, ["Ingress", "Egress"])
    ) {
      throw new Error("Strands Box revision NetworkPolicy is not adoptable.");
    }
    const retained = [];
    for (const rule of spec.egress) {
      const entry = asRecord(rule);
      const peers = Array.isArray(entry?.to) ? entry.to : [];
      if (!peers.some((peer) => asRecord(peer)?.ipBlock !== undefined)) {
        retained.push(rule);
        continue;
      }
      // Only the adapter's exact host/port rules can be refreshed. Never carry
      // a widened range or mixed peer onto a newly resolved destination.
      const block = asRecord(asRecord(peers[0])?.ipBlock);
      const parts = typeof block?.cidr === "string" ? block.cidr.split("/") : [];
      const family = isIP(parts[0] ?? "");
      const ports = Array.isArray(entry?.ports) ? entry.ports : [];
      const port = asRecord(ports[0]);
      if (
        !entry ||
        Object.keys(entry).length !== 2 ||
        peers.length !== 1 ||
        Object.keys(asRecord(peers[0]) ?? {}).length !== 1 ||
        !block ||
        Object.keys(block).length !== 1 ||
        !family ||
        parts.length !== 2 ||
        parts[1] !== (family === 4 ? "32" : "128") ||
        ports.length !== 1 ||
        !port ||
        Object.keys(port).length !== 2 ||
        port.protocol !== "TCP" ||
        !this.options.policy.network.endpoints.some((endpoint) =>
          endpoint.ports.includes(port.port as number),
        )
      ) {
        throw new Error("Strands Box endpoint rule differs from an exact approved destination.");
      }
    }
    const addresses = await this.endpointAddresses(context.signal);
    const egress = [
      ...retained,
      ...addresses.map(({ cidr, port }) => ({
        to: [{ ipBlock: { cidr } }],
        ports: [{ protocol: "TCP", port }],
      })),
    ];
    if (isDeepStrictEqual(spec.egress, egress)) {
      return;
    }
    const patch = {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: {
        name: ref.resourceName,
        namespace: ref.namespaceName,
        uid: metadata.uid,
        resourceVersion: metadata.resourceVersion,
      },
      spec: { egress },
    };
    await api(context).patch(
      patch,
      undefined,
      undefined,
      undefined,
      undefined,
      PatchStrategy.MergePatch,
    );
  }

  private async transportVerifier(context: SandboxHarnessContext): Promise<string> {
    const variables = context.requirements.environment;
    const token = variables.find(({ name }) => name === "APP_SERVER_TOKEN");
    if (!token || !("valueFrom" in token)) {
      throw new Error(
        "Strands Box Pod readiness requires the prepared transport Secret reference.",
      );
    }
    const { name, key } = token.valueFrom.secretKeyRef;
    return sha256Hex(await this.transportCredential(context, name, key));
  }

  private async transportCredential(
    context: ExecutionContext,
    name: string,
    key: string,
  ): Promise<string> {
    const secret = await read(context, {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { namespace: context.namespace.name, name },
    });
    const labels = secret?.metadata?.labels;
    if (
      labels?.[OWNER] !== context.namespace.id ||
      labels[AGENT] !== context.revision.agentId ||
      labels[REVISION] !== context.revision.id
    ) {
      throw new Error("Prepared transport Secret must belong to this exact revision.");
    }
    const encoded = asRecord(asRecord(secret)?.data)?.[key];
    if (typeof encoded !== "string" || encoded.length === 0 || encoded.length > 65536) {
      throw new Error("Prepared transport credential is unavailable.");
    }
    // Only the external listener verifier enters the prepared inputs.
    return Buffer.from(encoded, "base64").toString("utf8");
  }

  private async gatewayRoute(
    context: SandboxHarnessContext,
  ): Promise<
    { host: string; port: number; egress: Readonly<Record<string, unknown>> } | undefined
  > {
    const reference = context.requirements.environment.find(
      (entry) => entry.name === "OPENCLAW_NODE_SETUP_CODE",
    );
    if (!reference) {
      return undefined;
    }
    if (!("valueFrom" in reference)) {
      throw new Error("Workspace enrollment must retain its private Secret reference.");
    }
    const secret = await read(context, {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { namespace: context.namespace.name, name: reference.valueFrom.secretKeyRef.name },
    });
    const setup = validateWorkspaceNodeSetupSecret(secret, {
      namespace: context.namespace.name,
      namespaceId: context.namespace.id,
      agentId: context.revision.agentId,
      key: reference.valueFrom.secretKeyRef.key,
    });
    const endpoint = new URL(setup.url);
    const port = Number(endpoint.port || (endpoint.protocol === "wss:" ? 443 : 80));
    const routing = this.routing;
    if (
      endpoint.protocol !== "wss:" ||
      endpoint.hostname !== gatewayRoutingHostname(routing) ||
      port !== (routing.endpointPort ?? 443)
    ) {
      throw new Error("Strands Box workspace enrollment must use the installation Gateway route.");
    }
    return {
      host: endpoint.hostname,
      port,
      egress: {
        to: [
          {
            namespaceSelector: {
              matchLabels: { "kubernetes.io/metadata.name": routing.envoyNamespace },
            },
            podSelector: {
              matchLabels: {
                "app.kubernetes.io/component": "proxy",
                "app.kubernetes.io/managed-by": "envoy-gateway",
                "app.kubernetes.io/name": "envoy",
                "gateway.envoyproxy.io/owning-gateway-namespace": routing.gatewayNamespace,
                "gateway.envoyproxy.io/owning-gateway-name": routing.gatewayName,
              },
            },
          },
        ],
        ports: [{ protocol: "TCP", port: routing.envoyHttpsTargetPort ?? 10443 }],
      },
    };
  }

  // An existing revision may predate the diagnostic Service. Its immutable setup
  // credential may have been consumed; this Service needs only the prepared port and labels.
  private async ensureDiagnosticService(
    context: SandboxHarnessContext,
    ref: SandboxResourceRef,
    hash: string,
  ): Promise<void> {
    const desired = strandsBoxService(context, ref.resourceName, this.labels(context), hash, true);
    let current = await read(context, desired);
    if (!current) {
      try {
        await api(context).create(desired);
        return;
      } catch (error) {
        current = await read(context, desired);
        if (!current) {
          throw error;
        }
      }
    }
    owned(current, context.namespace.id, this.id);
    if (current.metadata?.annotations?.[HASH] !== hash || current.metadata.deletionTimestamp) {
      throw new Error("Strands Box diagnostic Service is not adoptable.");
    }
  }

  private async harnessServiceAddress(
    context: ExecutionContext & Partial<Pick<SandboxHarnessContext, "requirements">>,
    diagnostic: boolean,
    retainedPort?: number,
  ): Promise<string> {
    const ref = this.harnessResource(context);
    const serviceName = diagnostic ? `${ref.resourceName}-status` : ref.resourceName;
    const service = await read(context, {
      apiVersion: "v1",
      kind: "Service",
      metadata: { namespace: ref.namespaceName, name: serviceName },
    });
    if (!service) {
      throw new Error("Strands Box Harness Service is unavailable.");
    }
    owned(service, context.namespace.id, this.id);
    const expectedPort = context.requirements?.environment.find(
      (entry) => entry.name === "APP_SERVER_PORT",
    );
    const port = diagnostic
      ? STRANDS_STATUS_PORT
      : expectedPort && "value" in expectedPort
        ? Number(expectedPort.value)
        : (retainedPort ?? NaN);
    const spec = asRecord(asRecord(service)?.spec);
    const ports = Array.isArray(spec?.ports) ? spec.ports : [];
    if (
      !Number.isInteger(port) ||
      service.metadata?.deletionTimestamp ||
      (spec?.type !== undefined && spec.type !== "ClusterIP") ||
      (spec?.publishNotReadyAddresses ?? false) !== diagnostic ||
      ports.length !== 1 ||
      asRecord(ports[0])?.port !== port ||
      asRecord(ports[0])?.targetPort !== port ||
      (asRecord(ports[0])?.protocol ?? "TCP") !== "TCP" ||
      !isDeepStrictEqual(spec?.selector, this.labels(context))
    ) {
      throw new Error("Strands Box Harness Service differs from the revision.");
    }
    return `${serviceName}.${ref.namespaceName}.svc:${port}`;
  }

  private async livePod(context: ExecutionContext, uid: string) {
    const ref = this.harnessResource(context);
    const metadata = { name: ref.resourceName, namespace: ref.namespaceName };
    const labels = this.labels(context);
    const selector = Object.entries(labels)
      .map(([key, value]) => key + "=" + value)
      .join(",");
    const pods = await api(context).list(
      "v1",
      "Pod",
      metadata.namespace,
      undefined,
      undefined,
      undefined,
      undefined,
      selector,
    );
    const items = Array.isArray(pods.items) ? pods.items : undefined;
    if (items?.length === 0) {
      throw new TransientDependencyError(
        "sandbox_gateway",
        "unavailable",
        "Awaiting the first Strands execution Pod.",
      );
    }
    const pod = items?.length === 1 ? items[0] : undefined;
    const owner = pod?.metadata?.ownerReferences?.find((item) => item.controller === true);
    if (
      !pod?.metadata?.uid ||
      pod.metadata.deletionTimestamp ||
      owner?.kind !== "ReplicaSet" ||
      owner.apiVersion !== "apps/v1" ||
      !owner.uid ||
      !owner.name
    ) {
      throw new DependencyUnavailableError("Awaiting one Strands execution Pod.");
    }
    const rs = await read(context, {
      apiVersion: "apps/v1",
      kind: "ReplicaSet",
      metadata: { ...metadata, name: owner.name },
    });
    const controller = rs?.metadata?.ownerReferences?.find((item) => item.controller === true);
    if (
      rs?.metadata?.uid !== owner.uid ||
      rs.metadata.deletionTimestamp ||
      controller?.kind !== "Deployment" ||
      controller.apiVersion !== "apps/v1" ||
      controller.name !== metadata.name ||
      controller.uid !== uid
    ) {
      throw new Error("Strands Pod does not belong to the prepared Deployment.");
    }
    return {
      ...pod,
      metadata: { ...pod.metadata, name: pod.metadata.name, uid: pod.metadata.uid },
    };
  }

  private async listenerCertificate(
    context: ExecutionContext,
    readOnly = false,
  ): Promise<X509Certificate> {
    const ref = this.harnessResource(context);
    const metadata = { name: ref.resourceName, namespace: ref.namespaceName };
    const deployment = await read(context, { apiVersion: "apps/v1", kind: "Deployment", metadata });
    if (!deployment?.metadata?.uid || deployment.metadata.deletionTimestamp) {
      throw new DependencyUnavailableError("The Strands execution Deployment is unavailable.");
    }
    owned(deployment, context.namespace.id, this.id);
    const uid = deployment.metadata.uid;
    const labels = this.labels(context);
    const receipt = {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { ...metadata, name: metadata.name + "-listener", labels },
    };
    const hostname = metadata.name + "." + metadata.namespace + ".svc";
    const validate = (pem: unknown, podUid: unknown) => {
      if (
        typeof pem !== "string" ||
        pem.length > 4096 ||
        !/^-----BEGIN CERTIFICATE-----[\r\n]+[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----$/u.test(
          pem.trim(),
        ) ||
        !isPodUid(podUid)
      ) {
        throw new Error("Invalid Strands execution certificate evidence.");
      }
      const leaf = new X509Certificate(pem);
      if (
        leaf.ca ||
        leaf.subject !== "CN=" + podUid ||
        !leaf.checkHost(hostname, { subject: "never" }) ||
        !leaf.checkHost(metadata.name + "-status." + metadata.namespace + ".svc", {
          subject: "never",
        }) ||
        !leaf.verify(leaf.publicKey)
      ) {
        throw new Error("Strands listener identity does not match its Pod and Services.");
      }
      return leaf;
    };
    const pinned = (resource: KubernetesObject) => {
      owned(resource, context.namespace.id, this.id);
      const object = asRecord(resource);
      const data = asRecord(object?.data);
      if (
        object?.immutable !== true ||
        resource.metadata?.deletionTimestamp ||
        data?.deploymentUid !== uid
      ) {
        throw new Error("Strands execution receipt ownership changed.");
      }
      return validate(data.certificate, data.podUid);
    };
    const existing = await read(context, receipt);
    if (existing) {
      return pinned(existing);
    }
    if (readOnly) {
      awaitingLauncher();
    }
    const pod = await this.livePod(context, uid);
    const pending = (message: string) =>
      new TransientDependencyError("sandbox_gateway", "unavailable", message);
    const rawStatus = asRecord(pod)?.status;
    const status = asRecord(rawStatus);
    const state = listenerState(status?.initContainerStatuses);
    const terminated = asRecord(state?.terminated);
    if (terminated?.exitCode !== 0) {
      // Only normal startup observations justify retrying without a certificate.
      const phase = status?.phase;
      const waiting = asRecord(state?.waiting);
      const starting =
        waiting &&
        (waiting.reason === undefined ||
          waiting.reason === "ContainerCreating" ||
          waiting.reason === "PodInitializing");
      if (
        isPodUid(pod.metadata.uid) &&
        (rawStatus === undefined || status) &&
        (phase === undefined || phase === "Pending" || phase === "Running") &&
        (!state || starting || asRecord(state.running))
      ) {
        throw pending("Awaiting Strands listener certificate.");
      }
      throw new DependencyUnavailableError("Awaiting Strands listener certificate.");
    }
    const cert = validate(terminated.message, pod.metadata.uid);
    // Concurrent workers may observe different Pods. A single create wins.
    // Every retry uses the winner, including after the Deployment replaces a Pod.
    try {
      await api(context).create({
        ...receipt,
        immutable: true,
        data: {
          deploymentUid: uid,
          podUid: pod.metadata.uid,
          certificate: cert.toString(),
        },
      } as KubernetesObject);
    } catch (error) {
      const winner = await read(context, receipt);
      if (!winner) {
        throw error;
      }
      return pinned(winner);
    }
    return cert;
  }

  async harnessEndpoint(context: SandboxHarnessContext): Promise<SandboxHarnessEndpoint> {
    return {
      url: `wss://${await this.harnessServiceAddress(context, false)}`,
      tlsPeerCertificate: (await this.listenerCertificate(context)).toString(),
      workspaceRoot: "/home/node/workspace",
      codexPermissionProfile: ":danger-full-access",
    };
  }

  async harnessStatus(context: SandboxHarnessStatusContext): Promise<SandboxHarnessStatus> {
    const certificate = await this.listenerCertificate(context);
    const address = await this.harnessServiceAddress(context, true);
    const report = await StrandsBoxSandboxDriver.readiness(context, certificate, address);
    return report.state === "failed" ? report : { state: report.state };
  }

  private static async readiness(
    context: ExecutionContext & { readonly transportToken: string },
    certificate: X509Certificate,
    diagnosticAddress: string,
  ): Promise<Readiness> {
    context.signal.throwIfAborted();
    const route = "/revisions/" + encodeURIComponent(context.revision.id) + "/readiness";
    const timeout = AbortSignal.timeout(7500);
    return new Promise<Readiness>((resolve, reject) => {
      const unreadable = (cause: Error) => {
        if (context.signal.aborted) {
          reject(context.signal.reason);
          return;
        }
        reject(
          new TransientDependencyError(
            "sandbox_gateway",
            timeout.aborted ? "timeout" : "unreachable",
            "Strands Box did not answer the Harness status read.",
            { cause },
          ),
        );
      };
      const request = httpsRequest(
        new URL(`https://${diagnosticAddress}${route}`),
        {
          agent: false,
          ca: certificate.toString(),
          allowPartialTrustChain: true,
          rejectUnauthorized: true,
          checkServerIdentity: (host, peer) =>
            checkServerIdentity(host, peer) ??
            (certificate.raw.equals(peer.raw)
              ? undefined
              : new Error("Strands readiness TLS peer changed.")),
          headers: { authorization: `Bearer ${context.transportToken}` },
          signal: AbortSignal.any([context.signal, timeout]),
        },
        (response) => {
          let bytes = Buffer.alloc(0);
          response.on("data", (chunk) => {
            bytes = Buffer.concat([bytes, chunk]);
            if (bytes.length > 16384) {
              response.destroy(new Error("Invalid readiness response size"));
            }
          });
          response.on("error", unreadable);
          response.on("end", () => {
            if (response.statusCode === 200) {
              try {
                const result = asRecord(JSON.parse(bytes.toString()));
                if (result?.state === "serving" || result?.state === "starting") {
                  return resolve({
                    state: result.state,
                    ...(result.staged !== undefined && { staged: result.staged }),
                  });
                }
                if (result?.state === "failed" && result.runtimeFailure) {
                  return resolve({ state: "failed", runtimeFailure: result.runtimeFailure });
                }
              } catch {
                // Malformed status follows the same unavailable path as an unknown state.
              }
            }
            unreadable(new Error("Readiness response unavailable"));
          });
        },
      );
      request.on("error", unreadable);
      request.end();
    });
  }

  async cleanup(
    context: SandboxNamespaceContext & { readonly revision?: Readonly<AgentRevision> },
  ): Promise<void> {
    const exact =
      context.revision === undefined
        ? undefined
        : this.harnessResource({ namespace: context.namespace, revision: context.revision });
    const staged = context.revision?.credentialDeployment !== undefined;
    // Stop the workload before deleting its immutable inputs or exposure. A
    // retry resumes at the same ownership-fenced objects; PVCs are never listed.
    for (const [apiVersion, kind, suffix = ""] of [
      ["apps/v1", "Deployment"],
      ["v1", "Service"],
      ...(exact ? [["v1", "Service", "-status"] as const] : []),
      ["networking.k8s.io/v1", "NetworkPolicy"],
      ...(staged || !exact ? [["v1", "Secret", "-material"] as const] : []),
      ["v1", "Secret"],
      ...(staged ? [["v1", "ConfigMap", "-release"] as const] : []),
      ["v1", "ConfigMap"],
      ...(exact ? [["v1", "ConfigMap", "-listener"] as const] : []),
    ] as const) {
      const resources = exact
        ? [
            await read(context, {
              apiVersion,
              kind,
              metadata: {
                namespace: context.namespace.name,
                name: `${exact.resourceName}${suffix}`,
              },
            }),
          ].filter((resource): resource is KubernetesObject => resource !== undefined)
        : (
            await api(context).list(
              apiVersion,
              kind === "Secret" ? "ConfigMap" : kind,
              context.namespace.name,
              undefined,
              undefined,
              undefined,
              undefined,
              `${MANAGED}=${sha256Hex(this.id, 20)},${OWNER}=${context.namespace.id}`,
            )
          ).items;
      for (const candidate of resources) {
        if (
          !exact &&
          suffix === "-material" &&
          !/^strands-[a-f0-9]{32}$/u.test(candidate.metadata?.name ?? "")
        ) {
          continue;
        }
        const resource =
          !exact && kind === "Secret"
            ? await read(context, {
                apiVersion,
                kind,
                metadata: {
                  namespace: context.namespace.name,
                  name: candidate.metadata!.name! + suffix,
                },
              })
            : { ...candidate, apiVersion, kind };
        if (!resource) {
          continue;
        }
        owned(resource, context.namespace.id, this.id);
        const uid = resource.metadata?.uid;
        if (!uid) {
          throw new Error("Cannot remove a Strands Box resource without its exact UID.");
        }
        if (kind === "Deployment" && staged) {
          const pin = await read(context, {
            apiVersion: "v1",
            kind: "ConfigMap",
            metadata: {
              name: resource.metadata!.name! + "-listener",
              namespace: context.namespace.name,
            },
          });
          if (pin && asRecord(asRecord(pin)?.data)?.deploymentUid !== uid) {
            throw new Error("Refusing to retire a replacement Box execution.");
          }
        }
        try {
          await api(context).delete(
            resource,
            undefined,
            undefined,
            undefined,
            undefined,
            "Foreground",
            { preconditions: { uid } },
          );
        } catch (error) {
          if (!missing(error)) {
            throw error;
          }
        }
        const deadline = Date.now() + 40_000;
        while (await read(context, resource)) {
          if (Date.now() >= deadline) {
            throw new Error("Strands Box resource deletion is not yet confirmed.");
          }
          await delay(250, undefined, { signal: context.signal });
        }
      }
      if (kind === "Deployment" && (staged || !exact)) {
        // Foreground deletion does not account for an orphan. Keep the
        // listener pin and other evidence until the execution Pod is absent.
        const pin =
          exact &&
          (await read(context, {
            apiVersion: "v1",
            kind: "ConfigMap",
            metadata: { name: exact.resourceName + "-listener", namespace: context.namespace.name },
          }));
        const podUid = asRecord(asRecord(pin)?.data)?.podUid;
        const pods = await api(context).list("v1", "Pod", context.namespace.name);
        if (
          pods.metadata?._continue ||
          pods.items.some(({ metadata }) => {
            const labels = metadata?.labels;
            return (
              (podUid && metadata?.uid === podUid) ||
              (labels?.[MANAGED] === sha256Hex(this.id, 20) &&
                labels[OWNER] === context.namespace.id &&
                (!exact ||
                  (labels[AGENT] === exact.agentId && labels[REVISION] === exact.revisionId)))
            );
          })
        ) {
          throw new DependencyUnavailableError("Strands Box execution termination is unconfirmed.");
        }
      }
    }
  }
}
