import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import { Check } from "typebox/value";
import {
  AgentResponse,
  CredentialSourceResponse,
  CredentialWithdrawalResponse,
  IAMAccessBindingSchema,
} from "../../packages/contracts/src/api/resources.ts";
import { assertExecutionReleaseAllowed } from "../../packages/contracts/src/index.ts";
import { OpenClawController } from "../../packages/occ/src/index.ts";
import type { createFixtureResponse } from "./console-fixture-response.ts";
import { hasResourceId, hasStringField } from "./egress-observation-values.ts";
import { staticEgressFixture } from "./static-egress.mjs";
import { openStockOnlineHttpWire, type HttpEvaluation } from "./stock-online-http-wire.ts";

interface GrantHttpApp {
  request(
    method: "POST" | "PATCH" | "DELETE",
    path: string,
    options?: { body: unknown },
  ): Promise<{ status: number; body: unknown }>;
  fixtureResponse: ReturnType<typeof createFixtureResponse>;
}

interface GrantAdmission {
  app: GrantHttpApp;
  agent: unknown;
  namespace: { id: string };
  path: string;
}

interface UndeployedResources {
  controller: unknown;
  namespace: { id: string };
  agent: unknown;
  source: unknown;
  grant: unknown;
  deployAgent(namespaceId: string, agentId: string): Promise<unknown>;
  activateRevision(namespaceId: string, agentId: string, revisionId: string): Promise<unknown>;
}

export async function undeployedStockGrantFixture(
  t: TestContext,
  admitSource?: (input: GrantAdmission) => Promise<{ agent: unknown; source: unknown }>,
) {
  // The shared JS fixture also supports PostgreSQL and returns additional untyped resources.
  // The Console path uses the actual route schemas, and callers validate the resources they read.
  const options = { admitRevision: false as const, ...(admitSource && { admitSource }) };
  const fixture: UndeployedResources & (GrantHttpApp | { fixtureResponse?: never }) =
    await staticEgressFixture(t, options);
  assert.ok(fixture.fixtureResponse !== undefined, "expected the Console application fixture");
  const { controller, namespace, agent, source, grant, request, fixtureResponse } = fixture;
  assert.ok(controller instanceof OpenClawController && hasResourceId(agent));
  const namespaceId = namespace.id;
  const agentId = agent.id;
  return {
    controller,
    namespaceId,
    agentId,
    source,
    grant,
    request,
    fixtureResponse,
    async deploy() {
      const revision = await fixture.deployAgent(namespaceId, agentId);
      assert.ok(hasResourceId(revision), "expected deployed revision metadata");
      return revision.id;
    },
    activate: (revisionId: string) => fixture.activateRevision(namespaceId, agentId, revisionId),
  };
}

/**
 * Policy-only composition, deliberately outside production. OCC admits a real credential-free
 * grant; the test owns its association with a signed sandbox ID. No installation is recorded and
 * no stock supervisor is claimed by this fixture. Stock's normalized target cannot establish the
 * complete request or enforce the response policy of the production protected metadata profile.
 */
export async function credentialFreeOnlineGrantFixture(t: TestContext) {
  const origin = "https://api.fixture.test";
  const { controller, namespaceId, agentId, source, grant, request, fixtureResponse, deploy } =
    await undeployedStockGrantFixture(t, async ({ app, agent, namespace, path }) => {
      assert.ok(hasStringField(agent, "id") && hasStringField(agent, "configurationId"));
      const type = "credential-free-repository-metadata";
      const config = {
        origin,
        repository_id: "7311",
        repository: "fixture/credential-free",
        agent_id: agent.id,
        authority: "execution",
      };
      const created = await app.request("POST", path, {
        body: { name: "metadata-only", type, config },
      });
      const { data: source } = app.fixtureResponse(
        created,
        201,
        CredentialSourceResponse,
        "admit credential-free source",
      );
      assert.equal(source.egress?.adoption, "credential_free");
      assert.deepEqual(source.secrets, {});
      const bound = await app.request("PATCH", `/namespaces/${namespace.id}/agents/${agent.id}`, {
        body: {
          configurationId: agent.configurationId,
          harnessAuth: { method: "runtime" },
          credentialSources: [{ sourceId: source.id }],
        },
      });
      return { agent: app.fixtureResponse(bound, 200, AgentResponse, "bind source").data, source };
    });
  assert.ok(hasResourceId(source));
  if (!Check(IAMAccessBindingSchema, grant)) {
    assert.fail("expected the admitted IAM access binding");
  }
  const sourceId = source.id;
  const namespacePath = `/namespaces/${namespaceId}`;
  const agentPath = `${namespacePath}/agents/${agentId}`;

  // Activate policy state, never a workload. A positive observation remains insufficient for
  // Compute release; this check would fail if admission were silently downgraded to unprotected.
  async function activate(previousId: string | undefined) {
    const id = await deploy();
    return controller.transact(async ({ agents, revisions }) => {
      const revision = await revisions.findRevision(namespaceId, agentId, id);
      assert.ok(revision, "expected the admitted revision");
      assert.throws(() => assertExecutionReleaseAllowed(revision), /without exact installation/);
      const routes = revision.egressPlan?.routes;
      const route = routes?.[0];
      assert.ok(
        routes?.length === 1 &&
          route?.binding.grant.kind === "credential_free_repository_metadata" &&
          route.binding.source.source.id === sourceId,
        "expected the admitted credential-free source route",
      );
      assert.ok(await agents.compareAndSetActiveRevision(namespaceId, agentId, previousId, id));
      return route;
    });
  }
  const route = await activate(undefined);
  const bindingId = route.binding.binding.id;
  const sandboxId = "synthetic";
  const registration = "online-authorization";
  const wire = await openStockOnlineHttpWire(t, registration, {
    budgetMs: 5000,
    async authorize(request, signal) {
      if (request.sandboxId !== sandboxId || request.bindingId !== bindingId || signal.aborted) {
        return "deny";
      }
      const { method, reportedScheme, host, port, path, query } = request.target;
      if (port !== 443 || method !== "GET" || query !== "" || request.body.byteLength !== 0) {
        return "deny";
      }
      const result = await controller.observeCredentialFreeMetadataGrant(route.binding, {
        method,
        origin: reportedScheme + "://" + host,
        path,
      });
      return result === "current" && !signal.aborted ? "allow" : "deny";
    },
  });
  const bearer = wire.bearer("supervisor", sandboxId);
  const target = {
    scheme: "https",
    host: new URL(origin).host,
    port: 443,
    method: "GET",
    path: route.path,
  };
  return {
    evaluate(change: Partial<HttpEvaluation["target"]> = {}, body: Uint8Array = new Uint8Array()) {
      return wire.evaluate(
        {
          phase: 1,
          middleware_name: registration,
          context: { sandbox_id: sandboxId, request_id: randomUUID(), workspace: "synthetic" },
          config: { fields: { binding_id: { stringValue: bindingId } } },
          target: { ...target, ...change },
          body,
        },
        bearer,
      );
    },
    async withdraw() {
      const withdrawn = await request(
        "POST",
        `${agentPath}/credential-sources/${sourceId}/withdraw`,
      );
      assert.equal(
        fixtureResponse(withdrawn, 202, CredentialWithdrawalResponse, "withdraw source").data.state,
        "pending",
      );
    },
    async replaceRevision() {
      const next = await activate(route.binding.execution.revisionId);
      assert.notDeepEqual(next.binding.execution, route.binding.execution);
    },
    async revokeAccess() {
      const revoked = await request("DELETE", `${namespacePath}/iam/access-bindings/${grant.id}`);
      assert.equal(revoked.status, 204);
    },
  };
}
