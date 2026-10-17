import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isGitHubWireCredential } from "../repo/github/credentials/wire-credential.ts";
import type {
  OpenShellGatewayClient,
  OpenShellProviderProfile,
  OpenShellProviderResponse,
} from "../sandbox/openshell-gateway-client.ts";

/** Operator-owned scope; never populate this from a workload request. */
export interface OpenShellPreparedGitScope {
  readonly workspace: string;
  readonly workspaceId: string;
  readonly sandbox: string;
  readonly executionId: string;
  readonly repository: string;
  /** Exact HTTPS origins, including controlled origins used for qualification. */
  readonly gitOrigin: string;
  readonly apiOrigin: string;
  readonly binaries: readonly string[];
}

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

/** Exact current installation identity; timestamps and sequence are not identity fields. */
export interface OpenShellPreparedGitInstalled {
  readonly workspace: string;
  readonly sandbox: string;
  readonly sandboxId: string;
  readonly executionId: string;
  readonly provider: string;
  readonly providerId: string;
  readonly providerResourceVersion: string;
  readonly profileVersion: string;
  readonly credentialState: "bootstrap" | "active";
  readonly attachmentEpoch: string;
  readonly providerEnvRevision: string;
  readonly configRevision: string;
  readonly policyHash: string;
  readonly supervisorSessionId: string;
  readonly processInstanceId: string;
  readonly networkInstanceId: string;
}

export class OpenShellPreparedGitProviderError extends Error {
  readonly outcome: "refused" | "unknown";

  constructor(outcome: "refused" | "unknown") {
    super(`OpenShell prepared Git provider ${outcome}; operator reconciliation is required.`);
    this.name = "OpenShellPreparedGitProviderError";
    this.outcome = outcome;
  }
}

const KEY = "GITHUB_TOKEN";
const OWNER = "openclaw.dev/prepared-git-binding";

function refuse(): never {
  throw new OpenShellPreparedGitProviderError("refused");
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
  private readonly profile: OpenShellProviderProfile;
  private readonly provider: string;

  constructor(client: OpenShellGatewayClient, scope: OpenShellPreparedGitScope) {
    if (
      !/^[a-z0-9](?:[a-z0-9-]{0,17}[a-z0-9])?$/.test(scope.workspace) ||
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(scope.sandbox) ||
      !scope.workspaceId ||
      !scope.executionId ||
      !/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(scope.repository) ||
      scope.repository.split("/").some((part) => part === "." || part === "..") ||
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
          scope.repository,
          git.origin,
          api.origin,
          scope.binaries,
        ]),
      )
      .digest("hex")
      .slice(0, 48);
    this.provider = `oce-git-${this.fingerprint.slice(0, 32)}`;
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
      endpoints: [
        [git, `/${scope.repository}.git/**`],
        [api, `/repos/${scope.repository}/pulls`],
      ].map(([target, path]) => {
        const url = target as URL;
        return {
          host: url.hostname,
          port: Number(url.port || 443),
          protocol: "rest",
          path: path as string,
          // v0.1.4 rejects its deprecated explicit TLS mode. Omission selects auto-detection,
          // not a TLS-only guarantee; admission must independently enforce the latter.
        };
      }),
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
      !isDeepStrictEqual(
        endpoints,
        this.profile.endpoints.map((endpoint) => ({
          ...endpoint,
          enforcement: "NETWORK_ENFORCEMENT_MODE_ENFORCE",
          access: "NETWORK_ACCESS_PRESET_READ_WRITE",
        })),
      )
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
    // An accepted update is not evidence that the current supervisor installed it.
    // observe() separately correlates the gateway's desired and installed identities.
    return Object.freeze({
      workspace: this.scope.workspace,
      sandbox: this.scope.sandbox,
      executionId: this.scope.executionId,
      provider: this.provider,
      providerId: provider.id,
      profile: this.profile.id,
      profileVersion,
      resourceVersion: provider.resourceVersion,
      expiresAt,
      credentialState,
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
      writing = true;
      await this.client.importProviderProfile(this.scope.workspace, this.profile, signal);
      const profileVersion = await this.profileVersion(signal);
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
        signal,
      );
      return this.binding(provider, profileVersion, token.expiresAt, credentialState);
    } catch {
      // Gateway error details and echoed payloads may contain private material. Do not attach
      // a cause. A lost write reply stays unknown; do not automatically retry or delete it.
      throw new OpenShellPreparedGitProviderError(writing ? "unknown" : "refused");
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

  /** Read current state, never a historical receipt. A stale or partial response grants nothing. */
  async observe(
    binding: OpenShellPreparedGitBinding,
    sandboxId: string,
    signal: AbortSignal,
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
      const status = await this.client.getSandboxProviderStatus(
        this.scope.workspace,
        this.scope.sandbox,
        this.provider,
        signal,
      );
      const desired = status.receipt?.desired;
      const observed = status.observed;
      const evaluatedAt = Date.parse(status.evaluatedTime ?? "");
      const observedAt = Date.parse(status.observedTime ?? "");
      const unspecified = "PROVIDER_READINESS_REASON_UNSPECIFIED";
      if (
        status.state !== "PROVIDER_READINESS_STATE_READY" ||
        (status.reason !== undefined && status.reason !== unspecified) ||
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
        observed.providerEnvRevision !== desired.providerEnvRevision ||
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
        (binding.credentialState === "active" && !(Date.parse(binding.expiresAt) > Date.now()))
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

  async rotate(
    previous: OpenShellPreparedGitBinding,
    token: OpenShellPreparedGitToken,
    signal: AbortSignal,
  ): Promise<OpenShellPreparedGitBinding> {
    previous = Object.freeze({ ...previous });
    token = Object.freeze({ ...token });
    this.token(token);
    let writing = false;
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
      writing = true;
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
        signal,
      );
      if (
        updated.id !== previous.providerId ||
        updated.resourceVersion === previous.resourceVersion
      ) {
        refuse();
      }
      return this.binding(updated, previous.profileVersion, token.expiresAt);
    } catch {
      throw new OpenShellPreparedGitProviderError(writing ? "unknown" : "refused");
    }
  }
}
