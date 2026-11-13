import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, X509Certificate, createPrivateKey, createPublicKey } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { availablePort } from "../available-port.mjs";
import { caAndLeaf } from "../certificates.mjs";
import { ownPortForward } from "../port-forward-cleanup.ts";
import { fixtureFetch } from "./custody-probes.mjs";

const modules = ["oidc-provider-server.mjs", "oidc-provider.mjs", "id-token.mjs"];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const providerName = "signin-rehearsal-oidc";
const host = "idp.signin-rehearsal.test";
const origin = "https://" + host;

// The caller owns namespace/cluster custody, DNS installation, the traffic gate,
// and binding the extra Helm revision returned by configureOidc.
export async function prepareMaterialization({
  chartDirectory,
  system,
  release,
  directory,
  suffix,
  images,
  supportIdentities,
  providerMaterial,
  apply,
  kubectl,
  get,
  waitFor,
  run,
  custody,
  localCluster,
  bindProviderDns,
  registerPortForward,
}) {
  assert.equal(
    typeof registerPortForward,
    "function",
    "fixture owner must own provider forwarding",
  );
  await localCluster.assertCluster();
  assert.equal(typeof bindProviderDns, "function", "fixture owner must bind provider DNS");
  assert.equal(images.node, supportIdentities.node.image);
  assert.equal(images.postgres, supportIdentities.postgres.image);
  const metadata = (name, labels = {}) => ({
    name,
    namespace: system,
    labels: { "oce-test": suffix, ...labels },
  });
  const kubeArgs = [
    "--kubeconfig",
    localCluster.selection.kubeconfigPath,
    "--context",
    localCluster.selection.kubernetesContext,
    "-n",
    system,
    "--request-timeout=30s",
  ];
  const privateKube = (...args) => run("kubectl", [...kubeArgs, ...args], { protectedInput: true });
  const providerDirectory = pathToFileURL(providerMaterial.directory + "/");
  const files = {};
  for (const name of modules) {
    files[name] = await readFile(new URL("../" + name, import.meta.url), "utf8");
    await writeFile(new URL(name, providerDirectory), files[name], { flag: "wx", mode: 0o600 });
  }
  for (const name of ["config.json", "server.key", "ca.pem", "server.pem"]) {
    files[name] = await readFile(new URL(name, providerDirectory), "utf8");
  }
  const providerHashes = Object.freeze(
    Object.fromEntries(
      [...modules, "config.json", "server.pem", "ca.pem"].map((name) => [name, hash(files[name])]),
    ),
  );
  const leaf = new X509Certificate(files["server.pem"]);
  assert.equal(leaf.checkHost(host), host);
  assert(leaf.verify(new X509Certificate(files["ca.pem"]).publicKey));
  assert(
    new Date(leaf.validTo).getTime() > Date.now() + 3_600_000,
    "provider certificate expires during rehearsal",
  );
  assert.deepEqual(
    createPublicKey(createPrivateKey(files["server.key"])).export({
      format: "der",
      type: "spki",
    }),
    leaf.publicKey.export({ format: "der", type: "spki" }),
  );
  const createSecret = (name, stringData) =>
    apply({
      apiVersion: "v1",
      kind: "Secret",
      metadata: metadata(name),
      immutable: true,
      stringData,
    });
  const tlsDirectory = join(directory, "signin-database-tls");
  await mkdir(tlsDirectory, { mode: 0o700 });
  let setupFailed = false;
  let setupError;
  try {
    const databaseHost = `postgres.${system}.svc.cluster.local`;
    const tls = await caAndLeaf(tlsDirectory, {
      caName: "Disposable sign-in database CA",
      commonName: databaseHost,
      subjectAltName: `DNS:${databaseHost}`,
      days: 7,
    });
    for (const name of await readdir(tlsDirectory)) {
      await chmod(join(tlsDirectory, name), 0o600);
    }
    await createSecret("signin-rehearsal-database-ca", {
      "ca.pem": await readFile(tls.caPath, "utf8"),
    });
    await createSecret("signin-rehearsal-database-server", {
      "server.pem": await readFile(tls.certPath, "utf8"),
      "server.key": await readFile(tls.keyPath, "utf8"),
    });
  } catch (error) {
    setupFailed = true;
    setupError = error;
  }
  // mkdir established ownership; remove both keys even after partial generation.
  const removed = await Promise.allSettled(
    ["ca-key.pem", "key.pem"].map((name) => rm(join(tlsDirectory, name), { force: true })),
  );
  const failures = removed.filter((result) => result.status === "rejected");
  if (failures.length) {
    throw new AggregateError(
      [...(setupFailed ? [setupError] : []), ...failures.map((result) => result.reason)],
      "Database TLS private-key cleanup failed",
      { cause: setupError },
    );
  }
  if (setupFailed) {
    throw setupError;
  }
  await createSecret("signin-rehearsal-oidc-ca", { "ca.pem": files["ca.pem"] });
  const client = Object.fromEntries(
    await Promise.all(
      ["client-id", "client-secret"].map(async (name) => [
        name,
        (await readFile(new URL(name, providerDirectory), "utf8")).trim(),
      ]),
    ),
  );
  const config = JSON.parse(files["config.json"]);
  assert.ok(
    isDeepStrictEqual(config, providerMaterial.config),
    "generated provider configuration changed",
  );
  assert(client["client-id"] === config.clientId, "provider client ID mismatch");
  assert(client["client-secret"] === config.clientSecret, "provider client secret mismatch");
  await createSecret("signin-rehearsal-oidc-client", client);
  await createSecret(
    "signin-rehearsal-oidc-server",
    Object.fromEntries(
      ["config.json", "server.pem", "server.key"].map((name) => [name, files[name]]),
    ),
  );
  await apply({
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: metadata("signin-rehearsal-oidc-code"),
    immutable: true,
    data: Object.fromEntries(modules.map((name) => [name, files[name]])),
  });
  const labels = { app: providerName, "oce-test": suffix };
  await apply({
    apiVersion: "v1",
    kind: "Pod",
    metadata: metadata(providerName, labels),
    spec: {
      automountServiceAccountToken: false,
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 1000,
        runAsGroup: 1000,
        fsGroup: 1000,
        seccompProfile: { type: "RuntimeDefault" },
      },
      containers: [
        {
          name: "provider",
          image: images.node,
          imagePullPolicy: "Never",
          command: ["node", "/fixture/oidc-provider-server.mjs", "/fixture"],
          env: [
            { name: "OIDC_LISTEN_HOST", value: "0.0.0.0" },
            { name: "OIDC_LISTEN_PORT", value: "8443" },
          ],
          securityContext: {
            allowPrivilegeEscalation: false,
            readOnlyRootFilesystem: true,
            capabilities: { drop: ["ALL"] },
          },
          resources: {
            requests: { cpu: "100m", memory: "128Mi" },
            limits: { cpu: "1", memory: "1Gi" },
          },
          ports: [{ name: "https", containerPort: 8443 }],
          readinessProbe: { tcpSocket: { port: "https" }, periodSeconds: 2 },
          volumeMounts: [{ name: "fixture", mountPath: "/fixture", readOnly: true }],
        },
      ],
      volumes: [
        {
          name: "fixture",
          projected: {
            defaultMode: 0o440,
            sources: [
              { configMap: { name: "signin-rehearsal-oidc-code" } },
              { secret: { name: "signin-rehearsal-oidc-server" } },
              { secret: { name: "signin-rehearsal-oidc-ca" } },
            ],
          },
        },
      ],
    },
  });
  await apply({
    apiVersion: "v1",
    kind: "Service",
    metadata: metadata(providerName),
    spec: {
      selector: labels,
      ports: [{ name: "https", port: 443, targetPort: 8443 }],
    },
  });
  const apiLabels = {
    "app.kubernetes.io/name": "openclaw-enterprise",
    "app.kubernetes.io/instance": release,
    "app.kubernetes.io/component": "api",
  };
  const policy = (name, spec) =>
    apply({
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: metadata(name),
      spec,
    });
  await policy("signin-rehearsal-api-provider-target", {
    podSelector: { matchLabels: apiLabels },
    policyTypes: ["Egress"],
    egress: [
      {
        to: [{ podSelector: { matchLabels: labels } }],
        ports: [{ protocol: "TCP", port: 8443 }],
      },
    ],
  });
  await policy("signin-rehearsal-provider-isolation", {
    podSelector: { matchLabels: labels },
    policyTypes: ["Ingress", "Egress"],
    ingress: [
      {
        from: [{ podSelector: { matchLabels: apiLabels } }],
        ports: [{ protocol: "TCP", port: 8443 }],
      },
    ],
    egress: [],
  });
  await kubectl(
    "-n",
    system,
    "wait",
    "--for=condition=Ready",
    `pod/${providerName}`,
    "--timeout=180s",
  );
  const initial = await get("pod", providerName);
  const initialStatus = initial.status.containerStatuses.find(
    (status) => status.name === "provider",
  );
  custody.assertUID(`pod/${providerName}`, initial.metadata.uid);
  assert.equal(initial.spec.nodeName, localCluster.node);
  assert.equal(initial.spec.containers[0].image, images.node);
  assert.ok(initialStatus?.ready && initialStatus.state?.running);
  assert.equal(
    await localCluster.runningConfigDigest(initialStatus.containerID, initial.metadata.uid),
    supportIdentities.node.configDigest,
  );
  const service = await get("service", providerName);
  const dnsMapping = {
    hostname: host,
    serviceName: providerName,
    namespace: system,
    serviceUid: service.metadata.uid,
    clusterIP: service.spec.clusterIP,
  };
  await bindProviderDns(dnsMapping);
  await writeFile(join(directory, "materialization-dns.json"), JSON.stringify(dnsMapping) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  const port = await availablePort();
  const forward = spawn(
    "kubectl",
    [...kubeArgs, "port-forward", `pod/${providerName}`, `${port}:8443`, "--address=127.0.0.1"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const forwardOwner = ownPortForward(forward);
  registerPortForward(forwardOwner);
  let forwarding = false;
  const observe = (chunk) => {
    if (chunk.toString().includes("Forwarding from 127.0.0.1:")) {
      forwarding = true;
    }
  };
  forward.stdout.on("data", observe);
  forward.stderr.on("data", observe);
  try {
    await waitFor("private provider forwarding", async () => {
      if (forwardOwner.error) {
        throw forwardOwner.error;
      }
      assert(forward.exitCode === null && forward.signalCode === null, "provider forward exited");
      return forwarding;
    });
  } catch (error) {
    try {
      await forwardOwner.close();
    } catch (closeError) {
      throw new AggregateError([error, closeError], "Provider forwarding and cleanup failed", {
        cause: closeError,
      });
    }
    throw error;
  }
  const providerFetch = fixtureFetch(origin, "127.0.0.1", port, files["ca.pem"]);
  return {
    providerDirectory,
    providerHashes,
    providerFetch,
    dnsMapping,
    helmOptions: {
      databaseTLS: {
        imagePullPolicy: "Never",
        caSecretName: "signin-rehearsal-database-ca",
        serverSecretName: "signin-rehearsal-database-server",
      },
    },
    async assertDatabaseImage() {
      const pod = await get("pod", "postgres");
      custody.assertUID("pod/postgres", pod.metadata.uid);
      assert.equal(pod.spec.nodeName, localCluster.node);
      const server = pod.spec.containers.find((c) => c.name === "postgres");
      assert.equal(server?.image, images.postgres);
      const status = pod.status.containerStatuses.find((c) => c.name === "postgres");
      assert.ok(status?.ready && status.state?.running);
      assert.equal(
        await localCluster.runningConfigDigest(status.containerID, pod.metadata.uid),
        supportIdentities.postgres.configDigest,
        "running database differs from the selected PostgreSQL config",
      );
    },
    async assertRunningProvider(expectedHashes) {
      await localCluster.assertCluster();
      const pod = await get("pod", providerName);
      custody.assertUID(`pod/${providerName}`, pod.metadata.uid);
      assert.equal(pod.metadata.uid, initial.metadata.uid);
      const status = pod.status.containerStatuses.find((entry) => entry.name === "provider");
      assert(status.ready && status.state.running && status.restartCount === 0);
      assert.equal(status.containerID, initialStatus.containerID, "provider process replaced");
      assert.equal(pod.spec.containers[0].image, images.node);
      assert.equal(
        await localCluster.runningConfigDigest(status.containerID, pod.metadata.uid),
        supportIdentities.node.configDigest,
      );
      const names = Object.keys(expectedHashes);
      assert.deepEqual(expectedHashes, providerHashes);
      const script =
        "const fs=require('node:fs'),c=require('node:crypto');const names=JSON.parse(process.argv[1]);process.stdout.write(JSON.stringify(Object.fromEntries(names.map(n=>[n,c.createHash('sha256').update(fs.readFileSync('/fixture/'+n)).digest('hex')]))))";
      const actual = JSON.parse(
        await privateKube(
          "exec",
          `pod/${providerName}`,
          "-c",
          "provider",
          "--",
          "node",
          "-e",
          script,
          JSON.stringify(names),
        ),
      );
      assert.deepEqual(actual, expectedHashes, "running provider input mismatch");
      const response = await providerFetch(new URL("/.well-known/openid-configuration", origin), {
        signal: AbortSignal.timeout(10_000),
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).issuer, JSON.parse(files["config.json"]).issuer);
    },
    async configureOidc(userId) {
      assert.match(userId, /^[A-Za-z0-9_-]+$/);
      await localCluster.assertCluster();
      await custody.assertRelease();
      await custody.assertPostgres();
      const pods = JSON.parse(
        await privateKube(
          "get",
          "pods",
          "-l",
          Object.entries(apiLabels)
            .map(([key, value]) => `${key}=${value}`)
            .join(","),
          "-o",
          "json",
        ),
      ).items;
      assert.equal(pods.length, 1);
      const resolved = JSON.parse(
        await privateKube(
          "exec",
          "pod/" + pods[0].metadata.name,
          "-c",
          "api",
          "--",
          "node",
          "-e",
          "require('node:dns').lookup(process.argv[1],{all:true},(e,a)=>{if(e)process.exit(1);process.stdout.write(JSON.stringify(a.map(x=>x.address)))})",
          host,
        ),
      );
      assert.deepEqual(
        resolved,
        [service.spec.clusterIP],
        "owner must install the exact disposable provider DNS mapping before OIDC configuration",
      );
      const valuesPath = join(directory, "values.json");
      const values = JSON.parse(await readFile(valuesPath));
      assert.equal(values.images.controller, images.controller);
      assert.equal(values.auth.baseUrl, "https://console.signin-rehearsal.test");
      const { issuer, authorizationUrl, tokenUrl, jwksUrl, tokenAuth } = config;
      values.auth = {
        ...values.auth,
        recoveryUserId: userId,
        oidc: {
          enabled: true,
          issuer,
          authorizationUrl,
          tokenUrl,
          jwksUrl,
          tokenAuth,
          secretName: "signin-rehearsal-oidc-client",
          clientIdKey: "client-id",
          clientSecretKey: "client-secret",
          caSecretName: "signin-rehearsal-oidc-ca",
          caSecretKey: "ca.pem",
          egressCidrs: [initial.status.podIP + "/32"],
        },
      };
      values.agentNativeAdmin = { enabled: false };
      const upgradedValues = join(directory, "oidc-values.json");
      await writeFile(upgradedValues, JSON.stringify(values) + "\n", {
        flag: "wx",
        mode: 0o600,
      });
      const helmScope = [
        "--kubeconfig",
        localCluster.selection.kubeconfigPath,
        "--kube-context",
        localCluster.selection.kubernetesContext,
        "--namespace",
        system,
      ];
      const history = async () =>
        JSON.parse(
          await run("helm", ["history", release, ...helmScope, "--output", "json"], {
            protectedInput: true,
          }),
        );
      const before = (await history()).at(-1);
      assert.equal(before.status, "deployed");
      await run(
        "helm",
        [
          "upgrade",
          release,
          chartDirectory,
          ...helmScope,
          "--values",
          upgradedValues,
          "--wait",
          "--timeout",
          "300s",
        ],
        { protectedInput: true, timeout: 330_000 },
      );
      const after = (await history()).at(-1);
      assert.equal(after.status, "deployed");
      assert.equal(after.revision, before.revision + 1);
      await writeFile(valuesPath, JSON.stringify(values) + "\n", {
        mode: 0o600,
      });
      const receipt = {
        previousRevision: before.revision,
        revision: after.revision,
        release,
        namespace: system,
        controllerReference: images.controller,
        valuesPath: upgradedValues,
      };
      await writeFile(join(directory, "oidc-helm-revision.json"), JSON.stringify(receipt) + "\n", {
        flag: "wx",
        mode: 0o600,
      });
      return receipt;
    },
  };
}
