import assert from "node:assert/strict";
import { copyFile } from "node:fs/promises";
import { createServer as createHttpServer, type ServerResponse } from "node:http";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  readPrivateStatusProxy,
  RUNTIME_STATUS_PATH,
} from "../../apps/controller/src/drivers/compute/kubernetes/private-status-proxy.ts";
import {
  withComputeAbortSignal,
  withComputeOperationDeadline,
} from "../../apps/controller/src/drivers/compute/operation-context.ts";
import type { KubernetesAuthentication } from "../../apps/controller/src/drivers/kubernetes/authentication.ts";
import {
  createKubernetesClientConfiguration,
  KUBERNETES_KEEP_ALIVE_LIMITS,
  reuseRequestDispatcher,
} from "../../apps/controller/src/drivers/kubernetes/client.ts";
import {
  kubernetesRequest,
  type KubernetesRequestFailures,
} from "../../apps/controller/src/drivers/kubernetes/request.ts";
import { DependencyUnavailableError } from "../../packages/occ/src/index.ts";
import {
  runtimeDiagnosticsApi,
  runtimeStatusPath,
  runtimeStatusTarget,
} from "./kubernetes-client-diagnostics.ts";
import {
  apiServer,
  connectProxy,
  recordingApiServer,
  selfSignedCertificate,
  writeKubeconfig,
} from "./kubernetes-client-fixture.ts";
import { listen } from "../helpers/listen.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";
import { waitFor } from "../helpers/wait-for.ts";

test("Kubernetes API requests reuse keep-alive HTTP/1.1 connections and reconnect when the client certificate rotates", async (t) => {
  const directory = await temporaryDirectory(t, "occ-kubernetes-client-");
  const first = await selfSignedCertificate(directory, "operator-1", "DNS:operator");
  const second = await selfSignedCertificate(directory, "operator-2", "DNS:operator");
  const server = await apiServer(t, directory, [first.certPath, second.certPath]);
  const active = {
    certPath: join(directory, "operator.crt"),
    keyPath: join(directory, "operator.key"),
  };
  await copyFile(first.certPath, active.certPath);
  await copyFile(first.keyPath, active.keyPath);
  const authentication = await writeKubeconfig(directory, server, active);
  const { sdk, clientConfiguration } = await createKubernetesClientConfiguration(
    authentication,
    (message) => new Error(message),
  );
  const core = new sdk.CoreV1Api(clientConfiguration);

  // undici returns a socket to its pool just after the response resolves, so
  // back-to-back requests may alternate between two keep-alive connections.
  // Before the fix, every request opened its own HTTP/2 connection.
  for (let request = 0; request < 20; request += 1) {
    await core.listNamespace();
  }
  const firstConnections = server.connections.length;
  assert.ok(
    firstConnections >= 1 && firstConnections <= 2,
    `20 requests opened ${firstConnections} connections`,
  );
  for (const connection of server.connections) {
    assert.deepEqual(connection, { protocol: "http/1.1", client: "operator-1" });
  }

  // The kubeconfig names certificate files, which the client rereads on every
  // request: a rotated pair gets new connections and the old ones close.
  await copyFile(second.certPath, active.certPath);
  await copyFile(second.keyPath, active.keyPath);
  for (let request = 0; request < 20; request += 1) {
    await core.listNamespace();
  }
  const rotated = server.connections.slice(firstConnections);
  assert.ok(rotated.length >= 1 && rotated.length <= 2, `rotation opened ${rotated.length}`);
  for (const connection of rotated) {
    assert.deepEqual(connection, { protocol: "http/1.1", client: "operator-2" });
  }
  await waitFor("the connections for the old certificate to close", () =>
    [...server.open].some((connection) => connection.client === "operator-1") ? undefined : true,
  );
});

// undici keeps an Agent's options under Symbol("options"), and a ProxyAgent's
// inner Agent under Symbol("proxy agent"). It has no public accessor for them.
function undiciSymbol(object: unknown, description: string): unknown {
  assert.ok(typeof object === "object" && object !== null, `undici ${description} owner`);
  const symbols = Object.getOwnPropertySymbols(object).filter(
    (candidate) => candidate.description === description,
  );
  const [key] = symbols;
  assert.ok(
    key !== undefined && symbols.length === 1,
    `undici no longer keeps ${description} where this test reads it`,
  );
  const value: unknown = Reflect.get(object, key);
  return value;
}

test("Kubernetes API dispatchers carry the keep-alive limits, directly and through an HTTP proxy", async (t) => {
  assert.deepEqual(KUBERNETES_KEEP_ALIVE_LIMITS, {
    keepAliveTimeout: 4_000,
    keepAliveMaxTimeout: 30_000,
  });
  const directory = await temporaryDirectory(t, "occ-kubernetes-client-");
  const operator = await selfSignedCertificate(directory, "operator", "DNS:operator");
  const server = await selfSignedCertificate(directory, "api-server", "IP:127.0.0.1");
  const target = { url: "https://127.0.0.1:6443", caPath: server.certPath };
  for (const proxyUrl of [undefined, "http://127.0.0.1:3128"]) {
    const authentication = await writeKubeconfig(directory, target, operator, proxyUrl);
    const { sdk, kubeConfig } = await createKubernetesClientConfiguration(
      authentication,
      (message) => new Error(message),
    );
    const request = new sdk.RequestContext(target.url, sdk.HttpMethod.GET);
    await kubeConfig.applySecurityAuthentication(request);
    const dispatcher = request.getDispatcher();
    assert.ok(dispatcher, "the configured API request has a dispatcher");
    t.after(() => dispatcher.close());
    const agent = proxyUrl === undefined ? dispatcher : undiciSymbol(dispatcher, "proxy agent");
    const options = undiciSymbol(agent, "options");
    assert.ok(typeof options === "object" && options !== null);
    assert.ok(
      "keepAliveTimeout" in options && "keepAliveMaxTimeout" in options && "allowH2" in options,
    );
    assert.equal(options.keepAliveTimeout, 4_000, `proxy ${proxyUrl}`);
    assert.equal(options.keepAliveMaxTimeout, 30_000, `proxy ${proxyUrl}`);
    assert.equal(options.allowH2, false, `proxy ${proxyUrl}`);
  }
});

// Finding 909: undici trusts a server's Keep-Alive timeout hint up to its
// keepAliveMaxTimeout (600 s by default), so a hop advertising more idle time
// than another hop allows lets the other hop close a socket the client is about
// to reuse. The client must close an idle socket by keepAliveMaxTimeout even when
// the server advertises 600 s, and by keepAliveTimeout when it sends no hint.
// The production limits are 4 s and 30 s; small ones keep this test fast.
for (const viaProxy of [false, true]) {
  test(`Kubernetes API clients close idle connections within the keep-alive limits${viaProxy ? " through an HTTP proxy" : ""}`, async (t) => {
    const limits = { keepAliveTimeout: 300, keepAliveMaxTimeout: 800 };
    const directory = await temporaryDirectory(t, "occ-kubernetes-client-");
    const operator = await selfSignedCertificate(directory, "operator", "DNS:operator");
    // A Keep-Alive header without a timeout leaves the client at keepAliveTimeout.
    for (const [keepAliveHint, limit] of [
      ["timeout=600", limits.keepAliveMaxTimeout],
      ["max=100", limits.keepAliveTimeout],
    ] as const) {
      const server = await apiServer(t, directory, [operator.certPath], keepAliveHint);
      const proxy = viaProxy ? await connectProxy(t, new URL(server.url)) : undefined;
      const authentication = await writeKubeconfig(directory, server, operator, proxy?.url);
      const { sdk } = await createKubernetesClientConfiguration(
        authentication,
        (message) => new Error(message),
      );
      const kubeConfig = new sdk.KubeConfig();
      reuseRequestDispatcher(kubeConfig, limits);
      kubeConfig.loadFromFile(authentication.kubeconfigPath);
      const core = kubeConfig.makeApiClient(sdk.CoreV1Api);

      await core.listNamespace();
      assert.equal(server.idle.size, 1, `${keepAliveHint}: one connection`);
      assert.deepEqual(server.connections, [{ protocol: "http/1.1", client: "operator" }]);
      if (proxy !== undefined) {
        assert.deepEqual(proxy.tunnels, [new URL(server.url).host], `${keepAliveHint}: one tunnel`);
      }
      const { value: record, done } = server.idle.values().next();
      assert.equal(done, false);
      const closedAt = await waitFor(
        `${keepAliveHint}: the client to close the idle connection`,
        () => record.clientClosedAt,
      );
      assert.ok(record.lastResponseAt !== undefined, "the TLS API response finished");
      const idleFor = closedAt - record.lastResponseAt;
      assert.ok(
        // The upper bound only has to stay under undici's 4 s default.
        idleFor >= limit - 100 && idleFor < limit + 2_500,
        `${keepAliveHint}: the client closed the connection after ${idleFor} ms idle, expected about ${limit} ms`,
      );
    }
  });
}

const STATUS_PROXY_PATH =
  "/api/v1/namespaces/tenant/pods/agent-pod%3A18791/proxy/openclaw%2Fruntime%2Fstatus";

const requestFailures = {
  cancelled: (reason) => reason,
  failed: (error) => error,
  timedOut: () => new Error("request timed out"),
  deadlineElapsed: () => new Error("request lifetime elapsed before dispatch"),
} satisfies KubernetesRequestFailures;

async function statusReadback(
  authentication: KubernetesAuthentication,
  target: Parameters<typeof readPrivateStatusProxy>[2],
) {
  const { sdk, clientConfiguration } = await createKubernetesClientConfiguration(
    authentication,
    (message) => new Error(message),
  );
  return readPrivateStatusProxy(
    new sdk.CoreV1Api(clientConfiguration),
    (operation) => operation(),
    target,
  );
}

const REDIRECT_SECRET_PATH = "/api/v1/namespaces/occ-system/secrets/x";
const statusRequest = { path: STATUS_PROXY_PATH, authorization: "Bearer fixture-token" } as const;
const redirect = "Runtime status answered with a redirect.";

async function assertTerminalStatus(
  api: Awaited<ReturnType<typeof runtimeDiagnosticsApi>>,
  message: string,
) {
  const request = { path: runtimeStatusPath, authorization: "Bearer fixture-token" };
  // Compute suppresses unavailable startup evidence. Observe the classified wire
  // error separately, then count the requests issued by Compute's own retry policy.
  await assert.rejects(statusReadback(api.authentication, runtimeStatusTarget), {
    name: DependencyUnavailableError.name,
    message,
  });
  assert.deepEqual(api.statusRequests, [request]);
  const diagnostics = await api.diagnose();
  assert.deepEqual(diagnostics.checks, []);
  assert.deepEqual(api.statusRequests.slice(1), [request], "Compute must issue one status request");
}

// Finding 1347: whoever runs on a Pod's status port writes the proxied answer, and the
// API server's Pod proxy passes a relative Location, or one naming another host,
// through unchanged. Following it would send the controller's token to another API
// server path, or fetch another origin from the controller's network position. The
// readback must make exactly one request and report the redirect as unreadable.
const locations = [
  ["a relative path", () => "../../../../../../../api/v1/namespaces/occ-system/secrets/x"],
  ["another API server path", (apiUrl) => `${apiUrl}${REDIRECT_SECRET_PATH}`],
  ["another origin", (_apiUrl, otherUrl) => `${otherUrl}/collect`],
  ["itself", () => runtimeStatusPath],
] satisfies readonly (readonly [string, (apiUrl: string, otherUrl: string) => string])[];
for (const [target, location] of locations) {
  test(`runtime status readback does not follow a Pod redirect to ${target} (finding 1347)`, async (t) => {
    const directory = await temporaryDirectory(t, "occ-kubernetes-client-");
    const otherRequests: (string | undefined)[] = [];
    const other = createHttpServer((request, response) => {
      otherRequests.push(request.url);
      response.end("{}");
    });
    const otherPort = await listen(t, other);
    const api = await runtimeDiagnosticsApi(t, directory, (_request, response) => {
      response.writeHead(302, {
        location: location(api.url, `http://127.0.0.1:${otherPort}`),
      });
      response.end();
    });

    await assertTerminalStatus(api, redirect);
    assert.deepEqual(otherRequests, []);
  });
}

for (const body of ["truncated", "held open"]) {
  test(`runtime status readback stops at a redirect with a ${body} body`, async (t) => {
    const directory = await temporaryDirectory(t, "occ-kubernetes-client-");
    const responsesClosed: Promise<void>[] = [];
    const api = await runtimeDiagnosticsApi(t, directory, (_request, response) => {
      response.writeHead(302, {
        location: REDIRECT_SECRET_PATH,
        "content-length": "100",
      });
      responsesClosed.push(new Promise<void>((resolve) => response.once("close", resolve)));
      response.flushHeaders();
      if (body === "truncated") {
        response.write("partial");
        const timer = setTimeout(() => response.destroy(), 25);
        response.once("close", () => clearTimeout(timer));
      }
    });

    // An unfinished body must neither delay the redirect result nor cause a retry.
    await withComputeAbortSignal(AbortSignal.timeout(4_000), () =>
      assertTerminalStatus(api, redirect),
    );
    assert.equal(
      await Promise.race([
        Promise.all(responsesClosed).then(() => true),
        delay(2_000, false, { ref: false }),
      ]),
      true,
      "both read paths cancel the redirect response",
    );
  });
}

// Finding 1355: undici refuses a 100 Continue or an unrequested 101 with a status-less socket
// error. The Pod chose that answer, so Compute must not retry it.
const interimResponses = [
  [
    "100 Continue",
    (response) => {
      response.writeContinue();
      response.writeHead(302, { location: REDIRECT_SECRET_PATH });
      response.end();
    },
  ],
  [
    "101 Switching Protocols",
    (response) => {
      assert.ok(response.socket, "the API sends the unsolicited upgrade over its socket");
      response.socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nconnection: upgrade\r\nupgrade: websocket\r\n\r\n",
      );
    },
  ],
] satisfies readonly (readonly [string, (response: ServerResponse) => void])[];
for (const [interim, write] of interimResponses) {
  test(`runtime status readback reports an unrequested ${interim} once, without a retry`, async (t) => {
    const directory = await temporaryDirectory(t, "occ-kubernetes-client-");
    const api = await runtimeDiagnosticsApi(t, directory, (_request, response) => {
      write(response);
    });
    await withComputeAbortSignal(AbortSignal.timeout(4_000), () =>
      assertTerminalStatus(api, "Runtime status answered with an unrequested 1xx status."),
    );
  });
}

test("runtime status readback still retries a dropped connection", async (t) => {
  const directory = await temporaryDirectory(t, "occ-kubernetes-client-");
  let statusAttempts = 0;
  const api = await runtimeDiagnosticsApi(t, directory, (request, response) => {
    statusAttempts += 1;
    if (statusAttempts === 1) {
      // An API restart can drop the connection before answering the read.
      request.socket.destroy();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        revisionId: "revision-1",
        container: "gateway",
        podUid: "gateway-uid",
        runtimeFailure: {
          component: "gateway",
          check: "peer-bridge-record",
          checkedAt: "2026-09-19T12:00:00.000Z",
          code: "UNAVAILABLE",
        },
      }),
    );
  });
  const diagnostics = await api.diagnose();
  const podLists = api.observedPodLists();
  assert.equal(diagnostics.revisionId, "revision-1");
  assert.deepEqual(diagnostics.checks, [
    {
      component: "gateway",
      check: "peer-bridge-record",
      state: "failed",
      checkedAt: "2026-09-19T12:00:00.000Z",
      code: "UNAVAILABLE",
    },
  ]);
  assert.equal(statusAttempts, 2, "the dropped status request was retried once");
  // Compute must re-observe the Pod before accepting each proxied report.
  assert.equal(podLists.length, 4);
});

test("runtime status readback through the production client keeps 200 and 404 answers", async (t) => {
  const directory = await temporaryDirectory(t, "occ-kubernetes-client-");
  let status = 200;
  const api = await recordingApiServer(t, directory, (_request, response) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(status === 200 ? '{"revisionId":"revision-1"}' : "");
  });
  const authentication = await writeKubeconfig(directory, api, "fixture-token");
  const target = {
    namespace: "tenant",
    podName: "agent-pod",
    container: "agent",
    path: RUNTIME_STATUS_PATH,
  } as const;
  assert.deepEqual(await statusReadback(authentication, target), {
    body: { revisionId: "revision-1" },
  });
  // 404 means the status port is not serving yet: no status, no error.
  status = 404;
  assert.equal(await statusReadback(authentication, target), undefined);
  assert.deepEqual(api.requests, [statusRequest, statusRequest]);
  t.diagnostic("200 returned parsed status; 404 returned no status");
});

test("Kubernetes API clients do not follow a redirect from the API server (finding 1347)", async (t) => {
  const directory = await temporaryDirectory(t, "occ-kubernetes-client-");
  const api = await recordingApiServer(t, directory, (request, response) => {
    if (request.url?.startsWith("/api/v1/namespaces?")) {
      response.writeHead(302, { location: "/api/v1/namespaces/occ-system/secrets" });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"kind":"SecretList","apiVersion":"v1","items":[]}');
  });
  // The Secret and Configuration Drivers build their clients from this same configuration.
  const { sdk, clientConfiguration } = await createKubernetesClientConfiguration(
    await writeKubeconfig(directory, api, "fixture-token"),
    (message) => new Error(message),
  );
  await assert.rejects(
    new sdk.CoreV1Api(clientConfiguration).listNamespace({ limit: 1 }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === 302,
  );
  assert.equal(api.requests.length, 1);
});

// The non-redirecting library replaces client-node's own for every client (finding 1347), so it
// must still send each write's method and body, and stop a read when its operation is cancelled.
test("Kubernetes API clients send write bodies and honor cancellation through the shared library", async (t) => {
  const directory = await temporaryDirectory(t, "occ-kubernetes-client-");
  const writes: { readonly method: string | undefined; readonly body: string }[] = [];
  const cancel = new AbortController();
  const api = await recordingApiServer(t, directory, (request, response) => {
    // A read of this Namespace never answers; the operation is cancelled once it is in flight.
    if (request.url === "/api/v1/namespaces/held") {
      cancel.abort();
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: unknown) => {
      assert.ok(typeof chunk === "string", "the request stream is decoded as UTF-8");
      body += chunk;
    });
    request.on("end", () => {
      writes.push({ method: request.method, body });
      response.writeHead(201, { "content-type": "application/json" });
      response.end(body);
    });
  });
  const { sdk, clientConfiguration } = await createKubernetesClientConfiguration(
    await writeKubeconfig(directory, api, "fixture-token"),
    (message) => new Error(message),
  );
  const core = new sdk.CoreV1Api(clientConfiguration);
  const namespace = { apiVersion: "v1", kind: "Namespace", metadata: { name: "tenant" } };

  const created = await core.createNamespace({ body: namespace });
  assert.equal(created.metadata?.name, "tenant");
  assert.deepEqual(
    writes.map(({ method, body }) => {
      const decoded: unknown = JSON.parse(body);
      return { method, body: decoded };
    }),
    [{ method: "POST", body: namespace }],
  );

  // Re-scoping for a peer operation must retain the enclosing owner's cancellation.
  const held = withComputeOperationDeadline(
    { signal: cancel.signal, deadlineAt: new Date(Date.now() + 20_000).toISOString() },
    () =>
      withComputeAbortSignal(new AbortController().signal, () =>
        core.readNamespace({ name: "held" }),
      ),
  );
  await assert.rejects(
    Promise.race([held, delay(3_000, "still pending", { ref: false })]),
    (error: unknown) => {
      const reason: unknown = cancel.signal.reason;
      return error instanceof DOMException && error.name === "AbortError" && error === reason;
    },
  );
  assert.deepEqual(
    api.requests.map(({ path }) => path),
    ["/api/v1/namespaces", "/api/v1/namespaces/held"],
  );
});

test("Kubernetes dispatch retains the parent deadline through child and per-attempt scopes", async (t) => {
  const directory = await temporaryDirectory(t, "occ-kubernetes-client-");
  const api = await recordingApiServer(t, directory, (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ metadata: { name: "tenant" } }));
  });
  const { sdk, clientConfiguration } = await createKubernetesClientConfiguration(
    await writeKubeconfig(directory, api, "fixture-token"),
    (message) => new Error(message),
  );
  const core = new sdk.CoreV1Api(clientConfiguration);
  const signal = new AbortController().signal;
  const deadline = Date.now() + 20_000;
  await assert.rejects(
    withComputeOperationDeadline({ signal, deadlineAt: new Date(deadline).toISOString() }, () =>
      withComputeOperationDeadline(
        { signal, deadlineAt: new Date(deadline + 60_000).toISOString() },
        () =>
          kubernetesRequest(() => {
            // Only wall time advances after attempt setup. No timeout callback has run,
            // so the actual SDK HTTP dispatch must enforce the enclosing absolute bound.
            t.mock.method(Date, "now", () => deadline);
            return core.readNamespace({ name: "tenant" });
          }, requestFailures),
      ),
    ),
    { name: "TimeoutError" },
  );
  t.mock.restoreAll();
  await assert.rejects(
    withComputeOperationDeadline({ signal, deadlineAt: "invalid" }, () =>
      core.readNamespace({ name: "tenant" }),
    ),
    { name: "TimeoutError" },
  );
  assert.equal(
    api.requests.length,
    0,
    "expired or invalid lifetimes never reach the Kubernetes API",
  );
});
