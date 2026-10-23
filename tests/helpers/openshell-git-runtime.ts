import type { AgentRevision } from "../../packages/contracts/src/index.ts";
import { OpenShellGitRuntime } from "../../apps/controller/src/drivers/egress-proxy/openshell-git-runtime.ts";
import {
  createGitHubRepositoryDeliveryResolver,
  resolveGitHubRepositoryBinding,
  validateGitHubRepositoryRegistry,
} from "../../apps/controller/src/drivers/repo/github/credentials/registry.ts";
import {
  openShellProfileEndpoint,
  type OpenShellProviderCreateRequest,
  type OpenShellProviderProfile,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import type { routeStore } from "../fixtures/openshell-git-route-store.mjs";

type Entry = NonNullable<Awaited<ReturnType<OpenShellGitRuntime["entries"]["get"]>>>;
type Faults = {
  gateway?: unknown;
  material?: unknown;
  rotate?: unknown;
  onRead?: () => void;
  observe?: boolean;
  observeAfterRotate?: boolean;
  environmentLag?: boolean;
  duringObserve?: () => void;
  /** The error a named gateway call throws instead of answering, if any. */
  gatewayCall?: (method: string, name?: string) => unknown;
  /** Runs while the provider write is in flight, before it answers; given the caller's signal. */
  duringWrite?: (signal: AbortSignal) => unknown;
  /** The Sandbox does not exist yet: a first preparation bootstraps the route. */
  sandboxMissing?: boolean;
};
type Material = {
  value: string;
  expiresAt: string;
  preparationAttemptId: string;
  materialVersion: string;
  repository: string;
  providerInstanceId: string;
  repositoryId: string;
  grantId: string;
  pushRef: string;
  apiOrigin: string;
  sessionId: string;
};
type Owner = {
  material: Material;
  readOpenShellMaterial: () => Promise<Material>;
  authorizeOpenShellRequest: () => Promise<boolean>;
};
interface World {
  sandbox: {
    id: string;
    name: string;
    workspace: string;
    phase: string;
    restartCount: number;
    spec: { restart_policy: string };
  };
  supervisor: {
    supervisorSessionId: string;
    processInstanceId: string;
    networkInstanceId: string;
    attachmentEpoch: string;
  };
  calls: {
    getSandbox: number;
    observe: number;
    rotate: number;
    material: number;
    providerWrites: number;
    observedWith: (Entry["installed"] | undefined)[];
  };
  faults: Faults;
  owner: Owner;
}

const PUSH_REF = "refs/heads/review/task";
export const registry = validateGitHubRepositoryRegistry(
  {
    version: 1,
    backendId: "github-primary",
    providerInstanceId: "github-com-primary",
    appId: "12345",
    githubInstallationId: "67890",
    maximumDurationSeconds: 86400,
    repositories: [
      {
        repositoryRef: "application",
        repositoryId: "34567",
        repository: "example/application",
        namespaces: [
          {
            namespaceId: "namespace-a",
            profiles: ["git-write"],
            pushRefAllowlist: [PUSH_REF],
            transport: "git-only",
          },
        ],
      },
    ],
  },
  "github-primary",
);
const admitted = resolveGitHubRepositoryBinding(registry, {
  namespaceId: "namespace-a",
  repositoryRef: "application",
  profile: "git-write",
});
const future = () => new Date(Date.now() + 600_000).toISOString();

export function openShellGitRuntimeFixture({
  store,
  world,
  resolveDelivery = createGitHubRepositoryDeliveryResolver(registry),
}: {
  store?: ReturnType<typeof routeStore>;
  world?: World;
  resolveDelivery?: ReturnType<typeof createGitHubRepositoryDeliveryResolver>;
} = {}) {
  const revision = Object.freeze({
    id: "rev-one",
    namespaceId: "namespace-a",
    agentId: "agent-one",
    harness: { id: "codex", mode: "dedicated" },
    repositoryCredentials: {
      driver: { id: "repo-driver", implementation: "github" },
      deadlineWallMs: Date.now() + 3_600_000,
      bindings: [admitted],
    },
  }) as unknown as AgentRevision;
  // `world` shares the gateway, supervisor, faults and owner of an earlier fixture: the state a
  // restarted worker process finds (finding 2128).
  const sandbox = world?.sandbox ?? {
    id: "sandbox-id-one",
    name: "git-execution",
    workspace: "team-workspace",
    phase: "SANDBOX_PHASE_READY",
    restartCount: 0,
    spec: { restart_policy: "SANDBOX_RESTART_POLICY_NEVER" },
  };
  const supervisor = world?.supervisor ?? {
    supervisorSessionId: "session-one",
    processInstanceId: "process-one",
    networkInstanceId: "network-one",
    attachmentEpoch: "epoch-one",
  };
  const calls = world?.calls ?? {
    getSandbox: 0,
    observe: 0,
    rotate: 0,
    material: 0,
    providerWrites: 0,
    observedWith: [] as (Entry["installed"] | undefined)[],
  };
  const faults: Faults = world?.faults ?? {};
  // The gateway's own prepared Git profiles and providers, which a route's bootstrap writes
  // (oce-git- plus 32 hex digits). Any other name is the Agent's model provider.
  const prepared = /^oce-git-[0-9a-f]{32}$/;
  const profiles = new Map<string, Record<string, unknown>>();
  const providers = new Map<string, Record<string, unknown>>();
  const answer = (method: string, name?: string) => {
    const error = faults.gatewayCall?.(method, name);
    if (error) {
      throw error;
    }
  };
  const client = {
    getProvider: async (_workspace: string, name: string) => {
      answer("getProvider", name);
      return prepared.test(name) ? providers.get(name) : { type: "openai", profileWorkspace: "" };
    },
    getProviderProfile: async (_workspace: string | null, id: string) => {
      answer("getProviderProfile", id);
      return prepared.test(id)
        ? profiles.get(id)
        : { definition: { endpoints: [{ host: "api.openai.com" }], credentials: [] } };
    },
    importProviderProfile: async (_workspace: string, profile: OpenShellProviderProfile) => {
      calls.providerWrites += 1;
      answer("importProviderProfile");
      profiles.set(profile.id, {
        id: profile.id,
        resourceVersion: "1",
        annotations: profile.annotations,
        definition: {
          credentials: profile.credentials.map((credential) => ({
            name: credential.name,
            env_vars: credential.envVars,
            required: credential.required,
            auth_style: credential.authStyle,
            header_name: credential.headerName,
            stable_placeholder: credential.stablePlaceholder,
          })),
          binaries: profile.binaries.map((path) => ({ path })),
          endpoints: profile.endpoints.map(openShellProfileEndpoint),
        },
      });
    },
    createProvider: async (request: OpenShellProviderCreateRequest) => {
      calls.providerWrites += 1;
      answer("createProvider");
      const provider = {
        id: `${request.name}-id`,
        name: request.name,
        type: request.type,
        workspace: request.workspace,
        profileWorkspace: request.workspace,
        labels: request.labels,
        config: {},
        resourceVersion: "1",
      };
      providers.set(request.name, provider);
      return provider;
    },
    getSandbox: async () => {
      calls.getSandbox += 1;
      faults.onRead?.();
      answer("getSandbox");
      if (faults.gateway) {
        throw faults.gateway;
      }
      return faults.sandboxMissing ? undefined : { ...sandbox };
    },
    getGatewayInfo: async () => {
      answer("getGatewayInfo");
      if (faults.gateway) {
        throw faults.gateway;
      }
      return {
        extensions: [
          {
            configured_name: "oce-prepared-git",
            kind: "EXTENSION_KIND_SUPERVISOR_MIDDLEWARE",
            protocol_major: 1,
          },
        ],
      };
    },
    getWorkspace: async () => {
      answer("getWorkspace");
      return { id: "workspace-id-one", name: sandbox.workspace };
    },
  };
  const provider = {
    observe: async (
      binding: Entry["binding"],
      sandboxId: string,
      _signal: AbortSignal,
      installed?: Entry["installed"],
    ) => {
      calls.observe += 1;
      calls.observedWith.push(installed);
      faults.duringObserve?.();
      if (faults.environmentLag) {
        // Like the real observe(): only the provider environment moved and the supervisor has
        // not installed it yet, so the verified installation (if any) is answered unchanged.
        return installed;
      }
      if (faults.observe) {
        // The provider status does not verify yet (observe() answers undefined, never throws).
        return undefined;
      }
      // Like the real observe(): the generation it reports is the one this binding holds.
      return Object.freeze({
        credentialState: binding.credentialState,
        providerResourceVersion: binding.resourceVersion,
        sandboxId,
        ...supervisor,
      });
    },
    rotate: async (
      binding: Entry["binding"],
      release: () => Promise<Material | undefined>,
      signal: AbortSignal,
    ) => {
      const token = await release();
      // Like the real rotate(): a caller out of time sends nothing; once sent, the write is
      // not tied to the caller's signal.
      if (!token || signal.aborted) {
        return;
      }
      calls.rotate += 1;
      await faults.duringWrite?.(signal);
      if (faults.rotate) {
        throw faults.rotate;
      }
      if (faults.observeAfterRotate) {
        // The supervisor has not applied the written generation yet: the verifying read
        // that follows reports nothing until the test clears faults.observe.
        faults.observe = true;
      }
      return {
        ...binding,
        credentialState: "active",
        expiresAt: token.expiresAt,
        resourceVersion: String(Number(binding.resourceVersion) + 1),
      };
    },
  };
  const material = {
    value: "synthetic-installation-token",
    expiresAt: future(),
    preparationAttemptId: "attempt-one",
    materialVersion: "version-one",
    repository: registry.repositories[0]!.repository,
    providerInstanceId: admitted.grant.providerInstanceId,
    repositoryId: admitted.grant.repositoryId,
    grantId: admitted.grant.grantId,
    pushRef: PUSH_REF,
    apiOrigin: "https://api.github.com",
    sessionId: "session-one",
  };
  const owner: Owner = world?.owner ?? {
    readOpenShellMaterial: async () => {
      calls.material += 1;
      if (faults.material) {
        throw faults.material;
      }
      return owner.material;
    },
    material,
    authorizeOpenShellRequest: async () => true,
  };
  const entry: Entry = {
    revision,
    client: client as unknown as Entry["client"],
    provider: provider as unknown as Entry["provider"],
    bindingId: "binding_0123456789abcdefghijklmn",
    authorization: createGitHubRepositoryDeliveryResolver(registry)(revision),
    otherProviders: ["openai"],
    binding: {
      workspace: sandbox.workspace,
      sandbox: sandbox.name,
      provider: "oce-git",
      providerId: "provider-id-one",
      profileVersion: "7",
      resourceVersion: "11",
      credentialState: "bootstrap",
      expiresAt: "",
    },
    ...(store === undefined ? {} : { fence: 1 }),
    verify: (observed: { name: string }) => {
      if (observed.name !== "git-execution") {
        throw new Error("Refusing OpenShell Sandbox without exact AgentRevision ownership.");
      }
    },
  };
  const events: Readonly<Record<string, unknown>>[] = [];
  const runtime = new OpenShellGitRuntime(
    {
      registrationName: "oce-prepared-git",
      authority:
        {} as import("../../apps/controller/src/composition/egress-authority.ts").EgressAuthorityConfiguration,
    },
    resolveDelivery,
  );
  runtime["owner"] = owner;
  runtime["emit"] = (event: Readonly<Record<string, unknown>>) => events.push(event);
  runtime["routes"] = store as unknown as OpenShellGitRuntime["routes"];
  if (store !== undefined && !store.rows.has(revision.id)) {
    // The row this worker's own bootstrap left: fence 1, the bootstrap generation written.
    store.rows.set(revision.id, {
      revisionId: revision.id,
      namespaceId: revision.namespaceId,
      agentId: revision.agentId,
      workspace: sandbox.workspace,
      sandbox: sandbox.name,
      bindingId: entry.bindingId,
      fence: 1,
      operationFence: 1,
      targetMaterial: undefined,
      workerInstance: "worker-one",
      generation: {
        providerId: entry.binding.providerId,
        profileVersion: entry.binding.profileVersion,
        resourceVersion: entry.binding.resourceVersion,
        expiresAt: entry.binding.expiresAt,
        credentialState: entry.binding.credentialState,
      },
      material: undefined,
      observed: undefined,
      writePending: undefined,
      blocked: undefined,
    });
  }
  runtime["entries"].set(revision.id, Promise.resolve(entry));
  runtime["states"].set(revision.id, { entry });
  const identity = {
    sandboxId: sandbox.id,
    bindingId: entry.bindingId,
    workspace: sandbox.workspace,
    requestId: "request-one",
  };
  const f = { entry };
  const reconcile = async () => {
    // Force the refresh and backoff clocks so each call observes now.
    f.entry.nextRefreshAt = 0;
    f.entry.nextObserveAt = 0;
    await runtime["reconcile"](f.entry);
  };
  const lookup = () => runtime["lookup"](identity, AbortSignal.timeout(2_000));
  const prepare = () =>
    runtime.prepare(
      revision,
      client as unknown as Entry["client"],
      sandbox.workspace,
      sandbox.name,
      AbortSignal.timeout(2_000),
      ["openai"],
    );
  const errors = () => events.filter((event) => event.event === "worker.error");
  const denials = () => events.filter((event) => event.event === "worker.openshell-git-denied");
  return Object.assign(f, {
    runtime,
    client,
    provider,
    store,
    sandbox,
    supervisor,
    calls,
    faults,
    owner,
    events,
    reconcile,
    lookup,
    prepare,
    identity,
    errors,
    denials,
    revision,
  });
}

export async function reconciledOpenShellGitRuntimeFixture(
  options?: Parameters<typeof openShellGitRuntimeFixture>[0],
) {
  const fixture = openShellGitRuntimeFixture(options);
  await fixture.reconcile();
  return fixture;
}

/**
 * A worker about to bootstrap the route of a revision whose Sandbox does not exist yet: no
 * local entry, no persisted route, and the gateway's prepared provider written for real by the
 * runtime's own provider (finding 2210).
 */
export function bootstrappingOpenShellGitRuntimeFixture(
  options?: Parameters<typeof openShellGitRuntimeFixture>[0],
) {
  const fixture = openShellGitRuntimeFixture(options);
  fixture.runtime["entries"].clear();
  fixture.runtime["states"].clear();
  fixture.store?.rows.delete(fixture.revision.id);
  fixture.faults.sandboxMissing = true;
  return fixture;
}

export function openShellGitRuntimeWorkerAfterRestart(
  previous?: ReturnType<typeof openShellGitRuntimeFixture>,
) {
  const options = previous
    ? { world: previous, ...(previous.store === undefined ? {} : { store: previous.store }) }
    : {};
  const fixture = openShellGitRuntimeFixture(options);
  fixture.runtime["entries"].clear();
  fixture.runtime["states"].clear();
  return fixture;
}
