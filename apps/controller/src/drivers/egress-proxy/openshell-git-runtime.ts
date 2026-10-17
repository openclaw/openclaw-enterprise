import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import type { AgentRevision } from "@openclaw-enterprise/contracts";
import type { startPreparedGitHubGitOwner } from "../../backends/repository-credentials/prepared-git-owner.ts";
import type { EgressAuthorityConfiguration } from "../../composition/egress-authority.ts";
import {
  resolveGitHubRepositoryBinding,
  type GitHubRepositoryRegistry,
} from "../repo/github/credentials/registry.ts";
import type { OpenShellRepositoryMaterial } from "../repo/github/credentials/prepared-repository-git.ts";
import type {
  OpenShellGatewayClient,
  OpenShellSandboxResponse,
} from "../sandbox/openshell-gateway-client.ts";
import {
  OpenShellPreparedGitProvider,
  type OpenShellPreparedGitBinding,
  type OpenShellPreparedGitInstalled,
} from "./openshell-prepared-git-provider.ts";
import {
  createOpenShellOnlineGitAuthority,
  type OpenShellOnlineGitBinding,
  type OpenShellOnlineGitIdentity,
} from "./openshell-online-git-authority.ts";
import { bindOpenShellEgressAuthority } from "./openshell-authority.ts";

export interface OpenShellGitRuntimeConfiguration {
  readonly registrationName: string;
  readonly authority: EgressAuthorityConfiguration;
}
type Owner = Pick<
  Awaited<ReturnType<typeof startPreparedGitHubGitOwner>>,
  "readOpenShellMaterial" | "authorizeOpenShellRequest"
>;
type MaterialIdentity = Omit<OpenShellRepositoryMaterial, "value">;
interface Entry {
  readonly revision: Readonly<AgentRevision>;
  readonly client: OpenShellGatewayClient;
  readonly provider: OpenShellPreparedGitProvider;
  readonly bindingId: string;
  readonly repository: string;
  readonly otherProviders: readonly string[];
  binding: OpenShellPreparedGitBinding;
  verify?: (sandbox: OpenShellSandboxResponse) => void;
  sandboxId?: string;
  supervisor?: OpenShellPreparedGitInstalled;
  material?: MaterialIdentity;
  installed?: OpenShellPreparedGitInstalled | undefined;
  blocked?: true;
  nextRefreshAt?: number;
}
const binaries = [
  "/usr/bin/git",
  "/usr/lib/git-core/git-remote-https",
  "/usr/lib/git-core/git-remote-http",
  "/usr/libexec/git-core/git-remote-https",
  "/usr/libexec/git-core/git-remote-http",
  "/usr/bin/curl",
  "/usr/local/bin/node",
  "/usr/bin/node",
];

/** Worker-local authority. A restart deliberately requires a new revision; persisted labels
 * alone cannot adopt an old supervisor or resume a provider write whose result was lost. */
export class OpenShellGitRuntime {
  private readonly entries = new Map<string, Promise<Entry>>();
  private owner: Owner | undefined;
  private report: (() => void) | undefined;
  private stopped = new AbortController();
  private running: Promise<void> = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private server?: ReturnType<typeof createOpenShellOnlineGitAuthority>;
  readonly configuration: OpenShellGitRuntimeConfiguration;
  private readonly registry: GitHubRepositoryRegistry;
  constructor(configuration: OpenShellGitRuntimeConfiguration, registry: GitHubRepositoryRegistry) {
    this.configuration = configuration;
    this.registry = registry;
  }

  private scope(revision: Readonly<AgentRevision>) {
    const state = revision.repositoryCredentials;
    const binding = state?.bindings[0];
    if (
      !state ||
      state.bindings.length !== 1 ||
      !binding ||
      revision.harness.id !== "codex" ||
      revision.harness.mode !== "dedicated" ||
      revision.egressPlan ||
      state.deadlineWallMs <= Date.now() ||
      binding.profile !== "git-write"
    ) {
      throw new Error(
        "OpenShell prepared Git requires one live git-write binding and a dedicated Codex revision without another egress plan.",
      );
    }
    const resolved = resolveGitHubRepositoryBinding(this.registry, {
      namespaceId: revision.namespaceId,
      repositoryRef: binding.repositoryRef,
      profile: binding.profile,
    });
    const repository = this.registry.repositories.find(
      (r) => r.repositoryRef === binding.repositoryRef,
    )!;
    const policy = repository.namespaces.find((p) => p.namespaceId === revision.namespaceId)!;
    if (
      !isDeepStrictEqual(binding, resolved) ||
      policy.pushRefAllowlist?.length !== 1 ||
      !["git-only", "git-and-draft-pr"].includes(policy.transport ?? "")
    ) {
      throw new Error("OpenShell prepared Git requires the current exact registry grant.");
    }
    return { repository: repository.repository, binding, policy };
  }

  async prepare(
    revision: Readonly<AgentRevision>,
    client: OpenShellGatewayClient,
    workspace: string,
    sandbox: string,
    signal: AbortSignal,
    otherProviders: readonly string[] = [],
    otherHosts: readonly string[] = [],
  ) {
    const scope = this.scope(revision);
    if (otherHosts.some((host) => this.overlapsGit(host))) {
      throw new Error("OpenShell Git cannot share overlapping network policy.");
    }
    if (!this.owner || this.stopped.signal.aborted) {
      throw new Error("OpenShell Git worker is unavailable.");
    }
    let pending = this.entries.get(revision.id);
    if (!pending) {
      pending = (async (): Promise<Entry> => {
        await this.checkOtherProviders(client, workspace, otherProviders, signal);
        const current = await client.getSandbox({ workspace, name: sandbox }, signal);
        if (current) {
          throw new Error("OpenShell Git requires a new revision after worker restart.");
        }
        const info = await client.getGatewayInfo?.(signal);
        if (
          !Array.isArray(info?.extensions) ||
          !info.extensions.some((value) => {
            const extension = value as Record<string, unknown>;
            return (
              extension.configured_name === this.configuration.registrationName &&
              [4, "EXTENSION_KIND_SUPERVISOR_MIDDLEWARE"].includes(
                extension.kind as string | number,
              ) &&
              extension.protocol_major === 1
            );
          })
        ) {
          throw new Error("OpenShell Git middleware is not registered with the selected gateway.");
        }
        const ws = await client.getWorkspace(workspace, signal);
        if (!ws?.id) {
          throw new Error("OpenShell Git workspace identity is unavailable.");
        }
        const provider = new OpenShellPreparedGitProvider(client, {
          workspace,
          workspaceId: ws.id,
          sandbox,
          executionId: revision.id,
          repository: scope.repository,
          gitOrigin: "https://github.com",
          apiOrigin: "https://api.github.com",
          binaries,
        });
        const binding = await provider.bootstrap(signal);
        return {
          revision,
          client,
          provider,
          binding,
          repository: scope.repository,
          otherProviders: [...otherProviders],
          bindingId: randomBytes(24).toString("base64url"),
        };
      })();
      // Retain a rejected bootstrap as a stopped attempt, never silently replay its writes.
      this.entries.set(revision.id, pending);
    }
    const entry = await pending;
    if (
      entry.blocked ||
      entry.client !== client ||
      entry.binding.workspace !== workspace ||
      entry.binding.sandbox !== sandbox ||
      !isDeepStrictEqual(entry.otherProviders, otherProviders) ||
      !isDeepStrictEqual(entry.revision, revision)
    ) {
      throw new Error("OpenShell Git revision binding is unavailable.");
    }
    return {
      provider: entry.binding.provider,
      environment: [
        { name: "OCE_OPENSHELL_GIT_REPOSITORY", value: scope.repository },
        { name: "OCE_OPENSHELL_GIT_PUSH_REF", value: scope.policy.pushRefAllowlist![0]! },
        { name: "OCE_OPENSHELL_GIT_API_ORIGIN", value: "https://api.github.com" },
        ...(scope.policy.pullRequestBase
          ? [{ name: "OCE_OPENSHELL_GIT_BASE", value: scope.policy.pullRequestBase }]
          : []),
        { name: "GIT_TERMINAL_PROMPT", value: "0" },
        { name: "GIT_CONFIG_COUNT", value: "5" },
        { name: "GIT_CONFIG_KEY_0", value: "credential.helper" },
        { name: "GIT_CONFIG_VALUE_0", value: "" },
        {
          name: "GIT_CONFIG_KEY_1",
          value: `credential.https://github.com/${scope.repository}.git.helper`,
        },
        {
          name: "GIT_CONFIG_VALUE_1",
          value: "!f() { printf '%s\\n' 'username=x-access-token' \"password=$GITHUB_TOKEN\"; }; f",
        },
        { name: "GIT_CONFIG_KEY_2", value: "http.followRedirects" },
        { name: "GIT_CONFIG_VALUE_2", value: "false" },
        { name: "GIT_CONFIG_KEY_3", value: "http.sslVerify" },
        { name: "GIT_CONFIG_VALUE_3", value: "true" },
        { name: "GIT_CONFIG_KEY_4", value: "credential.useHttpPath" },
        { name: "GIT_CONFIG_VALUE_4", value: "true" },
      ],
      middlewares: {
        "oce-prepared-git": {
          name: "oce-prepared-git",
          middleware: this.configuration.registrationName,
          config: { fields: { binding_id: { stringValue: entry.bindingId } } },
          on_error: "fail_closed",
          order: 2147483647,
          endpoints: { include: ["github.com", "api.github.com"] },
        },
      },
    };
  }

  async bind(
    revisionId: string,
    verify: (sandbox: OpenShellSandboxResponse) => void,
  ): Promise<void> {
    const entry = await this.entries.get(revisionId);
    if (!entry || entry.blocked) {
      throw new Error("OpenShell Git has no admitted bootstrap.");
    }
    entry.verify = verify;
  }

  withdraw(revisionId: string): void {
    // Keep the tombstone to prevent adoption/recreation under the same execution identity.
    void this.entries.get(revisionId)?.then(
      (entry) => {
        entry.blocked = true;
        entry.installed = undefined;
      },
      () => {},
    );
  }

  withdrawNamespace(namespaceId: string): void {
    for (const pending of this.entries.values()) {
      void pending.then(
        (entry) => {
          if (entry.revision.namespaceId === namespaceId) {
            entry.blocked = true;
            entry.installed = undefined;
          }
        },
        () => {},
      );
    }
  }

  private overlapsGit(host: string): boolean {
    const normalized = host.toLowerCase().replace(/\.$/, "");
    if (!/^(?:\*\.)?[a-z0-9.-]+$/.test(normalized)) {
      return true;
    }
    return ["github.com", "api.github.com"].some(
      (target) =>
        normalized === target ||
        (normalized.startsWith("*.") && target.endsWith(normalized.slice(1))),
    );
  }

  private async checkOtherProviders(
    client: OpenShellGatewayClient,
    workspace: string,
    providers: readonly string[],
    signal: AbortSignal,
  ): Promise<void> {
    for (const name of providers) {
      const provider = await client.getProvider(workspace, name, signal);
      if (!provider) {
        throw new Error("OpenShell inference provider is unavailable.");
      }
      const profile = await client.getProviderProfile(
        provider.profileWorkspace || workspace,
        provider.type,
        signal,
      );
      const definition = profile?.definition;
      const endpoints = definition?.endpoints;
      const credentials = definition?.credentials;
      if (
        !definition ||
        !Array.isArray(endpoints) ||
        !Array.isArray(credentials) ||
        endpoints.some((value) =>
          this.overlapsGit(String((value as Record<string, unknown>).host ?? "")),
        ) ||
        credentials.some((value) =>
          ((value as Record<string, unknown>).env_vars as string[] | undefined)?.includes(
            "GITHUB_TOKEN",
          ),
        )
      ) {
        throw new Error(
          "OpenShell Git cannot share an unverified or overlapping credential provider.",
        );
      }
    }
  }

  private async observation(entry: Entry, signal: AbortSignal) {
    await this.checkOtherProviders(
      entry.client,
      entry.binding.workspace,
      entry.otherProviders,
      signal,
    );
    const sandbox = await entry.client.getSandbox(
      { workspace: entry.binding.workspace, name: entry.binding.sandbox },
      signal,
    );
    if (!sandbox?.id || !entry.verify) {
      return;
    }
    if (![2, "SANDBOX_PHASE_READY"].includes(sandbox.phase as string | number)) {
      return;
    }
    entry.verify(sandbox);
    if (
      (sandbox.restartCount ?? 0) !== 0 ||
      ![1, "SANDBOX_RESTART_POLICY_NEVER"].includes(
        sandbox.spec?.restart_policy as string | number,
      ) ||
      (entry.sandboxId && entry.sandboxId !== sandbox.id)
    ) {
      throw new Error("OpenShell Git execution was replaced.");
    }
    entry.sandboxId = sandbox.id;
    const observed = await entry.provider.observe(entry.binding, sandbox.id, signal);
    if (!observed) {
      return;
    }
    if (
      entry.supervisor &&
      ["supervisorSessionId", "processInstanceId", "networkInstanceId"].some(
        (key) =>
          entry.supervisor![key as keyof OpenShellPreparedGitInstalled] !==
          observed[key as keyof OpenShellPreparedGitInstalled],
      )
    ) {
      throw new Error("OpenShell Git supervisor was replaced.");
    }
    entry.supervisor ??= observed;
    return observed;
  }

  private async reconcile(entry: Entry): Promise<void> {
    if (
      entry.blocked ||
      !entry.verify ||
      !this.owner ||
      (entry.installed && performance.now() < (entry.nextRefreshAt ?? 0))
    ) {
      return;
    }
    const signal = AbortSignal.any([this.stopped.signal, AbortSignal.timeout(5000)]);
    try {
      // Observe the bootstrap supervisor before delivering the first usable credential.
      const observed = await this.observation(entry, signal);
      if (!observed) {
        entry.installed = undefined;
        return;
      }
      const material = await this.owner.readOpenShellMaterial(entry.revision.id, signal);
      if (!material) {
        entry.installed = undefined;
        return;
      }
      const { binding, policy } = this.scope(entry.revision);
      if (
        material.repository !== entry.repository ||
        material.providerInstanceId !== binding.grant.providerInstanceId ||
        material.repositoryId !== binding.grant.repositoryId ||
        material.grantId !== binding.grant.grantId ||
        material.pushRef !== policy.pushRefAllowlist![0] ||
        material.apiOrigin !== "https://api.github.com"
      ) {
        throw new Error("OpenShell Git material does not match admission.");
      }
      if (
        !entry.material ||
        entry.material.materialVersion !== material.materialVersion ||
        entry.material.preparationAttemptId !== material.preparationAttemptId
      ) {
        if (entry.blocked || this.stopped.signal.aborted || signal.aborted) {
          return;
        }
        entry.installed = undefined;
        entry.binding = await entry.provider.rotate(
          entry.binding,
          { value: material.value, expiresAt: material.expiresAt },
          signal,
        );
        const { value: _value, ...identity } = material;
        entry.material = identity;
      }
      const installed = await this.observation(entry, signal);
      if (
        installed?.credentialState === "active" &&
        !entry.blocked &&
        !this.stopped.signal.aborted &&
        !signal.aborted
      ) {
        entry.installed = installed;
        entry.nextRefreshAt = performance.now() + 10_000;
      }
    } catch {
      // This includes unknown provider writes: no retry, replacement, or token replay.
      entry.blocked = true;
      entry.installed = undefined;
      this.report?.();
    }
  }

  async lookup(
    identity: OpenShellOnlineGitIdentity,
    signal: AbortSignal,
  ): Promise<OpenShellOnlineGitBinding | undefined> {
    if (!this.owner || this.stopped.signal.aborted || signal.aborted) {
      return;
    }
    for (const pending of this.entries.values()) {
      const entry = await pending.catch(() => undefined);
      if (
        !entry ||
        entry.blocked ||
        !entry.installed ||
        !entry.material ||
        entry.sandboxId !== identity.sandboxId ||
        entry.bindingId !== identity.bindingId ||
        entry.binding.workspace !== identity.workspace
      ) {
        continue;
      }
      const material = entry.material;
      try {
        const observed = await this.observation(entry, signal);
        if (
          entry.blocked ||
          this.stopped.signal.aborted ||
          signal.aborted ||
          entry.material !== material ||
          !observed ||
          !isDeepStrictEqual(observed, entry.installed) ||
          Date.parse(material.expiresAt) <= Date.now()
        ) {
          return;
        }
        return {
          sandboxId: identity.sandboxId,
          bindingId: identity.bindingId,
          workspace: identity.workspace,
          executionId: entry.revision.id,
          sessionId: material.sessionId,
          providerInstanceId: material.providerInstanceId,
          repositoryId: material.repositoryId,
          grantId: material.grantId,
          repository: material.repository,
          pushRef: material.pushRef,
          ...(material.pullRequestBase ? { pullRequestBase: material.pullRequestBase } : {}),
          apiOrigin: material.apiOrigin,
          installed: {
            preparationAttemptId: material.preparationAttemptId,
            materialVersion: material.materialVersion,
          },
        };
      } catch {
        entry.blocked = true;
        entry.installed = undefined;
        this.report?.();
        return;
      }
    }
  }

  async start(owner: Owner, report?: () => void): Promise<void> {
    if (this.owner || this.stopped.signal.aborted) {
      throw new Error("OpenShell Git worker already started or stopped.");
    }
    const config = this.configuration.authority;
    const [certificate, privateKey, publicKey] = await Promise.all([
      readFile(config.certificatePath),
      readFile(config.privateKeyPath),
      readFile(config.issuerPublicKeyPath),
    ]);
    this.owner = owner;
    this.report = report;
    this.server = createOpenShellOnlineGitAuthority({
      registrationName: this.configuration.registrationName,
      budgetMs: 3000,
      identity: {
        issuer: config.issuer,
        audience: config.audience,
        keyId: config.keyId,
        publicKey,
      },
      lookupBinding: (identity, signal) => this.lookup(identity, signal),
      approve: (request, installed, signal) =>
        owner.authorizeOpenShellRequest(request, installed, signal),
    });
    try {
      await bindOpenShellEgressAuthority(
        this.server,
        `${config.host.includes(":") ? `[${config.host}]` : config.host}:${config.port}`,
        certificate,
        privateKey,
      );
    } catch (error) {
      this.server.forceShutdown();
      this.owner = undefined;
      throw error;
    } finally {
      privateKey.fill(0);
    }
    const tick = () => {
      this.running = (async () => {
        for (const pending of this.entries.values()) {
          const entry = await pending.catch(() => undefined);
          if (entry) {
            await this.reconcile(entry);
          }
        }
      })().finally(() => {
        if (!this.stopped.signal.aborted) {
          this.timer = setTimeout(tick, 1000);
        }
      });
    };
    tick();
  }

  async close(): Promise<void> {
    this.stopped.abort();
    clearTimeout(this.timer);
    this.server?.forceShutdown();
    await this.running;
    this.owner = undefined;
    this.entries.clear();
  }
}
