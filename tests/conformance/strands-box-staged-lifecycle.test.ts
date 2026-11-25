import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import test from "node:test";

import {
  KubernetesObjectApi,
  type KubernetesObject,
  type V1ConfigMap,
} from "../../apps/controller/node_modules/@kubernetes/client-node/dist/index.js";
import { sha256Hex } from "../../packages/utils/src/index.ts";
import { stagedStockFixture } from "../fixtures/strands-box.ts";
import { listen } from "../helpers/listen.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";

test("Box requires a measured, pinned launcher for activation and retains evidence until its Pod disappears", async (t) => {
  const {
    staged,
    sandbox: driver,
    proxy,
    fixture,
    prepare,
    sourceId,
    configurationId,
    deployment,
  } = await stagedStockFixture();
  const { resourceName: name, namespaceName: namespace } = driver.harnessResource(staged);
  const transportToken = "synthetic-transport";
  const version = randomUUID();
  const podUid = randomUUID();
  const directory = await temporaryDirectory(t, "oce-box-activation-");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=" + podUid,
      "-addext",
      "basicConstraints=critical,CA:FALSE",
      "-addext",
      `subjectAltName=DNS:localhost,DNS:${name}.${namespace}.svc,DNS:${name}-status.${namespace}.svc`,
      "-keyout",
      directory + "/key.pem",
      "-out",
      directory + "/peer.pem",
    ],
    { stdio: "ignore" },
  );
  const tls = {
    key: readFileSync(directory + "/key.pem"),
    cert: readFileSync(directory + "/peer.pem", "utf8"),
  };
  let receipt: unknown;
  let state = "starting";
  const port = await listen(
    t,
    createServer(tls, (req, res) => {
      assert.equal(req.headers.authorization, "Bearer " + transportToken);
      assert.equal(req.method, "GET");
      assert.equal(req.url, "/revisions/" + staged.revision.id + "/readiness");
      res.end(JSON.stringify({ state, staged: receipt }));
    }),
  );
  const resources = new Map<string, KubernetesObject>();
  const key = (ref: KubernetesObject) => ref.kind + "/" + ref.metadata!.name;
  const create = (ref: KubernetesObject) => {
    assert.equal(resources.has(key(ref)), false);
    resources.set(key(ref), {
      ...ref,
      metadata: { ...ref.metadata, uid: randomUUID(), resourceVersion: "1" },
    });
  };
  const pods: KubernetesObject[] = [];
  const kubernetes = Object.assign(Object.create(KubernetesObjectApi.prototype), {
    read(ref: KubernetesObject) {
      const object = resources.get(key(ref));
      if (!object) {
        throw Object.assign(new Error("missing"), { code: 404 });
      }
      return object;
    },
    create,
    list: (_apiVersion: string, kind: string) => ({
      items:
        kind === "Pod"
          ? pods
          : [...resources.values()].filter((resource) => resource.kind === kind),
    }),
    delete: (ref: KubernetesObject) => resources.delete(key(ref)),
  });
  const serviceAddress = Reflect.get(driver, "harnessServiceAddress").bind(driver);
  Object.assign(driver, {
    observer: Promise.resolve(kubernetes),
    harnessServiceAddress: async (...args: unknown[]) => {
      await serviceAddress(...args);
      return "localhost:" + port;
    },
    endpointAddresses: async () => [{ cidr: "192.0.2.1/32", port: 443 }],
    gatewayRoute: async () => ({ host: "gateway.oce.svc", port: 18789, egress: {} }),
  });
  const context = { ...staged, kubernetes, signal: new AbortController().signal, transportToken };
  const labels = {
    "openclaw.dev/namespace": staged.namespace.id,
    "openclaw.dev/agent": staged.revision.agentId,
    "openclaw.dev/revision": staged.revision.id,
  };
  const transport = staged.requirements.environment.find(
    (entry) => entry.name === "APP_SERVER_TOKEN",
  );
  assert.ok(transport && "valueFrom" in transport);
  const transportRef = transport.valueFrom.secretKeyRef;
  create({
    apiVersion: "v1",
    kind: "Secret",
    metadata: { labels, namespace, name: transportRef.name },
    data: { [transportRef.key]: Buffer.from(transportToken).toString("base64") },
  } as KubernetesObject);
  await assert.rejects(driver.provisionHarness(context), /held/);
  const targetRef = await driver.provisionStagedHarness(context);
  const expected = { targetRef, configurationId };
  const { sandboxId } = targetRef;
  assert.equal(resources.get("Deployment/" + name)!.metadata!.uid, sandboxId);
  const rs = {
    apiVersion: "apps/v1",
    kind: "ReplicaSet",
    name: "fixture-rs",
    uid: randomUUID(),
    controller: true,
  };
  resources.set("ReplicaSet/" + rs.name, {
    metadata: {
      uid: rs.uid,
      ownerReferences: [{ ...rs, kind: "Deployment", name, uid: sandboxId }],
    },
  });
  const pod = {
    metadata: { name: "launcher", uid: podUid, ownerReferences: [rs] },
    status: {
      conditions: [{ type: "Ready", status: "True" }],
      initContainerStatuses: [
        { name: "initialize-listener", state: { terminated: { exitCode: 0, message: tls.cert } } },
      ],
    },
  };
  pods.push(pod);
  const pending = { code: "CREDENTIAL_ACTIVATION_PENDING" };
  await assert.rejects(driver.stagedTarget(context, expected), pending);
  assert.deepEqual(await driver.harnessStatus(context), { state: "starting" });
  const target = await driver.stagedTarget(context, expected);
  assert.equal(target.status, undefined);
  await assert.rejects(driver.activateStagedHarness(context), pending);
  const data = (resources.get("ConfigMap/" + name) as V1ConfigMap).data!;
  const report = {
    challenge: "a".repeat(64),
    released: false,
    versions: { [sourceId]: version },
    policyHash: sha256Hex(data["policy.dw"]!),
    configHash: sha256Hex(data["box.toml"]!),
  };
  receipt = { ...report, policyHash: "0".repeat(64) };
  await assert.rejects(driver.stagedTarget(context, expected), /attest/);
  receipt = report;
  await assert.rejects(driver.activateStagedHarness(context), pending);
  receipt = undefined;

  let latestVersion: string = version;
  proxy.bindCurrentVersion(async () => latestVersion);
  let resolved = 0;
  const push = {
    ...expected,
    injectionPolicies: deployment.injectionPolicies,
    bindings: [
      {
        binding: deployment.bindings[0]!,
        resolveCredential: async () => {
          resolved += 1;
          return { credential: "synthetic-model-key", version };
        },
      },
    ],
  };
  await assert.rejects(
    proxy.configureDeployment(context, {
      ...push,
      targetRef: { ...targetRef, sandboxId: "foreign" },
    }),
    /target changed/u,
  );
  const invalidDelivery = /does not match the admitted execution/u;
  await assert.rejects(
    proxy.configureDeployment(context, { ...push, injectionPolicies: [] }),
    invalidDelivery,
  );
  assert.equal(resolved, 0);
  await assert.rejects(
    proxy.configureDeployment(context, {
      ...push,
      bindings: [
        {
          binding: deployment.bindings[0]!,
          resolveCredential: async () => ({
            credential: "synthetic-model-key",
            version,
            expiresAt: new Date(0).toISOString(),
          }),
        },
      ],
    }),
    invalidDelivery,
  );
  const { credentialProjections } = await proxy.configureDeployment(context, push);
  assert.equal((await proxy.getDeploymentStatus(context, expected)).state, "pending");
  receipt = { ...report, versions: { [sourceId]: "wrong-version" } };
  await assert.rejects(driver.activateStagedHarness(context), invalidDelivery);
  receipt = report;
  assert.equal((await proxy.getDeploymentStatus(context, expected)).state, "ready");
  latestVersion = randomUUID();
  assert.deepEqual(await proxy.getDeploymentStatus(context, expected), {
    state: "failed",
    code: "CREDENTIAL_SOURCE_VERSION_CHANGED",
  });
  latestVersion = version;
  await proxy.configureDeployment(context, push);
  assert.equal(resolved, 1);
  const requiresRetirement = { code: "CREDENTIAL_WITHDRAWAL_REQUIRES_RUNTIME_RETIREMENT" };
  const notify = () =>
    proxy.notifyCredentialUpdated(
      { sourceRef: deployment.bindings[0]!.sourceRef },
      async () => assert.fail("Static Box refresh must never resolve fresh material"),
      context.signal,
    );
  await assert.rejects(notify(), requiresRetirement);
  await assert.rejects(
    proxy.removeDeployment(context, { targetRef, bindingRefs: ["model"] }),
    requiresRetirement,
  );
  await assert.rejects(driver.prepareStagedHarness(context, []), /placeholder/);
  await driver.prepareStagedHarness(context, credentialProjections);
  const releaseKey = "ConfigMap/" + name + "-release";
  assert.equal(resources.has(releaseKey), false);
  await driver.activateStagedHarness(context);
  receipt = { ...report, released: true };
  await driver.activateStagedHarness(context);
  const release = resources.get(releaseKey) as V1ConfigMap;
  assert.equal(release.immutable, true);
  assert.deepEqual(JSON.parse(release.data!.release!), {
    sandboxId,
    podUid,
    configurationId,
    versions: report.versions,
    challenge: report.challenge,
    policyHash: report.policyHash,
    configHash: report.configHash,
  });
  await t.test(
    "Compute maintenance can observe this execution but never provision or release one",
    async () => {
      const { revision } = staged;
      const maintenance = { ...prepare, existingHarnessOnly: true as const };
      const compute = fixture.driver;
      const location = { name: namespace, plane: "control" };
      Object.assign(compute, { sandboxNamespaceContext: async () => context });
      state = "serving";
      const readSecret = fixture.clients.core.readNamespacedSecret;
      Object.assign(fixture.clients.core, {
        async readNamespacedSecret(request: { name: string; namespace: string }) {
          const secret = await readSecret(request);
          if (secret.data?.deviceId) {
            secret.data.enrolledRevisionId = Buffer.from(revision.id).toString("base64");
          }
          return secret;
        },
      });
      await assert.rejects(
        fixture.prepare(revision, maintenance),
        /retained Box target is missing/,
      );
      await Reflect.get(compute, "credentialDeploymentTarget").call(
        compute,
        revision,
        location,
        sandboxId,
      );
      const writes = fixture.writes.length;
      assert.equal((await fixture.prepare(revision, maintenance)).ready, true);
      await fixture.activate(revision, maintenance);
      const diagnosticKey = "Service/" + name + "-status";
      const diagnostic = resources.get(diagnosticKey)!;
      resources.delete(diagnosticKey);
      await assert.rejects(fixture.prepare(revision, maintenance), /Service is unavailable/);
      assert.equal(resources.has(diagnosticKey), false);
      resources.set(diagnosticKey, diagnostic);
      pod.metadata.uid = randomUUID();
      await assert.rejects(fixture.prepare(revision, maintenance), /replacement Pod/);
      pod.metadata.uid = podUid;
      state = "starting";
      receipt = report;
      resources.delete(releaseKey);
      assert.equal((await fixture.prepare(revision, maintenance)).ready, false);
      await assert.rejects(
        fixture.activate(revision, maintenance),
        /retained Box execution is unavailable/,
      );
      assert.equal(resources.has(releaseKey), false);
      resources.set(releaseKey, release);
      assert.equal(fixture.writes.length, writes);
    },
  );
  receipt = { ...report, challenge: "b".repeat(64) };
  await assert.rejects(driver.activateStagedHarness(context), /release differs/);
  pod.metadata.uid = randomUUID();
  await assert.rejects(driver.stagedTarget(context, expected), /replacement Pod/);
  pod.metadata.uid = podUid;
  await assert.rejects(driver.cleanup(context), /termination is unconfirmed/);
  assert.ok(resources.has(releaseKey));
  pods.pop();
  await driver.cleanup(context);
  assert.equal(resources.has(releaseKey), false);
  assert.equal(resources.has("Secret/" + name + "-material"), false);
  assert.equal(resources.has("ConfigMap/" + name + "-listener"), false);
  await proxy.removeDeployment(context, { targetRef });
  await notify();
});
