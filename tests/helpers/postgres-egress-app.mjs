import assert from "node:assert/strict";
import { createPostgresAgentApp } from "./postgres-agent-app.mjs";

export async function postgresApp(t, options, transportDatabaseUrl) {
  const p = await createPostgresAgentApp(t, {
    label: "static-egress",
    transportDatabaseUrl,
    poolOptions: options.poolOptions,
    controllerOptions: {
      preparedTokens: options.preparedTokens,
      driverConfigurations: options.driverConfigurations,
      ...(options.now && { now: options.now }),
      ...(options.recordOperations && { recordOperations: true }),
    },
    stateOptions: { preparedTokenProof: options.preparedTokens?.postgresCurrentProof },
    authSecret: "static-egress-fixture-session-secret-2026",
    appOptions: { secretDriver: options.secretDriver, computeDriver: options.computeDriver },
  });
  for (const driver of [options.secretDriver, options.computeDriver]) {
    p.controller.registerDriver(driver);
    p.controller.selectDriver(driver.capability, driver.id);
  }
  const request = async (method, path, { body } = {}) => {
    const result = await p.inject(method, path, body);
    const payload = result.statusCode === 204 ? {} : result.json();
    return { status: result.statusCode, body: payload, data: payload.data };
  };
  return {
    ...p,
    request,
    async bootstrap() {}, // createPostgresAgentApp bootstraps through the real development command.
    async createNamespace(name) {
      const result = await request("POST", "/namespaces", { body: { name } });
      assert.equal(result.status, 201, JSON.stringify(result.body));
      await p.controller.handleNamespaceLifecycle(p.principal.id, result.data.id, "ready");
      return (await request("GET", `/namespaces/${result.data.id}`)).data;
    },
    async createConfiguration(namespaceId, values) {
      const result = await request("POST", `/namespaces/${namespaceId}/configurations`, {
        body: { kind: "agent", values },
      });
      assert.equal(result.status, 201, JSON.stringify(result.body));
      return result.data;
    },
    async deployAgent(namespaceId, agentId) {
      const result = await request("POST", `/namespaces/${namespaceId}/agents/${agentId}/deploy`);
      assert.equal(result.status, 202, JSON.stringify(result.body));
      return result.data;
    },
    async activateRevision(namespaceId, agentId, revisionId) {
      assert.ok(
        await p.state.transact((unit) =>
          unit.agents.compareAndSetActiveRevision(namespaceId, agentId, undefined, revisionId),
        ),
      );
    },
  };
}
