import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { ConfigurationBackendUnavailableError } from "../../apps/controller/src/drivers/configuration/kubernetes/index.ts";
import { createOccLogger, WITHHELD_ERROR_TEXT } from "../../apps/controller/src/logging.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { ErrorResponse } from "../../packages/contracts/src/api/common.ts";
import type { NamespaceWire } from "../../packages/contracts/src/api/resources.ts";
import {
  DependencyUnavailableError,
  RuntimeCredentialsForbiddenByClusterError,
} from "../../packages/occ/src/index.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.ts";
import { createReadyComputeDriver } from "../helpers/development.ts";
import { jsonLineDestination, requireLogRecord } from "../helpers/json-lines.ts";
import { DEPENDENCY_UNAVAILABLE } from "../helpers/refusal-text.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";

type Fixture = Awaited<ReturnType<typeof createConsoleAppFixture>>;
type HttpResponse = { status: number; body: unknown };

const SECRET_VALUE = "sk-proj-dependencylogvalue0123456789";

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
  createError?: unknown,
  options: Parameters<typeof createConsoleAppFixture>[1] = {},
) {
  const { lines, logger } = capturedLogger();
  const configurationDriver = createTestConfigurationDriver({ id: "console-configuration" });
  const fixture = await createConsoleAppFixture(t, {
    ...options,
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
  return lines.map(requireLogRecord).filter((line) => line.event === event);
}

function dependencyWarnings(lines: readonly unknown[]) {
  return logEvents(lines, "http.dependency_unavailable");
}

function errorResponse(fixture: Fixture, response: HttpResponse) {
  return fixture.fixtureResponse(response, 503, ErrorResponse, "Dependency response");
}

export function registerDependencyUnavailableHttpCases(clientText: string) {
  test("a 503 DEPENDENCY_UNAVAILABLE keeps its generic body and logs its cause by request ID", async (t) => {
    const error = new ConfigurationBackendUnavailableError(
      "The Kubernetes ConfigMap create outcome is unknown after timeout.",
    );
    error.cause = Object.assign(new Error(clientText), {
      name: "ApiException",
      code: 500,
      body: clientText,
      cause: Object.assign(new Error(`socket ${clientText}`), { code: "ECONNRESET" }),
    });
    const { fixture, lines, namespace } = await configurationFixture(t, error);
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
    const { fixture, lines, namespace } = await configurationFixture(
      t,
      new DependencyUnavailableError(`Upstream answered with ${SECRET_VALUE}.`),
    );
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
    const { fixture, lines, namespace } = await configurationFixture(t, undefined, { auditSink });
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
        throw new Error(clientText);
      },
    };
    const { fixture, lines, namespace } = await configurationFixture(t, error);
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
}
