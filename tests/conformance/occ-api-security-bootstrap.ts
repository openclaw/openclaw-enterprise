/// <reference lib="es2024.promise" />
import assert from "node:assert/strict";
import test from "node:test";
import { tenantRequest as request } from "../helpers/tenant-reader-app.ts";
import { InstallationSchema, NamespaceSchema } from "../../packages/contracts/src/api/resources.ts";
import type { Restriction } from "../../packages/contracts/src/index.ts";
import { authenticatedHeaders } from "../helpers/auth-session.mjs";
import {
  bootstrap,
  bootstrappedDefaultNamespace,
  bootstrapDefaultNamespaceId,
  createAgent,
  createFixture,
  installationId,
  responseData,
  responseError,
  restrictionIds,
} from "./occ-api-security-fixture.ts";

export function registerBootstrapCases() {
  test("bootstrap owns one Installation without a plural installation collection", async () => {
    const fixture = await createFixture();
    const installation = await bootstrap(fixture);
    assert.equal(installation.name, "Security test installation");
    const defaultNamespace = await bootstrappedDefaultNamespace(fixture);

    const read = await request(fixture.app, "/installation");
    assert.equal(read.response.status, 200);
    // No Sandbox Driver is selected: Embedded OpenClaw is the one mode admission accepts (#2670).
    assert.deepEqual(read.payload.data, {
      ...installation,
      capabilities: { openclaw: { executionModes: ["embedded"] } },
    });

    const again = await request(fixture.app, "/installation/bootstrap", {
      body: { name: "Second installation" },
    });
    assert.equal(again.response.status, 409);

    for (const options of [{}, { body: { name: "Tenant installation" } }]) {
      const result = await request(fixture.app, "/installations", options);
      assert.equal(result.response.status, 404);
    }

    const bootstrapEvents = fixture.auditSink.events.filter(
      (event) => event.kind === "bootstrap" && event.resource.kind === "installation",
    );
    assert.equal(bootstrapEvents.length, 1);
    assert.equal(bootstrapEvents[0]?.actorId, fixture.administrator.id);
    assert.equal(bootstrapEvents[0]?.resource.id, installationId);

    assert.ok(fixture.controller);
    await fixture.controller.handleNamespaceLifecycle(
      fixture.administrator.id,
      defaultNamespace.id,
      "ready",
    );
    const readyDefault = await request(fixture.app, `/namespaces/${defaultNamespace.id}`);
    assert.equal(readyDefault.response.status, 200);
    const readyNamespace = responseData(NamespaceSchema, readyDefault.payload);
    assert.equal(readyNamespace.status, "ready");
    const defaultAgent = await createAgent(fixture, readyNamespace, "Default Agent");
    assert.equal(defaultAgent.namespaceId, defaultNamespace.id);
  });

  test("bootstrap fails closed when default Namespace creation is denied and later retries cleanly", async () => {
    const restrictions: Restriction[] = [
      {
        id: "restriction-no-bootstrap-namespace",
        action: "create",
        resourceKind: "namespace",
        effect: "deny",
      },
    ];
    const fixture = await createFixture({ restrictions });

    const denied = await request(fixture.app, "/installation/bootstrap", {
      body: { name: "Blocked default Namespace" },
    });
    assert.equal(denied.response.status, 403);
    assert.equal(responseError(denied.payload).code, "FORBIDDEN");

    const deniedEvent = fixture.auditSink.events.at(-1);
    assert.equal(deniedEvent?.kind, "authorization_denial");
    assert.equal(deniedEvent?.authorization?.action, "create");
    assert.deepEqual(deniedEvent?.authorization?.resource, {
      kind: "namespace",
      id: installationId,
    });
    assert.deepEqual(restrictionIds(deniedEvent), ["restriction-no-bootstrap-namespace"]);

    const absentInstallation = await request(fixture.app, "/installation");
    assert.equal(absentInstallation.response.status, 404);
    const absentNamespaces = await request(fixture.app, "/namespaces");
    assert.equal(absentNamespaces.response.status, 404);

    restrictions.length = 0;
    const recovered = await request(fixture.app, "/installation/bootstrap", {
      body: { name: "Recovered default Namespace" },
    });
    assert.equal(recovered.response.status, 201);
    assert.equal(
      responseData(InstallationSchema, recovered.payload).name,
      "Recovered default Namespace",
    );
    await bootstrappedDefaultNamespace(fixture);
  });

  test("bootstrap without Installation administer is refused and audited", async () => {
    const restrictions: Restriction[] = [
      {
        id: "restriction-no-installation-administer",
        action: "administer",
        resourceKind: "installation",
        effect: "deny",
      },
    ];
    const fixture = await createFixture({ restrictions });

    const eventsBefore = fixture.auditSink.events.length;
    const denied = await request(fixture.app, "/installation/bootstrap", {
      body: { name: "Refused Installation" },
    });
    assert.equal(denied.response.status, 403);
    assert.equal(responseError(denied.payload).code, "FORBIDDEN");
    assert.equal(fixture.controller, undefined);
    assert.equal(fixture.auditSink.events.length, eventsBefore + 1);
    const deniedEvent = fixture.auditSink.events.at(-1);
    assert.equal(deniedEvent?.kind, "authorization_denial");
    assert.equal(deniedEvent?.actorId, fixture.administrator.id);
    assert.deepEqual(restrictionIds(deniedEvent), ["restriction-no-installation-administer"]);

    restrictions.length = 0;
    const bootstrapped = await request(fixture.app, "/installation/bootstrap", {
      body: { name: "Allowed Installation" },
    });
    assert.equal(bootstrapped.response.status, 201);
  });

  test("concurrent streaming bootstrap creates one audited Installation", async () => {
    const fixture = await createFixture();
    const { promise: ready, resolve: releaseBodies } = Promise.withResolvers<void>();
    const encoder = new TextEncoder();

    function competingRequest(name: string) {
      const body = new ReadableStream<Uint8Array>({
        async start(stream) {
          await ready;
          stream.enqueue(encoder.encode(JSON.stringify({ name })));
          stream.close();
        },
      });

      const init: RequestInit & { duplex: "half" } = {
        method: "POST",
        duplex: "half",
        headers: authenticatedHeaders(fixture.app.defaultSession, {
          "content-type": "application/json",
        }),
        body,
      };
      return new Request(
        new URL("/installation/bootstrap", fixture.app.defaultSession.origin),
        init,
      );
    }

    const requests = [
      competingRequest("First competing installation"),
      competingRequest("Second competing installation"),
    ];
    const pending = Promise.all(requests.map((candidate) => fixture.app.fetch(candidate)));
    const release = setTimeout(() => releaseBodies(), 0);
    let responses: Response[];
    try {
      responses = await pending;
    } finally {
      clearTimeout(release);
    }

    assert.deepEqual(
      responses.map((response) => response.status).sort((left, right) => left - right),
      [201, 409],
    );
    const accepted = responses.find((response) => response.status === 201);
    assert.ok(accepted);
    const payload: unknown = await accepted.json();
    const installation = responseData(InstallationSchema, payload);
    const controller = fixture.controller;
    assert.ok(controller);
    assert.deepEqual(controller.installation, installation);
    await bootstrappedDefaultNamespace(fixture);

    const confirmed = await request(fixture.app, "/installation");
    assert.equal(confirmed.response.status, 200);
    // No Sandbox Driver is selected: Embedded OpenClaw is the one mode admission accepts (#2670).
    assert.deepEqual(confirmed.payload.data, {
      ...installation,
      capabilities: { openclaw: { executionModes: ["embedded"] } },
    });

    const bootstrapEvents = fixture.auditSink.events.filter(
      (event) => event.kind === "bootstrap" && event.resource.kind === "installation",
    );
    assert.equal(bootstrapEvents.length, 1);
    assert.equal(bootstrapEvents[0]?.resource.id, installation.id);
    assert.equal(bootstrapEvents[0]?.actorId, fixture.administrator.id);
    // Only the winning bootstrap queues provisioning of the default Namespace.
    assert.deepEqual(fixture.controller.pendingOperations(), [
      {
        kind: "namespace",
        action: "reconcile",
        target: "ready",
        namespaceId: bootstrapDefaultNamespaceId,
        resourceId: bootstrapDefaultNamespaceId,
        actorId: fixture.administrator.id,
      },
    ]);
  });

  test("a bootstrap that arrives while another is still in progress is refused", async () => {
    const fixture = await createFixture();
    const append = fixture.auditSink.append;
    const { promise: held, resolve: release } = Promise.withResolvers<void>();
    const { promise: inProgress, resolve: started } = Promise.withResolvers<void>();
    // Hold the first bootstrap at its audit write, after it has passed the guard but before
    // it publishes the controller. A second bootstrap that gets this far releases it.
    let bootstraps = 0;
    fixture.auditSink.append = async (event) => {
      if (event.kind === "bootstrap") {
        bootstraps += 1;
        if (bootstraps === 1) {
          started();
          await held;
        } else {
          release();
        }
      }
      return append.call(fixture.auditSink, event);
    };
    const first = request(fixture.app, "/installation/bootstrap", { body: { name: "First" } });
    try {
      // Report an early response if the first bootstrap never reaches the held audit write.
      await Promise.race([
        inProgress,
        first.then((result) => {
          throw new Error(`bootstrap ended before its audit write: ${result.response.status}`);
        }),
      ]);
      const second = await request(fixture.app, "/installation/bootstrap", {
        body: { name: "Second" },
      });
      release();
      assert.equal(second.response.status, 409);
      assert.equal(responseError(second.payload).code, "INSTALLATION_EXISTS");
      assert.equal((await first).response.status, 201);
    } finally {
      release();
      await Promise.allSettled([first]);
      fixture.auditSink.append = append;
    }
    assert.equal(fixture.auditSink.events.filter((event) => event.kind === "bootstrap").length, 1);
  });

  test("an existing controller cannot be configured for a different Installation", async () => {
    const fixture = await createFixture();
    const installation = await bootstrap(fixture);

    assert.throws(
      () =>
        fixture.createApp(fixture.administrator, {
          development: {
            installationId: "ins_9ce0e58a-415d-485e-90c2-20c3c5572505",
          },
        }),
      /installation/i,
    );

    const unchanged = await request(fixture.app, "/installation");
    assert.equal(unchanged.response.status, 200);
    // No Sandbox Driver is selected: Embedded OpenClaw is the one mode admission accepts (#2670).
    assert.deepEqual(unchanged.payload.data, {
      ...installation,
      capabilities: { openclaw: { executionModes: ["embedded"] } },
    });
    assert.deepEqual(fixture.controller?.installation, installation);
  });
}
