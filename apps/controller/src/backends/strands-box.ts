import { assertExecutionAdmission } from "@openclaw-enterprise/contracts";
import type { KubeConfig } from "@kubernetes/client-node";
import type {
  AgentRevision,
  CredentialProxyDriver,
  ProxyRevisionContext,
  CredentialGatewayDriver,
  EgressInstallation,
  Namespace,
  PreparedGitHubEgressLifecycle,
  SandboxDriver,
} from "@openclaw-enterprise/contracts";
import { immutableCopy } from "@openclaw-enterprise/utils";
import { isAbsolute } from "node:path";
import { isIPv4 } from "node:net";
import { isDeepStrictEqual } from "node:util";
import type { KubernetesAuthentication } from "../drivers/kubernetes/authentication.ts";
import { ExecutionKubernetes } from "../drivers/strands-box/kubernetes.ts";
import { assertStrandsInstallationProfile } from "../drivers/strands-box/installation-profile.ts";
import { StrandsInstallation } from "../drivers/strands-box/installation.ts";
import {
  COMPUTE_RELEASE_PROFILE,
  HARNESS_EGRESS_ENROLLMENT_PATH,
  harnessEgressEnrollment,
} from "../drivers/compute/egress-enrollment.ts";
import { openAiStaticProvider } from "../drivers/egress-proxy/openai-provider.ts";
import {
  credentialFreeMetadataProvider,
  githubMetadataProvider,
} from "../drivers/egress-proxy/github-metadata.ts";

export interface StrandsBoxOptions {
  readonly authorityUri: string;
  readonly authorityCaPath: string;
  readonly issuerPrivateKeyPath: string;
  readonly gatewayImage: string;
  /** Trusted execution-platform namespace; never a tenant/workload namespace. */
  readonly installationNamespace: string;
  readonly dogwoodPolicyPath: string;
  readonly issuer: string;
  readonly keyId: string;
  readonly audience: string;
  readonly qualifiedNetworkPolicy: "kubernetes-enforced";
  readonly storageClassName?: string;
  /** Resolve only the already-admitted workspace node gateway, without general workload DNS egress. */
  readonly workspaceGateway?: { readonly hostname: string; readonly address: string };
  /** Operator-owned private origin transport; never accepted from a credential source or a request. */
  readonly originOverrides?: Readonly<
    Record<string, { readonly connectIp?: string; readonly originCaPem?: string }>
  >;
}

const string = { type: "string", minLength: 1 };
const fields = {
  authorityUri: string,
  authorityCaPath: string,
  issuerPrivateKeyPath: string,
  gatewayImage: string,
  installationNamespace: string,
  dogwoodPolicyPath: string,
  issuer: string,
  keyId: string,
  audience: string,
  qualifiedNetworkPolicy: { const: "kubernetes-enforced" },
};

export const strandsCredentialProxyImplementation = {
  configurationSchema: {
    type: "object",
    additionalProperties: false,
    required: Object.keys(fields),
    properties: {
      ...fields,
      storageClassName: string,
      workspaceGateway: {
        type: "object",
        additionalProperties: false,
        required: ["hostname", "address"],
        properties: { hostname: string, address: string },
      },
      originOverrides: {
        type: "object",
        additionalProperties: {
          type: "object",
          additionalProperties: false,
          properties: { connectIp: string, originCaPem: string },
        },
      },
    },
  },
  validateConfiguration(value: unknown) {
    const options = value as StrandsBoxOptions;
    const authority = new URL(options.authorityUri);
    if (!/@sha256:[a-f\d]{64}$/.test(options.gatewayImage)) {
      throw new Error("Strands requires an immutable digest for the installed sender image.");
    }
    if (
      options.qualifiedNetworkPolicy !== "kubernetes-enforced" ||
      !isIPv4(authority.hostname) ||
      typeof options.installationNamespace !== "string" ||
      !/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/.test(options.installationNamespace) ||
      authority.origin !== options.authorityUri ||
      authority.protocol !== "https:" ||
      [options.authorityCaPath, options.issuerPrivateKeyPath, options.dogwoodPolicyPath].some(
        (p) => !isAbsolute(p),
      ) ||
      (options.workspaceGateway !== undefined &&
        (!isIPv4(options.workspaceGateway.address) ||
          !/^[\da-z][.\da-z-]{0,251}$/.test(options.workspaceGateway.hostname))) ||
      Object.values(options.originOverrides ?? {}).some((o) => o.connectIp && !isIPv4(o.connectIp))
    ) {
      throw new Error(
        "Strands requires verified HTTPS, mounted policy and trust inputs, and a qualified enforcing CNI.",
      );
    }
  },
};

export const strandsPairedImplementation = {
  configurationSchema: { type: "object", additionalProperties: false, properties: {} },
  validateConfiguration(value: unknown) {
    if (!value || Object.keys(value).length) {
      throw new Error("Configure the paired Strands Drivers on the Credential Proxy.");
    }
  },
};

interface Selection {
  readonly sandboxId: string;
  readonly proxyId: string;
  readonly credentialGatewayId?: string;
  readonly backendId?: string;
  readonly kubeConfig?: KubeConfig;
  readonly authentication?: KubernetesAuthentication;
  readonly preparedGitHub?: PreparedGitHubEgressLifecycle;
}

/** Strands supplies the trusted egress path. The selected, qualified Kubernetes runtime contains the workload. */
export function createStrandsBoxDrivers(
  value: StrandsBoxOptions,
  selection: Selection,
): {
  sandbox: SandboxDriver;
  proxy: CredentialProxyDriver;
  credentialGateway: CredentialGatewayDriver;
} {
  strandsCredentialProxyImplementation.validateConfiguration(value);
  const options = immutableCopy(value);
  const api = selection.kubeConfig ?? selection.authentication;
  if (!api) {
    throw new Error("Strands requires the selected Compute's execution Kubernetes identity.");
  }
  const kube = new ExecutionKubernetes(api);
  const implementation = "strands-box";
  const id = selection.backendId ?? selection.proxyId;
  const backend = { id, generation: 1 } as const;
  const sender = { id: id + "/sender", generation: 1 } as const;
  // Only the metadata provider can select the signed, positively credential-free exchange.
  // The sender derives the material profile from the exact admitted grant in the installation policy.
  const providers = [
    openAiStaticProvider,
    credentialFreeMetadataProvider,
    ...(selection.preparedGitHub ? [githubMetadataProvider] : []),
  ];
  function installation(context: {
    namespace: Pick<Namespace, "id" | "name">;
    revision: Pick<AgentRevision, "namespaceId" | "egressPlan" | "executionAdmission" | "id">;
    signal: AbortSignal;
  }) {
    const { namespace, revision, signal } = context;
    assertExecutionAdmission(revision);
    const plan = revision.egressPlan;
    if (
      revision.executionAdmission.mode !== "protected" ||
      !plan ||
      namespace.name === options.installationNamespace ||
      plan.execution.namespaceId !== namespace.id ||
      revision.namespaceId !== namespace.id ||
      plan.execution.revisionId !== revision.id ||
      plan.sandboxDriverId !== selection.sandboxId ||
      plan.egressDriverId !== selection.proxyId
    ) {
      throw new Error("Strands execution does not match its admitted owner.");
    }
    return new StrandsInstallation(kube, namespace.name, plan, options, signal);
  }
  function assertContext(context: ProxyRevisionContext) {
    if (!isDeepStrictEqual(context.plan, context.revision.egressPlan)) {
      throw new Error("Strands admitted plan changed.");
    }
  }
  function same(current: EgressInstallation | undefined, prior: EgressInstallation) {
    return !!current && isDeepStrictEqual({ ...current, installedAt: prior.installedAt }, prior);
  }
  const assertAvailable = (signal: AbortSignal) =>
    assertStrandsInstallationProfile(kube, options, signal);
  const proxy: CredentialProxyDriver = {
    capability: "credential_proxy",
    implementation,
    id: selection.proxyId,
    sourceControl: {
      backend,
      sender,
      resolver: { id: id + "/resolver", generation: 1 },
      providers,
      ...(selection.preparedGitHub ? { preparedGitHub: selection.preparedGitHub } : {}),
      assertAvailable,
    },
    async configureRevision(context) {
      assertContext(context);
      await assertAvailable(context.signal);
      return {
        plan: context.plan,
        configuration: { policyHash: installation(context).policyHash },
      };
    },
    async wiringStatus(context, prepared) {
      assertContext(context);
      await assertAvailable(context.signal);
      const runtime = installation(context);
      if (
        !isDeepStrictEqual(prepared.plan, context.plan) ||
        prepared.configuration.policyHash !== runtime.policyHash
      ) {
        throw new Error("Strands installation has a different admitted policy.");
      }
      return runtime.installation(sender);
    },
    async verifyInstallation(context, prior) {
      assertContext(context);
      await assertAvailable(context.signal);
      const execution = installation(context);
      // A profile upgrade must never bless the previous sender's otherwise valid seal and live signature.
      if (prior.enforcement?.policyHash !== execution.policyHash) {
        return false;
      }
      return same(await execution.installation(sender), prior);
    },
    async withdrawBinding(context, binding) {
      assertContext(context);
      // This single-binding implementation retires the execution, as the published Driver contract
      // permits. It cannot remove one binding from a live multi-binding execution.
      if (
        !context.plan.routes.length ||
        !context.plan.routes.every((r) => isDeepStrictEqual(r.binding.binding, binding))
      ) {
        throw new Error("Unknown Strands binding.");
      }
      return installation(context).remove({ retainHistory: true });
    },
    async removeRevision(context) {
      assertContext(context);
      return installation(context).remove();
    },
  };

  async function serving(
    runtime: StrandsInstallation,
    token: string,
    installed?: EgressInstallation,
  ): Promise<boolean> {
    const read = await runtime.harness("/authenticated-serving", token, 18791);
    if ([400, 404, 502, 503].includes(read.status)) {
      return false;
    }
    const observed = JSON.parse(read.text);
    if (read.status !== 200 || observed.state !== "serving") {
      return false;
    }
    const current = installed ?? (await runtime.installation(sender));
    if (!current) {
      return false;
    }
    const {
      sandboxId,
      enforcement: { instanceId, configurationId, peerKeyId },
    } = current;
    if (
      !isDeepStrictEqual(observed.installation, {
        sandboxId,
        instanceId,
        configurationId,
        peerKeyId,
      })
    ) {
      throw new Error("Strands Harness is not serving the exact released execution.");
    }
    return true;
  }

  const sandbox: SandboxDriver = {
    capability: "sandbox",
    implementation,
    id: selection.sandboxId,
    facets: ["networking", "process", "filesystem"],
    harnessResource(context) {
      return installation({ ...context, signal: AbortSignal.timeout(8_000) }).ref();
    },
    async provisionHarness(context) {
      return installation(context).provision(context);
    },
    async enrollHarness(context, installed, release) {
      const runtime = installation(context);
      // Maintenance revalidates the released app-server instead of misreading it as a fresh enrollment listener.
      if (await serving(runtime, context.transportToken, installed)) {
        return;
      }
      const port = Number(
        (
          context.requirements.environment.find((e) => e.name === "APP_SERVER_PORT") as {
            value?: string;
          }
        )?.value ?? 18790,
      );
      const harness = (body?: unknown) =>
        runtime.harness(HARNESS_EGRESS_ENROLLMENT_PATH, context.transportToken, port, body);
      const challenge = await harness();
      // A starting or already-enrolled transport is observed by the independent authenticated readiness path.
      if (challenge.status !== 200) {
        return;
      }
      const { profile, startupId, ...rest } = JSON.parse(challenge.text);
      if (
        profile !== COMPUTE_RELEASE_PROFILE ||
        !/^[\da-f]{8}[-\da-f]{28}$/.test(startupId) ||
        !isDeepStrictEqual(rest, harnessEgressEnrollment(installed.plan)) ||
        !same(await runtime.installation(sender), installed)
      ) {
        throw new Error("Strands enrollment changed before release.");
      }
      const acknowledgement = await harness(await release(startupId));
      if ([409, 410].includes(acknowledgement.status)) {
        return;
      }
      if (
        acknowledgement.status !== 200 ||
        !isDeepStrictEqual(JSON.parse(acknowledgement.text), { enrolled: true, startupId })
      ) {
        throw new Error("Strands protected Compute release was not acknowledged.");
      }
    },
    async harnessStatus(context) {
      return (await serving(installation(context), context.transportToken))
        ? { state: "serving" }
        : { state: "starting" };
    },
    async cleanup(context) {
      if (!context.revision) {
        return;
      } // Compute first cleans up every revision; Namespace deletion collects stragglers.
      if (!(await installation({ ...context, revision: context.revision }).remove())) {
        throw new Error(
          "Strands execution cleanup pending; keep the fence until termination is observed.",
        );
      }
    },
  };

  // OCC's current source management contract requires this catalog owner. All material stays in the
  // existing authoritative Resolver. Reject every legacy attachment or gateway material-write operation.
  const unsupported = async (): Promise<never> => {
    throw new Error("Strands requires protected Credential Proxy admission.");
  };
  const credentialGateway: CredentialGatewayDriver = {
    capability: "credential_gateway",
    implementation,
    id: selection.credentialGatewayId ?? id + "/source-catalog",
    async listSourceTypes() {
      return providers.map((p) => p.sourceType);
    },
    validateSourceConfig(input) {
      const provider = providers.find((p) => p.sourceType.type === input.type);
      if (!provider) {
        throw new Error("Unsupported Strands protected credential source.");
      }
      return provider.normalizeConfig(input.config);
    },
    registerSource: unsupported,
    updateSource: unsupported,
    sourceStatus: unsupported,
    async removeSource({ source }) {
      // OCC invokes this only after its reference and withdrawal fence. No live material was ever registered here.
      if (source.egress?.adoption !== "live" || !isDeepStrictEqual(source.egress.sender, sender)) {
        await unsupported();
      }
    },
    attachForRevision: unsupported,
    attachmentStatus: unsupported,
    withdraw: unsupported,
  };
  return { sandbox, proxy, credentialGateway };
}
