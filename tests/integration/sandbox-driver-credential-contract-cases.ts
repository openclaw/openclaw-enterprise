import assert from "node:assert/strict";
import test from "node:test";
import type { OpenShellCredentialGatewayDriver } from "../../apps/controller/src/drivers/credential-gateway/openshell.ts";
import {
  ConfigurationValidationError as SharedConfigurationValidationError,
  type CredentialSource,
} from "../../packages/contracts/src/index.ts";
import {
  CredentialSourceRegistrationConfigError,
  CredentialSourceRevisionError,
} from "../../packages/occ/src/index.ts";
import {
  assertCredentialSourceReady,
  type credentialGatewayOverProviders,
  type CredentialProviderFixture,
} from "./sandbox-driver-credential-fixture.ts";

type FixtureDependencies = {
  credentialGatewayOverProviders: typeof credentialGatewayOverProviders;
  structuralRefusal: typeof import("./sandbox-driver-startup-orchestration.ts").structuralRefusal;
};

function requiredProfile(profiles: CredentialProviderFixture["profiles"], id: string) {
  const profile = profiles.get(id);
  assert.ok(profile, `expected provider profile ${id}`);
  return profile;
}

export function registerSandboxCredentialContractCases({
  credentialGatewayOverProviders,
  structuralRefusal,
}: FixtureDependencies): void {
  /** A bearer-token source of the recording store, registered under `driver`. */
  function bearerTokenSources(gateway: CredentialProviderFixture) {
    const { context } = gateway;
    const endpoint = { host: "api.example.com", env_var: "EXAMPLE_TOKEN" };
    const bearer = (id: string, env_var = endpoint.env_var) => ({
      ...context(id).source,
      type: "bearer-token",
      config: { ...endpoint, env_var },
    });
    const { namespace, signal } = context("cs_00000000-0000-4000-8000-000000000000");
    const sourceContext = (source: CredentialSource) => ({ namespace, source, signal });
    const input = (source: CredentialSource, token = "t0ken") => ({
      type: source.type,
      config: source.config,
      secrets: { token },
    });
    const revisionContext = (sources: CredentialSource[]) => gateway.revisionContext(sources);
    const providerOf = (source: CredentialSource) =>
      [...gateway.providers.values()].find(
        ({ labels }) => labels["openclaw.dev/credential-source-id"] === source.id,
      );
    const register = (driver: OpenShellCredentialGatewayDriver, source: CredentialSource) =>
      assertCredentialSourceReady(driver.registerSource(sourceContext(source), input(source)));
    return { bearer, input, providerOf, register, revisionContext, sourceContext };
  }

  test("the OpenShell bearer-token type exists only with toolBinaries and validates its endpoint", async () => {
    const modelOnly = credentialGatewayOverProviders();
    assert.deepEqual(
      (await modelOnly.driver.listSourceTypes({ signal: new AbortController().signal })).map(
        ({ type }) => type,
      ),
      ["openai", "codex-pat"],
    );
    const tokenInput = (config: Record<string, string>) => ({
      type: "bearer-token",
      config,
      secrets: { token: "t0ken" },
    });
    const endpoint = { host: "api.example.com", env_var: "EXAMPLE_TOKEN" };
    await assert.rejects(
      modelOnly.driver.registerSource(
        modelOnly.context("cs_00000000-0000-4000-8000-0000000000f0"),
        tokenInput(endpoint),
      ),
      /does not support this type/,
    );
    assert.throws(
      () =>
        modelOnly.driverWith({ binaries: ["/usr/local/bin/codex"], toolBinaries: ["bin/curl"] }),
      (error) => {
        assert.ok(error instanceof SharedConfigurationValidationError);
        assert.deepEqual(
          error.error.details,
          structuralRefusal("/toolBinaries/0", "pattern", "INVALID_FORMAT"),
        );
        return true;
      },
    );

    const { calls, context, deletedProfiles, driver, input, profiles, providers, revisionContext } =
      credentialGatewayOverProviders({ toolBinaries: ["/usr/bin/curl"] });
    assert.deepEqual(
      (await driver.listSourceTypes({ signal: new AbortController().signal })).map(
        ({ type }) => type,
      ),
      ["openai", "codex-pat", "bearer-token"],
    );
    // Every invalid endpoint or placeholder variable is refused before any gateway effect.
    for (const config of [
      { ...endpoint, host: "10.0.0.1" },
      { ...endpoint, host: "API.example.com" },
      { ...endpoint, host: "https://api.example.com" },
      { ...endpoint, port: "0" },
      { ...endpoint, port: "443x" },
      { ...endpoint, port: "65536" },
      { ...endpoint, path: "v1/**" },
      { ...endpoint, path: "/v1?all" },
      { ...endpoint, env_var: "example_token" },
      { ...endpoint, env_var: "OPENAI_API_KEY" },
      { ...endpoint, env_var: "PATH" },
      { ...endpoint, env_var: "OPENCLAW_TOKEN" },
      { ...endpoint, env_var: "CODEX_TOKEN" },
      { host: "api.example.com" },
    ]) {
      await assert.rejects(
        driver.registerSource(
          context("cs_00000000-0000-4000-8000-0000000000f1"),
          tokenInput(config),
        ),
        CredentialSourceRegistrationConfigError,
        JSON.stringify(config),
      );
    }
    assert.deepEqual(calls, []);
    assert.equal(profiles.size, 0);

    // Each bearer-token source owns a profile that only the tool binaries may use, at its endpoint.
    const first = "cs_00000000-0000-4000-8000-0000000000f2";
    const second = "cs_00000000-0000-4000-8000-0000000000f3";
    await assertCredentialSourceReady(driver.registerSource(context(first), tokenInput(endpoint)));
    const provider = [...providers.values()].find(
      ({ labels }) => labels["openclaw.dev/credential-source-id"] === first,
    );
    assert.ok(provider);
    const profile = profiles.get(provider.type);
    assert.ok(profile, "the provider's type names its own profile");
    assert.equal(profile.id, provider.name);
    assert.deepEqual(profile.binaries, ["/usr/bin/curl"]);
    assert.equal(profile.inferenceCapable, false);
    assert.deepEqual(profile.endpoints, [
      { host: "api.example.com", port: 443, path: "/**", protocol: "rest" },
    ]);
    assert.deepEqual(
      profile.credentials.map(({ name, envVars, authStyle, headerName }) => ({
        name,
        envVars,
        authStyle,
        headerName,
      })),
      [
        {
          name: "token",
          envVars: ["EXAMPLE_TOKEN"],
          authStyle: "bearer",
          headerName: "authorization",
        },
      ],
    );
    // A model source owns its profile too, limited to the Harness binaries.
    const profileOf = (sourceId: string) => {
      const provider = [...providers.values()].find(
        ({ labels }) => labels["openclaw.dev/credential-source-id"] === sourceId,
      );
      assert.ok(provider);
      return requiredProfile(profiles, provider.type);
    };
    const model = "cs_00000000-0000-4000-8000-0000000000f4";
    await driver.registerSource(context(model), input());
    assert.equal(profileOf(model).inferenceCapable, true);
    assert.deepEqual(profileOf(model).binaries, ["/usr/local/bin/codex"]);
    assert.equal(profiles.has("oce-openai"), false, "no profile is shared between sources");

    // Two sources on one revision cannot share a placeholder variable.
    await driver.registerSource(context(second), tokenInput(endpoint));
    const bearer = (id: string) => ({
      ...context(id).source,
      type: "bearer-token",
      config: endpoint,
    });
    const { namespace, signal } = context(first);
    const { revision } = revisionContext([]);
    await assert.rejects(
      driver.attachForRevision({
        namespace,
        revision,
        sources: [bearer(first), bearer(second)],
        signal,
      }),
      (error) => {
        // A permanent refusal: the worker fails the deployment instead of retrying it.
        assert.ok(error instanceof CredentialSourceRevisionError, String(error));
        assert.equal(error.code, "CREDENTIAL_SOURCE_ENVIRONMENT_CONFLICT");
        assert.match(error.message, /use the same environment variable/);
        return true;
      },
    );
    assert.equal(
      (await driver.attachForRevision({ namespace, revision, sources: [bearer(first)], signal }))
        .length,
      1,
    );
    // A provider of another type under this source's name and labels is not this source's.
    providers.set(provider.name, { ...provider, type: "oce-openai" });
    assert.equal(
      (await driver.sourceStatus({ namespace, source: bearer(first), signal })).state,
      "failed",
    );
    providers.set(provider.name, provider);

    // Removing a source removes its own profile, while another source of the type remains.
    await driver.removeSource({ namespace, source: bearer(first), signal });
    assert.deepEqual(deletedProfiles, [provider.name]);
    assert.equal(profiles.has(provider.name), false);
    assert.equal(profiles.size, 2);
    // Removing one model source removes only its profile; the other model source keeps its own.
    const secondModel = "cs_00000000-0000-4000-8000-0000000000f5";
    await driver.registerSource(context(secondModel), input());
    const modelProfile = profileOf(model).id;
    const secondModelProfile = profileOf(secondModel).id;
    assert.notEqual(modelProfile, secondModelProfile);
    await driver.removeSource(context(model));
    assert.deepEqual(deletedProfiles, [provider.name, modelProfile]);
    assert.equal(profiles.has(secondModelProfile), true);
  });

  test("narrowing OpenShell toolBinaries narrows existing bearer-token sources on update and deployment", async () => {
    const gateway = credentialGatewayOverProviders({
      toolBinaries: ["/usr/bin/curl", "/usr/bin/python3"],
    });
    const { driver, driverWith, profileWrites, profiles } = gateway;
    const { bearer, input, providerOf, register, revisionContext, sourceContext } =
      bearerTokenSources(gateway);
    const updated = bearer("cs_00000000-0000-4000-8000-000000000101", "UPDATED_TOKEN");
    const deployed = bearer("cs_00000000-0000-4000-8000-000000000102", "DEPLOYED_TOKEN");
    await register(driver, updated);
    await register(driver, deployed);
    const profileOf = (source: CredentialSource) => {
      const provider = providerOf(source);
      assert.ok(provider);
      return requiredProfile(profiles, provider.type);
    };
    assert.deepEqual(profileOf(updated).binaries, ["/usr/bin/curl", "/usr/bin/python3"]);
    assert.deepEqual(profileOf(deployed).binaries, ["/usr/bin/curl", "/usr/bin/python3"]);

    // The operator drops python3. Status reads never write the profile.
    const narrowed = driverWith({ toolBinaries: ["/usr/bin/curl"] });
    profileWrites.length = 0;
    assert.equal((await narrowed.sourceStatus(sourceContext(updated))).state, "ready");
    assert.deepEqual([...profileWrites], []);

    // Updating a source's token rewrites its profile to the current list.
    await assertCredentialSourceReady(
      narrowed.updateSource(sourceContext(updated), input(updated, "n3w")),
    );
    assert.deepEqual(profileOf(updated).binaries, ["/usr/bin/curl"]);
    assert.deepEqual(profileOf(deployed).binaries, ["/usr/bin/curl", "/usr/bin/python3"]);

    // Deploying a revision rewrites each attached source's profile.
    assert.equal((await narrowed.attachForRevision(revisionContext([deployed]))).length, 1);
    assert.deepEqual(profileOf(deployed).binaries, ["/usr/bin/curl"]);
    assert.deepEqual(
      profileWrites.map(([operation]) => operation),
      ["update", "update"],
    );

    // An unchanged configuration writes nothing.
    profileWrites.length = 0;
    await narrowed.updateSource(sourceContext(updated), input(updated));
    await narrowed.attachForRevision(revisionContext([updated, deployed]));
    assert.deepEqual([...profileWrites], []);

    // A model source's profile follows the Harness binaries the same way.
    const model = "cs_00000000-0000-4000-8000-000000000103";
    await narrowed.registerSource(gateway.context(model), gateway.input());
    const retargeted = driverWith({
      binaries: ["/opt/codex/bin/codex"],
      toolBinaries: ["/usr/bin/curl"],
    });
    await retargeted.attachForRevision(revisionContext([gateway.source(model)]));
    assert.deepEqual(profileOf(gateway.source(model)).binaries, ["/opt/codex/bin/codex"]);
  });

  test("an OpenShell profile write that lost a race to the same profile still attaches", async () => {
    const gateway = credentialGatewayOverProviders({ toolBinaries: ["/usr/bin/curl"] });
    const { client, driverWith, profiles } = gateway;
    const { bearer, providerOf, register, revisionContext } = bearerTokenSources(gateway);
    const source = bearer("cs_00000000-0000-4000-8000-000000000111");
    await register(gateway.driver, source);
    const provider = providerOf(source);
    assert.ok(provider);
    const profileId = provider.type;
    const read = client.getProviderProfile;
    const narrowed = driverWith({ toolBinaries: ["/usr/bin/wget"] });
    const other = driverWith({ toolBinaries: ["/usr/bin/curl", "/usr/bin/wget"] });

    // Another deployment with the same configuration writes between this read and write: the
    // stale version is refused, and the stored profile is already the one this writer wanted.
    client.getProviderProfile = async (workspace, id) => {
      const stale = await read(workspace, id);
      client.getProviderProfile = read;
      await narrowed.attachForRevision(revisionContext([source]));
      return stale;
    };
    assert.equal((await narrowed.attachForRevision(revisionContext([source]))).length, 1);
    assert.deepEqual(requiredProfile(profiles, profileId).binaries, ["/usr/bin/wget"]);

    // A concurrent writer that stored another profile is not mistaken for success.
    const curlOnly = driverWith({ toolBinaries: ["/usr/bin/curl"] });
    client.getProviderProfile = async (workspace, id) => {
      const stale = await read(workspace, id);
      client.getProviderProfile = read;
      await curlOnly.attachForRevision(revisionContext([source]));
      return stale;
    };
    await assert.rejects(
      other.attachForRevision(revisionContext([source])),
      /modified concurrently/,
    );
    assert.deepEqual(requiredProfile(profiles, profileId).binaries, ["/usr/bin/curl"]);
  });

  test("an OpenShell bearer-token source stays deletable after toolBinaries is removed", async () => {
    const gateway = credentialGatewayOverProviders({ toolBinaries: ["/usr/bin/curl"] });
    const { deletedProfiles, driverWith, profiles } = gateway;
    const { bearer, input, providerOf, register, revisionContext, sourceContext } =
      bearerTokenSources(gateway);
    const source = bearer("cs_00000000-0000-4000-8000-000000000121");
    await register(gateway.driver, source);
    const provider = providerOf(source);
    assert.ok(provider);
    const profileId = provider.type;

    const modelOnly = driverWith();
    // The type is gone for new registrations, updates and deployments.
    await assert.rejects(
      modelOnly.registerSource(
        sourceContext(bearer("cs_00000000-0000-4000-8000-000000000122")),
        input(source),
      ),
      /does not support this type/,
    );
    await assert.rejects(
      modelOnly.updateSource(sourceContext(source), input(source)),
      /does not support this type/,
    );
    await assert.rejects(
      modelOnly.attachForRevision(revisionContext([source])),
      /does not support this type/,
    );
    // The existing source still reports its state and can be removed with its own profile.
    assert.equal((await modelOnly.sourceStatus(sourceContext(source))).state, "ready");
    await modelOnly.removeSource(sourceContext(source));
    assert.equal(providerOf(source), undefined);
    assert.deepEqual(deletedProfiles, [profileId]);
    assert.equal(profiles.has(profileId), false);
    // Removal is idempotent once the provider is gone.
    await modelOnly.removeSource(sourceContext(source));
  });
}
