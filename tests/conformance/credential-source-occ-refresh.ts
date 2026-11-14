import type {
  AuditEvent,
  CredentialSourceMetadata,
  OpenShellBackendDefinition,
} from "../../packages/contracts/src/index.ts";
import assert from "node:assert/strict";
import test from "node:test";
import {
  AuthorizationDeniedError,
  DependencyUnavailableError,
  DriverSelectionError,
  InMemoryPlatformState,
  OpenClawController,
  ResourceConflictError,
  type PlatformUnitOfWork,
} from "../../packages/occ/src/index.ts";
import {
  administrator,
  auditEvent,
  createSecret,
  createTestCredentialGateway,
  createTestCredentialRefresh,
  createTestSandbox,
  deployer,
  fixture,
  installation,
  updater,
  refreshSource,
} from "./credential-source-occ-fixture.ts";

// Registration derives its request IDs from the source ID (version 5 layout), so a replay reuses them.
const NAME_BASED_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function recordRowLocks(state: InMemoryPlatformState) {
  const locks: string[] = [];
  const transact = state.transact.bind(state);
  state.transact = <Result>(work: (unit: PlatformUnitOfWork) => Promise<Result>) =>
    transact((unit) =>
      work({
        ...unit,
        namespaces: {
          ...unit.namespaces,
          lockNamespace: async (...input) => {
            locks.push("namespace");
            return unit.namespaces.lockNamespace(...input);
          },
        },
        credentialSources: {
          ...unit.credentialSources,
          lockCredentialSource: async (...input) => {
            locks.push("credential_source");
            return unit.credentialSources.lockCredentialSource(...input);
          },
        },
        secrets: {
          ...unit.secrets,
          lockSecret: async (namespaceId, secretId) => {
            locks.push(secretId);
            return unit.secrets.lockSecret(namespaceId, secretId);
          },
        },
      }),
    );
  return locks;
}

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

  test("a pending first mint fails registration, and an unknown one keeps the record for DELETE", async () => {
    const context = await fixture();
    await context.makeReady();
    const list = () =>
      context.controller.listCredentialSources(administrator, context.namespace.id);
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
    context.passRegistrationFence();
    await context.controller.deleteCredentialSource(administrator, context.namespace.id, kept.id);
    assert.deepEqual(await list(), []);
  });

  test("rotation needs update on a refresh source, reads no Secret, and refuses static types", async () => {
    const context = await fixture();
    await context.makeReady();
    const { source } = await refreshSource(context);
    const input = { namespaceId: context.namespace.id, credentialSourceId: source.id };
    await assert.rejects(
      context.controller.rotateCredentialSource(deployer, input),
      AuthorizationDeniedError,
    );
    // The updater holds update on sources but no Secret operate: rotation reads no material.
    const rotated = await context.controller.rotateCredentialSource(updater, input);
    assert.equal(rotated.status?.refresh?.state, "ready");
    assert.equal(context.gateway.calls.filter(({ operation }) => operation === "rotate").length, 2);
    // Rotation forces a mint with the stored material; it never reconfigures the source.
    assert.equal(
      context.gateway.calls.filter(({ operation }) => operation === "configureRefresh").length,
      1,
    );

    // A static source has no issuer; rotating it means updating its Secret values instead.
    const model = await context.modelSecret();
    const staticSource = await context.controller.createCredentialSource(administrator, {
      namespaceId: context.namespace.id,
      name: "openai",
      type: "openai",
      secrets: { api_key: model.ref },
    });
    await assert.rejects(
      context.controller.rotateCredentialSource(administrator, {
        namespaceId: context.namespace.id,
        credentialSourceId: staticSource.id,
      }),
      (error: unknown) =>
        error instanceof ResourceConflictError && /refresh-type/.test(error.message),
    );
  });

  test("an update reconfigures refresh material and mints again instead of pushing a value", async () => {
    const context = await fixture();
    await context.makeReady();
    const { source } = await refreshSource(context);
    const replacement = await context.controller.createSecret(administrator, {
      namespaceId: context.namespace.id,
      name: `client-secret-${crypto.randomUUID()}`,
      value: "replacement-client-secret",
    });
    const before = context.gateway.calls.length;
    const updated = await context.controller.updateCredentialSource(administrator, {
      namespaceId: context.namespace.id,
      credentialSourceId: source.id,
      secrets: { client_secret: replacement.ref },
    });
    assert.deepEqual(updated.secrets, { client_secret: replacement.ref });
    assert.equal(updated.status?.refresh?.state, "ready");
    const calls = context.gateway.calls.slice(before);
    assert.deepEqual(
      calls.map(({ operation }) => operation),
      ["configureRefresh", "rotate"],
    );
    const [configuration] = calls;
    assert.equal(configuration?.operation, "configureRefresh");
    assert.deepEqual(configuration.input.secrets, { client_secret: "replacement-client-secret" });
    assert.equal(JSON.stringify(updated).includes("replacement-client-secret"), false);
  });

  test("an update refuses to re-send an issuer-rotated refresh token from its recorded Secret", async () => {
    const context = await fixture();
    await context.makeReady();
    const token = await createSecret(context, "refresh-token", "first-refresh-token");
    const client = await createSecret(context, "client-secret", "synthetic-client-secret");
    const source = await context.controller.createCredentialSource(administrator, {
      namespaceId: context.namespace.id,
      name: "oauth-user",
      type: "oauth-user",
      config: { client_id: "occ-tools" },
      secrets: { refresh_token: token.ref, client_secret: client.ref },
    });
    const input = { namespaceId: context.namespace.id, credentialSourceId: source.id };
    const replacementClient = await createSecret(context, "client-secret", "replacement-secret");
    const gatewayCalls = context.gateway.calls.length;
    const secretReads = context.secretDriver.calls.length;
    // The issuer may have replaced the token since the gateway last used it, so neither a bare
    // update nor one that keeps the token's Secret may send the recorded value again.
    for (const secrets of [
      undefined,
      { refresh_token: token.ref, client_secret: replacementClient.ref },
    ]) {
      await assert.rejects(
        context.controller.updateCredentialSource(administrator, {
          ...input,
          ...(secrets === undefined ? {} : { secrets }),
        }),
        (error) =>
          error instanceof ResourceConflictError &&
          /newer refresh_token/.test(error.message) &&
          /new sign-in/.test(error.message),
      );
    }
    // Refused before any Secret read or gateway effect.
    assert.equal(context.gateway.calls.length, gatewayCalls);
    assert.equal(context.secretDriver.calls.length, secretReads);

    // A fresh token in another Secret is the supported update.
    const fresh = await createSecret(context, "refresh-token", "fresh-refresh-token");
    const updated = await context.controller.updateCredentialSource(administrator, {
      ...input,
      secrets: { refresh_token: fresh.ref, client_secret: client.ref },
    });
    assert.deepEqual(updated.secrets, { refresh_token: fresh.ref, client_secret: client.ref });
    const calls = context.gateway.calls.slice(gatewayCalls);
    assert.deepEqual(
      calls.map(({ operation }) => operation),
      ["configureRefresh", "rotate"],
    );
    const [configuration] = calls;
    assert.equal(configuration?.operation, "configureRefresh");
    assert.equal(configuration.input.secrets.refresh_token, "fresh-refresh-token");

    // A client-credentials type has no issuer-rotated value, so a bare update still re-sends it.
    const { source: clientSource } = await refreshSource(context);
    const before = context.gateway.calls.length;
    await context.controller.updateCredentialSource(administrator, {
      namespaceId: context.namespace.id,
      credentialSourceId: clientSource.id,
    });
    assert.deepEqual(
      context.gateway.calls.slice(before).map(({ operation }) => operation),
      ["configureRefresh", "rotate"],
    );
  });

  test("an update reconfigures a refresh source whose gateway status is pending", async () => {
    const context = await fixture({ gateway: { sourceStatus: { state: "pending" } } });
    await context.makeReady();
    const { source } = await refreshSource(context);
    const replacement = await createSecret(context, "client-secret", "replacement-client-secret");
    const before = context.gateway.calls.length;
    const updated = await context.controller.updateCredentialSource(administrator, {
      namespaceId: context.namespace.id,
      credentialSourceId: source.id,
      secrets: { client_secret: replacement.ref },
    });
    // OCC never commits references the refresh Driver did not receive and mint with.
    assert.deepEqual(
      context.gateway.calls.slice(before).map(({ operation }) => operation),
      ["configureRefresh", "rotate"],
    );
    assert.deepEqual(updated.secrets, { client_secret: replacement.ref });
    assert.equal(updated.status?.refresh?.state, "ready");
  });

  /** Records Namespace and source row locks taken by OCC's transactions from now on. */
  test("a refresh update or rotation waits on the issuer under the source lock, not the Namespace lock", async () => {
    const context = await fixture();
    await context.makeReady();
    const { source } = await refreshSource(context);
    const replacement = await createSecret(context, "client-secret", "replacement-client-secret");
    const input = { namespaceId: context.namespace.id, credentialSourceId: source.id };
    const locks = recordRowLocks(context.state);
    // Each forced mint is an issuer round trip; record which locks the transaction holds then.
    const heldDuringMint: string[][] = [];
    context.refresh.nextRotate = async () => {
      heldDuringMint.push([...locks]);
      return { state: "ready", lastRefreshAt: "2026-09-27T12:30:00.000000000Z" };
    };
    await context.controller.rotateCredentialSource(administrator, input);
    locks.length = 0;
    await context.controller.updateCredentialSource(administrator, {
      ...input,
      secrets: { client_secret: replacement.ref },
    });
    // Other Namespace writes (Agents, Secrets, other sources) never queue behind the issuer; the
    // source lock still orders this source's update, rotation, deletion, and Agent admission.
    assert.deepEqual(heldDuringMint, [
      ["credential_source"],
      ["credential_source", replacement.id],
    ]);

    // An update locks its Secrets in ID order, whatever their field order, so two updates whose
    // sources share Secrets cannot deadlock.
    const token = await createSecret(context, "refresh-token", "synthetic-refresh-token");
    const client = await createSecret(context, "client-secret", "synthetic-client-secret");
    const user = await context.controller.createCredentialSource(administrator, {
      namespaceId: context.namespace.id,
      name: "oauth-user",
      type: "oauth-user",
      config: { client_id: "occ-tools" },
      secrets: { refresh_token: token.ref, client_secret: client.ref },
    });
    // The request names client_secret first, so only ID ordering locks the fresh token first.
    let fresh: Awaited<ReturnType<typeof createSecret>>;
    do {
      fresh = await createSecret(context, "refresh-token", "fresh-refresh-token");
    } while (fresh.id > client.id);
    locks.length = 0;
    heldDuringMint.length = 0;
    await context.controller.updateCredentialSource(administrator, {
      namespaceId: context.namespace.id,
      credentialSourceId: user.id,
      secrets: { client_secret: client.ref, refresh_token: fresh.ref },
    });
    assert.deepEqual(heldDuringMint, [["credential_source", fresh.id, client.id]]);
  });

  test("a refresh update or rotation that fails after reaching the gateway records a failure event", async () => {
    const context = await fixture();
    await context.makeReady();
    const { controller, namespace } = context;
    const { source } = await refreshSource(context);
    const input = { namespaceId: namespace.id, credentialSourceId: source.id };
    const replacement = await createSecret(context, "client-secret", "replacement-client-secret");
    // As the HTTP handler does: the success event commits in the request's own transaction, and
    // the failure builder is used only once that transaction has rolled back.
    type FailureAudit = (reasonCode: string) => AuditEvent;
    const request = (action: string, call: (audit: FailureAudit) => Promise<unknown>) =>
      controller.transact(async (unit) => {
        await call((reasonCode) => ({
          ...auditEvent(namespace.id, source.id, action),
          outcome: "failure",
          reasonCode,
        }));
        await unit.audit.append(auditEvent(namespace.id, source.id, action));
      });
    const outcomes = async () =>
      (await controller.transact((unit) => unit.audit.list()))
        .filter(({ resource }) => resource.id === source.id)
        .map(({ action, outcome, reasonCode }) => [action, outcome, reasonCode]);

    context.refresh.nextRotate = async () => ({
      state: "failed",
      failureCode: "oauth_invalid_grant",
      recoveryAction: "reauthorize",
    });
    await assert.rejects(
      request("openclaw.credential_sources.rotate", (audit) =>
        controller.rotateCredentialSource(administrator, input, audit),
      ),
      DependencyUnavailableError,
    );
    // The gateway already holds the new material when the mint fails, and Agents lose the token.
    await assert.rejects(
      request("openclaw.credential_sources.update", (audit) =>
        controller.updateCredentialSource(
          administrator,
          { ...input, secrets: { client_secret: replacement.ref } },
          audit,
        ),
      ),
      DependencyUnavailableError,
    );
    assert.deepEqual(await outcomes(), [
      ["openclaw.credential_sources.rotate", "failure", "CREDENTIAL_REFRESH_ROTATION_FAILED"],
      ["openclaw.credential_sources.update", "failure", "CREDENTIAL_REFRESH_UPDATE_FAILED"],
    ]);

    // A refusal before any gateway call changed nothing outside OCC, so it records no failure.
    context.refresh.nextRotate = undefined;
    await assert.rejects(
      request("openclaw.credential_sources.rotate", (audit) =>
        controller.rotateCredentialSource(deployer, input, audit),
      ),
      AuthorizationDeniedError,
    );
    const model = await context.modelSecret();
    const staticSource = await controller.createCredentialSource(administrator, {
      namespaceId: namespace.id,
      name: "openai",
      type: "openai",
      secrets: { api_key: model.ref },
    });
    await assert.rejects(
      request("openclaw.credential_sources.rotate", (audit) =>
        controller.rotateCredentialSource(
          administrator,
          { namespaceId: namespace.id, credentialSourceId: staticSource.id },
          audit,
        ),
      ),
      ResourceConflictError,
    );
    // An update refused at the gateway status check, before any write, records no failure either.
    const copy = context.gateway.stored.get(source.id);
    assert.ok(copy);
    context.gateway.stored.delete(source.id);
    const calls = context.gateway.calls.length;
    await assert.rejects(
      request("openclaw.credential_sources.update", (audit) =>
        controller.updateCredentialSource(
          administrator,
          { ...input, secrets: { client_secret: replacement.ref } },
          audit,
        ),
      ),
      DependencyUnavailableError,
    );
    assert.equal(context.gateway.calls.length, calls);
    context.gateway.stored.set(source.id, copy);
    // A failure event that cannot be written never replaces the request's own error.
    context.refresh.nextRotate = async () => ({
      state: "failed",
      failureCode: "oauth_invalid_grant",
    });
    await assert.rejects(
      controller.transact(() =>
        controller.rotateCredentialSource(administrator, input, () => {
          throw new Error("audit store unavailable");
        }),
      ),
      (error) =>
        error instanceof DependencyUnavailableError &&
        /did not mint a token \(oauth_invalid_grant\)/.test(error.message),
    );
    context.refresh.nextRotate = undefined;
    // A success records only its own event.
    await request("openclaw.credential_sources.rotate", (audit) =>
      controller.rotateCredentialSource(administrator, input, audit),
    );
    assert.deepEqual((await outcomes()).slice(2), [
      ["openclaw.credential_sources.rotate", "success", undefined],
    ]);
  });

  test("reading a refresh source reports its refresh status, and deletion removes refresh first", async () => {
    const context = await fixture();
    await context.makeReady();
    const { source } = await refreshSource(context);
    const read = await context.controller.readCredentialSource(
      administrator,
      context.namespace.id,
      source.id,
    );
    assert.deepEqual(read.status, {
      state: "ready",
      refresh: { state: "ready", expiresAt: "2026-09-27T13:00:00.000000000Z" },
    });
    // A static source in the same catalog has no refresh state to read or remove.
    const tool = await context.controller.createCredentialSource(administrator, {
      namespaceId: context.namespace.id,
      name: "registry",
      type: "registry",
      config: { host: "registry.example.com" },
    });
    assert.deepEqual(
      (await context.controller.readCredentialSource(administrator, context.namespace.id, tool.id))
        .status,
      { state: "ready" },
    );
    context.passRegistrationFence();
    const before = context.gateway.calls.length;
    await context.controller.deleteCredentialSource(administrator, context.namespace.id, tool.id);
    await context.controller.deleteCredentialSource(administrator, context.namespace.id, source.id);
    assert.deepEqual(
      context.gateway.calls.slice(before).map(({ operation, sourceId }) => [operation, sourceId]),
      [
        ["removeSource", tool.id],
        ["removeRefresh", source.id],
        ["removeSource", source.id],
      ],
    );
  });

  test("reading a refresh source the gateway no longer holds reports no refresh status", async () => {
    const context = await fixture();
    await context.makeReady();
    const { source } = await refreshSource(context);
    context.gateway.stored.delete(source.id);
    const read = await context.controller.readCredentialSource(
      administrator,
      context.namespace.id,
      source.id,
    );
    assert.deepEqual(read.status, { state: "absent" });
    assert.equal(
      context.gateway.calls.some(({ operation }) => operation === "refreshStatus"),
      false,
    );
  });

  test("reading a source whose type left the catalog keeps the gateway's status", async () => {
    const context = await fixture();
    await context.makeReady();
    const tool = await context.controller.createCredentialSource(administrator, {
      namespaceId: context.namespace.id,
      name: "registry",
      type: "registry",
      config: { host: "registry.example.com" },
    });
    const { source: refresh } = await refreshSource(context);
    // Removing an Installation setting, such as OpenShell's toolBinaries, withdraws types from
    // the catalog. Existing sources stay registered, so a read must still report the gateway's
    // own status rather than a false failure.
    context.gateway.listSourceTypes = async () => [];
    const read = (source: Pick<CredentialSourceMetadata, "id">) =>
      context.controller.readCredentialSource(administrator, context.namespace.id, source.id);
    assert.deepEqual((await read(tool)).status, { state: "ready" });
    // An unoffered refresh type cannot be classified, so its read omits refresh status.
    assert.deepEqual((await read(refresh)).status, { state: "ready" });
  });
}
