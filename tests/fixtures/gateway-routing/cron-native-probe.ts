import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { prepareNativeAdminConfiguration } from "../../../apps/controller/src/gateway/native-admin.ts";
import { createConsoleAppFixture } from "../../helpers/console-app.mjs";
import { createReadyComputeDriver } from "../../helpers/development.ts";
import { createHarnessConfiguration } from "../../helpers/harness-configuration.mjs";
import { grantRole } from "../../helpers/iam-grants.ts";
import { issueServiceKeyForNativeAgent } from "../../integration/native-admin-access-fixture.ts";

const endpoint = process.env.OCC_WORKSPACE_PROOF_ENDPOINT;
const keyPath = process.env.OCC_WORKSPACE_PROOF_KEY_PATH;
assert.ok(endpoint && keyPath, "Native Gateway endpoint and private key path are required.");
const apiKey = await readFile(keyPath, "utf8");
const cleanups: Array<() => unknown | Promise<unknown>> = [];
const scope = { after: (cleanup: () => unknown | Promise<unknown>) => cleanups.push(cleanup) };
let transportRequests = 0;
const compute = createReadyComputeDriver("native-cron-api-probe", {
  implementation: "native-cron-api-probe",
  validateHarnessAuth() {},
  getGatewayEndpoint: () => endpoint,
  async getGatewayBrowserRequest(_revision, { principalId, mode }) {
    assert.equal(mode, "admin");
    transportRequests++;
    return {
      endpoint,
      subject: `test:${principalId}`,
      headers: { "x-openclaw-scopes": "operator.admin" },
    };
  },
});
function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

const publicOrigin = "https://console.oce.example.test";
try {
  const f = await createConsoleAppFixture(scope, {
    computeDriver: compute,
    agentGatewayManagedMode: false,
    publicOrigin,
    authBaseURL: publicOrigin,
    development: { enabled: false },
    nativeAdmin: { enabled: true, domain: "agents.oce.example.test" },
    nativeAdminGatewayApiKey: async () => apiKey,
  });
  await f.bootstrap("Native cron API");
  const namespace = await f.createNamespace("Cron API", { ready: true });
  const values = createHarnessConfiguration("openclaw", "gpt-4.1");
  const agent = await f.createAgent(namespace.id, "Cron Agent", values);
  await f.updateConfiguration(
    namespace.id,
    agent.configurationId,
    prepareNativeAdminConfiguration(values, {
      publicOrigin,
      installationId: f.controller.installation.id,
      agent,
      domain: "agents.oce.example.test",
    }),
  );
  const revision = await f.deployAgent(namespace.id, agent.id);
  await f.activateRevision(namespace.id, agent.id, revision.id, undefined);
  const sibling = await f.createAgent(namespace.id, "Cron sibling", values);
  const administrator = await f.createAccountWithPolicy("cron-administrator", (principal) => {
    grantRole(f.policy, principal.id, {
      id: "cron-admin-exact",
      namespaceId: namespace.id,
      permissions: { agent: ["administer"] },
      resource: { kind: "agent", id: agent.id },
    });
  });
  const operator = await f.createAccountWithPolicy("cron-operator", (principal) => {
    grantRole(f.policy, principal.id, {
      id: "cron-operate-exact",
      namespaceId: namespace.id,
      permissions: { agent: ["operate"] },
      resource: { kind: "agent", id: agent.id },
    });
  });
  const adminSession = await f.signIn(administrator.credentials);
  const operatorSession = await f.signIn(operator.credentials);
  const base = `/namespaces/${namespace.id}/agents/${agent.id}/automations`;
  const siblingBase = `/namespaces/${namespace.id}/agents/${sibling.id}/automations`;
  const input = {
    name: "Disabled native cron API proof",
    enabled: false,
    schedule: { kind: "every", everyMs: 86_400_000 },
    prompt: "This disabled job must not run.",
  };
  const beforeDenials = transportRequests;
  // None of these callers can obtain native operator.admin transport.
  assert.equal(
    (await f.request("POST", base, { session: operatorSession, body: input })).status,
    403,
  );
  assert.equal((await f.request("GET", siblingBase, { session: adminSession })).status, 403);
  const service = await issueServiceKeyForNativeAgent({ fixture: f, namespace, agent });
  assert.equal(
    (await f.request("GET", base, { session: null, headers: { "x-api-key": service.key } })).status,
    401,
  );
  const csrf = await f.rawRequest("POST", base, {
    headers: { cookie: adminSession.cookie, origin: "https://untrusted.example.test" },
    body: input,
  });
  assert.equal(csrf.response.status, 403);
  assert.equal(transportRequests, beforeDenials, "Denied requests must not open native transport.");
  assert.ok(
    f.auditSink.events.some(
      (event) =>
        event.kind === "authorization_denial" &&
        event.outcome === "denied" &&
        event.actorId === operator.principal.id,
    ),
    "The operate-only refusal must have attributable audit evidence.",
  );

  const call = (method: string, path: string, body?: unknown) =>
    f.request(method, path, { session: adminSession, ...(body === undefined ? {} : { body }) });
  const created = await call("POST", base, input);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const job = created.data as {
    id: string;
    configRevision: string;
    enabled: boolean;
    name: string;
  };
  assert.ok(job.id && job.configRevision);
  assert.equal(job.enabled, false);
  const path = `${base}/${encodeURIComponent(job.id)}`;
  const listed = await call("GET", base);
  assert.equal(listed.status, 200);
  assert.ok(
    (listed.data as { jobs: Array<{ id: string }> }).jobs.some((item) => item.id === job.id),
  );
  assert.equal(record((await call("GET", path)).data).id, job.id);
  const updated = await call("PATCH", path, {
    expectedConfigRevision: job.configRevision,
    name: "Renamed disabled native cron API proof",
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  const updatedJob = record(updated.data);
  assert.equal(updatedJob.name, "Renamed disabled native cron API proof");
  assert.equal(
    (
      await call("PATCH", path, {
        expectedConfigRevision: job.configRevision,
        name: "Stale rename",
      })
    ).status,
    409,
    "A stale revision cannot change a job.",
  );
  const runs = await call("GET", `${path}/runs`);
  assert.equal(runs.status, 200);
  assert.deepEqual((runs.data as { entries: unknown[] }).entries, []);
  const removed = await call(
    "DELETE",
    `${path}?expectedConfigRevision=${encodeURIComponent(String(updatedJob.configRevision))}`,
  );
  assert.equal(removed.status, 204);
  assert.equal((await call("GET", path)).status, 404);
  for (const action of ["create", "update", "delete"]) {
    assert.ok(
      f.auditSink.events.some(
        (event) =>
          event.action === `openclaw.agents.automations.${action}` &&
          event.outcome === "success" &&
          event.actorId === administrator.principal.id,
      ),
      `Expected attributable ${action} audit evidence.`,
    );
  }
  process.stdout.write(
    JSON.stringify({ nativeCronCrud: true, deniedBeforeTransport: true }) + "\n",
  );
} finally {
  for (const cleanup of cleanups.reverse()) {
    await cleanup();
  }
}
