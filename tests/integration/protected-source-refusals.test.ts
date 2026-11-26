import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Check } from "typebox/value";

import { sandboxNamespaceLifecycleBinding } from "../../apps/controller/src/composition/namespace-lifecycle.ts";
import { OpenShellSandboxDriver } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { ErrorResponse } from "../../packages/contracts/src/api/common.ts";
import { OpenClawController, type PlatformStateStore } from "../../packages/occ/src/index.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import {
  CREDENTIAL_PROXY_SOURCES_WITHOUT_PROXY,
  WITHDRAWAL_SOURCE_NOT_USED,
} from "../helpers/refusal-credential-admission.ts";
import { refusedAnswer } from "../helpers/refusal-answers.ts";
import { protectedMetadataFixture } from "../helpers/static-egress.mjs";

test("deploy identifies a missing Proxy required by the saved Source", async (t) => {
  let state: PlatformStateStore | undefined;
  const f = await protectedMetadataFixture(t, {
    admitRevision: false,
    async appFactory(context, options) {
      return createConsoleAppFixture(context, {
        ...options,
        wrapState(store: PlatformStateStore) {
          state = store;
          return store;
        },
      });
    },
  });
  assert.ok(state && f.controller);

  // Reopen the same state without the selected Proxy. The Agent's saved Source still needs it.
  const sandbox = f.controller.selectedDriver("sandbox");
  const controller = new OpenClawController(f.controller.installation, {
    state,
    namespaceLifecycleBindings: [
      sandboxNamespaceLifecycleBinding(f.controller.selectedDriver("compute"), sandbox),
    ],
    driverConfigurations: [
      {
        capability: "sandbox",
        driverId: sandbox.id,
        implementation: sandbox.implementation,
        definition: OpenShellSandboxDriver,
      },
    ],
  });
  for (const capability of ["iam", "configuration", "compute", "secret", "sandbox"] as const) {
    const driver = f.controller.selectedDriver(capability);
    controller.registerDriver(driver);
    controller.selectDriver(capability, driver.id);
  }
  assert.deepEqual(
    await refusedAnswer(() =>
      controller.deployAgent(
        f.principal.id,
        { namespaceId: f.namespace.id, agentId: f.agent.id },
        resolveApprovedHarness,
      ),
    ),
    { status: 409, code: "RESOURCE_CONFLICT", message: CREDENTIAL_PROXY_SOURCES_WITHOUT_PROXY },
  );
});

test("withdrawal of a source the active version does not use is a conflict, for any source ID", async (t) => {
  const f = await protectedMetadataFixture(t);
  const source = await f.controller.createCredentialSource(f.principal.id, {
    namespaceId: f.namespace.id,
    name: "Unused metadata",
    type: "credential-free-repository-metadata",
    config: {
      ...f.source.config,
      repository: "fixture/unused",
      repository_id: "7312",
    },
  });
  // An existing Source outside the active revision and a missing ID get the same answer.
  for (const sourceId of [source.id, `cs_${randomUUID()}`]) {
    const response = await f.request(
      "POST",
      `/namespaces/${f.namespace.id}/agents/${f.agent.id}/credential-sources/${sourceId}/withdraw`,
    );
    assert.equal(response.status, 409);
    assert.ok(Check(ErrorResponse, response.body));
    assert.equal(response.body.error.code, "RESOURCE_CONFLICT");
    assert.equal(response.body.error.message, WITHDRAWAL_SOURCE_NOT_USED);
  }
});
