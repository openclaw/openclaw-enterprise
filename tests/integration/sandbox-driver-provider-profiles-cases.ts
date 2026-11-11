import assert from "node:assert/strict";
import type {
  CredentialRevisionContext,
  CredentialSource,
  CredentialSourceContext,
  CredentialSourceInput,
  CredentialSourceStatus,
} from "../../packages/contracts/src/index.ts";
import type { ScopeViolationError } from "../../packages/occ/src/index.ts";
import type {
  OpenShellCredentialGatewayDriver,
  OpenShellCredentialGatewayOptions,
} from "../../apps/controller/src/drivers/credential-gateway/openshell.ts";
import type {
  OpenShellProviderCreateRequest,
  OpenShellProviderProfile,
} from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";

type StoredProfile = OpenShellProviderProfile & { resourceVersion: string };

function requiredValue<T>(value: T | undefined): T {
  assert.ok(value);
  return value;
}

type ProviderFixture = {
  calls: [operation: string, providerName: string][];
  client: {
    createProvider: (provider: OpenShellProviderCreateRequest) => Promise<void>;
    deleteProviderProfile: (workspace: string, id: string) => Promise<void>;
    getProviderProfile: (workspace: string, id: string) => Promise<StoredProfile | undefined>;
  };
  context: (id: string) => CredentialSourceContext;
  deletedProfiles: string[];
  driver: OpenShellCredentialGatewayDriver;
  driverWith: (
    options?: Partial<OpenShellCredentialGatewayOptions>,
  ) => OpenShellCredentialGatewayDriver;
  input: (apiKey?: string) => CredentialSourceInput;
  profiles: Map<string, StoredProfile>;
  profileWrites: [operation: string, profileId: string][];
  providers: Map<string, OpenShellProviderCreateRequest>;
  revisionContext: (sources: readonly CredentialSource[]) => CredentialRevisionContext;
  source: (id: string, namespaceId?: string) => CredentialSource;
  unmark: (id: string) => StoredProfile | undefined;
};

type ProviderProfilesCaseFixtures = {
  ScopeViolationError: typeof ScopeViolationError;
  credentialGatewayOverProviders: (options?: { keepDeleted?: boolean }) => ProviderFixture;
  ready: (operation: Promise<CredentialSourceStatus>) => Promise<void>;
};

export function createSandboxProviderProfileChecks({
  credentialGatewayOverProviders,
  ready,
  ScopeViolationError,
}: ProviderProfilesCaseFixtures) {
  return {
    async restrictCodexPatNativeStartupAndPluginRoutes() {
      const { context, driver, profiles } = credentialGatewayOverProviders();
      const source = context("cs_00000000-0000-4000-8000-0000000000c1");
      await driver.registerSource(
        { ...source, source: { ...source.source, type: "codex-pat" } },
        { type: "codex-pat", config: {}, secrets: { access_token: "synthetic-codex-pat" } },
      );
      const profile = requiredValue(profiles.values().next().value);
      // The native client needs plugin installation, app metadata and MCP transport.
      // Backend or WHAM wildcards would also admit unrelated account APIs.
      assert.deepEqual(profile.endpoints, [
        {
          host: "auth.openai.com",
          port: 443,
          protocol: "rest",
          path: "/api/accounts/v1/user-auth-credential/whoami",
        },
        { host: "chatgpt.com", port: 443, protocol: "rest", path: "/backend-api/codex/**" },
        {
          host: "chatgpt.com",
          port: 443,
          protocol: "rest",
          path: "/backend-api/wham/config/bundle",
        },
        {
          host: "chatgpt.com",
          port: 443,
          protocol: "rest",
          path: "/backend-api/wham/accounts/check",
        },
        {
          host: "chatgpt.com",
          port: 443,
          protocol: "rest",
          path: "/backend-api/wham/settings/user",
        },
        { host: "chatgpt.com", port: 443, protocol: "rest", path: "/backend-api/wham/usage" },
        {
          host: "chatgpt.com",
          port: 443,
          protocol: "rest",
          path: "/backend-api/ps/plugins/**",
          rules: [
            { allow: { method: "GET", path: "/backend-api/ps/plugins/*" } },
            { allow: { method: "POST", path: "/backend-api/ps/plugins/*/install" } },
          ],
        },
        {
          host: "chatgpt.com",
          port: 443,
          protocol: "rest",
          path: "/backend-api/ps/apps/batch",
          rules: [{ allow: { method: "POST", path: "/backend-api/ps/apps/batch" } }],
        },
        {
          host: "chatgpt.com",
          port: 443,
          protocol: "rest",
          path: "/backend-api/ps/mcp",
          rules: [{ allow: { method: "POST", path: "/backend-api/ps/mcp" } }],
        },
      ]);
      assert.deepEqual(profile.binaries, ["/usr/local/bin/codex"]);
    },

    async keepCodexPatProviderProfilesDistinctAcrossReplays() {
      const { context, driver, profileWrites, profiles, providers } =
        credentialGatewayOverProviders();
      const register = (id: string) => {
        const owner = context(id);
        return driver.registerSource(
          { ...owner, source: { ...owner.source, type: "codex-pat" } },
          { type: "codex-pat", config: {}, secrets: { access_token: `synthetic-pat-${id}` } },
        );
      };
      const sources = [
        "cs_00000000-0000-4000-8000-0000000000c2",
        "cs_00000000-0000-4000-8000-0000000000c3",
      ] as const;
      for (const id of sources) {
        await ready(register(id));
      }
      // Each provider's type names a profile of its own, so one PAT's routes never bind another's.
      const profileIds = sources.map((id) => {
        const provider = requiredValue(
          [...providers.values()].find(
            ({ labels }) => labels["openclaw.dev/credential-source-id"] === id,
          ),
        );
        assert.equal(profiles.get(provider.type)?.id, provider.name, id);
        return provider.type;
      });
      // Exactly two profiles: no source shares a profile with the other.
      assert.deepEqual([...profiles.keys()].sort(), [...profileIds].sort());
      // Replaying a source's registration reuses its profile instead of minting another.
      profileWrites.length = 0;
      await ready(register(sources[0]));
      assert.equal(providers.size, 2);
      assert.deepEqual([...profiles.keys()].sort(), [...profileIds].sort());
      assert.deepEqual(profileWrites, []);
    },

    async restrictGatewayToItsOwnedProvider() {
      const {
        calls,
        context,
        driver,
        input,
        profiles,
        profileWrites,
        providers,
        revisionContext,
        source,
      } = credentialGatewayOverProviders();
      const owner = "cs_00000000-0000-4000-8000-0000000000b1";
      const other = "cs_00000000-0000-4000-8000-0000000000b2";
      await ready(driver.registerSource(context(owner), input()));
      const stored = requiredValue(providers.values().next().value);
      assert.equal(stored.labels["openclaw.dev/credential-source-id"], owner);
      // Another source's provider stored under this source's name: same manager and type, other id.
      providers.set(stored.name, {
        ...stored,
        labels: { ...stored.labels, "openclaw.dev/credential-source-id": other },
      });
      // The colliding profile differs from the requested endpoint, so reconciliation would write.
      const foreignProfile = {
        ...requiredValue(profiles.get(stored.name)),
        endpoints: [{ host: "foreign.example.test", port: 443, path: "/v1/**", protocol: "rest" }],
        annotations: { "openclaw.dev/profile-digest": "foreign-digest" },
      };
      profiles.set(stored.name, structuredClone(foreignProfile));
      calls.length = 0;
      profileWrites.length = 0;
      const requested = { ...input(), config: { base_url: "https://requested.example.test/v1" } };
      await assert.rejects(driver.registerSource(context(owner), requested), ScopeViolationError);
      assert.deepEqual(
        profiles.get(stored.name),
        foreignProfile,
        "foreign profile contents and version stay unchanged",
      );
      assert.deepEqual(profileWrites, []);
      await assert.rejects(
        driver.updateSource(context(owner), input("replacement")),
        ScopeViolationError,
      );
      assert.equal((await driver.sourceStatus(context(owner))).state, "failed");
      await assert.rejects(driver.removeSource(context(owner)), ScopeViolationError);
      await assert.rejects(
        driver.attachForRevision(revisionContext([source(owner)])),
        /provider for a bound credential source is unavailable/,
      );
      // Ownership refusal happens before any provider or profile mutation.
      assert.deepEqual(calls, []);
      assert.deepEqual(requiredValue(providers.get(stored.name)).credentials, stored.credentials);
    },

    async preserveOwnedProfileLifecycle() {
      const f = credentialGatewayOverProviders();
      const context = f.context("cs_main-era");
      const otherContext = f.context("cs_main-era-other");
      for (const owner of [context, otherContext]) {
        await f.driver.registerSource(owner, f.input("original-key"));
      }
      [...f.profiles.keys()].forEach(f.unmark);
      const [provider, otherProvider] = f.providers.values();
      assert.ok(provider);
      assert.ok(otherProvider);
      const original = structuredClone(requiredValue(f.profiles.get(provider.name)));
      const otherProfile = structuredClone(f.profiles.get(otherProvider.name));
      f.profileWrites.length = 0;
      const restarted = f.driverWith();
      await ready(restarted.sourceStatus(context));
      assert.deepEqual(await restarted.attachForRevision(f.revisionContext([context.source])), [
        { sourceId: context.source.id, ref: provider.name },
      ]);
      await ready(restarted.updateSource(context, f.input("rotated-key")));
      await ready(f.driverWith().registerSource(context, f.input("replay-key")));
      assert.equal(
        requiredValue(f.providers.get(provider.name)).credentials.OPENAI_API_KEY,
        "rotated-key",
      );
      assert.deepEqual(f.profiles.get(provider.name), original);
      assert.deepEqual(
        f.profileWrites,
        [],
        "unchanged main-era profiles need no marker-only write",
      );

      // A normal binary-policy change reconciles the owned profile using its resource version.
      const narrowed = f.driverWith({ binaries: ["/opt/codex"] });
      await narrowed.attachForRevision(f.revisionContext([context.source]));
      assert.deepEqual(requiredValue(f.profiles.get(provider.name)).binaries, ["/opt/codex"]);
      assert.notEqual(
        requiredValue(f.profiles.get(provider.name)).resourceVersion,
        original.resourceVersion,
      );
      assert.deepEqual(f.profiles.get(otherProvider.name), otherProfile);
      assert.deepEqual(f.providers.get(otherProvider.name), otherProvider);
      await narrowed.removeSource(context);
      assert.equal(f.providers.has(provider.name), false);
      assert.equal(f.profiles.has(provider.name), false);
      assert.deepEqual(f.profiles.get(otherProvider.name), otherProfile);

      // Deletion also works directly on an unmarked profile, without a prior reconciliation.
      await f.driverWith().removeSource(otherContext);
      await f.driverWith().removeSource(otherContext);
      assert.equal(f.providers.size, 0);
      assert.equal(f.profiles.size, 0);
    },

    async resumeInterruptedRegistrationWithoutCredentialReplay() {
      const f = credentialGatewayOverProviders();
      const context = f.context("cs_owned-retry");
      const create = f.client.createProvider;
      const unavailable = new Error("create provider unavailable");
      f.client.createProvider = async () => {
        throw unavailable;
      };
      // The import succeeded but provider creation did not. Main can resume without new annotations.
      await assert.rejects(
        f.driver.registerSource(context, f.input()),
        (error) => error === unavailable,
      );
      assert.equal(f.profiles.size, 1);
      assert.equal(f.providers.size, 0);
      [...f.profiles.keys()].forEach(f.unmark);
      f.client.createProvider = create;
      f.profileWrites.length = 0;
      const restarted = f.driverWith();
      await ready(restarted.registerSource(context, f.input("first-key")));
      await ready(restarted.registerSource(context, f.input("retry-key")));
      assert.deepEqual(f.profileWrites, []);
      const provider = requiredValue(f.providers.values().next().value);
      assert.equal(provider.credentials.OPENAI_API_KEY, "first-key");
      // Owned reconciliation still applies new binary configuration through registration.
      await f
        .driverWith({ binaries: ["/opt/codex"] })
        .registerSource(context, f.input("retry-key"));
      assert.deepEqual(requiredValue(f.profiles.get(provider.name)).binaries, ["/opt/codex"]);
      assert.equal(
        requiredValue(f.providers.get(provider.name)).credentials.OPENAI_API_KEY,
        "first-key",
      );
      // Legacy cleanup can remove this orphan, and repeated deletion stays idempotent.
      f.providers.delete(provider.name);
      await restarted.removeSource(context);
      await restarted.removeSource(context);
      assert.equal(f.profiles.size, 0);
    },

    async resumeCleanupWithoutLosingAnotherSource() {
      const f = credentialGatewayOverProviders();
      const context = f.context("cs_interrupted-delete");
      const other = f.context("cs_delete-survivor");
      await f.driver.registerSource(context, f.input());
      await f.driver.registerSource(other, f.input("other-key"));
      const [provider, survivor] = f.providers.values();
      assert.ok(provider);
      assert.ok(survivor);
      const unmarked = f.unmark(provider.name);
      const survivorProfile = structuredClone(f.profiles.get(survivor.name));
      const deleteProfile = f.client.deleteProviderProfile;
      const crash = new Error("controller stopped before deleting profile");
      f.client.deleteProviderProfile = async () => {
        throw crash;
      };
      // Provider deletion has committed when the process loses the profile deletion attempt.
      await assert.rejects(f.driver.removeSource(context), (error) => error === crash);
      assert.equal(f.providers.has(provider.name), false);
      assert.deepEqual(f.profiles.get(provider.name), unmarked);
      f.client.deleteProviderProfile = deleteProfile;
      await f.driverWith().removeSource(context);
      assert.equal(f.profiles.has(provider.name), false);
      assert.deepEqual(f.providers.get(survivor.name), survivor);
      assert.deepEqual(f.profiles.get(survivor.name), survivorProfile);
    },

    async preserveFirstProviderCredentialsDuringConcurrentRegistration() {
      const f = credentialGatewayOverProviders();
      const context = f.context("cs_concurrent-registration");
      const read = f.client.getProviderProfile;
      // Both registrations observe profile absence. Import's create-only contract refuses
      // the stale writer; readback recognizes the already stored configuration.
      f.client.getProviderProfile = async (...args) => {
        const stale = await read(...args);
        f.client.getProviderProfile = read;
        await f.driverWith().registerSource(context, f.input("winner-key"));
        return stale;
      };
      await ready(f.driver.registerSource(context, f.input("retry-key")));
      assert.equal(f.providers.size, 1);
      assert.equal(f.profiles.size, 1);
      assert.equal(
        requiredValue(f.providers.values().next().value).credentials.OPENAI_API_KEY,
        "winner-key",
      );
    },

    async rejectForeignProviderAfterPreflight() {
      const f = credentialGatewayOverProviders();
      const context = f.context("cs_provider-race");
      const create = f.client.createProvider;
      let foreign: OpenShellProviderCreateRequest | undefined;
      f.client.createProvider = async (provider) => {
        // Separate RPCs leave a window after profile import. The final duplicate check is required.
        foreign = {
          ...provider,
          labels: { ...provider.labels, "openclaw.dev/credential-source-id": "cs_other" },
        };
        f.providers.set(provider.name, foreign);
        return create(provider);
      };
      await assert.rejects(f.driver.registerSource(context, f.input()), ScopeViolationError);
      await assert.rejects(f.driver.removeSource(context), ScopeViolationError);
      assert.deepEqual([...f.providers.values()], [foreign]);
      assert.equal(
        f.profiles.size,
        1,
        "a separate profile import cannot be rolled back atomically",
      );
      assert.deepEqual(f.deletedProfiles, []);
    },

    async rejectUnknownProviderCreateOutcome() {
      const f = credentialGatewayOverProviders();
      const context = f.context("cs_unknown-create");
      const create = f.client.createProvider;
      const failure = new Error("transport lost after provider create");
      f.client.createProvider = async (provider) => {
        await create(provider);
        throw failure;
      };
      // Even a persisted owned provider cannot turn an unknown create outcome into success.
      await assert.rejects(
        f.driver.registerSource(context, f.input()),
        (error) => error === failure,
      );
      assert.equal(f.providers.size, 1);
      assert.equal(f.calls.length, 1);
    },

    async rejectCrossNamespaceAttachment() {
      const { context, driver, input, revisionContext, source } = credentialGatewayOverProviders();
      const owner = "cs_00000000-0000-4000-8000-0000000000c1";
      await driver.registerSource(context(owner), input());
      // The provider is genuinely owned, so only the Namespace check can refuse.
      const foreign = source(owner, "ns_00000000-0000-4000-8000-0000000000ff");
      await assert.rejects(
        driver.attachForRevision(revisionContext([foreign])),
        (error) =>
          error instanceof ScopeViolationError &&
          error.message === "The credential source is not owned by this gateway.",
      );
      assert.equal((await driver.attachForRevision(revisionContext([source(owner)]))).length, 1);
    },

    async rejectEmptySecretBeforeProviderCreation() {
      const { calls, context, driver, input, providers } = credentialGatewayOverProviders();
      await assert.rejects(
        driver.registerSource(context("cs_00000000-0000-4000-8000-0000000000d1"), input("")),
        ScopeViolationError,
      );
      assert.deepEqual(calls, []);
      assert.equal(providers.size, 0);
    },

    async failRemovalWhenProviderSurvivesDeletion() {
      const { context, driver, input, providers } = credentialGatewayOverProviders({
        keepDeleted: true,
      });
      const owner = "cs_00000000-0000-4000-8000-0000000000e1";
      await driver.registerSource(context(owner), input());
      await assert.rejects(driver.removeSource(context(owner)), /was not deleted/);
      assert.equal(providers.size, 1);
    },
  };
}
