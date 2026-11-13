import assert from "node:assert/strict";
import test from "node:test";

import { createOccLogger } from "../../apps/controller/src/logging.ts";
import { InMemoryAuditSink, type AuditEvent } from "../../packages/audit/src/index.ts";
import { ErrorResponse } from "../../packages/contracts/src/api/common.ts";
import {
  CredentialSourceListResponse,
  SecretListResponse,
} from "../../packages/contracts/src/api/resources.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { DEVICE_ACCESS_TOKEN } from "../helpers/device-credential-gateway.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { jsonLineDestination } from "../helpers/json-lines.mjs";
import { createDenied, DEVICE_LOGIN_NOT_CONFIGURED } from "../helpers/refusal-text.mjs";
import {
  assertNoCredentials,
  createFixture,
  deviceTestSandbox,
} from "./device-authorization-api-fixture.ts";

export function registerDeviceAuthorizationRefusalCases() {
  test("a failed Refresh login start retains a manageable source and sanitizes the failure", async (t) => {
    const lines: unknown[] = [];
    const logger = createOccLogger({
      component: "occ-api",
      level: "info",
      destination: jsonLineDestination(lines),
    });
    const fixture = await createFixture(t, {
      logger,
      startError: new Error(`external service unavailable: ${DEVICE_ACCESS_TOKEN}`),
    });
    const response = await fixture.request("POST", fixture.path, { body: { harnessId: "codex" } });
    const { error, meta } = fixture.fixtureResponse(
      response,
      503,
      ErrorResponse,
      "start with Refresh failure",
    );
    assert.equal(error.code, "DEPENDENCY_UNAVAILABLE");
    const warning = lines
      .map(asRecord)
      .find((line) => line?.event === "device_authorization.start_failed");
    assert.ok(warning, "a failed Refresh start must emit a warning");
    assert.equal(warning.severity, "WARN");
    assert.equal(warning.reason, "unavailable");
    assert.equal(warning.failure, "unclassified");
    assert.equal(warning.boundary, "credential_refresh");
    assert.equal(error.message, "Device login could not start. Try again.");
    assert.equal(JSON.stringify(lines).includes(DEVICE_ACCESS_TOKEN), false);
    const secrets = await fixture.request("GET", `/namespaces/${fixture.namespace.id}/secrets`);
    assert.deepEqual(
      fixture.fixtureResponse(
        secrets,
        200,
        SecretListResponse,
        "list Secrets after Refresh failure",
      ).data,
      [],
    );
    const sourceList = await fixture.request("GET", fixture.sourcesPath);
    const { data: sources } = fixture.fixtureResponse(
      sourceList,
      200,
      CredentialSourceListResponse,
      "list sources after Refresh failure",
    );
    assert.equal(
      sources.length,
      1,
      "an uncertain external login remains visible for source management",
    );
    const [source] = sources;
    assert.ok(source);
    const evidence = fixture.auditSink.events.filter(
      (event) => event.action === "openclaw.agents.device_authorization.start",
    );
    assert.deepEqual(
      evidence.map((event) => event.details?.phase),
      ["source_registering", "source_ready"],
    );
    for (const event of evidence) {
      assert.equal(event.actorId, fixture.principal.id);
      assert.equal(event.requestId, meta.requestId);
      assert.deepEqual(event.resource, {
        kind: "credential_source",
        id: source.id,
        namespaceId: fixture.namespace.id,
      });
    }
    // Source deletion fences uncertain external registration before final removal.
    await fixture.clock.advance(71_000);
    assert.equal(
      (await fixture.request("DELETE", `${fixture.sourcesPath}/${source.id}`)).status,
      204,
    );
    assert.equal(fixture.gateway.sources.size, 0);
    assertNoCredentials(fixture);
  });

  for (const { phase, retainedSources, eventCount } of [
    { phase: "source_registering", retainedSources: 0, eventCount: 0 },
    { phase: "source_ready", retainedSources: 1, eventCount: 1 },
    { phase: "session_pending", retainedSources: 1, eventCount: 2 },
  ]) {
    test(`device start fails closed when ${phase} audit cannot commit`, async (t) => {
      class FailingAuditSink extends InMemoryAuditSink {
        override async append(event: AuditEvent) {
          if (
            event.action === "openclaw.agents.device_authorization.start" &&
            (event.details?.phase === phase || event.details?.phase === undefined)
          ) {
            throw new Error("Synthetic audit storage failure");
          }
          await super.append(event);
        }
      }
      const fixture = await createFixture(t, { auditSink: new FailingAuditSink() });
      const response = await fixture.request("POST", fixture.path, {
        body: { harnessId: "codex" },
      });
      const { error, meta } = fixture.fixtureResponse(
        response,
        503,
        ErrorResponse,
        "start with audit failure",
      );
      assert.equal(error.code, "DEPENDENCY_UNAVAILABLE");
      const sourceList = await fixture.request("GET", fixture.sourcesPath);
      const { data: sources } = fixture.fixtureResponse(
        sourceList,
        200,
        CredentialSourceListResponse,
        "list sources after audit failure",
      );
      const secretList = await fixture.request(
        "GET",
        `/namespaces/${fixture.namespace.id}/secrets`,
      );
      const { data: secrets } = fixture.fixtureResponse(
        secretList,
        200,
        SecretListResponse,
        "list Secrets after audit failure",
      );
      assert.deepEqual(secrets, [], "a rejected start cannot leave a login Secret");
      assert.equal(sources.length, retainedSources);
      const evidence = fixture.auditSink.events.filter(
        (event) => event.action === "openclaw.agents.device_authorization.start",
      );
      assert.equal(evidence.length, eventCount);
      for (const event of evidence) {
        const [source] = sources;
        assert.ok(source, "committed start audit must identify a retained source");
        assert.equal(event.actorId, fixture.principal.id);
        assert.equal(event.requestId, meta.requestId);
        assert.equal(event.resource.id, source.id);
      }
      const loginCreates = fixture.secretDriver.calls.filter((call) => call.operation === "create");
      if (phase === "session_pending") {
        // The private Driver value must be compensated as well as its OCC metadata.
        assert.equal(loginCreates.length, 1);
        const [created] = loginCreates;
        assert.ok(created);
        assert.equal(fixture.secretDriver.has(created.identity), false);
      } else {
        assert.equal(loginCreates.length, 0);
        assert.equal(
          fixture.gateway.calls.some((call) => call.operation === "startDeviceAuthorization"),
          false,
        );
      }
      if (phase === "source_registering") {
        assert.equal(
          fixture.gateway.sources.size,
          0,
          "audit failure precedes Gateway registration",
        );
      }
      assertNoCredentials(fixture);
    });
  }

  // Finding D762: an Installation that does not select both Drivers device login needs names them
  // and who selects them, after the caller's grants and before any Gateway I/O.
  test("device login without a Credential Gateway and Refresh Driver names them and who selects them", async (t) => {
    const fixture = await createConsoleAppFixture(t);
    await fixture.bootstrap();
    const namespace = await fixture.createNamespace("No device login", { ready: true });
    const refused = await fixture.request(
      "POST",
      `/namespaces/${namespace.id}/agents/device-authorizations`,
      { body: { harnessId: "codex" } },
    );
    const { error } = fixture.fixtureResponse(refused, 501, ErrorResponse, "start without Drivers");
    assert.deepEqual(error, {
      code: "NOT_IMPLEMENTED",
      message: DEVICE_LOGIN_NOT_CONFIGURED,
    });
  });

  // Finding 2995: the start checks every grant it needs before the Driver selection. A Namespace
  // member who may create Agents and Secrets, and read and update an Agent, still lacks credential
  // source create, which no Namespace Role can grant, so they can never start. They get the 403
  // naming that grant on Create Agent and on a saved Agent, whether or not the Installation selects
  // the Drivers, with one audited denial. The administrator, who holds every grant, still gets the
  // Driver-selection 501 (the test above).
  test("a member who can never start device login gets the grant refusal before the Driver check", async (t) => {
    const bare = await createConsoleAppFixture(t, { sandboxDriver: deviceTestSandbox() });
    await bare.bootstrap();
    const bareNamespace = await bare.createNamespace("No device login drivers", { ready: true });
    const selected = await createFixture(t);
    for (const { fixture, namespace } of [
      { fixture: bare, namespace: bareNamespace },
      { fixture: selected, namespace: selected.namespace },
    ]) {
      // A dedicated Agent, the only kind a saved-Agent start accepts before the grants decide.
      const agent = await fixture.createAgent(
        namespace.id,
        "Member device login",
        createHarnessConfiguration("codex", "gpt-5.1"),
        { executionMode: "dedicated", harnessAuth: null },
      );
      const member = await fixture.createNamespaceMember("device-login-member", namespace.id, [
        ["read", "namespace"],
        ["create", "agent"],
        ["read", "agent"],
        ["update", "agent"],
        ["create", "secret"],
      ]);
      const session = await fixture.signIn(member.credentials);
      for (const path of [
        `/namespaces/${namespace.id}/agents/device-authorizations`,
        `/namespaces/${namespace.id}/agents/${agent.id}/device-authorizations`,
      ]) {
        const before = fixture.auditSink.events.length;
        const refused = await fixture.request("POST", path, {
          session,
          body: { harnessId: "codex" },
        });
        const { error } = fixture.fixtureResponse(
          refused,
          403,
          ErrorResponse,
          "start without source grant",
        );
        assert.equal(error.code, "FORBIDDEN");
        assert.equal(error.message, createDenied("CredentialSource", namespace.id));
        // The refused start is the only audited event: one denial naming the grant.
        const events = fixture.auditSink.events.slice(before);
        assert.equal(events.length, 1, JSON.stringify(events));
        const [denial] = events;
        assert.ok(denial);
        assert.equal(denial.action, "openclaw.agents.device_authorization.start");
        assert.equal(denial.outcome, "denied");
        assert.deepEqual(denial.authorization, {
          principalId: member.principal.id,
          action: "create",
          resource: { kind: "credential_source", id: namespace.id, namespaceId: namespace.id },
        });
      }
      // A refused start registers no source and saves no login Secret.
      const sourceList = await fixture.request(
        "GET",
        `/namespaces/${namespace.id}/credential-sources`,
      );
      const { data: sources } = fixture.fixtureResponse(
        sourceList,
        200,
        CredentialSourceListResponse,
        "list sources after grant refusal",
      );
      assert.deepEqual(sources, []);
      const secretList = await fixture.request("GET", `/namespaces/${namespace.id}/secrets`);
      const { data: secrets } = fixture.fixtureResponse(
        secretList,
        200,
        SecretListResponse,
        "list Secrets after grant refusal",
      );
      assert.deepEqual(secrets, []);
    }
  });
}
