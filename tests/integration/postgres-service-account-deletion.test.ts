import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import {
  OpenClawController,
  ServiceAccountDriverNotConfiguredError,
} from "../../packages/occ/src/index.ts";
import { registerAndSelectDrivers } from "../helpers/development.ts";
import { backendId, seedBackendBinding, workspaceId } from "../helpers/postgres-backend-state.ts";
import { createBackendFixture } from "../helpers/postgres-backend-runtime.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";

test(
  "a forced ServiceAccount delete without a Driver returns the issuer receipt and preserves its Source",
  requiresPostgres,
  async (t) => {
    const fixture = await createBackendFixture(t);
    const { actor, state, pool } = fixture;
    const controller = new OpenClawController(fixture.installation, { state });
    registerAndSelectDrivers(controller, [new NativeIAMDriver(state)]);
    const namespace = fixture.track(
      await state.transact((unit) =>
        unit.namespaces.createNamespace({
          id: `ns_${randomUUID()}`,
          name: `account-force-${randomUUID()}`,
          status: "ready",
          createdAt: new Date().toISOString(),
        }),
      ),
    );
    // An issued account can remain after the administrator removes its ChatGPT Backend.
    const { account, source } = await state.transact(async (unit) => {
      const tokenService = await unit.installations.selectTokenServiceInstance({
        id: randomUUID(),
        driverId: "occ",
        storeIdentity: "force-delete-existing-custody",
      });
      const source = await unit.credentialSources.createCredentialSource({
        id: `cs_${randomUUID()}`,
        namespaceId: namespace.id,
        name: "Retained issued PAT",
        type: "static",
        config: { provider_preset: "codex-pat" },
        ownerCapability: "token_service",
        tokenServiceInstanceId: tokenService.id,
        state: "ready",
        createdAt: new Date().toISOString(),
      });
      const account = await unit.serviceAccounts.createServiceAccount({
        id: `sa_${randomUUID()}`,
        namespaceId: namespace.id,
        name: "Issued account with retired Backend",
        credential: { kind: "access_token", sourceId: source.id },
      });
      return { account, source };
    });
    await seedBackendBinding(pool, account);
    const receipt = await state.transact((unit) =>
      unit.serviceAccounts.findIssuedCredentialBinding(namespace.id, account.id),
    );
    assert.ok(receipt);
    assert.equal(receipt.backendId, backendId);
    assert.equal(receipt.workspaceId, workspaceId);
    await assert.rejects(
      controller.deleteServiceAccount(actor.id, namespace.id, account.id),
      ServiceAccountDriverNotConfiguredError,
    );

    const result = await controller.deleteServiceAccount(actor.id, namespace.id, account.id, {
      force: true,
    });
    assert.deepEqual(result.unrevokedCredential, receipt);
    assert.equal(
      await state.read((unit) => unit.serviceAccounts.findServiceAccount(namespace.id, account.id)),
      undefined,
    );
    assert.equal(
      await state.transact((unit) =>
        unit.serviceAccounts.findIssuedCredentialBinding(namespace.id, account.id),
      ),
      undefined,
    );
    // Force acts on the issuer account, so TokenService custody follows its separate lifecycle.
    assert.deepEqual(
      await state.read((unit) =>
        unit.credentialSources.findCredentialSource(namespace.id, source.id),
      ),
      source,
    );
  },
);
