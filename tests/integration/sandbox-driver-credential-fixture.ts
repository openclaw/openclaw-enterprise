import assert from "node:assert/strict";
import { OpenShellGateway } from "../../apps/controller/src/backends/openshell.ts";
import {
  OpenShellCredentialGatewayDriver,
  type OpenShellCredentialGatewayOptions,
} from "../../apps/controller/src/drivers/credential-gateway/openshell.ts";
import {
  OpenShellProviderAlreadyExistsError,
  type OpenShellGatewayClient,
  type OpenShellProviderCreateRequest,
  type OpenShellProviderProfile,
  type OpenShellProviderResponse,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import type {
  CredentialRevisionContext,
  CredentialSource,
  CredentialSourceContext,
  CredentialSourceInput,
  CredentialSourceStatus,
  Namespace,
} from "../../packages/contracts/src/index.ts";
import { completeSandboxRevision } from "./sandbox-driver-revision-fixture.ts";
import { completeOpenShellGatewayClient } from "./sandbox-workspace-gateway-fixture.ts";

/** Complete records for the Credential Gateway's recording-store scenarios. */
export function createCredentialGatewayContexts(driverId: string) {
  const createdAt = "2026-09-23T00:00:00.000Z";
  const namespace: Namespace = {
    id: "ns_00000000-0000-4000-8000-0000000000aa",
    name: "placed-tenant",
    status: "ready",
    createdAt,
  };
  const signal = new AbortController().signal;
  const source = (id: string, namespaceId = namespace.id): CredentialSource => ({
    id,
    namespaceId,
    name: "openai",
    type: "openai",
    config: {},
    secrets: {},
    ownerCapability: "credential_gateway",
    driverId,
    state: "ready",
    createdAt,
  });
  const context = (id: string): CredentialSourceContext => ({
    namespace,
    source: source(id),
    signal,
  });
  const revisionContext = (sources: readonly CredentialSource[]): CredentialRevisionContext => ({
    namespace,
    revision: completeSandboxRevision({
      id: "rev_00000000-0000-4000-8000-0000000000aa",
      namespaceId: namespace.id,
      agentId: "agt_00000000-0000-4000-8000-0000000000aa",
      sandboxDriverId: "openshell-sandbox",
      harness: {
        id: "codex",
        version: "1.0.0",
        mode: "dedicated",
        overrides: {},
        configuration: {},
      },
    }),
    sources,
    signal,
  });
  return { source, context, revisionContext };
}

export async function assertCredentialSourceReady(
  operation: Promise<CredentialSourceStatus>,
): Promise<void> {
  assert.deepEqual(await operation, { state: "ready" });
}

type StoredProfile = OpenShellProviderProfile & { resourceVersion: string };
type ProviderOperation = "createProvider" | "updateProviderCredentials" | "deleteProvider";
type ProfileWrite = "import" | "update";
type ProfileMethods = Pick<
  OpenShellGatewayClient,
  "importProviderProfile" | "updateProviderProfile" | "deleteProviderProfile"
>;

/** Record profile mutations and provider reads independently of the Driver's ownership checks. */
export function createCredentialProviderStore({ keepDeleted }: { keepDeleted: boolean }) {
  const providers = new Map<string, OpenShellProviderCreateRequest>();
  const profiles = new Map<string, StoredProfile>();
  const deletedProfiles: string[] = [];
  const profileWrites: [operation: ProfileWrite, profileId: string][] = [];
  const calls: [operation: ProviderOperation, providerName: string][] = [];
  let resourceVersion = 0;
  const providerClient = {
    async getProviderProfile(_workspace: string | null, id: string) {
      return profiles.get(id);
    },
    async importProviderProfile(_workspace, profile) {
      profileWrites.push(["import", profile.id]);
      // Pinned OpenShell imports use MustCreate; they cannot overwrite a collision.
      if (profiles.has(profile.id)) {
        throw new Error("provider profile already exists");
      }
      profiles.set(profile.id, {
        ...profile,
        resourceVersion: String(++resourceVersion),
      });
    },
    // Like OpenShell, an update applies only over the version the writer last read.
    async updateProviderProfile(_workspace, profile, expectedResourceVersion) {
      profileWrites.push(["update", profile.id]);
      if (profiles.get(profile.id)?.resourceVersion !== expectedResourceVersion) {
        throw new Error("provider profile was modified concurrently");
      }
      profiles.set(profile.id, {
        ...profile,
        resourceVersion: String(++resourceVersion),
      });
    },
    async deleteProviderProfile(_workspace, id) {
      deletedProfiles.push(id);
      profiles.delete(id);
    },
    async getProvider(_workspace: string, name: string) {
      return providers.get(name);
    },
    async listProviders() {
      return [...providers.values()];
    },
    async updateProviderCredentials(
      _workspace: string,
      name: string,
      credentials: OpenShellProviderCreateRequest["credentials"],
    ) {
      calls.push(["updateProviderCredentials", name]);
      const provider = providers.get(name);
      assert.ok(provider, `Expected provider ${name} before credential update.`);
      providers.set(name, { ...provider, credentials });
    },
    async deleteProvider(_workspace: string, name: string) {
      calls.push(["deleteProvider", name]);
      if (!keepDeleted) {
        providers.delete(name);
      }
    },
  } satisfies ProfileMethods &
    Pick<
      OpenShellGatewayClient,
      "getProviderProfile" | "updateProviderCredentials" | "deleteProvider"
    > & {
      getProvider: (
        workspace: string,
        name: string,
      ) => Promise<OpenShellProviderCreateRequest | undefined>;
      listProviders: () => Promise<OpenShellProviderCreateRequest[]>;
    };
  return {
    calls,
    deletedProfiles,
    profileWrites,
    profiles,
    providerClient,
    providers,
    // Main stored only the digest annotation; provider ownership and profile content stay.
    unmark(id: string) {
      const profile = profiles.get(id);
      assert.ok(profile);
      const digest = profile.annotations["openclaw.dev/profile-digest"];
      assert.ok(digest);
      const unmarked = {
        ...profile,
        annotations: { "openclaw.dev/profile-digest": digest },
      };
      profiles.set(id, unmarked);
      return unmarked;
    },
  };
}

type CredentialDriverFixtureOptions = {
  binaries?: OpenShellCredentialGatewayOptions["binaries"] | undefined;
  toolBinaries?: OpenShellCredentialGatewayOptions["toolBinaries"] | undefined;
};
type CredentialStoreFixtureOptions = Pick<CredentialDriverFixtureOptions, "toolBinaries"> & {
  keepDeleted?: boolean | undefined;
  refresh?: boolean | undefined;
};
type ProviderClient = Omit<
  ReturnType<typeof createCredentialProviderStore>["providerClient"],
  "getProvider" | "listProviders"
> &
  Pick<OpenShellGatewayClient, "getGatewayInfo"> &
  Partial<
    Pick<
      OpenShellGatewayClient,
      "getWorkspace" | "getSandbox" | "detachSandboxProvider" | "getSandboxProviderStatus"
    >
  > & {
    createProvider(provider: OpenShellProviderCreateRequest): Promise<OpenShellProviderResponse>;
    getProvider(workspace: string, name: string): Promise<OpenShellProviderResponse | undefined>;
    listProviders(): Promise<OpenShellProviderResponse[]>;
  };

function providerResponse(provider: OpenShellProviderCreateRequest): OpenShellProviderResponse {
  return {
    workspace: provider.workspace,
    name: provider.name,
    type: provider.type,
    labels: provider.labels,
    config: provider.config ?? {},
    resourceVersion: "1",
  };
}

/** Record credential writes separately from the non-secret provider records the Driver reads. */
export function credentialGatewayOverProviders({
  keepDeleted = false,
  toolBinaries,
  refresh = false,
}: CredentialStoreFixtureOptions = {}) {
  const { providerClient, ...store } = createCredentialProviderStore({
    keepDeleted,
  });
  const { calls, providers } = store;
  const client: ProviderClient = {
    ...providerClient,
    async createProvider(provider) {
      calls.push(["createProvider", provider.name]);
      if (providers.has(provider.name)) {
        throw new OpenShellProviderAlreadyExistsError(provider.name);
      }
      providers.set(provider.name, { ...provider });
      return providerResponse(provider);
    },
    async getProvider(workspace, name) {
      const provider = await providerClient.getProvider(workspace, name);
      return provider === undefined ? undefined : providerResponse(provider);
    },
    async listProviders() {
      return (await providerClient.listProviders()).map(providerResponse);
    },
  };
  const backend = {
    id: "openshell",
    drivers: {
      credential_gateway: "credential-gateway-openshell",
      ...(refresh && { credential_refresh: "credential-refresh-openshell" }),
    },
    // The recording transport has no Kubernetes gateway placement.
    client: new OpenShellGateway(
      { endpoint: "http://127.0.0.1:1" },
      { gatewayClient: completeOpenShellGatewayClient(client) },
    ),
  };
  // Another controller configuration over the same OpenShell store, as after a config change.
  const driverWith = ({
    binaries = ["/usr/local/bin/codex"],
    toolBinaries,
  }: CredentialDriverFixtureOptions = {}) =>
    new OpenShellCredentialGatewayDriver(
      { binaries, ...(toolBinaries === undefined ? {} : { toolBinaries }) },
      { backend },
    );
  const driver = driverWith(toolBinaries === undefined ? {} : { toolBinaries });
  const { source, context, revisionContext } = createCredentialGatewayContexts(driver.id);
  return {
    ...store,
    client,
    driver,
    driverWith,
    source,
    context,
    revisionContext,
    input: (apiKey = "synthetic-openai-key"): CredentialSourceInput => ({
      type: "openai",
      config: {},
      secrets: { api_key: apiKey },
    }),
  };
}

export type CredentialProviderFixture = ReturnType<typeof credentialGatewayOverProviders>;
