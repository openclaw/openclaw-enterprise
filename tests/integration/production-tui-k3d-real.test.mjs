import { kubernetesNamespaceName } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { defaultAgentModel } from "../../apps/controller/src/console/agents/starter-model.mts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ownPortForward } from "../helpers/port-forward-cleanup.ts";
import { availablePort } from "../helpers/available-port.mjs";
import { createProductionTuiRequest } from "../helpers/production-tui-request.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { installProductionHelmControlPlane } from "../helpers/production-helm-real.mjs";
import {
  createKubernetesClient,
  createKubernetesInstallationConfiguration,
  kubectlArguments as buildKubectlArguments,
  kubernetesHash as hash,
  productionGatewayMemoryLimit,
  validateExplicitK3dLoopbackContext,
} from "../helpers/kubernetes-real.mjs";
import {
  assertKubernetesRuntimeOtelSettings,
  createOtelLogObservation,
  OTEL_RESOURCE,
} from "../helpers/logging-otel-observation.mjs";
import {
  bindLocalRehearsalCluster,
  createRehearsalCustody,
  localRehearsalEnvironment,
  protectedJSON,
  runFixtureCommand,
  writeFixtureObject,
} from "../helpers/production-rehearsal-custody.ts";
import {
  assertInstallationSecretRetained,
  assertInstallationVolume,
  assertLocalRehearsalSelection,
  measureUpgradeAvailability,
  readImmutableInstallationSecret,
  rehearsePopulatedReturn,
  selectRehearsalControllers,
} from "../helpers/staging-upgrade-return.ts";
import { rehearseOnlineMigration } from "../helpers/staging-online-migration.ts";

const selected = process.env.OCC_TEST_PRODUCTION_TUI_REAL === "1";
const harnessRoot = fileURLToPath(new URL("../../", import.meta.url));
const signinSelected = process.env.OCC_TEST_PRODUCTION_SIGNIN_REHEARSAL === "1";
const returnSelected = process.env.OCC_TEST_PRODUCTION_TUI_REHEARSAL === "1";
const onlineSelected = process.env.OCC_TEST_PRODUCTION_TUI_ONLINE_MIGRATION === "1";
const rehearsalSelected = signinSelected || returnSelected || onlineSelected;
const protectedTuiSelection = {
  kubeconfigPath: process.env.OCC_TEST_KUBERNETES_KUBECONFIG,
  kubernetesContext: process.env.OCC_TEST_KUBERNETES_CONTEXT,
};

function selectedTestTitle() {
  if (signinSelected) {
    return "Owned P/A sign-in receipts survive only the admitted controller transitions";
  }
  if (onlineSelected) {
    return "An incumbent production Helm Installation serves while the candidate migrates PostgreSQL";
  }
  if (returnSelected) {
    return "A populated production Helm Installation retains the acknowledged write after controller return";
  }
  return "Helm production installation supports interactive TUI and revision cutover";
}

test(
  selectedTestTitle(),
  {
    skip:
      selected || rehearsalSelected
        ? false
        : "Set OCC_TEST_PRODUCTION_TUI_REAL=1 with explicit disposable k3d and real images/key.",
    timeout: rehearsalSelected ? 2_700_000 : 1_800_000,
  },
  async (context) => {
    assert.ok(
      [signinSelected, onlineSelected, returnSelected].filter(Boolean).length <= 1,
      "Select exactly one local controller rehearsal",
    );
    const preparedHash = process.env.OCC_TEST_SIGNIN_PREPARED_SHA256;
    const signinReader = signinSelected ? await import("../helpers/signin/staged.mjs") : undefined;
    if (preparedHash) {
      assert.ok(signinReader, "the prepared cluster is dedicated to the sign-in case");
      signinReader.assertHostedSigninJob(process.env);
      assert.ok(
        !process.env.OCC_TEST_REHEARSAL_K3D_CLUSTER && !process.env.OCC_TEST_SIGNIN_NODE_UID,
        "the hosted cluster is selected only by its preparation receipt",
      );
    } else if (rehearsalSelected) {
      assertLocalRehearsalSelection(process.env);
    } else {
      await validateExplicitK3dLoopbackContext(protectedTuiSelection);
    }
    if (signinSelected) {
      assert.ok(
        !process.env.KUBECONFIG &&
          !protectedTuiSelection.kubeconfigPath &&
          !protectedTuiSelection.kubernetesContext &&
          !process.env.OCC_TEST_PRODUCTION_TUI_REHEARSAL,
      );
      if (!preparedHash) {
        assert.match(process.env.OCC_TEST_REHEARSAL_K3D_CLUSTER ?? "", /^signin-[a-f0-9]{20}$/);
        assert.match(process.env.OCC_TEST_SIGNIN_NODE_UID ?? "", /^[a-f0-9-]{36}$/);
      }
    }
    const planHash = process.env.OCC_TEST_SIGNIN_PLAN_SHA256;
    const stagedSignin =
      signinReader &&
      (await signinReader.readStagedSignin({
        directory: process.env.RUNNER_TEMP,
        expectedPlanHash: planHash,
        workflowSha: process.env.GITHUB_WORKFLOW_SHA,
        installation: process.env.STAGING_INSTALLATION,
      }));
    const preparedCluster =
      preparedHash &&
      (await signinReader.readPreparedSigninCluster(
        process.env,
        preparedHash,
        planHash,
        stagedSignin,
      ));
    const support = stagedSignin ? await import("../helpers/signin/support-images.mjs") : undefined;
    const supportReferences = support && (await support.signinSupportReferences());
    const images = Object.fromEntries(
      [
        ["controller", "OCC_TEST_PRODUCTION_CONTROLLER_IMAGE"],
        ["runtime", "OCC_TEST_KUBERNETES_RUNTIME_IMAGE"],
        ["postgres", "OCC_TEST_PRODUCTION_POSTGRES_IMAGE"],
        ["node", "OCC_TEST_PRODUCTION_NODE_IMAGE"],
      ].map(([name, variable]) => {
        const staged =
          stagedSignin &&
          (name === "controller"
            ? stagedSignin.previous.reference
            : name === "runtime"
              ? stagedSignin.fixedRuntime.reference
              : supportReferences[name]);
        if (staged && process.env[variable]) {
          assert.equal(process.env[variable], staged);
        }
        const value = staged ?? process.env[variable];
        assert.match(
          value ?? "",
          /^\S+@sha256:[a-f0-9]{64}$/,
          `${variable} must select a real immutable image`,
        );
        return [name, value];
      }),
    );
    const upgradeImageVariables = {
      controller: "OCC_TEST_PRODUCTION_UPGRADE_CONTROLLER_IMAGE",
      runtime: "OCC_TEST_PRODUCTION_UPGRADE_RUNTIME_IMAGE",
    };
    const upgradeImages = Object.fromEntries(
      Object.entries(upgradeImageVariables).map(([name, variable]) => [
        name,
        process.env[variable],
      ]),
    );
    const upgradeSelected = !rehearsalSelected && Object.values(upgradeImages).some(Boolean);
    if (upgradeSelected) {
      for (const [name, value] of Object.entries(upgradeImages)) {
        assert.match(
          value ?? "",
          /^\S+@sha256:[a-f0-9]{64}$/,
          `${upgradeImageVariables[name]} must select a real immutable image`,
        );
        assert.notEqual(value, images[name], `${name} upgrade image must change the digest`);
      }
    }
    if (!rehearsalSelected) {
      assert.ok(process.env.OPENAI_API_KEY, "A real model credential is required");
    }
    const model = rehearsalSelected
      ? undefined
      : (process.env.OCC_TEST_OPENAI_MODEL ?? defaultAgentModel);
    const suffix = randomBytes(rehearsalSelected ? 10 : 4).toString("hex");
    const system = `oce-tui-${suffix}`;
    const foreign = `oce-denied-${suffix}`;
    const release = `tui-${suffix}`;
    const directory = await mkdtemp(join(tmpdir(), "oce-production-tui-"));
    const rehearsalKubeconfig = join(directory, "rehearsal-kubeconfig");
    let cleanup;
    let restoreEnvironment;
    if (rehearsalSelected) {
      context.after(async () => {
        try {
          await cleanup?.();
        } finally {
          try {
            await rm(rehearsalKubeconfig, { force: true });
          } finally {
            restoreEnvironment?.();
          }
        }
      });
      // The shared Helm fixture's diagnostic helper also spawns kubectl directly.
      // The node:test file process owns these overrides for its whole rehearsal.
      const overrides = localRehearsalEnvironment(process.env);
      const original = Object.fromEntries(
        Object.keys(overrides).map((name) => [name, process.env[name]]),
      );
      const setEnvironment = (values) => {
        for (const [name, value] of Object.entries(values)) {
          if (value === undefined) {
            delete process.env[name];
          } else {
            process.env[name] = value;
          }
        }
      };
      setEnvironment(overrides);
      restoreEnvironment = () => setEnvironment(original);
      context.diagnostic(`Private rehearsal evidence directory: ${directory}`);
    }
    const secrets = process.env.OPENAI_API_KEY ? [process.env.OPENAI_API_KEY] : [];
    const otelLogs = rehearsalSelected
      ? undefined
      : createOtelLogObservation(context, { description: "production Helm real-Pod OTel logs" });
    const secret = () => {
      const value = randomBytes(32).toString("hex");
      secrets.push(value);
      return value;
    };
    const redact = (value) =>
      secrets.reduce(
        (text, credential) => text.split(credential).join("[redacted]"),
        String(value),
      );
    const names = rehearsalSelected ? [system] : [system, foreign];
    let localServiceKeyFile;
    let operatorForwarder;
    let providerForwarder;
    let rehearsalComplete = false;
    const run = (command, args, options) =>
      runFixtureCommand(command, args, options, redact, rehearsalSelected);
    if (stagedSignin) {
      assert.equal(
        (await run("git", ["rev-parse", "HEAD"], { cwd: harnessRoot })).trim(),
        stagedSignin.signinPlan.workflowSha,
        "staging harness checkout changed",
      );
      assert.equal(
        await run("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: harnessRoot }),
        "",
        "staging harness checkout must be clean",
      );
    }
    const supportIdentities =
      support && (await support.inspectSigninSupport(run, supportReferences));
    if (rehearsalSelected) {
      await run("bash", [
        "-c",
        'for tool in docker k3d go helm jq kubectl openssl python3 yq; do command -v "$tool" >/dev/null || { echo "missing rehearsal command: $tool" >&2; exit 1; }; done',
      ]);
    }
    const localCluster = rehearsalSelected
      ? await bindLocalRehearsalCluster(
          run,
          preparedCluster?.cluster ?? process.env.OCC_TEST_REHEARSAL_K3D_CLUSTER ?? "",
          rehearsalKubeconfig,
        )
      : undefined;
    const selection = localCluster?.selection ?? protectedTuiSelection;
    const rehearsal =
      stagedSignin ??
      (localCluster ? await selectRehearsalControllers(run, process.env) : undefined);
    const evidence = {
      source: "production Helm",
      cluster: selection.kubernetesContext,
      images,
      model,
      system,
      release,
      ...(supportIdentities && { supportIdentities }),
      rows: [],
    };
    const record = async (row, details = {}) => {
      evidence.rows.push({ row, ...details });
      await writeFile(join(directory, "proof.json"), JSON.stringify(evidence, null, 2) + "\n", {
        mode: 0o600,
      });
      context.diagnostic(`${details.disposition ?? "PASS"} ${row}`);
    };
    // Sign-in qualifies controller images; host tools and both Helm operations belong to this harness.
    const occCli = rehearsal ? join(directory, "occ") : join(process.cwd(), "bin", "occ");
    await run("go", ["build", "-trimpath", "-o", occCli, "./cmd/occ"], {
      cwd: signinSelected ? harnessRoot : rehearsal?.candidate.checkout,
    });
    const kubectl = (...args) => run("kubectl", buildKubectlArguments(selection, args));
    const kubernetes = createKubernetesClient({
      selection,
      kubectl,
      waitTimeoutMs: 180_000,
      waitIntervalMs: 1_000,
    });
    const kubeArgs = kubernetes.kubectlArguments([]);
    const get = async (kind, name, namespace = system) =>
      kubernetes.resource(kind, name, namespace);
    const { resources: resourcesFor, waitFor } = kubernetes;
    const custody = localCluster
      ? createRehearsalCustody({
          run,
          kubeArgs,
          namespace: system,
          release,
          suffix,
          cluster: localCluster,
          requireTLS: signinSelected,
          waitFor,
        })
      : undefined;
    if (signinSelected) {
      assert.equal(
        localCluster.nodeUID,
        preparedCluster?.nodeUID ?? process.env.OCC_TEST_SIGNIN_NODE_UID,
      );
      if (preparedCluster) {
        assert.equal(localCluster.clusterUID, preparedCluster.clusterUID);
        assert.equal(localCluster.serverID, preparedCluster.serverID);
        assert.deepEqual(supportIdentities, preparedCluster.support);
        for (const image of preparedCluster.release) {
          await localCluster.assertStagedImage(image);
        }
      }
      for (const identity of Object.values(supportIdentities)) {
        await localCluster.assertStagedImage(identity);
      }
      const namespaces = JSON.parse(await kubectl("get", "namespaces", "-o", "json")).items;
      assert.deepEqual(namespaces.map((n) => n.metadata.name).sort(), [
        "default",
        "kube-node-lease",
        "kube-public",
        "kube-system",
      ]);
      const pods = JSON.parse(await kubectl("get", "pods", "-A", "-o", "json")).items;
      assert(pods.every((p) => p.metadata.namespace === "kube-system"));
    }
    let materialization;
    let providerMaterial;
    let signinSetup;
    let signinOperator;
    let signinFailure;
    let dns;
    const apply = (object) =>
      custody ? custody.create(object) : writeFixtureObject(run, kubeArgs, "apply", object);
    const fixtureRun = async (command, args, options = {}) => {
      if (command === "kubectl" && options.input && args.slice(-3).join(" ") === "apply -f -") {
        const object = protectedJSON(options.input);
        if (
          (rehearsalSelected || upgradeSelected) &&
          object.kind === "Secret" &&
          object.metadata.name === "occ-installation-startup"
        ) {
          object.immutable = true;
        }
        if (custody) {
          return custody.create(object);
        }
        return run(command, args, {
          ...options,
          input: JSON.stringify(object),
          protectedInput: object.kind === "Secret",
        });
      }
      if (custody && command === "helm" && args[0] === "upgrade" && args[1] === "--install") {
        await custody.assertPostgres(true);
        if (signinSelected) {
          await materialization.assertDatabaseImage();
        }
        // This fixture owns a newly created namespace and starts revision 1.
        // Helm install cannot adopt an existing release by name.
        const output = await run(command, ["install", ...args.slice(2)], {
          ...options,
          cwd: signinSelected ? harnessRoot : rehearsal.previous.checkout,
        });
        await custody.bindRelease(1);
        return output;
      }
      return run(command, args, options);
    };
    const metadata = (name, namespace = system, labels = {}) => ({
      name,
      namespace,
      labels: { "oce-test": suffix, ...labels },
    });
    const createSecret = (name, stringData, namespace = system) =>
      apply({ apiVersion: "v1", kind: "Secret", metadata: metadata(name, namespace), stringData });
    const protectedBootstrapFiles = ["initial-admin-password", "initial-admin-service-key.json"];
    const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
    const podSecurity = {
      runAsNonRoot: true,
      runAsUser: 1000,
      runAsGroup: 1000,
      fsGroup: 1000,
      seccompProfile: { type: "RuntimeDefault" },
    };
    const securityContext = { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } };
    const resources = {
      requests: { cpu: "100m", memory: "128Mi" },
      limits: { cpu: "1", memory: "1Gi" },
    };
    const waitPod = (name, namespace = system) =>
      kubectl("-n", namespace, "wait", "--for=condition=Ready", `pod/${name}`, "--timeout=180s");
    const assertProtectedBootstrapFileModes = (stats, label) => {
      for (const file of protectedBootstrapFiles) {
        assert.equal(stats[file]?.mode, 0o600, `${label}: ${file} must stay owner-readable only`);
      }
    };

    cleanup = async () => {
      const closureErrors = [];
      for (const forwarder of [operatorForwarder, providerForwarder]) {
        try {
          await forwarder?.close();
        } catch (error) {
          closureErrors.push(error);
        }
      }
      if (closureErrors.length) {
        // Keep dependent resources while either forwarder may still be using them.
        throw new AggregateError(
          [...(signinFailure ? [signinFailure] : []), ...closureErrors],
          "Owned sign-in cleanup failed",
          { cause: closureErrors[0] },
        );
      }
      for (const close of [
        async () => {
          if (signinOperator) {
            await signinOperator(
              "rm",
              "-f",
              "/operator/signin-gate",
              "/operator/signin-gate.bootstrap",
              "/operator/signin-gate.retained",
            );
          }
        },
        async () => providerMaterial?.dispose(),
        async () => dns?.close(),
      ]) {
        try {
          await close();
        } catch (error) {
          closureErrors.push(error);
        }
      }
      // Preserve nonsecret proof and attach.sh; delete locally copied credentials.
      for (const file of ["tls.key", "tls.crt"]) {
        await rm(join(directory, file), { force: true });
      }
      if (localServiceKeyFile) {
        await rm(localServiceKeyFile, { force: true });
      }
      if (closureErrors.length) {
        throw new AggregateError(
          [...(signinFailure ? [signinFailure] : []), ...closureErrors],
          "Owned sign-in cleanup failed",
        );
      }
      // These namespaces are unique to this run. Keep is an explicit operator rehearsal mode.
      if (process.env.OCC_TEST_PRODUCTION_TUI_KEEP === "1" || (rehearsal && !rehearsalComplete)) {
        context.diagnostic(`Retained production setup: ${directory}`);
        return;
      }
      const uninstall = () =>
        run(
          "helm",
          [
            "uninstall",
            release,
            "-n",
            system,
            "--kubeconfig",
            selection.kubeconfigPath,
            "--kube-context",
            selection.kubernetesContext,
            ...(custody ? ["--wait", "--timeout=90s"] : []),
          ],
          { timeout: custody ? 100_000 : 60_000 },
        );
      if (custody) {
        await custody.teardown(uninstall);
        await rm(join(directory, "candidate-database-secret.json"), { force: true });
      } else {
        await uninstall().catch(() => {});
        for (const name of names.reverse()) {
          await kubectl("delete", "namespace", name, "--ignore-not-found", "--wait=false").catch(
            () => {},
          );
        }
      }
    };

    if (!rehearsalSelected) {
      context.after(cleanup);
    }

    async function installProductionControlPlane() {
      for (const name of names) {
        await apply({
          apiVersion: "v1",
          kind: "Namespace",
          metadata: { name, labels: { "oce-test": suffix } },
        });
      }
      if (signinSelected) {
        const { prepareMaterialization } = await import("../helpers/signin/materialization.mjs");
        const { providerDns } = await import("../helpers/signin/dns.mjs");
        dns = providerDns({ system, suffix, custody, localCluster, kubectl, kubeArgs, run });
        const { createOidcProviderMaterial } =
          await import("../helpers/oidc-provider-material.mjs");
        providerMaterial = await createOidcProviderMaterial(directory, {
          hostname: "idp.signin-rehearsal.test",
          redirectUri: "https://console.signin-rehearsal.test/api/auth/providers/oidc/callback",
          run: (command, args) => run(command, args, { protectedInput: true, timeout: 10_000 }),
        });
        materialization = await prepareMaterialization({
          providerMaterial,
          supportIdentities,
          chartDirectory: join(harnessRoot, "deploy/helm/openclaw-enterprise"),
          system,
          release,
          directory,
          suffix,
          images,
          apply,
          kubectl,
          get,
          waitFor,
          run,
          custody,
          localCluster,
          bindProviderDns: dns.bindProviderDns,
          registerPortForward: (forwarder) => {
            providerForwarder = forwarder;
          },
        });
      }
      const configuration = createKubernetesInstallationConfiguration({
        authentication: { mode: "inCluster" },
        platformNamespace: system,
        gatewayImage: images.runtime,
        codexImage: images.runtime,
        cluster: `production-tui-${suffix}`,
      });
      // The native TUI runs as a second OpenClaw process inside the gateway container.
      configuration.drivers.compute.configuration.resources.gateway.limits.memory =
        productionGatewayMemoryLimit;
      await writeFile(join(directory, "installation.json"), JSON.stringify(configuration), {
        mode: 0o600,
      });
      const port = await availablePort();
      const baseURL = `https://localhost:${port}`;
      const { adminEmail } = await installProductionHelmControlPlane({
        selection,
        images,
        namespace: system,
        release,
        directory,
        suffix,
        configuration,
        ...materialization?.helmOptions,
        authBaseURL: signinSelected
          ? "https://console.signin-rehearsal.test"
          : `https://console.oce.localhost:${port}`,
        agentNativeAdminDomain: "agents.oce.localhost",
        installationName: `Production TUI ${suffix}`,
        apiClients: [{ namespace: system, podLabels: { app: "production-tui-proxy" } }],
        channelDirectoryProxyUrl: returnSelected ? "http://198.51.100.25:3128" : undefined,
        metrics: rehearsal
          ? undefined
          : {
              enabled: true,
              scraperNamespaceLabels: { "kubernetes.io/metadata.name": system },
              scraperPodLabels: { app: "production-tui-proxy" },
            },
        run: fixtureRun,
        kubernetes,
        createSecretValue: secret,
        record,
      });

      await run("openssl", [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "2",
        "-keyout",
        join(directory, "tls.key"),
        "-out",
        join(directory, "tls.crt"),
        "-subj",
        "/CN=localhost",
        "-addext",
        signinSelected
          ? "subjectAltName=DNS:console.signin-rehearsal.test,DNS:localhost,IP:127.0.0.1"
          : "subjectAltName=DNS:localhost,IP:127.0.0.1",
      ]);
      await createSecret("proxy-tls", {
        "tls.key": await readFile(join(directory, "tls.key"), "utf8"),
        "tls.crt": await readFile(join(directory, "tls.crt"), "utf8"),
      });
      await apply({
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: metadata("proxy-code"),
        data: {
          "https-proxy.mjs": await readFile(
            "tests/fixtures/production-tui/https-proxy.mjs",
            "utf8",
          ),
        },
      });
      if (signinSelected) {
        await apply({
          apiVersion: "networking.k8s.io/v1",
          kind: "NetworkPolicy",
          metadata: metadata("signin-operator-private"),
          spec: {
            podSelector: {
              matchLabels: {
                app: "production-tui-proxy",
              },
            },
            policyTypes: ["Ingress"],
          },
        });
      }
      await apply({
        apiVersion: "v1",
        kind: "Pod",
        metadata: metadata("operator", system, {
          app: "production-tui-proxy",
          "app.kubernetes.io/name": "approved-gateway-client",
        }),
        spec: {
          securityContext: { ...podSecurity, fsGroupChangePolicy: "OnRootMismatch" },
          containers: [
            {
              name: "operator",
              image: images.node,
              imagePullPolicy: "IfNotPresent",
              command: ["node", "/code/https-proxy.mjs"],
              securityContext,
              resources,
              env: [
                ...(signinSelected
                  ? [
                      { name: "OCC_SIGNIN_PROXY", value: "1" },
                      {
                        name: "OCE_TEST_POD_UID",
                        valueFrom: { fieldRef: { fieldPath: "metadata.uid" } },
                      },
                    ]
                  : []),
                { name: "TLS_CERT_FILE", value: "/tls/tls.crt" },
                { name: "TLS_KEY_FILE", value: "/tls/tls.key" },
                {
                  name: "TARGET_URL",
                  value: `http://openclaw-enterprise-api.${system}.svc.cluster.local:8080`,
                },
              ],
              volumeMounts: [
                { name: "code", mountPath: "/code", readOnly: true },
                { name: "tls", mountPath: "/tls", readOnly: true },
                { name: "bootstrap", mountPath: "/bootstrap", readOnly: true },
                { name: "operator-private", mountPath: "/operator" },
              ],
              readinessProbe: { tcpSocket: { port: 8443 }, periodSeconds: 2 },
            },
          ],
          volumes: [
            { name: "code", configMap: { name: "proxy-code" } },
            { name: "tls", secret: { secretName: "proxy-tls" } },
            { name: "bootstrap", persistentVolumeClaim: { claimName: "bootstrap-password" } },
            { name: "operator-private", emptyDir: {} },
          ],
        },
      });
      await waitPod("operator");
      if (signinSelected) {
        const { operatorExecutor } = await import("../helpers/signin/operator.mjs");
        signinOperator = await operatorExecutor({
          custody,
          localCluster,
          get: async () => get("pod", "operator"),
          exec: (...args) =>
            run(
              "kubectl",
              [...kubeArgs, "-n", system, "exec", "pod/operator", "-c", "operator", "--", ...args],
              { protectedInput: true },
            ),
        });
        await signinOperator(
          "cp",
          "/operator/signin-gate.generation",
          "/operator/signin-gate.bootstrap",
        );
      }
      const bootstrapFileStats = async () =>
        JSON.parse(
          await kubectl(
            "-n",
            system,
            "exec",
            "operator",
            "--",
            "node",
            "-e",
            "const fs=require('node:fs');const root='/bootstrap';const result={};for(const name of ['initial-admin-password','initial-admin-service-key.json']){const s=fs.statSync(`${root}/${name}`);result[name]={uid:s.uid,gid:s.gid,mode:s.mode&0o777}}console.log(JSON.stringify(result));",
          ),
        );
      const beforeRetrievalStats = await bootstrapFileStats();
      assertProtectedBootstrapFileModes(beforeRetrievalStats, "before retrieval");
      const forwarding = spawn(
        "kubectl",
        [
          ...kubeArgs,
          "-n",
          system,
          "port-forward",
          "pod/operator",
          `${port}:8443`,
          "--address",
          "127.0.0.1",
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      operatorForwarder = ownPortForward(forwarding);
      let forwardOutput = "";
      forwarding.stdout.on("data", (data) => {
        forwardOutput += data;
      });
      forwarding.stderr.on("data", (data) => {
        forwardOutput += data;
      });
      await waitFor("TLS proxy forwarding", () => {
        if (operatorForwarder.error) {
          throw operatorForwarder.error;
        }
        assert(
          forwarding.exitCode === null && forwarding.signalCode === null,
          "operator forward exited",
        );
        return forwardOutput.includes("Forwarding from");
      });
      const ca = await readFile(join(directory, "tls.crt"));
      localServiceKeyFile = join(directory, "occ-service-key.json");
      let serviceKey;
      const externalRequest = createProductionTuiRequest({
        baseURL,
        ca,
        serviceKey: () => serviceKey,
        secrets,
      });
      const stagedServiceKey = JSON.parse(
        await kubectl(
          "-n",
          system,
          "exec",
          "operator",
          "--",
          "node",
          "-e",
          "const fs=require('node:fs');const source='/bootstrap/initial-admin-service-key.json';const target='/operator/occ-service-key.json';const input=JSON.parse(fs.readFileSync(source,'utf8'));if(typeof input.data?.key!=='string'||input.data.key.length===0)throw new Error('missing service key');fs.writeFileSync(target,JSON.stringify(input),{mode:0o600});fs.chmodSync(target,0o600);const sourceStat=fs.statSync(source);const targetStat=fs.statSync(target);console.log(JSON.stringify({id:input.data.id,installationId:input.meta?.installationId,expiresAt:input.data.expiresAt,sourceMode:sourceStat.mode&0o777,targetMode:targetStat.mode&0o777,targetUid:targetStat.uid,targetGid:targetStat.gid}));",
        ),
      );
      assert.equal(stagedServiceKey.sourceMode, 0o600);
      assert.equal(stagedServiceKey.targetMode, 0o600);
      await kubectl(
        "-n",
        system,
        "cp",
        "operator:/operator/occ-service-key.json",
        localServiceKeyFile,
      );
      await chmod(localServiceKeyFile, 0o600);
      const localServiceKey = JSON.parse(await readFile(localServiceKeyFile, "utf8"));
      assert.equal(typeof localServiceKey.data?.key, "string");
      assert.ok(localServiceKey.data.key.length > 0);
      assert.equal(localServiceKey.data.id, stagedServiceKey.id);
      assert.equal(localServiceKey.meta?.installationId, stagedServiceKey.installationId);
      serviceKey = localServiceKey.data.key;
      secrets.push(serviceKey);
      const afterRetrievalStats = await bootstrapFileStats();
      assert.deepEqual(afterRetrievalStats, beforeRetrievalStats);
      assertProtectedBootstrapFileModes(afterRetrievalStats, "after retrieval");

      const occEnv = {
        OCC_URL: baseURL,
        OCC_SERVICE_KEY_FILE: localServiceKeyFile,
        OCC_CA_BUNDLE: join(directory, "tls.crt"),
        OPENAI_API_KEY: undefined,
      };
      const runGuideOcc = async (args) => {
        const output = await run(occCli, [...args, "--output", "json"], { env: occEnv });
        for (const value of secrets) {
          assert.ok(!output.includes(value), "Guide output leaked a credential");
        }
        return JSON.parse(output);
      };
      const request = async (method, path, body, expected = 200) => {
        const result = await externalRequest(method, path, body);
        assert.equal(
          result.status,
          expected,
          redact(`${method} ${path}: ${JSON.stringify(result.body)}`),
        );
        assert.ok(result.body && typeof result.body === "object");
        assert.ok(Object.hasOwn(result.body, "data"));
        assert.ok(Object.hasOwn(result.body, "meta"));
        return result.body;
      };
      const installation = await request("GET", "/installation");
      if (signinSelected) {
        signinSetup = {
          port,
          ca,
          adminEmail,
          installationId: installation.data.id,
          operator: signinOperator,
        };
      }
      assert.equal(stagedServiceKey.installationId, installation.data.id);
      const guideInstallation = await runGuideOcc(["installation", "get"]);
      assert.equal(guideInstallation.id, installation.data.id);
      // Bind the cluster and OCC identities before either image workflow can mutate the release.
      if (custody) {
        await custody.annotateInstallation(installation.data.id);
      } else {
        await kubectl(
          "-n",
          system,
          "annotate",
          "secret",
          "occ-installation-startup",
          `openclaw.dev/installation-id=${installation.data.id}`,
        );
      }
      const externalUnauthenticatedInstallation = await externalRequest(
        "GET",
        "/installation",
        undefined,
        {
          authenticated: false,
        },
      );
      assert.equal(externalUnauthenticatedInstallation.status, 401);
      await record("Protected bootstrap output files remain 0600 through retrieval");
      await record("Service-key authenticated production HTTPS Installation read", {
        installationId: installation.data.id,
        serviceKeyId: stagedServiceKey.id,
      });
      const api = async (method, path, body, expected = 200) => {
        const result = await request(method, path, body, expected);
        return result.data;
      };
      return {
        api,
        baseURL,
        externalRequest,
        installationId: installation.data.id,
        occEnv,
        runGuideOcc,
      };
    }

    async function provisionNamespace({ api, externalRequest, runGuideOcc }) {
      assert.equal(
        (await externalRequest("GET", "/installation", undefined, { authenticated: false })).status,
        401,
      );
      const namespace = await runGuideOcc(["namespace", "create", `production-tui-${suffix}`]);
      await record("Guide occ CLI created OCC Namespace through production HTTPS", {
        namespaceId: namespace.id,
      });
      const tenantMetadata = await waitFor("backing tenant namespace", async () => {
        const list = JSON.parse(
          await kubectl(
            "get",
            "namespaces",
            "-l",
            `openclaw.dev/namespace=${namespace.id}`,
            "-o",
            "json",
          ),
        );
        if (!list.items.length) {
          return false;
        }
        assert.equal(list.items.length, 1);
        assert.equal(list.items[0].metadata.annotations["openclaw.dev/namespace-id"], namespace.id);
        return list.items[0].metadata;
      });
      const tenant = tenantMetadata.name;
      const gatewayTarget = kubernetesNamespaceName(namespace.id);
      assert.equal(gatewayTarget, tenant, "single-cluster Gateway uses the tenant namespace");
      await custody?.bindTenant(tenant, tenantMetadata.uid);
      names.push(tenant);
      for (const [name, role, account] of [
        ["worker", "worker", "worker"],
        ["configuration", "configuration", "api"],
        ["secrets", "api", "api"],
      ]) {
        await apply({
          apiVersion: "rbac.authorization.k8s.io/v1",
          kind: "RoleBinding",
          metadata: metadata(`production-tui-${name}`, tenant),
          roleRef: {
            apiGroup: "rbac.authorization.k8s.io",
            kind: "ClusterRole",
            name: `${release}-openclaw-tenant-${role}`,
          },
          subjects: [
            { kind: "ServiceAccount", name: `openclaw-enterprise-${account}`, namespace: system },
          ],
        });
      }
      await waitFor("backing Gateway namespace", async () => {
        const list = JSON.parse(
          await kubectl(
            "get",
            "namespaces",
            "-l",
            `openclaw.dev/gateway-namespace=${namespace.id}`,
            "-o",
            "json",
          ),
        );
        return list.items.some((item) => item.metadata.name === gatewayTarget);
      });
      await apply({
        apiVersion: "rbac.authorization.k8s.io/v1",
        kind: "RoleBinding",
        metadata: metadata("production-tui-gateway-worker", gatewayTarget),
        roleRef: {
          apiGroup: "rbac.authorization.k8s.io",
          kind: "ClusterRole",
          name: `${release}-openclaw-tenant-worker`,
        },
        subjects: [
          { kind: "ServiceAccount", name: "openclaw-enterprise-worker", namespace: system },
        ],
      });
      for (const role of ["configuration", "api"]) {
        await apply({
          apiVersion: "rbac.authorization.k8s.io/v1",
          kind: "RoleBinding",
          metadata: metadata(`production-tui-canonical-${role}`, gatewayTarget),
          roleRef: {
            apiGroup: "rbac.authorization.k8s.io",
            kind: "ClusterRole",
            name: `${release}-openclaw-tenant-${role}`,
          },
          subjects: [
            { kind: "ServiceAccount", name: "openclaw-enterprise-api", namespace: system },
          ],
        });
      }
      await waitFor("OCC Namespace ready", async () => {
        const current = await api("GET", `/namespaces/${namespace.id}`);
        assert.ok(!["failed", "deleting"].includes(current.status), `Namespace ${current.status}`);
        return current.status === "ready";
      });
      return { namespace, tenant };
    }

    async function provisionNamespaceAndAgent({ api, externalRequest, runGuideOcc }) {
      const { namespace, tenant } = await provisionNamespace({ api, externalRequest, runGuideOcc });
      // A connectivity demo has no identity wizard; first-run BOOTSTRAP.md would override its nonce prompt.
      const nativeConfiguration = createHarnessConfiguration("openclaw", model);
      nativeConfiguration.agents.defaults.skipBootstrap = true;
      nativeConfiguration.gateway.auth = {
        password: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_PASSWORD" },
      };
      const agentConfiguration = await api(
        "POST",
        `/namespaces/${namespace.id}/configurations`,
        { kind: "agent", values: nativeConfiguration },
        201,
      );
      const modelSecret = await api(
        "POST",
        `/namespaces/${namespace.id}/secrets`,
        { name: `model-${suffix}`, value: process.env.OPENAI_API_KEY },
        201,
      );
      const harnessAuth = { method: "api_key", source: modelSecret.ref };
      const agent = await api(
        "POST",
        `/namespaces/${namespace.id}/agents`,
        {
          name: `tui-${suffix}`,
          configurationId: agentConfiguration.id,
          executionMode: "embedded",
          harnessAuth,
        },
        201,
      );
      const stoppedAgent = await api(
        "POST",
        `/namespaces/${namespace.id}/agents`,
        {
          name: `stopped-${suffix}`,
          configurationId: agentConfiguration.id,
          executionMode: "embedded",
          harnessAuth,
        },
        201,
      );
      const secondaryAgent = await api(
        "POST",
        `/namespaces/${namespace.id}/agents`,
        {
          name: `secondary-${suffix}`,
          configurationId: agentConfiguration.id,
          executionMode: "embedded",
          harnessAuth,
        },
        201,
      );
      const secretOperator = await api(
        "POST",
        `/namespaces/${namespace.id}/iam/roles`,
        {
          name: `Model Secret operator ${suffix}`,
          permissions: [{ action: "operate", resourceKind: "secret" }],
        },
        201,
      );
      for (const target of [agent, stoppedAgent, secondaryAgent]) {
        // Each Agent service principal needs exact authority over its selected model Secret.
        await api(
          "POST",
          `/namespaces/${namespace.id}/iam/access-bindings`,
          {
            subjectKind: "identity",
            subjectId: target.servicePrincipalId,
            roleId: secretOperator.id,
            resourceKind: "secret",
            resourceId: modelSecret.id,
          },
          201,
        );
        // The Compute Driver, rather than this fixture, owns transport credential materialization.
        assert.deepEqual(
          await api(
            "POST",
            `/namespaces/${namespace.id}/agents/${target.id}/runtime-credentials`,
            {},
          ),
          { transportConfigured: true },
        );
      }
      const agentHash = hash(agent.id);
      await record("API-created Namespace ready with authenticated embedded Agents", {
        namespaceId: namespace.id,
        tenant,
        agentId: agent.id,
        secondaryAgentId: secondaryAgent.id,
        stoppedAgentId: stoppedAgent.id,
      });
      return { agent, agentHash, namespace, secondaryAgent, stoppedAgent, tenant };
    }

    async function prepareFleetBaselines() {
      const secondaryRevision = await api(
        "POST",
        `/namespaces/${namespace.id}/agents/${secondaryAgent.id}/deploy`,
        undefined,
        202,
      );
      const stoppedRevision = await api(
        "POST",
        `/namespaces/${namespace.id}/agents/${stoppedAgent.id}/deploy`,
        undefined,
        202,
      );
      await waitFor(
        "secondary baseline Agent initial revision",
        async () =>
          (await api("GET", `/namespaces/${namespace.id}/agents/${secondaryAgent.id}`))
            .activeRevisionId === secondaryRevision.id,
        300_000,
      );
      await waitFor(
        "stopped baseline Agent initial revision",
        async () =>
          (await api("GET", `/namespaces/${namespace.id}/agents/${stoppedAgent.id}`))
            .activeRevisionId === stoppedRevision.id,
        300_000,
      );
      await api(
        "POST",
        `/namespaces/${namespace.id}/agents/${stoppedAgent.id}/stop`,
        undefined,
        202,
      );
      await waitFor("stopped baseline Agent shutdown", async () => {
        const current = await api("GET", `/namespaces/${namespace.id}/agents/${stoppedAgent.id}`);
        return current.desiredRuntimeState === "stopped" && current.activeRevisionId === undefined;
      });
      return {
        secondaryRevisionId: secondaryRevision.id,
        stoppedRevisionId: stoppedRevision.id,
      };
    }

    async function proveProductionApiNetworkPolicy() {
      // Both clients use real listening services; a timeout alone is not a positive control.
      await apply({
        apiVersion: "v1",
        kind: "Pod",
        metadata: metadata("unapproved", foreign),
        spec: {
          securityContext: podSecurity,
          containers: [
            {
              name: "probe",
              image: images.node,
              imagePullPolicy: "IfNotPresent",
              securityContext,
              resources,
              command: [
                "node",
                "-e",
                "require('node:net').createServer(s=>s.end()).listen(8123,'0.0.0.0')",
              ],
              readinessProbe: { tcpSocket: { port: 8123 }, periodSeconds: 2 },
            },
          ],
        },
      });
      await waitPod("unapproved", foreign);
      const foreignIP = (await get("pod", "unapproved", foreign)).status.podIP;
      const probe = async (podNamespace, pod, host, targetPort, container) => {
        const code =
          "const net=require('node:net');const s=net.createConnection({host:process.argv[1],port:Number(process.argv[2])});s.setTimeout(3000);let done=false;function end(result){if(done)return;done=true;console.log(result);s.destroy()}s.on('connect',()=>end('connected'));s.on('timeout',()=>end('timeout'));s.on('error',e=>end(e.code));";
        return (
          await kubectl(
            "-n",
            podNamespace,
            "exec",
            pod,
            ...(container ? ["-c", container] : []),
            "--",
            "node",
            "-e",
            code,
            host,
            String(targetPort),
          )
        ).trim();
      };
      const apiService = (await get("service", "openclaw-enterprise-api")).spec.clusterIP;
      assert.equal(await probe(system, "operator", apiService, 8080), "connected");
      // Enforcing CNIs may REJECT immediately or DROP; the listening positive control stays live.
      assert.ok(
        ["timeout", "ECONNREFUSED", "EHOSTUNREACH"].includes(
          await probe(foreign, "unapproved", apiService, 8080),
        ),
      );
      assert.equal(await probe(system, "operator", apiService, 8080), "connected");
      assert.equal(await probe(system, "operator", foreignIP, 8123), "connected");
      // Both live OCC processes expose private metrics. Prove the allowed peer
      // can scrape, and the foreign peer cannot connect, against the same Pod IP.
      for (const component of ["api", "worker"]) {
        const pods = JSON.parse(
          await kubectl(
            "-n",
            system,
            "get",
            "pods",
            "-l",
            `app.kubernetes.io/component=${component},app.kubernetes.io/instance=${release}`,
            "-o",
            "json",
          ),
        );
        const running = pods.items.filter((pod) => pod.status.phase === "Running");
        assert.ok(running.length > 0, `${component} must have a running metrics target`);
        for (const pod of running) {
          const host = pod.status.podIP;
          assert.equal(await probe(system, "operator", host, 9464), "connected");
          assert.ok(
            ["timeout", "ECONNREFUSED", "EHOSTUNREACH"].includes(
              await probe(foreign, "unapproved", host, 9464),
            ),
          );
          const output = await kubectl(
            "-n",
            system,
            "exec",
            "operator",
            "--",
            "node",
            "-e",
            "fetch(process.argv[1]).then(async r=>{if(!r.ok)process.exit(1);process.stdout.write(await r.text())})",
            `http://${host}:9464/metrics`,
          );
          assert.match(output, /occ_process_resident_memory_bytes/);
        }
      }
      await record("Production API NetworkPolicy allows operator and denies foreign namespace");
      return { foreignIP, probe };
    }

    const nativeTuiArgv = ({ pod, state, session, message, invalidGatewayPassword = false }) => [
      ...kubeArgs,
      "-n",
      tenant,
      "exec",
      "-it",
      pod,
      "-c",
      "gateway",
      "--",
      "env",
      "-u",
      "OPENAI_API_KEY",
      `OPENCLAW_STATE_DIR=${state}`,
      ...(invalidGatewayPassword ? [`OPENCLAW_GATEWAY_PASSWORD=invalid-${suffix}`] : []),
      "node",
      "/app/openclaw.mjs",
      "tui",
      "--session",
      session,
      ...(message ? ["--message", message] : []),
    ];

    async function exerciseRevisionCutover() {
      let previousPod;
      let firstRevision;
      let finalPod;
      let finalRevision;
      for (const round of [1, 2]) {
        // Each bodyless deployment freezes a new immutable revision of the same Agent.
        const revision = await api(
          "POST",
          `/namespaces/${namespace.id}/agents/${agent.id}/deploy`,
          undefined,
          202,
        );
        const configMap = `gateway-${agentHash}-rev-${hash(revision.id)}`;
        await waitFor(
          `Agent active revision ${round}`,
          async () =>
            (await api("GET", `/namespaces/${namespace.id}/agents/${agent.id}`))
              .activeRevisionId === revision.id,
          300_000,
        );
        const gateway = await waitFor(`Ready gateway for revision ${round}`, async () => {
          const pods = await resourcesFor(
            "pods",
            tenant,
            "-l",
            `app.kubernetes.io/managed-by=openclaw-enterprise,openclaw.dev/namespace=${namespace.id},openclaw.dev/agent=${agent.id},openclaw.dev/workload-role=gateway`,
          );
          const matches = pods.filter(
            (pod) =>
              !pod.metadata.deletionTimestamp &&
              pod.status.phase === "Running" &&
              pod.status.conditions?.some(
                (condition) => condition.type === "Ready" && condition.status === "True",
              ) &&
              pod.spec.volumes.some((volume) => volume.configMap?.name === configMap),
          );
          assert.ok(matches.length <= 1, "Ambiguous active gateway Pod");
          return matches[0];
        });
        if (previousPod) {
          assert.notEqual(
            gateway.metadata.uid,
            previousPod.metadata.uid,
            "Cutover must serve the new immutable config in a new Pod",
          );
        }
        previousPod = gateway;
        if (round === 1) {
          firstRevision = revision.id;
        }
        finalPod = gateway.metadata.name;
        finalRevision = revision.id;
        if (round === 1) {
          const nonce = `DENIED_${suffix}`;
          const prompt = `Reply exactly: ${nonce}`;
          const output = await run("python3", [
            "tests/helpers/tui-pty.py",
            "expect-failure",
            "--deny-pattern",
            "gateway password mismatch",
            "--nonce",
            nonce,
            "--prompt",
            prompt,
            "--timeout",
            "60",
            "--",
            "kubectl",
            ...nativeTuiArgv({
              pod: gateway.metadata.name,
              state: `/tmp/occ-denied-${suffix}`,
              session: `denied-${suffix}`,
              message: prompt,
              invalidGatewayPassword: true,
            }),
          ]);
          for (const value of secrets) {
            assert.ok(!output.includes(value), "Denied TUI output leaked a credential");
          }
          assert.equal(JSON.parse(output).denied, true);
          await record("Fresh-state invalid gateway password rejected");
        }
        const first = `TUI_${round}_A_${randomBytes(8).toString("hex")}`;
        const second = `TUI_${round}_B_${randomBytes(8).toString("hex")}`;
        const firstPrompt = `Reply exactly: ${first}`;
        const secondPrompt = `Reply exactly: ${second}`;
        const output = await run(
          "python3",
          [
            "tests/helpers/tui-pty.py",
            "conversation",
            "--first-nonce",
            first,
            "--first-prompt",
            firstPrompt,
            "--second-nonce",
            second,
            "--second-prompt",
            secondPrompt,
            "--timeout",
            "240",
            "--",
            "kubectl",
            ...nativeTuiArgv({
              pod: gateway.metadata.name,
              state: `/tmp/occ-tui-${suffix}`,
              session: `production-${suffix}-${round}`,
              message: firstPrompt,
            }),
          ],
          { timeout: 550_000 },
        );
        for (const value of secrets) {
          assert.ok(!output.includes(value), "TUI output leaked a credential");
        }
        const conversation = JSON.parse(output);
        assert.equal(conversation.exitCode, 0);
        await writeFile(join(directory, `tui-revision-${round}.json`), output, { mode: 0o600 });
        assert.equal(
          (await get("pod", gateway.metadata.name, tenant)).metadata.uid,
          gateway.metadata.uid,
        );
        assert.equal(
          await kubectl(
            "-n",
            tenant,
            "exec",
            gateway.metadata.name,
            "-c",
            "gateway",
            "--",
            "node",
            "-e",
            "fetch('http://127.0.0.1:8080/readyz').then(r=>{if(!r.ok)process.exit(1);console.log('ready')})",
          ),
          "ready\n",
        );
        await record(
          `Revision ${round}: two assistant replies in one TUI, Ctrl+D leaves gateway ready`,
          {
            revisionId: revision.id,
            pod: gateway.metadata.name,
            podUid: gateway.metadata.uid,
            configMap,
            firstReply: conversation.firstReplyLine,
            secondReply: conversation.secondReplyLine,
          },
        );
        const gatewayService = (await get("service", `gateway-${agentHash}`, tenant)).spec
          .clusterIP;
        assert.equal(await probe(system, "operator", gatewayService, 8080), "connected");
        assert.ok(
          ["timeout", "ECONNREFUSED", "EHOSTUNREACH"].includes(
            await probe(foreign, "unapproved", gatewayService, 8080),
          ),
        );
        assert.equal(await probe(system, "operator", gatewayService, 8080), "connected");
        assert.ok(
          ["timeout", "ECONNREFUSED", "EHOSTUNREACH"].includes(
            await probe(tenant, gateway.metadata.name, foreignIP, 8123, "gateway"),
          ),
        );
        assert.equal(await probe(system, "operator", foreignIP, 8123), "connected");
        await record(`Revision ${round}: gateway ingress and private egress isolation`);
      }
      return {
        pod: finalPod,
        revisionId: finalRevision,
        successfulWorkerRevisionId: firstRevision,
      };
    }

    async function verifyCredentialBoundariesAndPrepareHandoff(finalGateway) {
      const { pod: finalPod, revisionId: finalRevision } = finalGateway;
      for (const [verb, resource, expected] of [
        ["get", "secrets", "yes"],
        ["create", "rolebindings", "no"],
      ]) {
        const allowed = await run(
          "kubectl",
          [
            ...kubeArgs,
            "-n",
            tenant,
            "auth",
            "can-i",
            verb,
            resource,
            "--as",
            `system:serviceaccount:${system}:openclaw-enterprise-worker`,
          ],
          { allowFailure: true },
        );
        assert.equal(allowed.trim(), expected, `Worker ${verb} ${resource} authority`);
      }
      const systemPods = await resourcesFor(
        "pods",
        system,
        "-l",
        "app.kubernetes.io/name=openclaw-enterprise",
      );
      for (const pod of systemPods.filter((item) => item.status.phase === "Running")) {
        await kubectl(
          "-n",
          system,
          "exec",
          pod.metadata.name,
          "--",
          "node",
          "-e",
          "if(process.env.OPENAI_API_KEY)process.exit(1)",
        );
        const logs = await kubectl(
          "-n",
          system,
          "logs",
          pod.metadata.name,
          "--all-containers",
          "--tail=200",
        );
        for (const value of secrets) {
          assert.ok(!logs.includes(value), "Control-plane log leaked a credential");
        }
      }
      const gatewayLogs = await kubectl(
        "-n",
        tenant,
        "logs",
        finalPod,
        "-c",
        "gateway",
        "--tail=200",
      );
      for (const value of secrets) {
        assert.ok(!gatewayLogs.includes(value), "Gateway log leaked a credential");
      }
      await record("Worker least privilege and credential output boundaries");
      await kubectl(
        "-n",
        system,
        "exec",
        "operator",
        "--",
        "rm",
        "-f",
        "/operator/occ-service-key.json",
      );
      if (localServiceKeyFile) {
        await rm(localServiceKeyFile, { force: true });
      }
      const bootstrapServiceKeyMode = JSON.parse(
        await kubectl(
          "-n",
          system,
          "exec",
          "operator",
          "--",
          "node",
          "-e",
          "const fs=require('node:fs');const s=fs.statSync('/bootstrap/initial-admin-service-key.json');console.log(JSON.stringify({mode:s.mode&0o777}))",
        ),
      );
      assert.equal(bootstrapServiceKeyMode.mode, 0o600);
      await record("Private service-key working copies removed before handoff");
      await record("No controller session required before interactive handoff");
      const attach = [
        "kubectl",
        ...nativeTuiArgv({
          pod: finalPod,
          state: `/tmp/occ-tui-${suffix}`,
          session: `production-${suffix}-2`,
        }),
      ];
      await writeFile(
        join(directory, "attach.sh"),
        "#!/bin/sh\nexec " + attach.map(shellQuote).join(" ") + "\n",
        { mode: 0o700 },
      );
      evidence.attachScript = join(directory, "attach.sh");
      await record("Final production setup attachable", {
        tenant,
        agentId: agent.id,
        revisionId: finalRevision,
        pod: finalPod,
      });
      context.diagnostic(`Evidence directory: ${directory}`);
    }

    async function exerciseIndependentImageUpgrades(finalGateway) {
      if (!upgradeSelected) {
        context.diagnostic(
          "SKIP independent image upgrades: set both OCC_TEST_PRODUCTION_UPGRADE_*_IMAGE values",
        );
        return finalGateway;
      }

      const sourceRevision = (await run("git", ["rev-parse", "HEAD"], { timeout: 30_000 })).trim();
      const valuesPath = join(directory, "values.json");
      const installationPath = join(directory, "installation.json");
      const installationKubeArgs = [...kubeArgs, "--namespace", system];
      const readInstallation = (name) =>
        readImmutableInstallationSecret(run, installationKubeArgs, name);
      const originalSecret = await readInstallation("occ-installation-startup");
      const assertMountedInstallation = async (name) => {
        const initialization = await get("job", `${release}-initialization`);
        assertInstallationVolume(initialization.spec.template.spec, name);
        const initializationPods = await resourcesFor(
          "pods",
          system,
          "-l",
          `batch.kubernetes.io/controller-uid=${initialization.metadata.uid}`,
        );
        assert.equal(initializationPods.length, 1, "expected the successful initializer Pod");
        assertInstallationVolume(initializationPods[0].spec, name);
        for (const component of ["api", "worker"]) {
          const deployment = await get("deployment", `openclaw-enterprise-${component}`);
          assertInstallationVolume(deployment.spec.template.spec, name);
          const pods = await resourcesFor(
            "pods",
            system,
            "-l",
            `app.kubernetes.io/instance=${release},app.kubernetes.io/component=${component}`,
          );
          const running = pods.filter(
            (pod) => !pod.metadata.deletionTimestamp && pod.status.phase === "Running",
          );
          assert.equal(running.length, 1, "expected one serving controller Pod");
          assertInstallationVolume(running[0].spec, name);
        }
      };
      const controllerEvidence = join(directory, "controller-upgrade");
      context.diagnostic(
        `Controller upgrade observations: ${join(directory, "forward-api-availability.json")}`,
      );
      const controllerOutput = await measureUpgradeAvailability(
        externalRequest,
        installationId,
        directory,
        () =>
          run(
            "scripts/upgrade-production-images",
            [
              "--kubeconfig",
              selection.kubeconfigPath,
              "--context",
              selection.kubernetesContext,
              "--namespace",
              system,
              "--release",
              release,
              "--values",
              valuesPath,
              "--installation",
              installationPath,
              "--controller-image",
              upgradeImages.controller,
              "--source-revision",
              sourceRevision,
              "--evidence-dir",
              controllerEvidence,
              "--occ",
              occCli,
              "--timeout-seconds",
              "600",
            ],
            { timeout: 900_000, env: occEnv },
          ),
        (details) =>
          record("Independent controller upgrade API availability observations", details),
      );
      assert.match(controllerOutput, /no Agent deployments were requested/u);
      for (const component of ["api", "worker"]) {
        const deployment = `openclaw-enterprise-${component}`;
        await kubectl("-n", system, "rollout", "status", `deployment/${deployment}`);
        const observed = await kubectl(
          "-n",
          system,
          "get",
          `deployment/${deployment}`,
          "-o",
          `jsonpath={.spec.template.spec.containers[?(@.name=='${component}')].image}`,
        );
        assert.equal(observed, upgradeImages.controller);
      }
      assertInstallationSecretRetained(
        await readInstallation(originalSecret.metadata.name),
        originalSecret,
      );
      await assertMountedInstallation(originalSecret.metadata.name);
      const controllerInventory = await waitFor(
        "fleet inventory after the independent controller upgrade",
        async () => {
          try {
            return await runGuideOcc(["installation", "deployment-inventory"]);
          } catch (error) {
            if (String(error).includes("HTTP 502")) {
              return false;
            }
            throw error;
          }
        },
        30_000,
      );
      assert.ok(controllerInventory.namespaces.some((candidate) => candidate.id === namespace.id));
      assert.equal(
        (await api("GET", `/namespaces/${namespace.id}/agents/${agent.id}`)).activeRevisionId,
        finalGateway.revisionId,
      );
      assert.equal(
        (await api("GET", `/namespaces/${namespace.id}/agents/${secondaryAgent.id}`))
          .activeRevisionId,
        secondaryBaselineRevision,
      );
      await record("Independent controller upgrade retained Agent revisions", {
        controllerImage: upgradeImages.controller,
      });

      // Configure a curated catalog and an unused documentation-range proxy in
      // the reviewed candidate; the live baseline remains unchanged until upgrade.
      const candidateValuesPath = join(directory, "candidate-values.json");
      const candidateInstallationPath = join(directory, "candidate-installation.json");
      const candidateValues = JSON.parse(await run("yq", ["-o=json", ".", valuesPath]));
      candidateValues.api = {
        ...candidateValues.api,
        channelDirectoryProxyUrl: "http://198.51.100.25:3128",
      };
      const candidateInstallation = JSON.parse(await run("yq", ["-o=json", ".", installationPath]));
      candidateInstallation.drivers.plugin = [
        {
          id: "codex-plugin",
          configuration: { catalogSource: "openai-curated" },
        },
      ];
      // Stage the final runtime configuration before stopping either controller.
      // The original immutable reference remains available for retained releases.
      const successorName = "occ-installation-successor";
      const successorConfiguration = structuredClone(candidateInstallation);
      successorConfiguration.drivers.compute.configuration.images.gateway = upgradeImages.runtime;
      successorConfiguration.drivers.compute.configuration.images.agent = upgradeImages.runtime;
      const successorObject = {
        apiVersion: "v1",
        kind: "Secret",
        metadata: {
          ...metadata(successorName),
          annotations: {
            "openclaw.dev/installation-id":
              originalSecret.metadata.annotations["openclaw.dev/installation-id"],
          },
        },
        immutable: true,
        type: originalSecret.type,
        data: {
          ...originalSecret.data,
          "installation.yaml": Buffer.from(JSON.stringify(successorConfiguration)).toString(
            "base64",
          ),
        },
      };
      const successorUID = (
        await writeFixtureObject(
          run,
          kubeArgs,
          "create",
          successorObject,
          "jsonpath={.metadata.uid}",
        )
      ).trim();
      const successor = await readInstallation(successorName);
      assert.equal(successor.metadata.uid, successorUID, "staged Installation Secret was replaced");
      assert.notEqual(successor.metadata.uid, originalSecret.metadata.uid);
      candidateValues.installation.secretName = successorName;
      const retainInstallationSecrets = async () => {
        assertInstallationSecretRetained(
          await readInstallation(originalSecret.metadata.name),
          originalSecret,
        );
        assertInstallationSecretRetained(await readInstallation(successorName), successor);
      };
      await writeFile(candidateValuesPath, JSON.stringify(candidateValues), { mode: 0o600 });
      await writeFile(candidateInstallationPath, JSON.stringify(candidateInstallation), {
        mode: 0o600,
      });
      const upgradeEvidence = join(directory, "runtime-upgrade");
      const runtimeArguments = [
        "--kubeconfig",
        selection.kubeconfigPath,
        "--context",
        selection.kubernetesContext,
        "--namespace",
        system,
        "--release",
        release,
        "--values",
        valuesPath,
        "--installation",
        installationPath,
        "--candidate-values",
        candidateValuesPath,
        "--candidate-installation",
        candidateInstallationPath,
        "--runtime-image",
        upgradeImages.runtime,
        "--source-revision",
        sourceRevision,
        "--evidence-dir",
        upgradeEvidence,
        "--occ",
        occCli,
        "--timeout-seconds",
        "600",
      ];
      const upgradeEnvironment = {
        OCC_URL: baseURL,
        OCC_SERVICE_KEY_FILE: localServiceKeyFile,
        OCC_CA_BUNDLE: join(directory, "tls.crt"),
        OPENAI_API_KEY: undefined,
      };

      // Interrupt after real quiescence and local preparation, before the Helm
      // submission marker. Resume must retain the staged reference and fleet.
      const wrapperDirectory = join(directory, "interrupted-upgrade-bin");
      await mkdir(wrapperDirectory);
      const realHelm = (await run("sh", ["-c", "command -v helm"])).trim();
      const wrapper = join(wrapperDirectory, "helm");
      await writeFile(
        wrapper,
        `#!/bin/sh\nif [ "$1" = status ] && [ -f ${shellQuote(join(upgradeEvidence, "quiescence-worker-deployment.json"))} ]; then exit 75; fi\nexec ${shellQuote(realHelm)} "$@"\n`,
        { mode: 0o700 },
      );
      await assert.rejects(
        run("scripts/upgrade-production-images", runtimeArguments, {
          timeout: 900_000,
          env: {
            ...upgradeEnvironment,
            PATH: `${wrapperDirectory}:${process.env.PATH}`,
          },
        }),
        /failed \(75\)/u,
      );
      await retainInstallationSecrets();
      assert.ok(
        Buffer.from(successor.data["installation.yaml"], "base64").toString() ===
          (await readFile(join(upgradeEvidence, "candidate-installation.yaml"), "utf8")),
        "prepared Installation bytes differ from the staged immutable Secret",
      );
      await assert.rejects(readFile(join(upgradeEvidence, "helm-started")), { code: "ENOENT" });
      for (const component of ["api", "worker"]) {
        assert.equal(
          (await get("deployment", `openclaw-enterprise-${component}`)).spec.replicas,
          0,
        );
      }
      const output = await run(
        "scripts/upgrade-production-images",
        [...runtimeArguments, "--resume"],
        {
          timeout: 900_000,
          env: upgradeEnvironment,
        },
      );
      assert.match(
        output,
        /runtime image; controller image remained unchanged and 2 running Agents selected new revisions/u,
      );
      await retainInstallationSecrets();
      await assertMountedInstallation(successorName);
      const apiDeployment = await get("deployment", "openclaw-enterprise-api");
      const apiContainer = apiDeployment.spec.template.spec.containers.find(
        ({ name }) => name === "api",
      );
      assert.equal(
        apiContainer.env.find(({ name }) => name === "OCC_CHANNEL_DIRECTORY_PROXY_URL").value,
        "http://198.51.100.25:3128",
      );
      const upgradedInstallation = JSON.parse(await run("yq", ["-o=json", ".", installationPath]));
      assert.equal(
        upgradedInstallation.drivers.plugin[0].configuration.catalogSource,
        "openai-curated",
      );
      for (const component of ["api", "worker"]) {
        const observed = await kubectl(
          "-n",
          system,
          "get",
          `deployment/openclaw-enterprise-${component}`,
          "-o",
          `jsonpath={.spec.template.spec.containers[?(@.name=='${component}')].image}`,
        );
        assert.equal(observed, upgradeImages.controller);
      }
      const deployments = (await readFile(join(upgradeEvidence, "deployments.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(deployments.length, 2);
      assert.ok(deployments.every((deployment) => deployment.namespaceId === namespace.id));
      const primaryDeployment = deployments.find((deployment) => deployment.agentId === agent.id);
      const secondaryDeployment = deployments.find(
        (deployment) => deployment.agentId === secondaryAgent.id,
      );
      assert.ok(primaryDeployment);
      assert.ok(secondaryDeployment);
      assert.notEqual(primaryDeployment.deploymentId, finalGateway.revisionId);
      assert.notEqual(secondaryDeployment.deploymentId, secondaryBaselineRevision);
      const doctorEvidence = (await readdir(join(upgradeEvidence, "status"))).filter((name) =>
        name.endsWith(".doctor.json"),
      );
      assert.equal(doctorEvidence.length, 2);
      for (const name of doctorEvidence) {
        assert.equal(
          JSON.parse(await readFile(join(upgradeEvidence, "status", name), "utf8")).ok,
          true,
        );
      }
      const stoppedAfter = await api(
        "GET",
        `/namespaces/${namespace.id}/agents/${stoppedAgent.id}`,
      );
      assert.equal(stoppedAfter.desiredRuntimeState, "stopped");
      assert.equal(stoppedAfter.activeRevisionId, undefined);
      const stoppedRevisions = await api(
        "GET",
        `/namespaces/${namespace.id}/agents/${stoppedAgent.id}/revisions`,
      );
      assert.deepEqual(
        stoppedRevisions.map((revision) => revision.id),
        [stoppedBaselineRevision],
      );

      const upgradedRevision = primaryDeployment.deploymentId;
      const gateway = await waitFor("upgraded gateway ready", async () => {
        const pods = await resourcesFor(
          "pods",
          tenant,
          "-l",
          `openclaw.dev/agent=${agent.id},openclaw.dev/revision=${upgradedRevision},openclaw.dev/workload-role=gateway`,
        );
        const matches = pods.filter(
          (pod) =>
            !pod.metadata.deletionTimestamp &&
            pod.status.phase === "Running" &&
            pod.status.conditions?.some(
              (condition) => condition.type === "Ready" && condition.status === "True",
            ),
        );
        assert.ok(matches.length <= 1, "Ambiguous upgraded gateway Pod");
        return matches[0];
      });
      assert.equal(
        gateway.spec.containers.find((container) => container.name === "gateway")?.image,
        upgradeImages.runtime,
      );

      const firstNonce = `UPGRADE_A_${randomBytes(8).toString("hex")}`;
      const secondNonce = `UPGRADE_B_${randomBytes(8).toString("hex")}`;
      const firstPrompt = `Reply exactly: ${firstNonce}`;
      const secondPrompt = `Reply exactly: ${secondNonce}`;
      const modelOutput = await run(
        "python3",
        [
          "tests/helpers/tui-pty.py",
          "conversation",
          "--first-nonce",
          firstNonce,
          "--first-prompt",
          firstPrompt,
          "--second-nonce",
          secondNonce,
          "--second-prompt",
          secondPrompt,
          "--timeout",
          "240",
          "--",
          "kubectl",
          ...nativeTuiArgv({
            pod: gateway.metadata.name,
            state: `/tmp/occ-upgrade-${suffix}`,
            session: `upgrade-${suffix}`,
            message: firstPrompt,
          }),
        ],
        { timeout: 300_000 },
      );
      for (const value of secrets) {
        assert.ok(!modelOutput.includes(value), "Upgrade TUI output leaked a credential");
      }
      assert.equal(JSON.parse(modelOutput).exitCode, 0);
      await retainInstallationSecrets();
      await record("Independent runtime image upgrade and fresh model reply", {
        installationReferences: {
          original: { name: originalSecret.metadata.name, uid: originalSecret.metadata.uid },
          successor: { name: successorName, uid: successor.metadata.uid },
          retained: true,
        },
        previousRevisionId: finalGateway.revisionId,
        revisionId: upgradedRevision,
        controllerImage: upgradeImages.controller,
        runtimeImage: upgradeImages.runtime,
        pod: gateway.metadata.name,
      });
      return {
        pod: gateway.metadata.name,
        revisionId: upgradedRevision,
        successfulWorkerRevisionId: upgradedRevision,
      };
    }

    async function newestPod(component) {
      const pods = await resourcesFor(
        "pods",
        system,
        "-l",
        `app.kubernetes.io/name=openclaw-enterprise,app.kubernetes.io/component=${component}`,
      );
      const candidates = pods
        .filter((pod) => pod.metadata.deletionTimestamp === undefined)
        .sort((left, right) =>
          String(left.metadata.creationTimestamp).localeCompare(
            String(right.metadata.creationTimestamp),
          ),
        );
      assert.ok(candidates.length > 0, `expected a ${component} Pod`);
      return candidates.at(-1);
    }

    async function assertProductionOtelLogs(finalGateway) {
      const [initializationPod, apiPod, workerPod, gatewayPod] = await Promise.all([
        newestPod("initialization"),
        newestPod("api"),
        newestPod("worker"),
        get("pod", finalGateway.pod, tenant),
      ]);
      assertKubernetesRuntimeOtelSettings(otelLogs, [gatewayPod]);
      await otelLogs.assertRecords({
        forbidden: secrets,
        expected: [
          {
            label: "production migration completed",
            serviceName: "occ-api",
            resource: {
              [OTEL_RESOURCE.serviceInstanceId]: initializationPod.metadata.uid,
            },
            attributes: { "event.name": "migration.completed" },
            body: "migration.completed",
          },
          {
            label: "production bootstrap completed",
            serviceName: "occ-api",
            resource: {
              [OTEL_RESOURCE.serviceInstanceId]: initializationPod.metadata.uid,
            },
            attributes: { "event.name": "installation.bootstrapped" },
            body: "installation.bootstrapped",
          },
          {
            label: "production API request completed",
            serviceName: "occ-api",
            resource: {
              [OTEL_RESOURCE.serviceInstanceId]: apiPod.metadata.uid,
            },
            attributes: {
              "event.name": "http.completed",
              "http.request.method": "GET",
              "http.response.status_code": 200,
            },
            body: "http.completed",
          },
          {
            label: "production worker completed embedded revision",
            serviceName: "occ-worker",
            resource: {
              [OTEL_RESOURCE.serviceInstanceId]: workerPod.metadata.uid,
            },
            attributes: {
              "event.name": "worker.completed",
              "occ.namespace.id": namespace.id,
              "occ.agent.id": agent.id,
              "occ.revision.id": finalGateway.successfulWorkerRevisionId,
              "work.operation": "agent_revision.reconcile",
              "work.outcome": "success",
            },
            body: "worker.completed",
          },
          {
            label: "production embedded gateway operational record",
            serviceName: "openclaw-gateway",
            resource: {
              [OTEL_RESOURCE.serviceInstanceId]: gatewayPod.metadata.uid,
              [OTEL_RESOURCE.namespaceId]: namespace.id,
              [OTEL_RESOURCE.agentId]: agent.id,
              [OTEL_RESOURCE.revisionId]: finalGateway.revisionId,
            },
            attributes: { "event.name": "gateway.operational" },
            body: "gateway.operational",
          },
        ],
      });
    }

    const { api, baseURL, externalRequest, installationId, occEnv, runGuideOcc } =
      await installProductionControlPlane();
    if (rehearsal) {
      await custody.assertPostgres();
      await custody.assertRelease();
      const { namespace, tenant } = await provisionNamespace({ api, externalRequest, runGuideOcc });
      if (signinSelected) {
        const { rehearseSignin } = await import("../helpers/signin/scenario.mjs");
        try {
          await rehearseSignin({
            rehearsal,
            system,
            release,
            directory,
            custody,
            kubectl,
            kubeArgs,
            localCluster,
            waitFor,
            run,
            record,
            api,
            namespace,
            tenant,
            materialization,
            signinSetup,
            dns,
          });
        } catch (error) {
          signinFailure = error;
          throw error;
        }
        rehearsalComplete = true;
        return;
      }
      if (onlineSelected) {
        await rehearseOnlineMigration({
          controllers: rehearsal,
          namespace: system,
          release,
          directory,
          run,
          kubectl,
          externalRequest,
          custody,
          localCluster,
          waitFor,
          record,
        });
        rehearsalComplete = true;
        return;
      }
      await rehearsePopulatedReturn({
        controllers: rehearsal,
        kubeconfig: selection.kubeconfigPath,
        context: selection.kubernetesContext,
        namespace: system,
        release,
        directory,
        occ: occCli,
        occEnv,
        namespaceId: namespace.id,
        tenant,
        runtime: images.runtime,
        run,
        kubectl,
        api,
        externalRequest,
        custody,
        localCluster,
        waitFor,
        record,
      });
      rehearsalComplete = true;
      return;
    }
    const { agent, agentHash, namespace, secondaryAgent, stoppedAgent, tenant } =
      await provisionNamespaceAndAgent({
        api,
        externalRequest,
        runGuideOcc,
      });
    const {
      secondaryRevisionId: secondaryBaselineRevision,
      stoppedRevisionId: stoppedBaselineRevision,
    } = await prepareFleetBaselines();
    const { foreignIP, probe } = await proveProductionApiNetworkPolicy();
    const finalGateway = await exerciseRevisionCutover();
    await assertProductionOtelLogs(finalGateway);
    const releaseGateway = await exerciseIndependentImageUpgrades(finalGateway);
    await verifyCredentialBoundariesAndPrepareHandoff(releaseGateway);
  },
);
