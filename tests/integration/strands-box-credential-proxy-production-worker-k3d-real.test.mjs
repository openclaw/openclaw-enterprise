// This is the ordinary startup configuration -> PostgreSQL work queue -> real Compute -> Codex test.
// The companion installed test isolates policy, boundary and response failures in a smaller workload.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { inflateRawSync } from "node:zlib";
import { lookup } from "node:dns/promises";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import pg from "pg";
import { kubernetesNamespaceName } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { nodeProgramArguments } from "../../apps/controller/src/drivers/compute/node-program.ts";
import { AGENT_RUNTIME_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { composeProduction } from "../../apps/controller/src/composition/production.ts";
import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import { createAuthenticatedControllerRequest } from "../helpers/auth-session.mjs";
import { ensureDevelopmentBootstrap } from "../helpers/bootstrap-installation.mjs";
import {
  protectedAgentBody,
  protectedConfigurationBody,
  protectedSourceBody,
  sourceAccessBindingBody,
} from "../helpers/egress-connected-inputs.mjs";
import { loadInstallationConfiguration } from "../../apps/controller/src/composition/installation-config.ts";
import {
  createEnvoyWorkspaceGatewayPlan,
  ensureEnvoyGatewayControllers,
} from "../helpers/envoy-workspace-gateway.mjs";
import {
  createKubernetesClient,
  createKubernetesInstallationConfiguration,
} from "../helpers/kubernetes-real.mjs";
import { createOpenShellKubernetesFixture } from "../helpers/openshell-kubernetes-real.mjs";
import {
  installStrandsProfile,
  issueStrandsTlsFixture,
  rejectedStrandsWsCapabilities,
} from "../helpers/strands-box-installed.mjs";
import { startSyntheticEgressProvider } from "../fixtures/synthetic-egress-provider.mjs";

const selected = process.env.OCC_TEST_STRANDS_PRODUCTION_WORKER === "1";
test(
  "ordinary production selection releases a real Codex Harness and preserves its admitted Strands Responses boundary",
  {
    skip:
      !selected &&
      "Requires disposable K3s, migrated PostgreSQL, immutable sender and OCE runtime.",
    timeout: 20 * 60_000,
  },
  async (t) => {
    const {
      KUBECONFIG: kubeconfigPath,
      STRANDS_PROXY_FIXTURE_IP: host,
      STRANDS_PROXY_RUNTIME_IMAGE: runtimeImage,
      STRANDS_PROXY_GATEWAY_IMAGE: gatewayImage,
      STRANDS_PROXY_TEST_DATABASE_URL: databaseUrl,
      STRANDS_PROXY_KUBERNETES_CONTEXT: kubernetesContext,
    } = process.env;
    assert.match(kubernetesContext, /^k3d-strands-proxy-[-a-z\d]+$/, "dedicated cluster only");
    assert.match(
      new URL(databaseUrl).hostname,
      /^strands-proxy-[-a-z\d]+-postgres$/,
      "dedicated DB only",
    );
    for (const ref of [runtimeImage, gatewayImage]) {
      assert.match(ref, /^\S+@sha256:[a-f\d]{64}$/, "normal production immutable images");
    }
    const dir = mkdtempSync(tmpdir() + "/strands-worker-");
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const hostname = "origin.qualification.invalid";
    const tls = issueStrandsTlsFixture(dir, "IP:" + host + ",DNS:" + hostname);
    const issuer = generateKeyPairSync("ed25519");
    const file = (name, data) => {
      const path = dir + "/" + name;
      writeFileSync(path, data, { mode: 0o600 });
      return path;
    };
    const issuerPublicKeyPath = file(
      "issuer-public",
      issuer.publicKey.export({ type: "spki", format: "pem" }),
    );
    const issuerPrivateKeyPath = file(
      "issuer-private",
      issuer.privateKey.export({ type: "pkcs8", format: "pem" }),
    );
    // Admit this genuine startup probe and one interactive turn, both bounded by the supplier's policy.
    // The companion installed-lane test checks a stricter temporal budget and cross-execution denial.
    const dogwoodPolicyPath = file(
      "policy.dw",
      [
        'permit(principal, action == Box::Action::"net:connect", resource);',
        'permit(principal, action == Box::Action::"http:request", resource)',
        'when { context.input.intercepted && context.input.path == "/v1/responses" };',
      ].join("\n"),
    );
    const prefix = "SYNTHETIC-OCE-EGRESS-" + randomUUID();
    const keys = { initial: prefix + "-v1", rotated: prefix + "-v2" };
    const model = "fixture-model";
    const provider = await startSyntheticEgressProvider(
      t,
      {
        certificatePath: dir + "/cert",
        privateKeyPath: dir + "/key",
        bindPort: 39443,
        bindHost: host,
        model,
        observeNativeWorkspacePrivacy: true,
      },
      keys,
    );
    const f = createOpenShellKubernetesFixture({
      kubeconfigPath,
      kubernetesContext,
      codexImage: runtimeImage,
      gatewayImage: runtimeImage,
      commandTimeoutMs: 110_000,
    });

    const platformNamespace = process.env.STRANDS_PROXY_TEST_PLATFORM_NAMESPACE;
    // Reuse the supplier's actual cert-manager/Envoy, native route and node enrollment fixtures.
    // Only this process trusts the fresh disposable test root; the Harness receives public trust only.
    process.env.OCC_TEST_GATEWAY_CA_CERT_PATH = tls.caPath;
    process.env.OCC_TEST_GATEWAY_CA_KEY_PATH = dir + "/ca-key";
    setDefaultCACertificates([...getCACertificates("default"), tls.ca]);
    // The routing fixture waits for cert-manager's initial NotFound to turn into a real TLS leaf.
    // Use its ordinary kubectl client here (the app-server probe intentionally redacts kubectl errors).
    const routingClient = createKubernetesClient({
      selection: { kubeconfigPath, kubernetesContext },
    });
    await ensureEnvoyGatewayControllers(routingClient);
    const routeCleanup = [];
    const gateway = await createEnvoyWorkspaceGatewayPlan(
      { after: (fn) => routeCleanup.push(fn) },
      { platformNamespace },
      routingClient,
    );
    const owningName = gateway.routing.gatewayName;
    const owningUid = (await routingClient.resource("gateway", owningName, platformNamespace))
      .metadata.uid;
    let worker;
    let app;
    t.after(async () => {
      if (worker) {
        await worker.stop();
      }
      if (app) {
        await app.close();
      }
      // GatewayClass deletion waits on its owning Gateway. Retire our exact Gateway first,
      // never hang on or replay an uncertain in-progress GatewayClass deletion.
      const actual = await routingClient.resource("gateway", owningName, platformNamespace);
      assert.equal(actual.metadata.uid, owningUid, "retire only this run's exact owning Gateway");
      await routingClient.kubectl(
        "-n",
        platformNamespace,
        "delete",
        "gateway",
        owningName,
        "--timeout=60s",
      );
      for (const finish of routeCleanup.reverse()) {
        await finish();
      }
      console.log("stopped worker/API and retired exact run-owned Gateway before GatewayClass");
    });
    const gatewayAddress = (await lookup(gateway.routing.hostname)).address;
    const apiKeyPath = file("workspace-operator-key", gateway.apiKey);
    const configuration = createKubernetesInstallationConfiguration({
      authentication: { mode: "kubeconfig", kubeconfigPath, context: kubernetesContext },
      platformNamespace,
      gatewayImage: runtimeImage,
      codexImage: runtimeImage,
      cluster: kubernetesContext,
    });
    // Match OCE's full native Gateway acceptance profile: this is not the lightweight
    // configuration fixture. The Gateway loads its plugins and native worker bundle.
    const gatewayMemoryLimit = "4Gi";
    configuration.drivers.compute.configuration.resources.gateway.limits.memory =
      gatewayMemoryLimit;
    configuration.drivers.compute.configuration.resources.namespace.quota = {
      pods: "16",
      "requests.cpu": "4",
      "requests.memory": "4Gi",
      "limits.cpu": "16",
      "limits.memory": "16Gi",
    };
    const compute = configuration.drivers.compute.configuration;
    delete compute.network.gatewayClients;
    compute.gatewayRouting = gateway.routing;
    compute.network.gatewayTrustedProxyCidrs = gateway.nativeOptions.gatewayAuth.trustedProxies;
    configuration.drivers.plugin = { id: "codex-plugin", configuration: {} };
    const members = {
      sandbox: "sandbox-strands",
      credential_proxy: "credential-proxy-strands",
      credential_gateway: "source-strands",
    };
    configuration.backend = [
      { id: "strands", type: "strands-box", drivers: members, configuration: {} },
    ];
    const authority = {
      host,
      port: 38443,
      certificatePath: dir + "/cert",
      privateKeyPath: dir + "/key",
      issuerPublicKeyPath,
      issuer: "oce-worker-qualification",
      audience: "oce-exchange",
      keyId: "test-issuer",
    };
    installStrandsProfile(
      (args, options) =>
        execFileSync("kubectl", ["--context", kubernetesContext, ...args], options),
      platformNamespace,
      gatewayImage,
    );
    // This entire qualification has one observed node. Production operators qualify all selected nodes.
    compute.runtime = {
      ...compute.runtime,
      nodeSelector: { "kubernetes.io/hostname": kubernetesContext + "-server-0" },
    };
    const strandsBox = {
      installationNamespace: platformNamespace,
      workspaceGateway: { hostname: gateway.routing.hostname, address: gatewayAddress },
      authorityUri: "https://" + host + ":38443",
      authorityCaPath: tls.caPath,
      issuerPrivateKeyPath,
      gatewayImage,
      dogwoodPolicyPath,
      qualifiedNetworkPolicy: "kubernetes-enforced",
      storageClassName: "local-path",
      originOverrides: { [hostname]: { connectIp: host, originCaPem: tls.ca } },
    };
    for (const [capability, id] of Object.entries(members)) {
      configuration.drivers[capability] = {
        id,
        configuration: capability === "credential_proxy" ? { authority, strandsBox } : {},
      };
    }
    const environment = {
      OCC_CONFIG_PATH: file("installation.yaml", JSON.stringify(configuration)),
      OCC_GATEWAY_API_KEY_PATH: apiKeyPath,
      OCC_GATEWAY_CA_PATH: tls.caPath,
    };
    const load = () => loadInstallationConfiguration({ mode: "production", environment });
    const drivers = await load();
    const workerDrivers = await load();
    const authBaseURL = "http://127.0.0.1";
    const authSecret = randomBytes(45).toString("base64url");
    const credentials = {
      email: "strands-worker@qualification.invalid",
      password: randomBytes(24).toString("base64url"),
    };
    await ensureDevelopmentBootstrap(t, {
      databaseUrl,
      authSecret,
      authBaseURL,
      ...credentials,
      installationName: "Strands qualification",
      environment: { PATH: process.env.PATH },
    });
    app = await composeProduction({
      mode: "production",
      host: "127.0.0.1",
      databaseUrl,
      authSecret,
      authBaseURL,
      drivers,
    });
    const request = await createAuthenticatedControllerRequest(app, credentials);
    const api = async (method, path, body) => {
      const response = await request(method, path, body);
      assert.ok(
        response.status < 300,
        method + " " + path + " returned " + response.status + " " + (response.error?.code ?? ""),
      );
      return response.data;
    };
    const events = [];
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 8 });
    worker = createControllerWorker({
      mode: "production",
      pool,
      drivers: workerDrivers,
      pollIntervalMs: 250,
      leaseDurationMs: 45_000,
      convergenceTimeoutMs: 600_000,
      emit(event) {
        // Failure evidence is content-free. Never serialize diagnostic objects, request, proof or provider bytes.
        if (/failed|deployment|claim/.test(event.event) || event.code) {
          const safe = [event.event, event.code, event.step, event.stage]
            .filter((x) => typeof x === "string" && /^[-\w.]{1,90}$/.test(x))
            .join(" ");
          if (events.at(-1) !== safe) {
            events.push(safe);
            console.log("worker:", safe);
          }
        }
      },
    });
    await worker.start();
    const ns = await api("POST", "/namespaces", {
      name: "strands-runtime-" + randomBytes(4).toString("hex"),
    });
    const base = "/namespaces/" + ns.id;
    let namespace;
    let deployment;
    for (let i = 0; i < 90; i++) {
      namespace = await api("GET", base);
      if (namespace.status === "ready") {
        break;
      }
      await delay(1000);
    }
    assert.equal(namespace.status, "ready", "ordinary worker Namespace provisioning");
    const create = (path, body) => api("POST", base + "/" + path, body);
    const secret = await create("secrets", { name: "fixture-origin", value: keys.initial });
    const createdSource = await create(
      "credential-sources",
      protectedSourceBody("responses", secret.ref, "https://" + hostname + ":39443/v1"),
    );
    // Record the maintainer's explicit live/execution consent before binding this fresh source.
    const source = await api("PATCH", base + "/credential-sources/" + createdSource.id, {
      adoption: "live",
      authorityScope: "execution",
    });
    assert.equal(source.id, createdSource.id);
    assert.deepEqual(source.egress, { adoption: "live", retention: "none" });
    const launch = protectedConfigurationBody(model);
    const native = gateway.nativeOptions.gatewayAuth;
    Object.assign(launch.values.gateway, {
      auth: native.auth,
      allowRealIpFallback: true,
      trustedProxies: native.trustedProxies,
    });
    const config = await create("configurations", launch);
    const agent = await create("agents", protectedAgentBody("real-harness", config.id, source.id));
    const role = await create("iam/roles", {
      name: "one-source",
      permissions: [{ action: "operate", resourceKind: "credential_source" }],
    });
    await create("iam/access-bindings", sourceAccessBindingBody(agent, role, source));
    const path = base + "/agents/" + agent.id;
    const transport = await api("POST", path + "/runtime-credentials", {});
    assert.equal(transport.transportConfigured, true);
    const revision = await api("POST", path + "/deploy");
    const started = Date.now();
    const deploymentPath = path + "/deployments/" + revision.id;
    const placement = kubernetesNamespaceName(ns.id);
    let harnessName;
    const preflightRolled = async () => {
      const [harness] = JSON.parse(
        await f.kubectl(
          "-n",
          placement,
          "get",
          "pods",
          "-o",
          "json",
          "-l",
          "openclaw.dev/strands-role=workload",
        ),
      ).items;
      if (!harness?.status.containerStatuses?.some((c) => c.name === "agent" && c.state.running)) {
        return;
      }
      const launched = harness.spec.containers.find((c) => c.name === "agent");
      assert.equal(launched.image, runtimeImage, "actual supplied OCE runtime manifest");
      // Compute packs the workspace supervisor, which packs the Codex startup program a second time.
      // Decode, do not evaluate either blob. Bind the rolled producer to source, not an image-age assumption.
      const [loader] = nodeProgramArguments("");
      const unpack = (pieces) =>
        inflateRawSync(Buffer.from(pieces.join(""), "base64")).toString("utf8");
      const loaderAt = launched.command.indexOf(loader);
      assert.ok(loaderAt > 0, "owning Compute node-program loader");
      const supervisor = unpack(launched.command.slice(loaderAt + 1));
      const args = JSON.parse(supervisor.match(/^\s*args: (\["-e",.+\]),$/m)?.[1]);
      assert.ok(args[1] === loader, "actual supplier's nested program loader");
      const startup = unpack(args.slice(2));
      assert.ok(
        startup === AGENT_RUNTIME_ENTRYPOINT &&
          startup.includes("Protected model probe requires its admitted CONNECT endpoint."),
        "rolled exact Codex startup from this Compute source, with bounded explicit CONNECT model probe",
      );
      harnessName = harness.metadata.name;
      // Kubelet can create .codex as root:2755 for its session/image subPath mounts. Prove this real
      // UID can write the config directory before waiting eleven minutes for a model it could not start.
      await f.kubectl(
        "exec",
        harnessName,
        "-n",
        placement,
        "-c",
        "agent",
        "--",
        "node",
        "-e",
        `
        const fs = require("node:fs"), dir = "/home/node/.codex", path = dir + "/qualification-" + require("crypto").randomUUID();
        if (process.getuid() !== 1000) throw new Error("workload UID is not 1000");
        fs.writeFileSync(path,"",{flag:"wx",mode:0o600}); fs.unlinkSync(path);
      `,
      );
      console.log(
        "verified actual rolled runtime, decoded exact nested Compute-generated model probe, writable non-root HOME",
      );
    };
    let active;
    console.log(
      "ordinary controller admitted revision; waiting for exact worker/Compute release, real startup probe and activation",
    );
    while (Date.now() - started < 660_000) {
      deployment = await api("GET", deploymentPath);
      assert.notEqual(
        deployment.status,
        "failed",
        "genuine deployment failed " + (deployment.error?.code ?? ""),
      );
      if (!harnessName) {
        await preflightRolled();
      }
      active = (await api("GET", path)).activeRevisionId;
      // The worker publishes the active pointer *before* finalizing the deployment. That
      // finalization can replace the bootstrap Gateway Pod, so wait for its durable success.
      if (active === revision.id && deployment.status === "succeeded") {
        break;
      }
      await delay(2000);
    }
    assert.equal(
      active,
      revision.id,
      "real production ControllerWorker must activate admitted revision; last phase " +
        events.at(-1),
    );
    assert.equal(deployment.status, "succeeded", "worker durably finalized this deployment");
    assert.deepEqual(provider.errors, []);
    assert.equal(provider.observations.length, 1, "one protected genuine Codex startup probe");
    assert.equal(provider.observations[0].credentialVersion, "initial");
    // This fixture exports the existing transport client used by supplier protected installation tests.
    // Only the ordinary Codex RPC client is used here. We do not install or select an OpenShell runtime.
    assert.ok(harnessName, "genuine rolled Harness and non-root startup-input checks completed");
    // The genuine startup probe has already established a positive control at this exact origin.
    await f.kubectl(
      "exec",
      harnessName,
      "-n",
      placement,
      "--",
      "node",
      "-e",
      `
      // Check after deployment: native setup has prepared this Git-backed workspace.
      // An empty workspace would make absence of native repository telemetry vacuous.
      require("node:fs").accessSync("/home/node/workspace/.git");
      const socket = require("node:net").connect(39443,${JSON.stringify(host)});
      socket.on("connect", () => {console.error("protected origin reachable without sender");process.exitCode=2;socket.destroy()});
      socket.on("error", e => {if(!["ECONNREFUSED","EHOSTUNREACH","ETIMEDOUT"].includes(e.code)) throw e});
      socket.setTimeout(3500,()=>socket.destroy());
    `,
    );
    await f.kubectl(
      "exec",
      harnessName,
      "-n",
      placement,
      "-c",
      "agent",
      "--",
      "node",
      "-e",
      rejectedStrandsWsCapabilities(),
    );
    // Capability behavior (not cryptographic server identity) and a real healthy retained channel.
    // After activation, the native app remains ready beyond two freshness intervals, without
    // presenting a capability to readyz and without a second startup model probe.
    await delay(12_000);
    await f.kubectl(
      "get",
      "--raw",
      "/api/v1/namespaces/" + placement + "/pods/" + harnessName + ":18791/proxy/readyz",
    );
    assert.equal(
      provider.observations.length,
      1,
      "native serving observation did not send a model request",
    );
    const runtimeEvidence = async () => {
      const k = (...args) => f.kubectl("-n", placement, ...args);
      const observations = JSON.parse(
        await k("get", "pods", "-l", "openclaw.dev/strands-execution", "-o", "json"),
      ).items;
      const history = JSON.parse(await k("get", "pvc", harnessName + "-history", "-o", "json"));
      const identity = observations
        .map((p) => {
          const c = p.status.containerStatuses.find(
            (x) => x.name === "agent" || x.name === "sender",
          );
          return [p.metadata.uid, c.containerID, c.imageID, c.restartCount, c.ready].join("/");
        })
        .sort();
      assert.equal(
        identity.length,
        2,
        "actual workload/sender identities and bound history for selected execution",
      );
      return JSON.stringify([identity, history.metadata.uid, history.spec.volumeName]);
    };
    const servingIdentity = await runtimeEvidence();
    // Resolve the finalized revision's own Ready gateway now, never a cached bootstrap Pod.
    const gatewaySelector =
      "openclaw.dev/workload-role=gateway,openclaw.dev/revision=" + revision.id;
    const gateways = JSON.parse(
      await f.kubectl("-n", placement, "get", "pods", "-l", gatewaySelector, "-o", "json"),
    ).items.filter(
      (p) =>
        !p.metadata.deletionTimestamp &&
        p.metadata.annotations["openclaw.dev/agent-id"] === agent.id &&
        p.status.conditions.some((c) => c.type === "Ready" && c.status === "True"),
    );
    assert.equal(gateways.length, 1, "one Ready gateway for this durably finalized Agent revision");
    assert.equal(
      gateways[0].spec.containers.find((c) => c.name === "gateway")?.resources.limits.memory,
      gatewayMemoryLimit,
      "the admitted ordinary Gateway has the full native acceptance-test budget",
    );
    const gatewayPod = gateways[0].metadata.name;
    const nonce = "OCE-EGRESS-" + randomUUID();
    console.log(
      "durable deployment succeeded, selected exact Ready revision gateway; invoking one turn",
    );
    let result;
    try {
      result = await f.requestCodexTurnFromGatewayPod({
        namespace: placement,
        gatewayPod,
        providerModel: model,
        prompt: "Reply exactly " + nonce,
        observeFailure: true,
        timeoutMs: 90_000,
      });
    } finally {
      // Never retry this turn, including an unknown outcome. Observe only bounded native,
      // authority and controlled-origin outcomes: no error text, items, requests or credentials.
      const message = result?.error?.message ?? "";
      const nativeStatus = ["failed", "completed", "interrupted"].includes(result?.status)
        ? result.status
        : "unknown";
      const { rows: ownerDenials } = await pool.query(
        `SELECT CASE WHEN details->>'phase' IN ('before_access', 'before_send') THEN details->>'phase' ELSE 'other' END AS phase,
           CASE WHEN details->>'code' IN ('identity','withdrawn','scope_mismatch','stale_configuration','unsupported_operation')
             THEN details->>'code' ELSE 'other' END AS code
         FROM occ.audit_events WHERE namespace_id=$1 AND resource_id=$2 AND details->>'revisionId'=$3
           AND action='openclaw.egress.authorize' AND outcome='denied' LIMIT 8`,
        [ns.id, source.id, revision.id],
      );
      console.log("turn transport and controlled-origin evidence", {
        resultReturned: result !== undefined,
        nativeStatus,
        nativeErrorHttpStatus: /\b(?:status|HTTP)\s+(\d{3})\b/i.exec(message)?.[1] ?? null,
        ownerDenials,
        totalOriginObservations: provider.observations.length,
        originObservationsMatchingTurn: provider.observations.filter((o) => o.nonce === nonce)
          .length,
      });
    }
    assert.equal(result.status, "completed");
    assert.ok(result.assistant === nonce, "original Codex client received exact protected answer");
    assert.equal(
      result.items.some((e) => e.params?.willRetry === true),
      false,
      "no automatic retry",
    );
    assert.equal(
      provider.observations.length,
      2,
      "one startup probe, one turn, no direct or automatic retry",
    );
    const last = provider.observations.at(-1);
    assert.deepEqual(
      [last.nonce, last.credentialVersion, last.store, last.stream],
      [nonce, "initial", false, true],
    );
    assert.ok(
      last.toolTypes.some((t) => t === "function" || t === "namespace"),
      "local tools advertised",
    );
    assert.equal(last.toolTypes.includes("web_search"), false, "no provider-executed search");
    const nativePrivacy = { nativeTurn: true, workspaceTelemetry: "absent" };
    assert.deepEqual(
      last.nativeTurnPrivacy,
      { body: nativePrivacy, header: nativePrivacy, headerCount: 1, bodyMatchesHeader: true },
      "controlled TLS origin received matching genuine native body/header turn metadata, neither with workspace telemetry",
    );
    console.log(
      "controlled origin: native body and one matching header retained; workspace telemetry absent in both",
    );
    // Long-lived Strands JWT maintenance belongs to the real worker/Compute. Observe the
    // unmodified durable schedule, never synthesize a rotation on the workload request path.
    const interval = workerDrivers.computeDriver.maintenanceIntervalMs;
    assert.equal(
      interval,
      120_000,
      "selected Strands Compute participates in natural durable maintenance",
    );
    console.log(
      "startup probe + completed real Codex turn; waiting for one natural worker maintenance and its queued successor",
    );
    const maintenanceDeadline = Date.now() + interval + 65_000;
    let maintained = false;
    while (Date.now() < maintenanceDeadline) {
      const { rows } = await pool.query(
        `SELECT state, reason_code FROM occ.controller_work WHERE namespace_id=$1 AND revision_id=$2 AND idempotency_key LIKE $3`,
        [ns.id, revision.id, "agent_revision:" + revision.id + ":maintenance:%"],
      );
      maintained =
        rows.some((w) => w.state === "succeeded" && w.reason_code === "REVISION_ALREADY_ACTIVE") &&
        rows.some((w) => w.state === "queued");
      if (maintained) {
        break;
      }
      await delay(2500);
    }
    assert.ok(
      maintained,
      "natural maintenance succeeded on already-active revision and the successor is durably queued",
    );
    assert.equal((await api("GET", path)).activeRevisionId, revision.id);
    assert.ok(
      (await runtimeEvidence()) === servingIdentity,
      "same ready workload/sender containers and bound history after maintenance",
    );
    assert.equal(
      provider.observations.length,
      2,
      "maintenance triggered no provider access, startup probe or operation replay",
    );
    console.log(
      "natural maintenance succeeded and queued successor; same ready sender/workload/history; origin still startup + one turn, not a 30m rotation claim",
    );
    console.log(
      "actual production worker activated revision, protected startup probe and one authentic real Codex app-server turn",
    );
  },
);
