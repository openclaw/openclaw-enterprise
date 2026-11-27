import assert from "node:assert/strict";
import test from "node:test";
import { createOccLogger } from "../../apps/controller/src/logging.ts";
import { InMemoryAuditSink, type AuditEvent } from "../../packages/audit/src/index.ts";
import { ErrorResponse } from "../../packages/contracts/src/api/common.ts";
import { CredentialSourceListResponse } from "../../packages/contracts/src/api/resources.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { jsonLineDestination } from "../helpers/json-lines.ts";
import {
  assertNoCredentials,
  createFixture,
  deviceTestSandbox,
} from "./device-authorization-api-fixture.ts";

export function registerDeviceAuthorizationRefusalCases(): void {
  test("an issuer start failure sanitizes diagnostics and creates neither a Source nor a login", async (t) => {
    const lines: unknown[] = [];
    const privateDetail = crypto.randomUUID();
    const fixture = await createFixture(t, {
      logger: createOccLogger({
        component: "occ-api",
        level: "info",
        destination: jsonLineDestination(lines),
      }),
      startError: new Error(privateDetail),
    });
    const reply = await fixture.request("POST", fixture.path, {
      body: { harnessId: "codex" },
    });
    assert.equal(
      fixture.fixtureResponse(reply, 503, ErrorResponse, "issuer failure").error.code,
      "DEPENDENCY_UNAVAILABLE",
    );
    assert.equal(JSON.stringify([lines, reply.body]).includes(privateDetail), false);
    assert.deepEqual(
      fixture.fixtureResponse(
        await fixture.request("GET", fixture.sourcesPath),
        200,
        CredentialSourceListResponse,
        "list Sources after failed start",
      ).data,
      [],
    );
    assertNoCredentials(fixture);
  });

  test("an uncertain issuer exchange cancels the login without creating a Source or replaying the code", async (t) => {
    const lines: unknown[] = [];
    const fixture = await createFixture(t, {
      logger: createOccLogger({
        component: "occ-api",
        level: "info",
        destination: jsonLineDestination(lines),
      }),
    });
    const issuerFetch = globalThis.fetch;
    const privateDetail = "synthetic lost exchange response";
    let exchanges = 0;
    t.mock.method(
      globalThis,
      "fetch",
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url === "https://auth.openai.com/oauth/token") {
          exchanges += 1;
          throw new TypeError(privateDetail);
        }
        return issuerFetch(input, init);
      },
    );
    const login = await fixture.start();
    await fixture.clock.advance(5000);
    const failed = await fixture.poll(login);
    assert.equal(failed.status, 503);
    assert.equal(JSON.stringify([lines, failed.body]).includes(privateDetail), false);
    const stored = await fixture.stored(login);
    assert.equal(stored.phase, "cancelled");
    assert.equal(stored.privateState, undefined);
    assert.equal((await fixture.poll(login)).status, 409);
    assert.equal(exchanges, 1, "an issuer may have consumed the code before losing its response");
    assert.deepEqual(
      fixture.fixtureResponse(
        await fixture.request("GET", fixture.sourcesPath),
        200,
        CredentialSourceListResponse,
        "list Sources after uncertain exchange",
      ).data,
      [],
    );
    assertNoCredentials(fixture);
  });

  test("device start fails closed when its session audit cannot commit", async (t) => {
    class FailingAuditSink extends InMemoryAuditSink {
      override async append(event: AuditEvent) {
        if (event.action === "openclaw.agents.device_authorization.start") {
          throw new Error("audit unavailable");
        }
        await super.append(event);
      }
    }
    const fixture = await createFixture(t, {
      auditSink: new FailingAuditSink(),
    });
    const reply = await fixture.request("POST", fixture.path, {
      body: { harnessId: "codex" },
    });
    assert.equal(reply.status, 503);
    assert.deepEqual(
      fixture.fixtureResponse(
        await fixture.request("GET", fixture.sourcesPath),
        200,
        CredentialSourceListResponse,
        "list Sources after audit failure",
      ).data,
      [],
    );
  });

  test("a Source completion audit failure cannot report a successful device login", async (t) => {
    class FailingAuditSink extends InMemoryAuditSink {
      override async append(event: AuditEvent) {
        if (
          event.action === "openclaw.agents.device_authorization.poll" &&
          event.resource.kind === "credential_source"
        ) {
          throw new Error("audit unavailable");
        }
        await super.append(event);
      }
    }
    const fixture = await createFixture(t, { auditSink: new FailingAuditSink() });
    const login = await fixture.start();
    await fixture.clock.advance(5000);
    assert.equal((await fixture.poll(login)).status, 503);
    assert.equal((await fixture.stored(login)).phase, "cancelled");
    const sources = await fixture.controller.transact((unit) =>
      unit.credentialSources.listCredentialSources(fixture.namespace.id),
    );
    assert.equal(
      sources.length,
      1,
      "the issuer grant was committed before audit settlement failed",
    );
    assertNoCredentials(fixture);
  });

  test("a caller missing Source creation receives the exact IAM refusal before CredentialService selection", async (t) => {
    const bare = await createConsoleAppFixture(t, {
      sandboxDriver: deviceTestSandbox(),
    });
    await bare.bootstrap();
    const bareNamespace = await bare.createNamespace("No selected CredentialService", {
      ready: true,
    });
    const selected = await createFixture(t);
    for (const { fixture, namespace } of [
      { fixture: bare, namespace: bareNamespace },
      { fixture: selected, namespace: selected.namespace },
    ]) {
      const agent = await fixture.createAgent(
        namespace.id,
        "Member device login",
        createHarnessConfiguration("codex", "gpt-5.1"),
        { executionMode: "dedicated", harnessAuth: null },
      );
      const member = await fixture.createNamespaceMember("device-member", namespace.id, [
        ["read", "namespace"],
        ["create", "agent"],
        ["read", "agent"],
        ["update", "agent"],
      ]);
      const session = await fixture.signIn(member.credentials);
      for (const path of [
        `/namespaces/${namespace.id}/agents/device-authorizations`,
        `/namespaces/${namespace.id}/agents/${agent.id}/device-authorizations`,
      ]) {
        const before = fixture.auditSink.events.length;
        const reply = await fixture.request("POST", path, {
          session,
          body: { harnessId: "codex" },
        });
        assert.equal(reply.status, 403);
        const events = fixture.auditSink.events.slice(before);
        assert.equal(events.length, 1);
        assert.deepEqual(events[0]?.authorization, {
          principalId: member.principal.id,
          action: "create",
          resource: {
            kind: "credential_source",
            id: namespace.id,
            namespaceId: namespace.id,
          },
        });
      }
    }
  });
}
