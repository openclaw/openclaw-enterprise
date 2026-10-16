import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { once } from "node:events";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";

import { validateSelectedBackendDrivers } from "../../packages/occ/src/index.ts";
import { createInstallationDriverConfiguration } from "../helpers/installation-driver-configuration.mjs";
import { loadInstallationConfiguration } from "../../apps/controller/src/composition/installation-config.ts";
import { assertStrandsInstallationProfile } from "../../apps/controller/src/drivers/strands-box/installation-profile.ts";
import { strandsHarnessPreparationCommand } from "../../apps/controller/src/drivers/strands-box/installation.ts";
import { credentialFreeMetadataProvider } from "../../apps/controller/src/drivers/egress-proxy/github-metadata.ts";
import { reconcileStrandsExecutionBearer } from "../../apps/controller/src/drivers/strands-box/execution-bearer.ts";
import { exactStrandsPodAdmission } from "../../apps/controller/src/drivers/strands-box/admission.ts";
import { HARNESS_EGRESS_ENROLLMENT_HELPER } from "../../apps/controller/src/drivers/compute/egress-enrollment.ts";

test("ordinary production installation selects only the paired Strands backend and immutable sender", async () => {
  const configuration = createInstallationDriverConfiguration();
  const members = {
    sandbox: "sandbox-strands",
    credential_proxy: "credential-proxy-strands",
    credential_gateway: "source-strands",
  };
  configuration.backend = [
    { id: "strands", type: "strands-box", drivers: members, configuration: {} },
  ];
  const authority = {
    host: "0.0.0.0",
    port: 8443,
    certificatePath: "/etc/oce/listener.pem",
    privateKeyPath: "/etc/oce/listener-key.pem",
    issuerPublicKeyPath: "/etc/oce/issuer.pub",
    issuer: "oce",
    audience: "oce-exchange",
    keyId: "issuer-1",
  };
  const strandsBox = {
    authorityUri: "https://192.0.2.1:8443",
    authorityCaPath: "/etc/oce/root.pem",
    issuerPrivateKeyPath: "/etc/oce/issuer-key.pem",
    gatewayImage: "example.invalid/strands@sha256:" + "e".repeat(64),
    installationNamespace: "oce-execution-system",
    dogwoodPolicyPath: "/etc/oce/policy.dw",
    qualifiedNetworkPolicy: "kubernetes-enforced",
    originOverrides: { "provider.example.test": { connectIp: "192.0.2.2" } },
  };
  for (const [capability, id] of Object.entries(members)) {
    configuration.drivers[capability] = {
      id,
      configuration: capability === "credential_proxy" ? { authority, strandsBox } : {},
    };
  }
  const load = (candidate = configuration) =>
    loadInstallationConfiguration({
      mode: "production",
      environment: {},
      startupConfiguration: { configuration: candidate, logging: {} },
    });
  const { proxyDriver, computeDriver, sandboxDriver, credentialGatewayDriver } = await load();
  assert.equal(proxyDriver.implementation, "strands-box");
  assert.equal(sandboxDriver.id, members.sandbox);
  assert.equal(
    computeDriver.maintenanceIntervalMs,
    120_000,
    "this active-revision owner maintains its short-lived execution identity",
  );
  const plain = await loadInstallationConfiguration({
    mode: "production",
    environment: {},
    startupConfiguration: { configuration: createInstallationDriverConfiguration(), logging: {} },
  });
  assert.equal(
    plain.computeDriver.maintenanceIntervalMs,
    undefined,
    "no periodic maintenance added to other installations",
  );
  assert.equal(credentialGatewayDriver.id, members.credential_gateway);
  const metadata = credentialFreeMetadataProvider;
  assert.ok(
    proxyDriver.sourceControl.providers.includes(metadata),
    "select the supplier's exact no-material profile",
  );
  assert.deepEqual(
    (await credentialGatewayDriver.listSourceTypes({})).find(
      (s) => s.type === metadata.sourceType.type,
    )?.secrets,
    [],
  );
  assert.throws(
    () => metadata.normalizeConfig({}),
    /execution consent/,
    "missing material is not execution consent",
  );
  await assert.rejects(
    credentialGatewayDriver.registerSource({}),
    /requires protected Credential Proxy/,
  );
  const selected = {
    sandbox: sandboxDriver,
    credential_gateway: credentialGatewayDriver,
    credential_proxy: proxyDriver,
  };
  validateSelectedBackendDrivers(configuration.backend, selected);
  assert.throws(
    () => validateSelectedBackendDrivers([], selected),
    /must belong to a configured protected Backend/,
  );
  assert.throws(
    () =>
      validateSelectedBackendDrivers(configuration.backend, {
        ...selected,
        credential_proxy: undefined,
      }),
    /requires its Credential Proxy Driver/,
  );

  for (const scenario of [
    "missing selection",
    "missing member",
    "wrong member",
    "retired installation",
    "retired backend",
  ]) {
    const candidate = structuredClone(configuration);
    const drivers = candidate.backend[0].drivers;
    if (scenario === "missing selection") {
      delete candidate.drivers.credential_proxy;
      await assert.rejects(load(candidate), /credential_proxy must match the selected/);
    } else if (scenario === "missing member") {
      delete drivers.credential_proxy;
      await assert.rejects(load(candidate), /Credential Proxy Driver ID/);
    } else if (scenario === "wrong member") {
      drivers.credential_proxy = "other-proxy";
      await assert.rejects(load(candidate), /credential_proxy must match the selected/);
    } else if (scenario === "retired installation") {
      candidate.drivers.conduit = null;
      await assert.rejects(load(candidate), /conduit is retired/);
    } else {
      drivers.conduit = drivers.credential_proxy;
      await assert.rejects(load(candidate), /conduit.*is retired/);
    }
  }
  const pinned = strandsBox.gatewayImage;
  strandsBox.gatewayImage = "example.invalid/strands:mutable";
  await assert.rejects(load(), /immutable digest/);
  strandsBox.gatewayImage = pinned;
  configuration.drivers.sandbox.id = "other-sandbox";
  await assert.rejects(load(), /exact paired protected/);
});

test("maintenance rotates the actual signed execution bearer at near-expiry and waits for its exact projection", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "strands-bearer-rotation-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const issuer = {
    issuerPrivateKeyPath: join(dir, "fixture.pem"),
    issuer: "test-issuer",
    audience: "test-exchange",
    keyId: "issuer-1",
  };
  await writeFile(
    issuer.issuerPrivateKeyPath,
    privateKey.export({ type: "pkcs8", format: "pem" }),
    { mode: 0o600 },
  );
  const observation = {
    sandboxId: "same-execution",
    instanceId: "same-process",
    peerKeyId: "same-exchange-key",
    bearerSha256: "",
  };
  let writes = 0;
  let secret = {
    metadata: { name: "our-identity", uid: "same-secret", resourceVersion: "1" },
    data: { bearer: "" },
  };
  const start = Date.now();
  const commit = (now) =>
    reconcileStrandsExecutionBearer(
      secret,
      observation,
      issuer,
      async (replacement) => {
        writes++;
        assert.deepEqual(
          replacement.metadata,
          secret.metadata,
          "replace only that resource with its observed resourceVersion",
        );
        secret = {
          ...replacement,
          metadata: { ...replacement.metadata, resourceVersion: String(writes + 1) },
        };
      },
      now,
    );
  function jwt() {
    const token = Buffer.from(secret.data.bearer, "base64").toString();
    const [header, payload, signature] = token.split(".");
    assert.ok(
      verify(
        null,
        Buffer.from(header + "." + payload),
        publicKey,
        Buffer.from(signature, "base64url"),
      ),
      "real issuer-signed JWT",
    );
    return {
      claims: JSON.parse(Buffer.from(payload, "base64url")),
      digest: createHash("sha256").update(token).digest("hex"),
    };
  }
  assert.equal(await commit(start), undefined, "issuing is not yet observing a projection");
  const first = jwt();
  assert.equal(writes, 1);
  observation.bearerSha256 = first.digest;
  const beforeRenewal = start + 24 * 60_000;
  assert.equal((await commit(beforeRenewal)).bearerSha256, first.digest);
  assert.equal(writes, 1, "ordinary maintenance doesn't issue a new bearer each iteration");
  const nearExpiry = start + 26 * 60_000;
  assert.equal(await commit(nearExpiry), undefined);
  assert.equal(writes, 2, "same execution renewed only inside the five-minute margin");
  const second = jwt();
  const { iat, exp, jti, ...scope } = second.claims;
  const { iat: oldIat, exp: oldExp, jti: oldJti, ...oldScope } = first.claims;
  assert.deepEqual(
    scope,
    oldScope,
    "execution, issuer, audience, process and exchange key remain the same",
  );
  assert.equal(exp - iat, 1800);
  assert.ok(iat > oldIat && exp > oldExp && jti !== oldJti);
  assert.equal(
    await commit(nearExpiry + 1000),
    undefined,
    "old projection isn't acknowledged after replacement",
  );
  assert.equal(writes, 2, "waiting for projection does not issue another JWT");
  observation.bearerSha256 = second.digest;
  assert.equal((await commit(nearExpiry + 2000)).bearerSha256, second.digest);
});

test("the Harness uid can write private Codex config before Kubernetes mounts nested session PVCs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "strands-private-home-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const before = await stat(root);
  const [node, flag, script] = strandsHarnessPreparationCommand([]);
  const home = join(root, "home");
  const temporary = join(root, "tmp");
  const initialize = () => execFileSync(node, [flag, script, home, temporary]);
  initialize();
  const codex = join(home, ".codex");
  for (const path of [home, codex, temporary]) {
    const info = await stat(path);
    assert.equal(info.mode & 0o777, 0o700, path);
    if (process.getuid) {
      assert.equal(info.uid, process.getuid(), "owned by the Harness user, not an administrator");
    }
  }
  const config = join(codex, "config.toml");
  await writeFile(config, "private-config", { mode: 0o600 });
  initialize();
  assert.equal(
    await readFile(config, "utf8"),
    "private-config",
    "repeat does not erase existing configuration",
  );
  assert.equal(
    (await stat(root)).mode,
    before.mode,
    "the volume root is never made more permissive",
  );
});

test("refuse a privileged or substituted admitted Pod even when ownership labels still match", () => {
  const desired = {
    automountServiceAccountToken: false,
    enableServiceLinks: false,
    containers: [
      {
        name: "agent",
        image: "trusted-image",
        volumeMounts: [{ name: "client", mountPath: "/client", readOnly: true }],
      },
    ],
    volumes: [{ name: "client", configMap: { name: "public-client" } }],
  };
  const live = {
    ...structuredClone(desired),
    serviceAccountName: "default",
    dnsPolicy: "ClusterFirst",
  };
  live.volumes[0].configMap.defaultMode = 420;
  assert.equal(exactStrandsPodAdmission(desired, live), true, "allow ordinary API defaults");
  const invalid = [
    { ...live, hostNetwork: true },
    { ...live, initContainers: [{ name: "unadmitted-init" }] },
    { ...live, nodeSelector: { "host-zone": "unadmitted" } },
    { ...live, hostAliases: [{ ip: "192.0.2.2", hostnames: ["unadmitted-host"] }] },
    { ...live, containers: [...live.containers, { name: "injected-sidecar" }] },
    {
      ...live,
      volumes: [...live.volumes, { name: "exchange-seed", secret: { secretName: "sender" } }],
    },
    { ...live, containers: [{ ...live.containers[0], image: "unadmitted-image" }] },
    { ...live, serviceAccountName: "unexpected-account" },
    { ...live, ephemeralContainers: [{ name: "inspection" }] },
  ];
  for (const pod of invalid) {
    assert.equal(exactStrandsPodAdmission(desired, pod), false);
  }
  const init = {
    name: "prepare-workspace",
    image: "trusted-image",
    command: strandsHarnessPreparationCommand([]),
    volumeMounts: [{ name: "home", mountPath: "/runtime-state" }],
    securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true },
  };
  const expectInit = { ...desired, initContainers: [init] };
  const withInit = (extra = {}) => ({ ...live, initContainers: [{ ...init, ...extra }] });
  assert.ok(
    exactStrandsPodAdmission(expectInit, withInit()),
    "only the admitted unprivileged init may prepare HOME",
  );
  for (const extra of [
    { volumeMounts: [...init.volumeMounts, { name: "sender", mountPath: "/identity" }] },
    { securityContext: { privileged: true } },
    { command: ["unexpected-command"] },
  ]) {
    assert.equal(exactStrandsPodAdmission(expectInit, withInit(extra)), false);
  }
});

test("released Harness rejects auth-disabled upgrade without disclosing bearer; readiness requires the same live authenticated socket", async (t) => {
  const token = "temporary-transport";
  const headers = { "x-oce-enrollment-proof": token };
  const installation = {
    sandboxId: "execution",
    instanceId: "process",
    configurationId: "policy",
    peerKeyId: "key",
  };
  let behavior = "accept-any";
  let bearerReceived = 0;
  let withoutProof = 0;
  let pings = 0;
  let sendUnsolicited;
  const peers = new Set();
  function appUpgrade(request, socket) {
    const proof = request.headers.authorization;
    const genuine = proof === "Bearer " + token;
    if (genuine) {
      bearerReceived++;
    }
    if (!proof) {
      withoutProof++;
    }
    if (behavior === "reject-503") {
      socket.end("HTTP/1.1 503 Still Starting\r\n\r\n");
      return;
    }
    if (behavior === "reject-all" || (!genuine && behavior !== "accept-any")) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      return;
    }
    const accept = createHash("sha1")
      .update(request.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " +
        accept +
        "\r\n\r\n",
    );
    // Real RFC 6455 masked Ping -> unmasked Pong with that payload.
    peers.add(socket);
    socket.on("close", () => peers.delete(socket));
    socket.on("error", () => socket.destroy());
    let priorPong;
    let receivedUnsolicited;
    sendUnsolicited = () =>
      new Promise((resolve) => {
        receivedUnsolicited = resolve;
        // Send a Ping after the unsolicited Pong, so its reply confirms that both frames were processed.
        socket.write(Buffer.from([0x8a, 1, 0x77, 0x89, 1, 0x76]));
      });
    socket.on("data", (frame) => {
      if (receivedUnsolicited && frame[0] === 0x8a) {
        receivedUnsolicited();
        receivedUnsolicited = undefined;
        return;
      }
      pings++;
      assert.equal(frame[0], 0x89);
      assert.ok(frame[1] & 0x80);
      const payload = Buffer.from(frame.subarray(6));
      for (let i = 0; i < payload.length; i++) {
        payload[i] ^= frame[2 + (i % 4)];
      }
      if (behavior === "wrong-pong") {
        payload[0] ^= 0xff;
      }
      const pong = Buffer.from([0x8a, payload.length, ...payload]);
      if (behavior === "duplicate-pong" || behavior === "previous-pong-only") {
        if (priorPong) {
          socket.write(priorPong);
        } // A delayed duplicate races the new Ping.
        if (behavior === "previous-pong-only") {
          return;
        } // Never acknowledge the outstanding challenge.
        socket.write(Buffer.concat([pong, pong])); // Native Codex sends the matching Pong twice.
        priorPong = pong;
      } else {
        socket.write(pong);
      }
    });
  }
  const app = createServer();
  app.on("upgrade", appUpgrade).listen(0, "127.0.0.1");
  await once(app, "listening");
  const appPort = app.address().port;
  t.after(() => {
    for (const peer of peers) {
      peer.destroy();
    }
    app.close();
  });

  const require = createRequire(import.meta.url);
  const start = runInNewContext(
    HARNESS_EGRESS_ENROLLMENT_HELPER + ";startProtectedKubernetesHarnessObservation",
    { require, AbortSignal, Buffer, setTimeout, clearTimeout },
  );
  const maxAge = 100;
  const status = start(
    installation,
    createHash("sha256").update(token).digest(),
    appPort,
    0,
    maxAge,
  );
  await once(status, "listening");
  t.after(() => {
    status.closeAllConnections();
    status.close();
  });
  const url = "http://127.0.0.1:" + status.address().port;
  const observe = () => fetch(url + "/authenticated-serving", { headers }).then((r) => r.json());
  const ready = () => fetch(url + "/readyz").then((r) => r.status);
  const age = () => new Promise((resolve) => setTimeout(resolve, maxAge + 30));

  assert.equal(await ready(), 503);
  assert.equal((await fetch(url + "/authenticated-serving")).status, 401);
  assert.equal((await observe()).state, "starting", "an auth-disabled server completes a real 101");
  assert.equal(bearerReceived, 0, "never give an auth-disabled listener the actual capability");
  behavior = "reject-503";
  assert.equal((await observe()).state, "starting");
  assert.equal(bearerReceived, 0, "a generic rejection is not the expected capability rejection");
  behavior = "reject-all";
  assert.equal(
    (await observe()).state,
    "starting",
    "both challenges rejected; no authenticated stream",
  );
  assert.equal(await ready(), 503);
  behavior = "wrong-pong";
  assert.equal(
    (await observe()).state,
    "starting",
    "matching nonce required on authenticated connection",
  );
  assert.equal(await ready(), 503);
  behavior = "duplicate-pong";
  assert.deepEqual(await observe(), { state: "serving", installation });
  const before = { bearerReceived, pings, withoutProof };
  assert.equal(await ready(), 200);
  for (let renewal = 1; renewal <= 2; renewal++) {
    await age();
    await sendUnsolicited(); // No pending Ping. This Pong must neither break the stream nor renew freshness.
    assert.equal(
      await ready(),
      200,
      "fresh rejection + matching new nonce survive the native duplicate Pong",
    );
    assert.equal(
      bearerReceived,
      before.bearerReceived,
      "no saved bearer is needed to remain ready",
    );
    assert.equal(
      pings,
      before.pings + renewal,
      "unsolicited Pong could not extend the expired readiness",
    );
    assert.equal(withoutProof, before.withoutProof + renewal);
  }
  behavior = "previous-pong-only";
  await age();
  assert.equal(
    await ready(),
    503,
    "a delayed duplicate cannot satisfy a new outstanding challenge; its timeout still runs",
  );

  behavior = "require-auth";
  assert.equal((await observe()).state, "serving");
  const beforeDisabled = bearerReceived;
  behavior = "accept-any"; // Existing authorized stream is still alive.
  await age();
  assert.equal(
    await ready(),
    503,
    "fresh auth check detects disabled auth even while server answers our nonce",
  );
  assert.equal(bearerReceived, beforeDisabled, "readiness renewal cannot disclose the bearer");

  behavior = "require-auth";
  assert.equal((await observe()).state, "serving");
  for (const peer of peers) {
    peer.destroy();
  }
  await new Promise((resolve) => app.close(resolve));
  const reuse = createServer();
  behavior = "accept-any";
  reuse.on("upgrade", appUpgrade).listen(appPort, "127.0.0.1");
  await once(reuse, "listening");
  t.after(() => reuse.close());
  const beforeReuse = bearerReceived;
  assert.equal(
    await ready(),
    503,
    "server exit immediately invalidates even previously fresh readiness",
  );
  assert.equal(
    (await observe()).state,
    "starting",
    "auth-disabled replacement on the very same port",
  );
  assert.equal(bearerReceived, beforeReuse, "do not disclose capability to the replacement");
});

test("a missing, replaced, incompatible or replayed installation profile cannot authorize adoption", async () => {
  const native = "strands-credential-proxy-v1";
  const image = "registry.invalid/sender@sha256:" + "b".repeat(64);
  const name = "oce-strands-installation-0";
  const namespace = "oce-execution-system";
  const supported = [
    "execution-policy-and-sender-proof-v1",
    "signed-credential-proxy-exchange-v1",
    "final-send-and-response-custody-v1",
    "explicit-no-material-v1",
    "warm-repository-metadata-v1",
    "dogwood-private-attempt-history-v1",
  ];
  let read;
  let fault;
  const seen = new Set();
  const kube = {
    path: (ns, kind, destination) => {
      assert.deepEqual([ns, kind, destination], [namespace, "Pod", name + ":8081"]);
      return "/only-this-pod";
    },
    read: async (ns, kind, who) => {
      assert.deepEqual([ns, kind, who], [namespace, "Pod", name]);
      if (fault === "missing") {
        return undefined;
      }
      const uid = fault === "replacement" && read++ ? "replaced" : "installed";
      return {
        metadata: { name, namespace, uid },
        spec: {
          automountServiceAccountToken: false,
          containers: [
            {
              name: "installation",
              image,
              args: ["--installation-profile"],
              env: [
                {
                  name: "OCE_INSTALLATION_POD_UID",
                  valueFrom: { fieldRef: { apiVersion: "v1", fieldPath: "metadata.uid" } },
                },
              ],
              envFrom: fault === "secret" ? [{}] : undefined,
            },
          ],
        },
        status: {
          podIP: "192.0.2.8",
          phase: "Running",
          containerStatuses: [
            {
              name: "installation",
              ready: true,
              state: { running: {} },
              containerID: "instance",
              imageID:
                fault === "image" ? "registry.invalid/sender@sha256:" + "d".repeat(64) : image,
            },
          ],
        },
      };
    },
    text: async (path) => {
      const url = new URL(path, "https://execution.invalid");
      assert.equal(url.pathname, "/only-this-pod/proxy/profile/" + native);
      const challenge = url.searchParams.get("challenge");
      assert.match(challenge, /^[a-f0-9]{64}$/);
      assert.ok(!seen.has(challenge), "every negotiation must use a fresh challenge");
      seen.add(challenge);
      const peer = {
        podUid: "installed",
        challenge: fault === "stale" ? "0".repeat(64) : challenge,
        protocolMajor: fault === "version" ? 2 : 1,
        profile: native,
        required: fault === "unknown-required" ? [...supported, "unknown"] : supported,
        supported: fault === "incompatible" ? supported.slice(1) : supported,
      };
      return { status: 200, text: JSON.stringify(peer) };
    },
  };
  const check = () =>
    assertStrandsInstallationProfile(
      kube,
      { installationNamespace: namespace, gatewayImage: image },
      AbortSignal.timeout(3000),
    );
  await check();
  for (fault of [
    "missing",
    "image",
    "replacement",
    "version",
    "unknown-required",
    "incompatible",
    "stale",
    "secret",
  ]) {
    read = 0;
    await assert.rejects(check(), /no compatible live Credential Proxy profile/, fault);
  }
});
