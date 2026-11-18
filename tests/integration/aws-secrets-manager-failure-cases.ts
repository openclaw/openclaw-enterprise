import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { setTimeout as delay } from "node:timers/promises";
import { DependencyUnavailableError, ScopeViolationError } from "../../packages/occ/src/index.ts";
import { AwsSecretsManagerSecretDriver } from "../../apps/controller/src/drivers/secret/aws-secrets-manager/index.ts";
import { withMutationDeadline } from "../../apps/controller/src/admission/mutation-deadline.ts";
import { withComputeOperationDeadline } from "../../apps/controller/src/drivers/compute/operation-context.ts";
import { backend, options, stored } from "./aws-secrets-manager-fixture.ts";

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

test("an expired API write budget prevents a create after a slow STS response", async (t) => {
  const b = backend();
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const deadline = Date.now() + 12_000;
  let identityCalls = 0;
  const driver = new AwsSecretsManagerSecretDriver(options, {
    ...b.injection,
    identityClient: {
      send: async () => {
        identityCalls++;
        t.mock.timers.setTime(deadline + 1);
        return { Account: options.accountId };
      },
    },
  });
  const identity = { id: `sec_${randomUUID()}`, namespaceId: `ns_${randomUUID()}`, name: "key" };
  await assert.rejects(
    withMutationDeadline(deadline, () => driver.create(identity, "synthetic-value")),
    { name: "DependencyUnavailableError", message: /no mutation was submitted/ },
  );
  assert.equal(identityCalls, 1);
  assert.deepEqual(b.calls, []);
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
