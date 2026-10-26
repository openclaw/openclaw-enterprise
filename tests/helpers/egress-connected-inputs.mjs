import assert from "node:assert/strict";
import { isIP } from "node:net";
import { isAbsolute, posix } from "node:path";
import { createHarnessConfiguration } from "./harness-configuration.mjs";

export const protectedEgressCapability =
  "openshell.supervisor-middleware.http-credential-access.v1";

export function validateConnectedDatabaseUrl(value) {
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

// The runner chooses where its service credential can go. The separate stack
// manifest is checked against that choice, never used to select a credential file.
export function takeConnectedControllerBinding(env) {
  const serviceKey = env.OCC_TEST_EGRESS_CONNECTED_SERVICE_KEY;
  delete env.OCC_TEST_EGRESS_CONNECTED_SERVICE_KEY; // Do not pass it to kubectl or other children.
  assert.ok(
    typeof serviceKey === "string" && serviceKey.length > 0 && !/\s/.test(serviceKey),
    "the runner must supply the prepared controller service key",
  );
  const { apiOrigin, namespaceId, model, providerOrigin } = JSON.parse(
    env.OCC_TEST_EGRESS_CONNECTED_CONTROLLER,
  );
  const api = new URL(apiOrigin);
  assert.ok(
    (api.protocol === "http:" || api.protocol === "https:") &&
      api.hostname === "127.0.0.1" &&
      Number(api.port) > 1024 &&
      api.origin === apiOrigin,
    "select the controller's exact 127.0.0.1 origin and explicit high port",
  );
  return { apiOrigin, namespaceId, model, providerOrigin, serviceKey };
}

// Inputs describe an already installed, disposable protected stack. They do not
// authorize this test to install a gateway, change trust, or relax admission.
export function validateConnectedInputs(input, controller, { wholeExecution = false } = {}) {
  assert.equal(input.version, 2);
  assert.equal(input.apiOrigin, controller.apiOrigin, "controller origin disagrees with runner");
  assert.equal(input.namespaceId, controller.namespaceId, "tenant disagrees with runner");
  assert.equal(input.model, controller.model, "model disagrees with runner");
  assert.equal(input.provider.origin, controller.providerOrigin, "fixture disagrees with runner");
  assert.equal(input.serviceKeyPath, undefined, "manifest must not select a controller key file");
  assert.match(input.namespaceId ?? "", /^ns_[A-Za-z0-9_-]+$/);
  assert.match(input.model ?? "", /^[a-zA-Z0-9][a-zA-Z0-9._-]+$/);
  for (const path of [
    input.kubeconfigPath,
    input.provider?.certificatePath,
    input.provider?.privateKeyPath,
    input.openShellBackend?.rootCertificatePath,
  ]) {
    assert.ok(
      typeof path === "string" && isAbsolute(path),
      "explicit absolute fixture/trust paths are required",
    );
  }
  assert.match(input.kubernetesContext ?? "", /^k3d-/);
  assert.match(input.controllerNamespace ?? "", /^[a-z0-9-]+$/);
  assert.ok(input.controllerSelector && !/[\r\n]/.test(input.controllerSelector));
  assert.match(input.openShellGatewayNamespace ?? "", /^[a-z0-9-]+$/);
  assert.ok(input.openShellGatewaySelector && !/[\r\n]/.test(input.openShellGatewaySelector));
  assert.match(input.runtimeClass ?? "", /^[a-z0-9-]+$/);
  for (const image of Object.values(input.images ?? {})) {
    assert.match(image, /^[^\s@]+@sha256:[a-f0-9]{64}$/);
  }
  assert.deepEqual(
    Object.keys(input.images ?? {}).sort(),
    ["agent", "controller", "gateway", "openShellGateway", "sandbox", "supervisor"].sort(),
  );
  // Explicit operator verification of the genuine intended executable in the
  // immutable workload image is required. Never discover authority by TOFU.
  if (wholeExecution) {
    assert.equal(input.authorityProfile, "fresh-whole-execution");
    assert.equal(
      input.credentialConnector,
      undefined,
      "a connector grant cannot authorize the entire execution",
    );
  } else {
    assert.equal(
      input.authorityProfile,
      undefined,
      "legacy connector inputs cannot claim whole-execution authority",
    );
    const pin = input.credentialConnector;
    assert.ok(pin && typeof pin.path === "string" && pin.path.startsWith("/") && pin.path !== "/");
    assert.equal(posix.normalize(pin.path), pin.path);
    assert.ok(
      !pin.path.endsWith("/") &&
        ![...pin.path].some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127),
    );
    assert.match(pin.sha256 ?? "", /^[a-f0-9]{64}$/);
    assert.equal(pin.image, input.images.agent);
    assert.equal(pin.verification, "operator-verified-image-executable");
  }
  for (const head of [input.oceCommit, input.supplierCommit]) {
    assert.match(head ?? "", /^[a-f0-9]{40}$/);
  }
  const gateway = new URL(input.openShellBackend.endpoint);
  assert.equal(gateway.protocol, "https:");
  assert.equal(gateway.username + gateway.password + gateway.search + gateway.hash, "");
  const auth = input.openShellBackend.auth;
  assert.ok(auth && typeof auth === "object", "explicit Backend authentication is required");
  const authPaths =
    auth.mode === "bearerTokenFile" ? ["path"] : ["certificatePath", "privateKeyPath"];
  assert.ok(
    auth.mode === "bearerTokenFile" || auth.mode === "mtls",
    "Backend authentication must be bearerTokenFile or mtls",
  );
  assert.deepEqual(Object.keys(auth).sort(), ["mode", ...authPaths].sort());
  for (const key of authPaths) {
    assert.ok(
      typeof auth[key] === "string" && isAbsolute(auth[key]),
      "explicit absolute Backend authentication paths are required",
    );
  }
  assert.equal(input.openShellBackend.insecureTransport, undefined);
  const provider = new URL(input.provider.origin);
  assert.equal(provider.protocol, "https:");
  assert.ok(
    provider.hostname.endsWith(".test") || provider.hostname === "host.openshell.internal",
    "use a fixture-only .test origin or the native host.openshell.internal fixture alias",
  );
  assert.equal(provider.pathname, "/v1");
  assert.equal(provider.username + provider.password + provider.search + provider.hash, "");
  assert.ok(isIP(input.provider.bindHost), "explicit provider listener IP is required");
  assert.ok(
    Number.isSafeInteger(input.provider.bindPort) &&
      input.provider.bindPort > 1024 &&
      input.provider.bindPort < 65536,
  );
  assert.equal(Number(provider.port || 443), input.provider.bindPort);
  return input;
}

// The gateway client loads proto3 with defaults:false and longs:String. An
// omitted uint64 is zero, while present values must retain all 64 bits.
export function connectedReceiptRevision(value) {
  if (value === undefined) {
    return "0";
  }
  assert.ok(typeof value === "string" && /^(0|[1-9][0-9]{0,19})$/.test(value));
  assert.ok(BigInt(value) <= 18446744073709551615n);
  return value;
}

export function assertNoConnectedAssistantOutput(result) {
  assert.equal(result.assistant, "", "no staged response text may escape a failed delivery");
  assert.equal(
    result.items.some(
      (event) =>
        (event.method === "item/agentMessage/delta" && Boolean(event.params?.delta)) ||
        (["item/started", "item/completed"].includes(event.method) &&
          event.params?.item?.type === "agentMessage" &&
          Boolean(event.params.item.text)),
    ),
    false,
    "a failed delivery must not expose partial assistant output",
  );
}

export function protectedSourceBody(name, secretRef, origin) {
  return { name, type: "openai", config: { base_url: origin }, secrets: { api_key: secretRef } };
}

export function protectedAgentBody(name, configurationId, sourceId) {
  return {
    name,
    configurationId,
    executionMode: "dedicated",
    harnessAuth: { method: "credential_source", sourceId },
    credentialSources: [{ sourceId }],
  };
}

export function protectedConfigurationBody(model) {
  const values = createHarnessConfiguration("codex", model);
  // Keep ordinary local tools. The production grant derives disabled provider
  // tools and zero retries; no test-supplied Codex config overrides those decisions.
  values.tools = { allow: ["read", "write", "edit", "exec"], fs: { workspaceOnly: true } };
  return { kind: "agent", values };
}

export function sourceAccessBindingBody(agent, role, source) {
  return {
    subjectKind: "identity",
    subjectId: agent.servicePrincipalId,
    roleId: role.id,
    resourceKind: "credential_source",
    resourceId: source.id,
  };
}

export function serializeConnectedRequest(method, path, body) {
  assert.ok(path.startsWith("/") && !path.startsWith("//"));
  return {
    method,
    path,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

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
export function assertConnectedResponse(response, expectedStatus) {
  assert.equal(
    response.status,
    expectedStatus,
    `HTTP ${response.status}; error code ${response.body?.error?.code ?? "absent"}`,
  );
  if (expectedStatus === 204) {
    assert.equal(response.body, undefined);
    return undefined;
  }
  assert.ok(
    response.body && typeof response.body === "object",
    "actual JSON response body is required",
  );
  assert.equal(typeof response.body.meta?.requestId, "string");
  if (expectedStatus >= 400) {
    assert.equal(typeof response.body.error?.code, "string");
    return response.body.error;
  }
  assert.ok(response.body.data !== undefined, "actual response data is required");
  return response.body.data;
}
