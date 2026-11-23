import type { SecretReference } from "../../packages/contracts/src/index.ts";
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
} from "../../packages/occ/src/index.ts";
import { RESOURCE_NOT_FOUND } from "../helpers/refusal-text.mjs";
import {
  credentialSourceFieldRequired,
  credentialSourceFieldUnknown,
} from "../helpers/refusal-credential-admission.ts";
import {
  administrator,
  auditActions,
  auditEvent,
  deployer,
  fixture,
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

  test("Gateway registration refuses active and stale borrowed transactions before effects", async () => {
    const { controller, gateway, makeReady, modelSecret, namespace, secretDriver } =
      await fixture();
    await makeReady();
    const secret = await modelSecret();
    const input = {
      namespaceId: namespace.id,
      name: "nested-openai",
      type: "openai",
      secrets: { api_key: secret.ref },
    };
    // Keep a ready Source in the catalog while the borrowed registration is refused.
    await controller.createCredentialSource(administrator, {
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
    const createAudit: NonNullable<Parameters<typeof controller.createCredentialSource>[2]> = (
      created,
    ) => {
      auditCallbacks += 1;
      return auditEvent(namespace.id, created.id, "openclaw.credential_sources.create");
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

    // The boundary check must not prevent an ordinary independent registration.
    const second = await controller.createCredentialSource(administrator, input);
    assert.equal(second.state, "ready");
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

  test("a timed-out Gateway registration retains its cleanup record for a possible late create", async () => {
    const { controller, gateway, makeReady, modelSecret, namespace } = await fixture({
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
    const [orphan] = await controller.transact((unit) =>
      unit.credentialSources.listCredentialSources(namespace.id),
    );
    assert.ok(orphan);
    assert.equal(orphan.state, "deleting");
    assert.equal(gateway.stored.has(orphan.id), false);
    gateway.completeLateCreates();
    assert.equal(gateway.stored.has(orphan.id), true);
  });

  test("an uncertain Gateway registration retains its record when cleanup fails", async () => {
    const failRemove = true;
    const { controller, gateway, makeReady, modelSecret, namespace } = await fixture({
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
    const [orphan] = await controller.transact((unit) =>
      unit.credentialSources.listCredentialSources(namespace.id),
    );
    assert.ok(orphan);
    assert.equal(orphan.state, "deleting");
    assert.equal(gateway.stored.has(orphan.id), true);
  });

  test("Gateway registration commits its audit event with the ready state", async () => {
    const { controller, makeReady, modelSecret, namespace } = await fixture();
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
  });

  test("a retained Gateway Source, including a deleting one, keeps its Namespace nonempty", async () => {
    const { controller, makeReady, namespace } = await fixture();
    await makeReady();
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
    // A prior API process could have committed deletion before the canonical Source API replaced it.
    await controller.transact((unit) =>
      unit.credentialSources.markCredentialSourceDeleting(namespace.id, source.id),
    );
    await assert.rejects(
      controller.deleteNamespace(administrator, namespace.id),
      NamespaceNotEmptyError,
    );
  });
}
