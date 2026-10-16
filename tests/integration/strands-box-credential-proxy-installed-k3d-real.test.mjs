// Opt in through scripts/qualification/strands-box-credential-proxy-k3d.sh.
// This installs the production Sandbox, sender, policy and Credential Proxy in an owned Linux cluster.
// The app fixture supplies real API/IAM/OCC with in-memory state, synthetic material, and a
// minimal released HTTPS workload. It does not substitute an installed receipt, send or origin.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { custodyOriginWire } from "../fixtures/egress-custody-origin-wire.mjs";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createStrandsBoxDrivers } from "../../apps/controller/src/backends/strands-box.ts";
import {
  COMPUTE_RELEASE_PUBLIC_KEY,
  HARNESS_EGRESS_ENROLLMENT_HELPER,
  computeReleasePublicKey,
  harnessEgressEnrollment,
  signComputeExecutionRelease,
} from "../../apps/controller/src/drivers/compute/egress-enrollment.ts";
import {
  bindOpenShellEgressAuthority,
  createOpenShellEgressAuthority,
} from "../../apps/controller/src/drivers/egress-proxy/openshell-authority.ts";
import { OpenShellEgressIdentity } from "../../apps/controller/src/drivers/egress-proxy/openshell-identity.ts";
import { assertExecutionAdmission } from "../../packages/contracts/src/index.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import {
  createDevelopmentComputeDriver,
  registerAndSelectDrivers,
} from "../helpers/development.mjs";
import {
  protectedAgentBody,
  protectedConfigurationBody,
  protectedSourceBody,
  sourceAccessBindingBody,
} from "../helpers/egress-connected-inputs.mjs";
import {
  installStrandsProfile,
  issueStrandsTlsFixture,
  rejectedStrandsWsCapabilities,
} from "../helpers/strands-box-installed.mjs";
import { KubernetesSecretDriver } from "../../apps/controller/src/drivers/secret/kubernetes/index.ts";

import { createSystemClock } from "../../apps/controller/src/drivers/repo/credentials/clock.ts";
import { createGitHubProtocol } from "../fixtures/repository-credentials/github/protocol.mjs";
import { preparedMetadataFixture } from "../helpers/prepared-metadata-fixture.mjs";

const selected = process.env.OCC_TEST_STRANDS_INSTALLED === "1";
const require = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
const { KubeConfig } = require("@kubernetes/client-node");
const sha = (value) => createHash("sha256").update(value).digest("hex");
const model = "fixture-model";
const repository = { id: 7311, full_name: "fixture/credential-free" };
const identityPath = "/repos/" + repository.full_name;
const receipt = "origin-answer-" + randomUUID();

test(
  "installed Strands Box and Dogwood enforce execution egress and preserve Credential Proxy response custody",
  {
    skip: !selected && "Requires an owned K3s cluster with observed NetworkPolicy enforcement.",
    timeout: 900_000,
  },
  async (t) => {
    const kubeConfig = new KubeConfig();
    kubeConfig.loadFromFile(process.env.KUBECONFIG);
    const context = kubeConfig.getCurrentContext();
    assert.match(context, /^k3d-strands-proxy-[-a-z\d]+$/, "dedicated cluster only");
    const kubectl = (...args) =>
      execFileSync("kubectl", ["--context", context, ...args], {
        encoding: "utf8",
        timeout: 45_000,
      });
    const host = process.env.STRANDS_PROXY_FIXTURE_IP;
    assert.match(
      host,
      /^(?:192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|10\.)/,
      "private fixture network",
    );
    const dir = mkdtempSync(tmpdir() + "/strands-installed-");
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const originHost = "origin.qualification.invalid";
    const tls = issueStrandsTlsFixture(dir, "IP:" + host + ",DNS:" + originHost);
    const material = "qualification-" + randomBytes(24).toString("base64url");
    const githubClock = createSystemClock();
    const github = createGitHubProtocol({ clock: githubClock });
    const preparedRepository = { id: 73, full_name: "fixture/repository" };
    const preparedPath = "/repos/" + preparedRepository.full_name;
    let issuerSecret;
    const completedRequests = [];
    let arrivals = 0;
    const originCounts = () => ({
      wire: origin.wireCount(),
      arrivals,
      completed: completedRequests.length,
    });
    let originMode = "normal";
    let pairArrived;
    const overlapping = [];
    const origin = custodyOriginWire(tls, async (request, response) => {
      // Node emits request after parsing complete HTTP headers. Count it even if the body never finishes.
      // This cannot observe TCP, TLS, or an HTTP attempt that stops before the headers are complete.
      arrivals++;
      if (request.url === preparedPath || request.url.startsWith("/app/installations/")) {
        return github.handleRequest(request, response);
      }
      const chunks = [];
      for await (const part of request) {
        chunks.push(part);
      }
      if (request.url === identityPath) {
        const exact =
          request.method === "GET" &&
          Buffer.concat(chunks).length === 0 &&
          request.headers.host === originHost + ":" + origin.address().port &&
          Object.keys(request.headers).every((name) => ["host", "connection"].includes(name));
        completedRequests.push({ path: identityPath, mode: "explicitly-no-credential", exact });
        response.writeHead(200, { "content-type": "application/json" });
        // The response owner must release only the admitted repository identity, not our private field.
        response.end(JSON.stringify({ ...repository, private: "private-origin-field" }));
        return;
      }
      const input = JSON.parse(Buffer.concat(chunks));
      // Remember matching booleans, not credential or request body.
      completedRequests.push({
        exact:
          request.method === "POST" &&
          input.model === model &&
          request.headers.host === originHost + ":" + origin.address().port &&
          request.headers.authorization === "Bearer " + material,
        path: request.url,
        mode: originMode,
      });
      if (originMode === "lose-response") {
        return request.socket.destroy();
      }
      let reply = receipt;
      if (originMode === "overlap") {
        const recipient = input.messages[0].content;
        assert.match(recipient, /^recipient-[12]$/);
        reply += "-" + recipient;
        overlapping.push(recipient);
        if (overlapping.length === 1) {
          await new Promise((done) => {
            pairArrived = done;
          });
        } else {
          pairArrived();
        }
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.write(JSON.stringify({ output: reply }));
      if (originMode === "forbidden-trailer") {
        response.addTrailers({ "x-forbidden-final": receipt });
      }
      response.end();
    });
    await new Promise((r) => origin.listen(0, host, r));
    t.after(() => {
      origin.closeAllConnections();
      origin.close();
    });
    const originPort = origin.address().port;
    const baseUrl = "https://" + originHost + ":" + originPort + "/v1";
    const issuer = generateKeyPairSync("ed25519");
    const issuerPrivateKeyPath = dir + "/issuer.pem";
    writeFileSync(
      issuerPrivateKeyPath,
      issuer.privateKey.export({ type: "pkcs8", format: "pem" }),
      { mode: 0o600 },
    );
    const dogwoodPolicyPath = dir + "/policy.dw";
    // The example denies repeated Responses attempts. Permit the distinct chat route at this layer
    // so the downstream withdrawal, response and outage probes are not masked by that earlier denial.
    writeFileSync(
      dogwoodPolicyPath,
      readFileSync(resolve("runtimes/strands-credential-proxy/policy/one-attempt.dw")) +
        '\npermit(principal, action == Box::Action::"http:request", resource)\n' +
        'when { context.input.intercepted && (context.input.path == "/v1/chat/completions" || context.input.path == "' +
        identityPath +
        '" || context.input.path == "' +
        preparedPath +
        '") };\n',
    );
    const id = {
      issuer: "https://issuer.qualification.invalid",
      keyId: "installed-test",
      audience: "oce-egress",
    };
    const identity = new OpenShellEgressIdentity({
      ...id,
      publicKey: issuer.publicKey.export({ type: "spki", format: "pem" }),
      sender: { id: "strands-proxy/sender", generation: 1 },
    });
    const storage = new KubernetesSecretDriver({
      authentication: { mode: "kubeconfig", context, kubeconfigPath: process.env.KUBECONFIG },
    });
    let materialReads = 0;
    const readMaterial = storage.readCredentialInput.bind(storage);
    storage.readCredentialInput = async (...args) => {
      materialReads++;
      return readMaterial(...args);
    };
    const reads = () => materialReads;
    const selection = {
      backendId: "strands-proxy",
      proxyId: "strands-proxy",
      sandboxId: "strands-sandbox",
      credentialGatewayId: "strands-catalog",
    };
    const app = await createConsoleAppFixture(t, {
      backends: [
        {
          id: selection.backendId,
          type: "strands-box",
          configuration: {},
          drivers: {
            sandbox: selection.sandboxId,
            credential_gateway: selection.credentialGatewayId,
            credential_proxy: selection.proxyId,
          },
        },
      ],
      provisionedPeople: [],
      secretDriver: storage,
      computeDriver: {
        ...createDevelopmentComputeDriver(),
        validateExecutionAdmission: assertExecutionAdmission,
        resolveSandboxNamespace: async (value) => value,
      },
    });
    await app.bootstrap();
    const operations = [];
    let signedNoMaterial;
    let lastAuthorizedUse;
    let lastSendCheck;
    let loseAuthorizeReply = false;
    let lostAuthorization;
    let beforeSendCheck;
    const authority = createOpenShellEgressAuthority(identity, {
      createCredentialProxy(...args) {
        // Observe only method and disposition at the original supplier. Never grant a decision in the test.
        const real = app.controller.createCredentialProxy(...args);
        for (const key of ["resolve", "authorizeSend", "protectResponse"]) {
          const method = real[key].bind(real);
          real[key] = async (...args) => {
            // Pause only the test caller, after real resolution and immediately before the real send check.
            if (key === "authorizeSend") {
              lastSendCheck = args[2];
              if (beforeSendCheck) {
                await beforeSendCheck();
              }
            }
            const value = await method(...args);
            // Bind the publicly observable request and empty injection digest to the supplier receipt below.
            if (key === "authorizeSend" && value?.kind === "allow") {
              lastAuthorizedUse = args[2];
              if (loseAuthorizeReply) {
                loseAuthorizeReply = false;
                lostAuthorization = args[2];
                // Drop the reply *after* the real authority committed the dispatch opportunity.
                // This is not a PostgreSQL COMMIT-acknowledgement or a database-restart test.
                throw new Error("qualification lost authorized reply");
              }
            }
            if (key === "authorizeSend" && value?.noMaterialRequired) {
              signedNoMaterial = { id: args[2], digest: value.injectionDigest };
            }
            operations.push(key + ":" + (value?.kind ?? (value ? "released" : "blocked")));
            return value;
          };
        }
        return real;
      },
    });
    const port = await bindOpenShellEgressAuthority(
      authority,
      host + ":0",
      Buffer.from(tls.cert),
      Buffer.from(tls.key),
    );
    t.after(() => authority.forceShutdown());
    const platform = "strands-platform-" + randomBytes(5).toString("hex");
    kubectl("create", "namespace", platform);
    const gh = { ...github, tls, origin: "https://" + host + ":" + originPort };
    const preparedFixture = preparedMetadataFixture(t, {
      gh,
      clock: githubClock,
      async loadIssuer(secret) {
        const lifetime = {
          signal: AbortSignal.timeout(5000),
          deadlineAt: new Date(Date.now() + 5000).toISOString(),
        };
        const { value } = await storage.readCredentialInput({
          secret,
          lifetime,
          retention: "none",
        });
        return createPrivateKey(value);
      },
    });
    const options = {
      installationNamespace: platform,
      ...id,
      authorityUri: "https://" + host + ":" + port,
      authorityCaPath: tls.caPath,
      issuerPrivateKeyPath,
      dogwoodPolicyPath,
      gatewayImage: process.env.STRANDS_PROXY_GATEWAY_IMAGE,
      qualifiedNetworkPolicy: "kubernetes-enforced",
      storageClassName: "local-path",
      originOverrides: {
        [originHost]: { connectIp: host, originCaPem: tls.ca },
        [host]: { connectIp: host, originCaPem: tls.ca },
      },
    };
    const { sandbox, proxy, credentialGateway } = createStrandsBoxDrivers(options, {
      ...selection,
      preparedGitHub: preparedFixture.preparedGitHub,
      kubeConfig,
    });
    // Exercise the same installed authority before and after an operator moves the profile from digest A
    // to B. Switch only between the two real Drivers' verification owners; neither decision is stubbed.
    let verificationOwner = proxy;
    registerAndSelectDrivers(app.controller, [
      credentialGateway,
      sandbox,
      {
        ...proxy,
        verifyInstallation: (...args) => verificationOwner.verifyInstallation(...args),
      },
    ]);
    await app.controller.validateBackendConfiguration();
    const namespace = await app.createNamespace("strands-" + randomBytes(5).toString("hex"), {
      ready: true,
    });
    const k = (...args) => kubectl("-n", namespace.name, ...args);
    kubectl("create", "namespace", namespace.name);
    kubectl(
      "annotate",
      "namespace",
      namespace.name,
      "openclaw.dev/namespace-id=" + namespace.id,
      "openclaw.dev/namespace-lifecycle=external",
    );
    kubectl(
      "label",
      "namespace",
      namespace.name,
      "openclaw.dev/namespace=" + namespace.id,
      "openclaw.dev/gateway-namespace=" + namespace.id,
      ...["enforce", "audit", "warn"].map(
        (mode) => "pod-security.kubernetes.io/" + mode + "=restricted",
      ),
    );
    const apply = (object) =>
      execFileSync("kubectl", ["--context", context, "-n", namespace.name, "apply", "-f", "-"], {
        input: JSON.stringify(object),
        encoding: "utf8",
        timeout: 30_000,
      });
    const policy = { apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy" };
    apply({
      ...policy,
      metadata: { name: "tenant-default-deny" },
      spec: { podSelector: {}, policyTypes: ["Egress", "Ingress"] },
    });
    const { id: ns } = namespace;
    const secret = await app.createSecret(ns, "origin-key", material);
    const api = async (method, path, body) => {
      const response = await app.request(method, "/namespaces/" + ns + "/" + path, { body });
      assert.ok(response.status < 300, method + " " + path + " returned " + response.status);
      return response.data;
    };
    // The actual POST already admits this source. With healthy Kubernetes but no installed profile,
    // it must refuse before provider material access; do not assume adoption first happens at PATCH.
    const readsWithoutProfile = reads();
    const input = protectedSourceBody("origin", secret.ref, baseUrl);
    const missing = await app.request("POST", "/namespaces/" + ns + "/credential-sources", {
      body: input,
    });
    assert.equal(
      missing.status,
      503,
      "missing installation must refuse the first protected source POST",
    );
    assert.equal(
      reads(),
      readsWithoutProfile,
      "source POST attempted no material reads without a profile",
    );
    console.log(
      "source admission phase=profile_missing method=POST status=503 material_reads_delta=0",
    );
    installStrandsProfile(
      (args, extra) => execFileSync("kubectl", ["--context", context, ...args], extra),
      platform,
      options.gatewayImage,
    );
    const createdSource = await api("POST", "credential-sources", input);
    assert.equal(
      reads(),
      readsWithoutProfile + 1,
      "the same source POST with a live profile performed its admission read",
    );
    console.log(
      "source admission phase=profile_live method=POST status=success material_reads_delta=1",
    );
    const source = await api("PATCH", "credential-sources/" + createdSource.id, {
      adoption: "live",
      authorityScope: "execution",
    });
    assert.equal(source.id, createdSource.id);
    assert.deepEqual(source.egress, { adoption: "live", retention: "none" });
    const configuration = await api("POST", "configurations", protectedConfigurationBody(model));
    const role = await api("POST", "iam/roles", {
      name: "one-source",
      permissions: [{ action: "operate", resourceKind: "credential_source" }],
    });
    const install = async (name, profile = "credential") => {
      const noMaterial = profile === "identity";
      const prepared = profile === "prepared";
      const repositoryRead = noMaterial || prepared;
      const zeroRoutes = profile === "zero-routes";
      let selectedSource = source;
      const agent = await api(
        "POST",
        "agents",
        repositoryRead || zeroRoutes
          ? {
              name,
              configurationId: configuration.id,
              executionMode: "dedicated",
              harnessAuth: { method: "runtime" },
            }
          : protectedAgentBody(name, configuration.id, source.id),
      );
      if (repositoryRead) {
        if (prepared) {
          selectedSource = await api("POST", "credential-sources", {
            name: "already-prepared-metadata",
            type: "github-app-metadata",
            config: { ...preparedFixture.config, agent_id: agent.id, authority: "execution" },
            secrets: { private_key: issuerSecret.ref },
          });
          assert.equal(selectedSource.egress.adoption, "prepared");
        } else {
          selectedSource = await api("POST", "credential-sources", {
            name: "identity-only",
            type: "credential-free-repository-metadata",
            config: {
              agent_id: agent.id,
              authority: "execution",
              origin: new URL(baseUrl).origin,
              repository_id: String(repository.id),
              repository: repository.full_name,
            },
          });
          assert.equal(
            selectedSource.egress.adoption,
            "credential_free",
            "source positively admitted as credential-free",
          );
          assert.deepEqual(selectedSource.secrets, {}, "no provider credential reference to read");
        }
        await api("PATCH", "agents/" + agent.id, {
          configurationId: configuration.id,
          harnessAuth: { method: "runtime" },
          credentialSources: [{ sourceId: selectedSource.id }],
        });
      }
      const binding = zeroRoutes
        ? undefined
        : await api(
            "POST",
            "iam/access-bindings",
            sourceAccessBindingBody(agent, role, selectedSource),
          );
      const deployed = await app.deployAgent(ns, agent.id);
      const revision = await app.controller.transact((u) =>
        u.revisions.findRevision(ns, agent.id, deployed.id),
      );
      const plan = revision.egressPlan;
      assert.equal(plan?.egressDriverId, proxy.id);
      assert.deepEqual(revision.executionAdmission, { version: 2, mode: "protected" });
      if (zeroRoutes) {
        assert.deepEqual(plan.routes, []);
      }
      const signal = AbortSignal.timeout(780_000);
      const ctx = { namespace, revision, plan, signal };
      const computeKey = generateKeyPairSync("ed25519").privateKey;
      const token = randomBytes(32).toString("base64url");
      const requirements = {
        image: process.env.STRANDS_PROXY_WORKLOAD_IMAGE,
        command: ["node", "-e", workload(plan)],
        workspaceMounts: [],
        files: [],
        credentialAttachments: [],
        loginMode: repositoryRead || zeroRoutes ? "runtime" : "credential_source",
        labels: {
          "openclaw.dev/network-profile": "provider-fenced-v1",
          "openclaw.dev/workload-role": "agent",
          "openclaw.dev/agent": agent.id,
          "openclaw.dev/revision": revision.id,
        },
        environment: Object.entries({
          APP_TOKEN_SHA: sha(token),
          APP_SERVER_PORT: "18790",
          OPENCLAW_EGRESS_ENROLLMENT_REVISION_ID: revision.id,
          [COMPUTE_RELEASE_PUBLIC_KEY]: computeReleasePublicKey(computeKey),
        }).map(([name, value]) => ({ name, value })),
        proxyWiring: await proxy.configureRevision(ctx),
      };
      const nodeSelector = { "kubernetes.io/hostname": context + "-server-0" };
      requirements.proxyWiring = {
        ...requirements.proxyWiring,
        configuration: {
          ...requirements.proxyWiring.configuration,
          computeWorkload: { nodeSelector },
        },
      };
      const provision = { ...ctx, requirements, transportToken: token };
      let installed;
      let ref;
      while (!installed) {
        ref = await sandbox.provisionHarness(provision);
        installed = await proxy.wiringStatus(ctx, ref.proxyWiring);
        if (!installed) {
          await delay(4000, undefined, { signal });
        }
      }
      const pod = ref.resourceName;
      const inPod = (...cmd) => k("exec", pod, "--", ...cmd);
      const spec = JSON.parse(k("get", "pod", pod, "-o", "json")).spec;
      const senderSpec = JSON.parse(k("get", "pod", pod + "-sender", "-o", "json")).spec;
      assert.deepEqual(spec.nodeSelector, nodeSelector);
      assert.deepEqual(
        senderSpec.nodeSelector,
        nodeSelector,
        "trusted sender and Harness select only qualified nodes",
      );
      assert.equal(spec.automountServiceAccountToken, false);
      assert.equal(
        spec.volumes.some((v) => v.secret || v.projected),
        false,
        "workload receives no signer, bearer or provider secret",
      );
      assert.ok(
        await proxy.verifyInstallation(ctx, installed),
        "observed exact running installation",
      );
      await app.controller.transact((u) => u.credentialSources.recordEgressInstallation(installed));
      assert.deepEqual(
        await sandbox.harnessStatus(provision),
        { state: "starting" },
        "no authenticated serving before release",
      );
      let released = false;
      while (!released) {
        await sandbox.enrollHarness(provision, installed, async (startupId) => {
          const committed = await app.controller.transact((u) =>
            u.credentialSources.findEgressInstallation(installed.sender.id, installed.sandboxId),
          );
          assert.ok(
            await proxy.verifyInstallation(ctx, committed),
            "fresh exact install verification before Compute signature",
          );
          released = true;
          return signComputeExecutionRelease(computeKey, startupId, committed);
        });
        if (!released) {
          await delay(2000, undefined, { signal });
        }
      }
      assert.equal(
        inPod("cat", "/tmp/compute-released").trim(),
        revision.id,
        "actual workload verified signed startup challenge",
      );
      inPod("node", "-e", rejectedStrandsWsCapabilities());
      let status;
      for (let tries = 0; tries < 8; tries++) {
        status = await sandbox.harnessStatus(provision);
        if (status.state === "serving") {
          break;
        }
        await delay(1000, undefined, { signal });
      }
      assert.equal(status.state, "serving", "post-release authenticated RFC6455 observation");
      await app.activateRevision(ns, agent.id, revision.id);
      const ip = JSON.parse(k("get", "pod", pod + "-sender", "-o", "json")).status.podIP;
      // A content-free readiness observation. Do not send a capability to this endpoint.
      const ready = () => {
        try {
          k(
            "get",
            "--raw",
            "/api/v1/namespaces/" + namespace.name + "/pods/" + pod + ":18791/proxy/readyz",
          );
          return true;
        } catch (error) {
          if (
            error.status === 1 &&
            /ServiceUnavailable|service unavailable|503/i.test(String(error.stderr))
          ) {
            return false;
          }
          throw new Error(
            "could not observe content-free Harness readiness, kubectl exit " + error.status,
            { cause: error },
          );
        }
      };
      assert.ok(ready(), "actual authenticated retained serving channel established");
      return {
        provision,
        ready,
        pod,
        ip,
        binding,
        installed,
        ctx,
        inPod,
        operation: async (route, recipient) => {
          // Keep this event loop available: it owns both the actual TLS authority and test origin.
          const { stdout } = await promisify(execFile)(
            "kubectl",
            [
              "--context",
              context,
              "-n",
              namespace.name,
              "exec",
              pod,
              "--",
              "node",
              "-e",
              client(
                prepared ? gh.origin : baseUrl,
                route,
                repositoryRead ? (prepared ? preparedRepository : repository) : undefined,
                recipient,
              ),
              route,
            ],
            { timeout: 48_000 },
          );
          return JSON.parse(stdout);
        },
      };
    };

    console.log("installing first admitted execution in default-deny tenant");
    const first = await install("first-workload");
    // Prove the same live installation with a real API identity explicitly unable to get Secrets.
    const serviceAccount = "strands-public-installation-reader";
    k("create", "serviceaccount", serviceAccount);
    apply({
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "Role",
      metadata: { name: serviceAccount },
      rules: [
        { apiGroups: [""], resources: ["pods"], verbs: ["get", "list"] },
        {
          apiGroups: [""],
          resources: ["pods/proxy", "configmaps", "services", "persistentvolumeclaims"],
          verbs: ["get"],
        },
        { apiGroups: ["networking.k8s.io"], resources: ["networkpolicies"], verbs: ["list"] },
      ],
    });
    k(
      "create",
      "rolebinding",
      serviceAccount,
      "--role=" + serviceAccount,
      "--serviceaccount=" + namespace.name + ":" + serviceAccount,
    );
    const as = "system:serviceaccount:" + namespace.name + ":" + serviceAccount;
    let canGetSecrets;
    try {
      canGetSecrets = k("auth", "can-i", "get", "secrets", "--as=" + as);
    } catch (e) {
      assert.equal(e.status, 1);
      canGetSecrets = e.stdout;
    }
    assert.equal(canGetSecrets.trim(), "no", "read-only verifier must lack get Secrets");
    kubectl(
      "-n",
      platform,
      "create",
      "rolebinding",
      "qualification-reader",
      "--role=oce-strands-installation-reader",
      "--serviceaccount=" + namespace.name + ":" + serviceAccount,
    );
    const reader = new KubeConfig();
    reader.loadFromOptions({
      clusters: [kubeConfig.getCurrentCluster()],
      currentContext: "read-only",
      contexts: [
        { name: "read-only", cluster: kubeConfig.getCurrentCluster().name, user: "read-only" },
      ],
      users: [
        { name: "read-only", token: k("create", "token", serviceAccount, "--duration=10m").trim() },
      ],
    });
    const publicObserver = createStrandsBoxDrivers(options, {
      ...selection,
      kubeConfig: reader,
    }).proxy;
    assert.ok(
      await publicObserver.verifyInstallation(first.ctx, first.installed),
      "nonce proof, observed workload/sender/fence/history and public identity binding without Secret access",
    );
    console.log("verified genuine live installation from an API identity without get Secrets");
    // The serving observer has a finite ~5s freshness bound. A healthy retained, authenticated
    // channel can provide new nonce evidence; a cached prior upgrade alone must not keep this ready.
    await delay(12_000);
    assert.ok(
      first.ready(),
      "healthy serving beyond two freshness intervals, no capability passed to readyz",
    );
    const before = reads();
    const firstOperations = operations.length;
    assert.deepEqual(await first.operation("responses"), { status: 200, originAnswer: true });
    assert.deepEqual(completedRequests[0], { exact: true, path: "/v1/responses", mode: "normal" });
    assert.deepEqual(originCounts(), { wire: 1, arrivals: 1, completed: 1 });
    assert.equal(reads(), before + 1, "exactly one supplier material access");
    assert.deepEqual(
      operations.slice(firstOperations).map((op) => op.split(":")[0]),
      ["resolve", "authorizeSend", "protectResponse"],
    );
    const afterSuccess = operations.length;
    for (let i = 0; i < 2; i++) {
      assert.deepEqual(await first.operation("responses"), { status: 403, originAnswer: false });
    }
    assert.equal(
      operations.length,
      afterSuccess,
      "temporal denials did not enter supplier or exercise authority",
    );
    assert.equal(reads(), before + 1);
    assert.deepEqual(
      originCounts(),
      { wire: 1, arrivals: 1, completed: 1 },
      "temporal denials added no HTTP request at the origin",
    );
    first.inPod("node", "-e", tcpDenied(host, originPort));
    first.inPod("node", "-e", tcpDenied(host, port));
    console.log(
      "one authentic origin read; two temporal denials; direct provider and authority unreachable",
    );

    // A separate admitted execution can use its fresh history, but cannot enter the first execution's sender.
    const second = await install("other-workload");
    second.inPod("node", "-e", tcpDenied(first.ip, 8080));
    first.inPod("node", "-e", tcpDenied(second.ip, 8080));
    assert.deepEqual(await second.operation("responses"), { status: 200, originAnswer: true });
    assert.deepEqual(originCounts(), { wire: 2, arrivals: 2, completed: 2 });
    assert.ok(
      completedRequests[1].exact,
      "different admitted execution got its own allowed operation",
    );
    console.log("both admitted workloads fenced from the other sender; second history independent");

    const chat = () => first.operation("chat/completions");
    // Prove the later downstream negative cases are not masked by the temporal Responses limit.
    assert.deepEqual(await chat(), { status: 200, originAnswer: true });
    const n = completedRequests.length;
    assert.equal(arrivals, n);
    const chatPath = "/v1/chat/completions";
    assert.deepEqual(completedRequests.at(-1), { exact: true, path: chatPath, mode: "normal" });
    const receiptFor = (execution, useId) =>
      app.controller.transact((u) =>
        u.egressSendReceipts.find({
          sender: execution.installed.sender,
          instanceId: execution.installed.enforcement.instanceId,
          useId,
          attemptId: useId,
        }),
      );
    originMode = "forbidden-trailer";
    assert.deepEqual(await chat(), {
      status: 502,
      originAnswer: false,
      fixedFailure: "dispatch-uncertain",
    });
    assert.deepEqual(originCounts(), { wire: n + 1, arrivals: n + 1, completed: n + 1 });
    assert.deepEqual(completedRequests.at(-1), {
      exact: true,
      path: chatPath,
      mode: "forbidden-trailer",
    });
    const blocked = await receiptFor(first, lastAuthorizedUse);
    assert.deepEqual(blocked?.observation, {
      kind: "response_blocked",
      dispatch: "confirmed",
      code: "response_policy",
    });
    originMode = "lose-response";
    assert.deepEqual(await chat(), {
      status: 502,
      originAnswer: false,
      fixedFailure: "dispatch-uncertain",
    });
    assert.deepEqual(
      originCounts(),
      { wire: n + 2, arrivals: n + 2, completed: n + 2 },
      "possible dispatch was not retried",
    );
    assert.deepEqual(completedRequests.at(-1), {
      exact: true,
      path: chatPath,
      mode: "lose-response",
    });
    const unknown = await app.controller.transact((u) =>
      u.egressSendReceipts.find({
        sender: first.installed.sender,
        instanceId: first.installed.enforcement.instanceId,
        useId: lastAuthorizedUse,
        attemptId: lastAuthorizedUse,
      }),
    );
    assert.deepEqual(
      unknown?.outcome,
      { kind: "uncertain", dispatch: "possible" },
      "fixture origin saw the write once; Credential Proxy did not infer a confirmed or absent dispatch",
    );
    assert.equal(unknown.observation, null);
    assert.equal(unknown.settled, false, "never repair an authorized send whose response was lost");

    originMode = "normal";
    // Lose the authority's reply before this real sender can receive a permit. TLS may already exist,
    // but the observer below counts even a partial first decrypted application byte, before HTTP parsing.
    const noPermitOrigin = originCounts();
    loseAuthorizeReply = true;
    assert.deepEqual(await chat(), { status: 502, originAnswer: false, fixedFailure: "not-sent" });
    assert.match(lostAuthorization, /^[a-f0-9-]{36}$/);
    const noPermit = await receiptFor(first, lostAuthorization);
    assert.deepEqual(noPermit.outcome, { kind: "uncertain", dispatch: "possible" });
    assert.equal(noPermit.settled, false);
    assert.equal(noPermit.observation, null);
    assert.deepEqual(
      originCounts(),
      noPermitOrigin,
      "lost permit sent zero application bytes to origin",
    );
    const noPermitStages = k("logs", first.pod + "-sender")
      .split("\n")
      .filter((line) => line.includes("request_id=" + lostAuthorization + " stage="))
      .map((line) => line.split(" stage=")[1]);
    assert.deepEqual(noPermitStages, ["resolve_accepted", "no_permit", "response_blocked"]);
    assert.deepEqual(await chat(), { status: 200, originAnswer: true });
    assert.equal(
      origin.wireCount(),
      noPermitOrigin.wire + 1,
      "only a new control sent any origin application bytes",
    );
    assert.deepEqual(
      await receiptFor(first, lostAuthorization),
      noPermit,
      "uncertain operation never replayed",
    );

    originMode = "overlap";
    const pairWire = origin.wireCount();
    const pair = await Promise.all(
      [first, second].map((execution, index) =>
        execution.operation("chat/completions", "recipient-" + (index + 1)),
      ),
    );
    assert.deepEqual(
      pair,
      Array(2).fill({ status: 200, ownReply: true }),
      "each actual sender released only its own reply",
    );
    assert.deepEqual(overlapping.sort(), ["recipient-1", "recipient-2"]);
    assert.equal(origin.wireCount(), pairWire + 2);
    originMode = "normal";
    const checkpoint = { origin: originCounts(), reads: reads() };

    // Kubernetes NotIn matches a missing label, even when its excluded value is the empty string.
    // Demonstrate that native behavior with a canary that has *no* authority or credential before
    // asking Credential Proxy to refuse stale installation. Never grant a direct path to the provider here.
    const canaryLabels = { qualification: "strands-missing-label-canary" };
    const firstLabels = {
      "openclaw.dev/strands-execution": first.installed.plan.execution.executionId,
      "openclaw.dev/strands-role": "workload",
    };
    const canary = "strands-policy-canary";
    const canaryIngress = "only-first-workload-to-harmless-canary";
    apply({
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name: canary, labels: canaryLabels },
      spec: {
        automountServiceAccountToken: false,
        restartPolicy: "Never",
        securityContext: {
          runAsUser: 1000,
          runAsNonRoot: true,
          seccompProfile: { type: "RuntimeDefault" },
        },
        containers: [
          {
            name: "harmless-literal",
            image: process.env.STRANDS_PROXY_WORKLOAD_IMAGE,
            command: [
              "node",
              "-e",
              'require("node:net").createServer(s=>s.end("harmless-policy-canary")).listen(18080)',
            ],
            readinessProbe: { tcpSocket: { port: 18080 } },
            securityContext: {
              allowPrivilegeEscalation: false,
              readOnlyRootFilesystem: true,
              capabilities: { drop: ["ALL"] },
            },
          },
        ],
      },
    });
    apply({
      ...policy,
      metadata: { name: canaryIngress },
      spec: {
        podSelector: { matchLabels: canaryLabels },
        policyTypes: ["Ingress"],
        ingress: [
          {
            from: [{ podSelector: { matchLabels: firstLabels } }],
            ports: [{ protocol: "TCP", port: 18080 }],
          },
        ],
      },
    });
    k("wait", "--for=condition=Ready", "pod/" + canary, "--timeout=35s");
    const harmlessIp = k("get", "pod", canary, "-o", "jsonpath={.status.podIP}").trim();
    const canaryFrom = (host, expected) =>
      "(" + observeHarmlessCanary.toString() + ")(" + JSON.stringify({ host, expected }) + ")";
    const denyToLiveCanary = () => {
      assert.equal(first.inPod("node", "-e", canaryFrom(harmlessIp, "denied")), "denied");
      // A dead listener would also be unreachable. Check the *same* listener, locally, after denial.
      assert.equal(
        k("exec", canary, "--", "node", "-e", canaryFrom("127.0.0.1", "harmless-policy-canary")),
        "harmless-policy-canary",
      );
    };
    denyToLiveCanary();
    apply({
      ...policy,
      metadata: { name: "changed-installation" },
      spec: {
        podSelector: {
          matchLabels: firstLabels,
          matchExpressions: [
            {
              key: "qualification.openclaw.dev/intentionally-absent",
              operator: "NotIn",
              values: [""],
            },
          ],
        },
        policyTypes: ["Egress"],
        egress: [
          {
            to: [{ podSelector: { matchLabels: canaryLabels } }],
            ports: [{ protocol: "TCP", port: 18080 }],
          },
        ],
      },
    });
    assert.equal(
      first.inPod("node", "-e", canaryFrom(harmlessIp, "harmless-policy-canary")),
      "harmless-policy-canary",
      "native policy with missing-label NotIn grants only the harmless canary",
    );
    assert.equal(
      await proxy.verifyInstallation(first.ctx, first.installed),
      false,
      "changed policy is not an exact installation",
    );
    assert.deepEqual(await chat(), { status: 403, originAnswer: false, fixedFailure: "not-sent" });
    assert.deepEqual(
      { origin: originCounts(), reads: reads() },
      checkpoint,
      "no material read and no HTTP request event at the origin for stale installation",
    );
    k("delete", "networkpolicy", "changed-installation");
    denyToLiveCanary();
    k("delete", "networkpolicy", canaryIngress);
    k("delete", "pod", canary, "--wait=false");
    console.log(
      "missing-label NotIn matched only a harmless canary; stale Credential Proxy refused provider access; temporary policies removed",
    );
    assert.ok(
      await proxy.verifyInstallation(first.ctx, first.installed),
      "exact selection restored after removing the stale network policy",
    );
    // This is a *separately admitted* no-material operation, never a missing or expired credential fallback.
    const beforeNoMaterial = {
      origin: originCounts(),
      reads: reads(),
      operation: operations.length,
    };
    const identityOnly = await install("explicit-identity-only", "identity");
    const identityRead = () => identityOnly.operation(identityPath);
    assert.deepEqual(
      await identityRead(),
      { status: 200, identity: true },
      "ordinary credential-free client received only the admitted repository identity",
    );
    assert.deepEqual(originCounts(), {
      wire: beforeNoMaterial.origin.wire + 1,
      arrivals: beforeNoMaterial.origin.arrivals + 1,
      completed: beforeNoMaterial.origin.completed + 1,
    });
    assert.deepEqual(
      completedRequests.at(-1),
      { path: identityPath, mode: "explicitly-no-credential", exact: true },
      "bodyless TLS identity GET; origin saw only admitted Host, no credential header, not even an empty one",
    );
    assert.equal(
      reads(),
      beforeNoMaterial.reads,
      "zero attempted versioned provider Secret reads from source admission through origin and release",
    );
    assert.ok(
      operations.slice(beforeNoMaterial.operation).includes("resolve:ready_without_material"),
      "signed supplier first fresh check positively selected no material",
    );
    const emptyDigest = sha("");
    assert.equal(
      signedNoMaterial?.digest,
      emptyDigest,
      "signed second fresh check positively permitted only empty injection",
    );
    const dispatch = await app.controller.transact((u) =>
      u.egressSendReceipts.find({
        sender: identityOnly.installed.sender,
        instanceId: identityOnly.installed.enforcement.instanceId,
        useId: signedNoMaterial.id,
        attemptId: signedNoMaterial.id,
      }),
    );
    assert.equal(
      dispatch?.material.kind,
      "no_material_required",
      "original send receipt distinguishes no material from credential loss",
    );
    assert.equal(dispatch.authorization.injectionDigest, emptyDigest);
    assert.deepEqual(dispatch.observation, {
      kind: "response",
      dispatch: "confirmed",
      status: 200,
    });
    const afterNoMaterial = { origin: originCounts(), reads: reads() };
    await api("DELETE", "iam/access-bindings/" + identityOnly.binding.id);
    assert.deepEqual(await identityRead(), {
      status: 403,
      originAnswer: false,
      fixedFailure: "not-sent",
    });
    assert.deepEqual(
      { origin: originCounts(), reads: reads() },
      afterNoMaterial,
      "withdrawn identity authority yielded no material read or HTTP request event at the origin",
    );
    console.log(
      "positively no-material on both signed checks, confirmed empty-injection receipt, exactly one bodyless TLS read; IAM withdrawal stopped next read",
    );

    // The same real Rust sender, this time bound to consented credential-bearing repository metadata.
    // A controlled GitHub issues one repository-scoped installation token only on an explicit preparation.
    // The actual preparation owner/reader use an in-memory preparation store, not a PostgreSQL restart.
    issuerSecret = await app.createSecret(
      ns,
      "fixture-app-key",
      github.privateKey.export({ type: "pkcs8", format: "pem" }),
    );
    const prepared = await install("scoped-prepared-metadata", "prepared");
    const readPrepared = () => prepared.operation(preparedPath);
    const cold = {
      wire: origin.wireCount(),
      issues: github.issuesOfTokens.length,
      reads: preparedFixture.reads,
    };
    assert.deepEqual(await readPrepared(), {
      status: 502,
      originAnswer: false,
      fixedFailure: "not-sent",
    });
    assert.equal(
      preparedFixture.reads,
      cold.reads + 1,
      "real cold warm-only lookup reached the scoped reader",
    );
    assert.equal(
      github.issuesOfTokens.length,
      cold.issues,
      "request never issues material on a cold miss",
    );
    assert.equal(origin.wireCount(), cold.wire, "cold miss put no application bytes at GitHub");
    assert.equal(await preparedFixture.prepare(), "committed");
    assert.equal(github.issuesOfTokens.length, cold.issues + 1);
    const warm = {
      wire: origin.wireCount(),
      reads: preparedFixture.reads,
      checks: preparedFixture.sendChecks,
    };
    assert.deepEqual(await readPrepared(), { status: 200, identity: true });
    assert.equal(preparedFixture.reads, warm.reads + 1);
    assert.equal(
      preparedFixture.sendChecks,
      warm.checks + 1,
      "final authority check used the current preparation",
    );
    assert.equal(origin.wireCount(), warm.wire + 1);
    assert.equal(github.trace.at(-1).target, preparedPath);
    assert.equal(
      github.trace.at(-1).tokenIndex,
      1,
      "origin validated exactly the prepared repository token",
    );
    assert.equal(
      github.issuesOfTokens.length,
      cold.issues + 1,
      "warm request neither issued nor renewed",
    );
    assert.deepEqual(github.errors, []);
    console.log(
      "installed sender: cold scoped metadata ready-miss, separate single preparation, exact warm authorized HTTPS read",
    );

    // An empty protected plan still enrolls. A permitted Box HTTP request has no matching
    // installed route, cannot reach the Credential Proxy, and cannot take an unprotected path.
    const empty = await install("protected-empty-plan", "zero-routes");
    const emptyCheckpoint = { origin: originCounts(), reads: reads(), calls: operations.length };
    assert.deepEqual(await empty.operation("chat/completions"), {
      status: 403,
      originAnswer: false,
      fixedFailure: "not-sent",
    });
    empty.inPod("node", "-e", tcpDenied(host, originPort));
    assert.deepEqual(
      { origin: originCounts(), reads: reads(), calls: operations.length },
      emptyCheckpoint,
    );
    console.log(
      "protected empty plan enrolled; no route, material, authority call, or direct origin access",
    );

    // Withdraw IAM after material was resolved, before the real supplier makes its final decision.
    // Require both the client refusal and the exact supplier receipt, with no new HTTP request event at the origin.
    const beforeRevocation = { reads: reads(), origin: originCounts(), use: lastSendCheck };
    beforeSendCheck = async () => {
      beforeSendCheck = undefined;
      await api("DELETE", "iam/access-bindings/" + second.binding.id);
    };
    assert.deepEqual(await second.operation("chat/completions"), {
      status: 403,
      originAnswer: false,
      fixedFailure: "not-sent",
    });
    assert.equal(beforeSendCheck, undefined);
    assert.notEqual(lastSendCheck, beforeRevocation.use);
    const denied = await receiptFor(second, lastSendCheck);
    assert.equal(denied?.settled, true);
    assert.equal(denied.authorization, null);
    assert.equal(denied.observation, null);
    assert.deepEqual(denied.outcome, {
      kind: "refused",
      dispatched: false,
      error: { kind: "denied", code: "unauthorized" },
    });
    assert.equal(reads(), beforeRevocation.reads + 1);
    assert.deepEqual(originCounts(), beforeRevocation.origin);
    console.log(
      "revoked after resolution; committed refused/not dispatched receipt, origin received no additional decrypted application bytes",
    );

    // This is an actual last-binding withdrawal, separate from either IAM test. Hold the sender
    // in deletion so the intermediate fence is observable, then release only our own finalizer.
    const pod = second.pod;
    const sender = pod + "-sender";
    const resource = (kind, name) => JSON.parse(k("get", kind, name, "-o", "json"));
    const uid = (kind, name) => resource(kind, name).metadata.uid;
    const histories = "persistentvolumeclaim/" + pod + "-history";
    const fence = () => [
      uid("networkpolicy", pod + "-in"),
      uid("networkpolicy", pod + "-out"),
      k("get", histories, "-o", "jsonpath={.metadata.uid}"),
      uid("pod", pod),
    ];
    const nextImage = process.env.STRANDS_PROXY_NEXT_GATEWAY_IMAGE;
    assert.match(nextImage, /@sha256:[a-f\d]{64}$/);
    assert.notEqual(
      nextImage.split("@")[1],
      options.gatewayImage.split("@")[1],
      "the profile upgrade has a genuinely new manifest",
    );
    const profileRollout = (image) => {
      kubectl(
        "-n",
        platform,
        "set",
        "image",
        "statefulset/oce-strands-installation",
        "installation=" + image,
      );
      kubectl(
        "-n",
        platform,
        "rollout",
        "status",
        "statefulset/oce-strands-installation",
        "--timeout=180s",
      );
    };
    // A still has live authority on the first execution, independently of the revoked second execution.
    assert.deepEqual(await chat(), { status: 200, originAnswer: true });
    const oldSender = () =>
      resource("pod", first.pod + "-sender").status.containerStatuses.find(
        (c) => c.name === "sender",
      );
    const fromA = oldSender();
    assert.ok(fromA.imageID.endsWith("@" + options.gatewayImage.split("@")[1]));
    profileRollout(nextImage);
    const upgraded = createStrandsBoxDrivers(
      { ...options, gatewayImage: nextImage },
      { ...selection, kubeConfig },
    ).proxy;
    await upgraded.sourceControl.assertAvailable(first.ctx.signal);
    // The new live profile B must not bless an old, correctly sealed, still-running sender A. Capture
    // the actual authority's reason and phase: a generic 403 or a profile/fetch error cannot satisfy this.
    verificationOwner = upgraded;
    const beforeStale = { origin: originCounts(), reads: reads(), operations: operations.length };
    const audit = () => app.controller.transact((u) => u.audit.list());
    const beforeAudit = await audit();
    assert.deepEqual(await chat(), { status: 403, originAnswer: false, fixedFailure: "not-sent" });
    const denial = (await audit()).find(
      (e) =>
        !beforeAudit.some((prior) => prior.id === e.id) &&
        e.action === "openclaw.egress.authorize" &&
        e.details.revisionId === first.ctx.revision.id,
    );
    assert.equal(denial?.details.phase, "before_access");
    assert.equal(denial.details.code, "stale_configuration");
    assert.deepEqual(operations.slice(beforeStale.operations), ["resolve:refused"]);
    assert.deepEqual(
      originCounts(),
      beforeStale.origin,
      "new profile + old sender sent no origin application bytes",
    );
    assert.equal(
      reads(),
      beforeStale.reads,
      "new profile + old sender attempted zero material reads",
    );
    assert.equal(
      oldSender().containerID,
      fromA.containerID,
      "negative used the original live sender, not a replacement",
    );
    console.log(
      "profile=B running_sender=A authority=stale_configuration phase=before_access material_reads_delta=0 origin_wire_delta=0",
    );

    // Use the upgraded Driver to retire old A, including while Pod deletion is held and on the later
    // history cleanup. Neither stopping A nor retrying its retirement may require reauthorizing that manifest.
    const beforeWithdrawal = fence();
    const finalizer = "qualification.openclaw.dev/observe-withdrawal";
    assert.deepEqual(resource("pod", sender).metadata.finalizers ?? [], []);
    const patch = (operations) =>
      k("patch", "pod", sender, "--type=json", "-p", JSON.stringify(operations));
    patch([{ op: "add", path: "/metadata/finalizers", value: [finalizer] }]);
    const withdraw = () =>
      upgraded.withdrawBinding(second.ctx, second.ctx.plan.routes[0].binding.binding);
    try {
      assert.equal(
        await withdraw(),
        false,
        "do not report withdrawal while sender deletion is pending",
      );
      assert.ok(resource("pod", sender).metadata.deletionTimestamp);
      assert.deepEqual(
        fence(),
        beforeWithdrawal,
        "both fences, workload and history still present",
      );
      assert.equal(await upgraded.verifyInstallation(second.ctx, second.installed), false);
    } finally {
      patch([
        { op: "test", path: "/metadata/finalizers", value: [finalizer] },
        { op: "remove", path: "/metadata/finalizers/0" },
      ]);
    }
    const retiring = AbortSignal.timeout(120_000);
    while (!(await withdraw())) {
      await delay(750, undefined, { signal: retiring });
    }
    const absent = (...objects) =>
      assert.equal(k("get", ...objects, "--ignore-not-found", "-o", "name").trim(), "");
    absent(
      "pod/" + sender,
      "pod/" + pod,
      "networkpolicy/" + pod + "-in",
      "networkpolicy/" + pod + "-out",
    );
    assert.equal(k("get", histories, "-o", "jsonpath={.metadata.uid}"), beforeWithdrawal[2]);
    await assert.rejects(sandbox.provisionHarness(second.provision), /execution was retired/);
    assert.equal(
      await upgraded.removeRevision(second.ctx),
      true,
      "revision cleanup releases retired history",
    );
    if (k("get", histories, "--ignore-not-found", "-o", "name").trim()) {
      k("wait", "--for=delete", histories, "--timeout=60s");
    }
    absent(histories);
    await assert.rejects(sandbox.provisionHarness(second.provision), /execution was retired/);
    // Restore A, then prove first's still-live grant before its separate pre-access IAM withdrawal.
    // Keep that grant throughout the A/B control so its stale-configuration denial has only one cause.
    profileRollout(options.gatewayImage);
    verificationOwner = proxy;
    assert.ok(
      await proxy.verifyInstallation(first.ctx, first.installed),
      "retirement left the other installation intact",
    );
    console.log(
      "last binding retired whole execution; fenced pending deletion; history retained until revision cleanup; stale provisioning refused",
    );

    assert.deepEqual(await chat(), { status: 200, originAnswer: true });
    const beforeFirstWithdrawal = { origin: originCounts(), reads: reads() };
    await api("DELETE", "iam/access-bindings/" + first.binding.id);
    assert.deepEqual(await chat(), { status: 403, originAnswer: false, fixedFailure: "not-sent" });
    assert.deepEqual(
      { origin: originCounts(), reads: reads() },
      beforeFirstWithdrawal,
      "withdrawing the live first grant prevented material access and sent no origin application bytes",
    );
    console.log(
      "first IAM withdrawal phase=before_access material_reads_delta=0 origin_wire_delta=0",
    );

    const beforeOutage = { origin: originCounts(), reads: reads() };
    authority.forceShutdown();
    assert.deepEqual(await chat(), { status: 502, originAnswer: false, fixedFailure: "not-sent" });
    assert.deepEqual(
      { origin: originCounts(), reads: reads() },
      beforeOutage,
      "unavailable authority yielded no material or direct retry",
    );
    // Drop only the synthetic app's retained capability channel, never an origin connection.
    // The listener remains live and rejects missing/wrong credentials. A prior successful upgrade
    // is insufficient, but a new control observation may acquire fresh authenticated evidence.
    identityOnly.inPod(
      "node",
      "-e",
      'process.kill(Number(require("fs").readFileSync("/tmp/qualification-app-pid","utf8")),"SIGUSR2")',
    );
    let seenUnready = false;
    for (let i = 0; i < 8; i++) {
      if (!identityOnly.ready()) {
        seenUnready = true;
        break;
      }
      await delay(800);
    }
    assert.ok(
      seenUnready,
      "closed retained serving channel cannot keep a live but unauthenticated listener ready",
    );
    assert.equal(
      (await sandbox.harnessStatus(identityOnly.provision)).state,
      "serving",
      "new authenticated channel, never prior upgrade replay",
    );
    assert.ok(identityOnly.ready());
    assert.deepEqual(
      { origin: originCounts(), reads: reads() },
      beforeOutage,
      "serving-channel probes did not exercise provider authority",
    );
    console.log(
      "forbidden final trailer and lost reply released no origin response bytes; stale installation, IAM withdrawal and outage added no HTTP request event at the origin",
    );
  },
);

function workload(plan) {
  const enrollment = JSON.stringify(harnessEgressEnrollment(plan));
  const fixture = readFileSync(
    new URL("../fixtures/strands-box-enrolled-workload.cjs", import.meta.url),
    "utf8",
  );
  return (
    HARNESS_EGRESS_ENROLLMENT_HELPER +
    "\n" +
    fixture +
    "\nmodule.exports(" +
    enrollment +
    ",waitForHarnessEgressEnrollment).catch(() => {console.error('fixture release or serving failed');process.exitCode=1});"
  );
}

function client(base, route, expectedRepository, recipient) {
  const metadata = Boolean(expectedRepository);
  return `
    const {request, Agent} = require("node:https");
    const url = ${JSON.stringify(metadata ? new URL(route, base).href : base + "/" + route)};
    const input = JSON.stringify(process.argv[1] === "responses"
      ? {model:"fixture-model",input:"hello",store:false}
      : {model:"fixture-model",messages:[{role:"user",content:${JSON.stringify(recipient ?? "hello")}}],store:false});
    const metadata = ${metadata};
    const req = request(url,{method:metadata ? "GET" : "POST", agent:new Agent({proxyEnv:process.env}),
      headers: metadata ? {} : {"content-type":"application/json","content-length":Buffer.byteLength(input)},
      signal:AbortSignal.timeout(38000)}, r => {
      let str = ""; r.on("data", c => str+=c); r.on("end", () => {
        const originAnswer = (str + JSON.stringify([r.headers,r.trailers])).includes(${JSON.stringify(receipt)});
        if (${Boolean(recipient)} && r.statusCode === 200) {
          const ownReply = JSON.stringify({output: ${JSON.stringify(receipt + "-" + recipient)}});
          return console.log(JSON.stringify({status:200, ownReply: str === ownReply}));
        }
        if (metadata && r.statusCode === 200) {
          const parsed = JSON.parse(str);
          const identity = JSON.stringify(parsed) === ${JSON.stringify(JSON.stringify(expectedRepository))};
          return console.log(JSON.stringify({status:200,identity}));
        }
        const failure = str === "origin dispatch is uncertain; the gateway did not retry" ? "dispatch-uncertain"
          : str === "request not sent" ? "not-sent" : undefined;
        const fixedFailure = failure &&
          r.headers["x-strands-box-egress"] === "refused" && !Object.keys(r.trailers).length &&
          JSON.stringify(Object.keys(r.headers).sort()) === JSON.stringify(["connection","content-length","x-strands-box-egress"]) &&
          r.headers["content-length"] === String(Buffer.byteLength(str)) && r.headers.connection.toLowerCase() === "close";
        console.log(JSON.stringify({status:r.statusCode,originAnswer,...(fixedFailure ? {fixedFailure:failure} : {})}));
      })
    }); req.end(metadata ? undefined : input);
  `;
}
function tcpDenied(host, port) {
  return `
    const s = require("node:net").connect(${Number(port)},${JSON.stringify(host)});
    s.once("connect", () => { console.error("unmanaged TCP unexpectedly connected"); process.exitCode=2; s.destroy() });
    s.once("error", e => { if(!["ECONNREFUSED","ETIMEDOUT","EHOSTUNREACH"].includes(e.code)) throw e });
    s.setTimeout(3500, () => s.destroy());
  `;
}

// Executed inside one of our two test Pods. API admission and CNI dataplane convergence are
// asynchronous. Probe only the powerless literal canary, never the provider or a Credential Proxy operation.
async function observeHarmlessCanary({ host, expected }) {
  const { connect } = await import("node:net");
  const { setTimeout: pause } = await import("node:timers/promises");
  const until = performance.now() + 25_000;
  const denied = new Set(["ECONNREFUSED", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH"]);
  do {
    const observed = await new Promise((resolve, reject) => {
      const socket = connect(18080, host);
      let connected = false;
      let reply = "";
      socket.on("connect", () => (connected = true));
      socket.setTimeout(1200, () => {
        socket.destroy();
        if (connected) {
          reject(new Error("connected canary did not reply"));
        } else {
          resolve("denied");
        }
      });
      socket.on("error", (e) => (!connected && denied.has(e.code) ? resolve("denied") : reject(e)));
      socket.on("data", (c) => (reply += c));
      socket.on("end", () =>
        reply === "harmless-policy-canary"
          ? resolve(reply)
          : reject(new Error("wrong canary reply")),
      );
    });
    if (observed === expected) {
      process.stdout.write(observed);
      return;
    }
    await pause(400);
  } while (performance.now() < until);
  throw new Error("CNI did not converge to expected harmless canary reachability");
}
