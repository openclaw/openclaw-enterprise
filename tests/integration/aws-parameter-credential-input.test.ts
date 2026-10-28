import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import https, { type RequestOptions } from "node:https";
import http, { type IncomingMessage } from "node:http";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { buffer } from "node:stream/consumers";
import test, { type TestContext } from "node:test";
import {
  KubernetesSecretDriver,
  SecretBackendUnavailableError,
  SecretOwnershipError,
} from "../../apps/controller/src/drivers/secret/kubernetes/index.ts";
import type { Secret } from "../../packages/contracts/src/index.ts";
import { createInstallationDriverConfiguration } from "../helpers/installation-driver-configuration.mjs";
import { loadInstallationFile } from "../helpers/installation-file.mjs";
import { selfSigned } from "../helpers/certificates.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";
import { listen } from "../helpers/listen.mjs";

const arn = "arn:aws:ssm:us-east-1:123456789012:parameter/oce/synthetic-access";
const hostname = "ssm.us-east-1.amazonaws.com";
const accessKey = "synthetic-access-key";
const signingKey = "synthetic-signing-key";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const hmac = (key: string | Buffer, value: string) =>
  createHmac("sha256", key).update(value).digest();

// Independently verify the wire contract, including signature, rather than echoing SDK output.
function verifySignature(headers: import("node:http").IncomingHttpHeaders, bytes: Buffer) {
  assert.equal(headers.host, hostname);
  assert.equal(headers["x-amz-target"], "AmazonSSM.GetParameter");
  assert.deepEqual(JSON.parse(bytes.toString()), { Name: arn, WithDecryption: true });
  const auth = String(headers.authorization);
  const match =
    /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/us-east-1\/ssm\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(
      auth,
    );
  assert.ok(match, "SSM request must carry a service- and region-scoped SigV4 signature");
  assert.equal(match[1], accessKey);
  const names = match[3]!.split(";");
  assert.ok(names.includes("host") && names.includes("x-amz-date"));
  const canonical = names
    .map((name) => `${name}:${String(headers[name]).trim().replace(/\s+/g, " ")}\n`)
    .join("");
  const request = ["POST", "/", "", canonical, match[3], hash(bytes)].join("\n");
  const scope = `${match[2]}/us-east-1/ssm/aws4_request`;
  const signed = ["AWS4-HMAC-SHA256", headers["x-amz-date"], scope, hash(request)].join("\n");
  const key = hmac(
    hmac(hmac(hmac(`AWS4${signingKey}`, match[2]!), "us-east-1"), "ssm"),
    "aws4_request",
  );
  assert.equal(createHmac("sha256", key).update(signed).digest("hex"), match[4]);
}

async function awsWire(t: TestContext) {
  const directory = await temporaryDirectory(t, "oce-ssm-wire-");
  const tls = await selfSigned(directory);
  let parameter: Record<string, unknown> = {
    ARN: arn,
    Type: "SecureString",
    Version: 1,
    Value: "synthetic-aws-A",
  };
  let failure = false;
  let calls = 0;
  let callerAccount = "123456789012";
  let onRequest: (() => Promise<void>) | undefined;
  const identityServer = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, "synthetic-pod-token");
    res.end(
      JSON.stringify({
        AccessKeyId: accessKey,
        SecretAccessKey: signingKey,
        Token: "synthetic-session",
        Expiration: new Date(Date.now() + 3600000).toISOString(),
      }),
    );
  });
  const identityPort = await listen(t, identityServer);
  const originalHttp = http.request;
  t.mock.method(
    http,
    "request",
    (options: RequestOptions, callback: (response: IncomingMessage) => void) => {
      if ((options.hostname ?? options.host) !== "169.254.170.23") {
        assert.ok(
          ["127.0.0.1", "localhost", "::1"].includes(String(options.hostname ?? options.host)),
          "unexpected nonlocal HTTP destination",
        );
        return originalHttp(options, callback);
      }
      return originalHttp(
        { ...options, host: "127.0.0.1", hostname: "127.0.0.1", port: identityPort, agent: false },
        callback,
      );
    },
  );
  const originalRead = fs.readFile;
  t.mock.method(fs, "readFile", (...args: Parameters<typeof fs.readFile>) =>
    args[0] === "/var/run/secrets/pods.eks.amazonaws.com/serviceaccount/eks-pod-identity-token"
      ? Promise.resolve(Buffer.from("synthetic-pod-token"))
      : originalRead(...args),
  );
  const server = https.createServer(tls, async (req, res) => {
    try {
      const bytes = await buffer(req);
      if (req.headers.host === "sts.us-east-1.amazonaws.com") {
        res.setHeader("content-type", "text/xml");
        res.end(
          `<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><GetCallerIdentityResult><Account>${callerAccount}</Account><Arn>arn:aws:sts::123456789012:assumed-role/synthetic/test</Arn><UserId>synthetic</UserId></GetCallerIdentityResult></GetCallerIdentityResponse>`,
        );
        return;
      }
      verifySignature(req.headers, bytes);
      calls++;
      await onRequest?.();
      res.setHeader("content-type", "application/x-amz-json-1.1");
      res
        .writeHead(failure ? 400 : 200)
        .end(
          JSON.stringify(failure ? { __type: "AccessDeniedException" } : { Parameter: parameter }),
        );
    } catch (error) {
      res.writeHead(500).end();
      assert.fail(String(error));
    }
  });
  const port = await listen(t, server);
  const original = https.request;
  // Only socket routing is replaced. The real AWS client signs the original endpoint;
  // TLS remains verified against this owned fixture's certificate.
  t.mock.method(
    https,
    "request",
    (options: RequestOptions, callback: (response: IncomingMessage) => void) => {
      if (
        (options.hostname ?? options.host) !== hostname &&
        (options.hostname ?? options.host) !== "sts.us-east-1.amazonaws.com"
      ) {
        assert.ok(
          ["127.0.0.1", "localhost", "::1"].includes(String(options.hostname ?? options.host)),
          "unexpected nonlocal HTTPS destination",
        );
        return original(options, callback);
      }
      assert.equal(Number(options.port ?? 443), 443);
      return original(
        {
          ...options,
          host: "127.0.0.1",
          hostname: "127.0.0.1",
          port,
          servername: "localhost",
          ca: tls.cert,
          agent: false,
        },
        callback,
      );
    },
  );
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const previous = { ...process.env };
  for (const [key, value] of Object.entries({
    AWS_ACCESS_KEY_ID: "unused-ambient-access-key",
    AWS_SECRET_ACCESS_KEY: "unused-ambient-signing-key",
    AWS_SESSION_TOKEN: "synthetic-session",
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_REGION: "us-east-1",
    AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://169.254.170.23/v1/credentials",
    AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE:
      "/var/run/secrets/pods.eks.amazonaws.com/serviceaccount/eks-pod-identity-token",
  })) {
    process.env[key] = value;
  }
  t.after(() => {
    for (const key of [
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "AWS_EC2_METADATA_DISABLED",
      "AWS_REGION",
      "AWS_CONTAINER_CREDENTIALS_FULL_URI",
      "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
    ]) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
  });
  return {
    get calls() {
      return calls;
    },
    setCallerAccount(account: string) {
      callerAccount = account;
    },
    rotate(value: string, version: number) {
      parameter = { ARN: arn, Type: "SecureString", Version: version, Value: value };
      failure = false;
    },
    invalid(fields: Record<string, unknown>) {
      parameter = { ...parameter, ...fields };
    },
    fail() {
      failure = true;
    },
    pause() {
      const reached = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      onRequest = () => {
        reached.resolve();
        return released.promise;
      };
      return {
        reached: reached.promise,
        release() {
          onRequest = undefined;
          released.resolve();
        },
      };
    },
  };
}

test(
  "configured AWS protected input rereads rotation and refuses unsafe reads",
  { timeout: 30000 },
  async (t) => {
    const aws = await awsWire(t);
    const directory = await temporaryDirectory(t, "oce-ssm-kube-");
    const tls = await selfSigned(directory);
    const ns = "ns_11111111-1111-4111-8111-111111111111";
    const nsName = `oce-${hash(ns).slice(0, 15)}`;
    const mapped: Secret = {
      id: "sec_22222222-2222-4222-8222-222222222222",
      namespaceId: ns,
      name: "synthetic",
      driverId: "secret-kubernetes",
      backendRef: {
        namespaceName: nsName,
        name: "synthetic",
        key: "value",
        uid: "33333333-3333-4333-8333-333333333333",
      },
      createdAt: new Date().toISOString(),
    };
    let uid = mapped.backendRef.uid;
    const kube = https.createServer(tls, (req, res) => {
      res.setHeader("content-type", "application/json");
      const namespace = {
        apiVersion: "v1",
        kind: "Namespace",
        metadata: {
          name: nsName,
          labels: {
            "app.kubernetes.io/managed-by": "openclaw-enterprise",
            "openclaw.dev/gateway-namespace": ns,
            "openclaw.dev/namespace": ns,
          },
          annotations: { "openclaw.dev/namespace-id": ns },
        },
        status: { phase: "Active" },
      };
      if (req.url?.startsWith("/api/v1/namespaces?")) {
        res.end(JSON.stringify({ apiVersion: "v1", kind: "NamespaceList", items: [namespace] }));
      } else if (req.url === `/api/v1/namespaces/${nsName}`) {
        res.end(JSON.stringify(namespace));
      } else {
        res.end(
          JSON.stringify({
            apiVersion: "v1",
            kind: "Secret",
            type: "Opaque",
            metadata: {
              name: "synthetic",
              namespace: nsName,
              uid,
              resourceVersion: "1",
              labels: {
                "app.kubernetes.io/managed-by": "openclaw-enterprise",
                "openclaw.dev/namespace": ns,
                "openclaw.dev/secret": mapped.id,
              },
              annotations: {
                "openclaw.dev/namespace-id": ns,
                "openclaw.dev/secret-id": mapped.id,
                "openclaw.dev/secret-name": mapped.name,
                "openclaw.dev/secret-driver-id": mapped.driverId,
              },
            },
            data: { value: Buffer.from("synthetic-local-sentinel").toString("base64") },
          }),
        );
      }
    });
    const port = await listen(t, kube);
    const kubeconfigPath = `${directory}/kubeconfig.json`;
    await fs.writeFile(
      kubeconfigPath,
      JSON.stringify({
        apiVersion: "v1",
        kind: "Config",
        clusters: [
          {
            name: "fixture",
            cluster: {
              server: `https://127.0.0.1:${port}`,
              "certificate-authority-data": Buffer.from(tls.cert).toString("base64"),
            },
          },
        ],
        users: [{ name: "fixture", user: {} }],
        contexts: [{ name: "fixture", context: { cluster: "fixture", user: "fixture" } }],
        "current-context": "fixture",
      }),
    );
    const base = createInstallationDriverConfiguration();
    const configuration = {
      ...base,
      drivers: {
        ...base.drivers,
        secret: {
          id: mapped.driverId,
          configuration: {
            authentication: { mode: "kubeconfig", kubeconfigPath, context: "fixture" },
            awsParameterInputs: [
              {
                namespaceId: ns,
                secretId: mapped.id,
                backendUid: mapped.backendRef.uid,
                parameterArn: arn,
              },
            ],
          },
        },
      },
    };
    const loaded = await loadInstallationFile(t, configuration);
    assert.ok(loaded?.secretDriver.readCredentialInput);
    assert.ok(loaded.secretDriver.withValue);
    const driver = loaded.secretDriver;
    assert.ok(driver.withValue);
    const read = (
      secret = mapped,
      signal = new AbortController().signal,
      deadlineAt = new Date(Date.now() + 10000).toISOString(),
    ) =>
      driver.readCredentialInput!({ secret, lifetime: { signal, deadlineAt }, retention: "none" });
    let priorVersion = "";
    for (const [value, version] of [
      ["synthetic-aws-A", 1],
      ["synthetic-aws-B", 2],
    ] as const) {
      aws.rotate(value, version);
      const before = aws.calls;
      const result = await read();
      assert.equal(result.value, value);
      assert.notEqual(result.version, priorVersion);
      assert.equal(aws.calls, before + 1);
      priorVersion = result.version;
    }
    for (const fields of [{ ARN: arn + "-wrong" }, { Type: "String" }, { Version: 1.5 }]) {
      aws.rotate("synthetic-aws-B", 2);
      aws.invalid(fields);
      await assert.rejects(read(), SecretBackendUnavailableError);
    }
    aws.setCallerAccount("999999999999");
    const callsBeforeCrossAccount = aws.calls;
    await assert.rejects(read(), SecretBackendUnavailableError);
    assert.equal(aws.calls, callsBeforeCrossAccount, "wrong AWS account never reaches SSM");
    aws.setCallerAccount("123456789012");
    aws.fail();
    await assert.rejects(
      read(),
      SecretBackendUnavailableError,
      "AWS failure cannot reuse prior AWS or local material",
    );
    const before = aws.calls;
    await assert.rejects(
      driver.withValue(mapped, async (value) => value),
      SecretOwnershipError,
    );
    await assert.rejects(
      read({ ...mapped, namespaceId: "ns_44444444-4444-4444-8444-444444444444" }),
      { message: "The Kubernetes Secret namespace verification failed." },
    );
    await assert.rejects(
      read(mapped, new AbortController().signal, new Date(Date.now() - 1).toISOString()),
      { name: "TimeoutError" },
    );
    await assert.rejects(
      read({ ...mapped, backendRef: { ...mapped.backendRef, uid: "replacement" } }),
      SecretOwnershipError,
    );
    assert.equal(aws.calls, before);
    aws.rotate("synthetic-aws-B", 2);
    const paused = aws.pause();
    const pending = read();
    await paused.reached;
    uid = "recreated-uid";
    paused.release();
    await assert.rejects(
      pending,
      SecretOwnershipError,
      "ownership must be reread after AWS responds",
    );
    uid = mapped.backendRef.uid;
    const pausedAbort = aws.pause();
    const abort = new AbortController();
    const withdrawn = read(mapped, abort.signal);
    await pausedAbort.reached;
    abort.abort();
    pausedAbort.release();
    await assert.rejects(withdrawn, SecretBackendUnavailableError);
    const unmappedConfiguration = {
      ...configuration,
      drivers: {
        ...configuration.drivers,
        secret: {
          id: mapped.driverId,
          configuration: {
            authentication: { mode: "kubeconfig", kubeconfigPath, context: "fixture" },
          },
        },
      },
    };
    const local = await loadInstallationFile(t, unmappedConfiguration);
    assert.ok(local?.secretDriver.withValue);
    const localBefore = aws.calls;
    assert.equal(
      await local.secretDriver.withValue(mapped, async (value) => value),
      "synthetic-local-sentinel",
    );
    assert.equal(aws.calls, localBefore);
  },
);

test(
  "regular OCC protected inference uses fresh AWS input and enforces withdrawn grants",
  { timeout: 30000 },
  async (t) => {
    const { staticEgressFixture } = await import("../helpers/static-egress.mjs");
    const { createConsoleAppFixture } = await import("../helpers/console-app.mjs");
    const { OpenClawController } = await import("../../packages/occ/src/index.ts");
    let state: import("../../packages/occ/src/index.ts").PlatformStateStore | undefined;
    const aws = await awsWire(t);
    const f = await staticEgressFixture(t, {
      appFactory: (context, options) =>
        createConsoleAppFixture(context, {
          ...options,
          wrapState(value: import("../../packages/occ/src/index.ts").PlatformStateStore) {
            state = value;
            return value;
          },
        }),
      async createAuthorityController({
        app,
        secret,
        installedDriver,
        catalog,
        authentication,
        driverConfigurations,
      }) {
        assert.ok(state);
        const mapped = await app.controller.transact(
          (unit: import("../../packages/occ/src/index.ts").PlatformUnitOfWork) =>
            unit.secrets.findSecret(secret.namespaceId, secret.id),
        );
        assert.ok(mapped);
        const controller = new OpenClawController(app.controller.installation, {
          state,
          driverConfigurations,
        });
        const driver = new KubernetesSecretDriver(
          {
            authentication,
            awsParameterInputs: [
              {
                namespaceId: mapped.namespaceId,
                secretId: mapped.id,
                backendUid: mapped.backendRef.uid,
                parameterArn: arn,
              },
            ],
          },
          { id: mapped.driverId },
        );
        for (const selected of [
          app.iamDriver,
          driver,
          catalog,
          app.controller.selectedDriver("compute"),
        ]) {
          controller.registerDriver(selected);
          controller.selectDriver(selected.capability, selected.id);
        }
        controller.registerDriver(installedDriver);
        controller.selectDriver("sandbox", installedDriver.require("sandbox").id);
        controller.selectDriver("credential_proxy", installedDriver.require("credential_proxy").id);
        return controller;
      },
    });
    assert.ok("capture" in f, "the complete admitted runtime fixture is required");
    let priorVersion = "";
    for (const [value, version] of [
      ["synthetic-aws-A", 1],
      ["synthetic-aws-B", 2],
    ] as const) {
      aws.rotate(value, version);
      const before = aws.calls;
      const captured = f.capture();
      const resolved = await f.resolve(captured);
      assert.ok(resolved.ready, JSON.stringify(resolved));
      assert.equal(resolved.ready.credential_headers[0].value, `Bearer ${value}`);
      assert.notEqual(resolved.ready.evidence.material_version, priorVersion);
      priorVersion = resolved.ready.evidence.material_version;
      assert.ok(aws.calls > before, "each operation reads the current AWS version");
      assert.ok((await f.authorize(f.permitRequest(captured, resolved.ready))).allowed);
      const response = await f.protect(captured, await f.send(captured, resolved.ready));
      assert.deepEqual(JSON.parse(response.body), { output: "fixture answer" });
      assert.equal(f.providerRequests.at(-1).authorization, `Bearer ${value}`);
    }
    assert.equal(f.providerRequests.length, 2);
    const captured = f.capture();
    const resolved = await f.resolve(captured);
    assert.ok(resolved.ready);
    await f.revoke();
    const before = aws.calls;
    assert.ok(
      (await f.authorize(f.permitRequest(captured, resolved.ready))).refused,
      "withdrawal between resolution and send must refuse authorization",
    );
    assert.ok((await f.resolve(f.capture())).refused);
    assert.equal(aws.calls, before, "withdrawn grant is checked before fresh AWS reads");
    assert.equal(f.providerRequests.length, 2, "withdrawal permits zero new destination sends");
  },
);
