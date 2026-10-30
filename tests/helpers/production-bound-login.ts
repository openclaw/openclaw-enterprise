import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, chmod, mkdir, lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { TestContext } from "node:test";
import { requireHostSessionCookie } from "../fixtures/bound-login/browser.ts";
import { cleanEnvironment } from "../fixtures/repository-credentials/process.mjs";
import { installProductionHelmControlPlane } from "./production-helm-real.mjs";
import { createKubernetesClient, validateExplicitK3dLoopbackContext } from "./kubernetes-real.mjs";
import {
  createInitialInstallationConfiguration,
  bindInstallationConfiguration,
} from "../fixtures/bound-login/configuration.ts";
import { openShellSupervisorLabels } from "./openshell-kubernetes-real.mjs";
import { installNativeGateway } from "../fixtures/bound-login/native.ts";
import { QualificationFailure, type FailureClass } from "../fixtures/bound-login/failure.ts";
import { QualificationOperations, type Action } from "../fixtures/bound-login/operations.ts";
import { certificateAuthority, signedLeaf } from "./certificates.mjs";

const hash = (x: string) => createHash("sha256").update(x).digest("hex");
/** Runs only against the selected normal CI-owned disposable k3d context. */
export async function qualifyBoundLogin(
  t: TestContext,
  environment: NodeJS.ProcessEnv,
  clusterDirectory: string,
  clusterIdentity: { dev: number; ino: number; uid: number },
) {
  let stage = "prerequisites";
  const checkpoint = (action: Action) => {
    // Stdout survives in the Actions reporter's failure/interruption tail.
    console.log(JSON.stringify({ stage, action, status: "STARTED", remoteOutcome: "unknown" }));
  };
  checkpoint("prerequisites");
  const operations = new QualificationOperations(t.signal, checkpoint);
  // These callbacks contain only local preparation, never application dispatch.
  const local = async <T>(
    action: "private-directory" | "local-setup",
    prepare: () => T | Promise<T>,
  ) => {
    operations.begin(action);
    return operations.call(async () => {
      try {
        return await prepare();
      } catch {
        throw new QualificationFailure(t.signal.aborted ? "cancelled" : "local-setup");
      }
    });
  };
  const prepareLocal = <T>(prepare: () => T | Promise<T>) => local("local-setup", prepare);
  let commandCount = 0;
  const selection = {
    kubeconfigPath: environment.OCC_TEST_KUBERNETES_KUBECONFIG,
    kubernetesContext: environment.OCC_TEST_KUBERNETES_CONTEXT,
  };
  const images = {} as Record<
    | "controller"
    | "postgres"
    | "node"
    | "runtime"
    | "openShellGateway"
    | "openShellSandbox"
    | "openShellSupervisor",
    string
  >;
  let suffix: string;
  let directory: string;
  try {
    t.signal.throwIfAborted();
    // Standard job preparation owns the cluster and its private directory.
    // The test never tears down application resources; final lane cleanup retires the cluster.
    try {
      const kubeconfig = selection.kubeconfigPath;
      assert.ok(
        isAbsolute(clusterDirectory) && kubeconfig === join(clusterDirectory, "kubeconfig"),
      );
      assert.equal(await realpath(kubeconfig), kubeconfig);
      const directoryStat = await lstat(clusterDirectory);
      const configStat = await lstat(kubeconfig);
      assert.ok(directoryStat.isDirectory() && configStat.isFile());
      assert.deepEqual(
        {
          dev: directoryStat.dev,
          ino: directoryStat.ino,
          uid: directoryStat.uid,
        },
        clusterIdentity,
        "Cluster must match the selected job state",
      );
      assert.equal(directoryStat.uid, process.getuid!());
      assert.equal(configStat.uid, process.getuid!());
      assert.equal(directoryStat.mode & 0o777, 0o700);
      assert.equal(configStat.mode & 0o777, 0o600);
    } catch {
      throw new QualificationFailure("directory-refusal");
    }
    t.signal.throwIfAborted();
    operations.begin("kubeconfig-view");
    await validateExplicitK3dLoopbackContext(selection, {
      onCommand: () => {
        commandCount++;
      },
      onFailure: (details: { failureClass: FailureClass; exitCode?: number }) => {
        operations.stop(new QualificationFailure(details.failureClass, details));
      },
    });
    operations.begin("prerequisites");
    for (const [key, variable] of Object.entries({
      controller: "OCC_TEST_PRODUCTION_CONTROLLER_IMAGE",
      postgres: "OCC_TEST_PRODUCTION_POSTGRES_IMAGE",
      node: "OCC_TEST_PRODUCTION_NODE_IMAGE",
      runtime: "OCC_TEST_KUBERNETES_RUNTIME_IMAGE",
      openShellGateway: "OCC_TEST_OPENSHELL_GATEWAY_IMAGE",
      openShellSandbox: "OCC_TEST_OPENSHELL_SANDBOX_IMAGE",
      openShellSupervisor: "OCC_TEST_OPENSHELL_SUPERVISOR_IMAGE",
    })) {
      assert.match(environment[variable] ?? "", /^\S+@sha256:[a-f0-9]{64}$/);
      images[key as keyof typeof images] = environment[variable]!;
    }
    assert.equal(images.runtime, environment.OCC_TEST_KUBERNETES_GATEWAY_IMAGE);
    assert.equal(images.runtime, environment.OCC_TEST_KUBERNETES_AGENT_IMAGE);
    for (const n of [
      "OCC_TEST_OPENSHELL_HELM",
      "OCC_TEST_OPENSHELL_HELM_CHART",
      "OCC_TEST_OPENSHELL_WORKSPACE_HELM_CHART",
      "OCC_TEST_OPENSHELL_RUNTIME_CLASS",
      "OCC_TEST_ENVOY_GATEWAY_NAMESPACE",
    ]) {
      assert.ok(environment[n]);
    }
    suffix = await local("local-setup", () => randomBytes(5).toString("hex"));
    directory = await local("private-directory", () =>
      mkdtemp(join(clusterDirectory, "oce-bound-login-")),
    );
    await local("private-directory", () => chmod(directory, 0o700));
  } catch (error) {
    throw operations.reportFailure(error, stage, commandCount, (text) => t.diagnostic(text));
  }
  const system = "oce-bound-" + suffix;
  const release = "bound-" + suffix;
  const gatewayClass = "bound-" + suffix;
  const consoleHost = `bound-console.${system}.svc`;
  const origin = `https://${consoleHost}:38443`;
  const run = async (
    command: string,
    args: string[],
    options: { input?: string; timeout?: number; action?: Action; boundRpc?: boolean } = {},
  ) => {
    const executable =
      (
        {
          kubectl: environment.OCC_KUBECTL_BIN,
          helm: environment.OCC_HELM_BIN,
        } as Record<string, string | undefined>
      )[command] ?? command;
    let action: Action = options.action ?? "command";
    if (!options.action) {
      if (command === "git") {
        action = "git";
      } else if (command === "tar") {
        action = "archive";
      } else if (command === "openssl") {
        action = "certificate";
      } else if (command === "helm" || command === environment.OCC_TEST_OPENSHELL_HELM) {
        action =
          args[0] === "install"
            ? "helm-install"
            : args[0] === "upgrade"
              ? "helm-upgrade"
              : args[0] === "package"
                ? "helm-package"
                : "helm-read";
      } else if (command === "kubectl") {
        let index = 0;
        while (["--kubeconfig", "--context", "-n", "--namespace"].includes(args[index] ?? "")) {
          index += 2;
        }
        const labels: Record<string, Action> = {
          create: "kubernetes-create",
          apply: "kubernetes-apply",
          wait: "kubernetes-wait",
          exec: "kubernetes-exec",
          label: "kubernetes-label",
          annotate: "kubernetes-annotate",
          delete: "kubernetes-delete",
        };
        const verb = args[index] ?? "";
        action = Object.hasOwn(labels, verb) ? labels[verb]! : "kubernetes-read";
      }
    }
    operations.begin(action);
    commandCount++;
    return operations.command(executable, args, {
      env: cleanEnvironment({
        PATH: environment.PATH!,
        HOME: directory,
        LANG: "C.UTF-8",
        HELM_CACHE_HOME: join(directory, "helm-cache"),
        HELM_CONFIG_HOME: join(directory, "helm-config"),
        HELM_DATA_HOME: join(directory, "helm-data"),
      }),
      timeout: 330000,
      ...options,
    });
  };
  const kubectl = (...args: string[]) =>
    run("kubectl", [
      "--kubeconfig",
      selection.kubeconfigPath!,
      "--context",
      selection.kubernetesContext!,
      ...args,
    ]);
  const kubernetes = createKubernetesClient({
    selection,
    kubectl,
    waitTimeoutMs: 180000,
    waitIntervalMs: 1000,
    onWaitTimeout: () => {
      throw new QualificationFailure("timeout");
    },
  });
  const apply = (obj: unknown) =>
    run("kubectl", kubernetes.kubectlArguments(["create", "-f", "-"]), {
      input: JSON.stringify(obj),
      ...(typeof obj === "object" && obj !== null && "kind" in obj && obj.kind === "Namespace"
        ? { action: "namespace-create" as const }
        : {}),
    });
  const replace = (obj: unknown) =>
    run("kubectl", kubernetes.kubectlArguments(["apply", "-f", "-"]), {
      input: JSON.stringify(obj),
    });
  const get = (kind: string, name: string, ns = system) =>
    kubernetes.resource(kind, name, ns || undefined);
  const helm = (...args: string[]) =>
    run("helm", [
      ...args,
      "-n",
      system,
      "--kubeconfig",
      selection.kubeconfigPath!,
      "--kube-context",
      selection.kubernetesContext!,
    ]);
  const observations: Record<string, unknown>[] = [];
  const record = (name: string, details: Record<string, unknown> = {}) => {
    observations.push({ case: name, ...details });
  };
  try {
    stage = "fresh-release-setup";
    const packageChart = async (revision: string, tree: string, name: string) => {
      assert.equal(
        (await run("git", ["rev-parse", `${revision}:deploy/helm/openclaw-enterprise`])).trim(),
        tree,
      );
      const root = join(directory, name);
      await local("local-setup", () => mkdir(root, { mode: 0o700 }));
      const archive = join(root, "source.tar");
      await run("git", ["archive", "--format=tar", `--output=${archive}`, tree]);
      const source = join(root, "chart");
      await local("local-setup", () => mkdir(source, { mode: 0o700 }));
      await run("tar", ["-xf", archive, "-C", source]);
      await run("helm", ["package", source, "--destination", root]);
      return join(root, "openclaw-enterprise-0.1.0.tgz");
    };
    const oldChart = await packageChart(
      "42599c019f1b286a87ed984cd3e2d57a266ee03e",
      "79615bf41c18adf0a7f88f3cd20c5b01a51b0b26",
      "old",
    );
    const chart = await packageChart(
      "3071689b3a0fff27441a66f7968bc16024c3e7e0",
      "b9d49361beafc193b5a6d6b38895ff8b9564eb86",
      "candidate",
    );
    const chartSha256 = createHash("sha256")
      .update(await local("local-setup", () => readFile(chart)))
      .digest("hex");
    const oldChartSha256 = createHash("sha256")
      .update(await local("local-setup", () => readFile(oldChart)))
      .digest("hex");
    assert.notEqual(oldChartSha256, chartSha256);

    await apply({
      apiVersion: "v1",
      kind: "Namespace",
      metadata: { name: system, labels: { "oce-test": suffix } },
    });
    await apply({
      apiVersion: "gateway.networking.k8s.io/v1",
      kind: "GatewayClass",
      metadata: { name: gatewayClass, labels: { "oce-test": suffix } },
      spec: { controllerName: "gateway.envoyproxy.io/gatewayclass-controller" },
    });
    const secret = () => {
      operations.begin("local-setup");
      try {
        const value = randomBytes(32).toString("hex");
        t.signal.throwIfAborted();
        return value;
      } catch {
        throw new QualificationFailure(t.signal.aborted ? "cancelled" : "local-setup");
      }
    };
    const createSecret = (name: string, stringData: Record<string, string>) =>
      apply({
        apiVersion: "v1",
        kind: "Secret",
        metadata: { name, namespace: system },
        stringData,
      });
    await createSecret("bound-gateway-key", { occ: secret() });
    const gatewayName = release + "-agent-gateways";
    const routing = {
      gatewayName,
      gatewayNamespace: system,
      envoyNamespace: environment.OCC_TEST_ENVOY_GATEWAY_NAMESPACE!,
    };
    const configuration = createInitialInstallationConfiguration({
      system,
      gatewayName,
      envoyNamespace: routing.envoyNamespace,
      runtimeImage: images.runtime,
      cluster: "bound-" + suffix,
    });
    const gatewayRouting = {
      enabled: true,
      gatewayClassName: gatewayClass,
      gatewayName,
      envoyNamespace: routing.envoyNamespace,
      apiKeySecretName: "bound-gateway-key",
      serviceType: "ClusterIP",
    };
    const { adminEmail } = await installProductionHelmControlPlane({
      selection,
      chart: oldChart,
      diagnoseFailure: false,
      repositoryCredentials: undefined,
      controlPlane: undefined,
      executionCluster: undefined,
      metrics: undefined,
      images,
      namespace: system,
      release,
      directory,
      suffix,
      configuration,
      authBaseURL: origin,
      installationName: "Bound login fixture",
      apiClients: [{ namespace: system, podLabels: { app: "bound-operator" } }],
      gatewayRouting,
      run,
      kubernetes,
      prepareLocal,
      createSecretValue: secret,
      record: async () => {},
    });
    const values: Record<string, unknown> = await local("local-setup", async () =>
      JSON.parse(await readFile(join(directory, "values.json"), "utf8")),
    );
    const ca = await certificateAuthority(directory, {
      run,
      caName: "Bound login fixture",
      caKeyPem: undefined,
    });
    const leaf = await signedLeaf(directory, ca, {
      run,
      prepareLocal,
      name: "peer",
      keyPem: undefined,
      commonName: "github.com",
      subjectAltName: `DNS:github.com,DNS:api.github.com,DNS:localhost,DNS:${consoleHost},DNS:openclaw-enterprise-egress-authority.${system}.svc`,
    });
    const caPem = await local("local-setup", () => readFile(ca.caPath, "utf8"));
    const fixtureDir = resolve("tests/fixtures/bound-login");
    const scripts: Record<string, string> = {};
    for (const name of [
      "browser.ts",
      "failure.ts",
      "operator.ts",
      "rpc.ts",
      "peer.ts",
      "peer-health.ts",
      "merge-ca.ts",
      "verify-transport.ts",
      "native-gateway-probe.ts",
    ]) {
      scripts[name] = await local("local-setup", () => readFile(join(fixtureDir, name), "utf8"));
    }
    await apply({
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name: "bound-login-scripts", namespace: system },
      immutable: true,
      data: scripts,
    });
    await apply({
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name: "bound-login-ca", namespace: system },
      immutable: true,
      data: { "ca.crt": caPem },
    });
    const clientId = "bound-private";
    const clientSecret = secret();
    await createSecret("bound-login-peer", {
      "tls.crt": leaf.cert,
      "tls.key": leaf.key,
      "config.json": JSON.stringify({
        origin,
        clientId,
        clientSecret,
        subjects: { member: 1001, outsider: 1002 },
      }),
    });
    await createSecret("occ-github-login", {
      "client-id": clientId,
      "client-secret": clientSecret,
    });
    const secure = {
      runAsNonRoot: true,
      runAsUser: 1000,
      runAsGroup: 1000,
      fsGroup: 1000,
      seccompProfile: { type: "RuntimeDefault" },
    };
    await apply({
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        name: "bound-operator",
        namespace: system,
        labels: { app: "bound-operator" },
      },
      spec: {
        automountServiceAccountToken: false,
        securityContext: secure,
        containers: [
          {
            name: "node",
            image: images.node,
            command: ["node", "/bound-login-scripts/operator.ts"],
            env: [
              {
                name: "BOUND_LOGIN_API_SERVICE",
                value: `openclaw-enterprise-api.${system}.svc`,
              },
              { name: "NODE_EXTRA_CA_CERTS", value: "/bound-login-ca/ca.crt" },
              { name: "BOUND_LOGIN_HEALTH_PORTS", value: "38443,39084" },
            ],
            securityContext: {
              allowPrivilegeEscalation: false,
              readOnlyRootFilesystem: true,
              capabilities: { drop: ["ALL"] },
            },
            readinessProbe: {
              exec: {
                command: ["node", "/bound-login-scripts/peer-health.ts"],
              },
            },
            volumeMounts: [
              {
                name: "scripts",
                mountPath: "/bound-login-scripts",
                readOnly: true,
              },
              {
                name: "private",
                mountPath: "/bound-login-private",
                readOnly: true,
              },
              { name: "ca", mountPath: "/bound-login-ca", readOnly: true },
              { name: "bootstrap", mountPath: "/bootstrap", readOnly: true },
            ],
          },
        ],
        volumes: [
          { name: "scripts", configMap: { name: "bound-login-scripts" } },
          { name: "private", secret: { secretName: "bound-login-peer" } },
          { name: "ca", configMap: { name: "bound-login-ca" } },
          {
            name: "bootstrap",
            persistentVolumeClaim: { claimName: "bootstrap-password" },
          },
        ],
      },
    });
    await apply({
      apiVersion: "v1",
      kind: "Service",
      metadata: { name: "bound-console", namespace: system },
      spec: {
        type: "ClusterIP",
        selector: { app: "bound-operator" },
        ports: [{ name: "https", port: 38443, targetPort: 38443, protocol: "TCP" }],
      },
    });
    await apply({
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: { name: "bound-console", namespace: system },
      spec: {
        podSelector: { matchLabels: { app: "bound-operator" } },
        policyTypes: ["Ingress", "Egress"],
        ingress: [
          {
            from: [{ podSelector: { matchLabels: { app: "bound-operator" } } }],
            ports: [{ protocol: "TCP", port: 38443 }],
          },
        ],
        egress: [
          {
            to: [{ podSelector: { matchLabels: { app: "bound-operator" } } }],
            ports: [{ protocol: "TCP", port: 38443 }],
          },
          {
            to: [
              {
                podSelector: {
                  matchLabels: {
                    "app.kubernetes.io/instance": release,
                    "app.kubernetes.io/component": "api",
                  },
                },
              },
            ],
            ports: [{ protocol: "TCP", port: 8080 }],
          },
          {
            to: [
              {
                namespaceSelector: {
                  matchLabels: { "kubernetes.io/metadata.name": "kube-system" },
                },
                podSelector: { matchLabels: { "k8s-app": "kube-dns" } },
              },
            ],
            ports: [
              { protocol: "UDP", port: 53 },
              { protocol: "TCP", port: 53 },
            ],
          },
        ],
      },
    });
    await kubectl(
      "-n",
      system,
      "wait",
      "--for=condition=Ready",
      "pod/bound-operator",
      "--timeout=180s",
    );
    const rpc = async (
      input: unknown,
      pod = "bound-operator",
      container = "node",
      target = "operator",
      action?: Action,
    ) => {
      const inputAction =
        typeof input === "object" && input !== null && "action" in input ? input.action : undefined;
      let actionLabel: Action = "console-mutate";
      if (target === "peer") {
        actionLabel = "peer-authorize";
      } else if (inputAction === "new") {
        actionLabel = "browser-new";
      } else if (inputAction === "freeze") {
        actionLabel = "browser-freeze";
      } else if (inputAction === "pin") {
        actionLabel = "browser-pin";
      } else if (inputAction === "bootstrap") {
        actionLabel = "browser-bootstrap";
      } else if (
        typeof input === "object" &&
        input !== null &&
        "method" in input &&
        input.method === "GET"
      ) {
        actionLabel = "console-read";
      }
      const out = await run(
        "kubectl",
        kubernetes.kubectlArguments([
          "-n",
          system,
          "exec",
          "-i",
          pod,
          "-c",
          container,
          "--",
          "node",
          "/bound-login-scripts/rpc.ts",
          target,
        ]),
        { input: JSON.stringify(input), action: action ?? actionLabel, boundRpc: true },
      );
      let shape: "authorization" | "ack" | "response" = "response";
      if (target === "peer") {
        shape = "authorization";
      } else if (["new", "freeze", "pin"].includes(String(inputAction))) {
        shape = "ack";
      }
      return operations.reply(out, shape);
    };
    const fresh = async (name: string) => {
      await rpc({ action: "new", browser: name });
    };
    type ResponseData = Awaited<ReturnType<typeof rpc>>["data"];
    const request = async (
      browser: string,
      method: string,
      path: string,
      body?: unknown,
      status = 200,
      validate?: (data: ResponseData) => unknown,
    ) => {
      const result = await rpc({
        action: "request",
        browser,
        method,
        path,
        body,
      });
      const data = operations.validateResponse(result, status, () => {
        const data = result.data;
        if (status === 200 || status === 201) {
          const text = (value: unknown) => typeof value === "string" && value.length > 0;
          if (path === "/api/auth/session") {
            assert.ok(
              data === null ||
                (data?.authenticated === true &&
                  text(data?.user?.id) &&
                  text(data?.user?.email) &&
                  text(data?.user?.name) &&
                  typeof data?.sessionKey === "string" &&
                  /^[A-Za-z0-9_-]{43}$/.test(data.sessionKey)),
            );
          } else {
            const list =
              method === "GET" && /\/(presets|iam\/roles|iam\/access-bindings)$/.test(path);
            assert.ok(data && typeof data === "object" && (list || !Array.isArray(data)));
            if (path === "/api/auth/sign-in/email") {
              assert.equal(data.authenticated, true);
            } else if (path.endsWith("/providers/github/start")) {
              assert.ok(text(data.url) && text(data.attemptId));
            } else if (path.endsWith("/providers/github/result")) {
              assert.match(data.sessionKey, /^[A-Za-z0-9_-]{43}$/);
            } else if (path === "/api/auth/recovery") {
              assert.ok(text(data.userId) && text(data.principalId) && text(data.methodId));
            } else if (path === "/installation") {
              assert.ok(text(data.id));
            } else if (path === "/api/auth/accounts") {
              assert.ok(text(data.id) && text(data.principalId) && text(data.email));
              assert.equal(data.email, (body as { email: string }).email);
            } else if (path.startsWith("/api/auth/accounts/")) {
              if (method === "POST") {
                assert.equal(data.userId, path.split("/")[4]);
              } else {
                assert.equal(data.userId, path.split("/")[4]);
                assert.ok(
                  text(data.principalId) &&
                    Number.isSafeInteger(data.version) &&
                    data.version >= 1 &&
                    data.version <= 2147483647 &&
                    typeof data.disabled === "boolean" &&
                    Array.isArray(data.methods) &&
                    data.methods.every(
                      (
                        method: {
                          methodId?: unknown;
                          providerId?: unknown;
                          subject?: unknown;
                        } | null,
                      ) =>
                        text(method?.methodId) && text(method?.providerId) && text(method?.subject),
                    ),
                );
              }
            } else if (
              method === "GET" &&
              /\/(presets|iam\/roles|iam\/access-bindings)$/.test(path)
            ) {
              assert.ok(Array.isArray(data));
              assert.ok(data.every((entry: { id?: unknown }) => text(entry.id)));
            } else if (method === "POST" && path.endsWith("/iam/roles")) {
              assert.ok(text(data.id));
              assert.equal(data.namespaceId, path.split("/")[2]);
              const permissionTuples = (permissions: { action: string; resourceKind: string }[]) =>
                permissions
                  .map(({ action, resourceKind }) => [action, resourceKind] as const)
                  .sort(
                    ([leftAction, leftKind], [rightAction, rightKind]) =>
                      leftAction.localeCompare(rightAction) || leftKind.localeCompare(rightKind),
                  );
              assert.ok(Array.isArray(data.permissions));
              assert.deepEqual(
                permissionTuples(data.permissions),
                permissionTuples(
                  (body as { permissions: { action: string; resourceKind: string }[] }).permissions,
                ),
              );
            } else if (method === "POST" && path.endsWith("/iam/access-bindings")) {
              assert.ok(text(data.id));
              assert.equal(data.namespaceId, path.split("/")[2]);
              for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
                assert.deepEqual(data[key], value);
              }
            } else if (path.startsWith("/namespaces")) {
              assert.ok(text(data.id));
              if (method === "GET" && /^\/namespaces\/[^/]+$/.test(path)) {
                assert.equal(data.id, path.split("/")[2]);
                assert.ok(["provisioning", "ready", "failed", "deleting"].includes(data.status));
              }
            }
          }
        }
        return data;
      });
      return validate
        ? operations.validateResponse(result, status, () => validate(data), "assertion")
        : data;
    };
    const read = <T>(
      browser: string,
      path: string,
      validate: (data: ResponseData) => T,
    ): Promise<T> => request(browser, "GET", path, undefined, 200, validate);
    const bootstrap = async (name: string, expectedUserId?: string) => {
      await fresh(name);
      const r = await rpc({
        action: "bootstrap",
        browser: name,
        email: adminEmail,
      });
      operations.validateResponse(
        r,
        200,
        () => {
          if (typeof r.data?.authenticated !== "boolean") {
            throw new QualificationFailure("malformed-response");
          }
          assert.equal(r.data.authenticated, true);
        },
        "assertion",
      );
      const session = await read(name, "/api/auth/session", (data) => {
        assert.ok(
          data.user.id,
          "Bootstrap must resolve an authenticated session before any mutation",
        );
        assert.equal(data.user.email, adminEmail);
        if (expectedUserId !== undefined) {
          assert.equal(data.user.id, expectedUserId);
        }
        return data;
      });
      return session;
    };
    const admin = await bootstrap("recovery");
    const namespace = await request(
      "recovery",
      "POST",
      "/namespaces",
      { name: "Bound fixture" },
      201,
    );
    const tenant = "oce-" + hash(namespace.id).slice(0, 15);
    const validatePhysicalNamespace = (
      observed: ResponseData,
      expectedUid?: string,
      expectedLifecycle?: "preprovisioned",
    ) => {
      assert.equal(observed?.apiVersion, "v1");
      assert.equal(observed?.kind, "Namespace");
      assert.equal(observed.status?.phase, "Active");
      const metadata = observed.metadata;
      assert.equal(metadata?.name, tenant);
      assert.equal(metadata.annotations?.["openclaw.dev/namespace-id"], namespace.id);
      assert.equal(metadata.annotations?.["openclaw.dev/namespace-lifecycle"], expectedLifecycle);
      assert.equal(metadata.labels?.["app.kubernetes.io/managed-by"], "openclaw-enterprise");
      assert.equal(metadata.labels?.["openclaw.dev/namespace"], namespace.id);
      assert.equal(metadata.labels?.["openclaw.dev/gateway-namespace"], namespace.id);
      assert.equal(
        metadata.labels?.["openclaw-enterprise.io/gateway"],
        hash(system + "/" + gatewayName).slice(0, 12),
      );
      assert.equal(metadata.deletionTimestamp, undefined);
      assert.match(metadata.uid, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
      if (expectedUid !== undefined) {
        assert.equal(metadata.uid, expectedUid);
      }
      return metadata.uid as string;
    };
    const firstUid = await kubernetes.waitFor("owned tenant namespace", async () => {
      const observed = await kubectl(
        "get",
        "namespace",
        tenant,
        "--ignore-not-found",
        "-o",
        "json",
      );
      if (observed.length === 0) {
        return false;
      }
      return validatePhysicalNamespace(JSON.parse(observed));
    });
    // Normal initial enrollment: the worker creates the real namespace; operator grants its scoped roles.
    for (const [name, role, account] of [
      ["worker", "worker", "worker"],
      ["configuration", "configuration", "api"],
      ["secrets", "api", "api"],
    ]) {
      await apply({
        apiVersion: "rbac.authorization.k8s.io/v1",
        kind: "RoleBinding",
        metadata: { name, namespace: tenant },
        roleRef: {
          apiGroup: "rbac.authorization.k8s.io",
          kind: "ClusterRole",
          name: `${release}-openclaw-tenant-${role}`,
        },
        subjects: [
          {
            kind: "ServiceAccount",
            name: `openclaw-enterprise-${account}`,
            namespace: system,
          },
        ],
      });
    }
    await kubernetes.waitFor("normal Namespace ready", async () =>
      read("recovery", `/namespaces/${namespace.id}`, (data) => {
        assert.ok(data.status === "ready" || data.status === "provisioning");
        return data.status === "ready";
      }),
    );
    stage = "real-openshell-and-bound-baseline";
    const shellName = "openshell-" + hash(tenant).slice(0, 10);
    const nativeHost = `${shellName}.${tenant}.svc`;
    const nativeSubject = `bound-controller-${suffix}`;
    const gatewayLeaf = await signedLeaf(directory, ca, {
      run,
      prepareLocal,
      name: "gateway-server",
      keyPem: undefined,
      commonName: nativeHost,
      subjectAltName: `DNS:${nativeHost},DNS:${nativeHost}.cluster.local`,
    });
    const clientLeaf = await signedLeaf(directory, ca, {
      run,
      prepareLocal,
      name: "gateway-client",
      keyPem: undefined,
      commonName: nativeSubject,
      usage: "clientAuth",
      subjectAltName: undefined,
    });
    const peerLeaf = await signedLeaf(directory, ca, {
      run,
      prepareLocal,
      name: "gateway-peer",
      keyPem: undefined,
      commonName: `bound-peer-${suffix}`,
      usage: "clientAuth",
      subjectAltName: undefined,
    });
    await apply({
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: "bound-openshell-peer", namespace: tenant },
      stringData: { "ca.crt": caPem, "tls.crt": peerLeaf.cert, "tls.key": peerLeaf.key },
    });
    const clientData = { "ca.crt": caPem, "tls.crt": clientLeaf.cert, "tls.key": clientLeaf.key };
    await createSecret("bound-openshell-client", clientData);
    await apply({
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: "bound-openshell-ca", namespace: tenant },
      stringData: { "ca.crt": caPem },
    });
    await apply({
      apiVersion: "v1",
      kind: "Secret",
      type: "kubernetes.io/tls",
      metadata: { name: "bound-openshell-tls", namespace: tenant },
      stringData: { "tls.crt": gatewayLeaf.cert, "tls.key": gatewayLeaf.key },
    });
    stage = "native-installation";
    await installNativeGateway({
      namespace: tenant,
      directory,
      environment,
      run,
      ca: caPem,
      tls: {
        serverSecretName: "bound-openshell-tls",
        clientCaSecretName: "bound-openshell-ca",
        clientTlsSecretName: "bound-openshell-peer",
      },
    });
    const nativeWorkload = await get("statefulset", shellName, tenant);
    assert.equal(nativeWorkload.metadata.labels["app.kubernetes.io/version"], "0.1.5");
    const nativeImage = (image: string) => image.replace(/:[^/:@]+(?=@sha256:)/, "");
    assert.equal(
      nativeWorkload.spec.template.spec.containers.find(
        (container: { name: string }) => container.name === "openshell-gateway",
      )?.image,
      nativeImage(images.openShellGateway),
    );
    const nativeVolumes = nativeWorkload.spec.template.spec.volumes;
    for (const [name, secretName] of [
      ["tls-cert", "bound-openshell-tls"],
      ["tls-client-ca", "bound-openshell-ca"],
      ["peer-client-tls", "bound-openshell-peer"],
    ]) {
      assert.equal(
        nativeVolumes.find((v: { name: string }) => v.name === name)?.secret?.secretName,
        secretName,
      );
    }
    assert.deepEqual(Object.keys((await get("secret", "bound-openshell-ca", tenant)).data), [
      "ca.crt",
    ]);
    const nativeConfig = (await get("configmap", shellName + "-config", tenant)).data[
      "gateway.toml"
    ];
    for (const [key, image] of [
      ["sandbox_runtime_image", images.openShellSandbox],
      ["supervisor_image", images.openShellSupervisor],
    ] as const) {
      const match = nativeConfig.match(new RegExp(`^\\s*${key}\\s*=\\s*("[^"\\n]+")\\s*$`, "m"));
      assert.equal(match?.[1], JSON.stringify(nativeImage(image)));
    }
    assert.match(nativeConfig, /disable_tls = false/);
    assert.match(nativeConfig, /enable_loopback_service_http = false/);
    assert.match(nativeConfig, /mtls_auth = \{ enabled = true, operator_enabled = false \}/);
    assert.match(nativeConfig, /auth = \{ allow_unauthenticated_users = false \}/);
    assert.match(
      nativeConfig,
      /\[openshell\.drivers\.kubernetes\.resource_admission\]\s+enabled = true/,
    );
    const apiPeers = [
      {
        namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": system } },
        podSelector: {
          matchLabels: { "app.kubernetes.io/instance": release },
          matchExpressions: [
            { key: "app.kubernetes.io/component", operator: "In", values: ["api", "worker"] },
          ],
        },
      },
    ];
    await apply({
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: { name: "bound-openshell-api", namespace: tenant },
      spec: {
        podSelector: { matchLabels: { "app.kubernetes.io/instance": shellName } },
        policyTypes: ["Ingress"],
        ingress: [{ from: apiPeers, ports: [{ protocol: "TCP", port: 8080 }] }],
      },
    });
    await apply({
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: { name: "bound-openshell-egress", namespace: system },
      spec: {
        podSelector: apiPeers[0]!.podSelector,
        policyTypes: ["Egress"],
        egress: [
          {
            to: [
              {
                namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": tenant } },
                podSelector: { matchLabels: { "app.kubernetes.io/instance": shellName } },
              },
            ],
            ports: [{ protocol: "TCP", port: 8080 }],
          },
        ],
      },
    });
    await apply({
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name: "bound-native-probe", namespace: tenant },
      immutable: true,
      data: { "native-gateway-probe.ts": scripts["native-gateway-probe.ts"] },
    });
    // Only DNS is added here. Direct 8080 access must use the stock helper's
    // existing same-namespace supervisor-labelled ingress/egress route.
    await apply({
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: { name: "bound-native-probe-dns", namespace: tenant },
      spec: {
        podSelector: { matchLabels: { app: "bound-native-probe" } },
        policyTypes: ["Egress"],
        egress: [
          {
            to: [
              {
                namespaceSelector: {
                  matchLabels: { "kubernetes.io/metadata.name": "kube-system" },
                },
                podSelector: { matchLabels: { "k8s-app": "kube-dns" } },
              },
            ],
            ports: [
              { protocol: "UDP", port: 53 },
              { protocol: "TCP", port: 53 },
            ],
          },
        ],
      },
    });
    await apply({
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        name: "bound-native-probe",
        namespace: tenant,
        labels: { app: "bound-native-probe", ...openShellSupervisorLabels },
      },
      spec: {
        automountServiceAccountToken: false,
        securityContext: secure,
        containers: [
          {
            name: "probe",
            image: images.node,
            command: ["node", "-e", "setInterval(() => {}, 1000)"],
            securityContext: {
              allowPrivilegeEscalation: false,
              readOnlyRootFilesystem: true,
              capabilities: { drop: ["ALL"] },
            },
            volumeMounts: [
              { name: "private", mountPath: "/bound-openshell", readOnly: true },
              { name: "code", mountPath: "/bound-login-scripts", readOnly: true },
            ],
          },
        ],
        volumes: [
          {
            name: "private",
            secret: {
              secretName: "bound-openshell-ca",
              items: [{ key: "ca.crt", path: "ca.crt" }],
            },
          },
          { name: "code", configMap: { name: "bound-native-probe" } },
        ],
      },
    });
    await kubectl(
      "-n",
      tenant,
      "wait",
      "--for=condition=Ready",
      "pod/bound-native-probe",
      "--timeout=180s",
    );
    const probeNativeGateway = async (
      ns: string,
      pod: string,
      container: string,
      owner: boolean,
    ) => {
      const expectedNativeProof = {
        nativeIdentityVerified: owner,
        anonymousRpcDenied: true,
        plaintextDenied: true,
        nonOperatorUserIdentity: owner,
      };
      const proof = JSON.parse(
        await kubectl(
          "-n",
          ns,
          "exec",
          pod,
          "-c",
          container,
          "--",
          "node",
          "/bound-login-scripts/native-gateway-probe.ts",
          nativeHost,
          nativeSubject,
          owner ? "owner" : "negative",
        ),
      );
      assert.deepEqual(proof, expectedNativeProof);
      return proof;
    };
    const supervisorNativeProof = await probeNativeGateway(
      tenant,
      "bound-native-probe",
      "probe",
      false,
    );
    const issuerPublic = Buffer.from(
      await kubectl(
        "-n",
        tenant,
        "get",
        "secret",
        shellName + "-jwt-keys",
        "-o",
        "jsonpath={.data.public\\.pem}",
      ),
      "base64",
    ).toString();
    const issuerKid = Buffer.from(
      await kubectl(
        "-n",
        tenant,
        "get",
        "secret",
        shellName + "-jwt-keys",
        "-o",
        "jsonpath={.data.kid}",
      ),
      "base64",
    )
      .toString()
      .trim();
    stage = "bound-namespace-binding";
    bindInstallationConfiguration(configuration, {
      tenant,
      shellName,
      runtimeClass: environment.OCC_TEST_OPENSHELL_RUNTIME_CLASS!,
      issuerKid,
    });
    await createSecret("bound-egress-tls", {
      "tls.crt": leaf.cert,
      "tls.key": leaf.key,
    });
    await createSecret("bound-egress-issuer", { "public.pem": issuerPublic });
    await replace({
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: "occ-installation-startup", namespace: system },
      stringData: { "installation.yaml": JSON.stringify(configuration) },
    });
    const observed = await get("namespace", tenant, "");
    assert.ok(firstUid);
    const uid = validatePhysicalNamespace(observed, firstUid);
    await kubectl(
      "annotate",
      "namespace",
      tenant,
      "openclaw.dev/namespace-lifecycle=preprovisioned",
      "--overwrite",
    );
    assert.equal(
      observed.metadata.labels["openclaw-enterprise.io/gateway"],
      hash(system + "/" + gatewayName).slice(0, 12),
    );
    const initialJob = await get("job", release + "-initialization");
    assert.equal(initialJob.status.succeeded, 1);
    await kubectl("-n", system, "delete", "job", release + "-initialization", "--wait=true");
    values.preprovisionedNamespace = { namespaceId: namespace.id, uid };
    values.egressAuthority = {
      enabled: true,
      port: 9444,
      tlsSecretName: "bound-egress-tls",
      issuerSecretName: "bound-egress-issuer",
      clients: [
        {
          namespaceSelector: {
            matchLabels: { "kubernetes.io/metadata.name": tenant },
          },
          podSelector: {
            matchLabels: { "app.kubernetes.io/instance": shellName },
          },
        },
      ],
    };
    values.controlPlane = {
      installationChecksum: hash(JSON.stringify(configuration)),
    };
    const renderer = join(fixtureDir, "post-renderer.ts");
    const transport = join(directory, "transport.json");
    const transportSettings = {
      namespace: system,
      controllerImage: images.controller,
      peerImage: images.node,
      kubernetesServiceIP: (await get("service", "kubernetes", "default")).spec.clusterIP,
      github: false,
    };
    await local("local-setup", () => writeFile(transport, JSON.stringify(transportSettings)));
    const valuePath = join(directory, "bound-values.json");
    await local("local-setup", () => writeFile(valuePath, JSON.stringify(values), { mode: 0o600 }));
    await helm(
      "upgrade",
      release,
      oldChart,
      "-f",
      valuePath,
      "--post-renderer",
      renderer,
      "--post-renderer-args",
      transport,
      "--wait",
      "--timeout",
      "300s",
    );
    type Owner = {
      kind: string;
      name: string;
      uid: string;
      controller?: boolean;
    };
    const currentPod = async (component: string) =>
      kubernetes.waitFor("current " + component, async () => {
        const deployment = await get("deployment", "openclaw-enterprise-" + component);
        const revision = deployment.metadata.annotations?.["deployment.kubernetes.io/revision"];
        if (
          !/^[1-9][0-9]*$/.test(revision ?? "") ||
          !(deployment.status.observedGeneration >= deployment.metadata.generation) ||
          deployment.spec.replicas !== 1 ||
          deployment.status.replicas !== 1 ||
          deployment.status.updatedReplicas !== 1 ||
          deployment.status.readyReplicas !== 1 ||
          deployment.status.availableReplicas !== 1
        ) {
          return false;
        }
        const selector = `app.kubernetes.io/instance=${release},app.kubernetes.io/component=${component}`;
        const sets = await kubernetes.resources("replicasets", system, "-l", selector);
        const matches = sets.filter(
          (rs: typeof deployment) =>
            !rs.metadata.deletionTimestamp &&
            rs.metadata.annotations?.["deployment.kubernetes.io/revision"] === revision &&
            rs.metadata.ownerReferences?.some(
              (r: Owner) =>
                r.kind === "Deployment" &&
                r.controller &&
                r.name === deployment.metadata.name &&
                r.uid === deployment.metadata.uid,
            ),
        );
        if (matches.length !== 1) {
          return false;
        }
        const rs = matches[0]!;
        const template = structuredClone(rs.spec.template);
        delete template.metadata.labels["pod-template-hash"];
        if (!isDeepStrictEqual(template, deployment.spec.template)) {
          return false;
        }
        const pods = await kubernetes.resources("pods", system, "-l", selector);
        const ready = pods.filter(
          (p: typeof deployment) =>
            !p.metadata.deletionTimestamp &&
            p.metadata.labels?.["pod-template-hash"] ===
              rs.metadata.labels?.["pod-template-hash"] &&
            p.metadata.ownerReferences?.some(
              (r: Owner) =>
                r.kind === "ReplicaSet" &&
                r.controller &&
                r.name === rs.metadata.name &&
                r.uid === rs.metadata.uid,
            ) &&
            p.status.conditions?.some(
              (c: { type: string; status: string }) => c.type === "Ready" && c.status === "True",
            ),
        );
        if (ready.length !== 1) {
          return false;
        }
        const latest = await get("deployment", deployment.metadata.name);
        if (
          latest.metadata.uid !== deployment.metadata.uid ||
          latest.metadata.generation !== deployment.metadata.generation ||
          latest.metadata.annotations?.["deployment.kubernetes.io/revision"] !== revision
        ) {
          return false;
        }
        return { pod: ready[0]!, deployment, rs };
      });
    const observe = async (github: boolean) => {
      const history = JSON.parse(await helm("history", release, "--max", "1", "-o", "json"));
      assert.equal(history.length, 1);
      assert.equal(history[0].status, "deployed");
      const revision = Number(history[0].revision);
      const stored = JSON.parse(
        await helm("get", "values", release, "--revision", String(revision), "-o", "json"),
      );
      assert.deepEqual(stored.preprovisionedNamespace, {
        namespaceId: namespace.id,
        uid,
      });
      assert.equal(stored.images.controller, images.controller);
      const live = await get("namespace", tenant, "");
      validatePhysicalNamespace(live, uid, "preprovisioned");
      assert.equal(
        (
          await kubectl(
            "-n",
            system,
            "get",
            "job",
            release + "-initialization",
            "--ignore-not-found",
            "-o",
            "json",
          )
        ).trim(),
        "",
      );
      assert.equal(
        (await helm("get", "hooks", release, "--revision", String(revision))).trim(),
        "",
      );
      const continuity: Record<
        string,
        {
          deploymentUID: string;
          roleUID: string;
          bindingUID: string;
          imageID: string;
        }
      > = {};
      let workerTemplate: unknown;
      for (const component of ["api", "worker"]) {
        const role = await get(
          "clusterrole",
          release + "-openclaw-namespace-" + (component === "api" ? "observer" : "worker"),
          "",
        );
        assert.deepEqual(role.rules, [
          {
            apiGroups: [""],
            resources: ["namespaces"],
            resourceNames: [tenant],
            verbs: ["get"],
          },
          { nonResourceURLs: ["/version"], verbs: ["get"] },
        ]);
        const binding = await get(
          "clusterrolebinding",
          release + "-openclaw-" + component + "-namespaces",
          "",
        );
        assert.deepEqual(binding.roleRef, {
          apiGroup: "rbac.authorization.k8s.io",
          kind: "ClusterRole",
          name: role.metadata.name,
        });
        assert.deepEqual(binding.subjects, [
          {
            kind: "ServiceAccount",
            name: "openclaw-enterprise-" + component,
            namespace: system,
          },
        ]);
        const { pod, deployment, rs } = await currentPod(component);
        if (component === "worker") {
          workerTemplate = structuredClone(deployment.spec.template);
        }
        assert.equal(deployment.metadata.annotations["meta.helm.sh/release-name"], release);
        assert.equal(deployment.metadata.annotations["meta.helm.sh/release-namespace"], system);
        assert.equal(deployment.status.readyReplicas, 1);
        assert.ok(deployment.status.observedGeneration >= deployment.metadata.generation);
        const container = pod.spec.containers.find((c: { name: string }) => c.name === component);
        const status = pod.status.containerStatuses.find(
          (c: { name: string }) => c.name === component,
        );
        const rsRef = pod.metadata.ownerReferences.find(
          (r: { kind: string; controller?: boolean }) => r.kind === "ReplicaSet" && r.controller,
        );
        assert.ok(rsRef);
        assert.equal(rs.metadata.uid, rsRef.uid);
        assert.ok(
          rs.metadata.ownerReferences.some(
            (r: { uid: string; controller?: boolean }) =>
              r.uid === deployment.metadata.uid && r.controller,
          ),
        );
        assert.equal(container.image, images.controller);
        assert.ok(status.ready);
        assert.ok(
          status.imageID.endsWith(images.controller.slice(images.controller.indexOf("sha256:"))),
        );
        const env = Object.fromEntries(
          container.env.map((e: { name: string; value: string }) => [e.name, e.value]),
        );
        assert.deepEqual(JSON.parse(env.OCC_PREPROVISIONED_NAMESPACE), {
          namespaceId: namespace.id,
          uid,
        });
        if (component === "api") {
          assert.equal(env.OCC_AGENT_NATIVE_ADMIN_ENABLED, "false");
          if (github) {
            assert.equal(env.OCC_AUTH_GITHUB_ALLOWED_TEAMS, "bound-login-fixture/members");
            assert.equal(env.OCC_AUTH_PASSWORD_SIGN_IN, "recovery-only");
            assert.equal(env.OCC_AUTH_GITHUB_RECOVERY_USER_ID, admin.user.id);
            assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:39082");
          } else {
            assert.ok(!env.OCC_AUTH_GITHUB_CLIENT_ID);
          }
        }
        continuity[component] = {
          deploymentUID: deployment.metadata.uid,
          roleUID: role.metadata.uid,
          bindingUID: binding.metadata.uid,
          imageID: status.imageID,
        };
      }
      const tenantBindings = [];
      for (const name of ["worker", "configuration", "secrets"]) {
        const binding = await get("rolebinding", name, tenant);
        assert.ok(binding.metadata.uid);
        tenantBindings.push({
          name,
          uid: binding.metadata.uid,
          roleRef: binding.roleRef,
          subjects: binding.subjects,
        });
      }
      return { revision, uid, continuity, workerTemplate, tenantBindings };
    };
    const before = await observe(false);
    await bootstrap("recovery", admin.user.id);
    const password = secret();
    stage = "baseline-accounts";
    const member = await request(
      "recovery",
      "POST",
      "/api/auth/accounts",
      { name: "Member", email: `member-${suffix}@example.invalid`, password },
      201,
    );
    const outsider = await request(
      "recovery",
      "POST",
      "/api/auth/accounts",
      {
        name: "Outsider",
        email: `outsider-${suffix}@example.invalid`,
        password,
      },
      201,
    );
    assert.notEqual(member.id, outsider.id);
    assert.notEqual(member.principalId, outsider.principalId);
    const base = `/namespaces/${namespace.id}`;
    const presets = base + "/presets";
    const roles = base + "/iam/roles";
    const bindings = base + "/iam/access-bindings";
    stage = "baseline-grants";
    const role = await request(
      "recovery",
      "POST",
      roles,
      {
        name: "Narrow login fixture",
        permissions: [
          { action: "read", resourceKind: "namespace" },
          { action: "read", resourceKind: "preset" },
          { action: "delete", resourceKind: "preset" },
        ],
      },
      201,
    );
    const markers: { id: string }[] = [];
    for (const name of ["baseline", "member-effect", "denial-marker"]) {
      markers.push(
        await request("recovery", "POST", presets, { name: "Bound " + name, template: {} }, 201),
      );
    }
    for (const who of [member, outsider]) {
      for (const target of [
        { kind: "namespace", id: namespace.id },
        ...markers.map((p) => ({ kind: "preset", id: p.id })),
      ]) {
        await request(
          "recovery",
          "POST",
          bindings,
          {
            subjectKind: "identity",
            subjectId: who.principalId,
            roleId: role.id,
            resourceKind: target.kind,
            resourceId: target.id,
          },
          201,
        );
      }
    }
    await fresh("old-member");
    await request("old-member", "POST", "/api/auth/sign-in/email", {
      email: member.email,
      password,
    });
    await read("old-member", "/api/auth/session", (data) => assert.equal(data.user.id, member.id));
    await request("old-member", "GET", roles, undefined, 403);
    await request("old-member", "DELETE", presets + "/" + markers[0]!.id, undefined, 204);
    await request("recovery", "GET", "/api/auth/recovery", undefined, 409);
    await request("recovery", "GET", "/api/auth/accounts/" + member.id, undefined, 409);
    const original = {
      installation: await request("recovery", "GET", "/installation"),
      namespace: await read("recovery", base, (data) => {
        assert.equal(data.status, "ready");
        return data;
      }),
      roles: await request("recovery", "GET", roles),
      bindings: await request("recovery", "GET", bindings),
    };
    const marker = await request("recovery", "GET", presets + "/" + markers[2]!.id);
    record("closed-bound-baseline-and-narrow-member", {
      revision: before.revision,
      namespaceUIDSha256: hash(uid),
    });
    stage = "normal-auth-upgrade";
    assert.equal(
      createHash("sha256")
        .update(await local("local-setup", () => readFile(chart)))
        .digest("hex"),
      chartSha256,
    );
    const immediate = await observe(false);
    assert.deepEqual(immediate, before);
    await local("local-setup", () =>
      writeFile(transport, JSON.stringify({ ...transportSettings, github: true })),
    );
    const overlay = join(directory, "auth-overlay.json");
    await local("local-setup", () =>
      writeFile(
        overlay,
        JSON.stringify({
          auth: {
            github: {
              enabled: true,
              allowedTeams: ["bound-login-fixture/members"],
              allowedOrgs: [],
              egressCidrs: ["127.0.0.1/32"],
            },
            passwordSignIn: "recovery-only",
            recoveryUserId: admin.user.id,
          },
          agentNativeAdmin: { enabled: false },
        }),
      ),
    );
    await helm(
      "upgrade",
      release,
      chart,
      "--reuse-values",
      "-f",
      overlay,
      "--post-renderer",
      renderer,
      "--post-renderer-args",
      transport,
      "--wait",
      "--timeout",
      "300s",
    );
    const after = await observe(true);
    assert.equal(after.revision, before.revision + 1);
    assert.deepEqual(after.continuity, before.continuity);
    assert.deepEqual(after.tenantBindings, before.tenantBindings);
    // This pinned chart changes auth only on the API; retain all worker annotations.
    assert.deepEqual(after.workerTemplate, before.workerTemplate);
    const { pod: apiPod } = await currentPod("api");
    const apiNativeProof = await probeNativeGateway(system, apiPod.metadata.name, "api", true);
    const policy = await get("networkpolicy", "openclaw-enterprise-api-github-login-egress");
    assert.deepEqual(policy.spec.egress, []);
    const transportProof = JSON.parse(
      await run(
        "kubectl",
        kubernetes.kubectlArguments([
          "-n",
          system,
          "exec",
          apiPod.metadata.name,
          "-c",
          "api",
          "--",
          "node",
          "/bound-login-scripts/verify-transport.ts",
        ]),
      ),
    );
    assert.deepEqual(transportProof, {
      untrustedChainRejected: true,
      normalAuthorityVerified: true,
      foreignConnectRejected: true,
    });
    await read("old-member", "/api/auth/session", (data) => assert.equal(data, null));
    await read("recovery", "/api/auth/session", (data) => assert.equal(data, null));
    await bootstrap("recovery", admin.user.id);
    const readRecoveryDesignation = (browser: string, expected?: ResponseData) =>
      read(browser, "/api/auth/recovery", (data) => {
        assert.equal(data.userId, admin.user.id);
        if (expected !== undefined) {
          assert.deepEqual(data, expected);
        }
        return data;
      });
    const readRecoveryAccount = (
      browser: string,
      designation: ResponseData,
      expected?: ResponseData,
    ) =>
      read(browser, "/api/auth/accounts/" + admin.user.id, (data) => {
        // The verified password bootstrap qualifies the credential; this independent
        // account read ties its sole password and Principal to the designation.
        assert.equal(data.principalId, designation.principalId);
        assert.equal(data.disabled, false);
        const passwords = data.methods.filter(
          (method: { providerId: string }) => method.providerId === "credential",
        );
        assert.equal(passwords.length, 1);
        assert.equal(passwords[0].methodId, designation.methodId);
        assert.equal(passwords[0].subject, admin.user.id);
        if (expected !== undefined) {
          assert.equal(data.principalId, expected.principalId);
          assert.deepEqual(data.methods, expected.methods);
        }
        return data;
      });
    const designation = await readRecoveryDesignation("recovery");
    const recoveryAccount = await readRecoveryAccount("recovery", designation);
    for (const [who, subject] of [
      [member, 1001],
      [outsider, 1002],
    ] as const) {
      const path = "/api/auth/accounts/" + who.id;
      const account = await read("recovery", path, (data) => {
        assert.equal(data.principalId, who.principalId);
        assert.equal(data.disabled, false);
        assert.ok(
          !data.methods.some((m: { providerId: string }) => m.providerId.startsWith("github:")),
        );
        return data;
      });
      await request("recovery", "POST", path + "/providers/github", {
        subject: String(subject),
        expectedVersion: account.version,
      });
      await read("recovery", path, (data) => {
        assert.equal(data.principalId, who.principalId);
        assert.equal(data.version, account.version + 1);
        const attached = data.methods.filter((m: { providerId: string }) =>
          m.providerId.startsWith("github:"),
        );
        assert.equal(attached.length, 1);
        assert.equal(attached[0].subject, String(subject));
      });
    }

    const oauth = async (browser: string, login: string) => {
      await fresh(browser);
      const start = await request(browser, "POST", "/api/auth/providers/github/start");
      const authorized = await rpc(
        { url: start.url, login },
        apiPod.metadata.name,
        "bound-login-github-peer",
        "peer",
      );
      const callback = new URL(authorized.callback);
      assert.equal(callback.origin, origin);
      const response = await rpc(
        {
          action: "request",
          browser,
          method: "GET",
          path: callback.pathname + callback.search,
        },
        undefined,
        undefined,
        undefined,
        "oauth-callback",
      );
      operations.expectStatus(response.status, 302);
      return { response, attemptId: start.attemptId };
    };
    stage = "ordinary-member-callback";
    const allowed = await oauth("member", "member");
    operations.validateResponse(allowed.response, 302, () => {
      assert.equal(allowed.response.location, "/console/");
      requireHostSessionCookie(allowed.response);
    });
    const result = await request("member", "POST", "/api/auth/providers/github/result", {
      attemptId: allowed.attemptId,
    });
    const session = await read("member", "/api/auth/session", (data) => {
      assert.equal(data.user.id, member.id);
      return data;
    });
    // This compares two exchanges, rather than validating either response alone.
    assert.equal(result.sessionKey, session.sessionKey);
    await rpc({ action: "pin", browser: "member", key: result.sessionKey });
    await rpc({ action: "freeze", browser: "member", target: "frozen" });
    await request("frozen", "GET", roles, undefined, 403);
    await request("frozen", "DELETE", presets + "/" + markers[1]!.id, undefined, 204);
    await read("recovery", presets, (data) =>
      assert.ok(!data.some((p: { id: string }) => p.id === markers[1]!.id)),
    );
    await read("recovery", presets + "/" + markers[2]!.id, (data) =>
      assert.deepEqual(data, marker),
    );
    record("ordinary-member-console-result-session-key-and-tenant-delete", {
      sessionKeyMatched: true,
      sessionCookieClass: "host",
      pinned: true,
      deletedPresetIdSha256: hash(markers[1]!.id),
      retainedMarkerIdSha256: hash(marker.id),
      retainedMarkerSha256: hash(JSON.stringify(marker)),
    });
    stage = "outsider-callback";
    const denied = await oauth("outsider", "outsider");
    operations.validateResponse(denied.response, 302, () => {
      assert.equal(denied.response.sessionCookieIssued, false);
      assert.deepEqual(denied.response.sessionCookieClasses, []);
      assert.equal(
        new URL(denied.response.location, origin).searchParams.get("authReason"),
        "membership",
      );
    });
    await request(
      "outsider",
      "POST",
      "/api/auth/providers/github/result",
      { attemptId: denied.attemptId },
      401,
    );
    await read("outsider", "/api/auth/session", (data) => assert.equal(data, null));
    await request("outsider", "DELETE", presets + "/" + marker.id, undefined, 401);
    await read("recovery", presets + "/" + marker.id, (data) => assert.deepEqual(data, marker));
    record("attached-outsider-denied-unchanged-exact-marker", {
      markerIdSha256: hash(marker.id),
      sha256: hash(JSON.stringify(marker)),
      status: 401,
    });
    stage = "revoke-exact-session";
    const account = await read("recovery", "/api/auth/accounts/" + member.id, (data) => {
      assert.equal(data.principalId, member.principalId);
      assert.equal(data.disabled, false);
      const attached = data.methods.filter((m: { providerId: string }) =>
        m.providerId.startsWith("github:"),
      );
      assert.equal(attached.length, 1);
      assert.equal(attached[0].subject, "1001");
      return data;
    });
    await request("recovery", "POST", "/api/auth/accounts/" + member.id + "/revoke", {
      expectedVersion: account.version,
    });
    await request("frozen", "DELETE", presets + "/" + marker.id, undefined, 401);
    await read("recovery", presets + "/" + marker.id, (data) => assert.deepEqual(data, marker));
    record("revoked-cookie-and-key-denied-unchanged-exact-marker", {
      markerIdSha256: hash(marker.id),
      sha256: hash(JSON.stringify(marker)),
      status: 401,
    });
    await bootstrap("recovery-final", admin.user.id);
    await readRecoveryAccount("recovery-final", designation, recoveryAccount);
    for (const who of [member, outsider]) {
      await read("recovery-final", "/api/auth/accounts/" + who.id, (data) =>
        assert.equal(data.principalId, who.principalId),
      );
    }
    await readRecoveryDesignation("recovery-final", designation);
    await request("recovery-final", "DELETE", presets + "/" + marker.id, undefined, 204);
    await read("recovery-final", presets, (data) =>
      assert.ok(!data.some((p: { id: string }) => markers.some((m) => m.id === p.id))),
    );
    await read("recovery-final", "/installation", (data) =>
      assert.deepEqual(data, original.installation),
    );
    await read("recovery-final", base, (data) => assert.deepEqual(data, original.namespace));
    await read("recovery-final", roles, (data) => assert.deepEqual(data, original.roles));
    await read("recovery-final", bindings, (data) =>
      assert.deepEqual(
        data,
        original.bindings.filter(
          (b: { resourceId?: string }) => ![markers[1]!.id, marker.id].includes(b.resourceId),
        ),
      ),
    );
    assert.deepEqual(await observe(true), after);
    record("recovery-identities-role-grants-and-bound-namespace-retained");
    return {
      chartSha256,
      oldChartSha256,
      observations,
      beforeRevision: before.revision,
      afterRevision: after.revision,
      namespaceUIDSha256: hash(after.uid),
      continuitySha256: hash(JSON.stringify(after.continuity)),
      markerSha256: hash(JSON.stringify(marker)),
      controllerImageRefSha256: hash(images.controller),
      nativeGatewayProofSha256: hash(JSON.stringify({ supervisorNativeProof, apiNativeProof })),
    };
  } catch (error) {
    throw operations.reportFailure(error, stage, commandCount, (text) => t.diagnostic(text));
  }
}
