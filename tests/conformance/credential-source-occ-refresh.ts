import type { OpenShellBackendDefinition } from "../../packages/contracts/src/index.ts";
import assert from "node:assert/strict";
import test from "node:test";
import {
  DependencyUnavailableError,
  DriverSelectionError,
  InMemoryPlatformState,
  OpenClawController,
} from "../../packages/occ/src/index.ts";
import {
  administrator,
  createSecret,
  createTestCredentialGateway,
  createTestCredentialRefresh,
  createTestSandbox,
  fixture,
  installation,
  refreshSource,
} from "./credential-source-occ-fixture.ts";

// Registration derives its request IDs from the source ID (version 5 layout), so a replay reuses them.
const NAME_BASED_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function registerRefreshCases(): void {
  test("a refresh source is ready only after its first mint, and its material is not a gateway value", async () => {
    const context = await fixture();
    await context.makeReady();
    const { secret, source } = await refreshSource(context);
    assert.equal(source.state, "ready");
    assert.deepEqual(source.status, {
      state: "ready",
      refresh: { state: "ready", lastRefreshAt: "2026-09-27T12:00:00.000000000Z" },
    });
    // The gateway registers the source first; refresh material goes only to the refresh role,
    // which then mints the first token. Each step carries a name-based request ID for replay.
    const calls = context.gateway.calls.filter(({ sourceId }) => sourceId === source.id);
    assert.deepEqual(
      calls.map(({ operation }) => operation),
      ["registerSource", "configureRefresh", "rotate"],
    );
    // Custody boundary: the gateway registers config only and never receives the issuer secret.
    const [registration, configuration, rotation] = calls;
    assert.equal(registration?.operation, "registerSource");
    assert.equal(configuration?.operation, "configureRefresh");
    assert.equal(rotation?.operation, "rotate");
    assert.deepEqual(registration.input.secrets, {});
    assert.deepEqual(configuration.input.secrets, { client_secret: "synthetic-client-secret" });
    assert.deepEqual(configuration.input.config, { client_id: "occ-tools" });
    assert.match(configuration.input.requestId, NAME_BASED_UUID);
    assert.match(rotation.requestId, NAME_BASED_UUID);
    assert.notEqual(configuration.input.requestId, rotation.requestId);
    assert.deepEqual(source.secrets, { client_secret: secret.ref });
    assert.equal(JSON.stringify(source).includes("synthetic-client-secret"), false);
  });

  test("a refresh type needs a selected Credential Refresh Driver before any gateway effect", async () => {
    const context = await fixture({ withoutRefresh: true });
    await context.makeReady();
    const secret = await createSecret(context, "client-secret", "synthetic-client-secret");
    const secretReads = context.secretDriver.calls.length;
    await assert.rejects(
      context.controller.createCredentialSource(administrator, {
        namespaceId: context.namespace.id,
        name: "oauth-client",
        type: "oauth-client",
        config: { client_id: "occ-tools" },
        secrets: { client_secret: secret.ref },
      }),
      DependencyUnavailableError,
    );
    // Refused before any Secret read, too.
    assert.equal(context.secretDriver.calls.length, secretReads);
    assert.equal(context.gateway.calls.length, 0);
    assert.deepEqual(
      await context.controller.listCredentialSources(administrator, context.namespace.id),
      [],
    );
    // A refresh Driver missing any operation is not a Credential Refresh Driver.
    context.controller.registerDriver({ ...context.refresh, id: "credential-refresh-complete" });
    for (const operation of ["configureRefresh", "rotate", "refreshStatus", "removeRefresh"]) {
      assert.throws(
        () =>
          context.controller.registerDriver({
            ...context.refresh,
            id: `credential-refresh-without-${operation}`,
            [operation]: undefined,
          }),
        DriverSelectionError,
      );
    }
  });

  test("an OpenShell Backend names its refresh Driver, and the selected one must be a member", async () => {
    const backend = (refresh?: string): OpenShellBackendDefinition => ({
      id: "openshell",
      type: "openshell",
      configuration: { serviceName: "openshell", insecureTransport: "network-policy" },
      drivers: {
        sandbox: "sandbox-test",
        credential_gateway: "credential-gateway-test",
        ...(refresh === undefined ? {} : { credential_refresh: refresh }),
      },
    });
    assert.throws(
      () => new OpenClawController(installation, { backends: [backend("")] }),
      /drivers\.credential_refresh must be a Driver ID/,
    );
    const gateway = createTestCredentialGateway();
    for (const declared of ["credential-refresh-test", undefined]) {
      const controller = new OpenClawController(installation, {
        state: new InMemoryPlatformState(),
        backends: [backend(declared)],
      });
      for (const driver of [
        createTestSandbox(),
        gateway,
        createTestCredentialRefresh(gateway.calls),
      ]) {
        controller.registerDriver(driver);
        controller.selectDriver(driver.capability, driver.id);
      }
      const validated = controller.validateBackendConfiguration();
      await (declared === undefined
        ? assert.rejects(validated, /must belong to the Credential Gateway's Backend/)
        : validated);
    }
  });

  test("a refresh source whose first mint fails is removed from the gateway and from OCC", async () => {
    const context = await fixture({
      refresh: {
        rotateStatus: {
          state: "failed",
          failureCode: "oauth_invalid_client",
          recoveryAction: "fix_configuration",
        },
      },
    });
    await context.makeReady();
    // The Driver's safe failure code reaches the caller; the issuer's own text never does.
    await assert.rejects(
      refreshSource(context),
      (error) =>
        error instanceof DependencyUnavailableError && /oauth_invalid_client/.test(error.message),
    );
    assert.deepEqual(
      context.gateway.calls.map(({ operation }) => operation),
      ["registerSource", "configureRefresh", "rotate", "removeRefresh", "removeSource"],
    );
    assert.equal(context.refresh.configured.size, 0);
    assert.equal(context.gateway.stored.size, 0);
    assert.deepEqual(
      await context.controller.listCredentialSources(administrator, context.namespace.id),
      [],
    );
  });

  test("a pending first mint fails registration, and an unknown one retains its cleanup record", async () => {
    const context = await fixture();
    await context.makeReady();
    const list = () =>
      context.controller.transact((unit) =>
        unit.credentialSources.listCredentialSources(context.namespace.id),
      );
    // A pending mint holds no token yet; the refresh type is usable only once one is minted.
    context.refresh.nextRotate = async () => ({ state: "pending" });
    await assert.rejects(
      refreshSource(context),
      (error) =>
        error instanceof DependencyUnavailableError &&
        /did not mint a token\.$/.test(error.message),
    );
    assert.deepEqual(await list(), []);
    // A mint whose outcome is unknown may still complete, so cleanup keeps the record.
    context.refresh.nextRotate = async () => {
      throw new Error("issuer timed out");
    };
    await assert.rejects(refreshSource(context), DependencyUnavailableError);
    const [kept] = await list();
    assert.ok(kept);
    assert.equal(kept.state, "deleting");
    assert.equal(context.refresh.configured.size, 0);
    assert.equal(context.gateway.stored.size, 0);
  });
}
