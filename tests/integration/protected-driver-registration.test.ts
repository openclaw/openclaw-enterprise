import assert from "node:assert/strict";
import test from "node:test";
import type { CredentialProxyDriver } from "../../packages/contracts/src/index.ts";
import { InstalledDriver, OpenClawController } from "../../packages/occ/src/index.ts";

test("incomplete credential delivery Driver registration is refused before selection", () => {
  // An installed package can return a malformed capability despite the static contract.
  const incomplete = {
    id: "delivery",
    implementation: "openshell",
    capability: "credential_proxy",
    async deployProxy() {
      return {};
    },
    async configureDeployment() {
      return { credentialProjections: [] };
    },
    async removeDeployment() {},
  } as unknown as CredentialProxyDriver;
  assert.throws(
    () =>
      new InstalledDriver(
        { id: incomplete.id, implementation: incomplete.implementation, configuration: {} },
        { capabilities: { credential_proxy: incomplete } },
      ),
    /exact selected capability contracts/,
  );
  const controller = new OpenClawController({
    id: "installation",
    name: "installation",
    createdAt: "2026-10-01T00:00:00Z",
  });
  assert.throws(() => controller.registerDriver(incomplete), /exact capability contract/);
  assert.throws(
    () => controller.selectDriver("credential_proxy", incomplete.id),
    /No registered Driver matches/,
  );
});
