import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { KubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { staticEgressFixture } from "../helpers/static-egress.mjs";
import { computeFixturePorts, present } from "./repository-runtime-material-fixture.ts";
import { publicReaderAdmission } from "./repository-runtime-material-public-reader-fixture.ts";

import type {
  Agent,
  AgentRevision,
  EgressInstallation,
  Namespace,
  SandboxDriver,
} from "../../packages/contracts/src/index.ts";
import type { InstalledDriver } from "../../packages/occ/src/index.ts";

type AdmissionCallback = (input: {
  app: {
    request(
      method: "POST",
      path: string,
      options: { body: object },
    ): Promise<{ status: number; data: unknown }>;
    updateAgent(
      namespaceId: string,
      agentId: string,
      input: {
        configurationId: string;
        harnessAuth: { method: "runtime" };
        credentialSources: { sourceId: string }[];
      },
    ): Promise<Agent>;
  };
  agent: Agent;
  namespace: Namespace;
  path: string;
  origin: string;
}) => Promise<{ agent: Agent; source: { id: string } }>;

type ProtectedFixture = {
  fixtureKind: "deployed";
  revision: AgentRevision;
  installedDriver: InstalledDriver;
  installation: EgressInstallation;
  sandboxDriver: SandboxDriver;
};

// The shared JS fixture executes real API admission. Its callback is specific to
// this case, so declare just the consumed surface and check its deployed result.
const admitProtectedMetadata = staticEgressFixture as (
  t: TestContext,
  options: { admitSource: AdmissionCallback },
) => Promise<ProtectedFixture>;

function hasSourceId(value: unknown): value is { id: string } {
  return (
    typeof value === "object" && value !== null && "id" in value && typeof value.id === "string"
  );
}

test("API-admitted protected credential-free metadata projects no inference tools or anonymous reader", async (t) => {
  const f = await admitProtectedMetadata(t, {
    async admitSource({ app, agent, namespace, path, origin }) {
      const { status, data: source } = await app.request("POST", path, {
        body: {
          name: "identity-only",
          type: "credential-free-repository-metadata",
          config: {
            origin,
            repository_id: "7311",
            repository: "fixture/credential-free",
            agent_id: agent.id,
            authority: "execution",
          },
        },
      });
      assert.equal(status, 201);
      assert.ok(hasSourceId(source));
      const bound = await app.updateAgent(namespace.id, agent.id, {
        configurationId: agent.configurationId,
        harnessAuth: { method: "runtime" },
        credentialSources: [{ sourceId: source.id }],
      });
      return { agent: bound, source };
    },
  });
  assert.equal(f.fixtureKind, "deployed");
  const r = f.revision;
  assert.ok(r.egressPlan);
  assert.deepEqual(r.executionAdmission, { version: 3, mode: "protected" });
  assert.deepEqual(r.egressPlan.driver, f.installedDriver.ref);
  assert.deepEqual(r.harnessAuth, { method: "runtime" });
  assert.deepEqual(
    r.egressPlan.routes.map(({ binding }) => binding.grant.kind),
    ["credential_free_repository_metadata"],
  );
  assert.equal(r.egressPlan.repositoryGit, undefined);
  const { f: reader, driver: ordinary, admission } = await publicReaderAdmission();
  const driver = new KubernetesComputeDriver(reader.ports.options, {
    protectedDriver: f.installedDriver,
  });
  // The API fixture stores the protected plan. Apply the production Compute admission
  // to that revision and check the release gate and projection with the saved tag.
  const launchTag = "openshell-codex-launch:v1:";
  assert.equal(driver.admitRevision(r), launchTag);
  assert.equal(ordinary.admitRevision(r), undefined);
  assert.equal(driver.admitRevision({ ...r, sandboxDriverId: "foreign-sandbox" }), undefined);
  const tagged = {
    ...r,
    egressPlan: r.egressPlan,
    compute: { ...r.compute, admission: launchTag },
  };
  const context = { currentEgressInstallation: async () => f.installation };
  const ports = computeFixturePorts(driver);
  ports.validateRevisionExecution(tagged, context);
  assert.deepEqual(ports.codexLaunch(tagged, f.sandboxDriver), {
    providerOwned: true,
    protected: false,
    openShellProgram: "ordinary",
  });
  assert.throws(() => ports.codexLaunch(tagged, undefined), /Compute admission is invalid/);
  const { runtime } = present(ports.pluginRuntimeSnapshot(tagged));
  assert.ok(runtime.kind === "codex" && runtime.egressEnrollment);
  assert.deepEqual(runtime, present(ports.pluginRuntimeSnapshot(r)).runtime);
  assert.equal(runtime.providerTools, "none");
  assert.equal(runtime.egressEnrollment.inference, false);
  assert.equal(runtime.egressEnrollment.routeCount, 1);
  assert.equal(runtime.modelEndpoint, undefined);
  assert.equal(runtime.repositoryBrokerNetworkPolicy, undefined);
  assert.equal(runtime.publicGithubRead, undefined);
  const forgedInference = {
    ...tagged,
    compute: { ...tagged.compute, admission: launchTag + "protected-codex-no-connection-retry:v1" },
  };
  assert.throws(() => ports.pluginRuntimeSnapshot(forgedInference), /Compute admission is invalid/);
  const borrowedReader = { ...tagged, compute: { ...tagged.compute, admission } };
  assert.throws(
    () => ports.validateRevisionExecution(borrowedReader, context),
    /saved model provider does not match/,
  );
  assert.equal(driver.rejectedExecutionWithdrawal(borrowedReader), undefined);
  const borrowedRuntime = present(ports.pluginRuntimeSnapshot(borrowedReader)).runtime;
  assert.ok(borrowedRuntime.kind === "codex");
  assert.equal(borrowedRuntime.publicGithubRead, undefined);
  const unknown = structuredClone(tagged);
  const route = present(unknown.egressPlan.routes[0]);
  // Persisted grants can contain an unknown kind. Keep the forged value on the wire.
  Object.assign(route.binding.grant, { kind: "not_an_admitted_grant" });
  assert.throws(
    () => ports.pluginRuntimeSnapshot(unknown),
    /Unsupported protected inference tool grant/,
  );
});
