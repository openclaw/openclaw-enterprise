// The real k3d tests read the cluster through kubectlGetJson, which answers a
// plain `kubectl get -o json` from the API server in process. These cases hold
// it to kubectl's behavior against a TLS API server that requires a client
// certificate: the same stdout, the same failures, and kubectl itself for
// anything it does not serve.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { join } from "node:path";
import test from "node:test";
import { selfSigned } from "../helpers/certificates.mjs";
import { commandCalls, prependPath, writeCommand } from "../helpers/fake-commands.mjs";
import { kubectlGetJson, plainGet } from "../helpers/kubernetes-api-read.mjs";
import { isTransientKubectlFailure } from "../helpers/kubernetes-real.mjs";
import { refusingPort } from "../helpers/available-port.mjs";
import { listen } from "../helpers/listen.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";

const resource = (name, kind, namespaced, shortNames) => ({
  name,
  singularName: kind.toLowerCase(),
  namespaced,
  kind,
  verbs: ["get", "list", "watch"],
  shortNames,
});

// Discovery and objects of a small cluster; an unavailable aggregated API group.
const routes = {
  "/api/v1": {
    kind: "APIResourceList",
    groupVersion: "v1",
    resources: [
      resource("pods", "Pod", true, ["po"]),
      { ...resource("pods/log", "Pod", true), singularName: "" },
      resource("namespaces", "Namespace", false, ["ns"]),
    ],
  },
  "/apis": {
    kind: "APIGroupList",
    groups: [
      { name: "apps", preferredVersion: { groupVersion: "apps/v1" } },
      { name: "metrics.example", preferredVersion: { groupVersion: "metrics.example/v1" } },
    ],
  },
  "/apis/apps/v1": {
    kind: "APIResourceList",
    groupVersion: "apps/v1",
    resources: [resource("deployments", "Deployment", true, ["deploy"])],
  },
  "/api/v1/namespaces/team/pods?labelSelector=app%3Dweb": {
    kind: "PodList",
    apiVersion: "v1",
    metadata: { resourceVersion: "41" },
    items: [{ metadata: { name: "web-1", namespace: "team" }, status: { phase: "Running" } }],
  },
  "/api/v1/pods?fieldSelector=status.phase%3DRunning": {
    kind: "PodList",
    apiVersion: "v1",
    metadata: { resourceVersion: "42" },
    items: [
      { metadata: { name: "web-1", namespace: "team" } },
      { metadata: { name: "dns-1", namespace: "kube-system" } },
    ],
  },
  // The API server's key order, managedFields and HTML characters, as kubectl gets them.
  "/apis/apps/v1/namespaces/team/deployments/web": {
    kind: "Deployment",
    apiVersion: "apps/v1",
    metadata: {
      name: "web",
      namespace: "team",
      managedFields: [{ manager: "kubectl", operation: "Apply" }],
      annotations: { note: "a<b & c>d" },
    },
    // A field of the same name deeper in the object is not the object's own.
    spec: { replicas: 1, template: { metadata: { managedFields: [{ manager: "kept" }] } } },
  },
  "/api/v1/namespaces/team": {
    kind: "Namespace",
    apiVersion: "v1",
    metadata: { name: "team" },
  },
};
const missing = {
  kind: "Status",
  apiVersion: "v1",
  status: "Failure",
  message: 'pods "missing" not found',
  reason: "NotFound",
  details: { name: "missing", kind: "pods" },
  code: 404,
};

async function cluster(t) {
  const directory = await temporaryDirectory(t, "oce-api-read-");
  const server = await selfSigned(directory, {
    name: "api-server",
    commonName: "api-server",
    subjectAltName: "IP:127.0.0.1",
  });
  const client = await selfSigned(directory, {
    name: "operator",
    commonName: "operator",
    subjectAltName: "DNS:operator",
  });
  const requests = [];
  // Requests answered so far per URL (a Map: URLs come from the client).
  const seen = new Map();
  let connections = 0;
  const listener = createServer({
    key: server.key,
    cert: server.cert,
    ca: client.cert,
    requestCert: true,
    rejectUnauthorized: true,
  });
  listener.on("secureConnection", () => (connections += 1));
  listener.on("request", (request, response) => {
    requests.push(request.url);
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/v1/namespaces/slow/pods") {
      return;
    }
    // Drops every connection, or only the first request on a kept-alive one.
    if (
      request.url === "/api/v1/namespaces/dropped/pods" ||
      (request.url === "/api/v1/namespaces/flaky/pods" && !seen.has(request.url))
    ) {
      seen.set(request.url, (seen.get(request.url) ?? 0) + 1);
      request.socket.destroy();
      return;
    }
    // Asks for a retry once, as an overloaded API server does.
    if (request.url === "/api/v1/namespaces/busy/pods" && !seen.has(request.url)) {
      seen.set(request.url, 1);
      response.statusCode = 429;
      response.setHeader("retry-after", "1");
      response.setHeader("content-type", "text/plain");
      response.end("Too many requests, please try again later.\n");
      return;
    }
    if (["/api/v1/namespaces/flaky/pods", "/api/v1/namespaces/busy/pods"].includes(request.url)) {
      response.end(JSON.stringify({ kind: "PodList", apiVersion: "v1", items: [] }));
      return;
    }
    // An aggregated API that is down answers in plain text.
    if (request.url === "/api/v1/namespaces/unavailable/pods") {
      response.statusCode = 503;
      response.setHeader("content-type", "text/plain");
      response.end("service unavailable\n");
      return;
    }
    // A Namespace the caller may not read, as RBAC denies it.
    if (request.url === "/api/v1/namespaces/locked") {
      response.statusCode = 403;
      response.end(
        JSON.stringify({
          ...missing,
          message: 'namespaces "locked" is forbidden',
          reason: "Forbidden",
          code: 403,
        }),
      );
      return;
    }
    if (/^\/api\/v1\/namespaces\/(team|default|locked)\/pods\/missing$/.test(request.url)) {
      response.statusCode = 404;
      response.end(JSON.stringify(missing));
      return;
    }
    if (request.url.startsWith("/api/v1/namespaces/gone")) {
      response.statusCode = 404;
      response.end(
        JSON.stringify({
          ...missing,
          message:
            request.url === "/api/v1/namespaces/gone"
              ? 'namespaces "gone" not found'
              : 'pods "missing" not found',
        }),
      );
      return;
    }
    const body = routes[request.url];
    response.statusCode = body === undefined ? 503 : 200;
    response.end(JSON.stringify(body ?? { kind: "Status", reason: "ServiceUnavailable" }));
  });
  await listen(t, listener);

  // A kubectl on PATH that prints its kubeconfig for `config view` and logs every run.
  const calls = join(directory, "kubectl-calls");
  await writeCommand(
    directory,
    "kubectl",
    `[ "$5 $6" = "config view" ] && exec cat "$2"\nexit 7\n`,
    {
      log: calls,
    },
  );
  prependPath(t, directory);

  let configurations = 0;
  const kubeconfig = async (url, user) => {
    const kubeconfigPath = join(directory, `kubeconfig-${(configurations += 1)}`);
    await writeFile(
      kubeconfigPath,
      JSON.stringify({
        apiVersion: "v1",
        kind: "Config",
        clusters: [
          {
            name: "target",
            cluster: {
              server: url,
              "certificate-authority-data": Buffer.from(server.cert).toString("base64"),
            },
          },
        ],
        users: [{ name: "operator", user }],
        contexts: [
          { name: "target", context: { cluster: "target", user: "operator", namespace: "team" } },
        ],
        "current-context": "target",
      }),
    );
    return { kubeconfigPath, kubernetesContext: "target" };
  };
  const user = {
    "client-certificate-data": Buffer.from(client.cert).toString("base64"),
    "client-key-data": Buffer.from(client.key).toString("base64"),
  };
  return {
    selection: await kubeconfig(`https://127.0.0.1:${listener.address().port}`, user),
    kubeconfig,
    user,
    requests,
    connections: () => connections,
    kubectlRuns: () => commandCalls(calls),
  };
}

// What kubectl 1.3x prints for these reads, verbatim: a List whose items carry
// their apiVersion and kind, keys sorted, managedFields left out, and <, > and &
// escaped as Go does.
const printed = {
  labelled: `{
    "apiVersion": "v1",
    "items": [
        {
            "apiVersion": "v1",
            "kind": "Pod",
            "metadata": {
                "name": "web-1",
                "namespace": "team"
            },
            "status": {
                "phase": "Running"
            }
        }
    ],
    "kind": "List",
    "metadata": {
        "resourceVersion": ""
    }
}
`,
  running: `{
    "apiVersion": "v1",
    "items": [
        {
            "apiVersion": "v1",
            "kind": "Pod",
            "metadata": {
                "name": "web-1",
                "namespace": "team"
            }
        },
        {
            "apiVersion": "v1",
            "kind": "Pod",
            "metadata": {
                "name": "dns-1",
                "namespace": "kube-system"
            }
        }
    ],
    "kind": "List",
    "metadata": {
        "resourceVersion": ""
    }
}
`,
  deployment: `{
    "apiVersion": "apps/v1",
    "kind": "Deployment",
    "metadata": {
        "annotations": {
            "note": "a\\u003cb \\u0026 c\\u003ed"
        },
        "name": "web",
        "namespace": "team"
    },
    "spec": {
        "replicas": 1,
        "template": {
            "metadata": {
                "managedFields": [
                    {
                        "manager": "kept"
                    }
                ]
            }
        }
    }
}
`,
};

test("a plain get is read from the API server and printed as kubectl prints it", async (t) => {
  const { selection, requests, connections, kubectlRuns } = await cluster(t);

  assert.equal(
    await kubectlGetJson(selection, ["get", "pods", "-l", "app=web", "-o", "json"]),
    printed.labelled,
  );
  assert.equal(
    await kubectlGetJson(selection, [
      "get",
      "po",
      "--all-namespaces",
      "--field-selector=status.phase=Running",
      "--output=json",
    ]),
    printed.running,
  );
  for (const kind of ["deploy", "deployment.apps", "Deployment"]) {
    assert.equal(
      await kubectlGetJson(selection, ["get", kind, "web", "--namespace", "team", "-o", "json"]),
      printed.deployment,
      kind,
    );
  }
  assert.deepEqual(
    JSON.parse(await kubectlGetJson(selection, ["get", "namespace", "team", "-n", "x", "-o=json"])),
    routes["/api/v1/namespaces/team"],
  );

  // Discovery once (core, the group list, then each group's preferred version in
  // parallel), then one request per read on kept-alive connections; kubectl ran
  // once, to read the kubeconfig.
  assert.deepEqual(requests.slice(0, 2), ["/api/v1", "/apis"]);
  assert.equal(requests.length, 4 + 6);
  assert.ok(connections() <= 2, `${connections()} connections`);
  assert.deepEqual(await kubectlRuns(), [
    `--kubeconfig ${selection.kubeconfigPath} --context target config view --minify --flatten -o json`,
  ]);
});

test("a read retries what kubectl's client retries", async (t) => {
  const { selection, requests } = await cluster(t);
  const empty = `{
    "apiVersion": "v1",
    "items": [],
    "kind": "List",
    "metadata": {
        "resourceVersion": ""
    }
}
`;
  // A kept-alive connection the server dropped: tried again at once.
  await kubectlGetJson(selection, ["get", "pods", "-o", "json"]).catch(() => {});
  assert.equal(
    await kubectlGetJson(selection, ["get", "pods", "-n", "flaky", "-o", "json"]),
    empty,
  );
  assert.equal(requests.filter((url) => url === "/api/v1/namespaces/flaky/pods").length, 2);

  // A 429 with Retry-After: tried again after it.
  const startedAt = Date.now();
  assert.equal(await kubectlGetJson(selection, ["get", "pods", "-n", "busy", "-o", "json"]), empty);
  assert.ok(Date.now() - startedAt >= 900, "waited out Retry-After");
  assert.equal(requests.filter((url) => url === "/api/v1/namespaces/busy/pods").length, 2);
});

test("a failed read fails as kubectl fails, transient only when kubectl's would be", async (t) => {
  const { selection, kubeconfig, user, requests } = await cluster(t);
  const failure = (promise) =>
    promise.then(
      () => assert.fail("the read succeeded"),
      (error) => error,
    );

  const notFound = await failure(
    kubectlGetJson(selection, ["get", "pod", "missing", "-n", "team", "-o", "json"]),
  );
  assert.equal(notFound.code, 1);
  assert.equal(notFound.stderr, 'Error from server (NotFound): pods "missing" not found\n');
  assert.match(notFound.message, /^Command failed: kubectl get pod missing -n team -o json\n/);
  assert.equal(isTransientKubectlFailure(notFound), false);
  // In a Namespace that does not exist, kubectl names the Namespace.
  const namespaceGone = await failure(
    kubectlGetJson(selection, ["get", "pod", "missing", "-n", "gone", "-o", "json"]),
  );
  assert.equal(namespaceGone.stderr, 'Error from server (NotFound): namespaces "gone" not found\n');
  // Any other answer about the Namespace leaves the object's NotFound, and the
  // default Namespace is not looked up, as in kubectl.
  for (const namespace of ["locked", "default"]) {
    const kept = await failure(
      kubectlGetJson(selection, ["get", "pod", "missing", "-n", namespace, "-o", "json"]),
    );
    assert.equal(
      kept.stderr,
      'Error from server (NotFound): pods "missing" not found\n',
      namespace,
    );
  }
  assert.equal(requests.includes("/api/v1/namespaces/default"), false);

  // A plain-text 503 reads as kubectl's ServiceUnavailable, which callers retry.
  const unavailable = await failure(
    kubectlGetJson(selection, ["get", "pods", "-n", "unavailable", "-o", "json"]),
  );
  assert.equal(
    unavailable.stderr,
    "Error from server (ServiceUnavailable): the server is currently unable to handle the request\n",
  );
  assert.equal(isTransientKubectlFailure(unavailable), true);

  // A server that drops every connection: retried until the read's timeout, then
  // kubectl's transport failure.
  const droppedAt = Date.now();
  const dropped = await failure(
    kubectlGetJson(selection, ["get", "pods", "-n", "dropped", "-o", "json"], { timeoutMs: 1_200 }),
  );
  // Tried at 0 and 1 s, then the wait is cut to the 0.2 s left: about 1.2 s, where
  // a full second's wait would end past 2 s.
  assert.ok(Date.now() - droppedAt < 1_800, "no retry waits or starts past the read's timeout");
  assert.match(dropped.stderr, /^Unable to connect to the server: /);
  assert.equal(isTransientKubectlFailure(dropped), true);

  // Without discovery, as when the server cannot be reached, kubectl reads and reports.
  const refused = await refusingPort();
  t.after(() => refused.release());
  assert.equal(
    await kubectlGetJson(await kubeconfig(`https://127.0.0.1:${refused.port}`, user), [
      "get",
      "pods",
      "-o",
      "json",
    ]),
    undefined,
  );

  for (const [args, options] of [
    [["get", "pods", "-n", "slow", "--request-timeout=300ms", "-o", "json"], {}],
    [["get", "pods", "-n", "slow", "-o", "json"], { timeoutMs: 300 }],
  ]) {
    const startedAt = Date.now();
    const timedOut = await failure(kubectlGetJson(selection, args, options));
    assert.ok(Date.now() - startedAt < 5_000, `${args.join(" ")} stopped at its timeout`);
    assert.match(timedOut.stderr, /^Unable to connect to the server: .*context deadline exceeded/);
    assert.equal(isTransientKubectlFailure(timedOut), true);
  }

  // A read its caller stops is the caller's AbortError, never retried.
  const stopped = await failure(
    kubectlGetJson(selection, ["get", "pods", "-n", "slow", "-o", "json"], {
      signal: AbortSignal.timeout(300),
    }),
  );
  assert.equal(stopped.name, "AbortError");
  assert.equal(isTransientKubectlFailure(stopped), false);
});

test("anything but a plain get with embedded credentials is left to kubectl", async (t) => {
  const { selection, kubeconfig, kubectlRuns } = await cluster(t);
  for (const args of [
    ["get", "pods", "-o", "jsonpath={.items}"],
    ["get", "pods"],
    ["get", "pods,services", "-o", "json"],
    ["get", "pod/web-1", "-o", "json"],
    ["get", "pods", "--ignore-not-found", "-o", "json"],
    ["get", "pod", "web-1", "-A", "-o", "json"],
    ["get", "pods", "--request-timeout=1h", "-o", "json"],
    ["exec", "web-1", "--", "true"],
  ]) {
    assert.equal(plainGet(args), undefined, args.join(" "));
    assert.equal(await kubectlGetJson(selection, args), undefined, args.join(" "));
  }
  // A kind discovery does not list, so kubectl can report it.
  assert.equal(await kubectlGetJson(selection, ["get", "widgets", "-o", "json"]), undefined);

  // Credentials from a plugin or from files, or no kubeconfig at all, are kubectl's,
  // decided without running it.
  const before = (await kubectlRuns()).length;
  const execUser = await kubeconfig("https://127.0.0.1:1", { exec: { command: "token" } });
  await writeFile(
    execUser.kubeconfigPath,
    (await readFile(execUser.kubeconfigPath, "utf8")).replace(
      "certificate-authority-data",
      "certificate-authority",
    ),
  );
  const pods = ["get", "pods", "-o", "json"];
  assert.equal(await kubectlGetJson(execUser, pods), undefined);
  assert.equal(
    await kubectlGetJson({ kubeconfigPath: undefined, kubernetesContext: "x" }, pods),
    undefined,
  );
  assert.equal((await kubectlRuns()).length, before);

  // A kubeconfig with embedded CA data but a plugin user is read once, then kubectl's.
  const pluginUser = await kubeconfig("https://127.0.0.1:1", { exec: { command: "token" } });
  assert.equal(await kubectlGetJson(pluginUser, pods), undefined);
  assert.equal(await kubectlGetJson(pluginUser, pods), undefined);
  assert.equal((await kubectlRuns()).length, before + 1);
});
