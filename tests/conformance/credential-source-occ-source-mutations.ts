import type {
  CredentialSourceMetadata,
  SecretReference,
} from "../../packages/contracts/src/index.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { requestFailure } from "../../apps/controller/src/http/errors.ts";
import {
  AuthorizationDeniedError,
  CredentialSourceTypeNotOfferedError,
  DependencyUnavailableError,
  NamespaceNotEmptyError,
  NamespaceNotReadyError,
  type PlatformUnitOfWork,
  ResourceConflictError,
  ScopeViolationError,
} from "../../packages/occ/src/index.ts";
import { RESOURCE_NOT_FOUND } from "../helpers/refusal-text.mjs";
import {
  refusedAnswer,
  credentialSourceFieldRequired,
  credentialSourceFieldUnknown,
  registrationFenceRetry,
} from "./credential-source-occ-refusals.ts";
import {
  administrator,
  auditActions,
  auditEvent,
  type GatewayOptions,
  deployer,
  fixture,
  updater,
} from "./credential-source-occ-fixture.ts";

export function registerSourceMutationCases(): void {
  test("registration validates the catalog and hands the gateway values OCC never stores", async () => {
    const { controller, gateway, makeReady, modelSecret, namespace } = await fixture();
    await assert.rejects(
      controller.createCredentialSource(administrator, {
        namespaceId: namespace.id,
        name: "before-ready",
        type: "openai",
      }),
      NamespaceNotReadyError,
    );
    await makeReady();
    const secret = await modelSecret();

    // Unknown types, missing required inputs, and unknown fields fail before any gateway effect.
    await assert.rejects(
      controller.createCredentialSource(administrator, {
        namespaceId: namespace.id,
        name: "invalid",
        type: "unknown",
      }),
      CredentialSourceTypeNotOfferedError,
    );
    // A catalog field refusal is a request error that names the field and its fix, not the
    // generic 404 (finding 2536). The detail points at the submitted member.
    for (const [input, message, path] of [
      [
        { type: "openai" },
        credentialSourceFieldRequired("openai", "secrets.api_key"),
        "/secrets/api_key",
      ],
      [
        { type: "openai", secrets: { api_key: secret.ref, extra: secret.ref } },
        credentialSourceFieldUnknown("openai", "secrets.extra", "secrets", "api_key"),
        "/secrets/extra",
      ],
      [
        { type: "openai", config: { region: "x" }, secrets: { api_key: secret.ref } },
        credentialSourceFieldUnknown("openai", "config.region", "config", "none"),
        "/config/region",
      ],
      [
        { type: "registry" },
        credentialSourceFieldRequired("registry", "config.host"),
        "/config/host",
      ],
    ] as const) {
      const rejection = await controller
        .createCredentialSource(administrator, {
          namespaceId: namespace.id,
          name: "invalid",
          ...input,
        })
        .then(
          () => assert.fail(`${message}: expected a rejection`),
          (error: unknown) => error,
        );
      const { status, code, message: sent, details } = requestFailure(rejection);
      assert.deepEqual(
        { status, code, message: sent, details },
        {
          status: 400,
          code: "INVALID_REQUEST",
          message,
          details: [{ path, code: "INVALID_VALUE" }],
        },
      );
    }
    assert.equal(gateway.calls.length, 0);

    const source = await controller.createCredentialSource(administrator, {
      namespaceId: namespace.id,
      name: "openai",
      type: "openai",
      secrets: { api_key: secret.ref },
    });
    assert.equal(source.state, "ready");
    assert.deepEqual(source.status, { state: "ready" });
    assert.deepEqual(source.ref, {
      kind: "credential_source",
      namespaceId: namespace.id,
      id: source.id,
    });
    assert.deepEqual(source.secrets, { api_key: secret.ref });
    // The gateway receives the resolved value; OCC metadata only carries the Secret reference.
    assert.deepEqual(gateway.stored.get(source.id), { api_key: "synthetic-model-key" });
    // The gateway receives Compute's placement, not the Namespace display name.
    const registration = gateway.calls.find((call) => call.operation === "registerSource");
    assert.equal(registration?.namespaceName, `placed-${namespace.id.slice(-12)}`);
    assert.equal(JSON.stringify(source).includes("synthetic-model-key"), false);
    const listed = await controller.listCredentialSources(administrator, namespace.id);
    assert.equal(JSON.stringify(listed).includes("synthetic-model-key"), false);
  });

  test("registration requires operate on every referenced Secret before reading it", async () => {
    const { controller, gateway, makeReady, modelSecret, namespace, secretDriver } =
      await fixture();
    await makeReady();
    const secret = await modelSecret();
    await assert.rejects(
      controller.createCredentialSource(deployer, {
        namespaceId: namespace.id,
        name: "unauthorized",
        type: "openai",
        secrets: { api_key: secret.ref },
      }),
      AuthorizationDeniedError,
    );
    assert.equal(secretDriver.calls.filter(({ operation }) => operation === "withValue").length, 0);
    assert.equal(gateway.calls.length, 0);
  });

  test("a cross-Namespace Secret is an invalid request; a Secret the Namespace lacks stays not-found", async () => {
    const { controller, gateway, makeReady, modelSecret, namespace, secretDriver } =
      await fixture();
    await makeReady();
    const secret = await modelSecret();
    const source = await controller.createCredentialSource(administrator, {
      namespaceId: namespace.id,
      name: "openai",
      type: "openai",
      secrets: { api_key: secret.ref },
    });
    gateway.calls.length = 0;
    secretDriver.calls.length = 0;
    const foreign = { ...secret.ref, namespaceId: `ns_${crypto.randomUUID()}` };
    const missing = { ...secret.ref, id: `sec_${crypto.randomUUID()}` };
    const writes = [
      [
        "create",
        (ref: SecretReference) =>
          controller.createCredentialSource(administrator, {
            namespaceId: namespace.id,
            name: `openai-${crypto.randomUUID().slice(0, 8)}`,
            type: "openai",
            secrets: { api_key: ref },
          }),
      ],
      [
        "update",
        (ref: SecretReference) =>
          controller.updateCredentialSource(administrator, {
            namespaceId: namespace.id,
            credentialSourceId: source.id,
            secrets: { api_key: ref },
          }),
      ],
    ] as const;
    for (const [write, call] of writes) {
      for (const [description, ref, expected] of [
        [
          "cross-Namespace Secret",
          foreign,
          {
            status: 400,
            code: "INVALID_REQUEST",
            message: "Credential source Secrets cannot cross Namespaces.",
          },
        ],
        [
          "missing Secret",
          missing,
          {
            status: 404,
            code: "NOT_FOUND",
            message: RESOURCE_NOT_FOUND,
          },
        ],
      ] as const) {
        const rejection = await call(ref).then(
          () => assert.fail(`${write}, ${description}: expected a rejection`),
          (error: unknown) => error,
        );
        const { status, code, message } = requestFailure(rejection);
        assert.deepEqual({ status, code, message }, expected, `${write}, ${description}`);
      }
    }
    // Every reference is checked before any of them is authorized: a foreign second field wins
    // over a first field the deployer may not operate.
    const listSourceTypes = gateway.listSourceTypes.bind(gateway);
    gateway.listSourceTypes = async (...args) => [
      ...(await listSourceTypes(...args)),
      {
        type: "pair",
        config: [],
        secrets: [
          { name: "first", required: true },
          { name: "second", required: true },
        ],
        rotation: "none",
      },
    ];
    const mixed = await controller
      .createCredentialSource(deployer, {
        namespaceId: namespace.id,
        name: "pair",
        type: "pair",
        secrets: { first: secret.ref, second: foreign },
      })
      .then(
        () => assert.fail("a foreign second field must be rejected"),
        (error: unknown) => error,
      );
    const { status, code, message } = requestFailure(mixed);
    assert.deepEqual(
      { status, code, message },
      {
        status: 400,
        code: "INVALID_REQUEST",
        message: "Credential source Secrets cannot cross Namespaces.",
      },
    );
    assert.deepEqual(gateway.calls, []);
    assert.equal(secretDriver.calls.filter(({ operation }) => operation === "withValue").length, 0);
  });

  test("credential source writes refuse active and stale borrowed transactions before effects", async () => {
    const {
      controller,
      gateway,
      makeReady,
      modelSecret,
      namespace,
      passRegistrationFence,
      secretDriver,
    } = await fixture();
    await makeReady();
    const secret = await modelSecret();
    const input = {
      namespaceId: namespace.id,
      name: "nested-openai",
      type: "openai",
      secrets: { api_key: secret.ref },
    };
    // A top-level create is also the ready record that a nested delete must leave alone.
    const source = await controller.createCredentialSource(administrator, {
      ...input,
      name: "top-level-openai",
    });
    let catalogCalls = 0;
    const listSourceTypes = gateway.listSourceTypes.bind(gateway);
    gateway.listSourceTypes = async (...args) => {
      catalogCalls += 1;
      return listSourceTypes(...args);
    };
    let auditCallbacks = 0;
    const createAudit = (created: Readonly<CredentialSourceMetadata>) => {
      auditCallbacks += 1;
      return auditEvent(namespace.id, created.id, "openclaw.credential_sources.create");
    };
    const deleteAudit = () => {
      auditCallbacks += 1;
      return auditEvent(namespace.id, source.id, "openclaw.credential_sources.delete");
    };
    const snapshot = async (unit: PlatformUnitOfWork) =>
      structuredClone({
        sources: await unit.credentialSources.listCredentialSources(namespace.id),
        audit: await unit.audit.list(),
      });
    const before = await controller.transact(snapshot);
    const gatewayCalls = gateway.calls.length;
    const secretReads = secretDriver.calls.filter(
      ({ operation }) => operation === "withValue",
    ).length;
    const stored = structuredClone(gateway.stored);
    const assertRefused = async (operation: Promise<unknown>) =>
      assert.rejects(operation, (error) => {
        assert.ok(error instanceof ResourceConflictError);
        assert.match(error.message, /cannot run in a controller transaction/);
        return true;
      });
    const attemptBoth = async () => {
      await assertRefused(controller.createCredentialSource(administrator, input, createAudit));
      await assertRefused(
        controller.deleteCredentialSource(administrator, namespace.id, source.id, deleteAudit),
      );
    };

    await controller.transact(async (unit) => {
      await attemptBoth();
      assert.deepEqual(await snapshot(unit), before);
    });

    // The async task inherits the unit of work, but is released only after its owner commits.
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    let staleAttempt: Promise<void> | undefined;
    await controller.transact(async () => {
      staleAttempt = (async () => {
        await gate;
        await attemptBoth();
      })();
    });
    release();
    assert.ok(staleAttempt);
    await staleAttempt;
    assert.deepEqual(await controller.transact(snapshot), before);
    assert.equal(
      secretDriver.calls.filter(({ operation }) => operation === "withValue").length,
      secretReads,
    );
    assert.equal(catalogCalls, 0);
    assert.equal(gateway.calls.length, gatewayCalls);
    assert.deepEqual(gateway.stored, stored);
    assert.equal(auditCallbacks, 0);

    // The boundary check must not prevent ordinary independent create and delete phases.
    const second = await controller.createCredentialSource(administrator, input);
    assert.equal(second.state, "ready");
    passRegistrationFence();
    await controller.deleteCredentialSource(administrator, namespace.id, source.id);
    await controller.deleteCredentialSource(administrator, namespace.id, second.id);
    assert.deepEqual(await controller.listCredentialSources(administrator, namespace.id), []);
  });

  test("a definitive registration failure removes the gateway copy and the record", async () => {
    const { controller, gateway, makeReady, modelSecret, namespace } = await fixture({
      gateway: { registerStatus: { state: "failed", reason: "rejected" } },
    });
    await makeReady();
    const secret = await modelSecret();
    await assert.rejects(
      controller.createCredentialSource(
        administrator,
        {
          namespaceId: namespace.id,
          name: "openai",
          type: "openai",
          secrets: { api_key: secret.ref },
        },
        (source) => auditEvent(namespace.id, source.id, "openclaw.credential_sources.create"),
      ),
      DependencyUnavailableError,
    );
    // The gateway answered, so no create is still in flight and the record can go at once.
    assert.deepEqual(await controller.listCredentialSources(administrator, namespace.id), []);
    assert.deepEqual(
      gateway.calls.map(({ operation }) => operation),
      ["registerSource", "removeSource"],
    );
    // Only a completed registration is audited as a successful mutation.
    assert.deepEqual(await auditActions(controller), []);
  });

  test("a timed-out registration keeps its record until a late gateway create is removed", async () => {
    const { advanceClock, controller, gateway, makeReady, modelSecret, namespace } = await fixture({
      gateway: { lateCreate: true },
    });
    await makeReady();
    const secret = await modelSecret();
    await assert.rejects(
      controller.createCredentialSource(administrator, {
        namespaceId: namespace.id,
        name: "openai",
        type: "openai",
        secrets: { api_key: secret.ref },
      }),
      DependencyUnavailableError,
    );
    // Cleanup found no copy, but the outcome was unknown, so OCC keeps the cleanup handle.
    const [orphan] = await controller.listCredentialSources(administrator, namespace.id);
    assert.ok(orphan);
    assert.equal(orphan.state, "deleting");
    assert.equal(gateway.stored.has(orphan.id), false);
    gateway.completeLateCreates();
    assert.equal(gateway.stored.has(orphan.id), true);

    // Within the fence, DELETE removes the copy but keeps the record for a later retry. The 503
    // names the wait instead of the generic text (finding 2536).
    const fenced = (seconds: number) => (error: unknown) => {
      assert.ok(error instanceof DependencyUnavailableError);
      const { status, code, message } = requestFailure(error);
      assert.deepEqual(
        { status, code, message },
        { status: 503, code: "DEPENDENCY_UNAVAILABLE", message: registrationFenceRetry(seconds) },
      );
      return true;
    };
    await assert.rejects(
      controller.deleteCredentialSource(administrator, namespace.id, orphan.id),
      fenced(70),
    );
    assert.equal(gateway.stored.has(orphan.id), false);
    assert.equal(
      (await controller.readCredentialSource(administrator, namespace.id, orphan.id)).state,
      "deleting",
    );
    // The fence is twice the gateway timeout plus 10 s after createdAt: 70 s.
    advanceClock(69_999);
    await assert.rejects(
      controller.deleteCredentialSource(administrator, namespace.id, orphan.id),
      fenced(1),
    );
    advanceClock(1);
    await controller.deleteCredentialSource(administrator, namespace.id, orphan.id);
    assert.deepEqual(await controller.listCredentialSources(administrator, namespace.id), []);
  });

  test("an uncertain registration whose cleanup fails stays listed until DELETE removes the copy", async () => {
    let failRemove = true;
    const { controller, gateway, makeReady, modelSecret, namespace, passRegistrationFence } =
      await fixture({
        gateway: {
          replyError: new Error("reply lost"),
          removeError: () => (failRemove ? new Error("gateway unavailable") : undefined),
        },
      });
    await makeReady();
    const secret = await modelSecret();
    // The gateway stored a copy but OCC never learned the outcome, and cleanup failed too.
    await assert.rejects(
      controller.createCredentialSource(administrator, {
        namespaceId: namespace.id,
        name: "openai",
        type: "openai",
        secrets: { api_key: secret.ref },
      }),
      DependencyUnavailableError,
    );
    const [orphan] = await controller.listCredentialSources(administrator, namespace.id);
    assert.ok(orphan);
    assert.equal(orphan.state, "deleting");
    assert.equal(gateway.stored.has(orphan.id), true);

    // The record keeps the provider identity, so an ordinary DELETE retry removes the copy.
    failRemove = false;
    passRegistrationFence();
    await controller.deleteCredentialSource(administrator, namespace.id, orphan.id);
    assert.equal(gateway.stored.has(orphan.id), false);
    assert.deepEqual(await controller.listCredentialSources(administrator, namespace.id), []);
  });

  test("registration and deletion commit their audit events with the final state change", async () => {
    const { controller, makeReady, modelSecret, namespace, passRegistrationFence } =
      await fixture();
    await makeReady();
    const secret = await modelSecret();
    const source = await controller.createCredentialSource(
      administrator,
      {
        namespaceId: namespace.id,
        name: "openai",
        type: "openai",
        secrets: { api_key: secret.ref },
      },
      (created) => auditEvent(namespace.id, created.id, "openclaw.credential_sources.create"),
    );
    assert.equal(source.state, "ready");
    assert.deepEqual(await auditActions(controller), ["openclaw.credential_sources.create"]);
    passRegistrationFence();

    // An audit that cannot be appended rolls back the removal, so DELETE can be retried.
    await assert.rejects(
      controller.deleteCredentialSource(administrator, namespace.id, source.id, () => ({
        ...auditEvent(namespace.id, source.id, "openclaw.credential_sources.delete"),
        installationId: "ins_other",
      })),
      ScopeViolationError,
    );
    const retained = await controller.readCredentialSource(administrator, namespace.id, source.id);
    assert.equal(retained.state, "deleting");
    await controller.deleteCredentialSource(administrator, namespace.id, source.id, () =>
      auditEvent(namespace.id, source.id, "openclaw.credential_sources.delete"),
    );
    assert.deepEqual(await auditActions(controller), [
      "openclaw.credential_sources.create",
      "openclaw.credential_sources.delete",
    ]);
    assert.deepEqual(await controller.listCredentialSources(administrator, namespace.id), []);
  });

  test("deletion is refused while referenced, retried while the gateway fails, and gates the Namespace", async () => {
    let failRemove = false;
    const {
      controller,
      dedicatedAgent,
      gateway,
      makeReady,
      modelSecret,
      namespace,
      passRegistrationFence,
    } = await fixture({
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
    const agent = await dedicatedAgent();
    await controller.updateAgent(administrator, {
      namespaceId: namespace.id,
      agentId: agent.id,
      configurationId: agent.configurationId,
      harnessAuth: { method: "credential_source", sourceId: source.id },
      credentialSources: [{ sourceId: source.id }],
    });

    // A bound source and its Secret cannot be removed out from under the Agent.
    await assert.rejects(
      controller.deleteCredentialSource(administrator, namespace.id, source.id),
      ResourceConflictError,
    );
    await assert.rejects(
      controller.deleteSecret(administrator, namespace.id, secret.id),
      (error) =>
        error instanceof ResourceConflictError &&
        error.message ===
          `The Secret is still referenced by credential source ${source.id}. Remove those references first.`,
    );
    // The list holds the reference, so unbinding clears both the Harness binding and the list.
    await controller.updateAgent(administrator, {
      namespaceId: namespace.id,
      agentId: agent.id,
      configurationId: agent.configurationId,
      harnessAuth: null,
      credentialSources: [],
    });

    // A gateway failure keeps the record `deleting` so the caller can retry.
    failRemove = true;
    await assert.rejects(
      controller.deleteCredentialSource(administrator, namespace.id, source.id),
      DependencyUnavailableError,
    );
    const deleting = await controller.readCredentialSource(administrator, namespace.id, source.id);
    assert.equal(deleting.state, "deleting");
    // A deleting source cannot be bound again, and it still makes the Namespace nonempty.
    await assert.rejects(
      controller.updateAgent(administrator, {
        namespaceId: namespace.id,
        agentId: agent.id,
        configurationId: agent.configurationId,
        harnessAuth: { method: "credential_source", sourceId: source.id },
        credentialSources: [{ sourceId: source.id }],
      }),
      ScopeViolationError,
    );

    failRemove = false;
    passRegistrationFence();
    await controller.deleteCredentialSource(administrator, namespace.id, source.id);
    assert.deepEqual(await controller.listCredentialSources(administrator, namespace.id), []);
    assert.equal(gateway.stored.has(source.id), false);
  });

  test("a credential source, including one being deleted, keeps its Namespace nonempty", async () => {
    let failRemove = false;
    const { controller, makeReady, namespace, passRegistrationFence } = await fixture({
      gateway: { removeError: () => (failRemove ? new Error("gateway unavailable") : undefined) },
    });
    await makeReady();
    // A secretless source is the Namespace's only resource, so only the source guard can refuse.
    const source = await controller.createCredentialSource(administrator, {
      namespaceId: namespace.id,
      name: "registry",
      type: "registry",
      config: { host: "registry.example.com" },
    });
    await assert.rejects(
      controller.deleteNamespace(administrator, namespace.id),
      NamespaceNotEmptyError,
    );
    failRemove = true;
    await assert.rejects(
      controller.deleteCredentialSource(administrator, namespace.id, source.id),
      DependencyUnavailableError,
    );
    await assert.rejects(
      controller.deleteNamespace(administrator, namespace.id),
      NamespaceNotEmptyError,
    );
    failRemove = false;
    passRegistrationFence();
    await controller.deleteCredentialSource(administrator, namespace.id, source.id);
    await controller.deleteNamespace(administrator, namespace.id);
  });

  test("an update re-sends current or replacement Secret values and keeps config immutable", async () => {
    const { controller, gateway, makeReady, modelSecret, namespace, state } = await fixture();
    await makeReady();
    const original = await modelSecret();
    const source = await controller.createCredentialSource(administrator, {
      namespaceId: namespace.id,
      name: "openai",
      type: "openai",
      secrets: { api_key: original.ref },
    });

    // A bare update re-reads the referenced Secret, so a changed Secret reaches the gateway copy.
    await controller.updateSecret(administrator, {
      namespaceId: namespace.id,
      secretId: original.id,
      value: "rotated-model-key",
    });
    const resynced = await controller.updateCredentialSource(administrator, {
      namespaceId: namespace.id,
      credentialSourceId: source.id,
    });
    assert.deepEqual(resynced.status, { state: "ready" });
    assert.deepEqual(gateway.stored.get(source.id), { api_key: "rotated-model-key" });
    // Only the gateway holds the value: the response, the read, and OCC's record carry references.
    assert.equal(JSON.stringify(resynced).includes("rotated-model-key"), false);
    const reread = await controller.readCredentialSource(administrator, namespace.id, source.id);
    assert.equal(JSON.stringify(reread).includes("rotated-model-key"), false);
    const persisted = await state.read((view) =>
      view.credentialSources.findCredentialSource(namespace.id, source.id),
    );
    assert.equal(JSON.stringify(persisted).includes("rotated-model-key"), false);

    // Replacement references switch the source to another same-Namespace Secret.
    const replacement = await modelSecret();
    const replaced = await controller.updateCredentialSource(administrator, {
      namespaceId: namespace.id,
      credentialSourceId: source.id,
      secrets: { api_key: replacement.ref },
    });
    assert.deepEqual(replaced.secrets, { api_key: replacement.ref });
    assert.deepEqual(gateway.stored.get(source.id), { api_key: "synthetic-model-key" });
    assert.equal(JSON.stringify(replaced).includes("synthetic-model-key"), false);
    // The original Secret is no longer referenced by the source, so it can now be deleted.
    await controller.deleteSecret(administrator, namespace.id, original.id);

    // Replacements must keep the catalog's exact fields.
    assert.deepEqual(
      await refusedAnswer(() =>
        controller.updateCredentialSource(administrator, {
          namespaceId: namespace.id,
          credentialSourceId: source.id,
          secrets: { api_key: replacement.ref, extra: replacement.ref },
        }),
      ),
      {
        status: 400,
        code: "INVALID_REQUEST",
        message: credentialSourceFieldUnknown("openai", "secrets.extra", "secrets", "api_key"),
      },
    );
  });

  test("an update requires update on the source and operate on every Secret it reads", async () => {
    const { controller, gateway, makeReady, modelSecret, namespace } = await fixture({
      gateway: {},
    });
    await makeReady();
    const secret = await modelSecret();
    const source = await controller.createCredentialSource(administrator, {
      namespaceId: namespace.id,
      name: "openai",
      type: "openai",
      secrets: { api_key: secret.ref },
    });
    // The deployer may read and create sources but holds neither update nor Secret operate.
    await assert.rejects(
      controller.updateCredentialSource(deployer, {
        namespaceId: namespace.id,
        credentialSourceId: source.id,
      }),
      AuthorizationDeniedError,
    );
    // Update on the source alone is not enough: every Secret it reads needs operate too.
    await assert.rejects(
      controller.updateCredentialSource(updater, {
        namespaceId: namespace.id,
        credentialSourceId: source.id,
      }),
      (error) =>
        error instanceof AuthorizationDeniedError &&
        error.authorization?.resource.kind === "secret" &&
        error.authorization.resource.id === secret.id,
    );
    assert.equal(gateway.calls.filter(({ operation }) => operation === "updateSource").length, 0);
  });

  test("an update whose commit fails after the gateway accepted it converges when repeated", async () => {
    const { controller, gateway, makeReady, modelSecret, namespace } = await fixture();
    await makeReady();
    const original = await modelSecret();
    const source = await controller.createCredentialSource(administrator, {
      namespaceId: namespace.id,
      name: "openai",
      type: "openai",
      secrets: { api_key: original.ref },
    });
    const replacement = await modelSecret();
    await controller.updateSecret(administrator, {
      namespaceId: namespace.id,
      secretId: replacement.id,
      value: "replacement-model-key",
    });
    const input = {
      namespaceId: namespace.id,
      credentialSourceId: source.id,
      secrets: { api_key: replacement.ref },
    };

    // The gateway call runs inside the request's transaction; a later failure, such as its
    // audit append, rolls back OCC's references while the gateway copy is already newer.
    await assert.rejects(
      controller.transact(async () => {
        await controller.updateCredentialSource(administrator, input);
        throw new Error("audit append failed");
      }),
      /audit append failed/,
    );
    assert.deepEqual(gateway.stored.get(source.id), { api_key: "replacement-model-key" });
    const retained = await controller.readCredentialSource(administrator, namespace.id, source.id);
    assert.deepEqual(retained.secrets, { api_key: original.ref });

    // Repeating the same request brings OCC level with the gateway.
    const repeated = await controller.updateCredentialSource(administrator, input);
    assert.deepEqual(repeated.secrets, { api_key: replacement.ref });
    assert.deepEqual(gateway.stored.get(source.id), { api_key: "replacement-model-key" });
  });

  for (const [failure, gatewayOptions] of [
    ["throws", { updateError: new Error("gateway unavailable") }],
    // The gateway lost its copy while OCC still records the source as ready.
    ["reports the copy absent", { updateStatus: { state: "absent" } }],
    ["reports the update failed", { updateStatus: { state: "failed" } }],
  ] satisfies [string, GatewayOptions][]) {
    test(`a gateway update that ${failure} keeps the source and its Secret references unchanged`, async () => {
      const { controller, makeReady, modelSecret, namespace } = await fixture({
        gateway: gatewayOptions,
      });
      await makeReady();
      const original = await modelSecret();
      const source = await controller.createCredentialSource(administrator, {
        namespaceId: namespace.id,
        name: "openai",
        type: "openai",
        secrets: { api_key: original.ref },
      });
      const replacement = await modelSecret();
      const action = "openclaw.credential_sources.update";
      await assert.rejects(
        controller.transact(() =>
          controller.updateCredentialSource(
            administrator,
            {
              namespaceId: namespace.id,
              credentialSourceId: source.id,
              secrets: { api_key: replacement.ref },
            },
            (reasonCode) => ({
              ...auditEvent(namespace.id, source.id, action),
              outcome: "failure",
              reasonCode,
            }),
          ),
        ),
        DependencyUnavailableError,
      );
      const retained = await controller.readCredentialSource(
        administrator,
        namespace.id,
        source.id,
      );
      assert.equal(retained.state, "ready");
      assert.deepEqual(retained.secrets, { api_key: original.ref });
      // The gateway call began, so the failure is audited after OCC's transaction rolled back.
      assert.deepEqual(
        (await controller.transact((unit) => unit.audit.list()))
          .filter(({ resource }) => resource.id === source.id)
          .map(({ outcome, reasonCode }) => [outcome, reasonCode]),
        [["failure", "CREDENTIAL_GATEWAY_UPDATE_FAILED"]],
      );
    });
  }
}
