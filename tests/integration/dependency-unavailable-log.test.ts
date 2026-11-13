import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { ConfigurationBackendUnavailableError } from "../../apps/controller/src/drivers/configuration/kubernetes/index.ts";
import { GrpcOpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { dependencyUnavailableLogFields } from "../../apps/controller/src/http/errors.ts";
import { createOccLogger, WITHHELD_ERROR_TEXT } from "../../apps/controller/src/logging.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { ErrorResponse } from "../../packages/contracts/src/api/common.ts";
import type { NamespaceWire } from "../../packages/contracts/src/api/resources.ts";
import {
  DependencyUnavailableError,
  RuntimeCredentialsForbiddenByClusterError,
} from "../../packages/occ/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { syntheticCredentialUrl } from "../fixtures/synthetic-credential-url.mjs";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.ts";
import { createReadyComputeDriver } from "../helpers/development.ts";
import { jsonLineDestination } from "../helpers/json-lines.mjs";
import { grpc } from "../helpers/openshell-grpc-sdk.ts";
import { DEPENDENCY_UNAVAILABLE } from "../helpers/refusal-text.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";

type Fixture = Awaited<ReturnType<typeof createConsoleAppFixture>>;
type HttpResponse = { status: number; body: unknown };

const SECRET_VALUE = "sk-proj-dependencylogvalue0123456789";
// What a Kubernetes client error can carry: the request and the answer's body.
const CLIENT_TEXT =
  "POST /api/v1/namespaces/t/configmaps Authorization: Bearer clienttoken0123456789";

function capturedLogger() {
  const lines: unknown[] = [];
  const logger = createOccLogger({
    component: "occ-api",
    level: "info",
    destination: jsonLineDestination(lines),
  });
  return { lines, logger };
}

// OCC passes a Configuration Driver's DependencyUnavailableError through to HTTP unchanged, as it
// does a ServiceAccount Driver's.
async function configurationFixture(
  t: TestContext,
  {
    createError,
    auditSink,
  }: {
    createError?: DependencyUnavailableError;
    auditSink?: InMemoryAuditSink;
  } = {},
) {
  const { lines, logger } = capturedLogger();
  const configurationDriver = createTestConfigurationDriver({ id: "console-configuration" });
  const fixture = await createConsoleAppFixture(t, {
    ...(auditSink === undefined ? {} : { auditSink }),
    logger,
    configurationDriver,
    secretDriver: createTestSecretDriver({ id: "console-secret" }),
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Dependency log", { ready: true });
  if (createError !== undefined) {
    configurationDriver.create = async () => {
      throw createError;
    };
  }
  return { fixture, lines, namespace };
}

function createConfiguration(fixture: Fixture, namespace: NamespaceWire): Promise<HttpResponse> {
  return fixture.request("POST", `/namespaces/${namespace.id}/configurations`, {
    body: { kind: "agent", values: { note: SECRET_VALUE } },
  });
}

function logEvents(lines: readonly unknown[], event: string) {
  return lines.map(asRecord).filter((line) => line?.event === event);
}

function dependencyWarnings(lines: readonly unknown[]) {
  return logEvents(lines, "http.dependency_unavailable");
}

function errorResponse(fixture: Fixture, response: HttpResponse) {
  return fixture.fixtureResponse(response, 503, ErrorResponse, "Dependency response");
}

test("a 503 DEPENDENCY_UNAVAILABLE keeps its generic body and logs its cause by request ID", async (t) => {
  const error = new ConfigurationBackendUnavailableError(
    "The Kubernetes ConfigMap create outcome is unknown after timeout.",
  );
  error.cause = Object.assign(new Error(CLIENT_TEXT), {
    name: "ApiException",
    code: 500,
    body: CLIENT_TEXT,
    cause: Object.assign(new Error(`socket ${CLIENT_TEXT}`), { code: "ECONNRESET" }),
  });
  const { fixture, lines, namespace } = await configurationFixture(t, { createError: error });
  const response = await createConfiguration(fixture, namespace);

  const body = errorResponse(fixture, response);
  assert.deepEqual(body.error, {
    code: "DEPENDENCY_UNAVAILABLE",
    message: DEPENDENCY_UNAVAILABLE,
  });
  const warnings = dependencyWarnings(lines);
  assert.equal(warnings.length, 1, JSON.stringify(warnings));
  const [entry] = warnings;
  assert.ok(entry);
  const { time, ...warning } = entry;
  assert.equal(typeof time, "string");
  assert.deepEqual(warning, {
    severity: "WARN",
    service: "occ-api",
    event: "http.dependency_unavailable",
    requestId: body.meta.requestId,
    method: "POST",
    route: "/namespaces/:namespaceId/configurations",
    errorClass: "ConfigurationBackendUnavailableError",
    message: "The Kubernetes ConfigMap create outcome is unknown after timeout.",
    causes: [{ errorClass: "ApiException", code: 500 }, { code: "ECONNRESET" }],
  });
  // Neither the submitted value nor the client error's text reaches any log line.
  const logged = JSON.stringify(lines);
  assert.equal(logged.includes(SECRET_VALUE), false);
  assert.equal(logged.includes("clienttoken"), false);
});

test("a dependency message that resembles a credential is withheld from the log", async (t) => {
  const { fixture, lines, namespace } = await configurationFixture(t, {
    createError: new DependencyUnavailableError(`Upstream answered with ${SECRET_VALUE}.`),
  });
  const response = await createConfiguration(fixture, namespace);

  const body = errorResponse(fixture, response);
  assert.equal(body.error.message, DEPENDENCY_UNAVAILABLE);
  const warnings = dependencyWarnings(lines);
  assert.equal(warnings.length, 1, JSON.stringify(warnings));
  const [warning] = warnings;
  assert.ok(warning);
  assert.equal(warning.message, WITHHELD_ERROR_TEXT);
  assert.equal(JSON.stringify(lines).includes(SECRET_VALUE), false);
});

test("responses other than a dependency 503 log no dependency warning", async (t) => {
  const { fixture, lines, namespace } = await configurationFixture(t);
  const created = await createConfiguration(fixture, namespace);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const missing: HttpResponse = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/cfg_00000000-0000-4000-8000-000000000000`,
  );
  assert.equal(missing.status, 404, JSON.stringify(missing.body));
  const invalid: HttpResponse = await fixture.request(
    "POST",
    `/namespaces/${namespace.id}/configurations`,
    { body: { kind: "agent" } },
  );
  assert.equal(invalid.status, 400, JSON.stringify(invalid.body));
  assert.deepEqual(dependencyWarnings(lines), []);
});

test("a dependency error answered with its own code logs no dependency warning", async (t) => {
  const { lines, logger } = capturedLogger();
  const checkedAgents: { namespaceId: string; agentId: string }[] = [];
  // The selected Compute Driver reports a tenant RoleBinding denial to the runtime-credentials route.
  const computeDriver = createReadyComputeDriver("dependency-log-compute", {
    validateHarnessAuth() {},
    async getAgentRuntimeCredentialStatus({ namespace, agent }) {
      checkedAgents.push({ namespaceId: namespace.id, agentId: agent.id });
      throw new RuntimeCredentialsForbiddenByClusterError({
        verb: "get",
        resource: "secrets",
        kubernetesNamespace: "tenant-dependency-log",
        plane: "control",
        status: 403,
      });
    },
  });
  const fixture = await createConsoleAppFixture(t, {
    logger,
    computeDriver,
    secretDriver: createTestSecretDriver({ id: "console-secret" }),
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Runtime credential denial", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Runtime credential Agent");
  const response = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${agent.id}/runtime-credentials`,
  );

  const body = errorResponse(fixture, response);
  assert.deepEqual(body.error, {
    code: "RUNTIME_CREDENTIALS_CLUSTER_RBAC",
    message:
      "The cluster denied OCC access needed for this Agent's runtime credentials. Ask a platform operator to grant the API ServiceAccount the documented tenant RoleBindings in the Agent's Kubernetes namespaces.",
  });
  assert.deepEqual(checkedAgents, [{ namespaceId: namespace.id, agentId: agent.id }]);
  assert.deepEqual(dependencyWarnings(lines), []);
  const warnings = logEvents(lines, "agent_runtime_credentials.cluster_denied");
  assert.equal(warnings.length, 1, JSON.stringify(warnings));
  const [entry] = warnings;
  assert.ok(entry);
  const { time, ...warning } = entry;
  assert.equal(typeof time, "string");
  assert.deepEqual(warning, {
    severity: "WARN",
    service: "occ-api",
    event: "agent_runtime_credentials.cluster_denied",
    requestId: body.meta.requestId,
    route: "/namespaces/:namespaceId/agents/:agentId/runtime-credentials",
    verb: "get",
    resource: "secrets",
    kubernetesNamespace: "tenant-dependency-log",
    plane: "control",
    kubernetesStatus: 403,
  });
});

test("a dependency 503 that no dependency error raised logs no dependency warning", async (t) => {
  const auditSink = new InMemoryAuditSink();
  const { fixture, lines, namespace } = await configurationFixture(t, { auditSink });
  const limited = await fixture.createAccountWithPolicy("dependency-log-member", () => {});
  const session = await fixture.signIn(limited.credentials);
  // The denial's audit write fails, so the denial answers a dependency 503 of its own.
  const append = t.mock.method(auditSink, "append", async () => {
    throw new DependencyUnavailableError("The platform audit repository is unavailable.");
  });
  const response = await fixture.request("GET", `/namespaces/${namespace.id}`, { session });
  const body = errorResponse(fixture, response);
  assert.deepEqual(body.error, {
    code: "DEPENDENCY_UNAVAILABLE",
    message: DEPENDENCY_UNAVAILABLE,
  });
  assert.equal(append.mock.callCount(), 1);
  const [attempt] = append.mock.calls;
  assert.ok(attempt);
  const [event] = attempt.arguments;
  assert.equal(event?.kind, "authorization_denial");
  assert.equal(event?.requestId, body.meta.requestId);
  assert.deepEqual(dependencyWarnings(lines), []);
});

test("a dependency error whose fields cannot be read keeps its 503 and a bare warning", async (t) => {
  const error = new DependencyUnavailableError("unused");
  Object.defineProperty(error, "message", { value: 42 });
  error.cause = {
    get code() {
      throw new Error(CLIENT_TEXT);
    },
  };
  const { fixture, lines, namespace } = await configurationFixture(t, { createError: error });
  const response = await createConfiguration(fixture, namespace);
  const body = errorResponse(fixture, response);
  assert.deepEqual(body.error, {
    code: "DEPENDENCY_UNAVAILABLE",
    message: DEPENDENCY_UNAVAILABLE,
  });
  const warnings = dependencyWarnings(lines);
  assert.equal(warnings.length, 1, JSON.stringify(warnings));
  const [warning] = warnings;
  assert.ok(warning);
  assert.deepEqual(Object.keys(warning).sort(), [
    "event",
    "method",
    "requestId",
    "route",
    "service",
    "severity",
    "time",
  ]);
  assert.equal(JSON.stringify(lines).includes("clienttoken"), false);
});

test("an OpenShell call that fails without a gRPC status keeps only the error class", async (t) => {
  const client = new GrpcOpenShellGatewayClient({ endpoint: "127.0.0.1:1" });
  // A synchronous SDK failure occurs before a call can return any gRPC status.
  const createCall = t.mock.method(grpc.Channel.prototype, "createCall", () => {
    throw new TypeError(`invalid argument ${CLIENT_TEXT}`);
  });
  t.after(() => {
    createCall.mock.restore();
    return client.close();
  });
  await assert.rejects(
    client.getSandbox(
      { name: "sandbox-log", workspace: "workspace-log" },
      AbortSignal.timeout(2_000),
    ),
    (error) => {
      assert.ok(error instanceof DependencyUnavailableError);
      assert.equal(error.message, "OpenShell GetSandbox failed: TypeError");
      return true;
    },
  );
  assert.equal(createCall.mock.callCount(), 1);
  const [call] = createCall.mock.calls;
  assert.equal(call?.arguments[0], "/openshell.v1.OpenShell/GetSandbox");
});

test("dependency log fields keep only the class and code of a bounded cause chain", () => {
  const first = Object.assign(new Error(CLIENT_TEXT), { code: "not a code: Bearer x" });
  const second = Object.assign(new Error(CLIENT_TEXT), { name: "Bearer abc", code: 1.5 });
  first.cause = second;
  second.cause = first;
  const error = new DependencyUnavailableError("The selected secret Driver is unavailable.");
  error.cause = first;
  assert.deepEqual(dependencyUnavailableLogFields(error), {
    errorClass: "DependencyUnavailableError",
    message: "The selected secret Driver is unavailable.",
    causes: [{}, {}],
  });

  let chain = new Error("root");
  for (let depth = 0; depth < 6; depth += 1) {
    chain = Object.assign(new Error(`level ${depth}`), { code: `L${depth}`, cause: chain });
  }
  const deep = new DependencyUnavailableError("Deep outage.\nNext line\u0000.");
  deep.cause = chain;
  const fields = dependencyUnavailableLogFields(deep);
  assert.equal(fields.message, "Deep outage. Next line .");
  assert.ok(fields.causes);
  assert.deepEqual(
    fields.causes.map(({ code }) => code),
    ["L5", "L4", "L3", "L2"],
  );
  for (const message of [
    `Fetch ${syntheticCredentialUrl({ username: "user", password: "pass", host: "example.test", port: undefined, pathname: "/x" })} failed.`,
    "Fetch https://example.test/x?sig=abc failed.",
    // A credential that straddles the 512-character cut is still withheld.
    `${"a".repeat(500)} Bearer abcdefghijklmnopqrstuvwxyz`,
  ]) {
    const withheld = new DependencyUnavailableError(message);
    assert.equal(dependencyUnavailableLogFields(withheld).message, WITHHELD_ERROR_TEXT, message);
  }
  const long = dependencyUnavailableLogFields(new DependencyUnavailableError("b".repeat(600)));
  assert.equal(long.message, "b".repeat(512));
  // A class name or code that resembles a credential is dropped, never logged.
  const credentialLike = new DependencyUnavailableError("Outage.");
  credentialLike.cause = Object.assign(new Error("x"), {
    name: "AKIA0123456789ABCDEF",
    code: "AKIA0123456789ABCDEF",
  });
  assert.deepEqual(dependencyUnavailableLogFields(credentialLike).causes, [{}]);
});

// Fake values, assembled so no complete token shape appears in the source.
const FAKE = "Abcdefghij0123456789Abcdefghij012345";
const POSTGRES_URL = syntheticCredentialUrl({
  protocol: "postgres",
  username: "fake-user",
  password: "fake-pass",
  host: "db.example.test",
  port: undefined,
  pathname: "/occ",
});
const POSTGRES_USER_ONLY = new URL("postgres://db.example.test/occ");
POSTGRES_USER_ONLY.username = "fake-user";
const CREDENTIAL_MESSAGES = [
  `Upstream sent ${["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiJmYWtlIn0", "c2lnbmF0dXJl"].join(".")}.`,
  `Header Authorization: Basic ${Buffer.from("fake-user:fake-pass").toString("base64")}`,
  "Header authorization: basic ZmFrZTpmYWtl",
  ...["ghs", "ghu", "ghr", "ghp", "gho"].map((prefix) => `Clone with ${prefix}_${FAKE} failed.`),
  `Slack answered for ${["xoxb", "1234567890", "fakefakefake"].join("-")}.`,
  ...["client_secret", "refresh_token", "id_token", "code", "apikey", "X-Amz-Signature"].map(
    (name) => `Fetch https://idp.example.test/token?a=1&${name}=fake-value failed.`,
  ),
  `Connect ${syntheticCredentialUrl({ protocol: "postgres", username: "fake-user", password: "pa/ss", host: "db.example.test", port: 5432, pathname: "/occ" })} failed.`,
  `Connect ${POSTGRES_USER_ONLY} failed.`,
  "Connect host=db.example.test user=occ password=fake-pass failed.",
  "Connect Server=db.example.test;Uid=occ;Pwd=fake-pass; failed.",
  "Token exchange body grant_type=refresh_token&refresh_token=fake-value was refused.",
];
// Representative renderings of the interpolating construction sites found by the audit of
// DependencyUnavailableError and its subclasses, plus prose that names credentials.
const BENIGN_MESSAGES = [
  "ChatGPT Admin API POST request was unavailable.",
  "ChatGPT Admin API DELETE request failed with HTTP 503.",
  "The Kubernetes Secret create failed.",
  "The Kubernetes Secret replace outcome is unknown after timeout.",
  "The Kubernetes Secret delete was cancelled.",
  "The Kubernetes ConfigMap create outcome is unknown after timeout.",
  "The exact AgentRevision gateway could not apply its workspace node (WORKSPACE_NODE_FAILED).",
  "OpenShell accepted deletion of Sandbox sbx-0123abcd but did not finish it within 30 s.",
  "OpenShell CreateSandbox failed with gRPC status 14: connection refused",
  "OpenShell GetSandbox failed: TypeError",
  "The selected secret Driver is unavailable.",
  "Persisted saved configuration is invalid.",
  "Persisted AgentRevision plugin state is invalid.",
  "The Agent runtime credential Kubernetes namespace is unavailable.",
  "Basic authentication with the registry failed.",
  "Uses basic OpenShell sandboxing.",
  "Basic ServiceAccount token projection failed.",
  "The ServiceAccount credential Secret create outcome is unknown, and its cleanup could not finish.",
  "Fetch https://registry.example.test/v2/token?scope=pull failed.",
  "Cluster https://kubernetes.default.svc:443/api answered 503.",
];

test("dependency log fields withhold common token, URL and connection-string credentials", () => {
  for (const message of CREDENTIAL_MESSAGES) {
    const fields = dependencyUnavailableLogFields(new DependencyUnavailableError(message));
    assert.equal(fields.message, WITHHELD_ERROR_TEXT, message);
  }
  for (const message of BENIGN_MESSAGES) {
    const fields = dependencyUnavailableLogFields(new DependencyUnavailableError(message));
    assert.equal(fields.message, message);
  }
  // A cause code shaped like a token is dropped; an ordinary code is kept.
  const error = new DependencyUnavailableError("Outage.");
  error.cause = Object.assign(new Error("x"), {
    code: `ghs_${FAKE}`,
    cause: Object.assign(new Error("y"), {
      code: ["xoxb", "1234567890", "fakefakefake"].join("-"),
      cause: Object.assign(new Error("z"), { code: "ECONNRESET" }),
    }),
  });
  assert.deepEqual(dependencyUnavailableLogFields(error).causes, [{}, {}, { code: "ECONNRESET" }]);
});

test("dependency log fields check a bounded prefix of a long message", () => {
  // Inputs that made the URL pattern scan quadratically before the check was bounded.
  for (const message of [
    "a.".repeat(500_000),
    "a://b:".repeat(200_000),
    `${"x".repeat(1_000_000)} Bearer abcdefghijklmnopqrstuvwxyz`,
  ]) {
    const started = performance.now();
    const fields = dependencyUnavailableLogFields(new DependencyUnavailableError(message));
    const elapsedMs = performance.now() - started;
    assert.ok(elapsedMs < 1_000, `${message.slice(0, 12)}: ${elapsedMs} ms`);
    assert.equal(fields.message, message.slice(0, 512));
  }
  // A credential that starts before the cut and runs far past it is still withheld.
  const straddling = `${"c".repeat(500)} Bearer ${"t".repeat(5_000)}`;
  assert.equal(
    dependencyUnavailableLogFields(new DependencyUnavailableError(straddling)).message,
    WITHHELD_ERROR_TEXT,
  );
  // Padding collapses before the bound, so it cannot push a credential's end past the check.
  const padded = `x${" ".repeat(2_025)}${POSTGRES_URL}`;
  assert.equal(
    dependencyUnavailableLogFields(new DependencyUnavailableError(padded)).message,
    WITHHELD_ERROR_TEXT,
  );
});
