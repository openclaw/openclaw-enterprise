import assert from "node:assert/strict";
import test from "node:test";
import {
  requireConfiguration,
  ConfigurationValidationError as SharedConfigurationValidationError,
  type IdentityLookup,
} from "../../packages/contracts/src/index.ts";
import { NativeIAMDriver, type NativeIAMState } from "../../packages/iam/src/index.ts";

export function registerIdentityCases(
  state: NativeIAMState,
  createDriver: () => NativeIAMDriver,
): void {
  test("service identity lookup uses exact IAM scope and cannot resolve a human identity", async () => {
    const driver = createDriver();
    assert.equal(
      (
        await driver.lookupIdentity({
          servicePrincipalId: "service-principal-reader-a",
          namespaceId: "namespace-a",
        })
      )?.id,
      "service-principal-reader-a",
    );
    // Pass each raw lookup to the Driver, including a mixed human and service lookup.
    for (const lookup of [
      { servicePrincipalId: "principal-reader-a", namespaceId: "namespace-a" },
      { servicePrincipalId: "missing", namespaceId: "namespace-a" },
      { servicePrincipalId: "service-principal-reader-a" },
      { servicePrincipalId: "service-principal-reader-a", namespaceId: "namespace-b" },
      {
        servicePrincipalId: "service-principal-reader-a",
        namespaceId: "namespace-a",
        issuer: "forged",
        subject: "forged",
      },
    ]) {
      assert.equal(await driver.lookupIdentity(lookup as IdentityLookup), undefined);
    }
  });

  test("the native IAM implementation exposes a closed pre-construction configuration schema", () => {
    assert.deepEqual(NativeIAMDriver.configurationSchema, {
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    assert.equal(Object.isFrozen(NativeIAMDriver.configurationSchema), true);
    assert.equal(Object.isFrozen(NativeIAMDriver.configurationSchema.properties), true);
    assert.doesNotThrow(() => requireConfiguration(NativeIAMDriver, {}));

    for (const configuration of [
      undefined,
      null,
      [],
      "native",
      { unsupported: true },
      new Date(),
    ]) {
      assert.throws(
        () => requireConfiguration(NativeIAMDriver, configuration),
        SharedConfigurationValidationError,
      );
    }

    const driver = new NativeIAMDriver(
      { loadNativeIAMState: async () => state },
      {
        id: "iam-configured",
        implementation: "native",
      },
    );
    assert.equal(driver.id, "iam-configured");
    assert.equal(driver.implementation, "native");
    assert.equal(driver.namespacePolicyTransaction, "platform-unit-of-work");
  });

  test("the IAM Driver resolves only explicitly provisioned issuer and subject identities", async () => {
    const driver = createDriver();
    assert.equal(driver.capability, "iam");
    assert.equal(typeof driver.id, "string");
    assert.equal(typeof driver.implementation, "string");

    const known = await driver.lookupIdentity({
      issuer: "https://identity.example.com",
      subject: "reader-a",
    });
    assert.equal(known?.id, "principal-reader-a");
    assert.equal(Object.isFrozen(known), true);

    for (const lookup of [
      {
        issuer: "https://identity.example.com",
        subject: "unknown",
      },
      {
        issuer: "https://untrusted.example.com",
        subject: "reader-a",
      },
      {
        installationId: "installation-legacy",
        issuer: "https://identity.example.com",
        subject: "reader-a",
      },
    ]) {
      assert.equal(await driver.lookupIdentity(lookup as IdentityLookup), undefined);
    }
  });
}
