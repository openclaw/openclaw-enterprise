import assert from "node:assert/strict";
import test from "node:test";
import { createManagedPluginRequestAuthority } from "../../apps/controller/src/drivers/egress-proxy/managed-plugin-requests.ts";
import {
  managedGoogleInstall,
  managedPluginMiddleware,
} from "../../apps/controller/src/drivers/plugin/managed-catalog.ts";
import { grpc, invoke, openShellOnlineWire, token } from "../helpers/openshell-online-wire.mjs";

test("the signed OpenShell request stage admits only the bundled Gmail operation and public discovery", async (t) => {
  const { client, keys } = await openShellOnlineWire(
    t,
    managedPluginMiddleware,
    {},
    ({ identity }) => createManagedPluginRequestAuthority(identity),
  );
  const sandbox = "fixture-runtime-1";
  const signed = token(keys, "supervisor", sandbox);
  const gateway = token(keys, "gateway");
  const context = { sandbox_id: sandbox, workspace: "default", request_id: "gmail-request-1" };
  const config = { fields: { binding_id: { stringValue: managedGoogleInstall.releaseSha256 } } };
  const target = {
    scheme: "https",
    host: "gmail.googleapis.com",
    port: 443,
    method: "GET",
    path: "/gmail/v1/users/me/messages",
    query: "maxResults=1",
  };
  const request = { phase: 1, middleware_name: managedPluginMiddleware, config, context, target };
  const evaluate = async (input: object, caller = signed) =>
    (await invoke(client, "EvaluateHttpRequest", input, caller)).decision;
  const contract = "openshell.supervisor-middleware.contract";
  const manifest = await invoke(
    client,
    "Describe",
    {
      gateway: {
        protocol_version: { major: 1, minor: 0 },
        supported_capabilities: [contract],
        required_capabilities: [contract],
      },
    },
    gateway,
  );
  assert.deepEqual(
    manifest.bindings.map(({ operation, phase }: { operation: number; phase: number }) => [
      operation,
      phase,
    ]),
    [
      [1, 1],
      [2, 1],
    ],
  );
  assert.equal((await invoke(client, "ValidateConfig", request, gateway)).valid, true);
  const stale = { ...request, config: { fields: { binding_id: { stringValue: "0".repeat(64) } } } };
  assert.equal((await invoke(client, "ValidateConfig", stale, gateway)).valid, false);
  assert.equal(await evaluate(stale), 2);
  assert.equal(await evaluate(request, token(keys, "supervisor", "other-runtime")), 2);
  assert.equal(await evaluate(request, gateway), 2);
  assert.equal(await evaluate({ ...request, headers: [{ name: "user-agent", value: "gog" }] }), 1);

  const discovery = {
    ...target,
    host: "www.googleapis.com",
    path: "/discovery/v1/apis/gmail/v1/rest",
    query: "",
  };
  assert.equal(await evaluate({ ...request, target: discovery }), 1);
  for (const denied of [
    { ...request, target: { ...target, method: "POST" } },
    { ...request, target: { ...target, host: discovery.host } },
    { ...request, target: { ...target, path: target.path + "/send" } },
    { ...request, target: { ...target, scheme: "http" } },
    { ...request, target: { ...target, port: 444 } },
    { ...request, target: { ...discovery, query: "key=unexpected" } },
    ...[
      "",
      "maxResults=2",
      "maxResults=1&maxResults=1",
      "maxResults=1&extra=x",
      "maxResults=%31",
      "maxResults=1&",
    ].map((query) => ({ ...request, target: { ...target, query } })),
    { ...request, body: Buffer.from("{}") },
    ...["x-http-method-override", "x-original-url", "x-goog-request-params", "authorization"].map(
      // Only tests headers presented by the sender. Stock OpenShell filters Authorization.
      (name) => ({ ...request, headers: [{ name, value: "override" }] }),
    ),
    {
      ...request,
      headers: [
        { name: "accept", value: "*/*" },
        { name: "accept", value: "application/json" },
      ],
    },
  ]) {
    assert.equal(await evaluate(denied), 2);
  }

  const metadata = new grpc.Metadata();
  metadata.set("authorization", signed);
  const session = client.EvaluateWebSocketSession(metadata, { deadline: Date.now() + 5_000 });
  const decision = new Promise<{ preflight_decision: { action: number } }>((resolve, reject) => {
    session.once("data", resolve);
    session.once("error", reject);
  });
  session.end({ preflight: { context } });
  assert.equal((await decision).preflight_decision.action, 3);
});
