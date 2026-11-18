import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { ConfigurationValidationError } from "../../packages/contracts/src/index.ts";
import {
  AuthorizationDeniedError,
  DependencyUnavailableError,
  ScopeViolationError,
  InMemoryPlatformState,
  OpenClawController,
} from "../../packages/occ/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import {
  createDevelopmentComputeDriver,
  registerAndSelectDrivers,
} from "../helpers/development.ts";
import { grantRole, principalIAMState } from "../helpers/iam-grants.ts";
import { loadInstallationFile } from "../helpers/installation-file.ts";
import {
  awsFixtureFromInstallation,
  backend,
  options,
  stored,
} from "./aws-secrets-manager-fixture.ts";

test("Installation selects AWS and OCC authorizes the Secret lifecycle against a simulated service", async (t) => {
  const b = await awsFixtureFromInstallation(t);
  const { config, driver } = b;
  const iamState = principalIAMState(["owner", "denied"], "aws-secrets");
  grantRole(iamState, "owner", {
    namespaceId: undefined,
    resource: undefined,
    id: "owner-role",
    bindingId: "owner-binding",
    permissions: {
      namespace: ["create", "read"],
      secret: ["create", "read", "update", "delete", "operate"],
    },
  });
  const iam = new NativeIAMDriver({ loadNativeIAMState: async () => iamState });
  const controller = new OpenClawController(
    { id: "installation-test", name: "AWS test", createdAt: new Date().toISOString() },
    { state: new InMemoryPlatformState() },
  );
  registerAndSelectDrivers(controller, [iam, createDevelopmentComputeDriver(), driver]);
  const namespace = await controller.createNamespace("owner", { name: "AWS tenant" });
  await controller.transact((tx) =>
    tx.namespaces.transitionNamespaceStatus(namespace.id, "provisioning", "ready"),
  );
  const metadata = await controller.createSecret("owner", {
    namespaceId: namespace.id,
    name: "key",
    value: "synthetic-first",
  });
  assert.ok(!JSON.stringify(metadata).includes("synthetic-first"));
  const secret = await controller.transact((tx) =>
    tx.secrets.findSecret(namespace.id, metadata.id),
  );
  assert.ok(secret);
  assert.ok(secret.backendRef.name.split(".").every((label) => label.length <= 63));
  assert.equal((await controller.readSecret("owner", namespace.id, metadata.id)).id, metadata.id);
  assert.deepEqual(await controller.listSecrets("owner", namespace.id), [metadata]);
  assert.equal(await driver.withValue(secret, async (v) => v), "synthetic-first");
  const before = b.calls.length;
  await assert.rejects(
    controller.updateSecret("denied", {
      namespaceId: namespace.id,
      secretId: secret.id,
      value: "forbidden",
    }),
    AuthorizationDeniedError,
  );
  assert.equal(b.calls.length, before);
  await controller.updateSecret("owner", {
    namespaceId: namespace.id,
    secretId: secret.id,
    value: "synthetic-second",
  });
  assert.equal(await driver.withValue(secret, async (v) => v), "synthetic-second");
  await controller.deleteSecret("owner", namespace.id, secret.id);
  assert.deepEqual(await controller.listSecrets("owner", namespace.id), []);
  await assert.rejects(
    controller.readSecret("owner", namespace.id, secret.id),
    ScopeViolationError,
  );
  assert.ok(Array.from(b.records.values())[0]?.DeletedDate);
  await assert.rejects(driver.resolve(secret), DependencyUnavailableError);
  await driver.delete(secret);
  assert.equal(b.calls.filter((c) => c === "DeleteSecretCommand").length, 1);
  // OCC propagates an unknown create outcome without replay. A separate client
  // request allocates a new identity; it is not a retry of the prior resource.
  const attempts: string[] = [];
  b.setFault((kind, input) => {
    if (kind === "CreateSecretCommand") {
      attempts.push(input.Name!);
      throw new Error("unknown create outcome");
    }
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(
      controller.createSecret("owner", {
        namespaceId: namespace.id,
        name: "unknown",
        value: "synthetic-value",
      }),
      DependencyUnavailableError,
    );
    assert.equal(attempts.length, attempt + 1);
  }
  assert.notEqual(attempts[0], attempts[1]);
  assert.deepEqual(await controller.listSecrets("owner", namespace.id), []);
  for (const configuration of [
    { ...options, accountId: "bad" },
    { ...options, prefix: "../bad" },
    { ...options, credentials: "forbidden" },
  ]) {
    await assert.rejects(
      loadInstallationFile(t, {
        ...config,
        drivers: { ...config.drivers, secret: { id: driver.id, configuration } },
      }),
      Object.hasOwn(configuration, "credentials")
        ? { message: /must not contain a plaintext credential/ }
        : ConfigurationValidationError,
    );
  }
});

test("complete ARN and ownership binding rejects namespace, driver, key, account and replacement changes", async () => {
  const b = backend();
  const secret = await stored(b);
  for (const changed of [
    { ...secret, namespaceId: "ns_other" },
    { ...secret, id: "sec_other" },
    { ...secret, driverId: "other" },
    ...[
      { key: "other" },
      { namespaceName: "other" },
      { uid: secret.backendRef.name },
      { name: secret.backendRef.name.replace(/.$/, "z") },
    ].map((change) => ({ ...secret, backendRef: { ...secret.backendRef, ...change } })),
  ]) {
    const before = b.calls.length;
    await assert.rejects(b.driver.update(changed, "synthetic-new"), ScopeViolationError);
    await assert.rejects(b.driver.delete(changed), ScopeViolationError);
    assert.equal(b.calls.length, before);
  }
  const record = Array.from(b.records.values())[0]!;
  record.Tags[1]!.Value = "ns_foreign";
  await assert.rejects(b.driver.resolve(secret), ScopeViolationError);
  await assert.rejects(b.driver.delete(secret), ScopeViolationError);
  record.Tags[1]!.Value = secret.namespaceId;
  record.ARN = record.ARN.replace("Ab123x", "Cd456y");
  await assert.rejects(
    b.driver.withValue(secret, async () => assert.fail("foreign value")),
    ScopeViolationError,
  );
  b.records.clear();
  for (const operation of [
    () => b.driver.update(secret, "synthetic-new"),
    () => b.driver.delete(secret),
    () => b.driver.resolve(secret),
  ]) {
    await assert.rejects(operation, (error: Error) => {
      assert.ok(error instanceof DependencyUnavailableError);
      assert.doesNotMatch(error.message, /sensitive diagnostic/);
      return true;
    });
  }
  assert.equal(b.calls.filter((c) => c === "CreateSecretCommand").length, 1);
  assert.equal(b.calls.includes("DeleteSecretCommand"), false);
});

test("versioned credential reads follow external rotation and refuse stale or racing responses", async () => {
  const b = backend();
  const secret = await stored(b);
  const read = () =>
    b.driver.readCredentialInput({
      secret,
      retention: "none",
      lifetime: {
        signal: new AbortController().signal,
        deadlineAt: new Date(Date.now() + 10_000).toISOString(),
      },
    });
  const first = await read();
  const record = Array.from(b.records.values())[0]!;
  const next = randomUUID();
  record.VersionIdsToStages = { [first.version]: ["AWSPREVIOUS"], [next]: ["AWSCURRENT"] };
  b.values.set(next, "synthetic-rotated");
  const rotated = await read();
  assert.equal(rotated.value, "synthetic-rotated");
  assert.equal(rotated.version, next);
  b.setFault((name) =>
    name === "GetSecretValueCommand"
      ? {
          ARN: record.ARN,
          Name: record.Name,
          SecretString: first.value,
          VersionId: first.version,
          VersionStages: ["AWSCURRENT"],
        }
      : undefined,
  );
  await assert.rejects(read, DependencyUnavailableError);
  b.setFault((name) => {
    if (name === "GetSecretValueCommand") {
      record.VersionIdsToStages = { [randomUUID()]: ["AWSCURRENT"] };
    }
  });
  await assert.rejects(read, DependencyUnavailableError);
  b.setFault(undefined);
  record.VersionIdsToStages = {};
  await assert.rejects(b.driver.resolve(secret), DependencyUnavailableError);
  const before = b.calls.length;
  await assert.rejects(
    b.driver.readCredentialInput({
      secret,
      retention: "none",
      lifetime: {
        signal: AbortSignal.abort(),
        deadlineAt: new Date(Date.now() + 10_000).toISOString(),
      },
    }),
    { name: "AbortError" },
  );
  assert.equal(b.calls.length, before);
});
