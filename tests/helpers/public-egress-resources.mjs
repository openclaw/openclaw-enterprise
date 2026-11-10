import assert from "node:assert/strict";
import { assertConnectedResponse } from "./egress-connected-inputs.mjs";
import { AGENT_NAME_CONFLICT, REPOSITORY_SETTINGS_MISSING } from "./refusal-text.mjs";

// This connected scenario owns these three resources. Keep a definitive admission
// refusal distinct from a missing response; neither permits replaying a create.
export function publicEgressResources({
  request,
  namespacePath,
  retireAgent,
  record,
  checkCluster,
}) {
  const resources = {
    configuration: { path: "/configurations", state: "not-started" },
    agent: { path: "/agents", state: "not-started" },
    role: { path: "/iam/roles", state: "not-started" },
  };
  const api = async (method, path, body, expected = 200) =>
    assertConnectedResponse(await request(method, path, body), expected);
  return {
    async create(kind, body) {
      const item = resources[kind];
      assert.equal(item.state, "not-started", "a create must never be replayed");
      await record(kind + "-create-intent", { name: body.name });
      item.name = body.name;
      item.state = "unconfirmed";
      const response = await request("POST", namespacePath + item.path, body);
      // These admission responses precede mutation. In particular, a name-taken
      // refusal never grants ownership of the existing Agent. Unlisted conflicts
      // and dependency failures remain uncertain: a write may have begun.
      if (
        (response.status === 400 && response.body?.error?.code === "INVALID_REQUEST") ||
        (response.status === 401 && response.body?.error?.code === "UNAUTHENTICATED") ||
        (response.status === 403 && response.body?.error?.code === "FORBIDDEN") ||
        (kind === "agent" &&
          response.status === 409 &&
          response.body?.error?.code === "RESOURCE_CONFLICT" &&
          [AGENT_NAME_CONFLICT, REPOSITORY_SETTINGS_MISSING].includes(response.body.error.message))
      ) {
        assertConnectedResponse(response, response.status);
        item.state = "refused";
      }
      item.value = assertConnectedResponse(response, 201);
      item.state = "created";
      await record(kind + "-created", { id: item.value.id });
      return item.value;
    },
    async cleanup() {
      const errors = [];
      const outcomes = {};
      let agentSettled = false;
      for (const [kind, item] of Object.entries(resources)) {
        outcomes[kind] = { id: item.value?.id, name: item.name, state: item.state };
      }
      try {
        await checkCluster();
      } catch (error) {
        // Local evidence is still safe when the cluster cannot be authenticated.
        // Do not reconcile names or perform any mutation against that target.
        for (const outcome of Object.values(outcomes)) {
          outcome.createState = outcome.state;
          if (outcome.state !== "not-started" && outcome.state !== "refused") {
            outcome.state = "unsettled";
          }
        }
        const failures = [error];
        try {
          await record("cleanup", { resources: outcomes, settled: false, clusterVerified: false });
        } catch (receiptError) {
          failures.push(receiptError);
        }
        if (failures.length > 1) {
          throw new AggregateError(
            failures,
            "Cluster verification failed and its cleanup receipt could not be written",
            { cause: error },
          );
        }
        throw error;
      }
      // Retirement is the prerequisite for deleting its Configuration and Role.
      // A Role failure must not prevent the independent Configuration deletion.
      for (const kind of ["agent", "role", "configuration"]) {
        const item = resources[kind];
        try {
          if (item.state === "not-started" || item.state === "refused") {
            if (kind === "agent") {
              agentSettled = true;
            }
            continue;
          }
          if (kind !== "agent") {
            assert.ok(agentSettled, "Agent retirement is unconfirmed; retain dependent resources");
          }
          if (!item.value) {
            assert.notEqual(kind, "configuration", "Configuration creation is unconfirmed");
            const matches = (await api("GET", namespacePath + item.path)).filter(
              (candidate) => candidate.name === item.name,
            );
            assert.equal(matches.length, 1, kind + " creation is unconfirmed; retain the stack");
            item.value = matches[0];
            outcomes[kind].id = item.value.id;
          }
          if (kind === "agent") {
            await retireAgent(item.value);
            agentSettled = true;
          } else {
            await api("DELETE", namespacePath + item.path + "/" + item.value.id, undefined, 204);
          }
          outcomes[kind].state = "deleted";
        } catch (error) {
          outcomes[kind].state = "unsettled";
          errors.push(error);
        }
      }
      await record("cleanup", { resources: outcomes, settled: errors.length === 0 });
      if (errors.length > 0) {
        throw new AggregateError(errors, "Public egress cleanup is unsettled; retain the stack");
      }
    },
  };
}
