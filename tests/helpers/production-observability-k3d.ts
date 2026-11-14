import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { OpenClawConfigurationDocument } from "../../packages/contracts/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { run as runProcess } from "../fixtures/repository-credentials/process.mjs";
import { prepareObservabilityNativeRepository } from "./observability-native-repository.mjs";
import { createObservabilityCollector } from "./production-observability-collector.ts";
import { installProductionHelmControlPlane } from "./production-helm-real.mjs";
import {
  createHarnessConfiguration,
  withStubbedProviderEndpoint,
} from "./harness-configuration.mjs";
import {
  createKubernetesClient,
  createKubernetesInstallationConfiguration,
  explicitK3dSelection,
  kubectlArguments,
  validateExplicitK3dLoopbackContext,
} from "./kubernetes-real.mjs";

type CommandOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string | Buffer | undefined;
  timeout?: number;
  signal?: AbortSignal;
};

type Images = {
  controller: string;
  postgres: string;
  node: string;
  runtime: string;
  codex?: string;
  collector?: string;
  credentials?: string;
};

type Labels = Record<string, string>;
type KubernetesClient = {
  resource(kind: string, name: string, namespace?: string): Promise<unknown>;
  resources(kind: string, namespace: string, ...args: string[]): Promise<unknown>;
  waitFor<T>(
    description: string | (() => string),
    probe: () => Promise<T | false | undefined>,
    timeoutMs?: number,
  ): Promise<T>;
};

type InstallationOptions = {
  modelTurns?: boolean;
  nativeRepository?: boolean;
};

type HarnessConfiguration = OpenClawConfigurationDocument & {
  agents: { defaults: OpenClawConfigurationDocument };
};

// The JavaScript runner infers its default environment's exact allowlist.
const runCommand = runProcess as (
  command: string,
  args: string[],
  options: CommandOptions & { allowFailure: boolean },
) => Promise<unknown>;

function importedImage(variable: string): string {
  const image = process.env[variable] ?? "";
  assert.match(
    image,
    /^\S+@sha256:[a-f0-9]{64}$/,
    `${variable} requires an imported immutable image`,
  );
  return image;
}

function readModelTurnInputs() {
  const key = process.env.OPENAI_API_KEY;
  const model = process.env.OCC_TEST_OPENAI_MODEL;
  assert.ok(key, "OPENAI_API_KEY is required for explicit model-turn validation");
  assert.ok(model, "OCC_TEST_OPENAI_MODEL is required for explicit model-turn validation");
  return { key, model };
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  const result = asRecord(value);
  assert.ok(result, `Expected ${label} object`);
  return result;
}

function readArray(value: unknown, label: string): unknown[] {
  assert.ok(Array.isArray(value), `Expected ${label} array`);
  return value;
}

function readString(value: unknown, label: string): string {
  assert.ok(typeof value === "string", `Expected ${label} string`);
  return value;
}

export const observabilitySelection = {
  skip:
    process.env.OCC_TEST_PRODUCTION_OBSERVABILITY === "1"
      ? false
      : "Select k3d-observability with the CI runner; see docs/testing/local.md#kubernetes-observability-acceptance.",
  timeout: 1_200_000,
};

// Own only test resources. API calls, lifecycle, telemetry and policy enforcement
// all use the installed production implementations, with a credential-free runtime fixture.
export async function installObservabilityControlPlane(
  t: TestContext,
  { modelTurns = false, nativeRepository = false }: InstallationOptions = {},
) {
  const modelInputs = modelTurns ? readModelTurnInputs() : undefined;
  const selectionInput = explicitK3dSelection();
  await validateExplicitK3dLoopbackContext(selectionInput);
  const { kubeconfigPath, kubernetesContext } = selectionInput;
  assert.ok(kubeconfigPath && kubernetesContext);
  const selection = { kubeconfigPath, kubernetesContext };
  const images: Images = {
    controller: importedImage("OCC_TEST_PRODUCTION_CONTROLLER_IMAGE"),
    postgres: importedImage("OCC_TEST_PRODUCTION_POSTGRES_IMAGE"),
    node: importedImage("OCC_TEST_PRODUCTION_NODE_IMAGE"),
    ...(nativeRepository
      ? { credentials: importedImage("OCC_TEST_REPOSITORY_CREDENTIALS_IMAGE") }
      : {}),
    ...(modelTurns
      ? {
          runtime: importedImage("OCC_TEST_KUBERNETES_GATEWAY_IMAGE"),
          codex: importedImage("OCC_TEST_KUBERNETES_AGENT_IMAGE"),
        }
      : {
          runtime: importedImage("OCC_TEST_KUBERNETES_IMAGE"),
          collector: importedImage("OCC_TEST_OBSERVABILITY_COLLECTOR_IMAGE"),
        }),
  };
  const suffix = randomBytes(4).toString("hex");
  const system = `oce-observe-${suffix}`;
  const monitoring = `oce-monitor-${suffix}`;
  const foreign = `oce-other-${suffix}`;
  const release = `obs-${suffix}`;
  const directory = await mkdtemp(join(tmpdir(), "oce-observability-"));
  const secrets = modelInputs ? [modelInputs.key] : [];
  const secret = () => {
    const value = randomBytes(32).toString("hex");
    secrets.push(value);
    return value;
  };
  const redact = (value: string) =>
    secrets.reduce((text, item) => text.replaceAll(item, "[redacted]"), value);
  const run = async (command: string, args: string[], options: CommandOptions = {}) => {
    const executables: Record<string, string | undefined> = {
      helm: process.env.OCC_HELM_BIN,
      kubectl: process.env.OCC_KUBECTL_BIN,
    };
    const result = readRecord(
      await runCommand(executables[command] ?? command, args, {
        env: process.env,
        timeout: 180_000,
        ...options,
        allowFailure: true,
      }),
      "command result",
    );
    const { code, stderr, stdout } = result;
    assert.ok(code === null || typeof code === "number", "Expected command exit status");
    const diagnostics = readString(stderr, "command stderr");
    // Validation errors can quote the submitted Secret, including escaped PEM
    // or base64 data. Never expose diagnostics from a command with private stdin.
    assert.equal(
      code,
      0,
      options.input ? `${command} failed with input` : redact(`${command}: ${diagnostics}`),
    );
    return readString(stdout, "command stdout");
  };
  const kubectl = (...args: string[]) => run("kubectl", kubectlArguments(selection, args));
  const kubernetes: KubernetesClient = createKubernetesClient({
    selection,
    kubectl,
    waitTimeoutMs: 180_000,
    waitIntervalMs: 1_000,
  });
  const { waitFor } = kubernetes;
  const namespaces = [system, monitoring, foreign];
  const metadata = (name: string, namespace = system, labels: Labels = {}) => ({
    name,
    namespace,
    labels: { "oce-test": suffix, ...labels },
  });
  const apply = (object: object) =>
    run("kubectl", kubectlArguments(selection, ["apply", "-f", "-"]), {
      input: JSON.stringify(object),
    });
  const get = (kind: string, name: string, namespace = system) =>
    kubernetes.resource(kind, name, namespace);
  const record = (message: string) => t.diagnostic(message);
  t.after(async () => {
    // Register ownership before creation; cleanup failures must fail acceptance.
    const errors: unknown[] = [];
    try {
      await run("helm", [
        "uninstall",
        release,
        "-n",
        system,
        "--kubeconfig",
        selection.kubeconfigPath,
        "--kube-context",
        selection.kubernetesContext,
        "--ignore-not-found",
        "--wait",
        "--timeout",
        "120s",
      ]);
    } catch (error) {
      errors.push(error);
    }
    try {
      await kubectl(
        "delete",
        "namespace",
        ...namespaces,
        "--ignore-not-found",
        "--wait=true",
        "--timeout=120s",
      );
    } catch (error) {
      errors.push(error);
    }
    await rm(directory, { recursive: true, force: true });
    if (errors.length) {
      throw new AggregateError(errors, "observability resource cleanup failed");
    }
  });
  for (const name of namespaces) {
    await apply({
      apiVersion: "v1",
      kind: "Namespace",
      metadata: { name, labels: { "oce-test": suffix } },
    });
  }
  const configuration = createKubernetesInstallationConfiguration({
    authentication: { mode: "inCluster" },
    platformNamespace: system,
    gatewayImage: images.runtime,
    codexImage: images.codex ?? images.runtime,
    codexSeccompProfile: modelTurns
      ? process.env.OCC_TEST_KUBERNETES_CODEX_SECCOMP_PROFILE
      : undefined,
    cluster: `observability-${suffix}`,
  });
  if (!modelTurns) {
    // The Installation's resolved provider and the fixture Agent's native configuration must agree.
    Object.assign(configuration.drivers.compute.configuration.runtime, {
      modelProvider: { protocol: "openai-responses", baseUrl: "https://model.stub.invalid/v1" },
    });
  }
  let repositoryCredentials: Record<string, unknown> | undefined;
  if (nativeRepository) {
    const prepared: unknown = await prepareObservabilityNativeRepository({
      configuration,
      system,
      release,
      directory,
      suffix,
      images,
      secrets,
      run,
      apply,
      metadata,
    });
    repositoryCredentials = readRecord(prepared, "native repository Helm values");
    assert.equal(repositoryCredentials.image, images.credentials);
  }
  await installProductionHelmControlPlane({
    selection,
    images,
    namespace: system,
    release,
    directory,
    suffix,
    configuration,
    authBaseURL: "https://observability.example.invalid",
    agentNativeAdminDomain: "agents.example.invalid",
    installationName: "Observability acceptance",
    repositoryCredentials,
    databaseName: `openclaw_k8s_observability_${suffix}`,
    apiClients: [{ namespace: system, podLabels: { app: "operator" } }],
    run,
    kubernetes,
    createSecretValue: secret,
    record,
  });
  const values = readRecord(
    JSON.parse(await readFile(join(directory, "values.json"), "utf8")),
    "Helm values",
  );
  async function upgrade(patch: Record<string, unknown>) {
    Object.assign(values, patch);
    await writeFile(join(directory, "values.json"), JSON.stringify(values), { mode: 0o600 });
    await run(
      "helm",
      [
        "upgrade",
        release,
        "deploy/helm/openclaw-enterprise",
        "-n",
        system,
        "--kubeconfig",
        selection.kubeconfigPath,
        "--kube-context",
        selection.kubernetesContext,
        "-f",
        join(directory, "values.json"),
        "--wait",
        "--timeout",
        "300s",
      ],
      { timeout: 330_000 },
    );
  }
  const securityContext = {
    allowPrivilegeEscalation: false,
    capabilities: { drop: ["ALL"] },
    readOnlyRootFilesystem: true,
  };
  async function probePod(name: string, namespace: string, labels: Labels, bootstrap = false) {
    await apply({
      apiVersion: "v1",
      kind: "Pod",
      metadata: metadata(name, namespace, labels),
      spec: {
        automountServiceAccountToken: false,
        terminationGracePeriodSeconds: 1,
        securityContext: {
          runAsNonRoot: true,
          runAsUser: 1000,
          runAsGroup: 1000,
          fsGroup: 1000,
          seccompProfile: { type: "RuntimeDefault" },
        },
        containers: [
          {
            name: "node",
            image: images.node,
            securityContext,
            command: [
              "node",
              "-e",
              "require('node:http').createServer((q,r)=>r.end('probe')).listen(3100,'0.0.0.0')",
            ],
            resources: {
              requests: { cpu: "10m", memory: "32Mi" },
              limits: { cpu: "500m", memory: "128Mi" },
            },
            ...(bootstrap
              ? { volumeMounts: [{ name: "bootstrap", mountPath: "/bootstrap", readOnly: true }] }
              : {}),
          },
        ],
        ...(bootstrap
          ? {
              volumes: [
                { name: "bootstrap", persistentVolumeClaim: { claimName: "bootstrap-password" } },
              ],
            }
          : {}),
      },
    });
    await kubectl(
      "-n",
      namespace,
      "wait",
      "--for=condition=Ready",
      `pod/${name}`,
      "--timeout=180s",
    );
  }
  // Independent probe Pods can become ready together; settle all creation before
  // a failure triggers namespace cleanup.
  const probes = await Promise.allSettled([
    probePod(
      "operator",
      system,
      { app: "operator", "app.kubernetes.io/name": "approved-gateway-client" },
      true,
    ),
    probePod("scraper", monitoring, { app: "scraper" }),
    probePod("wrong-pod", monitoring, { app: "wrong" }),
    probePod("wrong-namespace", foreign, { app: "scraper" }),
  ]);
  for (const result of probes) {
    if (result.status === "rejected") {
      const reason: unknown = result.reason;
      throw reason;
    }
  }
  async function node(pod: string, namespace: string, script: string, input?: unknown) {
    return run(
      "kubectl",
      kubectlArguments(selection, [
        "-n",
        namespace,
        "exec",
        "-i",
        pod,
        "--",
        "node",
        "--input-type=module",
        "-e",
        script,
      ]),
      { input: JSON.stringify(input) },
    );
  }
  async function request(method: string, path: string, body?: unknown, authenticated = true) {
    const result: unknown = JSON.parse(
      await node(
        "operator",
        system,
        `
      import fs from 'node:fs';
      const input=JSON.parse(fs.readFileSync(0,'utf8'));
      const headers=input.body===undefined?{}:{'content-type':'application/json'};
      if(input.authenticated)headers['x-api-key']=JSON.parse(fs.readFileSync('/bootstrap/initial-admin-service-key.json','utf8')).data.key;
      const r=await fetch(input.url,{method:input.method,headers,body:input.body===undefined?undefined:JSON.stringify(input.body),signal:AbortSignal.timeout(15000)});
      console.log(JSON.stringify({status:r.status,requestId:r.headers.get('x-request-id'),body:await r.json()}));
    `,
        {
          url: `http://openclaw-enterprise-api.${system}.svc:8080${path}`,
          method,
          body,
          authenticated,
        },
      ),
    );
    for (const value of secrets) {
      assert.ok(!JSON.stringify(result).includes(value), "API response contains private input");
    }
    const response = readRecord(result, "API probe response");
    const { status, requestId } = response;
    assert.ok(typeof status === "number", "Expected API probe status");
    assert.ok(requestId === null || typeof requestId === "string", "Expected API probe request ID");
    assert.ok("body" in response, "Expected API probe body");
    return { status, requestId, body: response.body };
  }
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const result = await request(method, path, body);
    assert.equal(result.status, status, redact(JSON.stringify(result.body)));
    return readRecord(result.body, "API response envelope").data;
  };
  const scrape = async (pod: string, namespace: string, url: string, headers: Labels = {}) => {
    const result: unknown = JSON.parse(
      await node(
        pod,
        namespace,
        `
    import fs from 'node:fs';const input=JSON.parse(fs.readFileSync(0,'utf8'));
    try { const r=await fetch(input.url,{headers:input.headers,signal:AbortSignal.timeout(3000)});console.log(JSON.stringify({status:r.status,text:await r.text()})); }
    catch { console.log(JSON.stringify({status:0})); }
  `,
        { url, headers },
      ),
    );
    const { status, text } = readRecord(result, "metrics probe response");
    assert.ok(typeof status === "number", "Expected metrics probe status");
    if (text === undefined) {
      return { status };
    }
    return { status, text: readString(text, "metrics probe body") };
  };
  const pods = async (component: string) =>
    readArray(
      await kubernetes.resources(
        "pods",
        system,
        "-l",
        `app.kubernetes.io/instance=${release},app.kubernetes.io/component=${component}`,
      ),
      "Kubernetes Pod list",
    );
  const currentPod = (component: string) =>
    waitFor(`${component} ready`, async () => {
      for (const item of await pods(component)) {
        const pod = readRecord(item, "Kubernetes Pod");
        const metadata = readRecord(pod.metadata, "Kubernetes Pod metadata");
        if (metadata.deletionTimestamp) {
          continue;
        }
        const status = readRecord(pod.status, "Kubernetes Pod status");
        const conditions = readArray(status.conditions ?? [], "Kubernetes Pod conditions");
        if (
          conditions.some((condition) => {
            const { type, status } = readRecord(condition, "Kubernetes Pod condition");
            return type === "Ready" && status === "True";
          })
        ) {
          return pod;
        }
      }
      return undefined;
    });
  const selectors = {
    scraperNamespaceLabels: { "kubernetes.io/metadata.name": monitoring },
    scraperPodLabels: { app: "scraper" },
  };
  async function readyNamespace(namespace: { id: string }): Promise<[string, string]> {
    const placements: string[] = [];
    // Namespace readiness now requires scoped grants in both managed targets,
    // even when this scenario uses an embedded runtime in the data namespace.
    for (const label of ["openclaw.dev/namespace", "openclaw.dev/gateway-namespace"]) {
      const target = await waitFor(`backing namespace for ${label}`, async () => {
        const result: unknown = JSON.parse(
          await kubectl("get", "namespaces", "-l", `${label}=${namespace.id}`, "-o", "json"),
        );
        const [first] = readArray(
          readRecord(result, "Kubernetes Namespace list").items,
          "Kubernetes Namespaces",
        );
        if (first === undefined) {
          return undefined;
        }
        const metadata = readRecord(
          readRecord(first, "Kubernetes Namespace").metadata,
          "Kubernetes Namespace metadata",
        );
        return readString(metadata.name, "Kubernetes Namespace name");
      });
      namespaces.push(target);
      placements.push(target);
      for (const [name, role, account] of [
        ["worker", "worker", "worker"],
        ["configuration", "configuration", "api"],
        ["secrets", "api", "api"],
      ] as const) {
        await apply({
          apiVersion: "rbac.authorization.k8s.io/v1",
          kind: "RoleBinding",
          metadata: metadata(name, target),
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
    }
    await waitFor(
      "Namespace ready",
      async () =>
        readRecord(await api("GET", `/namespaces/${namespace.id}`), "Namespace").status === "ready",
    );
    const [tenant, gateway] = placements;
    assert.ok(tenant && gateway, "Expected both Namespace placements");
    return [tenant, gateway];
  }
  async function createAgent(executionMode: "embedded" | "dedicated" = "embedded") {
    const namespace = readRecord(
      await api("POST", "/namespaces", { name: `Observability ${suffix}` }, 201),
      "created Namespace",
    );
    assert.ok(typeof namespace.id === "string", "Expected Namespace ID");
    const [tenant, gatewayRuntimeNamespace] = await readyNamespace({ id: namespace.id });
    const gatewayPlacement = executionMode === "dedicated" ? gatewayRuntimeNamespace : tenant;
    const sentinel = modelInputs ? modelInputs.key : `fixture-only-${secret()}`;
    secrets.push(sentinel);
    const credential = readRecord(
      await api(
        "POST",
        `/namespaces/${namespace.id}/secrets`,
        { name: "Fixture credential", value: sentinel },
        201,
      ),
      "created Secret",
    );
    assert.ok(typeof credential.id === "string", "Expected Secret ID");
    const configuration: HarnessConfiguration = createHarnessConfiguration(
      executionMode === "dedicated" ? "codex" : "openclaw",
      modelInputs ? modelInputs.model.replace(/^(?:openai|codex)\//, "") : "gpt-4.1",
    );
    // The fixture answers model probes locally; its synthetic key must never target OpenAI.
    const native: HarnessConfiguration = modelTurns
      ? configuration
      : withStubbedProviderEndpoint(configuration);
    Object.assign(native.agents.defaults, { skipBootstrap: true });
    const config = readRecord(
      await api(
        "POST",
        `/namespaces/${namespace.id}/configurations`,
        { kind: "agent", values: native },
        201,
      ),
      "created Configuration",
    );
    assert.ok(typeof config.id === "string", "Expected Configuration ID");
    const createdAgent = await api(
      "POST",
      `/namespaces/${namespace.id}/agents`,
      {
        name: `Private content ${suffix}`,
        configurationId: config.id,
        executionMode,
        harnessAuth: {
          method: "api_key",
          source: { kind: "secret", namespaceId: namespace.id, id: credential.id },
        },
      },
      201,
    );
    const agent = readRecord(createdAgent, "created Agent");
    const role = readRecord(
      await api(
        "POST",
        `/namespaces/${namespace.id}/iam/roles`,
        {
          name: "Fixture model access",
          permissions: [{ action: "operate", resourceKind: "secret" }],
        },
        201,
      ),
      "created IAM role",
    );
    await api(
      "POST",
      `/namespaces/${namespace.id}/iam/access-bindings`,
      {
        subjectKind: "identity",
        subjectId: readString(agent.servicePrincipalId, "Agent service principal ID"),
        roleId: readString(role.id, "IAM role ID"),
        resourceKind: "secret",
        resourceId: credential.id,
      },
      201,
    );
    const path = `/namespaces/${namespace.id}/agents/${readString(agent.id, "Agent ID")}`;
    // The regular manual Agent workflow provisions platform-owned transport
    // credentials before admitting the first revision.
    await api("POST", `${path}/runtime-credentials`, {});
    const deploy = async () => {
      const revision = readRecord(
        await api("POST", `${path}/deploy`, undefined, 202),
        "Agent revision",
      );
      const revisionId = readString(revision.id, "Agent revision ID");
      await waitFor(
        "Agent revision active",
        async () => readRecord(await api("GET", path), "Agent").activeRevisionId === revisionId,
      );
      return revision;
    };
    const stop = async () => {
      await api("POST", `${path}/stop`, undefined, 202);
      await waitFor(
        "Agent stopped",
        async () => !readRecord(await api("GET", path), "Agent").activeRevisionId,
      );
    };
    return {
      namespace,
      tenant,
      gatewayPlacement,
      agent,
      path,
      deploy,
      stop,
      forbidden: [sentinel, readString(agent.name, "Agent name")],
    };
  }
  const createSecret = (name: string, stringData: Record<string, string>, namespace = system) =>
    apply({ apiVersion: "v1", kind: "Secret", metadata: metadata(name, namespace), stringData });
  return {
    selection,
    images,
    suffix,
    system,
    monitoring,
    foreign,
    release,
    directory,
    secrets,
    run,
    kubectl,
    kubernetes,
    waitFor,
    metadata,
    apply,
    get,
    upgrade,
    values,
    node,
    request,
    api,
    scrape,
    pods,
    currentPod,
    probePod,
    selectors,
    createAgent,
    readyNamespace,
    createSecret,
    ...createObservabilityCollector({
      images,
      system,
      monitoring,
      selectors,
      securityContext,
      createSecret,
      upgrade,
      kubectl,
      apply,
      metadata,
      node,
    }),
    record,
  };
}
