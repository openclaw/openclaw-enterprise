import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
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
import { certificateAuthority, signedLeaf } from "../helpers/certificates.mjs";
import { ensureDevelopmentBootstrap } from "../helpers/bootstrap-installation.mjs";
import { createInstallationDriverConfiguration } from "../helpers/installation-driver-configuration.mjs";
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
const annotation = "openclaw.dev/provider-credential-id";
const safeObject = (x: unknown): Json => {
  assert.ok(x !== null && typeof x === "object" && !Array.isArray(x));
  return x as Json;
};
const textField = (x: Json, k: string): string => {
  assert.equal(typeof x[k], "string");
  return x[k] as string;
};
const data = (r: Reply): Json => safeObject(r.body.data);
const secretName = (id: string): string =>
  "service-account-" + createHash("sha256").update(id).digest("hex").slice(0, 32);
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function until(
  predicate: () => Promise<boolean> | boolean,
  label: string,
  ms = 10_000,
): Promise<void> {
  const end = Date.now() + ms;
  while (!(await predicate())) {
    if (Date.now() >= end) {
      throw new Error(label);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}
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
  compute: undefined as KubernetesComputeDriver | undefined,
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
function secret(id: string): Secret | undefined {
  return live.secrets.get(secretName(id));
}
function durableSecret(id: string): Secret | undefined {
  const value = safeObject(
    JSON.parse(readFileSync(join(live.directory, "kubernetes.json"), "utf8")) as unknown,
  );
  return new Map(value.secrets as [string, Secret][]).get(secretName(id));
}
function credentialFor(a: Account): Credential {
  const found = [...live.credentials.values()].find((x) => x.accountId === a.externalId);
  assert.ok(found, "expected one synthetic provider credential");
  return found;
}
function seedSecret(a: Account, credentialId: string, token: string = randomUUID()): Secret {
  const name = secretName(a.id);
  const s: Secret = {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name,
      namespace: kubernetesNamespaceName(live.namespaceId),
      uid: randomUUID(),
      resourceVersion: String(live.events.length + 1),
      labels: {
        "app.kubernetes.io/managed-by": "openclaw-enterprise",
        "openclaw.dev/namespace": live.namespaceId,
        "openclaw.dev/service-account": a.id,
      },
      annotations: {
        "openclaw.dev/namespace-id": live.namespaceId,
        "openclaw.dev/service-account-id": a.id,
        [annotation]: credentialId,
      },
    },
    type: "Opaque",
    data: { token: Buffer.from(token).toString("base64") },
  };
  live.secrets.set(name, s);
  persist("kubernetes");
  return s;
}
function armAudit(a: Account): void {
  live.afterStored.set(secretName(a.id), () => {
    live.auditNext = () => {
      live.auditConsumed++;
      return live.duplicateAuditId;
    };
  });
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
  assert.equal(parts[4], "secrets");
  if (parts.length === 5 && request.method === "POST") {
    const value = (await body(request)) as unknown as Secret;
    assert.equal(value.kind, "Secret");
    assert.equal(value.apiVersion, "v1");
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
  assert.equal(r.status, wanted, "HTTP status; " + JSON.stringify(live.diagnostics.at(-1) ?? {}));
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
function retained(a: Account, c: Credential): void {
  const s = durableSecret(a.id);
  assert.ok(s, "recovery receipt must remain after unconfirmed provider revocation");
  assert.equal(s.metadata.annotations?.[annotation], c.id, "receipt credential ID");
  assert.ok(
    s.data?.token === Buffer.from(c.token).toString("base64"),
    "receipt token must match without disclosure",
  );
  assert.ok(s.metadata.uid && s.metadata.resourceVersion, "persisted Secret identity");
  assert.ok(live.credentials.has(c.id), "provider credential remains live");
}
function order(a: Account, c: Credential, start = 0): void {
  const e = live.events.slice(start);
  const confirmed = e.findIndex(
    (x) =>
      x.operation === "credential-delete" &&
      x.id === a.externalId + "/" + c.id &&
      (x.outcome === "confirmed" ||
        x.outcome.startsWith("reply-credential_not_found") ||
        x.outcome.startsWith("reply-service_account_not_found")),
  );
  const removed = e.findIndex(
    (x) => x.operation === "secret-delete" && x.id === secretName(a.id) && x.outcome === "applied",
  );
  assert.ok(
    confirmed >= 0 && removed > confirmed,
    "provider confirmation must precede exact Secret deletion",
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
        return createChatGPTServiceAccountDriverFactory(
          {
            id: definition.id,
            drivers: definition.drivers,
            client: new ChatGPTClient({
              workspaceId: definition.configuration.workspaceId,
              adminKey: live.adminKey,
              credentialTtlSeconds: 3600,
            }),
          },
          runtime.computeDriver,
        );
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
  const conf = createInstallationDriverConfiguration();
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
      presets: { includeDefaults: false },
      backend: [
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
  const bootstrapKey = safeObject(
    safeObject(
      JSON.parse(
        await readFile(boot.environment.OCC_BOOTSTRAP_SERVICE_KEY_FILE, "utf8"),
      ) as unknown,
    ).data,
  );
  live.key = textField(bootstrapKey, "key");
  live.keyId = textField(bootstrapKey, "id");
  live.runtime = await loadInstallationConfiguration({
    mode: "development",
    environment: { OCC_CONFIG_PATH: configPath },
  });
  assert.ok(live.runtime);
  assert.ok(live.runtime.computeDriver instanceof KubernetesComputeDriver);
  live.compute = live.runtime.computeDriver;
  live.pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 3,
    application_name: "sa-comp-observer-" + randomUUID(),
  });
  setGlobalDispatcher(live.agent);
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
  "known audit rollback retains the exact recovery receipt when provider revocation fails",
  requiresPostgres,
  async () => {
    const a = await account("audit-retain");
    armAudit(a);
    live.deleteModes.set(a.externalId, "503");
    const before = live.auditConsumed;
    const r = await issue(a);
    expect(r, 503, "DEPENDENCY_UNAVAILABLE");
    assert.equal(live.auditConsumed, before + 1, "real audit collision consumed");
    await noBinding(a);
    const c = credentialFor(a);
    retained(a, c);
    assert.equal(providerEvents(a).length, 1);
  },
);
test(
  "HTTP retry is blocked until the retained provider credential is confirmed revoked",
  requiresPostgres,
  async () => {
    const a = await account("retry");
    armAudit(a);
    live.deleteModes.set(a.externalId, "503");
    expect(await issue(a), 503, "DEPENDENCY_UNAVAILABLE");
    const c = credentialFor(a);
    const start = live.events.length;
    expect(await issue(a), 503, "DEPENDENCY_UNAVAILABLE");
    assert.equal(providerEvents(a).length, 1, "retry cannot mint before revocation");
    live.deleteModes.delete(a.externalId);
    const r = await issue(a);
    expect(r, 201);
    order(a, c, start);
    assert.equal(providerEvents(a).length, 2);
    assert.ok(!live.credentials.has(c.id));
    const next = credentialFor(a);
    assert.equal((await binding(a))?.external_credential_id, next.id);
    assert.ok(
      !r.text.includes(next.id) &&
        !r.text.includes(next.token) &&
        !r.text.includes(secretName(a.id)),
      "public projection excludes private locator and provider identity",
    );
  },
);
test(
  "applied but unacknowledged Kubernetes create retains a recoverable credential ID",
  requiresPostgres,
  async () => {
    const a = await account("applied-create");
    armAudit(a);
    live.createModes.set(secretName(a.id), "drop");
    live.deleteModes.set(a.externalId, "503");
    const r = await issue(a);
    expect(r, 503, "DEPENDENCY_UNAVAILABLE");
    await noBinding(a);
    const c = credentialFor(a);
    assert.equal(
      live.events.filter(
        (x) =>
          x.operation === "secret-post" && x.id === secretName(a.id) && x.outcome === "requested",
      ).length,
      1,
      "mutating create cannot replay",
    );
    assert.ok(
      live.events.some(
        (x) => x.operation === "secret-get" && x.id === secretName(a.id) && x.outcome === "found",
      ),
      "real SDK readback",
    );
    retained(a, c);
    live.createModes.delete(secretName(a.id));
    expect(await issue(a), 503, "DEPENDENCY_UNAVAILABLE");
    assert.equal(providerEvents(a).length, 1);
    live.deleteModes.delete(a.externalId);
    const start = live.events.length;
    expect(await issue(a), 201);
    order(a, c, start);
    assert.equal(providerEvents(a).length, 2);
  },
);
test(
  "confirmed revocation cleans only its matching Secret after either failed issuance entrance",
  requiresPostgres,
  async () => {
    for (const applied of [false, true]) {
      const a = await account(applied ? "clean-applied" : "clean-audit");
      armAudit(a);
      if (applied) {
        live.createModes.set(secretName(a.id), "drop");
      }
      const start = live.events.length;
      const r = await issue(a);
      expect(r, 409, "RESOURCE_CONFLICT");
      await noBinding(a);
      const event = providerEvents(a)[0]!;
      const id = event.id.slice(a.externalId.length + 1);
      order(a, { id, accountId: a.externalId, occId: a.id, token: "" }, start);
      assert.equal(secret(a.id), undefined);
      assert.ok(!live.credentials.has(id));
      live.createModes.delete(secretName(a.id));
      expect(await issue(a), 201);
    }
    const a = await account("readback-success");
    live.createModes.set(secretName(a.id), "drop");
    expect(await issue(a), 201);
    assert.equal(providerEvents(a).length, 1);
    assert.equal((await binding(a))?.external_credential_id, credentialFor(a).id);
  },
);
test("recognized already-absent provider replies complete recovery", requiresPostgres, async () => {
  for (const mode of ["credential404", "account404"] as const) {
    const a = await account(mode);
    armAudit(a);
    live.deleteModes.set(a.externalId, "503");
    expect(await issue(a), 503);
    const c = credentialFor(a);
    live.credentials.delete(c.id);
    persist("provider");
    live.deleteModes.set(a.externalId, mode);
    const start = live.events.length;
    expect(await issue(a), 201);
    order(a, c, start);
    assert.equal(providerEvents(a).length, 2);
    live.deleteModes.delete(a.externalId);
  }
});
test(
  "unconfirmed provider failures keep the receipt and block replacement",
  requiresPostgres,
  async () => {
    for (const mode of [
      "unknown404",
      "403",
      "503",
      "invalidJson",
      "wrongId",
      "notDeleted",
      "lostReply",
    ] as const) {
      const a = await account(mode);
      armAudit(a);
      live.deleteModes.set(a.externalId, "503");
      expect(await issue(a), 503);
      const c = credentialFor(a);
      live.deleteModes.set(a.externalId, mode);
      expect(await issue(a), 503, "DEPENDENCY_UNAVAILABLE");
      assert.ok(durableSecret(a.id), "unconfirmed provider reply must retain receipt");
      assert.equal(providerEvents(a).length, 1, "unconfirmed recovery must not mint");
      if (mode === "lostReply") {
        assert.ok(!live.credentials.has(c.id));
        live.deleteModes.set(a.externalId, "credential404");
        expect(await issue(a), 201);
        assert.equal(providerEvents(a).length, 2);
      }
      live.deleteModes.delete(a.externalId);
    }
  },
);
test(
  "a Kubernetes create that never applied leaves foreign or unrelated objects untouched",
  requiresPostgres,
  async () => {
    for (const mode of ["before503", "beforeReset"] as const) {
      const a = await account(mode);
      live.createModes.set(secretName(a.id), mode);
      expect(await issue(a), 503, "DEPENDENCY_UNAVAILABLE");
      assert.equal(secret(a.id), undefined);
      assert.equal(
        [...live.credentials.values()].filter((c) => c.accountId === a.externalId).length,
        0,
      );
    }
    for (const foreign of [true, false]) {
      const a = await account(foreign ? "foreign" : "other-token");
      live.createModes.set(secretName(a.id), "before503");
      live.beforeSecretCreate = (name) => {
        if (name === secretName(a.id)) {
          const s = seedSecret(a, "unrelated-id");
          if (foreign) {
            s.metadata.labels!["openclaw.dev/service-account"] = "other";
          }
          persist("kubernetes");
        }
      };
      try {
        expect(await issue(a), 503, "DEPENDENCY_UNAVAILABLE");
        const observed = secret(a.id);
        assert.ok(observed);
        assert.equal(observed.metadata.annotations?.[annotation], "unrelated-id");
        assert.equal(
          [...live.credentials.values()].filter((c) => c.accountId === a.externalId).length,
          0,
        );
      } finally {
        live.beforeSecretCreate = undefined;
      }
    }
  },
);
test("delayed compensation cannot delete another issuance's Secret", requiresPostgres, async () => {
  const a = await account("delayed");
  armAudit(a);
  const held = deferred();
  const release = deferred();
  let oldId = "";
  let first = true;
  live.beforeProviderDelete = async (id) => {
    if (first) {
      first = false;
      oldId = id;
      held.resolve();
      await release.promise;
    }
  };
  const pending = issue(a);
  try {
    await held.promise;
    await noBinding(a);
    expect(await issue(a), 201);
    const replacementId = (await binding(a))?.external_credential_id;
    assert.ok(replacementId);
    const replacement = live.credentials.get(replacementId);
    assert.ok(replacement);
    assert.notEqual(replacement.id, oldId);
    release.resolve();
    expect(await pending, 409, "RESOURCE_CONFLICT");
    assert.equal((await binding(a))?.external_credential_id, replacement.id);
    assert.equal(secret(a.id)?.metadata.annotations?.[annotation], replacement.id);
    assert.ok(live.credentials.has(replacement.id));
  } finally {
    release.resolve();
    live.beforeProviderDelete = undefined;
    await pending.catch(() => {});
  }
});

test(
  "exact cleanup respects ownership, credential ID, UID and resourceVersion",
  requiresPostgres,
  async () => {
    const a = await account("exact");
    const original = "synthetic-exact-" + randomUUID();
    const input = {
      namespaceId: live.namespaceId,
      serviceAccountId: a.id,
      secretRef: { name: secretName(a.id), key: "token" },
    };
    let s = seedSecret(a, "original-id", original);
    await live.compute!.deleteServiceAccountCredential({
      ...input,
      accessToken: "different-token",
    });
    assert.equal(secret(a.id)?.metadata.uid, s.metadata.uid);
    await live.compute!.deleteServiceAccountCredential({ ...input, credentialId: "different-id" });
    assert.equal(secret(a.id)?.metadata.uid, s.metadata.uid);
    await live.compute!.deleteServiceAccountCredential({
      ...input,
      accessToken: original,
      credentialId: "different-id",
    });
    assert.equal(secret(a.id)?.metadata.uid, s.metadata.uid, "both supplied selectors must match");
    s.metadata.labels!["openclaw.dev/service-account"] = "foreign";
    persist("kubernetes");
    await live.compute!.deleteServiceAccountCredential({ ...input, accessToken: original });
    assert.equal(secret(a.id)?.metadata.uid, s.metadata.uid);
    // Each race isolates one precondition, so either omitted wire field is observable.
    for (const changedField of ["resourceVersion", "uid"] as const) {
      s = seedSecret(a, "original-id", original);
      assert.ok(s.metadata.uid);
      assert.ok(s.metadata.resourceVersion);
      const expectedPreconditions = {
        uid: s.metadata.uid,
        resourceVersion: s.metadata.resourceVersion,
      };
      let observedDelete = false;
      const eventCount = live.events.length;
      live.beforeSecretDelete = (name, value) => {
        if (name === secretName(a.id)) {
          live.beforeSecretDelete = undefined;
          assert.deepEqual(value.preconditions, expectedPreconditions);
          observedDelete = true;
          const replacement = seedSecret(a, "replacement-id");
          if (changedField === "resourceVersion") {
            replacement.metadata.uid = expectedPreconditions.uid;
            replacement.metadata.resourceVersion =
              expectedPreconditions.resourceVersion + "-changed";
          } else {
            replacement.metadata.resourceVersion = expectedPreconditions.resourceVersion;
          }
          assert.notEqual(replacement.metadata[changedField], expectedPreconditions[changedField]);
          const unchangedField = changedField === "uid" ? "resourceVersion" : "uid";
          assert.equal(replacement.metadata[unchangedField], expectedPreconditions[unchangedField]);
          persist("kubernetes");
        }
      };
      await assert.rejects(
        live.compute!.deleteServiceAccountCredential({ ...input, credentialId: "original-id" }),
        { code: 409 },
      );
      assert.equal(observedDelete, true);
      assert.equal(secret(a.id)?.metadata.annotations?.[annotation], "replacement-id");
      assert.deepEqual(durableSecret(a.id), secret(a.id));
      assert.ok(
        live.events
          .slice(eventCount)
          .some(
            (x) =>
              x.operation === "secret-delete" &&
              x.id === secretName(a.id) &&
              x.outcome === "precondition-conflict",
          ),
      );
    }
    for (const field of ["uid", "resourceVersion"] as const) {
      s = seedSecret(a, "original-id", original);
      delete s.metadata[field];
      persist("kubernetes");
      await assert.rejects(
        live.compute!.deleteServiceAccountCredential({ ...input, accessToken: original }),
        { message: "The ServiceAccount credential Secret has no exact identity to delete." },
      );
      assert.ok(secret(a.id));
    }
    live.beforeSecretDelete = undefined;
  },
);
test(
  "an owned leftover without a safe credential ID blocks issuance",
  requiresPostgres,
  async () => {
    for (const id of ["", "..", ".", "invalid/id"]) {
      const a = await account("unsafe");
      const s = seedSecret(a, id);
      if (id === "") {
        delete s.metadata.annotations![annotation];
      }
      persist("kubernetes");
      const start = live.events.length;
      expect(await issue(a), 409, "RESOURCE_CONFLICT");
      assert.equal(secret(a.id)?.metadata.uid, s.metadata.uid);
      assert.equal(
        live.events.slice(start).filter((x) => x.operation.startsWith("credential-")).length,
        0,
      );
    }
  },
);
test(
  "two concurrent HTTP issuances serialize on the exact PostgreSQL account lock",
  requiresPostgres,
  async () => {
    const a = await account("concurrent");
    const held = deferred();
    const release = deferred();
    live.beforeProviderCreate = async (id) => {
      if (id === a.externalId) {
        held.resolve();
        await release.promise;
      }
    };
    const first = issue(a);
    let second: Promise<Reply> | undefined;
    try {
      await held.promise;
      second = issue(a);
      await until(
        async () =>
          Number(
            (
              await live.pool!.query<{ n: string }>(
                "SELECT count(*)::text AS n FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1 AND wait_event_type='Lock'",
                [live.appName],
              )
            ).rows[0]!.n,
          ) >= 1,
        "second issuance did not wait on the PostgreSQL lock",
      );
      assert.equal(providerEvents(a).length, 0);
      release.resolve();
      expect(await first, 201);
      expect(await second, 409, "RESOURCE_CONFLICT");
      assert.equal(providerEvents(a).length, 1);
      assert.equal((await binding(a))?.external_credential_id, credentialFor(a).id);
    } finally {
      release.resolve();
      live.beforeProviderCreate = undefined;
      await first.catch(() => {});
      await second?.catch(() => {});
    }
  },
);
test(
  "lost PostgreSQL session during leftover lookup cannot reclaim a later committed issuance",
  requiresPostgres,
  async () => {
    const a = await account("lost-session");
    const initial = seedSecret(a, "old-credential");
    live.credentials.set("old-credential", {
      id: "old-credential",
      accountId: a.externalId,
      occId: a.id,
      token: Buffer.from(initial.data!.token!, "base64").toString(),
    });
    persist("provider");
    const held = deferred();
    const release = deferred();
    let first = true;
    live.beforeSecretRead = async (name) => {
      if (first && name === secretName(a.id)) {
        first = false;
        held.resolve();
        await release.promise;
      }
    };
    const stale = issue(a);
    try {
      await held.promise;
      const pids = await live.pool!.query<{ pid: number }>(
        "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1 AND state='idle in transaction'",
        [live.appName],
      );
      assert.equal(pids.rowCount, 1, "exactly one owned transaction may be terminated");
      assert.equal(
        (
          await live.pool!.query<{ terminated: boolean }>(
            "SELECT pg_terminate_backend($1) AS terminated",
            [pids.rows[0]!.pid],
          )
        ).rows[0]!.terminated,
        true,
      );
      expect(await issue(a), 201);
      const c = credentialFor(a);
      release.resolve();
      expect(await stale, 503, "DEPENDENCY_UNAVAILABLE");
      assert.equal((await binding(a))?.external_credential_id, c.id);
      assert.equal(secret(a.id)?.metadata.annotations?.[annotation], c.id);
      assert.ok(live.credentials.has(c.id));
    } finally {
      release.resolve();
      live.beforeSecretRead = undefined;
      await stale.catch(() => {});
    }
  },
);
test(
  "lost PostgreSQL COMMIT acknowledgment preserves a committed issuance without replay",
  requiresPostgres,
  async () => {
    assert.ok(databaseUrl);
    const a = await account("lost-commit");
    const proxy = await commitAckProxy(databaseUrl);
    live.proxies.push(proxy);
    const url = await startApp(proxy.url, true, "sa-comp-commit-" + randomUUID());
    live.afterStored.set(secretName(a.id), () => {
      live.auditNext = () => {
        proxy.arm();
        return "aud_" + randomUUID();
      };
    });
    const start = live.events.length;
    const r = await issue(a, { url });
    expect(r, 503, "DEPENDENCY_UNAVAILABLE");
    assert.ok(proxy.observedCommit, "actual COMMIT was observed");
    const c = credentialFor(a);
    assert.equal((await binding(a))?.external_credential_id, c.id);
    assert.equal(
      live.events.slice(start).filter((x) => x.operation.endsWith("-delete")).length,
      0,
      "unknown COMMIT cannot compensate",
    );
    expect(await issue(a), 409, "RESOURCE_CONFLICT");
    assert.equal(providerEvents(a).length, 1);
  },
);
test(
  "withheld PostgreSQL COMMIT is reconciled before an explicit recovery request",
  requiresPostgres,
  async () => {
    assert.ok(databaseUrl);
    const a = await account("withheld-commit");
    const proxy = await commitAckProxy(databaseUrl);
    live.proxies.push(proxy);
    const name = "sa-comp-withheld-" + randomUUID();
    const url = await startApp(proxy.url, true, name);
    live.afterStored.set(secretName(a.id), () => {
      live.auditNext = () => {
        proxy.arm({ pauseCommit: true });
        return "aud_" + randomUUID();
      };
    });
    const start = live.events.length;
    const pending = issue(a, { url });
    await until(() => proxy.commitPaused, "COMMIT was not paused");
    await proxy.close();
    live.proxies.splice(live.proxies.indexOf(proxy), 1);
    const r = await pending;
    expect(r, 503, "DEPENDENCY_UNAVAILABLE");
    assert.equal(proxy.observedCommit, true, "proxy observed the withheld COMMIT request");
    await until(
      async () =>
        Number(
          (
            await live.pool!.query<{ n: string }>(
              "SELECT count(*)::text AS n FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1",
              [name],
            )
          ).rows[0]!.n,
        ) === 0,
      "withheld transaction session did not end",
    );
    await noBinding(a);
    assert.equal(live.events.slice(start).filter((x) => x.operation.endsWith("-delete")).length, 0);
    const c = credentialFor(a);
    retained(a, c);
    const recovery = live.events.length;
    expect(await issue(a), 201);
    order(a, c, recovery);
    assert.equal(providerEvents(a).length, 2);
  },
);
test(
  "parser and exact-account IAM refusals precede provider and Secret effects",
  requiresPostgres,
  async () => {
    const a = await account("admission");
    const principal = await request(
      "POST",
      "/namespaces/" + live.namespaceId + "/iam/service-principals",
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
        name: "recovery refusal",
      }),
    );
    expect(keyReply, 201);
    const key = textField(data(keyReply), "key");
    const start = live.events.length;
    expect(
      await request(
        "POST",
        "/namespaces/" + live.namespaceId + "/service-accounts/" + a.id + "/credentials",
        "{}",
        null,
      ),
      401,
      "UNAUTHENTICATED",
    );
    const denied = await issue(a, { key });
    assert.ok([403, 404].includes(denied.status));
    assert.ok(
      ["FORBIDDEN", "NOT_FOUND"].includes(textField(safeObject(denied.body.error), "code")),
    );
    expect(await issue(a, { payload: '{"unexpected":true}' }), 400, "INVALID_REQUEST");
    expect(await issue(a, { query: "?force=true" }), 400, "INVALID_REQUEST");
    expect(
      await request(
        "POST",
        "/namespaces/" + live.namespaceId + "/service-accounts/not-an-id/credentials",
        "{}",
      ),
      400,
      "INVALID_REQUEST",
    );
    assert.equal(
      live.events
        .slice(start)
        .filter(
          (x) =>
            x.operation.startsWith("credential-") ||
            x.operation === "secret-post" ||
            x.operation === "secret-delete",
        ).length,
      0,
    );
    const role = await request(
      "POST",
      "/namespaces/" + live.namespaceId + "/iam/roles",
      JSON.stringify({
        name: "Recovery issuer " + randomUUID().slice(0, 8),
        permissions: [{ action: "update", resourceKind: "service_account" }],
      }),
    );
    expect(role, 201);
    const grant = await request(
      "POST",
      "/namespaces/" + live.namespaceId + "/iam/access-bindings",
      JSON.stringify({
        subjectKind: "identity",
        subjectId: principalId,
        roleId: textField(data(role), "id"),
        resourceKind: "service_account",
        resourceId: a.id,
      }),
    );
    expect(grant, 201);
    expect(await issue(a, { key }), 201);
  },
);
test(
  "revoked exact-account authority cannot recover a retained credential",
  requiresPostgres,
  async () => {
    const a = await account("revoked-authority");
    const iam = "/namespaces/" + live.namespaceId + "/iam";
    const principal = await request("POST", iam + "/service-principals", "{}");
    expect(principal, 201);
    const principalId = textField(data(principal), "id");
    const keyReply = await request(
      "POST",
      "/api/auth/service-keys",
      JSON.stringify({
        servicePrincipalId: principalId,
        namespaceId: live.namespaceId,
        name: "Retained credential recovery",
      }),
    );
    expect(keyReply, 201);
    const key = textField(data(keyReply), "key");
    const role = await request(
      "POST",
      iam + "/roles",
      JSON.stringify({
        name: "Exact credential issuer " + randomUUID().slice(0, 8),
        permissions: [{ action: "update", resourceKind: "service_account" }],
      }),
    );
    expect(role, 201);
    const grant = await request(
      "POST",
      iam + "/access-bindings",
      JSON.stringify({
        subjectKind: "identity",
        subjectId: principalId,
        roleId: textField(data(role), "id"),
        resourceKind: "service_account",
        resourceId: a.id,
      }),
    );
    expect(grant, 201);

    // The real audit rollback leaves one recoverable credential outside PostgreSQL.
    armAudit(a);
    live.deleteModes.set(a.externalId, "503");
    const auditBefore = live.auditConsumed;
    expect(await issue(a, { key }), 503, "DEPENDENCY_UNAVAILABLE");
    assert.equal(live.auditConsumed, auditBefore + 1, "real audit collision consumed");
    await noBinding(a);
    const old = credentialFor(a);
    retained(a, old);
    assert.equal(providerEvents(a).length, 1);
    const receipt = structuredClone(durableSecret(a.id));

    // Revocation goes through the same IAM owner as an administrator's policy edit.
    expect(await request("DELETE", iam + "/access-bindings/" + textField(data(grant), "id")), 204);
    live.deleteModes.delete(a.externalId);
    const deniedStart = live.events.length;
    expect(await issue(a, { key }), 403, "FORBIDDEN");
    assert.equal(
      live.events
        .slice(deniedStart)
        .filter(
          (x) =>
            x.operation.startsWith("credential-") ||
            x.operation === "account-post" ||
            x.operation === "account-delete" ||
            x.operation === "secret-post" ||
            x.operation === "secret-delete",
        ).length,
      0,
      "lost authority cannot mutate either credential owner",
    );
    await noBinding(a);
    assert.ok(
      JSON.stringify(durableSecret(a.id)) === JSON.stringify(receipt),
      "the exact retained receipt must stay unchanged without disclosing its token",
    );
    retained(a, old);
    assert.equal(providerEvents(a).length, 1, "denied recovery cannot issue a replacement");

    // A currently authorized caller must retire the exact old credential before replacement.
    const recoveryStart = live.events.length;
    expect(await issue(a), 201);
    order(a, old, recoveryStart);
    const recovery = live.events.slice(recoveryStart);
    const removed = recovery.findIndex(
      (x) =>
        x.operation === "secret-delete" && x.id === secretName(a.id) && x.outcome === "applied",
    );
    const created = recovery.findIndex(
      (x) => x.operation === "credential-post" && x.id.startsWith(a.externalId + "/"),
    );
    assert.ok(created > removed, "replacement issuance follows exact receipt removal");
    assert.equal(
      providerEvents(a, "credential-delete").filter((x) => x.outcome === "confirmed").length,
      1,
    );
    assert.equal(providerEvents(a).length, 2);
    assert.equal(live.credentials.has(old.id), false);
    const replacement = credentialFor(a);
    assert.notEqual(replacement.id, old.id);
    assert.equal((await binding(a))?.external_credential_id, replacement.id);
    assert.equal(secret(a.id)?.metadata.annotations?.[annotation], replacement.id);
    retained(a, replacement);
  },
);
test(
  "force deletion keeps configured-provider and no-provider behavior separate",
  requiresPostgres,
  async () => {
    const a = await account("configured-force");
    expect(await issue(a), 201);
    live.deleteModes.set(a.externalId, "503");
    expect(
      await request(
        "DELETE",
        "/namespaces/" + live.namespaceId + "/service-accounts/" + a.id + "?force=true",
      ),
      503,
      "DEPENDENCY_UNAVAILABLE",
    );
    assert.ok(await binding(a));
    assert.ok(secret(a.id));
    live.deleteModes.delete(a.externalId);
    expect(
      await request(
        "DELETE",
        "/namespaces/" + live.namespaceId + "/service-accounts/" + a.id + "?force=true",
      ),
      204,
    );
    assert.equal(await binding(a), undefined);
    const b = await account("no-driver-force");
    expect(await issue(b), 201);
    const credential = credentialFor(b);
    assert.equal((await binding(b))?.external_credential_id, credential.id);
    const noDriverUrl = await startApp(databaseUrl!, false, "sa-comp-no-driver-" + randomUUID());
    const accountPath = `/namespaces/${live.namespaceId}/service-accounts/${b.id}`;
    const start = live.events.length;
    expect(
      await request("DELETE", accountPath, undefined, live.key, noDriverUrl),
      409,
      "SERVICE_ACCOUNT_DRIVER_NOT_CONFIGURED",
    );
    const forced = await request(
      "DELETE",
      `${accountPath}?force=true`,
      undefined,
      live.key,
      noDriverUrl,
    );
    expect(forced, 200);
    // The public receipt identifies the Backend and leaves provider binding details in audit.
    assert.deepEqual(data(forced), {
      id: b.id,
      namespaceId: live.namespaceId,
      revocation: "skipped",
      backendId: "recovery-chatgpt",
    });
    expect(await request("GET", accountPath, undefined, live.key, noDriverUrl), 404);
    assert.equal(await binding(b), undefined);
    assert.equal(secret(b.id), undefined);
    assert.equal(
      live.events
        .slice(start)
        .filter((x) => x.operation.startsWith("credential-") || x.operation === "account-delete")
        .length,
      0,
    );
    const audit = await live.pool!.query<{ details: Json }>(
      `SELECT details - '__occAuditMetadata' AS details
       FROM occ.audit_events
       WHERE namespace_id=$1 AND resource_kind='service_account' AND resource_id=$2
         AND kind='mutation' AND action='openclaw.service_accounts.delete' AND outcome='success'`,
      [live.namespaceId, b.id],
    );
    // An operator needs the exact binding identifiers to revoke the orphaned credential.
    assert.deepEqual(audit.rows, [
      {
        details: {
          actorServiceKeyId: live.keyId,
          force: true,
          revocation: "skipped",
          backendId: "recovery-chatgpt",
          workspaceId: live.workspaceId,
          externalAccountId: b.externalId,
          credentialId: credential.id,
        },
      },
    ]);
    for (const mismatch of ["backend", "workspace"] as const) {
      const c = await account("foreign-" + mismatch);
      const other = await startApp(databaseUrl!, true, "sa-comp-foreign-" + randomUUID(), mismatch);
      expect(await issue(c, { url: other }), 503, "DEPENDENCY_UNAVAILABLE");
      assert.equal(providerEvents(c).length, 0);
      await noBinding(c);
    }
  },
);
