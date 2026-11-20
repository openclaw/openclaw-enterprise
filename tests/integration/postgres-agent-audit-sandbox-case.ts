import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { AgentAuditPage, AgentRevision } from "@openclaw-enterprise/contracts";

import type { PostgresPlatformState } from "../../packages/occ/src/index.ts";

const require = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
const { loadSync } = require("@grpc/proto-loader");
const schema = new URL(
  "../../apps/controller/src/http/proto/otlp-audit-logs.proto",
  import.meta.url,
);
const { serialize } = loadSync(fileURLToPath(schema), { keepCase: true })[
  "opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest"
] as { serialize(body: object): Buffer };
const token = randomBytes(32).toString("base64url");
export const openShellAuditHeaders = `authorization=Bearer ${token}\n`;
const route = "/internal/openshell-audit/v1/logs";

// Wire fixture for the private receiver. local-first-agent-real exercises the stock exporter.
function batch(sandboxId: string, uid: string, actionId: number, containerId = sandboxId) {
  const str = (key: string, value: string) => ({ key, value: { string_value: value } });
  const sandbox = str("openshell.sandbox.id", sandboxId);
  const body = {
    metadata: { uid, version: "1.8.0", product: { name: "OpenShell Sandbox Supervisor" } },
    class_uid: 4001,
    action_id: actionId,
    disposition_id: actionId,
    device: { container: { uid: containerId } },
    time: Date.now(),
    dst_endpoint: { domain: "private.example.invalid" },
    message: "private network details",
  };
  const attributes = [
    sandbox,
    str("ocsf.metadata.uid", uid),
    { key: "ocsf.class_uid", value: { int_value: 4001 } },
  ];
  return serialize({
    resource_logs: [
      {
        resource: { attributes: [str("service.name", "openshell-supervisor"), sandbox] },
        scope_logs: [
          {
            scope: { name: "openshell.ocsf" },
            log_records: [{ attributes, body: { string_value: JSON.stringify(body) } }],
          },
        ],
      },
    ],
  });
}

export async function checkSandboxAudit(
  state: PostgresPlatformState,
  revision: AgentRevision,
  credential: {
    token: string;
    grant: Parameters<PostgresPlatformState["removeGatewayRuntimeGrant"]>[0];
  },
  post: (
    event: unknown,
    token: string,
    source: string,
    path?: string,
  ) => Promise<number | undefined>,
  readPage: () => Promise<AgentAuditPage>,
) {
  const sandboxId = randomUUID();
  const next = randomUUID();
  const uid = randomUUID();
  const deny = batch(sandboxId, uid, 2);
  const send = (payload: Buffer, bearer = token) => post(payload, bearer, "openshell", route);
  const read = async () =>
    (await readPage()).events.filter(
      (event) => event.event === "runtime_activity" && event.details.runtimeSource === "openshell",
    );
  const action = "openclaw.runtime.policy.decided";
  const details = { policy: "network_policy", decision: "deny", sandboxId };
  // The exporter cannot pick an owner. Accepted, unrelated traffic produces no Agent row.
  assert.equal(await send(deny), 200);
  assert.deepEqual(await read(), []);
  await state.bindSandboxRuntimeAudit(revision, sandboxId);
  assert.equal(await send(deny, credential.token), 401);
  assert.equal(
    await post(
      { action, eventId: uid, occurredAt: new Date().toISOString(), ...details },
      credential.token,
      "openclaw",
    ),
    400,
  );
  assert.equal(await send(batch(sandboxId, uid, 2, next)), 400);
  assert.equal(await send(deny), 200);
  assert.equal(await send(deny), 200);
  assert.equal(await send(batch(sandboxId, uid, 1)), 409);
  const [entry] = await read();
  assert.ok(entry?.event === "runtime_activity");
  assert.deepEqual(
    [entry.action, entry.outcome, entry.details],
    [action, "denied", { ...details, agentRevisionId: revision.id, runtimeSource: "openshell" }],
  );
  // A replaced Sandbox loses authority before the new supervisor reports.
  await state.bindSandboxRuntimeAudit(revision, next);
  assert.equal(await send(batch(sandboxId, randomUUID(), 2)), 200);
  assert.equal(await send(batch(next, randomUUID(), 1)), 200);
  await state.removeGatewayRuntimeGrant(credential.grant);
  assert.equal(await send(batch(next, randomUUID(), 2)), 200);
  const events = await read();
  assert.equal(events.length, 2);
  const allowed = events.find((event) => event.outcome === "success");
  assert.ok(allowed?.event === "runtime_activity");
  assert.deepEqual(allowed.details, {
    ...details,
    sandboxId: next,
    decision: "allow",
    agentRevisionId: revision.id,
    runtimeSource: "openshell",
  });
}
