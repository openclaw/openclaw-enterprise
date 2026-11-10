import {
  openShellModelRequestPolicy,
  verifyModelRequestProfile,
  verifyModelRequestPolicy,
} from "../sandbox/openshell-model-request-policy.ts";
import {
  openShellGrantCredentialIdentity,
  type OpenShellTokenGrantConfiguration,
} from "./openshell-token-grant.ts";
import { wirePolicy } from "./openshell-wire-policy.ts";
import type { EgressAuthorityConfiguration } from "../../composition/egress-authority.ts";
import { bindOpenShellExchange } from "./openshell-exchange-binding.ts";
import { openShellGitMiddleware, type OpenShellGitRuntime } from "./openshell-git-runtime.ts";
import { repositoryGitDeliveryProfile, requireConfiguration } from "@openclaw-enterprise/contracts";
import type {
  CredentialProviderDefinition,
  ErrorDetail,
  RepositoryGitDeliveryProfile,
} from "@openclaw-enterprise/contracts";
import { credentialFreeMetadataProvider } from "./github-metadata.ts";
import { isDeepStrictEqual } from "node:util";
import type {
  Backend,
  CredentialSourceControl,
  ProxyWiring,
  EgressInstallation,
  ProxyPlan,
  CredentialProxyDriver,
  ProxyRevisionContext,
  SandboxDriver,
  AgentRevision,
  Namespace,
  RequestCredentialInput,
} from "@openclaw-enterprise/contracts";
import {
  CredentialProxyAdmissionError,
  CredentialProxyRepositoryOnlyError,
  DependencyUnavailableError,
  RepositoryGitProfileUnsupportedError,
  RepositoryGitSenderUnqualifiedError,
  RetryLaterError,
} from "@openclaw-enterprise/occ";
import { asRecord, immutableCopy, sha256Hex } from "@openclaw-enterprise/utils";
import { type OpenShellGateway, openShellWorkspaceName } from "../../backends/openshell.ts";
import {
  confirmSandboxAbsent,
  gatewayIdentityRefusal,
} from "../sandbox/openshell-gateway-errors.ts";
import {
  advertisesOpenShellExecutionProfile,
  openShellExchangeCapabilities as capabilities,
} from "./openshell-exchange-capabilities.ts";
import { createOpenAiStaticProvider, createOpenAiRequestProvider } from "./openai-provider.ts";
import { openShellProtectedCodexArtifacts } from "../sandbox/openshell-codex-artifacts.ts";
import { assertBoundedWorkspaceNodeRule } from "../sandbox/openshell-workspace-node-policy.ts";

/** Whether `registration` is a registered supervisor middleware advertising no execution capability. */
function registeredWithoutExecution(extensions: unknown, registration: string): boolean {
  return (
    Array.isArray(extensions) &&
    extensions.some((value) => {
      const item = asRecord(value);
      return (
        item?.configured_name === registration &&
        (item.kind === "EXTENSION_KIND_SUPERVISOR_MIDDLEWARE" || item.kind === 4) &&
        item.protocol_major === 1 &&
        ![item.required_capabilities, item.supported_capabilities].some(
          (list) =>
            Array.isArray(list) && list.some((entry) => capabilities.includes(entry as string)),
        )
      );
    })
  );
}

export interface OpenShellProxyOptions {
  readonly middlewareName: string;
  readonly repositoryMiddlewareName?: string;
  /** Installation operator promises a dedicated, operator-controlled supported stock gateway. */
  readonly observedHookPreviewWorkspace?: string;
  readonly authorityScope: "execution";
  readonly requestCredentials?: {
    readonly audience: string;
    readonly tokenEndpoint: string;
    readonly assertionSource?: OpenShellTokenGrantConfiguration["assertionSource"];
  };
}

function validRequestCredentials(input: unknown): boolean {
  const value = asRecord(input);
  if (
    !value ||
    ("assertionSource" in value
      ? Object.keys(value).length !== 3 || value.assertionSource !== "openshell_gateway"
      : Object.keys(value).length !== 2) ||
    typeof value.audience !== "string" ||
    !value.audience.trim() ||
    typeof value.tokenEndpoint !== "string" ||
    !URL.canParse(value.tokenEndpoint)
  ) {
    return false;
  }
  const endpoint = new URL(value.tokenEndpoint);
  return (
    endpoint.protocol === "https:" &&
    !endpoint.username &&
    !endpoint.password &&
    !endpoint.search &&
    !endpoint.hash &&
    endpoint.href === value.tokenEndpoint
  );
}

// Retain uint64 revisions as decimal strings: Number would lose generation precision.
function revisionNumber(value: unknown): string | undefined {
  // Proto3 omits a scalar zero; the enclosing evidence message remains mandatory.
  if (value === undefined) {
    return "0";
  }
  return typeof value === "string" &&
    /^(0|[1-9][0-9]{0,19})$/.test(value) &&
    BigInt(value) <= 18446744073709551615n
    ? value
    : undefined;
}

function enforcementEvidence(
  status: Readonly<Record<string, unknown>>,
  sandboxId: string,
  policyVersion: number,
  revisionId: string,
  options: OpenShellProxyOptions,
): EgressInstallation["enforcement"] | undefined {
  const revision = asRecord(status.revision);
  const observation = asRecord(status.loaded_policy_observation);
  const source = asRecord(revision?.policy);
  const effective = asRecord(observation?.effective_policy);
  const evidence = asRecord(observation?.enforcement);
  const registeredKey = observation?.registered_exchange_public_key;
  const authority = asRecord(asRecord(effective?.network_middlewares)?.["oce-egress"]);
  if (
    !revision ||
    !observation ||
    !source ||
    !effective ||
    !evidence ||
    !(registeredKey instanceof Uint8Array) ||
    registeredKey.byteLength !== 32 ||
    evidence.sandbox_id !== sandboxId ||
    typeof evidence.instance_id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      evidence.instance_id,
    ) ||
    revision.version !== policyVersion ||
    status.active_version !== policyVersion ||
    ![2, "POLICY_STATUS_LOADED"].includes(revision.status as string | number) ||
    evidence.policy_version !== policyVersion ||
    typeof evidence.policy_hash !== "string" ||
    !/^[0-9a-f]{64}$/.test(evidence.policy_hash) ||
    typeof revision.policy_hash !== "string" ||
    !/^[0-9a-f]{64}$/.test(revision.policy_hash) ||
    observation.source_policy_hash !== revision.policy_hash ||
    revisionNumber(evidence.config_revision) === undefined ||
    revisionNumber(evidence.provider_env_revision) === undefined ||
    authority?.execution_authority !== true ||
    authority.credential_authority !== true ||
    authority.middleware !== options.middlewareName ||
    (authority.credential_connectors !== undefined &&
      !isDeepStrictEqual(authority.credential_connectors, [])) ||
    !isDeepStrictEqual(evidence.enforced_capabilities, capabilities)
  ) {
    return undefined;
  }
  // This V1 observation trusts the registered supervisor and the producer's full
  // typed comparison, including fields outside our protobuf projection. It grants
  // no send authority. Unknown derivations must not produce an observation.
  const inertRule = observation.inert_provider_rule ?? "";
  if (inertRule === "") {
    if (
      evidence.policy_hash !== revision.policy_hash ||
      !isDeepStrictEqual(wirePolicy(source), wirePolicy(effective))
    ) {
      return undefined;
    }
  } else {
    const expectedName = `_provider_oce_runtime_${sha256Hex(revisionId, 16)}`;
    const sourceRules = asRecord(source.network_policies) ?? {};
    const effectiveRules = asRecord(effective.network_policies);
    if (
      inertRule !== expectedName ||
      evidence.policy_hash === revision.policy_hash ||
      !effectiveRules ||
      Object.hasOwn(sourceRules, expectedName) ||
      !isDeepStrictEqual(wirePolicy(effectiveRules[expectedName]), { name: expectedName }) ||
      !isDeepStrictEqual(
        wirePolicy(source),
        wirePolicy({
          ...effective,
          network_policies: Object.fromEntries(
            Object.entries(effectiveRules).filter(([name]) => name !== expectedName),
          ),
        }),
      )
    ) {
      return undefined;
    }
  }
  return {
    instanceId: evidence.instance_id,
    policyHash: evidence.policy_hash,
    peerKeyId: Buffer.from(registeredKey).toString("base64url"),
    authorityScope: "execution" as const,
    // Local change fence, not the supplier's canonical policy hash. Both supplier
    // identities and complete decoded policies must remain stable on revalidation.
    configurationId: sha256Hex(
      JSON.stringify([
        sandboxId,
        evidence.instance_id,
        policyVersion,
        observation.source_policy_hash,
        evidence.policy_hash,
        revisionNumber(evidence.config_revision),
        revisionNumber(evidence.provider_env_revision),
        capabilities,
        wirePolicy(source),
        wirePolicy(effective),
        inertRule,
      ]),
    ),
  };
}

/** Nonsecret, exact routing consumed and independently checked by the paired Sandbox. */
export function openShellEgressConfiguration(
  plan: ProxyPlan,
  options: OpenShellProxyOptions,
  revision?: Readonly<AgentRevision>,
): Readonly<Record<string, unknown>> {
  const artifacts = openShellProtectedCodexArtifacts(revision);
  if (new Set(plan.routes.map((route) => route.binding.binding.id)).size > 1) {
    throw new Error("The protected execution permits at most one binding.");
  }
  requireConfiguration(OpenShellCredentialProxyDriver, options);
  const hosts = [...new Set(plan.routes.map((route) => new URL(route.origin).hostname))];
  // Keep the authority installed for a zero-route plan. The selector names no
  // reachable rule: network_policies below remains empty, never a wildcard.
  if (!hosts.length) {
    hosts.push("deny-egress.invalid");
  }
  if (hosts.length !== 1 || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(hosts[0]!)) {
    throw new Error("Protected egress requires one literal host.");
  }
  if (plan.authorization === "online-request") {
    if (!revision) {
      throw new Error("Request authorization requires its admitted revision.");
    }
    const model = openShellModelRequestPolicy(plan, options, revision);
    if (!model || (plan.repositoryGit && !options.repositoryMiddlewareName)) {
      throw new DependencyUnavailableError("Request-authorized model delivery is unavailable.");
    }
    return immutableCopy({
      network_policies: artifacts,
      network_middlewares: {
        ...model.middlewares,
        ...(plan.repositoryGit &&
          openShellGitMiddleware(options.repositoryMiddlewareName!, plan.execution.executionId)),
      },
    });
  }
  if (plan.repositoryGit) {
    if (plan.routes.length || !options.repositoryMiddlewareName) {
      throw new DependencyUnavailableError(
        "This Credential Proxy cannot install the admitted repository plan.",
      );
    }
    // The prepared provider supplies the endpoints for the admitted GitHub scope. No generic exchange
    // authority, broad Git network rule or second credential-bearing sender accompanies it.
    return immutableCopy({
      network_policies: artifacts,
      network_middlewares: openShellGitMiddleware(
        options.repositoryMiddlewareName,
        plan.execution.executionId,
      ),
    });
  }
  return immutableCopy({
    network_policies: Object.fromEntries(
      plan.routes.map((route, index) => {
        const origin = new URL(route.origin);
        return [
          `oce-egress-${index}`,
          {
            name: `oce-egress-${index}`,
            endpoints: [
              {
                host: origin.hostname,
                ports: [Number(origin.port || 443)],
                protocol: "rest",
                enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
                access: "NETWORK_ACCESS_PRESET_FULL",
                path: route.path,
              },
            ],
          },
        ];
      }),
    ),
    network_middlewares: {
      "oce-egress": {
        name: "oce-egress",
        middleware: options.middlewareName,
        on_error: "fail_closed",
        endpoints: { include: hosts },
        credential_authority: true,
        execution_authority: true,
      },
    },
  });
}

export class OpenShellCredentialProxyDriver implements CredentialProxyDriver {
  readonly capability = "credential_proxy" as const;
  readonly implementation = "openshell";
  readonly id: string;
  readonly sourceControl: CredentialSourceControl;
  readonly requestTimeCredentials?: NonNullable<CredentialProxyDriver["requestTimeCredentials"]>;
  readonly bindExchange?: NonNullable<CredentialProxyDriver["bindExchange"]>;
  readonly bindRepositoryGit?: NonNullable<CredentialProxyDriver["bindRepositoryGit"]>;
  private readonly mandatoryEnforcement?: OpenShellGitRuntime["mandatoryEnforcement"];
  private readonly previewEnforcement?: OpenShellGitRuntime["previewEnforcement"];
  private readonly backend: Backend<OpenShellGateway>;
  private readonly sandbox: SandboxDriver;
  private readonly options: OpenShellProxyOptions;

  static readonly configurationSchema = {
    type: "object",
    additionalProperties: false,
    required: ["middlewareName", "authorityScope"],
    properties: {
      middlewareName: { type: "string", minLength: 1 },
      repositoryMiddlewareName: { type: "string", minLength: 1 },
      observedHookPreviewWorkspace: { type: "string", maxLength: 19, minLength: 1 },
      authorityScope: { type: "string", const: "execution" },
      requestCredentials: {
        type: "object",
        additionalProperties: false,
        required: ["audience", "tokenEndpoint"],
        properties: {
          audience: { type: "string", minLength: 1 },
          tokenEndpoint: { type: "string", minLength: 1 },
          assertionSource: { type: "string", const: "openshell_gateway" },
        },
      },
    },
  };

  static validateConfiguration(configuration: unknown): readonly ErrorDetail[] {
    const value = asRecord(configuration);
    if (
      !value ||
      Object.keys(value).some(
        (key) =>
          ![
            "middlewareName",
            "authorityScope",
            "repositoryMiddlewareName",
            "observedHookPreviewWorkspace",
            "requestCredentials",
          ].includes(key),
      ) ||
      typeof value.middlewareName !== "string" ||
      !value.middlewareName.trim() ||
      (value.observedHookPreviewWorkspace !== undefined &&
        (typeof value.observedHookPreviewWorkspace !== "string" ||
          !/^[a-z0-9](?:[a-z0-9-]{0,17}[a-z0-9])?$/.test(value.observedHookPreviewWorkspace))) ||
      value.authorityScope !== "execution" ||
      (value.requestCredentials !== undefined && !validRequestCredentials(value.requestCredentials))
    ) {
      return [
        {
          path: "",
          code: "INVALID_VALUE",
          message: "Invalid protected OpenShell egress configuration.",
        },
      ];
    }
    return [];
  }

  constructor(
    options: OpenShellProxyOptions,
    selection: {
      readonly id: string;
      readonly backend: Backend<OpenShellGateway>;
      readonly sandbox: SandboxDriver;
      readonly exchangeAuthority?: EgressAuthorityConfiguration;
      readonly tokenGrant?: OpenShellTokenGrantConfiguration;
      readonly bindRepositoryGit?: NonNullable<CredentialProxyDriver["bindRepositoryGit"]>;
      readonly mandatoryEnforcement?: OpenShellGitRuntime["mandatoryEnforcement"];
      readonly previewEnforcement?: OpenShellGitRuntime["previewEnforcement"];
      readonly preparedProviders?: readonly CredentialProviderDefinition[];
    },
  ) {
    requireConfiguration(OpenShellCredentialProxyDriver, options);
    if (selection.sandbox.harnessResource === undefined) {
      throw new Error("Invalid protected OpenShell egress configuration.");
    }
    if (selection.bindRepositoryGit) {
      this.bindRepositoryGit = selection.bindRepositoryGit;
    }
    const exchange = selection.exchangeAuthority;
    if (
      Boolean(options.requestCredentials) !== Boolean(selection.tokenGrant) ||
      (options.requestCredentials &&
        (!exchange ||
          options.requestCredentials.audience !== exchange.audience ||
          options.requestCredentials.tokenEndpoint !== selection.tokenGrant?.endpoint ||
          options.requestCredentials.assertionSource !== selection.tokenGrant?.assertionSource))
    ) {
      throw new Error("Request credentials require their selected authority and token grant.");
    }
    if (exchange) {
      this.bindExchange = (createProxy) =>
        bindOpenShellExchange(
          exchange,
          this.sourceControl.sender,
          createProxy,
          selection.tokenGrant && {
            registrationName: options.middlewareName,
            tokenGrant: selection.tokenGrant,
          },
        );
    }
    if (options.observedHookPreviewWorkspace && selection.previewEnforcement) {
      this.previewEnforcement = selection.previewEnforcement;
    }
    if (selection.mandatoryEnforcement) {
      this.mandatoryEnforcement = selection.mandatoryEnforcement;
    }
    this.id = selection.id;
    this.backend = selection.backend;
    this.sandbox = selection.sandbox;
    this.options = immutableCopy(options);
    if (options.requestCredentials) {
      this.requestTimeCredentials = Object.freeze({
        assertAvailable: (signal: AbortSignal) => this.assertRequestCredentialsAvailable(signal),
        verifyRequestInstallation: (context, installation, recipient) =>
          this.verifyRequestInstallation(context, installation, recipient),
      });
    }
    this.sourceControl = Object.freeze({
      backend: { id: selection.backend.id, generation: 1 },
      sender: { id: `${selection.backend.id}/supervisor`, generation: 1 },
      resolver: { id: `${selection.id}/resolver`, generation: 1 },
      providers: [
        createOpenAiStaticProvider(),
        ...(options.requestCredentials ? [createOpenAiRequestProvider()] : []),
        credentialFreeMetadataProvider,
        ...(selection.preparedProviders ?? []),
      ],
      assertAvailable: async (signal: AbortSignal, profile?: RepositoryGitDeliveryProfile) => {
        this.assertRepositoryGitProfileAvailable(profile);
        const client = this.backend.client.clientForNamespace("");
        if (!client.getGatewayInfo) {
          throw new DependencyUnavailableError(
            "The selected OpenShell counterpart does not support protected egress.",
          );
        }
        const info = await client.getGatewayInfo(signal);
        const extensions = info.extensions;
        const git =
          profile === "repository_git" ||
          profile === "github_installation" ||
          profile === "github_repository";
        const registration = git
          ? this.options.repositoryMiddlewareName
          : this.options.middlewareName;
        if (
          !registration ||
          !Array.isArray(extensions) ||
          !extensions.some((value) => {
            const item = asRecord(value);
            return (
              item?.configured_name === registration &&
              (item.kind === "EXTENSION_KIND_SUPERVISOR_MIDDLEWARE" || item.kind === 4) &&
              item.protocol_major === 1 &&
              (git ||
                (advertisesOpenShellExecutionProfile(item.required_capabilities) &&
                  advertisesOpenShellExecutionProfile(item.supported_capabilities)))
            );
          })
        ) {
          // Finding 2360: repository.openShell makes the request-phase Git service the only
          // registration. Registered with no execution capability at all, it is a configuration
          // that never serves a non-Git profile, not an outage or a partial negotiation.
          if (
            !git &&
            registration === this.options.repositoryMiddlewareName &&
            registration !== undefined &&
            registeredWithoutExecution(extensions, registration)
          ) {
            throw new CredentialProxyRepositoryOnlyError();
          }
          // A gateway state an operator fixes (registration, protocol or capability version),
          // which can also be a gateway still rolling out: a 503 that names it (finding 2536).
          throw new RetryLaterError("proxyRegistration");
        }
        // Advertise the explicitly selected assurance. The held launcher, actual policy and
        // recipient must still be verified before any usable Git credential is selected.
        if (
          profile === "github_installation" &&
          this.options.observedHookPreviewWorkspace &&
          this.previewEnforcement
        ) {
          return { profile, authorization: "request-hook-observed" as const };
        }
        if (git) {
          return { profile, authorization: "online-request" as const };
        }
      },
    });
  }

  private async assertRequestCredentialsAvailable(signal: AbortSignal): Promise<void> {
    const client = this.backend.client.clientForNamespace("");
    const info = await client.getGatewayInfo?.(signal);
    const extensions = info?.extensions;
    if (
      !this.options.requestCredentials ||
      !Array.isArray(extensions) ||
      !extensions.some((value) => {
        const item = asRecord(value);
        return (
          item?.configured_name === this.options.middlewareName &&
          (item.kind === "EXTENSION_KIND_SUPERVISOR_MIDDLEWARE" || item.kind === 4) &&
          item.protocol_major === 1
        );
      })
    ) {
      throw new RetryLaterError("proxyRegistration");
    }
  }

  private async verifyRequestInstallation(
    context: ProxyRevisionContext,
    installation: EgressInstallation,
    recipient: RequestCredentialInput["recipient"],
  ): Promise<boolean> {
    const { namespace, revision, signal } = context;
    if (
      (recipient.context !== undefined &&
        recipient.context !== openShellWorkspaceName(namespace)) ||
      installation.sandboxId !== recipient.id ||
      !isDeepStrictEqual(installation.plan, context.plan) ||
      !isDeepStrictEqual(installation.sender, this.sourceControl.sender)
    ) {
      return false;
    }
    const current = await this.requestInstallation(namespace, revision, signal, recipient.id);
    // The Worker independently qualified Git before persisting this installation. Model
    // requests recheck the full effective policy, without adopting its private Git custody.
    return (
      current !== undefined &&
      current.configurationId === installation.enforcement.requestConfigurationId &&
      current.requestCredentialIdentity === installation.enforcement.requestCredentialIdentity
    );
  }

  private async requestInstallation(
    namespace: Readonly<Namespace>,
    revision: Readonly<AgentRevision>,
    signal: AbortSignal,
    expectedSandboxId: string,
  ): Promise<EgressInstallation["enforcement"] | undefined> {
    const plan = revision.egressPlan;
    if (!plan || plan.authorization !== "online-request") {
      return undefined;
    }
    const expected = openShellModelRequestPolicy(plan, this.options, revision);
    if (!expected) {
      return undefined;
    }
    await this.assertRequestCredentialsAvailable(signal);
    const context = { namespace, revision, plan, signal };
    const ref = this.sandbox.harnessResource!(context);
    const client = this.backend.client.clientForNamespace(ref.namespaceName);
    const workspace = openShellWorkspaceName(namespace);
    const sandbox = await client.getSandbox({ workspace, name: ref.resourceName }, signal);
    if (
      !sandbox ||
      sandbox.id !== expectedSandboxId ||
      sandbox.workspace !== workspace ||
      ![2, "SANDBOX_PHASE_READY"].includes(sandbox.phase as string | number)
    ) {
      return undefined;
    }
    this.assertOwned(sandbox.annotations, context);
    const provider = await client.getProvider(workspace, expected.provider.name, signal);
    if (
      !provider ||
      provider.name !== expected.provider.name ||
      provider.workspace !== workspace ||
      !isDeepStrictEqual(provider.labels, {
        "app.kubernetes.io/managed-by": "openclaw-enterprise",
        "openclaw.dev/namespace-id": namespace.id,
        "openclaw.dev/agent-id": revision.agentId,
        "openclaw.dev/revision-id": revision.id,
      }) ||
      Object.keys(provider.config).length !== 0 ||
      provider.type !== expected.provider.profile.id ||
      provider.profileWorkspace !== workspace ||
      !Array.isArray(sandbox.spec?.providers) ||
      sandbox.spec.providers.length !== (plan.repositoryGit ? 3 : 2) ||
      sandbox.spec.providers[0] !== provider.name ||
      sandbox.spec.providers[1] !== `oce-runtime-${sha256Hex(revision.id, 16)}`
    ) {
      return undefined;
    }
    const gatewayAssertion =
      this.options.requestCredentials?.assertionSource === "openshell_gateway";
    const requestCredentialIdentity =
      gatewayAssertion && provider.id
        ? openShellGrantCredentialIdentity(
            provider.id,
            expected.provider.profile.credentials[0]!.name,
          )
        : undefined;
    if (gatewayAssertion && !requestCredentialIdentity) {
      return undefined;
    }
    const profile = await client.getProviderProfile(workspace, provider.type, signal);
    verifyModelRequestProfile(profile, expected.provider.profile, workspace);
    const config = await client.getSandboxConfig?.(workspace, ref.resourceName, signal);
    verifyModelRequestPolicy(config, expected, workspace);
    const admission = sandbox.configurationAdmission;
    if (
      !config ||
      !admission ||
      admission.state !== 2 ||
      admission.error ||
      !sandbox.mainProcessInstanceId ||
      !admission.instance_id ||
      config.configuration_instance_id !== admission.instance_id ||
      config.policy_hash !== admission.policy_hash ||
      config.config_revision !== admission.config_revision ||
      config.provider_env_revision !== admission.provider_env_revision ||
      config.version !== plan.generation ||
      admission.policy_version !== config.version ||
      typeof config.policy_hash !== "string" ||
      !/^[a-f0-9]{64}$/.test(config.policy_hash)
    ) {
      return undefined;
    }
    // Git credential activation and renewal change this cross-provider material epoch.
    // Require current admission agreement above, but pin policy and identity independently.
    // Canonicalize protobuf maps, preserving ordered arrays and explicit default presence.
    const configurationId = sha256Hex(
      JSON.stringify(
        wirePolicy(
          [
            sandbox.id,
            sandbox.mainProcessInstanceId,
            { ...admission, provider_env_revision: undefined },
            provider,
            profile,
            { ...config, provider_env_revision: undefined },
          ],
          true,
        ),
      ),
    );
    return {
      instanceId: sandbox.mainProcessInstanceId,
      configurationId,
      requestConfigurationId: configurationId,
      ...(requestCredentialIdentity && { requestCredentialIdentity }),
      policyHash: config.policy_hash,
      authorityScope: "execution",
    };
  }

  /** The selected registry and runtime observer must support the requested delivery.
   * Legacy installation-wide preview remains an explicit, separate opt-in. */
  protected assertRepositoryGitProfileAvailable(
    profile: RepositoryGitDeliveryProfile | undefined,
  ): void {
    if (
      (profile === "repository_git" || profile === "github_repository") &&
      !this.mandatoryEnforcement
    ) {
      throw new RepositoryGitSenderUnqualifiedError();
    }
    if (
      profile === "github_installation" &&
      !(this.options.observedHookPreviewWorkspace && this.previewEnforcement)
    ) {
      // An Installation setting no retry changes: a 409 like the git-write refusal above
      // (finding 2536). Protected Git always composes the preview enforcement, so only the
      // Proxy's observedHookPreviewWorkspace opt-in is missing.
      throw new CredentialProxyAdmissionError("installationPreview");
    }
  }

  async configureRevision(context: ProxyRevisionContext): Promise<ProxyWiring> {
    this.assertPlan(context);
    const configuration = openShellEgressConfiguration(
      context.plan,
      this.options,
      context.revision,
    );
    const profile = repositoryGitDeliveryProfile(context.plan.repositoryGit);
    if (context.plan.repositoryGit !== undefined && profile === undefined) {
      // Finding 2204: never check a Git plan's counterpart as an ordinary egress plan. Deploy
      // refuses it first; preparation repeats the refusal so the worker fails it at once.
      throw new RepositoryGitProfileUnsupportedError(context.plan.repositoryGit.bindings.length);
    }
    if (context.plan.authorization === "online-request") {
      await this.requestTimeCredentials!.assertAvailable(context.signal);
    }
    if (profile || context.plan.authorization !== "online-request") {
      await this.sourceControl.assertAvailable(context.signal, profile);
    }
    return immutableCopy({
      plan: context.plan,
      configuration,
    });
  }

  async wiringStatus(
    context: ProxyRevisionContext,
    prepared: ProxyWiring,
  ): Promise<EgressInstallation | undefined> {
    this.assertPlan(context);
    if (!isDeepStrictEqual(prepared.plan, context.plan)) {
      throw new Error("The prepared Sandbox policy has a different admitted plan.");
    }
    const protectedConfiguration = openShellEgressConfiguration(
      context.plan,
      this.options,
      context.revision,
    );
    const expected = prepared.configuration;
    const expectedPolicies = asRecord(expected.network_policies);
    if (expectedPolicies && Object.hasOwn(expectedPolicies, "workspace-node-enrollment")) {
      assertBoundedWorkspaceNodeRule(expectedPolicies["workspace-node-enrollment"]);
    }
    // SandboxResourceRef carries the paired Sandbox's exact WorkspaceNodeBinding-derived
    // auxiliary rule. It grants no artifact authority: every other rule comes from admission.
    const canonicalPolicies = {
      ...asRecord(protectedConfiguration.network_policies),
      ...(expectedPolicies && Object.hasOwn(expectedPolicies, "workspace-node-enrollment")
        ? { "workspace-node-enrollment": expectedPolicies["workspace-node-enrollment"] }
        : {}),
    };
    if (
      !expectedPolicies ||
      !isDeepStrictEqual(
        wirePolicy(expected.network_middlewares),
        wirePolicy(protectedConfiguration.network_middlewares),
      ) ||
      !isDeepStrictEqual(wirePolicy(expectedPolicies), wirePolicy(canonicalPolicies))
    ) {
      throw new Error("The prepared Sandbox policy changed protected egress routes.");
    }
    const observed = await this.loadedPolicy(context);
    if (!observed) {
      return undefined;
    }
    const { status, sandboxId } = observed;
    const revision = asRecord(status.revision);
    const policy = asRecord(revision?.policy);
    const policies = asRecord(policy?.network_policies);
    // The authenticated supervisor must report loading the exact policy. A desired spec,
    // provider name or running Pod alone is not installation evidence.
    if (
      !revision ||
      !policy ||
      // Protobuf omits the map when deny-all has no rules (even auxiliary rules).
      (Object.keys(expectedPolicies).length > 0 && !policies) ||
      Number(status.active_version) !== context.plan.generation ||
      Number(revision.version) !== context.plan.generation ||
      ![2, "POLICY_STATUS_LOADED"].includes(revision.status as string | number) ||
      !isDeepStrictEqual(
        wirePolicy(policy.network_middlewares),
        wirePolicy(expected.network_middlewares),
      )
    ) {
      return undefined;
    }
    // The paired Sandbox supplies the entire admitted source, including filesystem,
    // process and auxiliary rules. Network-only equality cannot establish that source.
    if (!isDeepStrictEqual(wirePolicy(policy), wirePolicy(expected))) {
      throw new DependencyUnavailableError(
        "The installed egress source policy differs from its admitted policy.",
      );
    }
    const enforcement = await observed.enforcement();
    return enforcement === undefined
      ? undefined
      : immutableCopy({
          plan: context.plan,
          sandboxId,
          sender: this.sourceControl.sender,
          installedAt: new Date().toISOString(),
          enforcement,
        });
  }

  async verifyInstallation(
    context: ProxyRevisionContext,
    installation: EgressInstallation,
  ): Promise<boolean> {
    this.assertPlan(context);
    if (
      typeof installation.sandboxId !== "string" ||
      installation.sandboxId.length === 0 ||
      !installation.enforcement ||
      !isDeepStrictEqual(installation.plan, context.plan) ||
      !isDeepStrictEqual(installation.sender, this.sourceControl.sender)
    ) {
      return false;
    }
    // Compare the same live registration, effective configuration and recipient. In the
    // observed preview this is a fresh observation, not a stock lock against operator changes.
    const observed = await this.loadedPolicy(context, installation.sandboxId);
    return isDeepStrictEqual(await observed?.enforcement(), installation.enforcement);
  }

  private async loadedPolicy(context: ProxyRevisionContext, expectedSandboxId?: string) {
    if (context.plan.authorization === "online-request") {
      await this.requestTimeCredentials!.assertAvailable(context.signal);
    }
    if (context.plan.repositoryGit || context.plan.authorization !== "online-request") {
      await this.sourceControl.assertAvailable(
        context.signal,
        repositoryGitDeliveryProfile(context.plan.repositoryGit),
      );
    }
    const ref = this.sandbox.harnessResource!(context);
    const client = this.backend.client.clientForNamespace(ref.namespaceName);
    const workspace = openShellWorkspaceName(context.namespace);
    const name = ref.resourceName;
    const existing = await client.getSandbox({ workspace, name }, context.signal);
    if (
      !existing ||
      (expectedSandboxId !== undefined &&
        (existing.id !== expectedSandboxId || !client.getSandboxPolicyStatus))
    ) {
      return undefined;
    }
    this.assertOwned(existing.annotations, context);
    if (!existing.id || !client.getSandboxPolicyStatus) {
      return undefined;
    }
    const status = await client.getSandboxPolicyStatus(workspace, name, context.signal);
    const sandboxId = existing.id;
    return {
      status,
      sandboxId,
      enforcement: async () => {
        const model =
          context.plan.authorization === "online-request"
            ? await this.requestInstallation(
                context.namespace,
                context.revision,
                context.signal,
                sandboxId,
              )
            : undefined;
        if (context.plan.authorization === "online-request" && !model) {
          return undefined;
        }
        const existing = context.plan.repositoryGit
          ? context.plan.repositoryGitAuthorization === "request-hook-observed" &&
            context.revision.executionAdmission.version === 6 &&
            workspace === this.options.observedHookPreviewWorkspace
            ? await this.previewEnforcement?.(context, sandboxId)
            : this.mandatoryEnforcement
              ? await this.mandatoryEnforcement(context, sandboxId)
              : this.repositoryGitEnforcement(context, status, sandboxId)
          : (model ??
            enforcementEvidence(
              status,
              sandboxId,
              context.plan.generation,
              context.revision.id,
              this.options,
            ));
        if (!existing || !model || !context.plan.repositoryGit) {
          return existing;
        }
        // Keep Git's independently verified recipient while fencing the model provider too.
        return {
          ...existing,
          requestConfigurationId: model.configurationId,
          ...(model.requestCredentialIdentity && {
            requestCredentialIdentity: model.requestCredentialIdentity,
          }),
          configurationId: sha256Hex(
            JSON.stringify([existing.configurationId, model.configurationId]),
          ),
        };
      },
    };
  }

  /** An independently qualified Driver may override this observer. The bundled runtime
   * uses its mandatory request challenge and exact current installation instead. */
  protected repositoryGitEnforcement(
    _context: ProxyRevisionContext,
    _status: Readonly<Record<string, unknown>>,
    _sandboxId: string,
  ): EgressInstallation["enforcement"] | undefined {
    return undefined;
  }

  async removeRevision(context: ProxyRevisionContext): Promise<boolean> {
    this.assertPlan(context);
    const ref = this.sandbox.harnessResource!(context);
    const client = this.backend.client.clientForNamespace(ref.namespaceName);
    const workspace = openShellWorkspaceName(context.namespace);
    const selector = { workspace, name: ref.resourceName };
    const unconfirmed = `the protected Sandbox ${ref.resourceName} cannot be confirmed removed`;
    const refused = gatewayIdentityRefusal(workspace, unconfirmed);
    const read = () => client.getSandbox(selector, context.signal);
    // OpenShell answers NOT_FOUND alike for a removed Sandbox and for one this identity may
    // not see, so a missing Sandbox is removed only once GetWorkspace proves the identity
    // still sees the Workspace and a second read still finds none (findings 1670, 1692,
    // 2055). A credential-less Sandbox is otherwise recorded withdrawn while it runs.
    const absent = () =>
      confirmSandboxAbsent(
        client,
        workspace,
        context.signal,
        refused,
        () => new Error(`OpenShell reports no Workspace ${workspace}, so ${unconfirmed}.`),
        read,
      );
    const existing = (await refused(read)) ?? (await absent());
    if (!existing) {
      return true;
    }
    this.assertOwned(existing.annotations, context);
    await refused(() => client.deleteSandbox(selector, context.signal));
    return ((await refused(read)) ?? (await absent())) === undefined;
  }

  private assertPlan(context: ProxyRevisionContext): void {
    if (
      !isDeepStrictEqual(context.plan, context.revision.egressPlan) ||
      context.plan.egressDriverId !== this.id ||
      context.plan.sandboxDriverId !== this.sandbox.id ||
      context.plan.execution.namespaceId !== context.namespace.id ||
      context.plan.execution.revisionId !== context.revision.id
    ) {
      throw new Error("Protected egress plan does not match its admitted owner.");
    }
  }

  private assertOwned(
    annotations: Readonly<Record<string, string>>,
    context: ProxyRevisionContext,
  ): void {
    if (
      annotations["openclaw.dev/namespace-id"] !== context.namespace.id ||
      annotations["openclaw.dev/agent-id"] !== context.revision.agentId ||
      annotations["openclaw.dev/revision-id"] !== context.revision.id
    ) {
      throw new Error("Protected Sandbox ownership differs from admission.");
    }
  }
}
