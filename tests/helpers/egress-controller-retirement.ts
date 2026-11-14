import assert from "node:assert/strict";
import { Check } from "typebox/value";
import { CredentialSourceId, type SecretReference } from "../../packages/contracts/src/index.ts";
import { assertConnectedResponse, protectedSourceBody } from "./egress-connected-inputs.mjs";
import { retainedState } from "./egress-controller-retained-state.ts";
import { record } from "./egress-observation-values.ts";
import type {
  ProviderCounters,
  RetirementEvidence,
  UpgradeDeployment,
  UpgradeSetup,
  UpgradeStack,
} from "./egress-upgrade-contracts.ts";

const retirement = {
  code: "RESOURCE_CONFLICT",
  message:
    "The selected Driver has retired new uses of this protected static credential provider. Ask an Installation administrator to configure a supported model access path.",
};

export async function verifyRetirementRefusals(
  setup: UpgradeSetup,
  stack: UpgradeStack,
  evidence: RetirementEvidence,
  provider: ProviderCounters,
  deployment: UpgradeDeployment,
  retained: {
    unbound: { id: string };
    replacement: { ref: SecretReference };
    state: Awaited<ReturnType<typeof retainedState>>;
    providerBaseline: { httpRequests: number; tcpConnections: number };
  },
) {
  const { namespacePath } = stack;
  const { api, checkpoint } = evidence;
  const { httpRequests: beforeIngress, tcpConnections: beforeConnections } =
    retained.providerBaseline;
  const name = `egress-refused-${evidence.runId}`;
  const requests = [
    {
      phase: "fresh-source" as const,
      method: "POST",
      path: `${namespacePath}/credential-sources`,
      body: protectedSourceBody(name, deployment.secret.ref, setup.controller.providerOrigin),
    },
    {
      phase: "unbound-adoption" as const,
      method: "PATCH",
      path: `${namespacePath}/credential-sources/${retained.unbound.id}`,
      body: { adoption: "live", authorityScope: "execution" },
    },
    {
      phase: "unbound-secret-reference" as const,
      method: "PATCH",
      path: `${namespacePath}/credential-sources/${retained.unbound.id}`,
      body: { secrets: { api_key: retained.replacement.ref } },
    },
    {
      phase: "new-deployment" as const,
      method: "POST",
      path: `${namespacePath}/agents/${deployment.agent.id}/deploy`,
    },
  ];
  for (const request of requests) {
    await checkpoint("retirement-refusal-start", { operation: request.phase });
    const creation = request.phase === "fresh-source";
    if (creation) {
      evidence.ledger.pendingCreate = { kind: "credential-sources", name };
      await checkpoint("create-refusal-request", { kind: "credential-sources" });
    }
    const deploying = request.phase === "new-deployment";
    if (deploying) {
      evidence.ledger.pendingDeploy = { agentId: deployment.agent.id, path: request.path };
      await checkpoint("deploy-refusal-request", { agentId: deployment.agent.id });
    }
    const response = await evidence.request(request.method, request.path, request.body);
    if (creation) {
      // A regression may unexpectedly admit the source. Only adopt cleanup for
      // a new, read-back identity matching this run; ambiguous creates stay pending.
      if (response.status === 201) {
        const source = record(assertConnectedResponse(response, 201));
        const sourceId = source.id;
        assert.ok(Check(CredentialSourceId, sourceId), "cleanup requires a valid source ID");
        assert.ok(
          !(retained.state.sources ?? []).some(({ id }) => id === sourceId),
          "cleanup must not adopt a source from the pre-upgrade baseline",
        );
        const observed = record(
          await api("GET", `${namespacePath}/credential-sources/${sourceId}`),
        );
        assert.equal(observed.id, sourceId, "cleanup requires the returned source ID");
        assert.equal(observed.namespaceId, stack.namespace.id, "cleanup requires this Namespace");
        assert.equal(observed.name, name, "cleanup requires this run-specific name");
        evidence.ledger.resources.push({ kind: "credential-sources", id: sourceId });
        delete evidence.ledger.pendingCreate;
      }
      await checkpoint("create-refusal-response", { status: response.status });
    }
    if (request.phase === "new-deployment" && response.status === 202) {
      const revision = record(assertConnectedResponse(response, 202));
      await checkpoint("deploy-request", {
        agentId: deployment.agent.id,
        unexpectedRevisionId: revision.id,
      });
    }
    const error: unknown = assertConnectedResponse(response, 409);
    assert.deepEqual(error, retirement);
    assert.deepEqual(
      await retainedState(stack, deployment),
      retained.state,
      "refusal must not mutate retained metadata or enqueue work",
    );
    assert.equal(
      provider.observations.length,
      beforeIngress,
      "retirement must precede provider I/O",
    );
    assert.equal(
      provider.tcpConnections,
      beforeConnections,
      "retirement must precede provider connections",
    );
    // A refusal is accounted for only after its persisted and external effects
    // are checked. Read failures and unexpected work must retain cleanup custody.
    if (creation) {
      delete evidence.ledger.pendingCreate;
    }
    if (deploying) {
      delete evidence.ledger.pendingDeploy;
    }
    await checkpoint("retirement-refused", {
      operation: request.phase,
      status: 409,
      providerSends: 0,
    });
  }
}
