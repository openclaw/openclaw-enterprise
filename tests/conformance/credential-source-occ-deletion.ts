import assert from "node:assert/strict";
import test from "node:test";
import {
  AuthorizationDeniedError,
  DependencyUnavailableError,
  ResourceConflictError,
} from "../../packages/occ/src/index.ts";
import { grantRole } from "../helpers/iam-grants.mjs";
import {
  administrator,
  auditActions,
  auditEvent,
  fixture,
  refreshSource,
  zeroGrant,
} from "./credential-source-occ-fixture.ts";

export function registerDeletionCases(): void {
  test("a deletion that wins against a registration removes the late gateway copy and the record", async () => {
    const { controller, gateway, makeReady, modelSecret, namespace } = await fixture();
    await makeReady();
    const secret = await modelSecret();
    const register = gateway.registerSource.bind(gateway);
    let deletion: unknown;
    gateway.registerSource = async (context, input) => {
      // DELETE marks the `registering` record `deleting` while the gateway call is in flight.
      deletion = await controller
        .deleteCredentialSource(administrator, namespace.id, context.source.id)
        .then(
          () => "deleted",
          (error: unknown) => error,
        );
      return register(context, input);
    };
    await assert.rejects(
      controller.createCredentialSource(
        administrator,
        {
          namespaceId: namespace.id,
          name: "openai",
          type: "openai",
          secrets: { api_key: secret.ref },
        },
        (created) => auditEvent(namespace.id, created.id, "openclaw.credential_sources.create"),
      ),
      (error) =>
        error instanceof ResourceConflictError &&
        error.message === "The credential source changed during registration.",
    );
    // The deletion found no copy yet and stays retryable inside the registration fence.
    assert.ok(deletion instanceof DependencyUnavailableError, String(deletion));
    // The copy stored after the deletion is removed, and no success event is committed.
    assert.equal(gateway.stored.size, 0);
    assert.deepEqual(await auditActions(controller), []);
    assert.deepEqual(await controller.listCredentialSources(administrator, namespace.id), []);
  });

  test("a deletion that wins against a refresh registration also removes the refresh state", async () => {
    const context = await fixture();
    await context.makeReady();
    const { controller, gateway, namespace } = context;
    const register = gateway.registerSource.bind(gateway);
    let deletion: unknown;
    gateway.registerSource = async (call, input) => {
      deletion = await controller
        .deleteCredentialSource(administrator, namespace.id, call.source.id)
        .then(
          () => "deleted",
          (error: unknown) => error,
        );
      return register(call, input);
    };
    await assert.rejects(
      refreshSource(context),
      (error) =>
        error instanceof ResourceConflictError &&
        error.message === "The credential source changed during registration.",
    );
    // The deletion found no copy yet and stays retryable inside the registration fence.
    assert.ok(deletion instanceof DependencyUnavailableError, String(deletion));
    // The first mint configured refresh state after the deletion; cleanup removes it with the copy.
    assert.equal(context.refresh.configured.size, 0);
    assert.equal(gateway.stored.size, 0);
    assert.deepEqual(await controller.listCredentialSources(administrator, namespace.id), []);
  });

  test("only a ready credential source can be updated", async () => {
    let failRemove = false;
    const { controller, gateway, makeReady, modelSecret, namespace } = await fixture({
      gateway: { removeError: () => (failRemove ? new Error("gateway unavailable") : undefined) },
    });
    await makeReady();
    const secret = await modelSecret();
    const source = await controller.createCredentialSource(administrator, {
      namespaceId: namespace.id,
      name: "openai",
      type: "openai",
      secrets: { api_key: secret.ref },
    });
    failRemove = true;
    await assert.rejects(
      controller.deleteCredentialSource(administrator, namespace.id, source.id),
      DependencyUnavailableError,
    );
    // Precondition: a `deleting` source keeps its gateway copy until DELETE completes.
    assert.equal(gateway.stored.has(source.id), true);
    // An update must not refresh that copy.
    await assert.rejects(
      controller.updateCredentialSource(administrator, {
        namespaceId: namespace.id,
        credentialSourceId: source.id,
      }),
      (error) =>
        error instanceof ResourceConflictError &&
        error.message === "Only a ready credential source can be updated.",
    );
    assert.equal(gateway.calls.filter(({ operation }) => operation === "updateSource").length, 0);
  });

  test("reading a credential source requires read on it, and listing filters per source", async () => {
    const { controller, iamState, makeReady, modelSecret, namespace } = await fixture();
    await makeReady();
    const secret = await modelSecret();
    const sources: Awaited<ReturnType<typeof controller.createCredentialSource>>[] = [];
    for (const name of ["visible", "hidden"]) {
      sources.push(
        await controller.createCredentialSource(administrator, {
          namespaceId: namespace.id,
          name,
          type: "openai",
          secrets: { api_key: secret.ref },
        }),
      );
    }
    const [visible, hidden] = sources;
    assert.ok(visible);
    assert.ok(hidden);
    await assert.rejects(
      controller.readCredentialSource(zeroGrant, namespace.id, visible.id),
      AuthorizationDeniedError,
    );
    // Namespace read lists only the sources this principal may read.
    const reader = "principal-source-namespace-reader";
    iamState.identities.push({
      kind: "principal",
      id: reader,
      issuer: "credential-source-occ",
      subject: reader,
    });
    grantRole(iamState, reader, {
      id: "source-namespace-reader-role",
      namespaceId: namespace.id,
      permissions: { namespace: ["read"] },
    });
    assert.deepEqual(await controller.listCredentialSources(reader, namespace.id), []);
    grantRole(iamState, reader, {
      id: "source-one-reader-role",
      namespaceId: namespace.id,
      permissions: { credential_source: ["read"] },
      resource: { kind: "credential_source", id: visible.id },
    });
    assert.deepEqual(
      (await controller.listCredentialSources(reader, namespace.id)).map(({ id }) => id),
      [visible.id],
    );
    assert.equal(
      (await controller.readCredentialSource(reader, namespace.id, visible.id)).id,
      visible.id,
    );
    await assert.rejects(
      controller.readCredentialSource(reader, namespace.id, hidden.id),
      AuthorizationDeniedError,
    );
  });

  test("a failing gateway status read reports a fixed reason, not the gateway's error", async () => {
    const { controller, gateway, makeReady, modelSecret, namespace } = await fixture();
    await makeReady();
    const secret = await modelSecret();
    const source = await controller.createCredentialSource(administrator, {
      namespaceId: namespace.id,
      name: "openai",
      type: "openai",
      secrets: { api_key: secret.ref },
    });
    gateway.sourceStatus = async () => {
      throw new Error("gateway echoed synthetic-model-key and internal address 10.0.0.7");
    };
    const read = await controller.readCredentialSource(administrator, namespace.id, source.id);
    assert.deepEqual(read.status, {
      state: "failed",
      reason: "The Credential Gateway status is unavailable.",
    });
    assert.equal(JSON.stringify(read).includes("synthetic-model-key"), false);
    assert.equal(JSON.stringify(read).includes("10.0.0.7"), false);
  });
}
