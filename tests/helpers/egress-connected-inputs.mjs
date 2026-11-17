import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { Check } from "typebox/value";
import { SecretReference } from "../../packages/contracts/src/api/common.ts";
import { isArray, isRecord, record } from "./egress-observation-values.ts";
import { createHarnessConfiguration } from "./harness-configuration.mjs";

export {
  takeConnectedControllerBinding,
  validateConnectedInputs,
} from "./egress-connected-manifest.ts";

export const protectedEgressCapability =
  "openshell.supervisor-middleware.http-credential-access.v1";

export function validateConnectedDatabaseUrl(/** @type {string | undefined} */ value) {
  assert.ok(value, "OCC_TEST_DATABASE_URL must select the prepared openclaw_k8s_* database");
  let database;
  try {
    database = new URL(value);
  } catch {
    throw new Error("OCC_TEST_DATABASE_URL must be a valid PostgreSQL URL");
  }
  assert.ok(["postgres:", "postgresql:"].includes(database.protocol));
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(database.hostname));
  assert.ok(/^\/openclaw_k8s_[a-z0-9_]+$/.test(database.pathname));
  assert.equal(database.username, "occ_app", "use the limited application database role");
  // libpq connection options can override the URL host/database. The prepared
  // loopback URL needs no query parameters and must not redirect this observer.
  assert.equal(database.search, "", "database URL query overrides are not supported");
  assert.equal(database.hash, "");
  return value;
}

// Both installed callers bind their evidence before touching the prepared stack.
/**
 * @param {{oceCommit: string, harnessCommit: string,
 *   controllerUpgrade?: {fromCommit: string} | undefined}} input
 */
export function assertConnectedCheckout(input) {
  /** @param {...string} args */
  const git = (...args) =>
    execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  assert.equal(git("rev-parse", "HEAD"), input.harnessCommit, "selected harness checkout");
  assert.equal(
    git("status", "--porcelain", "--untracked-files=all"),
    "",
    "installed qualification requires a clean checkout",
  );
  git("merge-base", "--is-ancestor", input.oceCommit, input.harnessCommit);
  if (input.controllerUpgrade) {
    git("merge-base", "--is-ancestor", input.controllerUpgrade.fromCommit, input.oceCommit);
  }
}

// The gateway client loads proto3 with defaults:false and longs:String. An
// omitted uint64 is zero, while present values must retain all 64 bits.
/** @param {unknown} value */
export function connectedReceiptRevision(value) {
  if (value === undefined) {
    return "0";
  }
  assert.ok(typeof value === "string" && /^(0|[1-9][0-9]{0,19})$/.test(value));
  assert.ok(BigInt(value) <= 18446744073709551615n);
  return value;
}

/** @param {unknown} result */
export function assertNoConnectedAssistantOutput(result) {
  assert.ok(isRecord(result), "expected Codex turn response");
  assert.equal(result.assistant, "", "no staged response text may escape a failed delivery");
  assert.ok(isArray(result.items), "expected Codex turn events");
  assert.equal(
    result.items.some((entry) => {
      assert.ok(entry != null, "expected Codex turn event");
      const event = record(entry);
      const params = record(event.params);
      const item = record(params.item);
      return (
        (event.method === "item/agentMessage/delta" && Boolean(params.delta)) ||
        ((event.method === "item/started" || event.method === "item/completed") &&
          item.type === "agentMessage" &&
          Boolean(item.text))
      );
    }),
    false,
    "a failed delivery must not expose partial assistant output",
  );
}

/**
 * @param {unknown} value
 * @returns {asserts value is { ref: import("../../packages/contracts/src/index.ts").SecretReference }}
 */
export function assertSecretReference(value) {
  assert.ok(
    isRecord(value) && Check(SecretReference, value.ref),
    "expected the OCC Secret reference",
  );
}

/**
 * @param {string} name
 * @param {import("../../packages/contracts/src/index.ts").SecretReference} secretRef
 * @param {string} origin
 */
export function protectedSourceBody(name, secretRef, origin) {
  return {
    name,
    type: "openai",
    config: { authorized_base_url: origin },
    secrets: { api_key: secretRef },
  };
}

/** @param {string} name @param {string} configurationId @param {string} sourceId */
export function protectedAgentBody(name, configurationId, sourceId) {
  return {
    name,
    configurationId,
    executionMode: "dedicated",
    harnessAuth: { method: "credential_source", sourceId },
    credentialSources: [{ sourceId }],
  };
}

/** @param {string} model */
export function protectedConfigurationBody(model) {
  const values = {
    ...createHarnessConfiguration("codex", model),
    // The production grant derives disabled provider tools and zero retries.
    tools: { allow: ["read", "write", "edit", "exec"], fs: { workspaceOnly: true } },
  };
  return { kind: "agent", values };
}

/** @param {{servicePrincipalId: string}} agent @param {{id: string}} role @param {{id: string}} source */
export function sourceAccessBindingBody(agent, role, source) {
  return {
    subjectKind: "identity",
    subjectId: agent.servicePrincipalId,
    roleId: role.id,
    resourceKind: "credential_source",
    resourceId: source.id,
  };
}

/**
 * @template {string} Method
 * @param {Method} method
 * @param {string} path
 * @param {unknown} [body]
 */
export function serializeConnectedRequest(method, path, body) {
  assert.ok(path.startsWith("/") && !path.startsWith("//"));
  return {
    method,
    path,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

/**
 * @param {{apiOrigin: string, serviceKey: string}} controller
 * @param {{method: string, path: string, headers: ReturnType<typeof serializeConnectedRequest>["headers"], body?: string | undefined}} wire
 * @param {AbortSignal} signal
 */
export function sendConnectedRequest({ apiOrigin, serviceKey }, wire, signal) {
  const url = new URL(wire.path, apiOrigin);
  // Check what fetch will use. A leading slash alone does not rule out a URL
  // authority after the URL parser normalizes backslashes and ASCII whitespace.
  assert.equal(url.origin, apiOrigin, "the service key may only go to the selected controller");
  return fetch(url, {
    method: wire.method,
    headers: { ...wire.headers, "x-api-key": serviceKey },
    ...(wire.body === undefined ? {} : { body: wire.body }),
    redirect: "error",
    signal,
  });
}

// Check the captured envelope, not a guessed client return shape. The same
// serializer is exercised through Fastify's real content parser in offline proof.
/**
 * @param {{ status: number, body?: unknown }} response
 * @param {number} expectedStatus
 * @returns {unknown}
 */
export function assertConnectedResponse(response, expectedStatus) {
  const body = response.body;
  const error = record(body).error;
  const code = record(error).code;
  assert.equal(
    response.status,
    expectedStatus,
    `HTTP ${response.status}; error code ${code ?? "absent"}`,
  );
  if (expectedStatus === 204) {
    assert.equal(response.body, undefined);
    return undefined;
  }
  assert.ok(isRecord(body), "actual JSON response body is required");
  assert.equal(typeof record(body.meta).requestId, "string");
  if (expectedStatus >= 400) {
    assert.equal(typeof code, "string");
    return error;
  }
  assert.ok(body.data !== undefined, "actual response data is required");
  return body.data;
}
