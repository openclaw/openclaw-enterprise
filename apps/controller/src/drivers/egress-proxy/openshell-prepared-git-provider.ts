import type { RepositoryGitRecipient } from "@openclaw-enterprise/contracts";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { observeOpenShellGitPredecessor } from "./openshell-expired-git.ts";
import {
  DependencyUnavailableError,
  SandboxGatewayUnavailableError,
} from "@openclaw-enterprise/occ";
import { openShellInstallationGitProviderPrefix } from "../repo/credentials/protected-repository-git-installation.ts";
import { isGitHubWireCredential } from "../repo/github/credentials/wire-credential.ts";
import {
  openShellProfileEndpoint,
  type OpenShellGatewayClient,
  type OpenShellProviderProfile,
  type OpenShellProviderResponse,
  type OpenShellSandboxProviderStatus,
} from "../sandbox/openshell-gateway-client.ts";

/** Operator-owned scope; never populate this from a workload request. */
export type OpenShellPreparedGitDelivery =
  | { readonly repository: string; readonly installationId?: never }
  | { readonly repository?: never; readonly installationId: string };

export type OpenShellPreparedGitScope = OpenShellPreparedGitDelivery & {
  readonly workspace: string;
  readonly workspaceId: string;
  /** Only the v6 operator-isolated preview requires a known, completed stock receipt. */
  readonly observedHookPreview?: true;
  readonly sandbox: string;
  readonly executionId: string;
  /** Exact HTTPS origins, including controlled origins used for qualification. */
  readonly gitOrigin: string;
  readonly apiOrigin: string;
  readonly binaries: readonly string[];
};

/** Only the credential worker supplies this value; no App signing key or OAuth material. */
export interface OpenShellPreparedGitToken {
  readonly value: string;
  readonly expiresAt: string;
}

export interface OpenShellPreparedGitBinding {
  readonly workspace: string;
  readonly sandbox: string;
  readonly executionId: string;
  readonly provider: string;
  readonly providerId: string;
  readonly profile: string;
  readonly profileVersion: string;
  readonly resourceVersion: string;
  readonly expiresAt: string;
  readonly credentialState: "bootstrap" | "active";
  readonly update: "accepted";
  readonly supervisor: "unknown";
  readonly readiness: {
    readonly rpc: "GetSandboxProviderStatus";
    readonly workspace: string;
    readonly sandbox: string;
    readonly provider: string;
  };
}

/** The provider generation this worker's own last write left: the facts a restarted worker
 * persists to re-adopt the route (finding 2128). Identity and versions only, never a token. */
export type OpenShellPreparedGitGeneration = Pick<
  OpenShellPreparedGitBinding,
  "providerId" | "profileVersion" | "resourceVersion" | "expiresAt" | "credentialState"
>;

/** Exact current installation identity; timestamps and sequence are not identity fields. */
export interface OpenShellPreparedGitInstalled extends RepositoryGitRecipient {
  readonly workspace: string;
  readonly sandbox: string;
  readonly sandboxId: string;
  readonly executionId: string;
  readonly provider: string;
  readonly providerResourceVersion: string;
  readonly profileVersion: string;
  readonly credentialState: "bootstrap" | "active";
  readonly providerEnvRevision: string;
  readonly configRevision: string;
  readonly policyHash: string;
  readonly supervisorSessionId: string;
}

/** The class of a failed gateway read behind a refusal: a fixed token, never the gateway's
 * text or an error object (finding 2136). An unknown write carries none. */
export type OpenShellPreparedGitReadFailure =
  "gateway_unavailable" | "gateway_request_failed" | "timeout";

export class OpenShellPreparedGitProviderError extends Error {
  readonly outcome: "refused" | "unknown";
  /** Set only on a refusal that happened because a read before the write failed. */
  readonly readFailure: OpenShellPreparedGitReadFailure | undefined;

  constructor(outcome: "refused" | "unknown", readFailure?: OpenShellPreparedGitReadFailure) {
    super(`OpenShell prepared Git provider ${outcome}; operator reconciliation is required.`);
    this.name = "OpenShellPreparedGitProviderError";
    this.outcome = outcome;
    this.readFailure = readFailure;
  }
}

const KEY = "GITHUB_TOKEN";
const OWNER = "openclaw.dev/prepared-git-binding";
const REPOSITORY_PROVIDER_PREFIX = "oce-git-";

function refuse(): never {
  throw new OpenShellPreparedGitProviderError("refused");
}

/**
 * How long a provider write may run once it is sent. The caller's signal bounds the reads
 * before it and decides whether the write starts; it never abandons a write in flight, which
 * would leave its outcome unknown and close the route for good (finding 2211). The gateway
 * client's own request deadline (10 s by default) normally ends a hung call first.
 */
const WRITE_TIMEOUT_MS = 30_000;

/** Classifies a failed gateway read behind a refusal. The provider's own refusals (refuse(),
 * a mismatched profile) classify as nothing: the write was refused, not merely unobserved.
 * A read the caller's signal ended (its budget, or the worker stopping) is a timeout, whatever
 * the signal's reason. A refused identity (gRPC PERMISSION_DENIED or UNAUTHENTICATED) is not a
 * read failure: it stays a refusal, never retried. */
function readFailure(
  error: unknown,
  signal: AbortSignal,
): OpenShellPreparedGitReadFailure | undefined {
  const code = (error as { readonly code?: unknown } | null)?.code;
  if (error instanceof OpenShellPreparedGitProviderError || code === 7 || code === 16) {
    return undefined;
  }
  if (error instanceof SandboxGatewayUnavailableError) {
    return "gateway_unavailable";
  }
  if (error instanceof DependencyUnavailableError) {
    return "gateway_request_failed";
  }
  if (
    signal.aborted ||
    (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
  ) {
    return "timeout";
  }
  return undefined;
}

function origin(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    !/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(url.hostname)
  ) {
    refuse();
  }
  return url;
}

/**
 * Private operator-plane provisioning, prior to Sandbox attachment/admission. The supplied
 * client must use the installation's authenticated gateway connection; never expose it to
 * workload callers. This class neither attaches a provider nor releases workload execution.
 *
 * Composition owns profile/policy writers and the current sandbox identity. Stock CAS
 * checks only resource version; its request-phase and TLS-reporting limitations remain
 * explicit restricted-dogfood risks. Provider endpoints do not enforce refs or PR bodies.
 */
export class OpenShellPreparedGitProvider {
  private readonly client: OpenShellGatewayClient;
  private readonly scope: OpenShellPreparedGitScope;
  private readonly fingerprint: string;
  private receipt?: { version: string; id?: string; complete?: true };

  private refreshReceipt?: { version: string; id?: string; complete?: true };

  private readonly profile: OpenShellProviderProfile;
  private readonly provider: string;

  constructor(client: OpenShellGatewayClient, scope: OpenShellPreparedGitScope) {
    if (
      !/^[a-z0-9](?:[a-z0-9-]{0,17}[a-z0-9])?$/.test(scope.workspace) ||
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(scope.sandbox) ||
      !scope.workspaceId ||
      !scope.executionId ||
      (scope.installationId !== undefined
        ? !/^[1-9][0-9]*$/.test(scope.installationId) ||
          scope.repository !== undefined ||
          scope.apiOrigin !== "https://api.github.com" ||
          scope.gitOrigin !== "https://github.com"
        : !/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(scope.repository) ||
          scope.repository.split("/").some((part) => part === "." || part === "..")) ||
      scope.binaries.length === 0 ||
      scope.binaries.some(
        (path) => !/^\/[A-Za-z0-9_./-]+$/.test(path) || path.split("/").includes(".."),
      )
    ) {
      refuse();
    }
    const git = origin(scope.gitOrigin);
    const api = origin(scope.apiOrigin);
    this.client = client;
    this.scope = Object.freeze({ ...scope, binaries: Object.freeze([...scope.binaries]) });
    this.fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          scope.workspace,
          scope.workspaceId,
          scope.sandbox,
          scope.executionId,
          scope.installationId ? ["github-installation", scope.installationId] : scope.repository,
          git.origin,
          api.origin,
          scope.binaries,
        ]),
      )
      .digest("hex")
      .slice(0, 48);
    const prefix = scope.installationId
      ? openShellInstallationGitProviderPrefix
      : REPOSITORY_PROVIDER_PREFIX;
    this.provider = prefix + this.fingerprint.slice(0, 32);
    this.profile = {
      id: this.provider,
      displayName: "Prepared Git installation token",
      category: "PROVIDER_PROFILE_CATEGORY_OTHER",
      credentials: [
        {
          name: "installation_token",
          envVars: [KEY],
          required: true,
          authStyle: "bearer",
          headerName: "authorization",
          stablePlaceholder: true,
        },
      ],
      // This profile bounds transport, not credential placement or GitHub permissions. Release
      // must independently verify the mandatory request phase, verified TLS and sole recipient.
      endpoints: scope.installationId
        ? [
            {
              host: git.hostname,
              port: 443,
              protocol: "rest",
              rules: [
                { allow: { method: "GET", path: "/**/info/refs" } },
                { allow: { method: "POST", path: "/**/git-upload-pack" } },
                { allow: { method: "POST", path: "/**/git-receive-pack" } },
              ],
            },
            {
              host: api.hostname,
              port: 443,
              protocol: "rest",
              access: "NETWORK_ACCESS_PRESET_FULL",
            },
            {
              host: api.hostname,
              port: 443,
              protocol: "graphql",
              path: "/graphql",
              access: "NETWORK_ACCESS_PRESET_FULL",
            },
          ]
        : [
            {
              host: git.hostname,
              port: Number(git.port || 443),
              protocol: "rest",
              path: "/" + scope.repository + ".git/**",
            },
            {
              host: api.hostname,
              port: Number(api.port || 443),
              protocol: "rest",
              path: "/repos/" + scope.repository + "/pulls",
            },
          ],
      binaries: this.scope.binaries,
      inferenceCapable: false,
      annotations: { [OWNER]: this.fingerprint },
    };
  }

  private token(token: OpenShellPreparedGitToken): void {
    const expires = Date.parse(token.expiresAt);
    const remaining = expires - Date.now();
    if (
      !isGitHubWireCredential(token.value) ||
      token.value.includes("openshell:resolve:") ||
      !Number.isFinite(expires) ||
      remaining <= 0 ||
      remaining > 3_600_000 ||
      new Date(expires).toISOString().replace(".000Z", "Z") !==
        token.expiresAt.replace(".000Z", "Z")
    ) {
      refuse();
    }
  }

  private async workspace(signal: AbortSignal): Promise<void> {
    const workspace = await this.client.getWorkspace(this.scope.workspace, signal);
    if (workspace?.name !== this.scope.workspace || workspace.id !== this.scope.workspaceId) {
      refuse();
    }
  }

  private async profileVersion(signal: AbortSignal, expected?: string): Promise<string> {
    const stored = await this.client.getProviderProfile(
      this.scope.workspace,
      this.profile.id,
      signal,
    );
    if (
      !stored ||
      !/^[1-9]\d*$/.test(stored.resourceVersion) ||
      stored.annotations[OWNER] !== this.fingerprint ||
      (expected !== undefined && stored.resourceVersion !== expected)
    ) {
      refuse();
    }
    // Compare the gateway's non-secret definition, not only caller-authored ownership labels.
    const definition = stored.definition;
    const credentials = definition?.credentials as readonly Record<string, unknown>[] | undefined;
    const endpoints = definition?.endpoints as readonly Record<string, unknown>[] | undefined;
    if (
      !definition ||
      definition.inference_capable === true ||
      (Array.isArray(definition.files) && definition.files.length > 0) ||
      credentials?.length !== 1 ||
      credentials[0]?.name !== "installation_token" ||
      !isDeepStrictEqual(credentials[0]?.env_vars, [KEY]) ||
      credentials[0]?.required !== true ||
      credentials[0]?.stable_placeholder !== true ||
      credentials[0]?.auth_style !== "bearer" ||
      credentials[0]?.header_name !== "authorization" ||
      credentials[0]?.refresh !== undefined ||
      !isDeepStrictEqual(
        definition.binaries,
        this.scope.binaries.map((path) => ({ path })),
      ) ||
      !isDeepStrictEqual(endpoints, this.profile.endpoints.map(openShellProfileEndpoint))
    ) {
      refuse();
    }
    return stored.resourceVersion;
  }

  private binding(
    provider: OpenShellProviderResponse,
    profileVersion: string,
    expiresAt: string,
    credentialState: "bootstrap" | "active" = "active",
  ): OpenShellPreparedGitBinding {
    if (
      provider.name !== this.provider ||
      provider.type !== this.profile.id ||
      !provider.id ||
      provider.workspace !== this.scope.workspace ||
      provider.profileWorkspace !== this.scope.workspace ||
      provider.labels[OWNER] !== this.fingerprint ||
      !/^[1-9]\d*$/.test(provider.resourceVersion) ||
      Object.keys(provider.config).length !== 0
    ) {
      refuse();
    }
    return this.bindingForGeneration({
      providerId: provider.id,
      profileVersion,
      resourceVersion: provider.resourceVersion,
      expiresAt,
      credentialState,
    });
  }

  private bindingForGeneration(
    generation: OpenShellPreparedGitGeneration,
  ): OpenShellPreparedGitBinding {
    // Neither a confirmed write nor a restored generation proves supervisor installation.
    // observe() separately correlates the gateway's desired and installed identities.
    return Object.freeze({
      workspace: this.scope.workspace,
      sandbox: this.scope.sandbox,
      executionId: this.scope.executionId,
      provider: this.provider,
      providerId: generation.providerId,
      profile: this.profile.id,
      profileVersion: generation.profileVersion,
      resourceVersion: generation.resourceVersion,
      expiresAt: generation.expiresAt,
      credentialState: generation.credentialState,
      update: "accepted",
      supervisor: "unknown",
      readiness: Object.freeze({
        rpc: "GetSandboxProviderStatus",
        workspace: this.scope.workspace,
        sandbox: this.scope.sandbox,
        provider: this.provider,
      }),
    });
  }

  async prepare(
    token: OpenShellPreparedGitToken,
    signal: AbortSignal,
  ): Promise<OpenShellPreparedGitBinding> {
    token = Object.freeze({ ...token });
    this.token(token);
    return this.create(token, "active", signal);
  }

  /**
   * The binding of a generation this worker's own earlier write left, from the persisted
   * route of a restarted worker (finding 2128). No gateway read and no evidence: observe()
   * verifies these facts against the gateway before the route reopens, and a generation
   * that does not verify never reopens it. The last generation can be expired: observe() still refuses it.
   * Only observePredecessor() may then identify the installation for standing succession.
   */
  restore(
    generation: OpenShellPreparedGitGeneration,
    standing = false,
  ): OpenShellPreparedGitBinding {
    const expires = Date.parse(generation.expiresAt);
    if (
      !generation.providerId ||
      !/^[1-9]\d*$/.test(generation.profileVersion) ||
      !/^[1-9]\d*$/.test(generation.resourceVersion) ||
      (generation.credentialState === "active"
        ? !Number.isFinite(expires)
        : generation.credentialState !== "bootstrap")
    ) {
      refuse();
    }
    const expired = !standing && generation.credentialState === "active" && expires <= Date.now();
    return this.bindingForGeneration({
      providerId: generation.providerId,
      profileVersion: generation.profileVersion,
      resourceVersion: generation.resourceVersion,
      expiresAt: expired ? "" : generation.expiresAt,
      credentialState: expired ? "bootstrap" : generation.credentialState,
    });
  }

  /** Creates an unprivileged provider so the sandbox can start before token preparation. */
  async bootstrap(signal: AbortSignal): Promise<OpenShellPreparedGitBinding> {
    return this.create(
      { value: "oce-unprivileged-bootstrap-sentinel", expiresAt: "" },
      "bootstrap",
      signal,
    );
  }

  private async create(
    token: OpenShellPreparedGitToken,
    credentialState: "bootstrap" | "active",
    signal: AbortSignal,
  ): Promise<OpenShellPreparedGitBinding> {
    let writing = false;
    try {
      await this.workspace(signal);
      if (
        (await this.client.getProviderProfile(this.scope.workspace, this.profile.id, signal)) ||
        (await this.client.getProvider(this.scope.workspace, this.provider, signal))
      ) {
        refuse();
      }
      // A caller out of time sends nothing: refused before the write, so it can be retried.
      signal.throwIfAborted();
      writing = true;
      const write = AbortSignal.timeout(WRITE_TIMEOUT_MS);
      await this.client.importProviderProfile(this.scope.workspace, this.profile, write);
      const profileVersion = await this.profileVersion(write);
      const provider = await this.client.createProvider(
        {
          workspace: this.scope.workspace,
          name: this.provider,
          type: this.profile.id,
          labels: { [OWNER]: this.fingerprint },
          credentials: { [KEY]: token.value },
          ...(credentialState === "active"
            ? { credentialExpirationTimes: { [KEY]: token.expiresAt } }
            : {}),
        },
        write,
      );
      return this.binding(provider, profileVersion, token.expiresAt, credentialState);
    } catch (error) {
      // Gateway error details and echoed payloads may contain private material: no cause, only
      // the failed read's class as a token. A lost write reply stays unknown; do not
      // automatically retry or delete it.
      throw new OpenShellPreparedGitProviderError(
        writing ? "unknown" : "refused",
        writing ? undefined : readFailure(error, signal),
      );
    }
  }

  private owns(binding: OpenShellPreparedGitBinding): boolean {
    return (
      binding.provider === this.provider &&
      binding.profile === this.profile.id &&
      binding.workspace === this.scope.workspace &&
      binding.sandbox === this.scope.sandbox &&
      binding.executionId === this.scope.executionId &&
      (binding.credentialState === "bootstrap" || binding.credentialState === "active")
    );
  }

  // Terminal OBSERVE history is read-only even when an old target becomes current
  // again. Its outcome never replaces original UPDATE custody or fresh READY evidence.
  private terminalReceipt(
    binding: OpenShellPreparedGitBinding,
    receipt: NonNullable<OpenShellPreparedGitProvider["receipt"]>,
    status: OpenShellSandboxProviderStatus,
  ): boolean {
    if (!receipt.id || status.receipt?.receiptId !== receipt.id) {
      return false;
    }
    return (
      status.completedOperationId === receipt.id ||
      (binding.credentialState === "active" &&
        receipt === this.refreshReceipt &&
        this.receipt?.complete === true &&
        this.receipt.version === receipt.version &&
        this.receipt.id !== receipt.id &&
        status.receipt.kind === "PROVIDER_MUTATION_KIND_OBSERVE" &&
        status.supersededObservationId === receipt.id)
    );
  }

  /** The 0.1.5 gateway may create or complete an operation here. Only the route reconciler
   * calls this; its response is not verification. observe() subsequently reads a receipt that
   * is already terminal, which stock does not update, and requires the live supervisor report. */
  async settlePreviewReceipt(
    binding: OpenShellPreparedGitBinding,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (!this.scope.observedHookPreview) {
      return true;
    }
    if (!this.receipt && binding.credentialState === "bootstrap") {
      this.receipt = { version: binding.resourceVersion };
    }
    let receipt = this.refreshReceipt ?? this.receipt;
    if (!receipt || receipt.version !== binding.resourceVersion) {
      return false;
    }
    if (receipt.complete || (receipt === this.refreshReceipt && receipt.id)) {
      const current = await this.client.getSandboxProviderStatus(
        binding.workspace,
        binding.sandbox,
        binding.provider,
        signal,
        receipt.id,
      );
      if (current.state !== "PROVIDER_READINESS_STATE_SUPERSEDED") {
        if (receipt.complete) {
          return true;
        }
      } else {
        // The original UPDATE remains custody evidence. Only the reconciler creates a
        // fresh OBSERVE; requests still read a completed receipt and verify live identity.
        // A changed aggregate environment can supersede an unchanged Git generation.
        const desired = current.receipt?.desired;
        const observed = current.observed;
        // A known pending OBSERVE can terminate SUPERSEDED/IGNORED_STALE without
        // becoming APPLIED. Replace only that observation; never infer completion
        // of the original UPDATE or accept this response as installation evidence.
        if (
          (receipt.complete
            ? !this.terminalReceipt(binding, receipt, current)
            : current.receipt?.kind !== "PROVIDER_MUTATION_KIND_OBSERVE" ||
              current.reason !== "PROVIDER_READINESS_REASON_DESIRED_STATE_CHANGED") ||
          current.receipt?.receiptId !== receipt.id ||
          !desired ||
          !observed ||
          desired.providerId !== binding.providerId ||
          desired.providerResourceVersion !== binding.resourceVersion ||
          observed.providerEnvRevision === desired.providerEnvRevision ||
          observed.attachmentEpoch !== desired.attachmentEpoch ||
          observed.configRevision !== desired.configRevision ||
          observed.policyHash !== desired.policyHash
        ) {
          return false;
        }
        receipt = this.refreshReceipt = { version: binding.resourceVersion };
      }
    }
    // Stock 0.1.6 keys OBSERVE by the full desired snapshot and capture reason.
    // Repeating an ID-less read after a lost reply reuses that durable operation;
    // it never replays the original credential UPDATE.
    const status = await this.client.getSandboxProviderStatus(
      binding.workspace,
      binding.sandbox,
      binding.provider,
      signal,
      receipt.id,
    );
    const id = status.receipt?.receiptId;
    if (
      !id ||
      (receipt.id && receipt.id !== id) ||
      status.receipt?.kind !==
        (binding.credentialState === "bootstrap" || receipt === this.refreshReceipt
          ? "PROVIDER_MUTATION_KIND_OBSERVE"
          : "PROVIDER_MUTATION_KIND_UPDATE") ||
      status.receipt.desired?.providerResourceVersion !== receipt.version
    ) {
      return false;
    }
    receipt.id = id;
    if (!this.terminalReceipt(binding, receipt, status)) {
      return false;
    }
    receipt.complete = true;
    return true;
  }

  /** The provider profile's exact credential-bearing rule, as composed by the stock 0.1.5 gateway. */
  previewNetworkRule() {
    const name = "_provider_" + this.provider.replaceAll("-", "_");
    return {
      name,
      binaries: this.scope.binaries.map((path) => ({ path })),
      endpoints: this.profile.endpoints.map((endpoint) => ({
        ...openShellProfileEndpoint(endpoint),
        provider_credentialed: true,
      })),
    };
  }

  /**
   * Read current state, never a historical receipt. A stale or partial response grants nothing.
   *
   * `installed` is the observation this binding last verified. While the Gateway's desired
   * snapshot has moved ahead of the supervisor only in the Sandbox-wide provider environment
   * revision (another provider attached to the Sandbox changed, as a sibling Agent's deploy
   * does; finding 2146), the supervisor still runs this provider's verified installation, so
   * it is answered unchanged. Any other difference answers undefined.
   */
  async observe(
    binding: OpenShellPreparedGitBinding,
    sandboxId: string,
    signal: AbortSignal,
    installed?: OpenShellPreparedGitInstalled,
  ): Promise<OpenShellPreparedGitInstalled | undefined> {
    binding = Object.freeze({ ...binding });
    if (
      !this.owns(binding) ||
      !sandboxId ||
      (binding.credentialState === "active" && !(Date.parse(binding.expiresAt) > Date.now()))
    ) {
      return undefined;
    }
    try {
      await this.workspace(signal);
      await this.profileVersion(signal, binding.profileVersion);
      const current = await this.client.getProvider(this.scope.workspace, this.provider, signal);
      if (
        !current ||
        current.id !== binding.providerId ||
        current.resourceVersion !== binding.resourceVersion
      ) {
        return undefined;
      }
      this.binding(current, binding.profileVersion, binding.expiresAt, binding.credentialState);
      const requestedAt = Date.now();
      const preview = this.scope.observedHookPreview;
      const receipt = this.refreshReceipt ?? this.receipt;
      if (
        preview &&
        (!receipt?.complete || !receipt.id || receipt.version !== binding.resourceVersion)
      ) {
        return;
      }
      const status = await this.client.getSandboxProviderStatus(
        this.scope.workspace,
        this.scope.sandbox,
        this.provider,
        signal,
        preview ? receipt!.id : undefined,
      );
      const desired = status.receipt?.desired;
      const observed = status.observed;
      const evaluatedAt = Date.parse(status.evaluatedTime ?? "");
      const observedAt = Date.parse(status.observedTime ?? "");
      const unspecified = "PROVIDER_READINESS_REASON_UNSPECIFIED";
      if (
        status.receipt?.workspace !== binding.workspace ||
        status.receipt.provider !== binding.provider ||
        !desired ||
        desired.sandboxId !== sandboxId ||
        desired.sandbox !== binding.sandbox ||
        desired.providerId !== binding.providerId ||
        desired.providerResourceVersion !== binding.resourceVersion ||
        !desired.attachmentEpoch ||
        !/^[1-9]\d*$/.test(desired.providerEnvRevision) ||
        !/^[1-9]\d*$/.test(desired.configRevision) ||
        !desired.policyHash ||
        !observed ||
        !observed.sessionId ||
        !/^[1-9]\d*$/.test(observed.sequence) ||
        observed.attachmentEpoch !== desired.attachmentEpoch ||
        !/^[1-9]\d*$/.test(observed.providerEnvRevision) ||
        observed.configRevision !== desired.configRevision ||
        observed.policyHash !== desired.policyHash ||
        !observed.credentialsInstalled ||
        !observed.policyActive ||
        !observed.launchEnvironmentInstalled ||
        !observed.processInstanceId ||
        (observed.reason !== "" && observed.reason !== unspecified) ||
        !status.networkInstanceId ||
        !Number.isFinite(evaluatedAt) ||
        evaluatedAt < requestedAt - 30_000 ||
        evaluatedAt > Date.now() + 30_000 ||
        !Number.isFinite(observedAt) ||
        observedAt > evaluatedAt ||
        (preview &&
          (evaluatedAt - observedAt >= 15_000 ||
            evaluatedAt < requestedAt - 5_000 ||
            evaluatedAt > Date.now() + 5_000 ||
            !this.terminalReceipt(binding, receipt!, status) ||
            status.receipt?.receiptId !== receipt!.id ||
            observed.providerEnvRevision !== desired.providerEnvRevision)) ||
        (binding.credentialState === "active" && !(Date.parse(binding.expiresAt) > Date.now()))
      ) {
        return undefined;
      }
      if (observed.providerEnvRevision !== desired.providerEnvRevision) {
        // The Gateway reports this as pending (snapshot mismatch) until the supervisor's next
        // settings poll installs the new environment. In OpenShell 0.1.4 (`5a7728c3`) the
        // revision hashes, per attached provider, its resource version, credential key names and
        // expiry times, refresh states and profile revision, then the policy's credential
        // bindings and any global policy (policy.rs,
        // compute_provider_env_revision_from_records_and_policy_bindings). For this provider
        // those are pinned above (resource version, profile version; its profile has no
        // refresh) or by the unchanged policy hash, so only another attached provider moved.
        // Re-check this list when the pinned OpenShell changes.
        return installed !== undefined &&
          status.state === "PROVIDER_READINESS_STATE_PENDING" &&
          status.reason === "PROVIDER_READINESS_REASON_SNAPSHOT_MISMATCH" &&
          installed.workspace === binding.workspace &&
          installed.sandbox === binding.sandbox &&
          installed.sandboxId === sandboxId &&
          installed.executionId === binding.executionId &&
          installed.provider === binding.provider &&
          installed.providerId === binding.providerId &&
          installed.providerResourceVersion === binding.resourceVersion &&
          installed.profileVersion === binding.profileVersion &&
          installed.credentialState === binding.credentialState &&
          installed.attachmentEpoch === desired.attachmentEpoch &&
          installed.configRevision === desired.configRevision &&
          installed.policyHash === desired.policyHash &&
          installed.supervisorSessionId === observed.sessionId &&
          installed.processInstanceId === observed.processInstanceId &&
          installed.networkInstanceId === status.networkInstanceId
          ? installed
          : undefined;
      }
      if (
        status.state !== "PROVIDER_READINESS_STATE_READY" ||
        (status.reason !== undefined && status.reason !== unspecified)
      ) {
        return undefined;
      }
      return Object.freeze({
        workspace: binding.workspace,
        sandbox: binding.sandbox,
        sandboxId,
        executionId: binding.executionId,
        provider: binding.provider,
        providerId: binding.providerId,
        providerResourceVersion: binding.resourceVersion,
        profileVersion: binding.profileVersion,
        credentialState: binding.credentialState,
        attachmentEpoch: desired.attachmentEpoch,
        providerEnvRevision: desired.providerEnvRevision,
        configRevision: desired.configRevision,
        policyHash: desired.policyHash,
        supervisorSessionId: observed.sessionId,
        processInstanceId: observed.processInstanceId,
        networkInstanceId: status.networkInstanceId,
      });
    } catch {
      // Read failures are unavailable evidence; never echo gateway diagnostics or token values.
      return undefined;
    }
  }

  /** Verify the exact previous installation, even if its credential expired. Never used by lookup. */
  async observePredecessor(
    binding: OpenShellPreparedGitBinding,
    previous: OpenShellPreparedGitInstalled,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (
      !this.owns(binding) ||
      binding.credentialState !== "active" ||
      previous.credentialState !== "active" ||
      previous.executionId !== binding.executionId ||
      previous.workspace !== binding.workspace ||
      previous.sandbox !== binding.sandbox ||
      previous.provider !== binding.provider ||
      previous.providerId !== binding.providerId ||
      previous.providerResourceVersion !== binding.resourceVersion ||
      previous.profileVersion !== binding.profileVersion
    ) {
      return false;
    }
    await this.workspace(signal);
    await this.profileVersion(signal, binding.profileVersion);
    const current = await this.client.getProvider(this.scope.workspace, this.provider, signal);
    if (current?.id !== binding.providerId || current.resourceVersion !== binding.resourceVersion) {
      return false;
    }
    this.binding(current, binding.profileVersion, binding.expiresAt);
    return observeOpenShellGitPredecessor(this.client, previous, signal);
  }

  /**
   * Deletes this route's provider, then its profile (finding 2206). The caller first confirms
   * the route's Sandbox gone; OpenShell also refuses to delete a provider a Sandbox still
   * attaches. A same-name object without this binding's owner fingerprint is refused, never
   * deleted.
   */
  async remove(signal: AbortSignal): Promise<void> {
    const provider = await this.client.getProvider(this.scope.workspace, this.provider, signal);
    if (provider !== undefined) {
      if (provider.labels[OWNER] !== this.fingerprint || provider.type !== this.profile.id) {
        refuse();
      }
      await this.client.deleteProvider(this.scope.workspace, this.provider, signal);
    }
    const profile = await this.client.getProviderProfile(
      this.scope.workspace,
      this.profile.id,
      signal,
    );
    if (profile !== undefined) {
      if (profile.annotations[OWNER] !== this.fingerprint) {
        refuse();
      }
      await this.client.deleteProviderProfile(this.scope.workspace, this.profile.id, signal);
    }
  }

  async rotate(
    previous: OpenShellPreparedGitBinding,
    release: () => Promise<OpenShellPreparedGitToken | undefined>,
    signal: AbortSignal,
  ): Promise<OpenShellPreparedGitBinding | undefined> {
    previous = Object.freeze({ ...previous });
    let phase: "reading" | "release" | "writing" = "reading";
    try {
      if (!this.owns(previous) || !this.client.updateProviderCredentialsConditionally) {
        refuse();
      }
      await this.workspace(signal);
      await this.profileVersion(signal, previous.profileVersion);
      const current = await this.client.getProvider(this.scope.workspace, this.provider, signal);
      if (
        !current ||
        current.id !== previous.providerId ||
        current.resourceVersion !== previous.resourceVersion
      ) {
        refuse();
      }
      this.binding(current, previous.profileVersion, previous.expiresAt);
      // This is the last await before the conditional write. Release checks the owner's current
      // approval, execution, session and material. It cannot recall a write already handed off.
      phase = "release";
      const token = await release();
      phase = "reading";
      if (!token || signal.aborted) {
        return;
      }
      this.token(token);
      phase = "writing";
      // The write runs to its own deadline, not the caller's remaining read budget (finding 2211).
      const write = AbortSignal.timeout(WRITE_TIMEOUT_MS);
      const updated = await this.client.updateProviderCredentialsConditionally(
        {
          workspace: this.scope.workspace,
          name: this.provider,
          type: this.profile.id,
          labels: { [OWNER]: this.fingerprint },
          credentials: { [KEY]: token.value },
          credentialExpirationTimes: { [KEY]: token.expiresAt },
        },
        previous.resourceVersion,
        write,
      );
      if (
        updated.id !== previous.providerId ||
        updated.resourceVersion === previous.resourceVersion
      ) {
        refuse();
      }
      if (this.scope.observedHookPreview) {
        // This is a post-write consistency check, not an atomic recipient condition. The
        // dedicated gateway's writers are qualified separately; an unexpected set is unknown
        // custody and must not be replayed. Read the *same* operation after policy reload.
        const receipts = updated.targetReceipts;
        const [target] = receipts ?? [];
        const desired = target?.desired as Record<string, unknown> | undefined;
        const id = target?.receipt_id;
        if (
          receipts?.length !== 1 ||
          typeof id !== "string" ||
          !id ||
          !updated.mutationId ||
          target?.mutation_id !== updated.mutationId ||
          target.kind !== "PROVIDER_MUTATION_KIND_UPDATE" ||
          target.workspace !== previous.workspace ||
          target.provider !== previous.provider ||
          desired?.sandbox !== previous.sandbox ||
          desired.provider_id !== previous.providerId ||
          desired.provider_resource_version !== updated.resourceVersion
        ) {
          throw new Error("OpenShell did not confirm the preview's single expected update target.");
        }
        delete this.refreshReceipt;
        this.receipt = { version: updated.resourceVersion, id };
      }
      return this.binding(updated, previous.profileVersion, token.expiresAt);
    } catch (error) {
      // Refused before the write for a read the gateway did not answer, the rotation is
      // observed again later; an unknown write is never retried (finding 2136).
      if (phase === "release") {
        throw error; // The local authority failed before this writer could send anything.
      }
      throw new OpenShellPreparedGitProviderError(
        phase === "writing" ? "unknown" : "refused",
        phase === "writing" ? undefined : readFailure(error, signal),
      );
    }
  }
}

/** Whether `name` is the name a preparation derives from the owner fingerprint it wrote. */
function preparedGitName(name: string, owner: string | undefined): boolean {
  const hash = owner?.slice(0, 32);
  return (
    owner !== undefined &&
    /^[0-9a-f]{48}$/.test(owner) &&
    (name === REPOSITORY_PROVIDER_PREFIX + hash ||
      name === openShellInstallationGitProviderPrefix + hash)
  );
}

function preparedGitProvider(provider: OpenShellProviderResponse): boolean {
  return provider.type === provider.name && preparedGitName(provider.name, provider.labels[OWNER]);
}

/**
 * Deletes one prepared Git provider and its profile, each only with the owner fingerprint its
 * preparation wrote (finding 2206). For a Sandbox's own provider when its route's scope no
 * longer names it; OpenShell refuses to delete a provider a Sandbox still attaches.
 */
export async function deleteOpenShellPreparedGitProvider(
  client: Pick<
    OpenShellGatewayClient,
    "deleteProvider" | "getProviderProfile" | "deleteProviderProfile"
  >,
  workspace: string,
  provider: OpenShellProviderResponse,
  signal: AbortSignal,
): Promise<void> {
  if (!preparedGitProvider(provider)) {
    return;
  }
  await client.deleteProvider(workspace, provider.name, signal);
  const profile = await client.getProviderProfile(workspace, provider.type, signal);
  if (profile?.annotations[OWNER] === provider.labels[OWNER]) {
    await client.deleteProviderProfile(workspace, provider.type, signal);
  }
}

/**
 * Namespace cleanup (finding 2206): deletes every prepared Git provider in `providers`, then
 * every prepared Git profile in the Workspace, before the Workspace is deleted. Its routes are
 * withdrawn and its Sandboxes gone by then; OpenShell refuses to delete a provider a Sandbox
 * still attaches. Profiles are listed, not reached through their providers, so a profile whose
 * provider is already gone (a lost CreateProvider reply, or an earlier pass that failed between
 * the two deletes) is found too. Only an object whose name derives from its owner fingerprint,
 * as a preparation wrote it, is deleted.
 */
export async function deleteOpenShellPreparedGitProviders(
  client: Pick<
    OpenShellGatewayClient,
    "deleteProvider" | "listProviderProfiles" | "deleteProviderProfile"
  >,
  workspace: string,
  providers: readonly OpenShellProviderResponse[],
  signal: AbortSignal,
): Promise<void> {
  for (const provider of providers.filter(preparedGitProvider)) {
    await client.deleteProvider(workspace, provider.name, signal);
  }
  for (const profile of await client.listProviderProfiles(workspace, signal)) {
    // The listing also returns platform and static profiles; a preparation imports into the
    // Workspace, and only that scope's profile is the Workspace's member.
    if (
      profile.definition?.scope === "workspace" &&
      preparedGitName(profile.id, profile.annotations[OWNER])
    ) {
      await client.deleteProviderProfile(workspace, profile.id, signal);
    }
  }
}
