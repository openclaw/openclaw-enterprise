import assert from "node:assert/strict";
import { createRequire } from "node:module";

import {
  AgentResponse,
  AgentRevisionResponse,
  ConfigurationResponse,
  NamespaceResponse,
  SecretResponse,
} from "../../packages/contracts/src/api/resources.ts";

const schemas = {
  agent: AgentResponse,
  revision: AgentRevisionResponse,
  configuration: ConfigurationResponse,
  namespace: NamespaceResponse,
  secret: SecretResponse,
};
type Responses = {
  agent: AgentResponse;
  revision: AgentRevisionResponse;
  configuration: ConfigurationResponse;
  namespace: NamespaceResponse;
  secret: SecretResponse;
};

const require = createRequire(new URL("../../packages/contracts/package.json", import.meta.url));
const valueModule: unknown = require("typebox/value");
function isCallable(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === "function";
}
assert.ok(typeof valueModule === "object" && valueModule !== null && "Check" in valueModule);
const candidate = valueModule.Check;
assert.ok(isCallable(candidate), "TypeBox value module must export Check");
const Check = candidate;

export function createFixtureResponse(context: Record<string, unknown>) {
  function isResponse<K extends keyof Responses>(kind: K, body: unknown): body is Responses[K] {
    return Check(context, schemas[kind], body) === true;
  }

  return function fixtureResponse<K extends keyof Responses>(
    result: { status: number; body: unknown },
    status: number,
    kind: K,
    operation: string,
  ): Responses[K]["data"] {
    assert.equal(result.status, status, `${operation}: unexpected HTTP status`);
    const body = result.body;
    if (!isResponse(kind, body)) {
      throw new Error(`${operation}: invalid ${kind} response envelope`);
    }
    return body.data;
  };
}
