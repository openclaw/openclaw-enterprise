import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startPluginRequestGuard } from "../../apps/controller/src/plugin-request-guard.ts";
import {
  managedGoogleInstall,
  managedPluginMiddleware,
  managedPluginMiddlewareAudience,
  managedPluginMiddlewareImplementation,
} from "../../apps/controller/src/drivers/plugin/managed-catalog.ts";
import { bindReservedPortInProcess, reservePort } from "../helpers/available-port.mjs";
import { harnessTlsFixture } from "../helpers/harness-tls.mjs";
import {
  grpc,
  invoke,
  openShellMiddlewareClient,
  token,
} from "../helpers/openshell-online-wire.mjs";

test("the standalone guard refuses startup without supervisor trust settings", () => {
  const entry = fileURLToPath(
    new URL("../../apps/controller/src/plugin-request-guard.ts", import.meta.url),
  );
  const result = spawnSync(process.execPath, [entry], {
    env: { OCC_PLUGIN_REQUEST_AUTHORITY_PORT: "9444" },
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /pluginRequestGuard.issuer must be/);
});

test("the signed OpenShell request guard intersects the source envelope with the pinned gog operations", async (t) => {
  const { directory, caBundle } = await harnessTlsFixture(t);
  const keys = generateKeyPairSync("ed25519");
  const issuerPublicKeyPath = join(directory, "issuer.pub");
  await writeFile(issuerPublicKeyPath, keys.publicKey.export({ type: "spki", format: "pem" }));
  const reservation = await reservePort();
  t.after(reservation.release);
  await bindReservedPortInProcess(reservation);
  const guard = await startPluginRequestGuard(
    {
      OCC_PLUGIN_REQUEST_AUTHORITY_PORT: String(reservation.port),
      OCC_PLUGIN_REQUEST_AUTHORITY_ISSUER: "https://gateway.example.test",
      OCC_PLUGIN_REQUEST_AUTHORITY_KEY_ID: "gateway-key",
    },
    {
      certificatePath: join(directory, "server.pem"),
      privateKeyPath: join(directory, "server.key"),
      issuerPublicKeyPath,
    },
  );
  t.after(guard.close);
  await reservation.release();
  const client = openShellMiddlewareClient(t, reservation.port, caBundle);
  const sandbox = "fixture-runtime-1";
  const signed = token(keys, "supervisor", sandbox, managedPluginMiddlewareAudience);
  const gateway = token(keys, "gateway", undefined, managedPluginMiddlewareAudience);
  const context = { sandbox_id: sandbox, workspace: "default", request_id: "gmail-request-1" };
  const gmail = "https://www.googleapis.com/auth/gmail.readonly";
  const scopeConfig = (host: string, path: string, scope: string) => ({
    fields: {
      binding_id: { stringValue: managedGoogleInstall.releaseSha256 },
      request_scope: { stringValue: JSON.stringify({ host, port: 443, path, scopes: [scope] }) },
    },
  });
  const config = scopeConfig("gmail.googleapis.com", "/gmail/v1/users/me/messages", gmail);
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
  // GetGatewayInfo exposes these negotiated fields before a Sandbox receives its provider.
  assert.equal(manifest.extension.implementation_name, managedPluginMiddlewareImplementation);
  assert.equal(manifest.extension.implementation_version, managedGoogleInstall.releaseSha256);
  assert.deepEqual(manifest.extension.required_capabilities, [contract]);
  assert.deepEqual(manifest.extension.supported_capabilities, [contract]);
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
  const stale = {
    ...request,
    config: { fields: { ...config.fields, binding_id: { stringValue: "0".repeat(64) } } },
  };
  assert.equal((await invoke(client, "ValidateConfig", stale, gateway)).valid, false);
  assert.equal(await evaluate(stale), 2);
  assert.equal(
    await evaluate(
      request,
      token(keys, "supervisor", "other-runtime", managedPluginMiddlewareAudience),
    ),
    2,
  );
  assert.equal(await evaluate(request, gateway), 2);
  assert.equal(await evaluate(request, token(keys, "supervisor", sandbox, "other-middleware")), 2);
  assert.equal(await evaluate({ ...request, headers: [{ name: "user-agent", value: "gog" }] }), 1);

  const discovery = {
    ...target,
    host: "www.googleapis.com",
    path: "/discovery/v1/apis/gmail/v1/rest",
    query: "",
  };
  assert.equal(await evaluate({ ...request, target: discovery }), 1);
  const fallback = { ...target, path: "/$discovery/rest", query: "version=v1" };
  assert.equal(await evaluate({ ...request, target: fallback }), 1);
  assert.equal(await evaluate({ ...request, target: { ...fallback, query: "version=v2" } }), 2);
  assert.equal(
    await evaluate({
      ...request,
      config: scopeConfig(target.host, "/**", gmail),
      target: fallback,
    }),
    2,
    "a public Discovery fallback cannot receive a bearer from an overlapping source",
  );
  assert.equal(
    await evaluate({
      ...request,
      target: { ...discovery, path: "/discovery/v1/apis", query: "preferred=true" },
    }),
    1,
  );
  for (const query of [
    "",
    "maxResults=2",
    "q=is%3Aunread&maxResults=10",
    "labelIds=INBOX&labelIds=STARRED",
  ]) {
    assert.equal(await evaluate({ ...request, target: { ...target, query } }), 1, query);
  }
  const get = { ...target, path: target.path + "/abc", query: "format=full" };
  assert.equal(
    await evaluate({ ...request, target: get }),
    2,
    "source still authorizes only the collection",
  );
  const subtree = scopeConfig(target.host, "/gmail/v1/users/me/**", gmail);
  assert.equal(await evaluate({ ...request, config: subtree, target: get }), 1);
  const metadataScope = scopeConfig(
    target.host,
    "/gmail/v1/users/me/**",
    "https://www.googleapis.com/auth/gmail.metadata",
  );
  assert.equal(await evaluate({ ...request, config: metadataScope, target: get }), 2);
  assert.equal(
    await evaluate({
      ...request,
      config: metadataScope,
      target: { ...get, query: "format=metadata" },
    }),
    1,
  );
  assert.equal(
    await evaluate({
      ...request,
      config: metadataScope,
      target: { ...target, query: "q=is%3Aunread" },
    }),
    2,
  );
  const json = (value: unknown) => ({
    body: Buffer.from(JSON.stringify(value)),
    headers: [{ name: "content-type", value: "application/json" }],
  });
  const freebusy = {
    ...request,
    config: scopeConfig(
      "www.googleapis.com",
      "/calendar/v3/freeBusy",
      "https://www.googleapis.com/auth/calendar.readonly",
    ),
    target: {
      ...target,
      host: "www.googleapis.com",
      path: "/calendar/v3/freeBusy",
      method: "POST",
      query: "",
    },
    ...json({
      timeMin: "2025-01-01T00:00:00Z",
      timeMax: "2025-01-02T00:00:00Z",
      items: [{ id: "primary" }],
    }),
  };
  assert.equal(await evaluate(freebusy), 1, "read-authorized POST");
  assert.equal(
    await evaluate({ ...freebusy, ...json({ items: [{ id: "primary", unreviewed: true }] }) }),
    2,
  );
  const batch = {
    ...request,
    config: scopeConfig(
      "sheets.googleapis.com",
      "/v4/**",
      "https://www.googleapis.com/auth/spreadsheets",
    ),
    target: {
      ...target,
      host: "sheets.googleapis.com",
      path: "/v4/spreadsheets/id:batchUpdate",
      method: "POST",
      query: "",
    },
  };
  assert.equal(
    await evaluate({
      ...batch,
      ...json({ requests: [{ addSheet: { properties: { title: "Test" } } }] }),
    }),
    1,
  );
  assert.equal(await evaluate({ ...batch, ...json({ requests: [{ unknownAction: {} }] }) }), 2);
  assert.equal(
    await evaluate({
      ...batch,
      ...json({ requests: [{ addSheet: {}, deleteSheet: { sheetId: 1 } }] }),
    }),
    2,
  );
  const cells = {
    ...batch,
    target: {
      ...batch.target,
      method: "PUT",
      path: "/v4/spreadsheets/id/values/Sheet1!A1%3AD1",
      query: "valueInputOption=RAW",
    },
  };
  assert.equal(
    await evaluate({ ...cells, ...json({ values: [["hello", 2, true, null]] }) }),
    1,
    "gog sheets update",
  );
  assert.equal(await evaluate({ ...cells, ...json({ values: [[{ unreviewed: true }]] }) }), 2);
  const drive = {
    ...request,
    target: {
      ...target,
      host: "www.googleapis.com",
      path: "/drive/v3/files/my-file",
      query: "fields=id,name",
    },
    config: scopeConfig(
      "www.googleapis.com",
      "/drive/v3/**",
      "https://www.googleapis.com/auth/drive.metadata.readonly",
    ),
  };
  assert.equal(await evaluate(drive), 1, "Drive metadata");
  const download = { ...drive, target: { ...drive.target, query: "alt=media" } };
  assert.equal(await evaluate(download), 2, "metadata grant cannot fetch file bytes");
  assert.equal(
    await evaluate({
      ...download,
      config: scopeConfig(
        "www.googleapis.com",
        "/drive/v3/**",
        "https://www.googleapis.com/auth/drive.readonly",
      ),
    }),
    1,
  );
  assert.equal(
    await evaluate({
      ...drive,
      target: { ...drive.target, path: "/drive/v3/files/generateIds", query: "" },
    }),
    2,
    "reserved RPC cannot match the generic file ID route",
  );
  const exp = {
    ...drive.target,
    path: "/drive/v3/files/doc/export",
    query: "mimeType=application%2Fpdf&alt=media",
  };
  assert.equal(
    await evaluate({ ...drive, target: exp }),
    2,
    "metadata scope cannot export content",
  );
  assert.equal(
    await evaluate({
      ...drive,
      config: scopeConfig(
        "www.googleapis.com",
        "/drive/v3/**",
        "https://www.googleapis.com/auth/drive.readonly",
      ),
      target: exp,
    }),
    1,
  );
  const keep = {
    ...target,
    host: "keep.googleapis.com",
    path: "/v1/notes/note/attachments/file",
    query: "mimeType=image%2Fpng&alt=media",
  };
  assert.equal(
    await evaluate({
      ...request,
      config: scopeConfig(keep.host, "/v1/**", "https://www.googleapis.com/auth/keep.readonly"),
      target: keep,
    }),
    1,
  );
  const sheetsRead = scopeConfig(
    "sheets.googleapis.com",
    "/v4/**",
    "https://www.googleapis.com/auth/spreadsheets.readonly",
  );
  assert.equal(
    await evaluate({ ...cells, config: sheetsRead, ...json({ values: [["hello"]] }) }),
    2,
    "read-only scope refuses write",
  );
  for (const denied of [
    { ...request, target: { ...target, method: "POST" } },
    { ...request, target: { ...target, host: discovery.host } },
    { ...request, target: { ...target, path: target.path + "/send" } },
    { ...request, target: { ...target, scheme: "http" } },
    { ...request, target: { ...target, port: 444 } },
    { ...request, target: { ...discovery, query: "key=unexpected" } },
    { ...request, config: subtree, target: { ...get, path: target.path + "/%2e%2e%2fsend" } },
    ...[
      "maxResults=bad",
      "maxResults=1&maxResults=1",
      "maxResults=1&extra=x",
      "access_token=injected",
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
