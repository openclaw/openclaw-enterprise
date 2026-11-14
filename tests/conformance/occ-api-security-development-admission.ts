import assert from "node:assert/strict";
import test from "node:test";
import { tenantRequest as request } from "../helpers/tenant-reader-app.ts";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import { authenticatedHeaders } from "../helpers/auth-session.mjs";
import {
  bootstrap,
  createFixture,
  createNamespace,
  responseError,
} from "./occ-api-security-fixture.ts";

export function registerDevelopmentAdmissionCases() {
  test("development admission fails closed outside explicit loopback-only development", async () => {
    await assert.rejects(
      createFixture({ development: { trustedCidrs: ["not-a-cidr"] } }),
      /IPv4 CIDR/,
    );
    // "08" is prefix 8, and "010" is decimal 10. Production trusted proxies refuse both.
    for (const cidr of ["192.168.0.0/08", "10.0.0.010/32", "10.0.0.0/032"]) {
      await assert.rejects(
        createFixture({ development: { trustedCidrs: [cidr] } }),
        /IPv4 CIDR/,
        cidr,
      );
    }
    for (const browserOrigin of [
      "https://public.example.com",
      "ftp://127.0.0.1:3000",
      "http://x.localhost",
      "https://.localhost",
      "http://localhost:3000/auth",
    ]) {
      await assert.rejects(
        createFixture({ development: { browserOrigin } }),
        /HTTPS localhost subdomain/,
      );
    }
    // Outside development even a valid loopback origin is refused, not admitted.
    await assert.rejects(
      createFixture({ development: { enabled: false, browserOrigin: "http://127.0.0.1:3000" } }),
      /HTTPS localhost subdomain/,
    );

    const fixture = await createFixture();
    const remote = await request(fixture.app, "/installation/bootstrap", {
      origin: "http://public.example.com",
      body: { name: "Must not bootstrap remotely" },
    });
    assert.equal(remote.response.status, 403);
    assert.equal(fixture.controller, undefined);

    const remoteOrigin = await request(fixture.app, "/installation/bootstrap", {
      headers: { origin: "http://public.example.com" },
      body: { name: "Must not bootstrap from a remote browser origin" },
    });
    assert.equal(remoteOrigin.response.status, 403);
    assert.equal(fixture.controller, undefined);

    const forwardedHeaders: ReadonlyArray<Record<string, string>> = [
      { forwarded: "for=203.0.113.2" },
      { "x-forwarded-for": "203.0.113.2" },
      { "x-forwarded-host": "public.example.com" },
      { "x-forwarded-proto": "https" },
      { "x-forwarded-port": "443" },
      { "x-real-ip": "203.0.113.2" },
    ];
    for (const forwarded of forwardedHeaders) {
      const response = await request(fixture.app, "/installation/bootstrap", {
        headers: forwarded,
        body: { name: "Must not trust forwarded requests" },
      });
      assert.equal(response.response.status, 403);
      assert.equal(fixture.controller, undefined);
    }
  });

  test("a trusted development CIDR admits its own range and nothing else", async (t) => {
    const development = { trustedCidrs: ["10.89.0.0/16"] };
    const fixture = await createFixture({ development });
    await bootstrap(fixture);
    // app.fetch always injects from 127.0.0.1; Fastify inject can name the peer address.
    const app = fixture.createApp(fixture.administrator, { development }, createFastifyApp);
    t.after(() => app.close());
    const list = (remoteAddress: string) =>
      app.inject({
        url: "/namespaces",
        remoteAddress,
        headers: {
          host: new URL(fixture.app.defaultSession.origin).host,
          ...authenticatedHeaders(fixture.app.defaultSession),
        },
      });
    for (const admitted of ["127.0.0.1", "10.89.0.1", "10.89.255.254", "::ffff:10.89.3.4"]) {
      assert.equal((await list(admitted)).statusCode, 200, admitted);
    }
    for (const refused of [
      "10.90.0.1",
      "10.88.255.255",
      "192.0.2.10",
      "fd00::1",
      "::ffff:10.90.0.1",
    ]) {
      const response = await list(refused);
      assert.equal(response.statusCode, 403, refused);
      assert.match(
        responseError(response.json<unknown>()).message,
        /restricted to direct loopback requests/,
        refused,
      );
    }
  });

  test("an exact development browser origin admits only its trusted proxy", async (t) => {
    const browserOrigin = "https://console.occ-dev-example.oce.localhost:8443";
    const development = {
      browserOrigin,
      trustedCidrs: ["10.89.0.0/16"],
    };
    const fixture = await createFixture();
    await bootstrap(fixture);
    const app = fixture.createApp(fixture.administrator, { development }, createFastifyApp);
    t.after(() => app.close());
    const list = ({
      host,
      origin,
      remoteAddress,
    }: {
      host: string;
      origin?: string;
      remoteAddress: string;
    }) => {
      const { cookie } = authenticatedHeaders(fixture.app.defaultSession);
      return app.inject({
        url: "/namespaces",
        remoteAddress,
        headers: {
          cookie,
          host,
          ...(origin === undefined ? {} : { origin }),
        },
      });
    };

    for (const headers of [
      { host: new URL(browserOrigin).host, remoteAddress: "10.89.3.4" },
      {
        host: new URL(browserOrigin).host,
        origin: browserOrigin,
        remoteAddress: "10.89.3.4",
      },
    ]) {
      const response = await list(headers);
      assert.equal(response.statusCode, 200, response.body);
    }

    for (const headers of [
      {
        host: "other.occ-dev-example.oce.localhost:8443",
        origin: browserOrigin,
        remoteAddress: "10.89.3.4",
      },
      {
        host: new URL(browserOrigin).host,
        origin: "https://other.occ-dev-example.oce.localhost:8443",
        remoteAddress: "10.89.3.4",
      },
      {
        host: new URL(browserOrigin).host,
        origin: browserOrigin,
        remoteAddress: "10.90.3.4",
      },
    ]) {
      const response = await list(headers);
      assert.equal(response.statusCode, 403);
      assert.match(
        responseError(response.json<unknown>()).message,
        /restricted to direct loopback requests/,
      );
    }
  });

  test("spoofed bearer evidence is denied without audit writes and admitted unknown identities are audited", async () => {
    const fixture = await createFixture();
    await bootstrap(fixture);
    const controller = fixture.controller;
    assert.ok(controller);
    const expectedOperations = controller.pendingOperations().length;
    const expectedAuditEvents = fixture.auditSink.events.length;

    const spoofedHeaders: ReadonlyArray<Record<string, string>> = [
      {},
      {
        "x-openclaw-principal": fixture.administrator.id,
        "x-openclaw-issuer": fixture.administrator.issuer,
        "x-openclaw-subject": fixture.administrator.subject,
      },
    ];
    for (const headers of spoofedHeaders) {
      const denied = await request(fixture.app, "/namespaces", {
        identity: false,
        headers,
        body: { name: "Unauthorized namespace" },
      });
      assert.equal(denied.response.status, 401);
      assert.equal(controller.pendingOperations().length, expectedOperations);
      assert.equal(fixture.auditSink.events.length, expectedAuditEvents);
    }

    for (const headers of [
      { authorization: "Bearer impostor" },
      { authorization: "Basic impostor" },
      { authorization: "Bearer token-a, Bearer impostor" },
      { authorization: "Bearer" },
      { authorization: "not-a-session-cookie" },
    ]) {
      const denied = await request(fixture.app, "/namespaces", {
        headers,
        body: { name: "Unauthorized namespace" },
      });
      assert.equal(denied.response.status, 401);
      assert.equal(controller.pendingOperations().length, expectedOperations);
      assert.equal(fixture.auditSink.events.length, expectedAuditEvents);
    }

    const unprovisioned = await createFixture({ identities: [] });
    const unknown = await request(unprovisioned.app, "/installation/bootstrap", {
      body: { name: "Unknown principal" },
    });
    assert.equal(unknown.response.status, 403);
    assert.equal(unprovisioned.controller, undefined);
    assert.equal(unprovisioned.auditSink.events[0]?.kind, "authorization_denial");
  });

  test("an unknown caller cannot enumerate an empty or populated Namespace collection", async () => {
    const fixture = await createFixture();
    await bootstrap(fixture);

    const unknownHeaders = { authorization: "Bearer not-the-configured-token" };
    const initialAuditEvents = fixture.auditSink.events.length;
    const empty = await request(fixture.app, "/namespaces", {
      headers: unknownHeaders,
    });
    assert.equal(empty.response.status, 401);
    assert.equal(empty.payload.data, undefined);
    assert.equal(fixture.auditSink.events.length, initialAuditEvents);

    const namespace = await createNamespace(fixture, "Existing tenant");
    const expectedAuditEvents = fixture.auditSink.events.length;
    const populated = await request(fixture.app, "/namespaces", {
      headers: unknownHeaders,
    });
    assert.equal(populated.response.status, 401);
    assert.equal(populated.payload.data, undefined);
    assert.doesNotMatch(JSON.stringify(populated.payload), new RegExp(namespace.id));
    assert.equal(fixture.auditSink.events.length, expectedAuditEvents);
  });
}
