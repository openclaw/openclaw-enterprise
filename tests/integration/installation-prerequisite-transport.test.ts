import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer, request, type RequestListener } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { TLSSocket } from "node:tls";
import { certificateAuthority, signedLeaf } from "../helpers/certificates.ts";
import { listen } from "../helpers/listen.ts";

type Observation = {
  id: string;
  status: string;
  summary: string;
  action?: string;
};
type Reply = { status: number; body: object | string; location?: string };
type ApiRequest = {
  path: string;
  labelSelector: string | null;
  bearer: string | undefined;
  hasClientCertificate: boolean;
  tlsServerName: unknown;
};

function kubernetesStatus(code: number, reason: string): Reply {
  return {
    status: code,
    body: { kind: "Status", apiVersion: "v1", status: "Failure", reason, code },
  };
}

// Serve the discovery and named reads used by genuine kubectl over loopback.
// Neither endpoint needs a Kubernetes cluster or any real credential.
function api(
  requests: ApiRequest[],
  resource: (request: ApiRequest) => Reply | undefined,
): RequestListener {
  return (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    const received = {
      path,
      labelSelector: url.searchParams.get("labelSelector"),
      bearer: request.headers.authorization,
      hasClientCertificate: request.socket instanceof TLSSocket && request.socket.authorized,
      tlsServerName: "servername" in request.socket ? request.socket.servername : undefined,
    };
    requests.push(received);
    let reply = resource(received);
    if (reply === undefined) {
      if (path === "/api") {
        reply = {
          status: 200,
          body: { kind: "APIVersions", apiVersion: "v1", versions: ["v1"] },
        };
      } else if (path === "/apis") {
        reply = {
          status: 200,
          body: { kind: "APIGroupList", apiVersion: "v1", groups: [] },
        };
      } else if (path === "/api/v1") {
        reply = {
          status: 200,
          body: {
            kind: "APIResourceList",
            apiVersion: "v1",
            groupVersion: "v1",
            resources: [
              {
                name: "services",
                singularName: "service",
                kind: "Service",
                namespaced: true,
                verbs: ["get"],
              },
            ],
          },
        };
      } else {
        reply = kubernetesStatus(404, "NotFound");
      }
    }
    // Status zero leaves the API request pending for the interruption case.
    if (reply.status > 0) {
      response.writeHead(reply.status, {
        "content-type": "application/json",
        ...(reply.location ? { location: reply.location } : {}),
      });
      response.end(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body));
    }
  };
}

const apiPath = "/api/v1/namespaces/default/services/kubernetes";
const apiSlicesPath = "/apis/discovery.k8s.io/v1/namespaces/default/endpointslices";
const rolloutPath = "/apis/apps/v1/namespaces/default/deployments/controller";
const rolloutCheck = "controller:default/controller";
const servicePath = "/api/v1/namespaces/default/services/dependency";
const policyPath =
  "/apis/networking.k8s.io/v1/namespaces/default/networkpolicies/dependency-egress";
const dnsName = "gateway.test.invalid";

function serviceReply(name: string, spec: object) {
  return {
    status: 200,
    body: {
      kind: "Service",
      apiVersion: "v1",
      metadata: {
        name,
        namespace: "default",
        uid: randomUUID(),
        resourceVersion: "1",
      },
      spec,
    },
  };
}

const clientProbe = spawnSync(
  "kubectl",
  ["--kubeconfig", "/dev/null", "version", "--client", "-o", "json"],
  {
    encoding: "utf8",
    env: { ...process.env, KUBECTL_KUBERC: "false", KUBERC: "off" },
  },
);
const kubectlError = clientProbe.error;
const withoutKubectl =
  !process.env.OCC_TEST_KUBERNETES_CONFIGURATION &&
  kubectlError !== undefined &&
  "code" in kubectlError &&
  kubectlError.code === "ENOENT";

test(
  "installation prerequisites keep genuine kubectl on the selected verified transport",
  { skip: withoutKubectl && "requires kubectl", timeout: 120_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "prerequisite-transport-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const source = join(directory, "source");
    const scratch = join(directory, "scratch");
    await mkdir(source, { mode: 0o700 });
    await mkdir(scratch, { mode: 0o700 });
    const operatorHome = join(directory, "operator");
    await mkdir(join(operatorHome, ".kube"), { recursive: true, mode: 0o700 });
    const caName = "prerequisite transport test CA";
    const ca = await certificateAuthority(source, { caName });
    const server = await signedLeaf(source, ca, {
      name: "server",
      commonName: dnsName,
      subjectAltName: `IP:127.0.0.1,DNS:${dnsName}`,
      usage: "serverAuth",
    });
    const client = await signedLeaf(source, ca, {
      name: "client",
      commonName: "prerequisite-test-reader",
      usage: "clientAuth",
    });
    const token = randomUUID();
    const rolloutUid = randomUUID();
    const selectedController = { name: "controller", namespace: "default" };
    let rolloutIdentity = selectedController;
    const refreshedToken = randomUUID();
    const replacementToken = randomUUID();
    const caBundle = await readFile(ca.caPath);
    const tokenFile = join(source, "reader-token");
    const keyData = Buffer.from(client.key).toString("base64");
    await writeFile(tokenFile, token, { mode: 0o600 });
    const plugin = {
      apiVersion: "client.authentication.k8s.io/v1",
      kind: "ExecCredential",
      status: { token },
    };
    const pluginPath = join(source, "credential-plugin");
    const pluginMarker = join(source, "credential-plugin-started");
    await writeFile(
      pluginPath,
      `#!/bin/sh\necho started >> "$TEST_PLUGIN_MARKER"\nprintf '%s\\n' '${JSON.stringify(plugin)}'\n`,
      { mode: 0o700 },
    );

    const path = join(source, "kubeconfig");
    const plan = join(directory, "plan.json");
    const httpsRequests: ApiRequest[] = [];
    const httpRequests: ApiRequest[] = [];
    let firstServiceRead: (() => void) | undefined;
    let pauseServiceRead = false;
    let dependencyReply: Reply | undefined;
    let deniedPath: string | undefined;
    let apiServiceReply: Reply | undefined;
    let apiSlicesReply: Reply | undefined;
    let redirect: { path: string; location: string } | undefined;
    let proxyTunnel: { authority: string; port: number } | undefined;
    const plaintext = createServer(api(httpRequests, () => undefined));
    // The proxy never resolves the CONNECT authority. It can forward the
    // selected test authority only to the independently bound loopback fixture.
    plaintext.on("connect", (request, socket, head) => {
      httpRequests.push({
        path: request.url ?? "",
        labelSelector: null,
        bearer: request.headers.authorization,
        hasClientCertificate: false,
        tlsServerName: undefined,
      });
      if (!proxyTunnel || request.url !== proxyTunnel.authority) {
        socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        return;
      }
      const upstream = createConnection({
        host: "127.0.0.1",
        port: proxyTunnel.port,
      });
      socket.once("error", () => upstream.destroy());
      socket.once("close", () => upstream.destroy());
      upstream.once("error", () => socket.destroy());
      upstream.once("close", () => socket.destroy());
      upstream.once("connect", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        upstream.write(head);
        socket.pipe(upstream).pipe(socket);
      });
    });
    const plaintextPort = await listen(t, plaintext);
    let refreshCalls = 0;
    let refreshRequest: { method: string | undefined; form: URLSearchParams } | undefined;
    const refreshToken = randomUUID();
    const successor = randomUUID();
    const idToken = (exp: number) =>
      `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.`;
    const expiredIdToken = idToken(1);
    const currentIdToken = idToken(Math.floor(Date.now() / 1_000) + 600);
    let quotaReply: Reply | undefined;
    const verifiedApi = api(httpsRequests, ({ path: requestPath }) => {
      if (redirect?.path === requestPath) {
        return { status: 307, location: redirect.location, body: {} };
      }
      if (quotaReply && requestPath === "/api/v1/namespaces/default") {
        return {
          status: 200,
          body: {
            apiVersion: "v1",
            kind: "Namespace",
            metadata: { name: "default", uid: "selected-namespace" },
          },
        };
      }
      if (requestPath === "/api/v1/namespaces/default/resourcequotas") {
        return quotaReply;
      }
      if (requestPath === rolloutPath) {
        return {
          status: 200,
          body: {
            kind: "Deployment",
            apiVersion: "apps/v1",
            metadata: {
              ...rolloutIdentity,
              uid: rolloutUid,
              resourceVersion: "42",
              generation: 3,
            },
            spec: { replicas: 2 },
            status: {
              observedGeneration: 3,
              replicas: 2,
              updatedReplicas: 2,
              availableReplicas: 2,
              conditions: [{ type: "Available", status: "True" }],
            },
          },
        };
      }
      if (requestPath === "/identity/.well-known/openid-configuration") {
        return {
          status: 200,
          body: { issuer: oidcIssuer, token_endpoint: `${oidcIssuer}/token` },
        };
      }
      if (requestPath === "/identity/token") {
        refreshCalls++;
        const validRefresh =
          refreshRequest?.method === "POST" &&
          refreshRequest.form.get("grant_type") === "refresh_token" &&
          refreshRequest.form.get("refresh_token") === refreshToken;
        return refreshCalls === 1 && validRefresh
          ? {
              status: 200,
              body: {
                access_token: successor,
                refresh_token: successor,
                id_token: currentIdToken,
                token_type: "Bearer",
              },
            }
          : { status: 400, body: { error: "invalid_grant" } };
      }
      if (requestPath === apiPath) {
        firstServiceRead?.();
        return pauseServiceRead
          ? { status: 0, body: {} }
          : (apiServiceReply ?? serviceReply("kubernetes", { clusterIP: "10.32.0.1" }));
      }
      if (requestPath === apiSlicesPath && apiSlicesReply) {
        return apiSlicesReply;
      }
      if (requestPath === deniedPath) {
        return kubernetesStatus(403, "Forbidden");
      }
      if (requestPath === servicePath) {
        return dependencyReply;
      }
    });
    const serverIdentity = { cert: server.cert, key: server.key };
    const mutualTls = createTlsServer(
      {
        ...serverIdentity,
        ca: caBundle,
        requestCert: true,
        rejectUnauthorized: true,
      },
      verifiedApi,
    );
    let rejectedHandshakes = 0;
    mutualTls.on("tlsClientError", () => {
      rejectedHandshakes++;
    });
    const verifiedPort = await listen(t, mutualTls);
    // Exec and OIDC use an HTTPS endpoint with server authentication and bearer credentials.
    const bearerPort = await listen(
      t,
      createTlsServer(serverIdentity, (request, response) => {
        if (request.url !== "/identity/token") {
          verifiedApi(request, response);
          return;
        }
        // Read the actual form before deciding whether to consume the token.
        let body = "";
        request.setEncoding("utf8").on("data", (chunk: string) => {
          body += chunk;
        });
        request.once("end", () => {
          refreshRequest = {
            method: request.method,
            form: new URLSearchParams(body),
          };
          verifiedApi(request, response);
        });
      }),
    );
    const oidcIssuer = `https://127.0.0.1:${bearerPort}/identity`;
    const endpoint = {
      verified: {
        server: `https://127.0.0.1:${verifiedPort}`,
        "certificate-authority": basename(ca.caPath),
      },
      bearer: {
        server: `https://127.0.0.1:${bearerPort}`,
        "certificate-authority": basename(ca.caPath),
      },
      plaintext: { server: `http://127.0.0.1:${plaintextPort}` },
    };
    function config(
      target: keyof typeof endpoint,
      user: object,
      cluster: object = endpoint[target],
    ) {
      return JSON.stringify({
        apiVersion: "v1",
        kind: "Config",
        "current-context": "unused",
        contexts: [
          { name: "selected", context: { cluster: target, user: target } },
          { name: "unused", context: { cluster: "unused" } },
        ],
        clusters: [
          { name: target, cluster },
          { name: "unused", cluster: endpoint.plaintext },
        ],
        users: [{ name: target, user }],
      });
    }
    const relativeFiles = {
      tokenFile: "reader-token",
      "client-certificate": basename(client.certPath),
      "client-key": basename(client.keyPath),
    };
    const verifiedConfig = config("verified", relativeFiles);
    const plaintextConfig = config("plaintext", { token: replacementToken });
    const planInput = {
      kubeconfig: path,
      context: "selected",
      namespace: "default",
      gatewayClass: {
        name: "gateway",
        controllerName: "example.test/controller",
      },
      controllers: [selectedController],
      crds: [{ name: "gateways.gateway.networking.k8s.io", version: "v1" }],
      apiCidrs: ["10.32.0.1/32"],
      serviceDependency: {
        service: { namespace: "default", name: "dependency", port: 443 },
        policy: { namespace: "default", name: "dependency-egress" },
      },
    };
    const diagnosticArgs = ["--config", plan, "--json"];
    function collect(
      environment: NodeJS.ProcessEnv = {},
      expectCleanup = true,
      args = diagnosticArgs,
    ) {
      const processHandle = spawn(
        process.execPath,
        ["scripts/diagnose-kubernetes-prerequisites.ts", ...args],
        {
          env: {
            ...process.env,
            HOME: operatorHome,
            KUBERC: undefined,
            KUBECTL_KUBERC: undefined,
            TEST_PLUGIN_MARKER: pluginMarker,
            TMPDIR: scratch,
            KUBECACHEDIR: join(directory, "cache"),
            ...environment,
          },
          stdio: ["ignore", "pipe", "pipe"],
          signal: t.signal,
        },
      );
      let stdout = "";
      let stderr = "";
      processHandle.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
      });
      processHandle.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk;
      });
      const result = once(processHandle, "close").then(async ([code]) => {
        const output = stdout + stderr;
        assert.equal(
          [
            token,
            refreshedToken,
            replacementToken,
            refreshToken,
            successor,
            currentIdToken,
            expiredIdToken,
            keyData,
            "PRIVATE KEY",
          ].some((value) => output.includes(value)),
          false,
        );
        if (expectCleanup) {
          assert.deepEqual(
            await readdir(environment.TMPDIR ?? scratch),
            [],
            "private collection files were removed",
          );
        }
        return { code, output, stdout, stderr };
      });
      return { processHandle, result };
    }
    async function observations(
      kubeconfig: string,
      expectedCode: number | null = 1,
      environment?: NodeJS.ProcessEnv,
      args = diagnosticArgs,
    ) {
      await writeFile(path, kubeconfig, { mode: 0o600 });
      httpsRequests.length = 0;
      httpRequests.length = 0;
      const { code, output } = await collect(environment, true, args).result;
      if (expectedCode !== null) {
        assert.equal(code, expectedCode);
      }
      const { checks } = JSON.parse(output) as { checks: Observation[] };
      return new Map(checks.map((check) => [check.id, check]));
    }

    await t.test("unsupported plan fields stop diagnosis before Kubernetes reads", async () => {
      await writeFile(path, verifiedConfig, { mode: 0o600 });
      const { serviceDependency, ...required } = planInput;
      // A requested check must never disappear from a successful report.
      for (const [input, message] of [
        [{ ...required, serviceDependecy: serviceDependency }, /only supported top-level fields/u],
        [
          {
            ...required,
            serviceDependency: {
              ...serviceDependency,
              tls: { secretName: "leaf", serverName: dnsName },
            },
          },
          /serviceDependency accepts only service and policy/u,
        ],
      ] as const) {
        await writeFile(plan, JSON.stringify(input));
        const { code, stdout, stderr } = await collect().result;
        assert.equal(code, 2);
        assert.equal(stdout, "");
        assert.match(stderr, message);
        assert.equal(httpsRequests.length + httpRequests.length, 0);
      }
    });
    await writeFile(plan, JSON.stringify(planInput));
    await t.test("mutual TLS refuses missing or untrusted client certificates", async () => {
      const untrustedDirectory = join(source, "untrusted");
      await mkdir(untrustedDirectory, { mode: 0o700 });
      // Use the trusted issuer's name on an unrelated CA. A matching name
      // does not establish trust in the client's certificate signature.
      const untrustedCa = await certificateAuthority(untrustedDirectory, {
        caName,
      });
      const untrustedClient = await signedLeaf(untrustedDirectory, untrustedCa, {
        name: "client",
        usage: "clientAuth",
      });

      for (const user of [
        { tokenFile: relativeFiles.tokenFile },
        {
          ...relativeFiles,
          "client-certificate": untrustedClient.certPath,
          "client-key": untrustedClient.keyPath,
        },
      ]) {
        rejectedHandshakes = 0;
        const checks = await observations(config("verified", user), 2);
        assert.equal(checks.get("kubernetes-api")?.status, "unknown");
        assert.ok(rejectedHandshakes > 0, "the TLS handshake failed");
        assert.equal(httpsRequests.length, 0, "the rejected client sent no API request");
      }

      const checks = await observations(
        config("verified", relativeFiles, {
          ...endpoint.verified,
          "certificate-authority": untrustedCa.caPath,
        }),
        2,
      );
      assert.equal(checks.get("kubernetes-api")?.status, "unknown");
      assert.equal(httpsRequests.length, 0, "kubectl refused the untrusted server certificate");
    });
    await t.test(
      "replacing the context and CA cannot redirect the rollout or Service GET",
      async () => {
        firstServiceRead = () => {
          // Change the context and user, revoke the on-disk CA, and rotate the token
          // after kubectl has established the original authenticated connection.
          writeFileSync(path, plaintextConfig);
          writeFileSync(ca.caPath, "invalid replacement CA");
          writeFileSync(tokenFile, refreshedToken);
        };
        try {
          const checks = await observations(verifiedConfig);
          assert.equal(checks.get("kubernetes-api")?.status, "passed");
          assert.equal(httpRequests.length, 0, "no request reached the plaintext endpoint");
          const apiRead = httpsRequests.find(({ path }) => path === apiPath);
          assert.ok(
            apiRead?.bearer === `Bearer ${token}`,
            "the first read used the original token",
          );
          const rolloutReads = httpsRequests.filter(({ path }) => path === rolloutPath);
          assert.equal(rolloutReads.length, 1, "only the selected Deployment is read");
          assert.ok(
            rolloutReads[0]?.hasClientCertificate &&
              rolloutReads[0].bearer === `Bearer ${refreshedToken}`,
            "the rollout read remains on the pinned authenticated endpoint",
          );
          assert.equal(checks.get(rolloutCheck)?.status, "passed");
          const serviceRead = httpsRequests.find(({ path }) => path === servicePath);
          assert.ok(
            serviceRead?.hasClientCertificate,
            "kubectl presented the relative client certificate",
          );
          assert.ok(
            serviceRead.bearer === `Bearer ${refreshedToken}`,
            "the verified endpoint received the rotated token",
          );
          assert.equal(checks.get("service-egress")?.status, "failed");
        } finally {
          firstServiceRead = undefined;
          await Promise.all([writeFile(ca.caPath, caBundle), writeFile(tokenFile, token)]);
        }
      },
    );
    await t.test(
      "first and later authenticated reads never follow redirects",
      async (redirectTest) => {
        const alternateRequests: ApiRequest[] = [];
        const alternatePort = await listen(
          redirectTest,
          createTlsServer(
            { cert: server.cert, key: server.key },
            api(alternateRequests, () => undefined),
          ),
        );
        try {
          const normal = await observations(verifiedConfig);
          assert.equal(normal.get("kubernetes-api")?.status, "passed");
          assert.equal(normal.get(rolloutCheck)?.status, "passed");

          for (const [path, id, location] of [
            [apiPath, "kubernetes-api", `http://localhost:${plaintextPort}/sink`],
            [rolloutPath, rolloutCheck, `https://127.0.0.1:${alternatePort}/sink`],
            [rolloutPath, rolloutCheck, "/sink"],
          ] as const) {
            redirect = { path, location };
            const checks = await observations(verifiedConfig, null);
            assert.ok(
              httpsRequests.some(
                (request) => request.path === path && request.bearer === `Bearer ${token}`,
              ),
              "the verified API received the original authenticated read",
            );
            assert.equal(
              httpRequests.length + alternateRequests.length,
              0,
              "no request reached another origin",
            );
            assert.ok(
              !httpsRequests.some((request) => request.path === "/sink"),
              "no same-origin follow-up",
            );
            assert.equal(checks.get(id)?.status, "unknown");
            assert.match(checks.get(id)?.summary ?? "", /unexpected redirect/u);
          }
        } finally {
          redirect = undefined;
        }
      },
    );
    const execUser = {
      exec: {
        apiVersion: plugin.apiVersion,
        command: "./credential-plugin",
        interactiveMode: "Never",
      },
    };
    const execConfig = config("bearer", execUser);
    const kubectl = spawnSync("sh", ["-c", "command -v kubectl"], {
      encoding: "utf8",
    });
    assert.equal(kubectl.status, 0);
    await t.test("a late kuberc policy cannot be bypassed to run an exec plugin", async () => {
      const bin = join(directory, "late-policy-bin");
      await mkdir(bin);
      const policy = join(operatorHome, ".kube", "kuberc");
      await writeFile(
        join(bin, "kubectl"),
        `#!/bin/sh
if [ "$5" = config ] && [ "$6" = view ]; then
  "$TEST_KUBECTL" "$@" || exit $?
  cat > "$TEST_KUBERC_PATH" <<'PREFERENCE'
apiVersion: kubectl.config.k8s.io/v1beta1
kind: Preference
credentialPluginPolicy: DenyAll
PREFERENCE
else
  exec "$TEST_KUBECTL" "$@"
fi
`,
        { mode: 0o700 },
      );
      try {
        const checks = await observations(execConfig, 1, {
          PATH: `${bin}:${process.env.PATH}`,
          TEST_KUBECTL: kubectl.stdout.trim(),
          TEST_KUBERC_PATH: policy,
        });
        assert.match(await readFile(policy, "utf8"), /credentialPluginPolicy: DenyAll/u);
        assert.equal(checks.get("kubernetes-api")?.status, "failed");
        assert.match(checks.get("kubernetes-api")?.action ?? "", /credential owner/u);
        assert.equal(httpsRequests.length + httpRequests.length, 0);
        await assert.rejects(stat(pluginMarker), { code: "ENOENT" });
      } finally {
        await rm(policy, { force: true });
      }
    });
    await t.test(
      "authorized relative exec credentials still reach the verified server",
      async () => {
        const checks = await observations(execConfig, 1, { KUBERC: "off" });
        assert.equal(checks.get("kubernetes-api")?.status, "passed");
        const serviceRead = httpsRequests.find(({ path }) => path === servicePath);
        assert.ok(
          serviceRead?.bearer === `Bearer ${token}`,
          "kubectl used the relative exec plugin",
        );
        assert.equal(checks.get("service-egress")?.status, "failed");
        assert.match(checks.get("service-egress")?.action ?? "", /Service owner/u);
      },
    );
    const preference = { apiVersion: "kubectl.config.k8s.io/v1beta1", kind: "Preference" };
    const allowlist = (...names: string[]) => ({
      ...preference,
      credentialPluginPolicy: "Allowlist",
      credentialPluginAllowlist: names.map((name) => ({ name })),
    });
    const policyFile = join(source, "required-kuberc");
    const policyArgs = [...diagnosticArgs, "--require-kuberc"];
    // Select expectations from the actual client, independently of the CLI under test.
    assert.equal(clientProbe.status, 0);
    const { clientVersion } = JSON.parse(clientProbe.stdout);
    const supportsPolicy =
      clientVersion.platform === "linux/amd64" &&
      ["v1.35.0", "v1.36.2", "v1.36.4"].includes(clientVersion.gitVersion);
    const policyClient = { skip: supportsPolicy ? false : "requires a qualified kubectl" };

    const denyAll = JSON.stringify({ ...preference, credentialPluginPolicy: "DenyAll" });
    if (!supportsPolicy) {
      await t.test(
        "an unqualified client refuses required policy before authentication",
        async () => {
          await writeFile(path, execConfig, { mode: 0o600 });
          await writeFile(policyFile, JSON.stringify(allowlist(pluginPath)));
          await rm(pluginMarker, { force: true });
          httpsRequests.length = 0;
          httpRequests.length = 0;
          const result = await collect({ KUBERC: policyFile }, true, policyArgs).result;
          assert.equal(result.code, 2);
          assert.equal(result.stdout, "");
          assert.match(result.stderr, /stock kubectl/u);
          await assert.rejects(stat(pluginMarker), { code: "ENOENT" });
          assert.equal(httpsRequests.length + httpRequests.length, 0);
        },
      );
    }
    for (const [name, user, code, status] of [
      ["DenyAll", execUser, 2, "unknown"],
      ["a static token alongside exec", { ...execUser, token: replacementToken }, 1, "failed"],
    ] as const) {
      await t.test(
        `required kuberc prevents credential use with ${name}`,
        policyClient,
        async () => {
          await writeFile(policyFile, denyAll);
          await rm(pluginMarker, { force: true });
          const checks = await observations(
            config("bearer", user),
            code,
            { KUBERC: policyFile },
            policyArgs,
          );
          assert.equal(checks.get("kubernetes-api")?.status, status);
          await assert.rejects(stat(pluginMarker), { code: "ENOENT" });
          assert.equal(httpsRequests.length + httpRequests.length, 0);
        },
      );
    }
    await t.test(
      "required kuberc rejects missing or invalid policy and conflicting flags before authentication",
      async () => {
        await writeFile(path, execConfig, { mode: 0o600 });
        await rm(pluginMarker, { force: true });
        httpsRequests.length = 0;
        httpRequests.length = 0;
        for (const [policy, extraArgs, error] of [
          [undefined, [], /requires an absolute KUBERC path/u],
          [denyAll.replace("DenyAll", "Unknown"), [], /policy-only/u],
          [denyAll.replace("DenyAll", "Deny\\u0041ll"), [], /policy-only/u],
          [denyAll, ["--context", "selected"], /Usage:/u],
        ] as const) {
          if (policy !== undefined) {
            await writeFile(policyFile, policy);
          }
          const { code, stdout, stderr } = await collect(
            { KUBERC: policy === undefined ? undefined : policyFile },
            true,
            [...policyArgs, ...extraArgs],
          ).result;
          assert.equal(code, 2);
          assert.equal(stdout, "");
          assert.match(stderr, error);
        }
        await assert.rejects(stat(pluginMarker), { code: "ENOENT" });
        assert.equal(httpsRequests.length + httpRequests.length, 0);
      },
    );
    await t.test(
      "a change to required kuberc at proxy startup stops the first authenticated read",
      policyClient,
      async () => {
        await writeFile(path, execConfig, { mode: 0o600 });
        await writeFile(policyFile, JSON.stringify(allowlist(pluginPath)));
        await rm(pluginMarker, { force: true });
        httpsRequests.length = 0;
        httpRequests.length = 0;
        // Change only the source after the pre-spawn check. The real proxy starts
        // with an unchanged private policy that still permits the plugin.
        const bin = join(directory, "proxy-start-bin");
        await mkdir(bin);
        const replacement = JSON.stringify(allowlist(pluginPath, "another-plugin"));
        await writeFile(
          join(bin, "kubectl"),
          `#!/bin/sh
for arg do
  if [ "$arg" = --unix-socket ]; then
    printf '%s' "$TEST_REPLACEMENT" > "$TEST_KUBERC_PATH" || exit 1
  fi
done
exec "$TEST_KUBECTL" "$@"
`,
          { mode: 0o700 },
        );
        const { code, stdout, stderr } = await collect(
          {
            PATH: `${bin}:${process.env.PATH}`,
            KUBERC: policyFile,
            TEST_KUBECTL: kubectl.stdout.trim(),
            TEST_KUBERC_PATH: policyFile,
            TEST_REPLACEMENT: replacement,
          },
          true,
          policyArgs,
        ).result;
        assert.equal(await readFile(policyFile, "utf8"), replacement);
        assert.deepEqual(
          httpsRequests.map(({ path, bearer }) => ({
            path,
            authenticated: bearer === `Bearer ${token}`,
          })),
          [],
        );
        assert.equal(httpRequests.length, 0);
        await assert.rejects(stat(pluginMarker), { code: "ENOENT" });
        assert.equal(code, 2);
        assert.equal(stdout, "");
        assert.match(stderr, /kuberc.*changed/iu);
      },
    );
    await t.test(
      "a change to required kuberc stops later authenticated reads",
      policyClient,
      async () => {
        await writeFile(path, execConfig, { mode: 0o600 });
        await writeFile(policyFile, JSON.stringify(allowlist(pluginPath)));
        await rm(pluginMarker, { force: true });
        httpsRequests.length = 0;
        httpRequests.length = 0;
        firstServiceRead = () => {
          // The replacement also allows this plugin. Only a check for a change
          // to the original policy can stop the next read.
          writeFileSync(policyFile, JSON.stringify(allowlist(pluginPath, "another-plugin")));
        };
        try {
          const { code, stdout, stderr } = await collect({ KUBERC: policyFile }, true, policyArgs)
            .result;
          assert.deepEqual(
            httpsRequests.map(({ path }) => path),
            [apiPath],
          );
          assert.ok(httpsRequests[0]?.bearer === `Bearer ${token}`);
          assert.equal(httpRequests.length, 0);
          assert.equal(await readFile(pluginMarker, "utf8"), "started\n");
          assert.equal(code, 2);
          assert.equal(stdout, "");
          assert.match(stderr, /kuberc.*changed/iu);
        } finally {
          firstServiceRead = undefined;
        }
      },
    );
    await t.test("plaintext contexts fail before any Kubernetes request", async () => {
      const checks = await observations(plaintextConfig);
      assert.equal(checks.get("kubernetes-api")?.status, "failed");
      assert.equal(checks.get("service-egress")?.status, "unknown");
      assert.equal(httpRequests.length + httpsRequests.length, 0);
    });
    await t.test("a malformed https server never contacts a plaintext proxy", async () => {
      const checks = await observations(
        config(
          "plaintext",
          { token: replacementToken },
          {
            server: "https:1234",
            "proxy-url": endpoint.plaintext.server,
          },
        ),
      );
      assert.equal(httpRequests.length + httpsRequests.length, 0);
      assert.equal(checks.get("kubernetes-api")?.status, "failed");
      assert.match(checks.get("service-egress")?.action ?? "", /Resolve kubernetes-api/u);
    });
    await t.test("built-in OIDC is refused before refreshing the original credential", async () => {
      const original = config("bearer", {
        "auth-provider": {
          name: "oidc",
          config: {
            "client-id": "loopback-fixture",
            "idp-issuer-url": oidcIssuer,
            "idp-certificate-authority-data": caBundle.toString("base64"),
            "id-token": expiredIdToken,
            "refresh-token": refreshToken,
          },
        },
      });
      const checks = await observations(original);
      assert.equal(httpsRequests.length + httpRequests.length, 0, "no API or OIDC reads");
      assert.equal(refreshCalls, 0);
      assert.equal(checks.get("kubernetes-api")?.status, "failed");
      assert.match(checks.get("kubernetes-api")?.action ?? "", /exec plugin/u);
      assert.ok((await readFile(path, "utf8")) === original, "original kubeconfig is intact");

      // The same kubeconfig remains usable directly. Genuine kubectl may consume
      // the fixture's one-time token when it can persist its successor in the original.
      const direct = spawn(
        "kubectl",
        [
          "--kubeconfig",
          path,
          "--context",
          "selected",
          "--request-timeout=5s",
          "-n",
          "default",
          "get",
          "service",
          "kubernetes",
          "-o",
          "name",
        ],
        {
          env: {
            ...process.env,
            HOME: operatorHome,
            KUBERC: "off",
            KUBECACHEDIR: join(directory, "cache"),
          },
          stdio: "ignore",
          signal: t.signal,
        },
      );
      const [code] = await once(direct, "close");
      assert.equal(refreshCalls, 1);
      assert.equal(refreshRequest?.method, "POST");
      assert.equal(refreshRequest.form.get("grant_type"), "refresh_token");
      assert.ok(
        refreshRequest.form.get("refresh_token") === refreshToken,
        "kubectl submitted the original refresh token",
      );
      assert.equal(code, 0);
      assert.ok(
        httpsRequests.some(
          ({ path, bearer }) => path === apiPath && bearer === `Bearer ${currentIdToken}`,
        ),
        "the HTTPS API Service read used the issued bearer",
      );
      assert.ok(
        (await readFile(path, "utf8")).includes(successor),
        "kubectl persisted the successor",
      );
    });
    await t.test(
      "EKS reads use a literal verified loopback tunnel and refuse a numeric alias",
      async (eksTest) => {
        // Stub only the off-cluster AWS inventory. Every Kubernetes request still
        // passes through genuine kubectl, which verifies the loopback TLS endpoint.
        const clusterArn = "arn:aws:eks:us-west-2:123456789012:cluster/fixture";
        const awsCommand = join(directory, "aws");
        const awsCalls = join(directory, "aws-inventory-calls");
        const inventory = {
          sts: { Account: "123456789012" },
          eks: {
            cluster: {
              arn: clusterArn,
              name: "fixture",
              endpoint: `https://${dnsName}`,
              certificateAuthority: { data: caBundle.toString("base64") },
              resourcesVpcConfig: {
                vpcId: "vpc-123abc",
                clusterSecurityGroupId: "sg-123abc",
              },
            },
          },
          ec2: {
            NetworkInterfaces: [
              { PrivateIpAddresses: [{ PrivateIpAddress: "10.0.0.2" }] },
              {
                PrivateIpAddresses: [
                  { PrivateIpAddress: "10.0.0.1" },
                  { PrivateIpAddress: "10.0.0.2" },
                ],
              },
            ],
          },
        };
        const cases = Object.entries(inventory).map(
          ([service, body]) => `${service}) printf '%s\n' '${JSON.stringify(body)}';;`,
        );
        await writeFile(
          awsCommand,
          `#!/bin/sh
printf '%s\n' "$1" >> "$TEST_AWS_CALLS"
if [ "$1" = "--region" ]; then
  [ "$*" = "--region us-west-2 eks get-token --cluster-name fixture --output json" ] || exit 9
  : > "$TEST_PLUGIN_MARKER"
  printf '%s\n' '${JSON.stringify({ ...plugin, apiVersion: "client.authentication.k8s.io/v1beta1" })}'
  exit 0
fi
# A direct AWS credential process must inherit the caller's kubectl preferences.
[ "$KUBERC" = "$TEST_EXPECTED_KUBERC" ] || exit 10
case "$1" in
${cases.join("\n")}
*) exit 1;;
esac
`,
          { mode: 0o700 },
        );
        const environment = {
          PATH: `${directory}:${process.env.PATH}`,
          TEST_AWS_CALLS: awsCalls,
          KUBERC: join(directory, "operator-preferences"),
          TEST_EXPECTED_KUBERC: join(directory, "operator-preferences"),
        };
        const tunnel = { ...endpoint.verified, "tls-server-name": dnsName };
        await writeFile(
          plan,
          JSON.stringify({
            ...planInput,
            eks: { clusterArn, webhookCidrs: ["10.0.0.1/32", "10.0.0.2/32"] },
          }),
        );
        try {
          const checks = await observations(
            config("verified", relativeFiles, tunnel),
            1,
            environment,
          );
          assert.equal(checks.get("eks-cluster-identity")?.status, "passed");
          assert.equal(checks.get("webhook-addresses")?.status, "passed");
          assert.equal(checks.get("kubernetes-api")?.status, "passed");
          const serviceRead = httpsRequests.find(({ path }) => path === servicePath);
          assert.equal(serviceRead?.tlsServerName, dnsName);
          assert.equal(httpRequests.length, 0);

          const alias = {
            ...tunnel,
            server: `https://0x7f000001:${verifiedPort}`,
            "proxy-url": endpoint.plaintext.server,
          };
          const refused = await observations(
            config("verified", relativeFiles, alias),
            1,
            environment,
          );
          assert.equal(refused.get("eks-cluster-identity")?.status, "failed");
          assert.equal(refused.get("kubernetes-api")?.status, "unknown");
          assert.match(
            refused.get("service-egress")?.action ?? "",
            /Resolve eks-cluster-identity/u,
          );
          assert.equal(httpsRequests.length + httpRequests.length, 0);

          await eksTest.test("EKS inventory keeps its opt-in and exact read scope", async () => {
            const args = [
              "--inventory-eks",
              clusterArn,
              "--kubeconfig",
              path,
              "--context",
              "selected",
            ];
            await writeFile(path, config("verified", relativeFiles, tunnel), {
              mode: 0o600,
            });
            httpsRequests.length = 0;
            await writeFile(awsCalls, "");
            const refused = await collect({ ...environment, KUBERC: "off" }, true, args).result;
            assert.equal(refused.code, 2);
            assert.equal(refused.stdout, "");
            assert.match(refused.stderr, /explicit KUBECTL_KUBERC=false/u);
            assert.equal(httpsRequests.length, 0);
            assert.equal(await readFile(awsCalls, "utf8"), "");

            // Use the kubeconfig exec entry aws eks update-kubeconfig writes for this cluster.
            const execTunnel = { ...endpoint.bearer, "tls-server-name": dnsName };
            const awsConfig = (cluster = execTunnel) =>
              config(
                "bearer",
                {
                  exec: {
                    apiVersion: "client.authentication.k8s.io/v1beta1",
                    command: "aws",
                    args: [
                      "--region",
                      "us-west-2",
                      "eks",
                      "get-token",
                      "--cluster-name",
                      "fixture",
                      "--output",
                      "json",
                    ],
                  },
                },
                cluster,
              );
            const preferences = join(operatorHome, ".kube", "kuberc");
            await writeFile(
              preferences,
              [
                "apiVersion: kubectl.config.k8s.io/v1beta1",
                "kind: Preference",
                "credentialPluginPolicy: DenyAll",
                "defaults:",
                "- command: proxy",
                "  options:",
                "  - name: server",
                "    default: " + endpoint.plaintext.server,
                "  - name: address",
                "    default: 0.0.0.0",
              ].join("\n"),
              { mode: 0o600 },
            );
            await rm(pluginMarker, { force: true });
            const noOptIn = await observations(awsConfig(), 1, environment);
            assert.equal(noOptIn.get("kubernetes-api")?.status, "failed");
            assert.equal(httpsRequests.length + httpRequests.length, 0);
            await assert.rejects(stat(pluginMarker), { code: "ENOENT" });

            const optedIn = { ...environment, KUBECTL_KUBERC: "false" };
            async function expectInventoryFailure(
              reason: RegExp,
              inventoryArgs = args,
              env: NodeJS.ProcessEnv = optedIn,
            ) {
              const { code, stdout, stderr } = await collect(env, true, inventoryArgs).result;
              assert.equal(code, 2, stderr);
              assert.equal(stdout, "");
              assert.match(stderr, reason);
            }
            // An opt-in never authorizes the plugin for a different cluster or CA.
            const mismatches = [
              {
                kubeconfig: awsConfig(),
                args: [
                  "--inventory-eks",
                  clusterArn.replace(/fixture$/u, "other"),
                  ...args.slice(2),
                ],
              },
              {
                kubeconfig: awsConfig({ ...execTunnel, "certificate-authority": client.certPath }),
                args,
              },
            ];
            for (const mismatch of mismatches) {
              await writeFile(path, mismatch.kubeconfig, { mode: 0o600 });
              await expectInventoryFailure(/eks-cluster-identity/u, mismatch.args);
              assert.equal(httpsRequests.length + httpRequests.length, 0);
              await assert.rejects(stat(pluginMarker), { code: "ENOENT" });
            }

            function assertAuthenticatedReads() {
              assert.ok(httpsRequests.length > 0);
              assert.ok(
                httpsRequests.every(
                  ({ bearer, tlsServerName }) =>
                    bearer === "Bearer " + token && tlsServerName === dnsName,
                ),
              );
              assert.equal(httpRequests.length, 0);
            }
            const diagnosed = await observations(awsConfig(), 1, optedIn);
            for (const id of ["eks-cluster-identity", "webhook-addresses", "kubernetes-api"]) {
              assert.equal(diagnosed.get(id)?.status, "passed");
            }
            assertAuthenticatedReads();
            await stat(pluginMarker);
            httpsRequests.length = 0;

            // Inventory uses the production transport to read only the API Service and its slices.
            const sliceMetadata = (name: string, service = "kubernetes") => ({
              namespace: "default",
              name,
              labels: { "kubernetes.io/service-name": service },
            });
            const body = {
              apiVersion: "discovery.k8s.io/v1",
              kind: "EndpointSliceList",
              metadata: {},
              items: [
                {
                  metadata: sliceMetadata("kubernetes-v6"),
                  addressType: "IPv6",
                  endpoints: [{ addresses: ["fd00::1"] }],
                },
                {
                  metadata: sliceMetadata("kubernetes-v4"),
                  addressType: "IPv4",
                  endpoints: [{ addresses: ["10.0.2.10", "10.0.1.10", "10.0.2.10"] }],
                },
              ],
            };
            async function expectCompleteInventory(
              env: NodeJS.ProcessEnv,
              inventoryArgs: string[],
            ) {
              httpsRequests.length = 0;
              await rm(pluginMarker, { force: true });
              const accepted = await collect(env, true, inventoryArgs).result;
              assert.equal(accepted.code, 0, accepted.stderr);
              const report = JSON.parse(accepted.stdout) as {
                context: string;
                checkedAt: string;
                apiCidrs: string[];
                eks: { clusterArn: string; webhookCidrs: string[] };
              };
              assert.equal(report.context, "selected");
              assert.ok(Number.isFinite(Date.parse(report.checkedAt)));
              assert.deepEqual(report.apiCidrs, ["10.0.1.10/32", "10.0.2.10/32", "10.32.0.1/32"]);
              assert.deepEqual(report.eks, {
                clusterArn,
                webhookCidrs: ["10.0.0.1/32", "10.0.0.2/32"],
              });
              assert.deepEqual(
                httpsRequests.map(({ path, labelSelector }) => [path, labelSelector]),
                [
                  [apiPath, null],
                  [apiSlicesPath, "kubernetes.io/service-name=kubernetes"],
                ],
              );

              assertAuthenticatedReads();
              await stat(pluginMarker);
            }
            try {
              apiSlicesReply = { status: 200, body };
              await expectCompleteInventory(optedIn, args);

              // Direct AWS calls retain the caller's environment. Kubectl must
              // enforce the allowlist when invoking AWS as a credential plugin.
              const requiredArgs = [...args, "--require-kuberc"];
              await writeFile(environment.KUBERC, JSON.stringify(allowlist("another-plugin")));
              httpsRequests.length = 0;
              await rm(pluginMarker, { force: true });
              await expectInventoryFailure(
                supportsPolicy ? /kubernetes-api/u : /stock kubectl/u,
                requiredArgs,
                environment,
              );
              await assert.rejects(stat(pluginMarker), { code: "ENOENT" });
              assert.equal(httpsRequests.length + httpRequests.length, 0);

              if (supportsPolicy) {
                await writeFile(environment.KUBERC, JSON.stringify(allowlist("aws")));
                await expectCompleteInventory(environment, requiredArgs);
              }

              // Valid IPv4 replies cannot conceal a structurally invalid or unrelated item.
              for (const extra of [
                { metadata: sliceMetadata("missing-family"), endpoints: [] },
                { metadata: sliceMetadata("unknown-family"), addressType: "FQDN", endpoints: [] },
                {
                  metadata: sliceMetadata("unrelated", "another-service"),
                  addressType: "IPv4",
                  endpoints: [{ addresses: ["10.0.0.99"] }],
                },
                {
                  metadata: { ...sliceMetadata("cross-namespace"), namespace: "elsewhere" },
                  addressType: "IPv4",
                  endpoints: [{ addresses: ["10.0.0.99"] }],
                },
                {
                  metadata: sliceMetadata("wrong-family"),
                  addressType: "IPv6",
                  endpoints: [{ addresses: ["10.0.0.99"] }],
                },
              ]) {
                apiSlicesReply = { status: 200, body: { ...body, items: [...body.items, extra] } };
                await expectInventoryFailure(/EndpointSlice inventory is incomplete/u);
              }
              apiSlicesReply = { status: 200, body };
              apiServiceReply = serviceReply("kubernetes", {
                clusterIP: "10.32.0.1",
                clusterIPs: ["10.32.0.1", "invalid"],
              });
              await expectInventoryFailure(/Service address inventory is incomplete/u);
              apiServiceReply = undefined;

              redirect = {
                path: apiSlicesPath,
                location: endpoint.plaintext.server + servicePath,
              };
              try {
                await expectInventoryFailure(/unexpected redirect/u);
                assert.equal(httpRequests.length, 0);
              } finally {
                redirect = undefined;
              }

              apiSlicesReply = {
                status: 200,
                body: { ...body, metadata: { continue: "unread-next-page" } },
              };
              await expectInventoryFailure(/EndpointSlice inventory is incomplete/u);

              apiSlicesReply = kubernetesStatus(403, "Forbidden");
              await expectInventoryFailure(/not authorized.*read/u);
            } finally {
              apiServiceReply = undefined;
              apiSlicesReply = undefined;
              await rm(preferences, { force: true });
            }
          });

          await eksTest.test("EKS accepts explicit port 443 and literal IPv6", async () => {
            for (const authority of ["127.0.0.1:443", `[::1]:${verifiedPort}`]) {
              proxyTunnel = { authority, port: verifiedPort };
              const selected = {
                ...tunnel,
                server: `https://${authority}/`,
                "proxy-url": endpoint.plaintext.server,
              };
              try {
                const accepted = await observations(
                  config("verified", relativeFiles, selected),
                  1,
                  environment,
                );
                assert.equal(accepted.get("eks-cluster-identity")?.status, "passed", authority);
                assert.equal(accepted.get("kubernetes-api")?.status, "passed", authority);
                const read = httpsRequests.find(({ path }) => path === servicePath);
                assert.equal(read?.tlsServerName, dnsName);
                assert.ok(httpRequests.length > 0, "kubectl used CONNECT to reach the TLS fixture");
                assert.ok(
                  httpRequests.every(
                    ({ path, bearer }) => path === authority && bearer === undefined,
                  ),
                  "CONNECT used the expected authority and carried no Kubernetes credential",
                );
              } finally {
                proxyTunnel = undefined;
              }
            }
          });

          await eksTest.test(
            "EKS rejects non-root paths and missing or invalid tunnel ports",
            async () => {
              for (const server of [
                `${tunnel.server}/extra%2Fpart/..`,
                "https://127.0.0.1",
                "https://127.0.0.1:0",
                "https://127.0.0.1:65536",
              ]) {
                const invalid = {
                  ...tunnel,
                  server,
                  "proxy-url": endpoint.plaintext.server,
                };
                const rejected = await observations(
                  config("verified", relativeFiles, invalid),
                  null,
                  environment,
                );
                assert.equal(httpsRequests.length + httpRequests.length, 0, server);
                assert.notEqual(rejected.get("eks-cluster-identity")?.status, "passed", server);
                assert.notEqual(rejected.get("kubernetes-api")?.status, "passed", server);
              }
            },
          );
        } finally {
          await writeFile(plan, JSON.stringify(planInput));
        }
      },
    );
    await t.test("safe local command errors are preserved before Kubernetes reads", async () => {
      const emptyPath = join(directory, "no-commands");
      await mkdir(emptyPath);
      const missing = await observations(verifiedConfig, 2, {
        PATH: emptyPath,
      });
      assert.match(
        missing.get("kubernetes-api")?.summary ?? "",
        /required command is not installed/u,
      );
      const oversized = config("verified", {
        token: "x".repeat(2 * 1024 * 1024),
      });
      const tooLarge = await observations(oversized, 2);
      assert.match(
        tooLarge.get("kubernetes-api")?.summary ?? "",
        /read exceeded the output limit/u,
      );
      assert.equal(httpsRequests.length + httpRequests.length, 0);
    });
    await t.test("denied dependency reads give access guidance", async () => {
      dependencyReply = serviceReply("dependency", {
        clusterIP: "10.32.0.2",
        selector: { app: "dependency" },
        ports: [{ port: 443 }],
      });
      try {
        for (const path of [servicePath, policyPath]) {
          deniedPath = path;
          const check = (await observations(verifiedConfig)).get("service-egress");
          const reads = httpsRequests
            .map((request) => request.path)
            .filter((path) => path === servicePath || path === policyPath);
          assert.deepEqual(reads, path === servicePath ? [servicePath] : [servicePath, policyPath]);
          assert.equal(check?.status, "unknown");
          assert.match(check?.action ?? "", /read access/u);
        }
      } finally {
        dependencyReply = undefined;
        deniedPath = undefined;
      }
    });
    await t.test(
      "only a complete quota list for the selected namespace establishes capacity",
      async () => {
        const empty = {
          apiVersion: "v1",
          kind: "ResourceQuotaList",
          metadata: { resourceVersion: "42" },
          items: [],
        };
        async function status(body: object) {
          quotaReply = { status: 200, body };
          return (await observations(verifiedConfig)).get("resource-quotas")?.status;
        }
        try {
          assert.equal(await status(empty), "passed");
          assert.equal(await status({ ...empty, kind: "ServiceList" }), "unknown");
          assert.equal(await status({ ...empty, metadata: { continue: "next-page" } }), "unknown");
          assert.equal(await status({ ...empty, metadata: { remainingItemCount: 1 } }), "unknown");
          const other = {
            metadata: { namespace: "other", name: "storage" },
            spec: { hard: { "requests.storage": "1Gi" } },
          };
          assert.equal(await status({ ...empty, items: [other] }), "unknown");
        } finally {
          quotaReply = undefined;
        }
      },
    );

    await t.test("a ready Deployment cannot establish another controller's readiness", async () => {
      try {
        for (const mismatch of [{ name: "other-controller" }, { namespace: "other" }]) {
          rolloutIdentity = { ...selectedController, ...mismatch };
          const checks = await observations(verifiedConfig);
          assert.ok(httpsRequests.some(({ path }) => path === rolloutPath));
          assert.equal(checks.get(rolloutCheck)?.status, "unknown", JSON.stringify(mismatch));
        }
      } finally {
        rolloutIdentity = selectedController;
      }
    });
    await t.test("only Kubernetes NotFound reports a selected Service as absent", async () => {
      const collectService = async (reply: Reply) => {
        dependencyReply = reply;
        const check = (await observations(verifiedConfig)).get("service-egress");
        assert.ok(
          httpsRequests.some(({ path }) => path === servicePath),
          "the API received the named Service read",
        );
        assert.ok(check);
        return check;
      };
      try {
        const missing = await collectService(kubernetesStatus(404, "NotFound"));
        assert.equal(missing.status, "failed");
        assert.match(missing.summary, /does not exist/u);
        const intermediary = await collectService({
          status: 404,
          body: { message: "route missing" },
        });
        assert.equal(intermediary.status, "unknown");
        assert.doesNotMatch(intermediary.summary, /does not exist/u);

        // An ExternalName mismatch is conclusive only for the selected Service.
        const alias = serviceReply("dependency", { type: "ExternalName", externalName: dnsName });
        const selected = await collectService(alias);
        assert.equal(selected.status, "failed");
        assert.match(selected.summary, /ExternalName/u);
        for (const mismatch of [{ kind: "ConfigMap" }, { apiVersion: "example.test/v1" }]) {
          const invalid = await collectService({ ...alias, body: { ...alias.body, ...mismatch } });
          assert.equal(invalid.status, "unknown", JSON.stringify(mismatch));
          assert.ok(!("resources" in invalid));
        }

        for (const body of ["", "null", "[]", "42", "{}", "{"]) {
          const invalid = await collectService({ status: 200, body });
          assert.equal(invalid.status, "unknown", body || "empty response");
          assert.doesNotMatch(invalid.summary, /does not exist/u);
        }
      } finally {
        dependencyReply = undefined;
      }
    });
    await t.test(
      "the private listener enforces one GET and closes on hard termination",
      async () => {
        await writeFile(path, verifiedConfig, { mode: 0o600 });
        const reached = new Promise<void>((resolve) => {
          firstServiceRead = resolve;
        });
        pauseServiceRead = true;
        const { processHandle, result } = collect({}, false);
        try {
          await Promise.race([
            reached,
            result.then(() => assert.fail("the API request did not start")),
          ]);
          const [run] = await readdir(scratch);
          assert.ok(run);
          const socketDirectory = join(scratch, run);
          const socketPath = join(socketDirectory, "1");
          assert.ok((await stat(socketPath)).isSocket());
          // Test the actual socket in the run directory even when the test
          // runner itself starts under a longer private temporary path.
          await using directoryFd =
            process.platform === "linux" && Buffer.byteLength(socketPath) > 103
              ? await open(socketDirectory)
              : undefined;
          const address = directoryFd ? `/proc/self/fd/${directoryFd.fd}/1` : socketPath;
          const beforeRejectedReads = httpsRequests.length;
          for (const [method, path] of [
            ["POST", apiPath],
            ["GET", servicePath],
          ]) {
            const status = await new Promise<number | undefined>((resolve, reject) => {
              request(
                {
                  socketPath: address,
                  method,
                  path,
                  headers: { host: "localhost" },
                },
                (response) => {
                  response.resume();
                  resolve(response.statusCode);
                },
              )
                .once("error", reject)
                .end();
            });
            assert.equal(status, 403);
          }
          assert.equal(
            httpsRequests.length,
            beforeRejectedReads,
            "the proxy rejected both locally",
          );
          processHandle.kill("SIGKILL");
          await result;

          // The socket's owner observes parent EOF. A dead listener must not
          // accept new connections even while its pathname remains after SIGKILL.
          const deadline = performance.now() + 2_000;
          while (performance.now() < deadline) {
            const connected = await new Promise<boolean>((resolve) => {
              const probe = createConnection(address);
              probe.once("error", () => resolve(false));
              probe.once("connect", () => {
                probe.destroy();
                resolve(true);
              });
            });
            if (!connected) {
              return;
            }
            await delay(20);
          }
          assert.fail("the private listener survived the diagnostic process");
        } finally {
          processHandle.kill("SIGKILL");
          await result;
          firstServiceRead = undefined;
          pauseServiceRead = false;
          await rm(scratch, { recursive: true, force: true });
          await mkdir(scratch, { mode: 0o700 });
        }
      },
    );
    for (const [signal, exitCode] of [
      ["SIGHUP", 129],
      ["SIGINT", 130],
      ["SIGTERM", 143],
    ] as const) {
      await t.test(`${signal} removes the private snapshot while a read is pending`, async () => {
        const useLongPath = signal === "SIGTERM" && process.platform === "linux";
        const runScratch = useLongPath ? join(scratch, "long-".repeat(24)) : scratch;
        if (useLongPath) {
          await mkdir(runScratch, { mode: 0o700 });
        }
        await writeFile(path, verifiedConfig, { mode: 0o600 });
        const reached = new Promise<void>((resolve) => {
          firstServiceRead = resolve;
        });
        pauseServiceRead = true;
        const { processHandle, result } = collect({ TMPDIR: runScratch });
        let apiReadStarted = false;
        try {
          await Promise.race([
            reached,
            result.then(() => assert.fail("the API request did not start")),
          ]);
          apiReadStarted = true;
          const entries = await readdir(runScratch);
          assert.equal(entries.length, 1);
          const [run] = entries;
          assert.ok(run);
          const runDirectory = join(runScratch, run);
          assert.equal((await stat(runDirectory)).mode & 0o777, 0o700);
          assert.equal((await stat(join(runDirectory, "kubeconfig.json"))).mode & 0o777, 0o600);
          const socketPath = join(runDirectory, "1");
          if (useLongPath) {
            assert.ok(
              Buffer.byteLength(socketPath) > 107,
              "the path exceeds the Linux socket limit",
            );
          }
          const socket = await stat(socketPath);
          assert.ok(socket.isSocket());
          assert.equal(socket.mode & 0o077, 0, "the transport socket is private");
        } finally {
          processHandle.kill(signal);
          firstServiceRead = undefined;
          pauseServiceRead = false;
          const { code } = await result;
          if (useLongPath) {
            await rm(runScratch, { recursive: true, force: true });
          }
          if (apiReadStarted) {
            assert.equal(code, exitCode);
          }
        }
      });
    }
  },
);
