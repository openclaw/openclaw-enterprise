import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { assertExecutionReleaseAllowed } from "../../packages/contracts/src/index.ts";
import { staticEgressFixture } from "./static-egress.mjs";
import { invoke, openShellOnlineWire, token } from "./openshell-online-wire.mjs";

/**
 * Policy-only composition, deliberately outside production. OCC admits a real credential-free
 * grant; the test owns its association with a signed sandbox ID. No installation is recorded and
 * no stock supervisor is claimed by this fixture. Stock's normalized target cannot establish the
 * complete request or enforce the response policy of the production protected metadata profile.
 */
export async function credentialFreeOnlineGrantFixture(t, { appFactory } = {}) {
  const origin = "https://api.fixture.test";
  const { controller, namespace, agent, source, grant, deployAgent, request } =
    await staticEgressFixture(t, {
      appFactory,
      admitRevision: false, // Stop before the strict protocol's installation or exchange fixture.
      async admitSource({ app, agent, namespace, path }) {
        const type = "credential-free-repository-metadata";
        const config = {
          origin,
          repository_id: "7311",
          repository: "fixture/credential-free",
          agent_id: agent.id,
          authority: "execution",
        };
        const { status, data: source } = await app.request("POST", path, {
          body: { name: "metadata-only", type, config },
        });
        assert.equal(status, 201);
        assert.equal(source.egress.adoption, "credential_free");
        assert.deepEqual(source.secrets, {});
        const bound = await app.request(
          "PATCH",
          "/namespaces/" + namespace.id + "/agents/" + agent.id,
          {
            body: {
              configurationId: agent.configurationId,
              harnessAuth: { method: "runtime" },
              credentialSources: [{ sourceId: source.id }],
            },
          },
        );
        assert.equal(bound.status, 200);
        return { agent: bound.data, source };
      },
    });

  // Activate policy state, never a workload. A positive observation remains insufficient for
  // Compute release; this check would fail if admission were silently downgraded to unprotected.
  async function activate(previousId) {
    const { id } = await deployAgent(namespace.id, agent.id);
    return controller.transact(async ({ agents, revisions }) => {
      const revision = await revisions.findRevision(namespace.id, agent.id, id);
      assert.throws(() => assertExecutionReleaseAllowed(revision), /without exact installation/);
      assert.ok(await agents.compareAndSetActiveRevision(namespace.id, agent.id, previousId, id));
      return revision.egressPlan.routes[0];
    });
  }
  const route = await activate(undefined);
  const bindingId = route.binding.binding.id;
  const sandboxId = "synthetic";
  const registration = "online-authorization";
  const wire = await openShellOnlineWire(t, registration, {
    budgetMs: 5000,
    async authorize(request, signal) {
      if (request.sandboxId !== sandboxId || request.bindingId !== bindingId || signal.aborted) {
        return "deny";
      }
      const { method, reportedScheme, host, path } = request.target;
      const result = await controller.observeCredentialFreeMetadataGrant(route.binding, {
        method,
        origin: reportedScheme + "://" + host,
        path,
      });
      return result === "current" && !signal.aborted ? "allow" : "deny";
    },
  });
  const signed = (id) => token(wire.keys, "supervisor", id);
  const bearer = signed(sandboxId);
  const target = {
    scheme: "https",
    host: new URL(origin).host,
    port: 443,
    method: "GET",
    path: route.path,
  };
  return {
    wire,
    bearer,
    bindingId,
    registration,
    wrongBearer: signed("different-sandbox"),
    evaluate(change = {}) {
      return invoke(
        wire.client,
        "EvaluateHttpRequest",
        {
          phase: 1,
          middleware_name: registration,
          context: { sandbox_id: sandboxId, request_id: randomUUID() },
          config: { fields: { binding_id: { stringValue: bindingId } } },
          target: { ...target, ...change },
        },
        bearer,
      );
    },
    async withdraw() {
      const withdrawn = await request(
        "POST",
        "/namespaces/" +
          namespace.id +
          "/agents/" +
          agent.id +
          "/credential-sources/" +
          source.id +
          "/withdraw",
      );
      assert.equal(withdrawn.status, 202, JSON.stringify(withdrawn.body));
      assert.equal(withdrawn.data.state, "pending");
    },
    async replaceRevision() {
      const next = await activate(route.binding.execution.revisionId);
      assert.notDeepEqual(next.binding.execution, route.binding.execution);
    },
    async revokeAccess() {
      const revoked = await request(
        "DELETE",
        "/namespaces/" + namespace.id + "/iam/access-bindings/" + grant.id,
      );
      assert.equal(revoked.status, 204);
    },
  };
}
