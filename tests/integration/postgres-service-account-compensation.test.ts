import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { renameSync, writeFileSync } from "node:fs";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, test } from "node:test";
import pg from "pg";
import {
  Agent,
  buildConnector,
  getGlobalDispatcher,
  setGlobalDispatcher,
} from "../../apps/controller/node_modules/undici/index.js";
import type { OpenClawController, PostgresPlatformState } from "../../packages/occ/src/index.ts";
import { AuditEventFactory } from "../../packages/audit/src/index.ts";
import { createOccLogger } from "../../apps/controller/src/logging.ts";
import { ChatGPTClient } from "../../apps/controller/src/backends/chatgpt.ts";
import { composePostgresDevelopment } from "../../apps/controller/src/composition/development-postgres.ts";
import {
  loadInstallationConfiguration,
  type InstallationRuntimeDrivers,
} from "../../apps/controller/src/composition/installation-config.ts";
import { createChatGPTServiceAccountDriverFactory } from "../../apps/controller/src/drivers/service-account/chatgpt.ts";
import {
  KubernetesComputeDriver,
  kubernetesNamespaceName,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { certificateAuthority, signedLeaf } from "../helpers/certificates.ts";
import { ensureDevelopmentBootstrap } from "../helpers/bootstrap-installation.mjs";
import { defaultUsersIAM } from "../helpers/default-users-iam.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { buildSandboxInstallation } from "./sandbox-driver-installation-fixture.ts";
import { databaseUrl, requiresPostgres } from "../helpers/postgres-database.mjs";
import { commitAckProxy } from "../fixtures/postgres-commit-ack-proxy.mjs";

type Json = Record<string, unknown>;
type Metadata = {
  name: string;
  namespace?: string;
  uid?: string;
  resourceVersion?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
};
type Secret = {
  apiVersion: "v1";
  kind: "Secret";
  metadata: Metadata;
  type?: string;
  data?: Record<string, string>;
  stringData?: Record<string, string>;
};
type Namespace = {
  apiVersion: "v1";
  kind: "Namespace";
  metadata: Metadata;
  status: { phase: "Active" };
};
type Credential = { id: string; token: string; accountId: string; occId: string };
type Event = { operation: string; id: string; outcome: string; sequence: number };
type Reply = { status: number; body: Json; text: string };
type Account = { id: string; externalId: string; name: string };
type DeleteMode =
  | "ok"
  | "503"
  | "403"
  | "unknown404"
  | "credential404"
  | "account404"
  | "invalidJson"
  | "wrongId"
  | "notDeleted"
  | "lostReply";
type CreateMode = "drop" | "before503" | "beforeReset";
const scope = "chatgpt.workspace.feature.allow-codex-local-access.access";
const safeObject = (x: unknown): Json => {
  assert.ok(x !== null && typeof x === "object" && !Array.isArray(x));
  return x as Json;
};
const textField = (x: Json, k: string): string => {
  assert.equal(typeof x[k], "string");
  return x[k] as string;
};
const data = (r: Reply): Json => safeObject(r.body.data);
async function body(request: IncomingMessage): Promise<Json> {
  let bytes = "";
  for await (const chunk of request) {
    bytes += String(chunk);
  }
  return bytes === "" ? {} : safeObject(JSON.parse(bytes) as unknown);
}
function send(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}
function status(response: ServerResponse, code: number): void {
  send(response, code, {
    apiVersion: "v1",
    kind: "Status",
    status: "Failure",
    reason: code === 404 ? "NotFound" : code === 409 ? "Conflict" : "ServiceUnavailable",
    code,
  });
}
async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  if (server.listening) {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
  assert.equal(server.listening, false);
}
const live = {
  directory: "",
  key: "",
  keyId: "",
  namespaceId: "",
  workspaceId: randomUUID(),
  adminKey: randomUUID(),
  kubeKey: randomUUID(),
  authSecret: randomUUID() + randomUUID(),
  authBaseURL: "https://console.oce.localhost",
  appName: "sa-comp-" + randomUUID(),
  mainUrl: "",
  configPath: "",
  noDriverConfigPath: "",
  duplicateAuditId: "",
  auditNext: undefined as (() => string) | undefined,
  auditConsumed: 0,
  runtime: undefined as InstallationRuntimeDrivers | undefined,
  state: undefined as PostgresPlatformState | undefined,
  controller: undefined as OpenClawController | undefined,
  pool: undefined as pg.Pool | undefined,
  provider: undefined as Server | undefined,
  kube: undefined as Server | undefined,
  agent: undefined as Agent | undefined,
  originalDispatcher: getGlobalDispatcher(),
  apps: [] as Awaited<ReturnType<typeof composePostgresDevelopment>>[],
  proxies: [] as Awaited<ReturnType<typeof commitAckProxy>>[],
  faults: [] as string[],
  diagnostics: [] as Json[],
  events: [] as Event[],
  accounts: new Map<string, string>(),
  credentials: new Map<string, Credential>(),
  secrets: new Map<string, Secret>(),
  configMaps: new Map<string, Json>(),
  namespaces: new Map<string, Namespace>(),
  deleteModes: new Map<string, DeleteMode>(),
  createModes: new Map<string, CreateMode>(),
  afterStored: new Map<string, () => void>(),
  beforeProviderDelete: undefined as ((id: string) => Promise<void>) | undefined,
  beforeProviderCreate: undefined as ((accountId: string) => Promise<void>) | undefined,
  beforeSecretRead: undefined as ((name: string) => Promise<void>) | undefined,
  beforeSecretDelete: undefined as ((name: string, value: Json) => void) | undefined,
  beforeSecretCreate: undefined as ((name: string) => void) | undefined,
};
function record(operation: string, id: string, outcome: string): void {
  live.events.push({ operation, id, outcome, sequence: live.events.length + 1 });
}
function persist(kind: "provider" | "kubernetes"): void {
  const value =
    kind === "provider"
      ? { accounts: [...live.accounts], credentials: [...live.credentials] }
      : { namespaces: [...live.namespaces], secrets: [...live.secrets] };
  const path = join(live.directory, kind + ".json");
  writeFileSync(path + ".tmp", JSON.stringify(value), { mode: 0o600 });
  renameSync(path + ".tmp", path);
}
function credentialFor(a: Account): Credential {
  const found = [...live.credentials.values()].find((x) => x.accountId === a.externalId);
  assert.ok(found, "expected one synthetic provider credential");
  return found;
}
function providerEvents(a: Account, operation = "credential-post"): Event[] {
  return live.events.filter(
    (x) =>
      x.operation === operation && (x.id === a.externalId || x.id.startsWith(a.externalId + "/")),
  );
}
async function providerHandler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  assert.equal(request.headers.host, "api.chatgpt.com");
  assert.equal(request.headers.authorization, "Bearer " + live.adminKey);
  assert.equal(request.headers.accept, "application/json");
  const url = new URL(request.url ?? "", "https://api.chatgpt.com");
  assert.equal(url.search, "");
  const prefix = "/v1/manage/workspaces/" + live.workspaceId + "/service-accounts";
  assert.ok(
    url.pathname === prefix || url.pathname.startsWith(prefix + "/"),
    "unexpected provider path",
  );
  const parts = url.pathname
    .slice(prefix.length)
    .split("/")
    .filter(Boolean)
    .map(decodeURIComponent);
  if (request.method === "POST") {
    assert.equal(request.headers["content-type"], "application/json");
    const value = await body(request);
    if (parts.length === 0) {
      assert.deepEqual(Object.keys(value), ["name"]);
      const name = textField(value, "name");
      const id = "account-" + randomUUID();
      live.accounts.set(id, name);
      persist("provider");
      record("account-post", id, "applied");
      send(response, 200, { id, workspace_id: live.workspaceId, enabled: true });
      return;
    }
    assert.equal(parts.length, 2);
    assert.equal(parts[1], "credentials");
    const accountId = parts[0]!;
    assert.ok(live.accounts.has(accountId));
    const name = textField(value, "name");
    assert.deepEqual(value, { name, ttl: 3600, scopes: [scope] });
    assert.ok(
      name.startsWith("occ-") && live.accounts.get(accountId)!.endsWith("-" + name.slice(4)),
      "credential name must bind the OCC account",
    );
    await live.beforeProviderCreate?.(accountId);
    const id = "credential-" + randomUUID();
    const token = "synthetic-" + randomUUID();
    live.credentials.set(id, { id, token, accountId, occId: name.slice(4) });
    persist("provider");
    record("credential-post", accountId + "/" + id, "applied");
    send(response, 200, {
      id,
      access_token: token,
      workspace_id: live.workspaceId,
      service_account_id: accountId,
      scopes: [scope],
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    });
    return;
  }
  assert.equal(request.method, "DELETE");
  assert.ok(parts.length === 1 || (parts.length === 3 && parts[1] === "credentials"));
  if (parts.length === 1) {
    const id = parts[0]!;
    live.accounts.delete(id);
    for (const [key, value] of live.credentials) {
      if (value.accountId === id) {
        live.credentials.delete(key);
      }
    }
    persist("provider");
    record("account-delete", id, "confirmed");
    send(response, 200, { id, deleted: true });
    return;
  }
  const accountId = parts[0]!;
  const id = parts[2]!;
  const row = live.credentials.get(id);
  assert.ok(row === undefined || row.accountId === accountId, "wrong account credential DELETE");
  record("credential-delete", accountId + "/" + id, "requested");
  await live.beforeProviderDelete?.(id);
  const mode = live.deleteModes.get(accountId) ?? "ok";
  if (mode === "503" || mode === "403") {
    send(response, Number(mode), { error: { code: "unavailable" } });
    record("credential-delete", accountId + "/" + id, "refused-" + mode);
    return;
  }
  if (mode === "unknown404" || mode === "credential404" || mode === "account404") {
    const code =
      mode === "unknown404"
        ? "unrecognized"
        : mode === "credential404"
          ? "credential_not_found"
          : "service_account_not_found";
    send(response, 404, { error: { code } });
    record("credential-delete", accountId + "/" + id, "reply-" + code);
    return;
  }
  if (mode === "invalidJson") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{");
    record("credential-delete", accountId + "/" + id, "invalid-json");
    return;
  }
  if (mode === "wrongId" || mode === "notDeleted") {
    send(response, 200, {
      id: mode === "wrongId" ? "different-id" : id,
      deleted: mode !== "notDeleted",
    });
    record("credential-delete", accountId + "/" + id, "unconfirmed");
    return;
  }
  live.credentials.delete(id);
  persist("provider");
  if (mode === "lostReply") {
    record("credential-delete", accountId + "/" + id, "applied-reply-lost");
    response.destroy();
    return;
  }
  record("credential-delete", accountId + "/" + id, "confirmed");
  send(response, 200, { id, deleted: true });
}
async function kubeHandler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  assert.equal(request.headers.authorization, "Bearer " + live.kubeKey);
  const url = new URL(request.url ?? "", "https://localhost");
  const parts = url.pathname.split("/").filter(Boolean);
  if (url.pathname === "/version" && request.method === "GET") {
    send(response, 200, { major: "1", minor: "35", gitVersion: "v1.35.0" });
    return;
  }
  assert.deepEqual(parts.slice(0, 3), ["api", "v1", "namespaces"]);
  if (parts.length === 3 && request.method === "GET") {
    const selector = url.searchParams.get("labelSelector");
    const items = [...live.namespaces.values()].filter(
      (n) =>
        selector === null ||
        selector === "openclaw.dev/gateway-namespace" ||
        n.metadata.labels?.["openclaw.dev/namespace"] === selector.split("=")[1],
    );
    send(response, 200, {
      apiVersion: "v1",
      kind: "NamespaceList",
      metadata: { resourceVersion: "1" },
      items,
    });
    return;
  }
  const ns = parts[3]!;
  assert.ok(
    [...live.namespaces.values()].some((n) => n.metadata.name === ns),
    "unexpected Kubernetes Namespace",
  );
  if (parts.length === 4 && request.method === "GET") {
    send(
      response,
      200,
      [...live.namespaces.values()].find((n) => n.metadata.name === ns),
    );
    return;
  }
  if (parts[4] === "configmaps") {
    if (parts.length === 5 && request.method === "POST") {
      const value = await body(request);
      const metadata = safeObject(value.metadata);
      const name = textField(metadata, "name");
      const stored = {
        ...value,
        metadata: { ...metadata, namespace: ns, uid: randomUUID(), resourceVersion: "1" },
      };
      live.configMaps.set(name, stored);
      send(response, 201, stored);
      return;
    }
    if (parts.length === 6 && request.method === "GET") {
      const value = live.configMaps.get(parts[5]!);
      if (value) {
        send(response, 200, value);
      } else {
        status(response, 404);
      }
      return;
    }
    throw new Error("unexpected ConfigMap operation");
  }
  assert.equal(parts[4], "secrets");
  if (parts.length === 5 && request.method === "POST") {
    const value = (await body(request)) as unknown as Secret;

    assert.equal(value.metadata.namespace, ns);
    const name = value.metadata.name;
    const mode = live.createModes.get(name);
    record("secret-post", name, "requested");
    live.beforeSecretCreate?.(name);
    if (mode === "before503") {
      status(response, 503);
      return;
    }
    if (mode === "beforeReset") {
      response.destroy();
      return;
    }
    if (live.secrets.has(name)) {
      status(response, 409);
      return;
    }
    const stored: Secret = {
      ...value,
      apiVersion: "v1",
      kind: "Secret",
      metadata: {
        ...value.metadata,
        uid: randomUUID(),
        resourceVersion: String(live.events.length + 1),
      },
      data: {
        ...value.data,
        ...Object.fromEntries(
          Object.entries(value.stringData ?? {}).map(([k, v]) => [
            k,
            Buffer.from(v).toString("base64"),
          ]),
        ),
      },
    };
    delete stored.stringData;
    live.secrets.set(name, stored);
    persist("kubernetes");
    record("secret-post", name, "persisted");
    const hook = live.afterStored.get(name);
    live.afterStored.delete(name);
    hook?.();
    if (mode === "drop") {
      response.destroy();
      return;
    }
    send(response, 201, stored);
    return;
  }
  assert.equal(parts.length, 6);
  const name = parts[5]!;
  if (request.method === "GET") {
    const observed = structuredClone(live.secrets.get(name));
    record("secret-get", name, observed ? "found" : "absent");
    await live.beforeSecretRead?.(name);
    if (observed) {
      send(response, 200, observed);
    } else {
      status(response, 404);
    }
    return;
  }
  if (request.method === "PUT") {
    const value = (await body(request)) as unknown as Secret;
    const current = live.secrets.get(name);
    if (!current) {
      status(response, 404);
      return;
    }
    if (value.metadata.resourceVersion !== current.metadata.resourceVersion) {
      status(response, 409);
      return;
    }
    const stored: Secret = {
      ...value,
      apiVersion: "v1",
      kind: "Secret",
      metadata: {
        ...value.metadata,
        uid: current.metadata.uid,
        resourceVersion: String(Number(current.metadata.resourceVersion) + 1),
      },
      data: {
        ...value.data,
        ...Object.fromEntries(
          Object.entries(value.stringData ?? {}).map(([key, data]) => [
            key,
            Buffer.from(data).toString("base64"),
          ]),
        ),
      },
    };
    delete stored.stringData;
    live.secrets.set(name, stored);
    record("secret-put", name, "persisted");
    send(response, 200, stored);
    return;
  }
  assert.equal(request.method, "DELETE");
  const value = await body(request);
  live.beforeSecretDelete?.(name, value);
  const current = live.secrets.get(name);
  if (!current) {
    status(response, 404);
    return;
  }
  const pre = value.preconditions === undefined ? {} : safeObject(value.preconditions);
  if (
    (pre.uid !== undefined && pre.uid !== current.metadata.uid) ||
    (pre.resourceVersion !== undefined && pre.resourceVersion !== current.metadata.resourceVersion)
  ) {
    record("secret-delete", name, "precondition-conflict");
    status(response, 409);
    return;
  }
  record("secret-delete", name, "applied");
  live.secrets.delete(name);
  persist("kubernetes");
  send(response, 200, { apiVersion: "v1", kind: "Status", status: "Success", code: 200 });
}
function guardedHandler(handler: (q: IncomingMessage, s: ServerResponse) => Promise<void>) {
  return (q: IncomingMessage, s: ServerResponse) => {
    void handler(q, s).catch(() => {
      live.faults.push(
        "unexpected " + q.method + " " + new URL(q.url ?? "/", "https://localhost").pathname,
      );
      if (!s.headersSent) {
        send(s, 500, { error: "fixture-contract" });
      } else {
        s.destroy();
      }
    });
  };
}
async function request(
  method: string,
  path: string,
  payload?: string,
  key: string | null = live.key,
  url = live.mainUrl,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      url + path,
      {
        method,
        headers: {
          ...(key === null ? {} : { "x-api-key": key }),
          ...(payload === undefined
            ? {}
            : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }),
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (text += c));
        res.on("end", () =>
          resolve({
            status: res.statusCode!,
            body: text === "" ? {} : safeObject(JSON.parse(text) as unknown),
            text,
          }),
        );
      },
    );
    req.on("error", reject);
    req.setTimeout(20_000, () => req.destroy(new Error("OCC request timed out")));
    req.end(payload);
  });
}
function expect(r: Reply, wanted: number, code?: string): void {
  assert.equal(
    r.status,
    wanted,
    `HTTP status at ${new Error().stack?.split("\n")[2]?.trim()}; ${JSON.stringify(r.body.error ?? live.diagnostics.at(-1) ?? {})}`,
  );
  if (code) {
    assert.equal(safeObject(r.body.error).code, code, "canonical error code");
  }
}
function issue(
  a: Account,
  options: { key?: string; url?: string; payload?: string; query?: string } = {},
): Promise<Reply> {
  return request(
    "POST",
    "/namespaces/" +
      live.namespaceId +
      "/service-accounts/" +
      a.id +
      "/credentials" +
      (options.query ?? ""),
    options.payload ?? "{}",
    options.key ?? live.key,
    options.url ?? live.mainUrl,
  );
}
async function account(label: string): Promise<Account> {
  const name = "Recovery " + label + " " + randomUUID().slice(0, 8);
  const r = await request(
    "POST",
    "/namespaces/" + live.namespaceId + "/service-accounts",
    JSON.stringify({ name }),
  );
  expect(r, 201);
  const id = textField(data(r), "id");
  const result = await live.pool!.query<{ external_account_id: string }>(
    "SELECT external_account_id FROM occ.service_account_driver_bindings WHERE service_account_id=$1 AND namespace_id=$2",
    [id, live.namespaceId],
  );
  assert.equal(result.rowCount, 1);
  return { id, externalId: result.rows[0]!.external_account_id, name };
}
async function binding(
  a: Account,
): Promise<{ credential: unknown; external_credential_id: string | null } | undefined> {
  return (
    await live.pool!.query<{ credential: unknown; external_credential_id: string | null }>(
      "SELECT s.credential,b.external_credential_id FROM occ.service_accounts s JOIN occ.service_account_driver_bindings b ON b.service_account_id=s.id WHERE s.id=$1 AND s.namespace_id=$2",
      [a.id, live.namespaceId],
    )
  ).rows[0];
}
async function noBinding(a: Account): Promise<void> {
  assert.deepEqual(
    await binding(a),
    { credential: null, external_credential_id: null },
    "failed issuance must roll back both fields",
  );
}
async function startApp(
  url: string,
  selected = true,
  name = live.appName,
  mismatch?: "backend" | "workspace",
): Promise<string> {
  let configPath = selected ? live.configPath : live.noDriverConfigPath;
  if (mismatch !== undefined) {
    const configuration = safeObject(
      JSON.parse(await readFile(live.configPath, "utf8")) as unknown,
    );
    assert.ok(Array.isArray(configuration.backend));
    const definition = safeObject(configuration.backend[0]);
    if (mismatch === "backend") {
      definition.id = "different-chatgpt";
    } else {
      safeObject(definition.configuration).workspaceId = randomUUID();
    }
    configPath = join(live.directory, "installation-" + mismatch + ".json");
    await writeFile(configPath, JSON.stringify(configuration), { mode: 0o600 });
  }
  const runtime =
    live.apps.length === 0 && selected && mismatch === undefined
      ? live.runtime
      : await loadInstallationConfiguration({
          mode: "development",
          environment: { OCC_CONFIG_PATH: configPath },
        });
  assert.ok(runtime);
  assert.ok(runtime.computeDriver instanceof KubernetesComputeDriver);
  const auditEventFactory = new AuditEventFactory({
    idGenerator: () => {
      const next = live.auditNext;
      live.auditNext = undefined;
      return next?.() ?? "aud_" + randomUUID();
    },
  });
  const configured = new URL(url);
  configured.searchParams.set("application_name", name);
  const definition = runtime.installation.backend.find((entry) => entry.type === "chatgpt");
  const factory = selected
    ? (() => {
        assert.ok(definition?.type === "chatgpt");
        const register = createChatGPTServiceAccountDriverFactory({
          id: definition.id,
          drivers: definition.drivers,
          client: new ChatGPTClient({
            workspaceId: definition.configuration.workspaceId,
            adminKey: live.adminKey,
            credentialTtlSeconds: 3600,
          }),
        });
        return ((controller, state) => {
          live.state = state;
          live.controller = controller;
          register(controller, state);
        }) satisfies typeof register;
      })()
    : undefined;
  const app = await composePostgresDevelopment(
    {
      mode: "development",
      host: "127.0.0.1",
      databaseUrl: configured.toString(),
      authSecret: live.authSecret,
      authBaseURL: live.authBaseURL,
      nativeAdmin: { enabled: false, domain: "agents.oce.localhost" },
      logger: createOccLogger({
        component: "service-account-compensation-test",
        destination: {
          write(line: string) {
            const value = safeObject(JSON.parse(line) as unknown);
            if (value.event === "http.dependency_unavailable") {
              live.diagnostics.push({
                event: value.event,
                errorClass: value.errorClass,
                message: value.message,
                causes: value.causes,
              });
            }
          },
        },
      }),
    },
    { ...runtime, auditEventFactory },
    factory,
  );
  live.apps.push(app);
  await app.ready();
  return app.listen({ host: "127.0.0.1", port: 0 });
}
async function prepare(): Promise<void> {
  assert.ok(databaseUrl, "focused Postgres lane must supply a real database");
  live.directory = await mkdtemp(join(tmpdir(), "oce-sa-compensation-"));
  await chmod(live.directory, 0o700);
  persist("provider");
  persist("kubernetes");
  const ca = await certificateAuthority(live.directory, {
    caName: "ServiceAccount compensation fixture",
    caKeyPem: undefined,
  });
  const cert = await readFile(ca.caPath, "utf8");
  const providerLeaf = await signedLeaf(live.directory, ca, {
    name: "provider",
    keyPem: undefined,
    commonName: "api.chatgpt.com",
    subjectAltName: "DNS:api.chatgpt.com",
  });
  const kubeLeaf = await signedLeaf(live.directory, ca, {
    name: "kubernetes",
    keyPem: undefined,
    commonName: "localhost",
    subjectAltName: "DNS:localhost,IP:127.0.0.1",
  });
  live.provider = createServer(providerLeaf, guardedHandler(providerHandler));
  live.kube = createServer(kubeLeaf, guardedHandler(kubeHandler));
  live.provider.listen(0, "127.0.0.1");
  await once(live.provider, "listening");
  live.kube.listen(0, "127.0.0.1");
  await once(live.kube, "listening");
  const pa = live.provider.address();
  const ka = live.kube.address();
  assert.ok(pa && typeof pa !== "string" && ka && typeof ka !== "string");
  const connector = buildConnector({ ca: cert, allowH2: false });
  live.agent = new Agent({
    connect: (options, callback) => {
      assert.equal(options.hostname, "api.chatgpt.com", "unexpected native fetch authority");
      assert.equal(String(options.port || "443"), "443");
      assert.equal(options.protocol, "https:");
      return connector(
        { ...options, hostname: "127.0.0.1", port: String(pa.port), servername: "api.chatgpt.com" },
        callback,
      );
    },
  });
  const kubeconfigPath = join(live.directory, "kubeconfig.json");
  await writeFile(
    kubeconfigPath,
    JSON.stringify({
      apiVersion: "v1",
      kind: "Config",
      clusters: [
        {
          name: "fixture",
          cluster: {
            server: "https://127.0.0.1:" + ka.port,
            "certificate-authority-data": Buffer.from(cert).toString("base64"),
          },
        },
      ],
      users: [{ name: "fixture", user: { token: live.kubeKey } }],
      contexts: [{ name: "fixture", context: { cluster: "fixture", user: "fixture" } }],
      "current-context": "fixture",
    }),
    { mode: 0o600 },
  );
  const auth = { mode: "kubeconfig" as const, kubeconfigPath, context: "fixture" };
  const conf = buildSandboxInstallation();
  conf.occ.cluster = "compensation-fixture";
  for (const x of [conf.drivers.compute, conf.drivers.configuration, conf.drivers.secret]) {
    x.configuration.authentication = auth;
  }
  const adminPath = join(live.directory, "provider-key");
  await writeFile(adminPath, live.adminKey, { mode: 0o600 });
  const configPath = join(live.directory, "installation.json");
  await writeFile(
    configPath,
    JSON.stringify({
      ...conf,
      iam: defaultUsersIAM(),
      presets: { includeDefaults: false },
      backend: [
        ...conf.backend,
        {
          id: "recovery-chatgpt",
          type: "chatgpt",
          configuration: {
            workspaceId: live.workspaceId,
            apiKeyPath: adminPath,
            credentialTtlSeconds: 3600,
          },
          drivers: { service_account: "recovery-service-account" },
        },
      ],
      drivers: {
        ...conf.drivers,
        service_account: { id: "recovery-service-account", configuration: {} },
        token_service: { id: "occ", configuration: {} },
      },
    }),
    { mode: 0o600 },
  );
  live.configPath = configPath;
  live.noDriverConfigPath = join(live.directory, "installation-no-driver.json");
  const unselected = safeObject(JSON.parse(await readFile(configPath, "utf8")) as unknown);
  delete safeObject(unselected.drivers).service_account;
  unselected.backend = [];
  await writeFile(live.noDriverConfigPath, JSON.stringify(unselected), { mode: 0o600 });
  const boot = await ensureDevelopmentBootstrap(
    { after: () => {} },
    {
      databaseUrl,
      directory: live.directory,
      email: "recovery-" + randomUUID() + "@example.test",
      password: randomUUID() + randomUUID(),
      authSecret: live.authSecret,
      authBaseURL: live.authBaseURL,
      installationName: "ServiceAccount compensation",
      inProcess: true,
    },
  );
  const bootstrapResult = boot.result.stdout
    .trim()
    .split("\n")
    .map((line: string) => safeObject(JSON.parse(line) as unknown))
    .find((event: Record<string, unknown>) => event.event === "installation.bootstrapped");
  assert.ok(bootstrapResult);
  live.key = await readFile(boot.environment.OCC_BOOTSTRAP_SERVICE_KEY_INPUT_FILE, "utf8");
  live.keyId = textField(bootstrapResult, "serviceKeyId");
  live.runtime = await loadInstallationConfiguration({
    mode: "development",
    environment: { OCC_CONFIG_PATH: configPath },
  });
  assert.ok(live.runtime);
  assert.ok(live.runtime.computeDriver instanceof KubernetesComputeDriver);
  live.pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 3,
    application_name: "sa-comp-observer-" + randomUUID(),
  });
  setGlobalDispatcher(live.agent);
  live.namespaces.set("oce-installation-secrets", {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: { name: "oce-installation-secrets" },
    status: { phase: "Active" },
  });
  live.mainUrl = await startApp(databaseUrl);
  const ns = await request(
    "POST",
    "/namespaces",
    JSON.stringify({ name: "Compensation " + randomUUID().slice(0, 8) }),
  );
  expect(ns, 201);
  live.namespaceId = textField(data(ns), "id");
  const n = kubernetesNamespaceName(live.namespaceId);
  live.namespaces.set(n, {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: n,
      uid: randomUUID(),
      resourceVersion: "1",
      labels: {
        "app.kubernetes.io/managed-by": "openclaw-enterprise",
        "openclaw.dev/namespace": live.namespaceId,
        "openclaw.dev/gateway-namespace": live.namespaceId,
      },
      annotations: { "openclaw.dev/namespace-id": live.namespaceId },
    },
    status: { phase: "Active" },
  });
  persist("kubernetes");
  live.duplicateAuditId = (
    await live.pool.query<{ id: string }>(
      "SELECT id FROM occ.audit_events ORDER BY occurred_at,id LIMIT 1",
    )
  ).rows[0]!.id;
}
afterEach(() => {
  live.auditNext = undefined;
  live.afterStored.clear();
  live.beforeSecretCreate = undefined;
});

before(async () => {
  if (databaseUrl) {
    await prepare();
  }
});
after(async () => {
  live.auditNext = undefined;
  live.beforeProviderDelete = undefined;
  live.beforeProviderCreate = undefined;
  live.beforeSecretRead = undefined;
  live.beforeSecretDelete = undefined;
  for (const proxy of live.proxies) {
    await proxy.close().catch(() => {});
  }
  for (const app of live.apps.reverse()) {
    await app.close();
  }
  await live.pool?.end();
  setGlobalDispatcher(live.originalDispatcher);
  await live.agent?.destroy();
  if (live.provider) {
    await closeServer(live.provider);
  }
  if (live.kube) {
    await closeServer(live.kube);
  }
  if (live.directory) {
    await rm(live.directory, { recursive: true, force: true });
  }
  assert.deepEqual(live.faults, [], "wire fixtures accepted every genuine request");
});

test(
  "fresh issued ServiceAccount PAT uses TokenService custody and preserves independent Source lifecycle",
  requiresPostgres,
  async () => {
    const a = await account("fresh");
    const first = await issue(a);
    expect(first, 409);
    assert.equal(providerEvents(a).length, 0, "a provisioning Namespace cannot mint a PAT");
    await live.state!.transact(async (unit) => {
      const updated = await unit.namespaces.transitionNamespaceStatus(
        live.namespaceId,
        "provisioning",
        "ready",
      );
      assert.equal(updated?.status, "ready");
    });
    const principal = await request(
      "POST",
      `/namespaces/${live.namespaceId}/iam/service-principals`,
      "{}",
    );
    expect(principal, 201);
    const principalId = textField(data(principal), "id");
    const keyReply = await request(
      "POST",
      "/api/auth/service-keys",
      JSON.stringify({
        servicePrincipalId: principalId,
        namespaceId: live.namespaceId,
        name: "issuer permission check",
      }),
    );
    expect(keyReply, 201);
    const key = textField(data(keyReply), "key");
    const role = await request(
      "POST",
      `/namespaces/${live.namespaceId}/iam/roles`,
      JSON.stringify({
        name: `Issuer ${randomUUID()}`,
        permissions: [{ action: "update", resourceKind: "service_account" }],
      }),
    );
    expect(role, 201);
    expect(
      await request(
        "POST",
        `/namespaces/${live.namespaceId}/iam/access-bindings`,
        JSON.stringify({
          subjectKind: "identity",
          subjectId: principalId,
          roleId: textField(data(role), "id"),
          resourceKind: "service_account",
          resourceId: a.id,
        }),
      ),
      201,
    );
    expect(await issue(a, { key }), 403, "FORBIDDEN");
    assert.equal(
      providerEvents(a).length,
      0,
      "Source create authority must be checked before issuer mint",
    );

    // Namespace-level create grants are provisioned by Installation IAM, not by the exact-resource Namespace role API.
    const creatorRoleId = `role-${randomUUID()}`;
    await live.pool!.query(
      "INSERT INTO occ.iam_roles(id,name,permissions) VALUES($1,$2,$3::jsonb)",
      [
        creatorRoleId,
        "Fresh Source creator",
        JSON.stringify([
          { action: "create", resourceKind: "credential_source" },
          { action: "create", resourceKind: "agent" },
          { action: "read", resourceKind: "configuration" },
          { action: "read", resourceKind: "namespace" },
        ]),
      ],
    );
    await live.pool!.query(
      "INSERT INTO occ.iam_access_bindings(id,namespace_id,identity_subject_id,role_id) VALUES($1,$2,$3,$4)",
      [`binding-${randomUUID()}`, live.namespaceId, principalId, creatorRoleId],
    );
    const issued = await issue(a, { key });
    expect(issued, 201);
    const credential = safeObject(data(issued).credential);
    assert.equal(credential.kind, "access_token");
    const sourceId = textField(credential, "sourceId");
    assert.match(sourceId, /^cs_/);
    const c = credentialFor(a);
    assert.ok(
      !issued.text.includes(c.id) && !issued.text.includes(c.token),
      "public reply must exclude issuer identities and bearer",
    );
    assert.equal((await binding(a))?.external_credential_id, c.id);
    const sourceReply = await request(
      "GET",
      `/namespaces/${live.namespaceId}/credential-sources/${sourceId}`,
    );
    expect(sourceReply, 200);
    const source = data(sourceReply);
    assert.equal(
      Object.hasOwn(source, "ownerCapability"),
      false,
      "public Source metadata excludes private custody owner",
    );
    const storedSource = await live.state!.read((view) =>
      view.credentialSources.findCredentialSource(live.namespaceId, sourceId),
    );
    assert.ok(storedSource?.ownerCapability === "token_service" && storedSource.type === "static");
    const owner = live.controller!.selectedDriver("token_service");
    const resolved = await owner.resolveCredential(
      {
        sourceRef: { kind: "credential_source", namespaceId: live.namespaceId, id: sourceId },
        tokenServiceInstanceId: storedSource.tokenServiceInstanceId,
      },
      AbortSignal.timeout(5_000),
    );
    assert.equal(
      resolved.credential === c.token,
      true,
      "selected TokenService holds the issued bearer",
    );
    assert.equal(source.type, "static");
    assert.deepEqual(source.config, { provider_preset: "codex-pat" });
    assert.equal(
      [...live.secrets.values()].some((x) => x.metadata.name.startsWith("service-account-")),
      false,
      "no second ServiceAccount bearer Secret is created",
    );
    expect(
      await request("DELETE", `/namespaces/${live.namespaceId}/credential-sources/${sourceId}`),
      409,
      "RESOURCE_CONFLICT",
    );

    const config = await request(
      "POST",
      `/namespaces/${live.namespaceId}/configurations`,
      JSON.stringify({ kind: "agent", values: createHarnessConfiguration("codex", "gpt-4.1") }),
    );
    expect(config, 201);
    const boundAgent = await request(
      "POST",
      `/namespaces/${live.namespaceId}/agents`,
      JSON.stringify({
        name: `Issued PAT Agent ${randomUUID()}`,
        configurationId: textField(data(config), "id"),
        executionMode: "dedicated",
        harnessAuth: { method: "credential_source", sourceId },
        credentialSources: [{ sourceId }],
      }),
      key,
    );
    expect(boundAgent, 201);
    assert.deepEqual(
      data(boundAgent).credentialSources,
      [{ sourceId }],
      "the restricted issuer can select the Source using its creator operate grant",
    );
    // Source binding is independent from the issuer account. Deleting the account must revoke
    // the exact issuer credential while leaving the bound Agent and ordinary Source retirement intact.
    const deleted = await request(
      "DELETE",
      `/namespaces/${live.namespaceId}/service-accounts/${a.id}`,
    );
    expect(deleted, 204);
    assert.ok(!live.credentials.has(c.id), "issuer credential must be revoked");
    expect(
      await request("GET", `/namespaces/${live.namespaceId}/credential-sources/${sourceId}`),
      200,
    );
    const retainedAgent = await request(
      "GET",
      `/namespaces/${live.namespaceId}/agents/${textField(data(boundAgent), "id")}`,
    );
    expect(retainedAgent, 200);
    assert.deepEqual(data(retainedAgent).credentialSources, [{ sourceId }]);
    assert.equal(
      (
        await live.pool!.query(
          "SELECT 1 FROM occ.service_account_driver_bindings WHERE service_account_id=$1",
          [a.id],
        )
      ).rowCount,
      0,
    );

    // An audit collision after Source registration is a known finalization failure. The normal
    // rollback callback must revoke the issuer credential before removing its custody Source.
    const failed = await account("known-finalization");
    const beforeSources = (
      await live.pool!.query(
        "SELECT count(*)::int AS n FROM occ.credential_sources WHERE namespace_id=$1",
        [live.namespaceId],
      )
    ).rows[0].n;
    const beforeCustody = new Set(live.secrets.keys());
    live.beforeSecretCreate = (name) => {
      if (name.startsWith("occ-private-")) {
        live.afterStored.set(name, () => {
          live.auditNext = () => {
            live.auditConsumed++;
            return live.duplicateAuditId;
          };
        });
      }
    };
    const failedReply = await issue(failed);
    live.beforeSecretCreate = undefined;
    expect(failedReply, 409, "RESOURCE_CONFLICT");
    assert.equal(providerEvents(failed).length, 1);
    assert.equal(
      [...live.credentials.values()].filter((x) => x.accountId === failed.externalId).length,
      0,
      "known rollback revokes the newly minted issuer credential",
    );
    await noBinding(failed);
    assert.equal(
      (
        await live.pool!.query(
          "SELECT count(*)::int AS n FROM occ.credential_sources WHERE namespace_id=$1",
          [live.namespaceId],
        )
      ).rows[0].n,
      beforeSources,
      "known failed association removes newly registered Source",
    );
    assert.deepEqual(
      [...live.secrets.keys()].filter((name) => !beforeCustody.has(name)),
      [],
      "known failed association removes newly created private custody",
    );
  },
);
