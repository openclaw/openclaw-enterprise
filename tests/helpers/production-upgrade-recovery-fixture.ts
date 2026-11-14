import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { asRecord } from "../../packages/utils/src/index.ts";
import { syntheticCredentialUrl } from "../fixtures/synthetic-credential-url.mjs";
import { startFakePostgres } from "./fake-postgres-server.mjs";
import { bashString, commandShim, startCommandServer } from "./fixture-command-server.ts";
import { listen } from "./listen.ts";
import { createRecoveryCommandHandler } from "./production-upgrade-recovery-commands.ts";
import { evidenceFiles } from "./production-upgrade-recovery-evidence.ts";
import { runPreflight, testCertificate } from "./production-upgrade-recovery-render.ts";
import {
  list,
  record,
  requireRecoveryPreflight,
  type CapabilityProbe,
  type PreflightFault,
} from "./production-upgrade-recovery-state.ts";
import {
  controller,
  execute,
  helmTargetOverrides,
  newBroker,
  newController,
  oldRuntime,
  runtime,
  spawnResult,
  type RecoveryTools,
} from "./production-upgrade-recovery-tools.ts";

type FakePostgres = Awaited<ReturnType<typeof startFakePostgres>>;
type DatabaseAnswer = NonNullable<NonNullable<Parameters<typeof startFakePostgres>[0]>["onQuery"]>;
type PreflightDatabase = NonNullable<Parameters<typeof runPreflight>[4]>;

type RecoveryNamespace = { metadata: { name: string; labels?: Record<string, string> } };

type ExecutionCluster = {
  namespaces: readonly RecoveryNamespace[];
  allows(
    attributes: Record<string, unknown>,
  ): boolean | { allowed: boolean; evaluationError?: string };
};

type ChartValues = Record<string, unknown> & {
  images: Record<string, unknown>;
  database: Record<string, unknown>;
  gatewayRouting: Record<string, unknown>;
  api: Record<string, unknown>;
  auth: Record<string, unknown>;
};

type ComputeConfiguration = Record<string, unknown> & {
  network: Record<string, unknown>;
  gatewayRouting: Record<string, unknown> & { gatewayName: string };
  runtime: Record<string, unknown>;
};

type ChartInstallation = Record<string, unknown> & {
  drivers: Record<string, unknown> & {
    compute: Record<string, unknown> & { configuration: ComputeConfiguration };
  };
};

type RecoveryChart = {
  values?(values: ChartValues): Record<string, unknown>;
  installation(installation: ChartInstallation): Record<string, unknown>;
  configMaps?: Record<string, { data: Record<string, string> }>;
};

type PluginDrivers = Record<string, unknown> | readonly unknown[];

export type RecoveryFixtureOptions = {
  agent?: boolean;
  release?: string;
  candidates?: boolean;
  controllerOnly?: boolean;
  continuity?: { before: object; after: object } | null;
  repositoryCredentials?: boolean;
  simulatePair?: boolean;
  capabilityReplies?: readonly unknown[];
  workerPlacement?: string;
  collector?: "current" | "stale" | "missing" | null;
  chart?: RecoveryChart | null;
  preflightResults?: Record<string, object> | null;
  recoveryHooks?: boolean;
  initializationResources?: object | undefined;
  preflightPolicy?: boolean;
  certificate?: boolean;
  preflightFault?: PreflightFault | null;
  kubernetesNamespaces?: readonly RecoveryNamespace[];
  kubernetesDenied?: boolean;
  executionCluster?: ExecutionCluster | null;
  installationName?: string | null;
  inventoryNamespaces?: readonly unknown[] | null;
  inventoryResponses?: readonly unknown[] | undefined;
  inventoryRequiresApi?: boolean;
  activeRevisionResponse?: unknown;
  names?: Record<string, string | number | null> | null;
  configurationValues?: Record<string, unknown> | null;
  pluginDrivers?: PluginDrivers;
  candidatePluginDrivers?: PluginDrivers;
  olderDraftRules?: boolean;
  unavailableDraftResolver?: boolean;
  databaseAnswer?: DatabaseAnswer;
  afterDeploy?: () => Promise<void>;
  environment?: NodeJS.ProcessEnv;
};

type RecoverySeed = {
  release: string;
  version: number;
  helmStatus: string;
  api: number;
  worker: number;
  dispatches: number;
  capabilityProbes: CapabilityProbe[];
  deployments: Record<string, string>;
  controller: string;
  collectorSecretName: string;
  realChart: boolean;
  startupCheck: boolean;
  kubeconfig: string | null;
  initActive: boolean;
} & Pick<
  RecoveryFixtureOptions,
  | "agent"
  | "capabilityReplies"
  | "configurationValues"
  | "continuity"
  | "initializationResources"
  | "installationName"
  | "inventoryNamespaces"
  | "inventoryRequiresApi"
  | "inventoryResponses"
  | "activeRevisionResponse"
  | "names"
  | "olderDraftRules"
  | "preflightFault"
  | "preflightPolicy"
  | "preflightResults"
  | "recoveryHooks"
  | "simulatePair"
  | "unavailableDraftResolver"
  | "workerPlacement"
> & {
    collectorSecret: Awaited<ReturnType<typeof collectorConfigSecret>>;
    secret: { apiVersion: string; kind: string; metadata: object; data: Record<string, string> };
    recoveryCandidateResources?: readonly object[];
    themeConfigMaps: NonNullable<RecoveryChart["configMaps"]>;
  };

function assertChartValues(value: unknown): asserts value is ChartValues {
  const values = asRecord(value);
  assert.ok(
    values &&
      asRecord(values.images) &&
      asRecord(values.database) &&
      asRecord(values.gatewayRouting) &&
      asRecord(values.api) &&
      asRecord(values.auth),
    "expected the production example Helm values",
  );
}

function assertChartInstallation(value: unknown): asserts value is ChartInstallation {
  const drivers = asRecord(asRecord(value)?.drivers);
  const configuration = asRecord(asRecord(drivers?.compute)?.configuration);
  const routing = asRecord(configuration?.gatewayRouting);
  assert.ok(
    configuration &&
      asRecord(configuration.network) &&
      asRecord(configuration.runtime) &&
      typeof routing?.gatewayName === "string",
    "expected the production example Installation Compute configuration",
  );
}

function readAccessAttributes(body: string): Record<string, unknown> | undefined {
  let review: unknown;
  try {
    review = JSON.parse(body);
  } catch {
    return;
  }
  return asRecord(asRecord(asRecord(review)?.spec)?.resourceAttributes);
}

// The bundled Collector's operator-created config Secret, as created from
// deploy/logging at install time ("current") or by an older revision ("stale").
async function collectorConfigSecret(
  repository: string,
  name: string,
  collector: RecoveryFixtureOptions["collector"],
) {
  if (collector !== "current" && collector !== "stale") {
    return null;
  }
  const data: Record<string, string> = {};
  for (const key of ["collector.yaml", "kubernetes.yaml", "exporter.yaml"]) {
    const shipped = await readFile(join(repository, "deploy/logging", key));
    let content = shipped;
    if (collector === "stale" && key !== "exporter.yaml") {
      content = Buffer.from(
        content
          .toString()
          .replace(
            /^ *- set\(attributes\["event\.name"\], cache\["record"\]\["event"\]\) where attributes\["event\.name"\] == nil.*\n/m,
            "",
          )
          .replace(/^ *- delete_key\(attributes, "container\.image\.tag"\).*\n/m, ""),
      );
      // Guard against a change to the shipped config making this stale fixture current.
      assert.notDeepEqual(content, shipped);
    }
    data[key] = content.toString("base64");
  }
  return { metadata: { name, uid: "collector-config-uid", resourceVersion: "1" }, data };
}

// A stand-in Kubernetes API for the startup preflight's Compute check. It serves
// only the version, Namespace and SelfSubjectAccessReview requests that check makes,
// over verified HTTPS with a bearer token, from the Namespaces a case seeds. With
// `execution`, a second stand-in serves the two-cluster execution target under the
// kubeconfig context `execution`, granting the rules its `allows` callback admits.
// The real Kubernetes Compute Driver in the preflight Pod decides whether that state
// may start; this is not live cluster or RBAC proof.
async function kubernetesApi(
  t: TestContext,
  directory: string,
  namespaces: readonly RecoveryNamespace[],
  denied: boolean,
  execution: ExecutionCluster | null,
) {
  const certificate = join(directory, "kubernetes-api.crt");
  const key = join(directory, "kubernetes-api.key");
  await execute("openssl", [
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:prime256v1",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=kubernetes",
    "-addext",
    "subjectAltName=IP:127.0.0.1",
    "-keyout",
    key,
    "-out",
    certificate,
  ]);
  const tls = { key: await readFile(key), cert: await readFile(certificate) };
  const serve = async ({ namespaces, uid, allows }: ExecutionCluster & { uid: string }) => {
    const reads: string[] = [];
    const reviews: Record<string, unknown>[] = [];
    const server = createServer(tls, async (request, response) => {
      const url = new URL(request.url ?? "/", "https://127.0.0.1");
      const reply = (status: number, body: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      const review =
        request.method === "POST" &&
        url.pathname === "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews";
      if (
        denied ||
        (request.method !== "GET" && !review) ||
        request.headers.authorization !== "Bearer preflight-token"
      ) {
        reply(403, { kind: "Status", apiVersion: "v1", status: "Failure", code: 403 });
        return;
      }
      if (review) {
        let body = "";
        for await (const chunk of request as AsyncIterable<unknown, unknown, unknown>) {
          body += String(chunk);
        }
        const attributes = readAccessAttributes(body);
        if (!attributes) {
          reply(400, { kind: "Status", apiVersion: "v1", status: "Failure", code: 400 });
          return;
        }
        // `allows` answers a decision, or a whole review status such as an evaluation error.
        const decision = allows(attributes);
        const status = typeof decision === "object" ? decision : { allowed: decision };
        reviews.push({ ...attributes, allowed: status.allowed });
        reply(201, {
          kind: "SelfSubjectAccessReview",
          apiVersion: "authorization.k8s.io/v1",
          spec: { resourceAttributes: attributes },
          status,
        });
        return;
      }
      reads.push(url.pathname);
      if (url.pathname === "/version") {
        reply(200, { major: "1", minor: "35", gitVersion: "v1.35.0" });
      } else if (url.pathname === "/api/v1/namespaces/kube-system") {
        // Two-cluster preflight tells the clusters apart by this Namespace's UID.
        reply(200, {
          kind: "Namespace",
          apiVersion: "v1",
          metadata: { name: "kube-system", uid },
        });
      } else if (url.pathname === "/api/v1/namespaces") {
        // Only label-existence selectors, which is what Compute preflight sends.
        const keys = (url.searchParams.get("labelSelector") ?? "").split(",").filter(Boolean);
        const items = namespaces.filter((namespace) =>
          keys.every((label) => label in (namespace.metadata.labels ?? {})),
        );
        reply(200, { kind: "NamespaceList", apiVersion: "v1", metadata: {}, items });
      } else {
        reply(404, { kind: "Status", apiVersion: "v1", status: "Failure", code: 404 });
      }
    });
    return { port: await listen(t, server), reads, reviews };
  };
  const control = await serve({ namespaces, uid: "control-cluster", allows: () => false });
  const target =
    execution === null
      ? null
      : await serve({
          namespaces: execution.namespaces,
          uid: "execution-cluster",
          allows: execution.allows,
        });
  const authority = (await readFile(certificate)).toString("base64");
  const cluster = (name: string, port: number) => ({
    name,
    cluster: { server: `https://127.0.0.1:${port}`, "certificate-authority-data": authority },
  });
  const kubeconfig = join(directory, "preflight-kubeconfig.json");
  await writeFile(
    kubeconfig,
    JSON.stringify({
      apiVersion: "v1",
      kind: "Config",
      clusters: [
        cluster("preflight", control.port),
        ...(target === null ? [] : [cluster("execution", target.port)]),
      ],
      users: [{ name: "preflight", user: { token: "preflight-token" } }],
      contexts: [
        { name: "preflight", context: { cluster: "preflight", user: "preflight" } },
        ...(target === null
          ? []
          : [{ name: "execution", context: { cluster: "execution", user: "preflight" } }]),
      ],
      "current-context": "preflight",
    }),
  );
  // The controller image's unprivileged user reads this file through a bind mount.
  await chmod(kubeconfig, 0o644);
  return {
    kubeconfig,
    reads: control.reads,
    executionReads: target?.reads ?? [],
    reviews: target?.reviews ?? [],
  };
}

export function createRecoveryFixture(tools: RecoveryTools) {
  const { repository, script, shimTools, sourceRevision } = tools;
  const handleCommand = createRecoveryCommandHandler(tools);

  return async function fixture(
    t: TestContext,
    {
      agent = false,
      release = "oce",
      candidates = false,
      controllerOnly = false,
      continuity = null,
      repositoryCredentials = false,
      simulatePair = false,
      capabilityReplies = [],
      workerPlacement = "container",
      collector = null,
      chart = null,
      preflightResults = null,
      recoveryHooks = false,
      initializationResources,
      preflightPolicy = false,
      certificate = false,
      preflightFault = null,
      kubernetesNamespaces = [],
      kubernetesDenied = false,
      executionCluster = null,
      installationName = "Production",
      inventoryNamespaces = null,
      inventoryResponses,
      inventoryRequiresApi = false,
      activeRevisionResponse,
      names = null,
      configurationValues = null,
      pluginDrivers,
      candidatePluginDrivers,
      olderDraftRules = false,
      unavailableDraftResolver = false,
      databaseAnswer = () => ({ rows: [{ id: "ins_test" }] }),
      afterDeploy,
      environment = {},
    }: RecoveryFixtureOptions = {},
  ) {
    const directory = await mkdtemp(join(tmpdir(), "occ-upgrade-recovery-"));
    const bin = join(directory, "bin");
    await mkdir(bin);
    const commands: string[] = [];
    let upgradeProcess: ChildProcess | undefined;
    let interrupted = false;
    let database: (FakePostgres & PreflightDatabase) | undefined;
    const server = await startCommandServer({
      forwardedEnv: [],
      handle: (request) => {
        const { command, args } = request;
        commands.push(command);
        if (
          (preflightFault?.mode === "interrupt" || preflightFault?.mode === "interrupt-hard") &&
          !interrupted &&
          command === "kubectl" &&
          args.includes("get") &&
          args.some((arg) => arg.startsWith("job.batch/oce-upgrade-preflight-"))
        ) {
          interrupted = true;
          assert.ok(upgradeProcess, "the preflight command must belong to a started upgrade");
          upgradeProcess.kill(preflightFault.mode === "interrupt-hard" ? "SIGKILL" : "SIGTERM");
        }
        return handleCommand(directory, request, afterDeploy, database);
      },
    });
    t.after(() => server.close());
    // Hooks run in order: stop answering commands before the directory goes.
    t.after(() => rm(directory, { recursive: true, force: true }));
    // Pair cases also answer node, to stand in for the image-pair probe.
    for (const command of ["helm", "kubectl", "occ", ...(simulatePair ? ["node"] : [])]) {
      const { port, clientToken, serverToken } = server;
      await writeFile(
        join(bin, command),
        commandShim({ ...shimTools, port, clientToken, serverToken, command, forwardedEnv: [] }),
        { mode: 0o700 },
      );
    }
    // The script waits "sleep 2" between polls. The fixture answers every poll at once, so
    // it waits 0.25 s instead: each case sees the same reads, in the same order, sooner.
    // Deadline cases script more reads than 0.25 s polls can use before their timeout.
    await writeFile(
      join(bin, "sleep"),
      `#!${shimTools.bash}\n[[ "$*" != 2 ]] || set -- 0.25\nexec ${bashString(shimTools.sleep)} "$@"\n`,
      { mode: 0o700 },
    );
    const collectorSecretName = "occ-demo-collector-config";
    let values = JSON.stringify({
      images: { controller },
      ...(collector
        ? { logging: { collector: { enabled: true, configSecretName: collectorSecretName } } }
        : {}),
      installation: { secretName: "occ-installation-startup", key: "installation.yaml" },
      ...(repositoryCredentials
        ? {
            repositoryCredentials: {
              enabled: true,
              image: `registry.example.invalid/broker@sha256:${"1".repeat(64)}`,
              serviceName: "git",
              hostname: "git.system.svc.cluster.local",
              clusterDomain: "cluster.local",
            },
          }
        : {}),
    });
    let installation = JSON.stringify({
      ...(repositoryCredentials
        ? {
            backend: [
              {
                id: "github-primary",
                type: "github",
                configuration: { registryPath: "/etc/openclaw/repository-registry/registry.json" },
                drivers: { repo: "repository-credentials" },
              },
            ],
            repository: {
              id: "repository-credentials",
              configuration: { sessionDurationSeconds: 86400 },
              nativeSender: {
                controlSocket: "/run/openclaw/repository-control/private/control.sock",
                publicCaPath: "/etc/openclaw/repository-ca/ca.crt",
              },
              preparedGitHub: {
                custodyKeyPath: "/etc/openclaw/prepared-repository/custody.key",
                privateKeyPath: "/etc/openclaw/prepared-repository/private-key.pem",
              },
            },
          }
        : {}),
      drivers: {
        ...(pluginDrivers && { plugin: pluginDrivers }),
        compute: {
          id: "compute-kubernetes",
          configuration: {
            authentication: { mode: "inCluster" },
            images: { agent: oldRuntime, gateway: oldRuntime },
            ...(repositoryCredentials
              ? {
                  network: {
                    repositoryCredentials: {
                      namespace: "system",
                      podLabels: { "app.kubernetes.io/component": "worker" },
                      port: 8443,
                    },
                  },
                }
              : {}),
          },
        },
      },
    });
    let api: Awaited<ReturnType<typeof kubernetesApi>> | null = null;
    if (chart) {
      // The release's example values and Installation, rendered by the real chart.
      const example = async (name: string): Promise<unknown> =>
        JSON.parse(
          (
            await execute("yq", [
              "-o=json",
              ".",
              join(repository, "deploy/examples/production", name),
            ])
          ).stdout,
        );
      const exampleValues = await example("values.yaml");
      assertChartValues(exampleValues);
      exampleValues.images.controller = controller;
      exampleValues.installation = {
        secretName: "occ-installation-startup",
        key: "installation.yaml",
      };
      const exampleInstallation = await example("installation.yaml");
      assertChartInstallation(exampleInstallation);
      const compute = exampleInstallation.drivers.compute.configuration;
      compute.network.gatewayTrustedProxyCidrs = ["10.42.0.0/16"];
      // Outside a cluster the preflight Pod has no service account, so Compute
      // reaches the stand-in Kubernetes API through an explicit kubeconfig.
      api = await kubernetesApi(
        t,
        directory,
        kubernetesNamespaces,
        kubernetesDenied,
        executionCluster,
      );
      // The example's Gateway namespace must follow this fixture's Helm release.
      compute.gatewayRouting.gatewayNamespace = "system";
      exampleValues.gatewayRouting.gatewayName = compute.gatewayRouting.gatewayName;
      compute.authentication = {
        mode: "kubeconfig",
        kubeconfigPath: api.kubeconfig,
        context: "preflight",
      };
      if (executionCluster) {
        // The experimental two-cluster profile: the same kubeconfig selects the
        // execution stand-in, with documentation-range endpoint CIDRs.
        compute.gatewayRouting.hostname = "gateway.example.test";
        exampleValues.gatewayRouting.hostname = compute.gatewayRouting.hostname;
        compute.executionCluster = {
          authentication: {
            mode: "kubeconfig",
            kubeconfigPath: api.kubeconfig,
            context: "execution",
          },
          harnessRouting: { ...compute.gatewayRouting, hostname: "harness.example.test" },
          network: {
            dns: compute.network.dns,
            harnessEndpointCidrs: ["192.0.2.2/32"],
            gatewayEndpointCidrs: ["192.0.2.1/32"],
            pluginStatusProxySourceCidrs: ["192.0.2.2/32"],
          },
        };
      }
      // Apply case-specific changes after constructing a consistent release baseline.
      values = JSON.stringify(chart.values ? chart.values(exampleValues) : exampleValues);
      installation = JSON.stringify(chart.installation(exampleInstallation));
      // Protocol-only dependency: it supplies rows, never decides identity or
      // enforces SQL. Real PostgreSQL and packaged-image qualification are separate.
      const postgres = await startFakePostgres({
        onQuery: (query, session) =>
          /^SELECT\b/i.test(query) ? databaseAnswer(query, session) : undefined,
      });
      t.after(() => postgres.close());
      const selectedValues: unknown = JSON.parse(values);
      const databaseValues = asRecord(asRecord(selectedValues)?.database);
      assert.ok(databaseValues, "expected database values");
      const secretName = databaseValues.secretName ?? "occ-database";
      const appUrlKey = databaseValues.appUrlKey ?? "application-url";
      assert.ok(typeof secretName === "string" && typeof appUrlKey === "string");
      database = {
        ...postgres,
        secretName,
        appUrlKey,
        url: syntheticCredentialUrl({
          protocol: "postgresql",
          username: "candidate_app",
          password: "fixture-only",
          host: "127.0.0.1",
          port: postgres.port,
          pathname: "/candidate",
        }),
      };
    }
    const state = {
      release,
      continuity,
      realChart: Boolean(chart),
      startupCheck: Boolean(chart),
      themeConfigMaps: chart?.configMaps ?? {},
      kubeconfig: api?.kubeconfig ?? null,
      preflightResults,
      recoveryHooks,
      initializationResources,
      preflightPolicy,
      preflightFault,
      installationName,
      inventoryNamespaces,
      inventoryResponses,
      inventoryRequiresApi,
      activeRevisionResponse,
      names,
      configurationValues,
      ...(certificate ? { recoveryCandidateResources: [testCertificate] } : {}),
      olderDraftRules,
      unavailableDraftResolver,
      version: 1,
      helmStatus: "deployed",
      api: 1,
      worker: 1,
      controller,
      agent,
      workerPlacement,
      simulatePair,
      capabilityReplies,
      capabilityProbes: [],
      dispatches: 0,
      deployments: {},
      initActive: false,
      collectorSecretName,
      collectorSecret: await collectorConfigSecret(repository, collectorSecretName, collector),
      secret: {
        apiVersion: "v1",
        kind: "Secret",
        metadata: {
          name: "occ-installation-startup",
          uid: "secret-uid",
          resourceVersion: "1",
          annotations: { "openclaw.dev/installation-id": "ins_test", retained: "yes" },
        },
        data: {
          "installation.yaml": Buffer.from(installation).toString("base64"),
          retained: "cHJlc2VydmVk",
        },
      },
    } satisfies RecoverySeed;
    await writeFile(join(directory, "state.json"), JSON.stringify(state));
    await writeFile(join(directory, "live-values"), values);
    await writeFile(join(directory, "events"), "");
    for (const [name, content] of Object.entries({
      kubeconfig: "cluster-config",
      key: "key",
      "values.json": values,
      "installation.json": installation,
    })) {
      await writeFile(join(directory, name), content, { mode: 0o600 });
    }
    if (candidates) {
      const candidateValues = asRecord(JSON.parse(values));
      assert.ok(candidateValues);
      candidateValues.api = {
        ...asRecord(candidateValues.api),
        channelDirectoryProxyUrl: "http://198.51.100.25:3128",
      };
      const candidateInstallation = asRecord(JSON.parse(installation));
      const drivers = asRecord(candidateInstallation?.drivers);
      assert.ok(drivers);
      if (candidatePluginDrivers) {
        drivers.plugin = candidatePluginDrivers;
      } else {
        const current = list(drivers.plugin ?? [], "installed Plugin drivers");
        drivers.plugin = [
          ...current,
          { id: "codex-plugin", configuration: { catalogSource: "openai-curated" } },
        ];
      }
      await writeFile(join(directory, "candidate-values.json"), JSON.stringify(candidateValues), {
        mode: 0o600,
      });
      await writeFile(
        join(directory, "candidate-installation.json"),
        JSON.stringify(candidateInstallation),
        { mode: 0o600 },
      );
    }
    const evidence = join(directory, "evidence");
    const args = [
      "--kubeconfig",
      join(directory, "kubeconfig"),
      "--context",
      "selected",
      "--namespace",
      "system",
      "--release",
      release,
      "--values",
      join(directory, "values.json"),
      "--installation",
      join(directory, "installation.json"),
      ...(controllerOnly ? ["--controller-image", newController] : ["--runtime-image", runtime]),
      ...(simulatePair && !controllerOnly ? ["--controller-image", newController] : []),
      ...(simulatePair ? ["--broker-image", newBroker] : []),
      ...(candidates
        ? [
            "--candidate-values",
            join(directory, "candidate-values.json"),
            "--candidate-installation",
            join(directory, "candidate-installation.json"),
          ]
        : []),
      "--source-revision",
      sourceRevision,
      "--evidence-dir",
      evidence,
      "--occ",
      join(bin, "occ"),
    ];
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      OCC_URL: "https://occ.example.invalid",
      OCC_SERVICE_KEY_FILE: join(directory, "key"),
    };
    for (const variable of helmTargetOverrides) {
      delete env[variable];
    }
    const readState = async () => {
      const value: unknown = JSON.parse(await readFile(join(directory, "state.json"), "utf8"));
      return record(value, "upgrade recovery fixture state.json");
    };
    return {
      directory,
      ...evidenceFiles(evidence),
      commands,
      databaseSessions: database?.sessions ?? [],
      runIdentityCheck: async (
        component: "api" | "worker",
        action: "identity-job" | "job" = "identity-job",
        protocol?: string,
        fixtureFiles?: readonly string[],
      ) => {
        const { stdout } = await execute(
          process.execPath,
          [
            "scripts/upgrade-startup-preflight.ts",
            action,
            join(evidence, "preflight-rendered.jsonl"),
            component,
            "identity-check",
            "system",
            release,
            "occ-installation-startup",
            "candidate-installation",
            newController,
            "30",
            join(evidence, "installation.json"),
            "none",
          ],
          { cwd: repository },
        );
        const job = asRecord(JSON.parse(stdout));
        const spec = asRecord(job?.spec);
        assert.ok(spec, "expected the generated Job spec");
        const state = await readState();
        const secret = record(state.secret, "candidate Secret");
        const metadata = record(secret.metadata, "candidate Secret metadata");
        assert.ok(
          typeof metadata.uid === "string",
          "the generated Job requires an identified candidate Secret",
        );
        record(requireRecoveryPreflight(state).secrets, "preflight Secrets")[
          "candidate-installation"
        ] = {
          ...secret,
          metadata: { ...metadata, uid: metadata.uid },
        };
        assert.ok(database, "the identity check needs a chart fixture database");
        const connection = { ...database };
        if (protocol) {
          connection.url = database.url.replace(/^[^:]+:/, protocol);
        }
        const result = await runPreflight(
          directory,
          repository,
          state,
          spec.template,
          connection,
          fixtureFiles,
        );
        return record(result, "identity check result");
      },
      deploy: (namespaceId: string, agentId: string) =>
        execute(
          join(bin, "occ"),
          ["--output", "json", "--namespace", namespaceId, "agent", "deploy", agentId],
          {
            cwd: repository,
            env,
          },
        ),
      kubernetesReads: api?.reads ?? [],
      executionReads: api?.executionReads ?? [],
      accessReviews: api?.reviews ?? [],
      run: (...extra: string[]) => {
        const result = execute(script, [...args, ...extra], {
          cwd: repository,
          env: { ...env, ...environment },
        });
        upgradeProcess = result.child;
        return result;
      },
      cleanup: (...extra: string[]) => {
        // Cleanup is a separate operator command with no deployment credentials,
        // image selection, or mutable values/Installation inputs.
        const cleanupEnv = { ...env, ...environment };
        delete cleanupEnv.OCC_URL;
        delete cleanupEnv.OCC_SERVICE_KEY_FILE;
        delete cleanupEnv.OCC_CA_BUNDLE;
        return execute(
          script,
          [
            "--cleanup-preflight",
            "--kubeconfig",
            join(directory, "kubeconfig"),
            "--context",
            "selected",
            "--namespace",
            "system",
            "--release",
            release,
            "--evidence-dir",
            evidence,
            ...extra,
          ],
          { cwd: repository, env: cleanupEnv },
        );
      },
      runWithStderr: (fd: number) =>
        spawnResult("/bin/bash", ["--", script, ...args], { cwd: repository, env }, fd),
      // Close the read end before launch; subprocess restores the CLI's default SIGPIPE.
      runWithBrokenPipe: () =>
        execute(
          "python3",
          [
            "-c",
            "import os, subprocess, sys; r, w = os.pipe(); os.close(r); p = subprocess.run(sys.argv[1:], stderr=w); sys.exit(p.returncode if p.returncode >= 0 else 128 - p.returncode)",
            script,
            ...args,
          ],
          { cwd: repository, env },
        ),
      state: readState,
      events: async () =>
        (await readFile(join(directory, "events"), "utf8")).trim().split("\n").filter(Boolean),
      failNext: (name: string) => writeFile(join(directory, name), ""),
    };
  };
}

export type RecoveryFixtureFactory = ReturnType<typeof createRecoveryFixture>;
export type RecoveryFixture = Awaited<ReturnType<RecoveryFixtureFactory>>;
