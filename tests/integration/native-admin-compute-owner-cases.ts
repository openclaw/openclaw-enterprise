import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type nodeTest from "node:test";

import { resolveApprovedHarness } from "../../apps/controller/src/composition/production-harness.ts";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import { createOccLogger } from "../../apps/controller/src/logging.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import type { ComputeDriver } from "../../packages/contracts/src/index.ts";
import { InMemoryPlatformState, OpenClawController } from "../../packages/occ/src/index.ts";
import type { signInToControllerApp as signIn } from "../helpers/auth-session.mjs";
import { createControllerAuth } from "../helpers/password-hasher.ts";
import {
  authBaseURL,
  injectJson,
  nativeDomain,
  publicOrigin,
  type NativeAdminCaseDependencies,
} from "./native-admin-access-fixture.ts";
import { errorRecord, readRecord, readString } from "./native-admin-authority-cases.ts";

const parseJson: (text: string) => unknown = JSON.parse;

export function registerNativeAdminComputeOwnerCases(
  test: typeof nodeTest,
  {
    createNativeAdminFixture,
    nativeOriginForAgent,
    trustLocalUpstreamCertificate,
  }: NativeAdminCaseDependencies,
  nativeComputeDriver: (upstreamPort: number) => ComputeDriver,
  nativeGatewayApiKey: string,
  signInToControllerApp: typeof signIn,
): void {
  const changedFields: readonly (undefined | "id" | "implementation")[] = [
    undefined,
    "id",
    "implementation",
  ];
  for (const changedField of changedFields) {
    test(`native admin retains the revision Compute owner after restart: ${changedField ?? "matching"}`, async (t) => {
      const state = new InMemoryPlatformState();
      const context = await createNativeAdminFixture(t, { state });
      const { fixture, upstream, namespace, agent, revision } = context;
      trustLocalUpstreamCertificate(t, upstream.cert);
      const originalCompute = fixture.controller.selectedDriver("compute");
      assert.deepEqual(revision.compute, {
        id: originalCompute.id,
        implementation: originalCompute.implementation,
      });

      // Reopen the same committed revision with a fresh registry, as on controller restart.
      // In particular, changing only implementation must not mutate a registered Driver.
      const controller = new OpenClawController(fixture.controller.installation, {
        state,
        recordOperations: false,
      });
      controller.registerDriver(fixture.iamDriver);
      controller.selectDriver("iam", fixture.iamDriver.id);
      const calls = { endpoint: 0, key: 0 };
      const upstreamPort = readRecord(upstream, "native upstream").port;
      assert.ok(typeof upstreamPort === "number", "native upstream port");
      const compute: ComputeDriver = {
        ...nativeComputeDriver(upstreamPort),
        ...(changedField === undefined ? {} : { [changedField]: `replacement-${changedField}` }),
        async getGatewayBrowserRequest(selectedRevision, input, signal) {
          calls.endpoint += 1;
          assert.equal(selectedRevision.id, revision.id);
          assert.equal(input.installationId, controller.installation.id);
          assert.ok(originalCompute.getGatewayBrowserRequest);
          return originalCompute.getGatewayBrowserRequest(selectedRevision, input, signal);
        },
      };
      controller.registerDriver(compute);
      controller.selectDriver("compute", compute.id);
      const auth = createControllerAuth({
        installationId: controller.installation.id,
        mode: "development",
        baseURL: authBaseURL,
        secret: `native-restart-test-${randomUUID()}-${randomUUID()}`,
        memoryDatabase: fixture.memoryDatabase,
        agentDomain: nativeDomain,
      });
      const logLines: string[] = [];
      const app = createFastifyApp({
        controller,
        iamDriver: fixture.iamDriver,
        auth,
        logger: createOccLogger({
          component: "native-admin-test",
          level: "info",
          destination: {
            write(chunk: string) {
              logLines.push(...String(chunk).split("\n").filter(Boolean));
              return true;
            },
          },
        }),
        auditSink: new InMemoryAuditSink(),
        development: { enabled: false },
        resolveHarness: resolveApprovedHarness,
        publicOrigin,
        nativeAdmin: { enabled: true, domain: nativeDomain },
        nativeAdminGatewayApiKey: async () => {
          calls.key += 1;
          return nativeGatewayApiKey;
        },
      });
      t.after(() => app.close());
      const session = await signInToControllerApp(app, fixture.credentials);
      const headers = { cookie: session.cookie, origin: publicOrigin };
      const status = await injectJson(
        { app },
        "GET",
        `/namespaces/${namespace.id}/agents/${agent.id}/native-admin`,
        { headers },
      );
      const host = new URL(nativeOriginForAgent(controller.installation.id, namespace.id, agent.id))
        .host;
      const proxyLogStart = logLines.length;
      const proxy = await injectJson({ app }, "GET", "/", {
        headers: { ...headers, host, origin: `https://${host}` },
      });
      if (changedField === undefined) {
        const proxyCompletions = logLines
          .slice(proxyLogStart)
          .map((line) => readRecord(parseJson(line), "structured log line"))
          .filter((line) => line.event === "http.completed");
        assert.equal(proxyCompletions.length, 1);
        const completion = proxyCompletions[0];
        assert.ok(completion);
        assert.equal(completion.status, 200);
        assert.ok(completion.requestId);
        assert.equal(completion.nativeAdmissionReason, undefined);
        const refused = await app.inject({
          method: "GET",
          url: "/?private=discard-query-marker",
          headers: { host, cookie: "discard-cookie-marker=private" },
        });
        assert.equal(refused.statusCode, 403);
        const completions = logLines
          .map((line) => readRecord(parseJson(line), "structured log line"))
          .filter((line) => line.event === "http.completed");
        const completed = completions.find(
          (line) => line.requestId === refused.headers["x-request-id"],
        );
        assert.ok(completed, "the refusal must correlate to its existing HTTP request ID");
        assert.equal(completed.nativeAdmissionReason, "session_invalid");
        assert.equal(completed.status, 403);
        assert.ok(!JSON.stringify(completed).includes("discard-"));
      }
      // A console poll repeats the status read; the mismatch is still warned only once.
      const repeated = await injectJson(
        { app },
        "GET",
        `/namespaces/${namespace.id}/agents/${agent.id}/native-admin`,
        { headers },
      );
      assert.equal(repeated.statusCode, status.statusCode);
      const mismatchLogs = logLines
        .map((line) => readRecord(parseJson(line), "structured log line"))
        .filter((line) => line.event === "native_admin.compute_owner_mismatch");
      if (changedField === undefined) {
        assert.deepEqual(mismatchLogs, []);
        assert.equal(status.statusCode, 200);
        assert.equal(
          readRecord(readRecord(status.json<unknown>(), "status body").data, "status data").status,
          "available",
        );
        assert.equal(proxy.statusCode, 200);
        assert.equal(proxy.body, "native admin upstream\n");
        assert.equal(calls.endpoint, 3);
        assert.equal(calls.key, 1);
        assert.equal(upstream.requests.length, 1);
      } else {
        assert.equal(status.statusCode, 503);
        assert.equal(errorRecord(status.json<unknown>()).code, "DEPENDENCY_UNAVAILABLE");
        // Agent-host admission retains its existing non-disclosing refusal envelope.
        assert.equal(proxy.statusCode, 403);
        assert.deepEqual(calls, { endpoint: 0, key: 0 });
        assert.equal(upstream.requests.length, 0);
        // One operator line names both owners and the recovery; no endpoint or key.
        assert.equal(mismatchLogs.length, 1, logLines.join("\n"));
        const [logged] = mismatchLogs;
        assert.ok(logged);
        assert.equal(logged.severity, "WARN");
        assert.deepEqual(
          {
            namespaceId: logged.namespaceId,
            agentId: logged.agentId,
            revisionId: logged.revisionId,
            revisionCompute: logged.revisionCompute,
            selectedCompute: logged.selectedCompute,
          },
          {
            namespaceId: namespace.id,
            agentId: agent.id,
            revisionId: revision.id,
            revisionCompute: revision.compute,
            selectedCompute: { id: compute.id, implementation: compute.implementation },
          },
        );
        assert.match(
          readString(logged.message, "mismatch recovery message"),
          /Select that Compute Driver again/,
        );
        const text = logLines.join("\n");
        assert.ok(!text.includes(nativeGatewayApiKey), "the gateway key must not be logged");
        assert.ok(originalCompute.getGatewayEndpoint);
        const endpoint = originalCompute.getGatewayEndpoint(revision);
        assert.ok(typeof endpoint === "string");
        assert.ok(!text.includes(endpoint), "the private gateway endpoint must not be logged");
      }
      const persisted = await state.read((view) =>
        view.revisions.findRevision(namespace.id, agent.id, revision.id),
      );
      assert.deepEqual(
        persisted,
        revision,
        "selection changes must not rewrite the active revision",
      );
    });
  }
}
