import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { createAuthPrincipalSeed } from "../../packages/iam/src/index.ts";
import { createPostgresAgentApp } from "../helpers/postgres-agent-app.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";

test(
  "an Installation admin controls Gateway managed mode and a deployer applies the saved setting",
  requiresPostgres,
  async (t) => {
    const { controller, inject, state, deployAgent } = await createPostgresAgentApp(t, {
      label: "gateway-managed-mode",
      authSecret: "gateway-managed-mode-postgres-auth-secret-minimum-32",
    });
    const { namespace, secretRef, agent, revision } = await deployAgent("Gateway managed mode");
    assert.equal(agent.gatewayManagedMode, true);

    const member = createAuthPrincipalSeed(
      controller.installation.id,
      "https://identity.example.test",
      { id: randomUUID() },
      { grant: "none" },
    );
    await state.appendNativeIAMPrincipal(member);
    const iamPath = `/namespaces/${namespace.id}/iam`;
    const role = await inject("POST", `${iamPath}/roles`, {
      permissions: [
        { action: "administer", resourceKind: "agent" },
        { action: "update", resourceKind: "agent" },
        { action: "deploy", resourceKind: "agent" },
        { action: "read", resourceKind: "configuration" },
        { action: "operate", resourceKind: "secret" },
      ],
    });
    assert.equal(role.statusCode, 201, role.body);
    for (const [resourceKind, resourceId] of [
      ["agent", agent.id],
      ["configuration", agent.configurationId],
      ["secret", secretRef.id],
    ]) {
      const binding = await inject("POST", `${iamPath}/access-bindings`, {
        subjectKind: "identity",
        subjectId: member.principal.id,
        roleId: role.json().data.id,
        resourceKind,
        resourceId,
      });
      assert.equal(binding.statusCode, 201, binding.body);
    }

    const agentIdentity = { namespaceId: namespace.id, agentId: agent.id };
    await assert.rejects(
      controller.updateAgent(member.principal.id, { ...agentIdentity, gatewayManagedMode: false }),
      {
        name: "AuthorizationDeniedError",
        authorization: {
          action: "administer",
          resource: { kind: "installation", id: controller.installation.id },
        },
      },
    );

    const agentPath = `/namespaces/${namespace.id}/agents/${agent.id}`;
    const saved = await inject("PATCH", agentPath, { gatewayManagedMode: false });
    assert.equal(saved.statusCode, 200, saved.body);
    const ordinarySave = await controller.updateAgent(member.principal.id, {
      ...agentIdentity,
      configurationId: agent.configurationId,
    });
    assert.equal(ordinarySave.gatewayManagedMode, false);
    const admitted = await controller.deployAgent(
      member.principal.id,
      agentIdentity,
      resolveApprovedHarness,
    );
    const versions = await Promise.all(
      [revision, admitted].map(({ id }) => inject("GET", `${agentPath}/revisions/${id}`)),
    );
    assert.deepEqual(
      versions.map((response) => response.json().data.gatewayManagedMode),
      [true, false],
    );
  },
);
