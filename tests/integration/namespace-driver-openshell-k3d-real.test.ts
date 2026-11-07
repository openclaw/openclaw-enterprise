import { boundedTeardown } from "../helpers/kubernetes-real.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { createRequire } from "node:module";
import type { OpenShellSandboxDriverOptions } from "../../apps/controller/src/drivers/sandbox/openshell.ts";

interface KubernetesObject {
  apiVersion: string;
  kind: string;
  metadata?: { name?: string; namespace?: string };
}
const require = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
const kubernetesRequire = createRequire(require.resolve("@kubernetes/client-node"));
const { loadAll } = kubernetesRequire("js-yaml") as { loadAll: (source: string) => unknown[] };
import { composeProduction } from "../../apps/controller/src/composition/production.ts";
import { loadInstallationConfiguration } from "../../apps/controller/src/composition/installation-config.ts";
import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import { OpenShellGateway } from "../../apps/controller/src/backends/openshell.ts";
import { GrpcOpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { kubernetesNamespaceName } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { createAuthenticatedControllerRequest } from "../helpers/auth-session.mjs";
import {
  developmentBootstrapEnvironment,
  runBootstrapInstallation,
} from "../helpers/bootstrap-installation.mjs";
import {
  createOpenShellInstallationConfiguration,
  createOpenShellKubernetesFixture,
  openshellHash,
  openShellChartImageValues,
  openShellGatewayNetworkPolicies,
} from "../helpers/openshell-kubernetes-real.mjs";
import { OPENSHELL_HARNESS_POD_LABEL_ALLOWLIST } from "../../apps/controller/src/drivers/sandbox/openshell.ts";
import { createScopedController } from "../helpers/openshell-sandbox-workflows.mjs";

const execute = promisify(execFile);
const selected = process.env.OCC_TEST_NAMESPACE_OPENSHELL_REAL === "1";

test(
  "bootstrap reconciles an owned OpenShell gateway and Workspace before any Agent, then initializes another Namespace",
  {
    skip: selected
      ? false
      : "Set OCC_TEST_NAMESPACE_OPENSHELL_REAL=1 with prepared disposable OpenShell infrastructure.",
    timeout: 900_000,
  },
  async (testContext) => {
    const { context } = boundedTeardown(testContext, { label: "Namespace lifecycle bootstrap" });
    const env = process.env;
    const fixture = createOpenShellKubernetesFixture({
      commandTimeoutMs: 60_000,
      signal: undefined,
      kubeconfigPath: env.OCC_TEST_KUBERNETES_KUBECONFIG,
      kubernetesContext: env.OCC_TEST_KUBERNETES_CONTEXT,
      databaseUrl: env.OCC_TEST_DATABASE_URL,
      gatewayImage: env.OCC_TEST_KUBERNETES_GATEWAY_IMAGE,
      codexImage: env.OCC_TEST_KUBERNETES_AGENT_IMAGE,
      openShellGatewayImage: env.OCC_TEST_OPENSHELL_GATEWAY_IMAGE,
      openShellSandboxImage: env.OCC_TEST_OPENSHELL_SANDBOX_IMAGE,
      openShellSupervisorImage: env.OCC_TEST_OPENSHELL_SUPERVISOR_IMAGE,
      openShellHelmPath: env.OCC_TEST_OPENSHELL_HELM,
      openShellHelmChart: env.OCC_TEST_OPENSHELL_HELM_CHART,
      openShellWorkspaceHelmChart: env.OCC_TEST_OPENSHELL_WORKSPACE_HELM_CHART,
      openShellRuntimeClass: env.OCC_TEST_OPENSHELL_RUNTIME_CLASS,
    });
    const kubeconfig = await fixture.validateOpenShellPrerequisites();
    const directory = await mkdtemp(join(tmpdir(), "oce-namespace-bootstrap-"));
    const platformNamespace = `oce-ns-${openshellHash(randomUUID())}`;
    const placements: string[] = [];
    context.after(async () => {
      for (const name of [...placements, platformNamespace]) {
        await fixture.kubectl(
          "delete",
          "namespace",
          name,
          "--ignore-not-found=true",
          "--wait=false",
        );
      }
      await rm(directory, { recursive: true, force: true });
    });
    await fixture.kubectl("create", "namespace", platformNamespace);
    const identity = await createScopedController(
      context,
      randomUUID(),
      platformNamespace,
      kubeconfig,
    );
    // Gateway workloads use the same tenant binding as other runtime workloads. No cluster-wide
    // workload permission is granted; RBAC prerequisites below remain operator-owned.
    await fixture.kubectl(
      "patch",
      "clusterrole",
      identity.tenantRole,
      "--type=json",
      "--patch",
      JSON.stringify([
        {
          op: "add",
          path: "/rules/-",
          value: {
            apiGroups: ["apps"],
            resources: ["statefulsets"],
            verbs: ["get", "list", "create", "patch", "delete"],
          },
        },
      ]),
    );
    await fixture.kubectl(
      "patch",
      "clusterrole",
      identity.tenantRole,
      "--type=json",
      "--patch",
      JSON.stringify([
        {
          op: "add",
          path: "/rules/-",
          value: { apiGroups: [""], resources: ["persistentvolumeclaims"], verbs: ["list"] },
        },
      ]),
    );
    const configuration = createOpenShellInstallationConfiguration({
      authentication: identity.authentication,
      platformNamespace,
      cluster: env.OCC_TEST_KUBERNETES_CONTEXT,
      gatewayImage: env.OCC_TEST_KUBERNETES_GATEWAY_IMAGE,
      codexImage: env.OCC_TEST_KUBERNETES_AGENT_IMAGE,
      openShellRuntimeClass: env.OCC_TEST_OPENSHELL_RUNTIME_CLASS,
    }) as ReturnType<typeof createOpenShellInstallationConfiguration> & {
      backend: { configuration: { serviceName: string; insecureTransport: string } }[];
      drivers: { sandbox: { configuration: OpenShellSandboxDriverOptions } };
    };
    const templateNamespace = "oce-namespace-template";
    const service = `openshell-${openshellHash(templateNamespace, 10)}`;
    const common = ["--namespace", templateNamespace, `--set-string=fullnameOverride=${service}`];
    const sandboxApis = String(await fixture.kubectl("api-versions"))
      .split("\n")
      .filter((version) => /^agents\.x-k8s\.io\/v1(?:alpha|beta)1$/.test(version));
    assert.ok(sandboxApis.length > 0, "the real cluster must serve Agent Sandbox before rendering");
    const render = async (chart: string, args: string[]) => {
      const { stdout } = await execute(
        env.OCC_TEST_OPENSHELL_HELM!,
        [
          "template",
          service,
          chart,
          ...common,
          ...sandboxApis.flatMap((version) => ["--api-versions", version]),
          ...args,
        ],
        { maxBuffer: 16 * 1024 * 1024 },
      );
      return loadAll(stdout).filter(Boolean) as KubernetesObject[];
    };
    // Rendering contributes configuration only. Neither Helm nor this test creates a gateway,
    // Service, gateway data volume, signing key, or Workspace.
    const gateway = await render(env.OCC_TEST_OPENSHELL_HELM_CHART!, [
      "--set=pkiInitJob.enabled=false",
      "--set=server.disableTls=true",
      "--set=server.auth.allowUnauthenticatedUsers=true",
      "--set=server.drivers.kubernetes.allowDriverConfig=true",
      "--set=server.drivers.kubernetes.resourceAdmission.enabled=false",
      "--set-string=server.drivers.kubernetes.workspaceMode=operator",
      "--set-string=server.drivers.kubernetes.operatorNamespaceLabel=openshell.ai/openclaw-workspace=true",
      "--set=workspaceResources.enabled=false",
      "--set=podSecurityContext.seccompProfile.type=RuntimeDefault",
      `--set-string=server.defaultRuntimeClassName=${env.OCC_TEST_OPENSHELL_RUNTIME_CLASS}`,
      `--set-json=gatewayConfig.openshell\\.drivers\\.kubernetes.allowed_pod_labels=${JSON.stringify(OPENSHELL_HARNESS_POD_LABEL_ALLOWLIST)}`,
      ...openShellChartImageValues("gateway.image", env.OCC_TEST_OPENSHELL_GATEWAY_IMAGE),
      ...openShellChartImageValues("sandboxRuntime.image", env.OCC_TEST_OPENSHELL_SANDBOX_IMAGE),
      ...openShellChartImageValues("supervisor.image", env.OCC_TEST_OPENSHELL_SUPERVISOR_IMAGE),
    ]);
    const workspace = await render(env.OCC_TEST_OPENSHELL_WORKSPACE_HELM_CHART!, [
      `--set-string=fullnameOverride=${service}-workspace`,
      "--set=gateway.allowDriverConfig=true",
      `--set-string=gateway.serviceAccount.name=${service}`,
      `--set-string=gateway.serviceAccount.namespace=${templateNamespace}`,
      `--set-string=gateway.networkPolicy.podSelector.app\\.kubernetes\\.io/instance=${service}`,
    ]);
    const operatorKinds = new Set(["Role", "RoleBinding", "ClusterRole", "ClusterRoleBinding"]);
    const prerequisites = [...gateway, ...workspace].filter((item) =>
      operatorKinds.has(item.kind!),
    );
    const clusterRoles = new Set(
      prerequisites
        .filter((object) => object.kind === "ClusterRole")
        .map((object) => object.metadata!.name!),
    );
    const clusterBindings = new Set<string>();
    const installedClusterRoles = new Set<string>();
    for (const object of prerequisites) {
      if (object.kind === "ClusterRole") {
        object.metadata!.name = `${platformNamespace}-${object.metadata!.name}`;
      }
      const roleRef = (object as KubernetesObject & { roleRef?: { kind: string; name: string } })
        .roleRef;
      if (roleRef?.kind === "ClusterRole" && clusterRoles.has(roleRef.name)) {
        roleRef.name = `${platformNamespace}-${roleRef.name}`;
      }
    }
    context.after(async () => {
      for (const name of clusterBindings) {
        await fixture.kubectl("delete", "clusterrolebinding", name, "--ignore-not-found=true");
      }
      for (const name of installedClusterRoles) {
        await fixture.kubectl("delete", "clusterrole", name, "--ignore-not-found=true");
      }
    });
    const runtime = [...gateway, ...workspace].filter((item) => !operatorKinds.has(item.kind!));
    const endpoints = (await fixture.resource("endpoints", "kubernetes", "default")) as {
      subsets: { addresses: { ip: string }[] }[];
    };
    const peers = endpoints.subsets.flatMap((subset) =>
      subset.addresses.map(({ ip }) => ({ ipBlock: { cidr: `${ip}/32` } })),
    );
    const templates = JSON.parse(
      JSON.stringify([
        ...runtime,
        ...openShellGatewayNetworkPolicies(templateNamespace, peers).items,
      ]).replaceAll(templateNamespace, "${OCE_NAMESPACE}"),
    );
    for (const object of templates) {
      if (object.kind === "Deployment" || object.kind === "StatefulSet") {
        object.spec.replicas = 0;
      }
    }
    Object.assign(configuration.drivers.sandbox.configuration.gateway, {
      namespaceGatewayResources: templates,
      operatorNamespaceLabels: { "openshell.ai/openclaw-workspace": "true" },
      readiness: {
        serviceName: service,
        podSelector: { "app.kubernetes.io/instance": service },
        timeoutMs: 30_000,
      },
    });
    configuration.backend[0]!.configuration = {
      serviceName: service,
      insecureTransport: "network-policy",
    };
    const startupPath = join(directory, "installation.json");
    const keyPath = join(directory, "gateway-key");
    await writeFile(startupPath, JSON.stringify(configuration), { mode: 0o600 });
    await writeFile(keyPath, randomBytes(32).toString("hex"), { mode: 0o600 });
    const credentials = {
      email: "namespace-bootstrap@example.test",
      password: randomBytes(24).toString("base64url"),
    };
    const authSecret = randomBytes(32).toString("hex");
    const authBaseURL = "http://127.0.0.1";
    const environment = { ...env, OCC_CONFIG_PATH: startupPath, OCC_GATEWAY_API_KEY_PATH: keyPath };
    const databaseUrl = env.OCC_TEST_DATABASE_URL!;
    const pool = new pg.Pool({ connectionString: databaseUrl });
    context.after(() => pool.end());
    assert.equal(
      (await pool.query("select count(*)::int as count from occ.installation")).rows[0].count,
      0,
      "bootstrap proof requires a fresh migrated database",
    );
    const bootstrap = await runBootstrapInstallation(
      developmentBootstrapEnvironment({
        databaseUrl,
        directory,
        ...credentials,
        authSecret,
        authBaseURL,
        installationName: "namespace-lifecycle",
        environment,
      }),
    );
    assert.equal(
      bootstrap.ok,
      true,
      "shipped bootstrap must succeed before provider infrastructure is available",
    );
    const initial = (await pool.query("select id, name, status from occ.namespaces")).rows;
    assert.equal(initial.length, 1);
    assert.equal(initial[0].name, "default");
    assert.equal(initial[0].status, "provisioning");
    const forwards = new Map<
      string,
      Promise<{ client: GrpcOpenShellGatewayClient; stop: () => Promise<void> }>
    >();
    const connected = (namespace: string) => {
      let pending = forwards.get(namespace);
      if (!pending) {
        pending = fixture.startPortForward(namespace, service).then((forward) => ({
          client: new GrpcOpenShellGatewayClient({ endpoint: forward.url }),
          stop: forward.stop,
        }));
        forwards.set(namespace, pending);
      }
      return pending;
    };
    context.after(async () => {
      for (const pending of forwards.values()) {
        const transport = await pending;
        transport.client.close();
        await transport.stop();
      }
    });
    // Only the transport changes for a loopback test process. Every RPC reaches the actual
    // gateway; Namespace setup, Workspace creation, and results come from shipped Drivers.
    const loadDrivers = async () =>
      (await loadInstallationConfiguration({
        mode: "production",
        environment,
        createOpenShellBackend(definition) {
          const client = new OpenShellGateway(definition.configuration);
          return {
            id: definition.id,
            drivers: definition.drivers,
            client: new Proxy(client, {
              get(target, property) {
                if (property === "clientForNamespace") {
                  return (namespace: string) =>
                    new Proxy(
                      {},
                      {
                        get(_target, operation: string) {
                          return async (...args: unknown[]) => {
                            const { client: gatewayClient } = await connected(namespace);
                            const method = Reflect.get(gatewayClient, operation) as (
                              ...args: unknown[]
                            ) => unknown;
                            return method.apply(gatewayClient, args);
                          };
                        },
                      },
                    );
                }
                const value = Reflect.get(target, property, target);
                return typeof value === "function" ? value.bind(target) : value;
              },
            }),
          };
        },
      }))!;
    const drivers = await loadDrivers();
    const startApi = (selectedDrivers: typeof drivers) =>
      composeProduction({
        mode: "production",
        host: "127.0.0.1",
        databaseUrl,
        authSecret,
        authBaseURL,
        drivers: selectedDrivers,
        gatewayApiKeyPath: keyPath,
      });
    let app = await startApi(drivers);
    context.after(() => app.close());
    let request = await createAuthenticatedControllerRequest(app, credentials, authBaseURL);
    const namespaceOutcomes: unknown[] = [];
    const startWorker = (selectedDrivers: typeof drivers) =>
      createControllerWorker({
        mode: "production",
        pool: new pg.Pool({ connectionString: databaseUrl }),
        drivers: selectedDrivers,
        pollIntervalMs: 100,
        leaseDurationMs: 10_000,
        maxAttempts: 40,
        emit: (event) => {
          if (event.event === "worker.completed") {
            namespaceOutcomes.push({
              operation: event.operation,
              code: event.code,
              reason: event.reason,
            });
          }
        },
      });
    let worker = startWorker(await loadDrivers());
    context.after(() => worker.stop());
    await worker.start();
    const prepareNamespace = async (id: string) => {
      const placement = kubernetesNamespaceName(id);
      placements.push(placement);
      assert.notEqual(placement, "default");
      await fixture.waitFor(
        "Compute creates the backing namespace",
        async () =>
          String(
            await fixture.kubectl(
              "get",
              "namespace",
              placement,
              "--ignore-not-found=true",
              "-o",
              "json",
            ),
          ).trim() || undefined,
      );
      // Operator grants are prerequisites. The test creates no gateway workload or Workspace.
      const prerequisitePath = join(directory, `${placement}-operator.json`);
      const objects = JSON.parse(
        JSON.stringify(prerequisites).replaceAll(templateNamespace, placement),
      ) as KubernetesObject[];
      for (const object of objects) {
        if (object.kind === "ClusterRole") {
          object.metadata!.name += `-${placement}`;
          installedClusterRoles.add(object.metadata!.name!);
        }
        const roleRef = (object as KubernetesObject & { roleRef?: { kind: string; name: string } })
          .roleRef;
        if (
          roleRef?.kind === "ClusterRole" &&
          [...clusterRoles].some((name) => roleRef.name === `${platformNamespace}-${name}`)
        ) {
          roleRef.name += `-${placement}`;
        }
        if (object.kind === "ClusterRoleBinding") {
          object.metadata!.name = `${platformNamespace}-${object.metadata!.name}-${placement}`;
          clusterBindings.add(object.metadata!.name);
        }
      }
      await writeFile(
        prerequisitePath,
        JSON.stringify({ apiVersion: "v1", kind: "List", items: objects }),
        { mode: 0o600 },
      );
      await fixture.kubectl("apply", "--namespace", placement, "-f", prerequisitePath);
      await fixture.kubectl(
        "create",
        "rolebinding",
        "namespace-lifecycle-worker",
        "--namespace",
        placement,
        `--clusterrole=${identity.tenantRole}`,
        `--serviceaccount=${platformNamespace}:${identity.account}`,
      );
      return placement;
    };
    const ready = async (id: string) => {
      const placement = await prepareNamespace(id);
      if (id === initial[0].id) {
        // Zero replicas makes real gateway readiness pending. Interrupt the worker, repair
        // configuration, and let a successor resume queued work without replacing its key.
        await fixture.waitFor("Driver-created gateway Service", () =>
          fixture.maybeResource("service", service, placement),
        );
        assert.equal((await request("GET", `/namespaces/${id}`)).data.status, "provisioning");
        assert.equal(
          (await pool.query("select count(*)::int as count from occ.agents")).rows[0].count,
          0,
        );
        const signingKey = await fixture.resource("secret", `${service}-jwt-keys`, placement);
        await worker.stop();
        for (const object of templates) {
          if (object.kind === "Deployment" || object.kind === "StatefulSet") {
            object.spec.replicas = 1;
          }
        }
        await writeFile(startupPath, JSON.stringify(configuration), { mode: 0o600 });
        worker = startWorker(await loadDrivers());
        await worker.start();
        assert.equal(
          (await fixture.resource("secret", `${service}-jwt-keys`, placement)).metadata.uid,
          signingKey.metadata.uid,
        );
      }
      await fixture.waitFor(
        "all Namespace participants complete",
        async () => {
          const observed = await request("GET", `/namespaces/${id}`);
          assert.equal(observed.status, 200);
          assert.notEqual(observed.data.status, "failed", JSON.stringify(namespaceOutcomes));
          return observed.data.status === "ready" ? true : undefined;
        },
        300_000,
      );
      assert.equal(
        (await pool.query("select count(*)::int as count from occ.agents")).rows[0].count,
        0,
        "both gateway and Workspace must precede every Agent",
      );
      const serviceResource = await fixture.resource("service", service, placement);
      assert.equal(serviceResource.metadata.labels["openclaw.dev/namespace"], id);
      const pods = (await fixture.resources("pods", placement)) as {
        metadata: { labels?: Record<string, string> };
        spec: { containers: { image: string }[] };
        status?: { conditions?: { type: string; status: string }[] };
      }[];
      assert.ok(
        pods.some(
          (pod) =>
            pod.metadata.labels?.["app.kubernetes.io/instance"] === service &&
            pod.metadata.labels?.["openclaw.dev/namespace"] === id &&
            pod.metadata.labels?.["openclaw.dev/namespace-gateway"] === "true" &&
            pod.spec.containers.some(({ image }) =>
              image.endsWith(`@${env.OCC_TEST_OPENSHELL_GATEWAY_IMAGE!.split("@")[1]}`),
            ) &&
            pod.status?.conditions?.some(
              (condition) => condition.type === "Ready" && condition.status === "True",
            ),
        ),
      );
      const { client } = await connected(placement);
      await client.health(AbortSignal.timeout(10_000));
      const workspace = await client.getWorkspace(placement, AbortSignal.timeout(10_000));
      assert.ok(workspace);
      assert.equal(workspace.labels["openclaw.dev/namespace-id"], id);
      return placement;
    };
    await ready(initial[0].id);
    const later = await request("POST", "/namespaces", { name: "later" });
    assert.equal(later.status, 201);
    assert.notEqual(await ready(later.data.id), kubernetesNamespaceName(initial[0].id));

    // IAM denial must commit audit evidence without queuing or provisioning a Namespace.
    const ungranted = {
      email: "ungranted@example.test",
      password: randomBytes(24).toString("base64url"),
    };
    const ungrantedAccount = await request("POST", "/api/auth/accounts", ungranted);
    assert.equal(ungrantedAccount.status, 201);
    const ungrantedRequest = await createAuthenticatedControllerRequest(
      app,
      ungranted,
      authBaseURL,
    );
    const workBefore = (
      await pool.query(
        "select count(*)::int as count from occ.controller_work where work_kind = 'namespace'",
      )
    ).rows[0].count;
    assert.equal((await ungrantedRequest("POST", "/namespaces", { name: "denied" })).status, 403);
    assert.equal(
      (await pool.query("select count(*)::int as count from occ.namespaces where name = 'denied'"))
        .rows[0].count,
      0,
    );
    assert.equal(
      (
        await pool.query(
          "select count(*)::int as count from occ.controller_work where work_kind = 'namespace'",
        )
      ).rows[0].count,
      workBefore,
    );
    assert.ok(
      (
        await pool.query(
          "select id from occ.audit_events where actor_id = $1 and outcome = 'denied'",
          [ungrantedAccount.data.principalId],
        )
      ).rows.length > 0,
    );

    // Apply a real Installation IAM configuration, then remove its grant while queued
    // work is paused. Account disable is a sign-in control, not an IAM grant revocation.
    await worker.stop();
    const accessPolicy = {
      roles: [{ id: "namespace_creator", permissions: ["namespace:create"] }],
      defaultUserGroups: ["namespace-creators"],
      roleBindings: [
        { group: "namespace-creators", role: "namespace_creator", scope: "installation" },
      ],
    };
    Object.assign(configuration, { iam: accessPolicy });
    await writeFile(startupPath, JSON.stringify(configuration), { mode: 0o600 });
    await app.close();
    app = await startApi(await loadDrivers());
    request = await createAuthenticatedControllerRequest(app, credentials, authBaseURL);
    const queuedActor = {
      email: "queued-actor@example.test",
      password: randomBytes(24).toString("base64url"),
    };
    const queuedAccount = await request("POST", "/api/auth/accounts", queuedActor);
    assert.equal(queuedAccount.status, 201);
    const queuedRequest = await createAuthenticatedControllerRequest(app, queuedActor, authBaseURL);
    const revoked = await queuedRequest("POST", "/namespaces", { name: "revoked-before-dispatch" });
    assert.equal(revoked.status, 201);
    placements.push(kubernetesNamespaceName(revoked.data.id));
    accessPolicy.roleBindings = [];
    await writeFile(startupPath, JSON.stringify(configuration), { mode: 0o600 });
    await app.close();
    app = await startApi(await loadDrivers());
    request = await createAuthenticatedControllerRequest(app, credentials, authBaseURL);
    worker = startWorker(await loadDrivers());
    await worker.start();
    await fixture.waitFor("revoked queued actor fails before infrastructure", async () => {
      const observed = (
        await pool.query(
          "select state, actor_id from occ.controller_work where namespace_id = $1 and namespace_target = 'ready'",
          [revoked.data.id],
        )
      ).rows[0];
      assert.equal(observed.actor_id, queuedAccount.data.principalId);
      return observed.state === "failed_permanent" ? true : undefined;
    });
    assert.equal(
      String(
        await fixture.kubectl(
          "get",
          "namespace",
          kubernetesNamespaceName(revoked.data.id),
          "--ignore-not-found=true",
          "-o",
          "json",
        ),
      ).trim(),
      "",
    );
    assert.ok(
      (
        await pool.query(
          "select id from occ.audit_events where namespace_id = $1 and actor_id = $2 and outcome = 'denied'",
          [revoked.data.id, queuedAccount.data.principalId],
        )
      ).rows.length > 0,
    );

    // Kubernetes quota is a real provider refusal after owned Secrets have been created.
    // Deleting this partial setup must remove those resources without requiring a gateway.
    await worker.stop();
    const originalQuota = structuredClone(
      configuration.drivers.compute.configuration.resources.namespace.quota,
    );
    Object.assign(configuration.drivers.compute.configuration.resources.namespace.quota, {
      services: "0",
    });
    await writeFile(startupPath, JSON.stringify(configuration), { mode: 0o600 });
    worker = startWorker(await loadDrivers());
    await worker.start();
    const refused = await request("POST", "/namespaces", { name: "quota-refused" });
    assert.equal(refused.status, 201);
    const refusedPlacement = await prepareNamespace(refused.data.id);
    await fixture.waitFor("provider refusal blocks readiness", async () => {
      const observed = await request("GET", `/namespaces/${refused.data.id}`);
      assert.equal(observed.status, 200);
      assert.notEqual(observed.data.status, "ready");
      return observed.data.status === "failed" ? true : undefined;
    });
    assert.ok(await fixture.maybeResource("secret", `${service}-jwt-keys`, refusedPlacement));
    assert.equal(await fixture.maybeResource("service", service, refusedPlacement), undefined);
    const remove = async (id: string) => {
      assert.equal((await request("DELETE", `/namespaces/${id}`)).status, 202);
      await fixture.waitFor("Namespace cleanup completes through the worker", async () => {
        if ((await request("GET", `/namespaces/${id}`)).status === 404) {
          return true;
        }
        const work = (
          await pool.query(
            "select state from occ.controller_work where namespace_id = $1 and namespace_target = 'deleted'",
            [id],
          )
        ).rows[0];
        assert.notEqual(
          work?.state,
          "failed_permanent",
          JSON.stringify(namespaceOutcomes.slice(-5)),
        );
        return undefined;
      });
      assert.equal(
        String(
          await fixture.kubectl(
            "get",
            "namespace",
            kubernetesNamespaceName(id),
            "--ignore-not-found=true",
            "-o",
            "json",
          ),
        ).trim(),
        "",
      );
    };
    await remove(refused.data.id);
    await worker.stop();
    configuration.drivers.compute.configuration.resources.namespace.quota = originalQuota;
    await writeFile(startupPath, JSON.stringify(configuration), { mode: 0o600 });
    worker = startWorker(await loadDrivers());
    await worker.start();
    await remove(later.data.id);
    const remaining = await connected(kubernetesNamespaceName(initial[0].id));
    await remaining.client.health(AbortSignal.timeout(10_000));
    assert.ok(
      await remaining.client.getWorkspace(
        kubernetesNamespaceName(initial[0].id),
        AbortSignal.timeout(10_000),
      ),
    );
    assert.equal(
      (await pool.query("select count(*)::int as count from occ.agents")).rows[0].count,
      0,
    );
  },
);
