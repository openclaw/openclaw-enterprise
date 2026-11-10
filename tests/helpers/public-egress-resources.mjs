import assert from "node:assert/strict";
import { assertConnectedResponse } from "./egress-connected-inputs.mjs";

// This connected scenario owns these three resources. Keep a definitive admission
// refusal distinct from a missing response; neither permits replaying a create.
export function publicEgressResources({ request, namespacePath, retireAgent, record }) {
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
      // These canonical admission responses precede mutation. Other errors stay
      // uncertain, including dependency failures after a write may have begun.
      if (
        (response.status === 400 && response.body?.error?.code === "INVALID_REQUEST") ||
        (response.status === 401 && response.body?.error?.code === "UNAUTHENTICATED") ||
        (response.status === 403 && response.body?.error?.code === "FORBIDDEN")
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
        outcomes[kind] = { id: item.value?.id, state: item.state };
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
