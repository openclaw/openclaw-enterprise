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

type Observation = { id: string; status: string; summary: string; action?: string };
type Reply = { status: number; body: object | string; location?: string };
type ApiRequest = {
  path: string;
  bearer: string | undefined;
  hasClientCertificate: boolean;
  tlsServerName: unknown;
};

// Serve the discovery and named reads used by genuine kubectl over loopback.
// Neither endpoint needs a Kubernetes cluster or any real credential.
function api(
  requests: ApiRequest[],
  resource: (request: ApiRequest) => Reply | undefined,
): RequestListener {
  return (request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const received = {
      path,
      bearer: request.headers.authorization,
      hasClientCertificate: request.socket instanceof TLSSocket && request.socket.authorized,
      tlsServerName: "servername" in request.socket ? request.socket.servername : undefined,
    };
    requests.push(received);
    const status = (code: number, reason: string): Reply => ({
      status: code,
      body: {
        kind: "Status",
        apiVersion: "v1",
        status: "Failure",
        reason,
        code,
      },
    });
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
              {
                name: "secrets",
                singularName: "secret",
                kind: "Secret",
                namespaced: true,
                verbs: ["get"],
              },
            ],
          },
        };
      } else {
        reply = status(404, "NotFound");
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
const servicePath = "/api/v1/namespaces/default/services/dependency";
const secretPath = "/api/v1/namespaces/default/secrets/leaf";
const dnsName = "gateway.test.invalid";

function object(kind: "Service" | "Secret", name: string, fields: object): Reply {
  return {
    status: 200,
    body: {
      kind,
      apiVersion: "v1",
      metadata: {
        name,
        namespace: "default",
        uid: randomUUID(),
        resourceVersion: "1",
      },
      ...fields,
    },
  };
}

const kubectlError = spawnSync("kubectl", ["version", "--client"], { stdio: "ignore" }).error;
const withoutKubectl =
  !process.env.OCC_TEST_KUBERNETES_CONFIGURATION &&
  kubectlError !== undefined &&
  "code" in kubectlError &&
  kubectlError.code === "ENOENT";

test(
  "installation prerequisites keep genuine kubectl on the selected verified transport",
  { skip: withoutKubectl && "requires kubectl", timeout: 60_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "prerequisite-transport-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const source = join(directory, "source");
    const scratch = join(directory, "scratch");
    await mkdir(source, { mode: 0o700 });
    await mkdir(scratch, { mode: 0o700 });
    const operatorHome = join(directory, "operator");
    await mkdir(join(operatorHome, ".kube"), { recursive: true, mode: 0o700 });
    const ca = await certificateAuthority(source, {
      caName: "prerequisite transport test CA",
    });
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
    const refreshedToken = randomUUID();
    const replacementToken = randomUUID();
    const caBundle = await readFile(ca.caPath);
    const tokenFile = join(source, "reader-token");
    const certData = Buffer.from(server.cert).toString("base64");
    const keyData = Buffer.from(server.key).toString("base64");
    await writeFile(tokenFile, token, { mode: 0o600 });
    const plugin = {
      apiVersion: "client.authentication.k8s.io/v1",
      kind: "ExecCredential",
      status: { token },
    };
    const pluginMarker = join(source, "credential-plugin-started");
    await writeFile(
      join(source, "credential-plugin"),
      `#!/bin/sh\n: > "$TEST_PLUGIN_MARKER"\nprintf '%s\\n' '${JSON.stringify(plugin)}'\n`,
      { mode: 0o700 },
    );

    const path = join(source, "kubeconfig");
    const plan = join(directory, "plan.json");
    const httpsRequests: ApiRequest[] = [];
    const httpRequests: ApiRequest[] = [];
    let firstServiceRead: (() => void) | undefined;
    let pauseServiceRead = false;
    let denyDependency = false;
    let serveValidLeaf = false;
    let secretReply: Reply | undefined;
    let redirect: { path: string; location: string } | undefined;
    let proxyTunnel: { authority: string; port: number } | undefined;
    const plaintext = createServer(
      api(httpRequests, ({ path }) => {
        if (path === secretPath) {
          return object("Secret", "leaf", { data: { "tls.crt": certData, "tls.key": keyData } });
        }
      }),
    );
    // The proxy never resolves the CONNECT authority. It can forward the
    // selected test authority only to the independently bound loopback fixture.
    plaintext.on("connect", (request, socket, head) => {
      httpRequests.push({
        path: request.url ?? "",
        bearer: request.headers.authorization,
        hasClientCertificate: false,
        tlsServerName: undefined,
      });
      if (!proxyTunnel || request.url !== proxyTunnel.authority) {
        socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        return;
      }
      const upstream = createConnection({ host: "127.0.0.1", port: proxyTunnel.port });
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
    const verifiedApi = api(httpsRequests, ({ path: requestPath }) => {
      if (redirect?.path === requestPath) {
        return { status: 307, location: redirect.location, body: {} };
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
          : object("Service", "kubernetes", {
              spec: { clusterIP: "10.32.0.1" },
            });
      }
      if (denyDependency && [servicePath, secretPath].includes(requestPath)) {
        return {
          status: 403,
          body: {
            apiVersion: "v1",
            kind: "Status",
            status: "Failure",
            reason: "Forbidden",
            code: 403,
          },
        };
      }
      if (requestPath === secretPath) {
        return (
          secretReply ??
          object("Secret", "leaf", {
            data: {
              "tls.crt": serveValidLeaf ? certData : Buffer.from("invalid leaf").toString("base64"),
              "tls.key": keyData,
            },
          })
        );
      }
    });
    const verifiedPort = await listen(
      t,
      createTlsServer(
        {
          cert: server.cert,
          key: server.key,
          ca: caBundle,
          requestCert: true,
          rejectUnauthorized: false,
        },
        (request, response) => {
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
            refreshRequest = { method: request.method, form: new URLSearchParams(body) };
            verifiedApi(request, response);
          });
        },
      ),
    );
    const oidcIssuer = `https://127.0.0.1:${verifiedPort}/identity`;
    const endpoint = {
      verified: {
        server: `https://127.0.0.1:${verifiedPort}`,
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
      controllers: [{ name: "controller", namespace: "default" }],
      crds: [{ name: "gateways.gateway.networking.k8s.io", version: "v1" }],
      apiCidrs: ["10.32.0.1/32"],
      serviceDependency: {
        service: { namespace: "default", name: "dependency", port: 443 },
        policy: { namespace: "default", name: "dependency-egress" },
        tls: { secretName: "leaf", serverName: dnsName },
      },
    };
    await writeFile(plan, JSON.stringify(planInput));
    function collect(environment: NodeJS.ProcessEnv = {}, expectCleanup = true) {
      const processHandle = spawn(
        process.execPath,
        ["scripts/diagnose-kubernetes-prerequisites.ts", "--config", plan, "--json"],
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
      let output = "";
      processHandle.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        output += chunk;
      });
      processHandle.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        output += chunk;
      });
      const result = once(processHandle, "close").then(async ([code]) => {
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
        return { code, output };
      });
      return { processHandle, result };
    }
    async function observations(
      kubeconfig: string,
      expectedCode: number | null = 1,
      environment?: NodeJS.ProcessEnv,
    ) {
      await writeFile(path, kubeconfig, { mode: 0o600 });
      httpsRequests.length = 0;
      httpRequests.length = 0;
      const { code, output } = await collect(environment).result;
      if (expectedCode !== null) {
        assert.equal(code, expectedCode);
      }
      const { checks } = JSON.parse(output) as { checks: Observation[] };
      return new Map(checks.map((check) => [check.id, check]));
    }

    await t.test("replacing the selected context and CA cannot redirect a Secret GET", async () => {
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
        // Before the fix this Secret GET reached the plaintext endpoint and falsely passed.
        assert.equal(httpRequests.length, 0, "no request reached the plaintext endpoint");
        const apiRead = httpsRequests.find(({ path }) => path === apiPath);
        assert.ok(apiRead?.bearer === `Bearer ${token}`, "the first read used the original token");
        const secretRead = httpsRequests.find(({ path }) => path === secretPath);
        assert.ok(
          secretRead?.hasClientCertificate,
          "kubectl presented the relative client certificate",
        );
        assert.ok(
          secretRead.bearer === `Bearer ${refreshedToken}`,
          "the verified endpoint received the rotated token",
        );
        assert.equal(checks.get("service-tls")?.status, "failed");
      } finally {
        firstServiceRead = undefined;
        await Promise.all([writeFile(ca.caPath, caBundle), writeFile(tokenFile, token)]);
      }
    });
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
        serveValidLeaf = true;
        try {
          const normal = await observations(verifiedConfig);
          assert.equal(normal.get("kubernetes-api")?.status, "passed");
          assert.equal(normal.get("service-tls")?.status, "passed");

          for (const [path, id, location] of [
            [apiPath, "kubernetes-api", `http://localhost:${plaintextPort}/sink`],
            [secretPath, "service-tls", `https://127.0.0.1:${alternatePort}/sink`],
            [secretPath, "service-tls", "/sink"],
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
          serveValidLeaf = false;
        }
      },
    );
    const execConfig = config("verified", {
      exec: {
        apiVersion: plugin.apiVersion,
        command: "./credential-plugin",
        interactiveMode: "Never",
      },
    });
    await t.test("a late kuberc policy cannot be bypassed to run an exec plugin", async () => {
      const kubectl = spawnSync("sh", ["-c", "command -v kubectl"], { encoding: "utf8" });
      assert.equal(kubectl.status, 0);
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
        const secretRead = httpsRequests.find(({ path }) => path === secretPath);
        assert.ok(
          secretRead?.bearer === `Bearer ${token}`,
          "kubectl used the relative exec plugin",
        );
        assert.equal(checks.get("service-tls")?.status, "failed");
        assert.match(checks.get("service-tls")?.action ?? "", /verify.*tls\.crt/u);
        assert.match(checks.get("service-egress")?.action ?? "", /Service owner/u);
      },
    );
    await t.test("plaintext contexts fail before any Kubernetes request", async () => {
      const checks = await observations(plaintextConfig);
      assert.equal(checks.get("kubernetes-api")?.status, "failed");
      assert.equal(checks.get("service-tls")?.status, "unknown");
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
      assert.match(checks.get("service-tls")?.action ?? "", /Resolve kubernetes-api/u);
    });
    await t.test("built-in OIDC is refused before refreshing the original credential", async () => {
      const original = config("verified", {
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
        const inventory = {
          sts: { Account: "123456789012" },
          eks: {
            cluster: {
              arn: clusterArn,
              name: "fixture",
              endpoint: `https://${dnsName}`,
              certificateAuthority: { data: caBundle.toString("base64") },
              resourcesVpcConfig: { vpcId: "vpc-123abc", clusterSecurityGroupId: "sg-123abc" },
            },
          },
          ec2: { NetworkInterfaces: [{ PrivateIpAddresses: [{ PrivateIpAddress: "10.0.0.1" }] }] },
        };
        const cases = Object.entries(inventory).map(
          ([service, body]) => `${service}) printf '%s\n' '${JSON.stringify(body)}';;`,
        );
        await writeFile(
          awsCommand,
          `#!/bin/sh\ncase "$1" in\n${cases.join("\n")}\n*) exit 1;;\nesac\n`,
          { mode: 0o700 },
        );
        const environment = { PATH: `${directory}:${process.env.PATH}` };
        const tunnel = { ...endpoint.verified, "tls-server-name": dnsName };
        await writeFile(
          plan,
          JSON.stringify({ ...planInput, eks: { clusterArn, webhookCidrs: ["10.0.0.1/32"] } }),
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
          const secretRead = httpsRequests.find(({ path }) => path === secretPath);
          assert.equal(secretRead?.tlsServerName, dnsName);
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
          assert.match(refused.get("service-tls")?.action ?? "", /Resolve eks-cluster-identity/u);
          assert.equal(httpsRequests.length + httpRequests.length, 0);

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
                const read = httpsRequests.find(({ path }) => path === secretPath);
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
                const invalid = { ...tunnel, server, "proxy-url": endpoint.plaintext.server };
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
      const missing = await observations(verifiedConfig, 2, { PATH: emptyPath });
      assert.match(
        missing.get("kubernetes-api")?.summary ?? "",
        /required command is not installed/u,
      );
      const oversized = config("verified", { token: "x".repeat(2 * 1024 * 1024) });
      const tooLarge = await observations(oversized, 2);
      assert.match(
        tooLarge.get("kubernetes-api")?.summary ?? "",
        /read exceeded the output limit/u,
      );
      assert.equal(httpsRequests.length + httpRequests.length, 0);
    });
    await t.test("denied dependency reads give access guidance", async () => {
      denyDependency = true;
      try {
        // Direct reads also establish that other prerequisites in this fixture are missing.
        const checks = await observations(verifiedConfig);
        for (const [id, action] of [
          ["service-egress", /read access/u],
          ["service-tls", /Secret read access/u],
        ] as const) {
          const check = checks.get(id);
          assert.equal(check?.status, "unknown");
          assert.match(check?.action ?? "", action);
        }
      } finally {
        denyDependency = false;
      }
    });
    await t.test("only HTTP 404 reports a selected Secret as absent", async () => {
      const collectSecret = async (reply: Reply) => {
        secretReply = reply;
        const check = (await observations(verifiedConfig)).get("service-tls");
        assert.ok(
          httpsRequests.some(({ path }) => path === secretPath),
          "the API received the named Secret read",
        );
        assert.ok(check);
        return check;
      };
      try {
        const missing = await collectSecret({
          status: 404,
          body: {
            apiVersion: "v1",
            kind: "Status",
            status: "Failure",
            reason: "NotFound",
            code: 404,
          },
        });
        assert.equal(missing.status, "failed");
        assert.match(missing.summary, /does not exist/u);
        for (const body of ["", "null", "[]", "42", "{}", "{"]) {
          const invalid = await collectSecret({ status: 200, body });
          assert.equal(invalid.status, "unknown", body || "empty response");
          assert.doesNotMatch(invalid.summary, /does not exist/u);
        }
      } finally {
        secretReply = undefined;
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
            ["GET", secretPath],
          ]) {
            const status = await new Promise<number | undefined>((resolve, reject) => {
              request(
                { socketPath: address, method, path, headers: { host: "localhost" } },
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
