import { ConfigurationValidationError } from "../../packages/contracts/src/index.ts";
import {
  AuthorizationDeniedError,
  DependencyUnavailableError,
  ScopeViolationError,
} from "../../packages/occ/src/index.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { withComputeOperationDeadline } from "../../apps/controller/src/drivers/compute/operation-context.ts";
import type { Secret } from "../../packages/contracts/src/index.ts";
import { AwsSecretsManagerSecretDriver } from "../../apps/controller/src/drivers/secret/aws-secrets-manager/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { InMemoryPlatformState, OpenClawController } from "../../packages/occ/src/index.ts";
import { createInstallationDriverConfiguration } from "../helpers/installation-driver-configuration.mjs";
import { loadInstallationFile } from "../helpers/installation-file.mjs";
import {
  createDevelopmentComputeDriver,
  registerAndSelectDrivers,
} from "../helpers/development.mjs";
import { grantRole, principalIAMState } from "../helpers/iam-grants.mjs";

// Resolve the SDK from its owning workspace package, not an undeclared root dependency.
const require = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
const {
  CreateSecretCommand,
  DescribeSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  DeleteSecretCommand,
} = require("@aws-sdk/client-secrets-manager");
const options = { region: "us-east-1", accountId: "123456789012", prefix: "oce/test" };
type RecordValue = {
  ARN: string;
  Name: string;
  Tags: { Key: string; Value: string }[];
  VersionIdsToStages: Record<string, string[]>;
  DeletedDate?: Date;
};

// Only the AWS service is simulated: commands, Driver, Installation validation,
// OCC lifecycle, ownership checks, and IAM decisions use production code.
function backend() {
  const records = new Map<string, RecordValue>();
  const values = new Map<string, string>();
  const calls: string[] = [];
  let fault: ((name: string, input: Record<string, string>) => unknown) | undefined;
  const send = async (command: {
    constructor: { name: string };
    input: Record<string, string>;
  }) => {
    const kind = command.constructor.name;
    calls.push(kind);
    const overridden = fault?.(kind, command.input);
    if (overridden !== undefined) {
      return overridden;
    }
    const input = command.input;
    if (command instanceof CreateSecretCommand) {
      const ARN = `arn:aws:secretsmanager:us-east-1:123456789012:secret:${input.Name}-Ab123x`;
      if (records.has(ARN)) {
        throw new Error("ResourceExistsException");
      }
      records.set(ARN, {
        ARN,
        Name: input.Name!,
        Tags: command.input.Tags as unknown as RecordValue["Tags"],
        VersionIdsToStages: { [input.ClientRequestToken!]: ["AWSCURRENT"] },
      });
      values.set(input.ClientRequestToken!, input.SecretString!);
      return { ARN, Name: input.Name, VersionId: input.ClientRequestToken };
    }
    const record = records.get(input.SecretId!);
    if (!record) {
      throw new Error("ResourceNotFoundException: synthetic sensitive diagnostic");
    }
    if (command instanceof DescribeSecretCommand) {
      return structuredClone(record);
    }
    if (command instanceof GetSecretValueCommand) {
      assert.equal(input.VersionStage, "AWSCURRENT");
      if (!record.VersionIdsToStages[input.VersionId!]?.includes("AWSCURRENT")) {
        throw new Error("InvalidRequestException");
      }
      return {
        ARN: record.ARN,
        Name: record.Name,
        VersionId: input.VersionId,
        VersionStages: ["AWSCURRENT"],
        SecretString: values.get(input.VersionId!),
      };
    }
    if (command instanceof PutSecretValueCommand) {
      for (const key of Object.keys(record.VersionIdsToStages)) {
        record.VersionIdsToStages[key] = ["AWSPREVIOUS"];
      }
      record.VersionIdsToStages[input.ClientRequestToken!] = ["AWSCURRENT"];
      values.set(input.ClientRequestToken!, input.SecretString!);
      return {
        ARN: record.ARN,
        Name: record.Name,
        VersionId: input.ClientRequestToken,
        VersionStages: ["AWSCURRENT"],
      };
    }
    assert.ok(command instanceof DeleteSecretCommand);
    assert.equal(command.input.RecoveryWindowInDays, 30);
    assert.equal(command.input.ForceDeleteWithoutRecovery, undefined);
    record.DeletedDate = new Date();
    return { ARN: record.ARN, Name: record.Name, DeletionDate: record.DeletedDate };
  };
  const client = { send } as unknown as NonNullable<
    ConstructorParameters<typeof AwsSecretsManagerSecretDriver>[1]
  >["client"];
  const identityClient = { send: async () => ({ Account: options.accountId }) };
  const credentials = { accessKeyId: "synthetic-key", secretAccessKey: "synthetic-signing-key" };
  const injection = { client: client!, identityClient, credentials };
  const driver = new AwsSecretsManagerSecretDriver(options, injection);
  return {
    records,
    values,
    calls,
    client: client!,
    injection,
    driver,
    setFault(value: typeof fault) {
      fault = value;
    },
  };
}

async function stored(b: ReturnType<typeof backend>): Promise<Secret> {
  const identity = {
    id: `sec_${randomUUID()}`,
    namespaceId: `ns_${randomUUID()}`,
    name: "api-key",
  };
  return {
    ...identity,
    driverId: b.driver.id,
    createdAt: new Date().toISOString(),
    backendRef: await b.driver.create(identity, "synthetic-original"),
  };
}

test("production Installation selects the AWS adapter and OCC authorizes its lifecycle", async (t) => {
  const configuration = createInstallationDriverConfiguration();
  const config = {
    ...configuration,
    drivers: {
      ...configuration.drivers,
      secret: { id: "secret-aws-secrets-manager", configuration: options },
    },
  };
  const runtime = await loadInstallationFile(t, config);
  assert.ok(runtime?.secretDriver instanceof AwsSecretsManagerSecretDriver);
  assert.equal(runtime.installation.drivers.secret.definition, AwsSecretsManagerSecretDriver);
  const b = backend();
  const selection = runtime.installation.drivers.secret;
  const driver = new AwsSecretsManagerSecretDriver(
    selection.configuration as unknown as typeof options,
    { id: selection.id, ...b.injection },
  );
  assert.equal("compareAndSwap" in driver, false);
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

test("ambiguous create and update failures are not retried or repaired by name", async () => {
  const b = backend();
  const secret = await stored(b);
  b.setFault((name) => {
    if (name === "PutSecretValueCommand" || name === "CreateSecretCommand") {
      throw new Error("synthetic sensitive diagnostic");
    }
  });
  await assert.rejects(b.driver.update(secret, "synthetic-new"), DependencyUnavailableError);
  await assert.rejects(stored(b), DependencyUnavailableError);
  assert.equal(b.calls.filter((c) => c === "PutSecretValueCommand").length, 1);
  assert.equal(b.calls.filter((c) => c === "CreateSecretCommand").length, 2);
  assert.equal(b.calls.includes("DeleteSecretCommand"), false);
});

test("configuration drift and in-progress rotation fail closed before mutations", async () => {
  const b = backend();
  const secret = await stored(b);
  for (const change of [
    { region: "us-west-2" },
    { accountId: "999999999999" },
    { prefix: "oce/other" },
  ]) {
    const driver = new AwsSecretsManagerSecretDriver(
      { ...options, ...change },
      { client: b.client },
    );
    const before = b.calls.length;
    await assert.rejects(driver.resolve(secret), ScopeViolationError);
    await assert.rejects(driver.delete(secret), ScopeViolationError);
    assert.equal(b.calls.length, before);
  }
  const record = Array.from(b.records.values())[0]!;
  record.VersionIdsToStages[randomUUID()] = ["AWSPENDING"];
  const before = b.calls.length;
  await assert.rejects(b.driver.update(secret, "synthetic-new"), /rotation is pending/);
  assert.deepEqual(b.calls.slice(before), ["DescribeSecretCommand"]);
  assert.equal(await b.driver.withValue(secret, async (v) => v), "synthetic-original");
  const other = await stored(b);
  assert.notEqual(other.namespaceId, secret.namespaceId);
  assert.notEqual(other.backendRef.namespaceName, secret.backendRef.namespaceName);
  await assert.rejects(
    b.driver.resolve({ ...secret, backendRef: other.backendRef }),
    ScopeViolationError,
  );
});

test("post-read rotation and cancellation never release material to the callback", async () => {
  const b = backend();
  const secret = await stored(b);
  const record = Array.from(b.records.values())[0]!;
  b.setFault((name, input) => {
    if (name !== "GetSecretValueCommand") {
      return;
    }
    record.VersionIdsToStages = { [randomUUID()]: ["AWSCURRENT"] };
    return {
      ARN: record.ARN,
      Name: record.Name,
      VersionId: input.VersionId,
      VersionStages: ["AWSCURRENT"],
      SecretString: "synthetic-original",
    };
  });
  await assert.rejects(
    b.driver.withValue(secret, async () => assert.fail("rotated material released")),
    /rotated during/,
  );
  const abort = new AbortController();
  b.setFault((name, input) => {
    if (name !== "GetSecretValueCommand") {
      return;
    }
    abort.abort();
    return {
      ARN: record.ARN,
      Name: record.Name,
      VersionId: input.VersionId,
      VersionStages: ["AWSCURRENT"],
      SecretString: "synthetic-original",
    };
  });
  await assert.rejects(
    b.driver.readCredentialInput({
      secret,
      retention: "none",
      lifetime: { signal: abort.signal, deadlineAt: new Date(Date.now() + 10_000).toISOString() },
    }),
    DependencyUnavailableError,
  );
  b.setFault(undefined);
  const before = b.calls.length;
  await assert.rejects(
    b.driver.readCredentialInput({
      secret,
      retention: "none",
      lifetime: { signal: new AbortController().signal, deadlineAt: new Date(0).toISOString() },
    }),
    { name: "TimeoutError" },
  );
  assert.equal(b.calls.length, before);
});

test("invalid material and mismatched mutation responses cannot become successful storage", async () => {
  const b = backend();
  const secret = await stored(b);
  for (const value of ["", "bad\0value", "\ud800", "x".repeat(65_537)]) {
    const before = b.calls.length;
    await assert.rejects(b.driver.update(secret, value), ScopeViolationError);
    assert.equal(b.calls.length, before);
  }
  const record = Array.from(b.records.values())[0]!;
  for (const response of [
    { ARN: record.ARN, Name: record.Name, VersionId: randomUUID(), VersionStages: ["AWSCURRENT"] },
    {
      ARN: record.ARN.replace("Ab123x", "Cd456y"),
      Name: record.Name,
      VersionStages: ["AWSCURRENT"],
    },
  ]) {
    b.setFault((name) => (name === "PutSecretValueCommand" ? response : undefined));
    await assert.rejects(b.driver.update(secret, "synthetic-new"), DependencyUnavailableError);
  }
  b.setFault((name) =>
    name === "CreateSecretCommand"
      ? { ARN: record.ARN, Name: record.Name, VersionId: randomUUID() }
      : undefined,
  );
  await assert.rejects(stored(b), {
    name: "DependencyUnavailableError",
    message: /mutation may have applied; reconciliation required/,
  });
  assert.equal(b.calls.includes("DeleteSecretCommand"), false);
});

test("account qualification refuses wrong or unavailable STS identity before any create", async () => {
  const b = backend();
  const identity = { id: `sec_${randomUUID()}`, namespaceId: `ns_${randomUUID()}`, name: "key" };
  for (const [index, identityClient] of [
    { send: async () => ({ Account: "999999999999" }) },
    {
      send: async () => {
        throw new Error("STS unavailable");
      },
    },
  ].entries()) {
    const driver = new AwsSecretsManagerSecretDriver(options, { ...b.injection, identityClient });
    await assert.rejects(driver.create(identity, "synthetic-value"), (error) => {
      if (index === 0) {
        assert.ok(error instanceof ScopeViolationError);
      } else {
        assert.ok(error instanceof DependencyUnavailableError);
        assert.match(error.message, /no mutation was submitted/);
      }
      return true;
    });
  }
  assert.equal(b.calls.length, 0);
});

for (const cancellation of ["abort", "deadline"] as const) {
  test(`pending credential acquisition settles on parent ${cancellation} without late AWS calls`, async () => {
    const b = backend();
    const provider = Promise.withResolvers<typeof b.injection.credentials>();
    const entered = Promise.withResolvers<void>();
    const parent = new AbortController();
    let identityCalls = 0;
    const driver = new AwsSecretsManagerSecretDriver(options, {
      ...b.injection,
      credentials: () => {
        entered.resolve();
        return provider.promise;
      },
      identityClient: {
        send: async () => {
          identityCalls++;
          return { Account: options.accountId };
        },
      },
    });
    // Capture the actual create promise, not a wrapper which could hide a hung Driver.
    let creation!: Promise<unknown>;
    const operation = withComputeOperationDeadline(
      {
        signal: parent.signal,
        deadlineAt: new Date(
          Date.now() + (cancellation === "deadline" ? 100 : 10_000),
        ).toISOString(),
      },
      () => {
        creation = driver.create(
          { id: `sec_${randomUUID()}`, namespaceId: `ns_${randomUUID()}`, name: "key" },
          "synthetic-value",
        );
        return creation;
      },
    );
    const result = operation.catch((error: unknown) => error);
    await entered.promise;
    if (cancellation === "abort") {
      parent.abort(new Error("synthetic private abort reason"));
    }
    try {
      const settled = await Promise.race([
        creation.then(
          () => "returned-reference",
          (error: unknown) => error,
        ),
        delay(1000, "still-pending"),
      ]);
      assert.ok(
        settled instanceof DependencyUnavailableError,
        "create must reject promptly without waiting for credentials",
      );
      assert.match(settled.message, /no mutation was submitted/);
      assert.equal(identityCalls, 0);
      assert.deepEqual(b.calls, []);
    } finally {
      provider.resolve(b.injection.credentials);
      await result;
    }
    await delay(10);
    assert.equal(identityCalls, 0, "late credentials must not reach STS");
    assert.deepEqual(b.calls, [], "late credentials must not reach Secrets Manager");
  });
}

test("pre-mutation provider, STS, describe and read failures do not claim mutation uncertainty", async () => {
  const b = backend();
  const identity = { id: `sec_${randomUUID()}`, namespaceId: `ns_${randomUUID()}`, name: "key" };
  const unavailable = {
    name: "DependencyUnavailableError",
    message: "AWS Secret operation failed; no mutation was submitted.",
  };
  for (const overrides of [
    {
      credentials: async () => {
        throw new Error("private provider diagnostic");
      },
    },
    {
      identityClient: {
        send: async () => {
          throw new Error("private STS diagnostic");
        },
      },
    },
  ]) {
    const driver = new AwsSecretsManagerSecretDriver(options, { ...b.injection, ...overrides });
    await assert.rejects(driver.create(identity, "synthetic-value"), unavailable);
    assert.deepEqual(b.calls, []);
  }
  const secret = await stored(b);
  for (const command of ["DescribeSecretCommand", "GetSecretValueCommand"]) {
    b.setFault((name) => {
      if (name === command) {
        throw new Error("private AWS diagnostic");
      }
    });
    const before = b.calls.length;
    await assert.rejects(
      b.driver.withValue(secret, async () => assert.fail("must not release material")),
      unavailable,
    );
    if (command === "DescribeSecretCommand") {
      await assert.rejects(b.driver.resolve(secret), unavailable);
      await assert.rejects(b.driver.update(secret, "synthetic-new"), unavailable);
      await assert.rejects(b.driver.delete(secret), unavailable);
    }
    assert.ok(
      b.calls
        .slice(before)
        .every((name) => name === "DescribeSecretCommand" || name === "GetSecretValueCommand"),
    );
  }
});

test("applied create with failed ownership verification requires reconciliation without adoption or cleanup", async () => {
  for (const failure of ["ownership", "describe", "version"]) {
    const b = backend();
    b.setFault((name) => {
      if (name !== "DescribeSecretCommand") {
        return;
      }
      // CreateSecret has genuinely persisted the fixture record before verification fails.
      const record = Array.from(b.records.values())[0]!;
      assert.ok(record);
      if (failure === "describe") {
        throw new Error("private verification diagnostic");
      }
      if (failure === "ownership") {
        record.Tags = [];
      }
      if (failure === "version") {
        record.VersionIdsToStages = { [randomUUID()]: ["AWSCURRENT"] };
      }
    });
    await assert.rejects(stored(b), {
      name: "DependencyUnavailableError",
      message: /mutation may have applied; reconciliation required/,
    });
    assert.equal(b.records.size, 1, "retain the applied record for reconciliation");
    assert.equal(b.values.size, 1);
    assert.deepEqual(b.calls, ["CreateSecretCommand", "DescribeSecretCommand"]);
  }
});

test("submitted create, update and delete failures require reconciliation", async () => {
  for (const command of [
    "CreateSecretCommand",
    "PutSecretValueCommand",
    "DeleteSecretCommand",
  ] as const) {
    for (const failure of ["throw", "response"]) {
      const b = backend();
      const secret = await stored(b);
      b.calls.length = 0;
      b.setFault((name) => {
        if (name !== command) {
          return;
        }
        if (failure === "throw") {
          throw new Error("private mutation diagnostic");
        }
        return {};
      });
      const operations = {
        CreateSecretCommand: () => stored(b),
        PutSecretValueCommand: () => b.driver.update(secret, "synthetic-new"),
        DeleteSecretCommand: () => b.driver.delete(secret),
      };
      const operation = operations[command]();
      await assert.rejects(operation, {
        name: "DependencyUnavailableError",
        message: /mutation may have applied; reconciliation required/,
      });
      assert.deepEqual(
        b.calls,
        command === "CreateSecretCommand" ? [command] : ["DescribeSecretCommand", command],
      );
    }
  }
});

test("lost create responses keep one resource per OCC identity across driver restarts", async () => {
  const b = backend();
  const identity = { id: `sec_${randomUUID()}`, namespaceId: `ns_${randomUUID()}`, name: "key" };
  let appliedName: string | undefined;
  const tokens: string[] = [];
  b.setFault((kind, input) => {
    if (kind !== "CreateSecretCommand") {
      return;
    }
    appliedName = input.Name!;
    tokens.push(input.ClientRequestToken!);
    const ARN = `arn:aws:secretsmanager:us-east-1:123456789012:secret:${appliedName}-Ab123x`;
    b.records.set(ARN, {
      ARN,
      Name: appliedName,
      Tags: [],
      VersionIdsToStages: { [input.ClientRequestToken!]: ["AWSCURRENT"] },
    });
    b.values.set(input.ClientRequestToken!, input.SecretString!);
    throw new Error("response lost after AWS applied creation");
  });
  await assert.rejects(b.driver.create(identity, "synthetic-first"), DependencyUnavailableError);
  b.setFault((kind, input) => {
    if (kind === "CreateSecretCommand") {
      tokens.push(input.ClientRequestToken!);
    }
  });
  const restarted = new AwsSecretsManagerSecretDriver(options, b.injection);
  await assert.rejects(
    restarted.create(identity, "synthetic-different"),
    DependencyUnavailableError,
  );
  assert.equal(b.records.size, 1);
  assert.deepEqual(tokens, [identity.id.slice(4), identity.id.slice(4)]);
  assert.equal(Array.from(b.records.values())[0]!.Name, appliedName);
  assert.deepEqual(Array.from(b.values.values()), ["synthetic-first"]);
  assert.deepEqual(b.calls, ["CreateSecretCommand", "CreateSecretCommand"]);
});

test("real SDK signs STS and creation with captured credentials at pinned HTTPS endpoints", async (t) => {
  const keys = ["AWS_ENDPOINT_URL", "AWS_ENDPOINT_URL_STS", "AWS_ENDPOINT_URL_SECRETS_MANAGER"];
  const saved = keys.map((key) => process.env[key]);
  for (const key of keys) {
    process.env[key] = "http://untrusted.invalid";
  }
  t.after(() =>
    keys.forEach((key, index) => {
      if (saved[index] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[index];
      }
    }),
  );
  for (const account of [options.accountId, "999999999999"]) {
    let resolutions = 0;
    const requests: { host: string; authorization: string; action: string }[] = [];
    let created:
      { Name: string; ClientRequestToken: string; Tags: RecordValue["Tags"] } | undefined;
    const handler = {
      handle: async (request: {
        protocol: string;
        hostname: string;
        headers: Record<string, string>;
        body: string | Uint8Array;
      }) => {
        assert.equal(request.protocol, "https:");
        const action = request.headers["x-amz-target"] ?? "GetCallerIdentity";
        requests.push({
          host: request.hostname,
          authorization: request.headers.authorization!,
          action,
        });
        let body: string | Uint8Array;
        if (request.hostname === "sts.us-east-1.amazonaws.com") {
          body = `<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><GetCallerIdentityResult><Account>${account}</Account><Arn>arn:aws:iam::${account}:role/workload</Arn><UserId>workload</UserId></GetCallerIdentityResult><ResponseMetadata><RequestId>test</RequestId></ResponseMetadata></GetCallerIdentityResponse>`;
        } else {
          assert.equal(request.hostname, "secretsmanager.us-east-1.amazonaws.com");
          if (action.endsWith("CreateSecret")) {
            created = JSON.parse(
              typeof request.body === "string"
                ? request.body
                : new TextDecoder().decode(request.body),
            ) as typeof created;
          }
          assert.ok(created);
          const ARN = `arn:aws:secretsmanager:us-east-1:123456789012:secret:${created.Name}-Ab123x`;
          body = JSON.stringify({
            ARN,
            Name: created.Name,
            VersionId: created.ClientRequestToken,
            Tags: created.Tags,
            VersionIdsToStages: { [created.ClientRequestToken]: ["AWSCURRENT"] },
          });
        }
        return { response: { statusCode: 200, headers: {}, body: new TextEncoder().encode(body) } };
      },
    };
    const driver = new AwsSecretsManagerSecretDriver(options, {
      credentials: async () => ({
        accessKeyId: `synthetic-key-${++resolutions}`,
        secretAccessKey: "synthetic-signing-key",
        expiration: new Date(Date.now() + 60_000),
      }),
      requestHandler: handler,
    });
    const identity = { id: `sec_${randomUUID()}`, namespaceId: `ns_${randomUUID()}`, name: "key" };
    if (account !== options.accountId) {
      await assert.rejects(driver.create(identity, "synthetic-value"), ScopeViolationError);
      assert.equal(requests.length, 1);
    } else {
      await driver.create(identity, "synthetic-value");
      assert.equal(requests[0]!.host, "sts.us-east-1.amazonaws.com");
      assert.ok(requests[1]!.action.endsWith("CreateSecret"));
      const signingKey = (authorization: string) => /Credential=([^/]+)/.exec(authorization)?.[1];
      assert.ok(signingKey(requests[0]!.authorization));
      assert.equal(signingKey(requests[0]!.authorization), signingKey(requests[1]!.authorization));
    }
  }
});
