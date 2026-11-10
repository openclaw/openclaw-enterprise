import assert from "node:assert/strict";
import type { Agent, Configuration, Role } from "@openclaw-enterprise/contracts";

import { assertConnectedResponse } from "./egress-connected-inputs.mjs";
import { AGENT_NAME_CONFLICT, REPOSITORY_SETTINGS_MISSING } from "./refusal-text.mjs";
import type { RunWindow } from "./public-egress-deadline.ts";

type Response = {
  status: number;
  body: { error?: { code?: string; message?: string }; data?: unknown; meta?: unknown } | undefined;
};
export type PublicEgressRequest = (
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: object,
  signal?: AbortSignal,
) => Promise<Response>;

type ResourceValues = {
  configuration: Pick<Configuration, "id">;
  agent: Pick<Agent, "id" | "servicePrincipalId">;
  role: Pick<Role, "id">;
};
type CreateBodies = {
  configuration: Pick<Configuration, "kind" | "values">;
  agent: Pick<Agent, "name" | "configurationId"> &
    Partial<
      Pick<Agent, "executionMode" | "harnessAuth" | "credentialSources" | "repositoryBindings">
    >;
  role: Pick<Role, "name" | "permissions">;
};
type Kind = keyof ResourceValues;
type CreateState = "not-started" | "unconfirmed" | "refused" | "created";
type Intent<K extends Kind> = {
  path: string;
  state: CreateState;
  name?: string | undefined;
  value?: ResourceValues[K];
};
type Outcome = {
  id?: string | undefined;
  name?: string | undefined;
  state: CreateState | "deleted" | "unsettled";
  createState?: CreateState;
};
type Dependencies = {
  request: PublicEgressRequest;
  namespacePath: string;
  retireAgent: (agent: ResourceValues["agent"], window?: RunWindow) => Promise<void>;
  record: (name: string, value: object) => Promise<void>;
  checkCluster: (window?: RunWindow) => Promise<void>;
};
const kinds = ["agent", "role", "configuration"] as const;

function definitivelyRefused(kind: Kind, { status, body }: Response) {
  const code = body?.error?.code;
  const message = body?.error?.message;
  return (
    (status === 400 && code === "INVALID_REQUEST") ||
    (status === 401 && code === "UNAUTHENTICATED") ||
    (status === 403 && code === "FORBIDDEN") ||
    (kind === "agent" &&
      status === 409 &&
      code === "RESOURCE_CONFLICT" &&
      (message === AGENT_NAME_CONFLICT || message === REPOSITORY_SETTINGS_MISSING))
  );
}

function resourceValue<K extends Kind>(kind: K, value: unknown): ResourceValues[K] {
  assert.ok(value && typeof value === "object" && "id" in value);
  assert.ok(typeof value.id === "string" && value.id.length > 0);
  if (kind === "agent") {
    assert.ok("servicePrincipalId" in value);
    assert.ok(typeof value.servicePrincipalId === "string" && value.servicePrincipalId.length > 0);
  }
  return value as ResourceValues[K];
}

export function publicEgressResources({
  request,
  namespacePath,
  retireAgent,
  record,
  checkCluster,
}: Dependencies) {
  const resources: { [K in Kind]: Intent<K> } = {
    configuration: { path: "/configurations", state: "not-started" },
    agent: { path: "/agents", state: "not-started" },
    role: { path: "/iam/roles", state: "not-started" },
  };
  async function recover<K extends Kind>(
    kind: K,
    item: Intent<K>,
    signal?: AbortSignal,
  ): Promise<ResourceValues[K]> {
    if (item.value) {
      return item.value;
    }
    assert.notEqual(kind, "configuration", "Configuration creation is unconfirmed");
    const response = await request("GET", namespacePath + item.path, undefined, signal);
    const candidates: (ResourceValues[K] & { name: string })[] = assertConnectedResponse(
      response,
      200,
    );
    const matches = candidates.filter((candidate) => candidate.name === item.name);
    assert.equal(matches.length, 1, kind + " creation is unconfirmed; retain the stack");
    return resourceValue(kind, matches[0]);
  }

  return {
    async create<K extends Kind>(kind: K, body: CreateBodies[K]): Promise<ResourceValues[K]> {
      const item: Intent<K> = resources[kind];
      assert.equal(item.state, "not-started", "a create must never be replayed");
      const name = "name" in body ? body.name : undefined;
      await record(kind + "-create-intent", { name });
      item.name = name;
      item.state = "unconfirmed";
      const response = await request("POST", namespacePath + item.path, body);
      // A definitive refusal precedes mutation and conveys no ownership.
      if (definitivelyRefused(kind, response)) {
        assertConnectedResponse(response, response.status);
        item.state = "refused";
      }
      const value = resourceValue(kind, assertConnectedResponse(response, 201));
      item.value = value;
      item.state = "created";
      await record(kind + "-created", { id: value.id });
      return value;
    },
    async cleanup(window?: RunWindow) {
      const outcomes = Object.fromEntries(
        kinds.map((kind) => {
          const item = resources[kind];
          const outcome: Outcome = { id: item.value?.id, name: item.name, state: item.state };
          return [kind, outcome];
        }),
      ) as Record<Kind, Outcome>;
      try {
        await checkCluster(window);
      } catch (error) {
        // Local evidence can be written after the target loses authentication.
        for (const kind of kinds) {
          const outcome = outcomes[kind];
          outcome.createState = resources[kind].state;
          if (outcome.state !== "not-started" && outcome.state !== "refused") {
            outcome.state = "unsettled";
          }
        }
        const failures = [error];
        await record("cleanup", {
          resources: outcomes,
          settled: false,
          clusterVerified: false,
        }).catch((receiptError: unknown) => failures.push(receiptError));
        if (failures.length > 1) {
          throw new AggregateError(
            failures,
            "Cluster verification failed and its cleanup receipt could not be written",
            { cause: error },
          );
        }
        throw error;
      }
      const signal = window?.signal;
      const errors: unknown[] = [];
      let agentSettled = false;
      for (const kind of kinds) {
        const item = resources[kind];
        try {
          if (item.state !== "not-started" && item.state !== "refused") {
            if (kind === "agent") {
              const agent = await recover(kind, resources.agent, signal);
              outcomes.agent.id = agent.id;
              await retireAgent(agent, window);
            } else {
              assert.ok(
                agentSettled,
                "Agent retirement is unconfirmed; retain dependent resources",
              );
              const value = await recover(kind, item, window?.signal);
              outcomes[kind].id = value.id;
              assertConnectedResponse(
                await request(
                  "DELETE",
                  namespacePath + item.path + "/" + value.id,
                  undefined,
                  window?.signal,
                ),
                204,
              );
            }
            outcomes[kind].state = "deleted";
          }
          if (kind === "agent") {
            agentSettled = true;
          }
        } catch (error) {
          outcomes[kind].state = "unsettled";
          errors.push(error);
        }
      }
      try {
        await record("cleanup", { resources: outcomes, settled: errors.length === 0 });
      } catch (error) {
        errors.push(error);
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, "Public egress cleanup is unsettled; retain the stack");
      }
    },
  };
}
