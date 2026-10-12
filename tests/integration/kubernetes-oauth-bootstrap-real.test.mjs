import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import test, { after } from "node:test";
import { createKubernetesClient } from "../helpers/kubernetes-real.mjs";
import { createGatewayNodeEnrollment } from "../../apps/controller/src/gateway/node-enrollment-client.ts";
import {
  kubeconfigPath,
  kubernetesContext,
  fixtureImage,
  fixtureComputeConfiguration,
  requiresKubernetesAndPostgres,
  hash,
  kubectl,
  kubectlRead,
  resource,
  resources,
  missing,
  waitFor,
  harnessWorkspaceClaimName,
  revisionName,
  createDriver,
  createScopedController,
  createProvisioningApiFixture,
  assertKubernetesFixtureAvailable,
  createNamespaceReaper,
} from "../helpers/kubernetes-compute-real.mjs";

const { deleteNamespaces, waitForDeletedVolumes } = createNamespaceReaper();
after(waitForDeletedVolumes);

test(
  "PostgreSQL API and worker complete OAuth bootstrap Jobs and retire exhausted Jobs on real Kubernetes",
  { ...requiresKubernetesAndPostgres, timeout: 300_000 },
  async (context) => {
    await assertKubernetesFixtureAvailable();
    const { applyManifest } = createKubernetesClient({
      selection: { kubeconfigPath, kubernetesContext },
    });
    const installationId = `ins_${randomUUID()}`;
    const platformNamespace = `oce-oauth-${hash(installationId)}`;
    await kubectl("create", "namespace", platformNamespace);
    context.after(() => deleteNamespaces(platformNamespace));
    const controller = await createScopedController(context, installationId, platformNamespace);
    // Before serving, Compute checks for obsolete routes even in this fixture
    // cluster without an installed Gateway API; grant only lookup and retirement.
    await kubectl(
      "patch",
      "clusterrole",
      controller.tenantRole,
      "--type=json",
      "--patch",
      JSON.stringify(
        [
          ["gateway.networking.k8s.io", "httproutes"],
          ["gateway.envoyproxy.io", "securitypolicies"],
        ]
          .map(([group, name]) => ({
            op: "add",
            path: "/rules/-",
            value: {
              apiGroups: [group],
              resources: [name],
              verbs: ["get", "delete"],
            },
          }))
          .concat(
            {
              op: "add",
              path: "/rules/-",
              value: { apiGroups: [""], resources: ["pods/log"], verbs: ["get"] },
            },
            {
              op: "add",
              path: "/rules/-",
              value: { apiGroups: [""], resources: ["events"], verbs: ["get", "list"] },
            },
          ),
      ),
    );
    const { driver, kubernetesNamespaceName } = await createDriver(
      {
        authentication: controller.authentication,
        resources: {
          ...fixtureComputeConfiguration().resources,
          agent: {
            requests: { cpu: "0.025", memory: "48Mi" },
            limits: { cpu: "0.25", memory: "1.5Gi" },
          },
        },
        network: {
          dns: { namespace: "kube-system", podLabels: { "k8s-app": "kube-dns" } },
          gatewayPort: 8080,
          gatewayTrustedProxyCidrs: ["127.0.0.1/32"],
        },
        gatewayRouting: {
          gatewayName: `oce-agent-gateways-${hash(installationId, 8)}`,
          gatewayNamespace: platformNamespace,
          envoyNamespace: platformNamespace,
        },
        runtime: { transportSecretPrefix: "transport", gatewayStorageClassName: "local-path" },
      },
      {
        nodeEnrollment: createGatewayNodeEnrollment(async () => "fixture-node-enrollment-api-key"),
      },
    );
    const workerEvents = [];
    const fixture = await createProvisioningApiFixture(context, driver, controller.authentication, {
      emit: (event) => workerEvents.push(event),
    });
    context.after(() =>
      deleteNamespaces(...fixture.bootstrapNamespaceIds.map(kubernetesNamespaceName)),
    );
    const createdNamespace = await fixture.request("POST", "/namespaces", {
      name: `OAuth Jobs ${randomUUID().slice(0, 8)}`,
    });
    assert.equal(createdNamespace.status, 201, JSON.stringify(createdNamespace.body));
    const namespaceId = createdNamespace.data.id;
    const placement = kubernetesNamespaceName(namespaceId);
    context.after(() => deleteNamespaces(placement));
    await fixture.startWorker();
    await waitFor("OAuth tenant namespace", async () => !(await missing("namespace", placement)));
    await kubectl(
      "create",
      "rolebinding",
      "openclaw-controller",
      "--namespace",
      placement,
      `--clusterrole=${controller.tenantRole}`,
      `--serviceaccount=${platformNamespace}:${controller.account}`,
    );
    await waitFor(
      "OAuth tenant readiness",
      async () =>
        (await fixture.request("GET", `/namespaces/${namespaceId}`)).data.status === "ready",
    );
    await fixture.stopWorker();

    // Only device-provider HTTP is simulated. The API, IAM, Secret Driver,
    // worker, Kubernetes Job controller, PVC, and actual seed writer are real.
    // The fixture has no Codex/model runtime and must not establish live OAuth proof.
    const tokens = {
      id_token: `e30.${Buffer.from("{}").toString("base64url")}.fixture`,
      access_token: "oauth-k3d-synthetic-access",
      refresh_token: "oauth-k3d-synthetic-refresh",
    };
    const originalFetch = globalThis.fetch;
    context.mock.method(globalThis, "fetch", (url, init) => {
      switch (String(url)) {
        case "https://auth.openai.com/api/accounts/deviceauth/usercode":
          return Promise.resolve(
            Response.json({
              device_auth_id: "fixture-device",
              user_code: "TEST-1234",
              interval: "1",
            }),
          );
        case "https://auth.openai.com/api/accounts/deviceauth/token":
          return Promise.resolve(
            Response.json({
              authorization_code: "fixture-code",
              code_verifier: "fixture-verifier",
            }),
          );
        case "https://auth.openai.com/oauth/token":
          return Promise.resolve(Response.json(tokens));
        default:
          return originalFetch(url, init);
      }
    });
    const basePath = `/namespaces/${namespaceId}`;
    async function login() {
      const started = await fixture.request("POST", `${basePath}/agents/device-authorizations`, {
        harnessId: "codex",
      });
      assert.equal(started.status, 200, JSON.stringify(started.body));
      await waitFor("synthetic device authorization", async () => {
        const polled = await fixture.request(
          "POST",
          `${basePath}/agents/device-authorizations/${started.data.source.id}/poll`,
          {},
        );
        assert.equal(polled.status, 200, JSON.stringify(polled.body));
        return polled.data.status === "ready";
      });
      return started.data.source;
    }
    const source = await login();
    const configuration = await fixture.request("POST", `${basePath}/configurations`, {
      kind: "agent",
      values: {
        gateway: { controlUi: { enabled: false } },
        agents: {
          defaults: {
            model: "codex/gpt-5.1",
            models: { "codex/gpt-5.1": { agentRuntime: { id: "codex" } } },
          },
        },
      },
    });
    assert.equal(configuration.status, 201, JSON.stringify(configuration.body));
    const createdAgent = await fixture.request("POST", `${basePath}/agents`, {
      name: "OAuth bootstrap fixture",
      configurationId: configuration.data.id,
      executionMode: "dedicated",
      harnessAuth: { method: "oauth", source },
    });
    assert.equal(createdAgent.status, 201, JSON.stringify(createdAgent.body));
    const agent = createdAgent.data;
    const agentPath = `${basePath}/agents/${agent.id}`;
    const role = await fixture.request("POST", `${basePath}/iam/roles`, {
      name: "OAuth fixture Secret operation",
      permissions: [{ action: "operate", resourceKind: "secret" }],
    });
    assert.equal(role.status, 201, JSON.stringify(role.body));
    async function grantSource(selected) {
      const binding = await fixture.request("POST", `${basePath}/iam/access-bindings`, {
        subjectKind: "identity",
        subjectId: agent.servicePrincipalId,
        roleId: role.data.id,
        resourceKind: "secret",
        resourceId: selected.id,
      });
      assert.equal(binding.status, 201, JSON.stringify(binding.body));
    }
    await grantSource(source);

    // A watch retains terminal evidence even when the worker erases the Job
    // between polling passes; it contains metadata and conditions, never tokens.
    const require = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
    const { KubeConfig, Watch } = require("@kubernetes/client-node");
    const kubeconfig = new KubeConfig();
    kubeconfig.loadFromFile(kubeconfigPath);
    kubeconfig.setCurrentContext(kubernetesContext);
    const observations = [];
    let watchError;
    const watcher = new Watch(kubeconfig);
    watcher.requestTimeoutMs = 300_000;
    const watch = await watcher.watch(
      `/apis/batch/v1/namespaces/${placement}/jobs`,
      { labelSelector: `openclaw.dev/agent=${agent.id}` },
      (_type, job) => observations.push(structuredClone(job)),
      (error) => {
        watchError = error;
      },
    );
    context.after(() => watch.abort());
    async function sourceObject(selected) {
      return (await resources("secrets", placement)).find(
        ({ metadata }) => metadata.annotations?.["openclaw.dev/secret-id"] === selected.id,
      );
    }
    async function deploy() {
      const response = await fixture.request("POST", `${agentPath}/deploy`);
      assert.equal(response.status, 202, JSON.stringify(response.body));
      return response.data;
    }
    function jobFor(candidate, condition) {
      return observations.find(
        (job) =>
          job.metadata.labels["openclaw.dev/revision"] === candidate.id &&
          job.status?.conditions?.some(
            ({ type, status }) => type === condition && status === "True",
          ),
      );
    }
    const first = await deploy();
    await fixture.startWorker();
    const initialJob = await waitFor("bootstrap Job admission", async () =>
      observations.find((job) => job.metadata.labels["openclaw.dev/revision"] === first.id),
    );
    await fixture.stopWorker();
    assert.equal(
      (await sourceObject(source)).metadata.annotations["openclaw.dev/oauth-phase"],
      "claimed",
    );
    // Recreate an unfinished Deployment-era handoff from its actual credential writer
    // template. The old writer stays alive after writing and still mounts the same seed/PVC.
    // Resumed preparation must stop it before the replacement Job touches that volume.
    await kubectl(
      "delete",
      "job",
      initialJob.metadata.name,
      "--namespace",
      placement,
      "--cascade=foreground",
      "--wait=true",
    );
    const oldTemplate = structuredClone(initialJob.spec.template);
    delete oldTemplate.metadata.labels["batch.kubernetes.io/controller-uid"];
    delete oldTemplate.metadata.labels["batch.kubernetes.io/job-name"];
    delete oldTemplate.metadata.labels["controller-uid"];
    delete oldTemplate.metadata.labels["job-name"];
    oldTemplate.spec.restartPolicy = "Always";
    oldTemplate.spec.containers[0].args[0] += "\nsetInterval(() => {}, 60000);";
    await applyManifest(
      JSON.stringify({
        apiVersion: "apps/v1",
        kind: "Deployment",
        metadata: {
          name: initialJob.metadata.name,
          namespace: placement,
          labels: initialJob.metadata.labels,
          annotations: initialJob.metadata.annotations,
        },
        spec: {
          replicas: 1,
          strategy: { type: "Recreate" },
          selector: { matchLabels: { "app.kubernetes.io/name": initialJob.metadata.name } },
          template: oldTemplate,
        },
      }),
    );
    await kubectl(
      "rollout",
      "status",
      `deployment/${initialJob.metadata.name}`,
      "--namespace",
      placement,
      "--timeout=60s",
    );
    await fixture.startWorker();
    // Stop at the bootstrap handoff boundary: this fixture deliberately has no
    // native Codex or private Gateway route, so it cannot prove runtime activation.
    await waitFor("Job completion and source consumption before native startup", async () => {
      assert.equal(watchError, undefined);
      const status = await fixture.request("GET", `${agentPath}/deployments/${first.id}`);
      assert.notEqual(
        status.data.status,
        "failed",
        JSON.stringify(
          workerEvents.filter(({ event }) => event === "worker.compute-prepare-failed"),
        ),
      );
      return (
        jobFor(first, "Complete") !== undefined &&
        (await sourceObject(source))?.metadata.annotations?.["openclaw.dev/oauth-phase"] ===
          "consumed" &&
        (await missing("job", jobFor(first, "Complete").metadata.name, placement)) &&
        (await missing("secret", jobFor(first, "Complete").metadata.name, placement))
      );
    }).catch(async (error) => {
      const deployment = await fixture.request("GET", `${agentPath}/deployments/${first.id}`);
      const pods = (await resources("pods", placement)).map(({ metadata, status }) => ({
        name: metadata.name,
        status,
      }));
      throw new Error(
        JSON.stringify({
          deployment: deployment.body,
          pods,
          jobs: observations.map(({ metadata, status }) => ({ name: metadata.name, status })),
        }),
        { cause: error },
      );
    });
    await fixture.stopWorker();
    const completedJob = jobFor(first, "Complete");
    assert.equal(await missing("deployment", completedJob.metadata.name, placement), true);
    // The real API canonicalizes 1.5Gi; ownership comparison must accept its value.
    assert.equal(completedJob.spec.template.spec.containers[0].resources.limits.memory, "1536Mi");
    assert.equal(completedJob.spec.backoffLimit, 2);
    assert.equal(completedJob.spec.activeDeadlineSeconds, 300);
    assert.equal(completedJob.spec.template.spec.restartPolicy, "Never");
    assert.equal(
      completedJob.spec.template.metadata.labels["openclaw.dev/network-profile"],
      undefined,
    );
    assert.equal(completedJob.spec.template.spec.automountServiceAccountToken, false);
    const consumed = JSON.parse(
      Buffer.from((await sourceObject(source)).data.value, "base64").toString("utf8"),
    );
    assert.equal(consumed.phase, "consumed");
    assert.equal(consumed.credential, undefined);
    const claim = await resource(
      "persistentvolumeclaim",
      harnessWorkspaceClaimName(agent.id),
      placement,
    );
    assert.equal(consumed.volumeUid, claim.metadata.uid);
    for (const kind of ["job", "secret"]) {
      assert.equal(await missing(kind, completedJob.metadata.name, placement), true);
    }
    assert.equal(
      (await resources("pods", placement)).some(
        ({ metadata }) => metadata.labels?.["job-name"] === completedJob.metadata.name,
      ),
      false,
    );

    // Inspect private disk with an isolated nonroot Pod. The fixture image cannot
    // refresh tokens, and this Pod receives no source or model credential Secret.
    const inspector = `oauth-inspect-${hash(agent.id)}`;
    await applyManifest(
      JSON.stringify({
        apiVersion: "v1",
        kind: "Pod",
        metadata: { name: inspector, namespace: placement },
        spec: {
          restartPolicy: "Never",
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
              name: "inspect",
              image: fixtureImage,
              imagePullPolicy: "IfNotPresent",
              command: ["node", "-e", "setInterval(() => {}, 1000)"],
              volumeMounts: [{ name: "private-state", mountPath: "/state" }],
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ["ALL"] },
              },
            },
          ],
          volumes: [
            { name: "private-state", persistentVolumeClaim: { claimName: claim.metadata.name } },
          ],
        },
      }),
    );
    await kubectl(
      "wait",
      "pod",
      inspector,
      "--namespace",
      placement,
      "--for=condition=Ready",
      "--timeout=60s",
    );
    const inspected = await kubectlRead(
      "exec",
      inspector,
      "--namespace",
      placement,
      "--",
      "node",
      "-e",
      `
      const fs = require("node:fs"); const auth = JSON.parse(fs.readFileSync("/state/codex-home/auth.json", "utf8"));
      const receipt = JSON.parse(fs.readFileSync("/state/codex-home/.oce-oauth.json", "utf8"));
      process.stdout.write(JSON.stringify({valid: auth.auth_mode === "chatgpt" && auth.tokens.access_token === ${JSON.stringify(tokens.access_token)}, receipt}));`,
    );
    assert.equal(JSON.parse(inspected).valid, true);
    assert.deepEqual(JSON.parse(inspected).receipt, {
      sourceUid: (await sourceObject(source)).metadata.uid,
      volumeUid: claim.metadata.uid,
    });

    // A planted lock symlink is an actual filesystem failure for the seed writer.
    // Kubernetes must spend its finite retry budget without ever consuming this source.
    await kubectl(
      "exec",
      inspector,
      "--namespace",
      placement,
      "--",
      "node",
      "-e",
      `
      const fs = require("node:fs"); fs.unlinkSync("/state/codex-home/.oce-oauth-bootstrap.lock");
      fs.symlinkSync("auth.json", "/state/codex-home/.oce-oauth-bootstrap.lock");`,
    );
    const replacement = await login();
    await grantSource(replacement);
    const patched = await fixture.request("PATCH", agentPath, {
      configurationId: configuration.data.id,
      harnessAuth: { method: "oauth", source: replacement },
    });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    const failedRevision = await deploy();
    await fixture.startWorker();
    await waitFor("replacement bootstrap Job admission", async () =>
      observations.some(
        (job) => job.metadata.labels["openclaw.dev/revision"] === failedRevision.id,
      ),
    );
    await fixture.stopWorker();
    await waitFor("actual bootstrap writer retry exhaustion", async () =>
      jobFor(failedRevision, "Failed"),
    );
    // Before retirement, the ordinary runtime API offers the actual main and init
    // containers. Reading one exact owned stream still uses IAM, redaction and audit.
    const runtime = await fixture.request(
      "GET",
      `${agentPath}/deployments/${failedRevision.id}/runtime`,
    );
    assert.equal(runtime.status, 200, JSON.stringify(runtime.body));
    const streams = runtime.data.sources.find(({ id }) => id === "agent").pods;
    const writer = streams.find(({ container }) => container === "oauth-bootstrap");
    const initializer = streams.find(({ container }) => container === "prepare-oauth-home");
    assert.ok(writer);
    assert.ok(initializer);
    for (const stream of [writer, initializer]) {
      const logs = await fixture.request(
        "GET",
        `${agentPath}/deployments/${failedRevision.id}/runtime/logs?source=agent&pod=${stream.name}&container=${stream.container}`,
      );
      assert.equal(logs.status, 200, JSON.stringify(logs.body));
      assert.equal(logs.data.stream.container, stream.container);
      assert.doesNotMatch(JSON.stringify(logs.body), /oauth-k3d-synthetic-(access|refresh)/);
    }
    const refusedContainer = await fixture.request(
      "GET",
      `${agentPath}/deployments/${failedRevision.id}/runtime/logs?source=agent&pod=${writer.name}&container=not-owned`,
    );
    assert.equal(refusedContainer.status, 400);
    await fixture.startWorker();
    await waitFor("exhausted bootstrap to fail deployment and finish durable cleanup", async () => {
      const status = await fixture.request("GET", `${agentPath}/deployments/${failedRevision.id}`);
      assert.equal(status.status, 200, JSON.stringify(status.body));
      if (status.data.status === "failed") {
        assert.equal(
          status.data.error.code,
          "HARNESS_CREDENTIAL_BOOTSTRAP_FAILED",
          JSON.stringify(status.body),
        );
      }
      return (
        status.data.status === "failed" &&
        (
          await fixture.readWork(
            `agent_revision:${failedRevision.id}:repository_cleanup:retire:${hash(failedRevision.id, 64)}`,
          )
        )?.state === "succeeded"
      );
    });
    const failedJob = jobFor(failedRevision, "Failed");
    assert.ok(failedJob);
    assert.equal(
      failedJob.status.conditions.find(({ type }) => type === "Failed").reason,
      "BackoffLimitExceeded",
    );
    assert.equal(
      new Set(
        observations
          .filter(({ metadata }) => metadata.labels["openclaw.dev/revision"] === failedRevision.id)
          .map(({ metadata }) => metadata.uid),
      ).size,
      1,
    );
    const status = await fixture.request("GET", `${agentPath}/deployments/${failedRevision.id}`);
    assert.equal(status.data.error.code, "HARNESS_CREDENTIAL_BOOTSTRAP_FAILED");
    assert.equal(status.data.cleanup.status, "succeeded");
    const evidence = status.data.error.data.preparation;
    assert.equal(evidence.workload.uid, failedJob.metadata.uid);
    assert.equal(evidence.reason, "retry_limit");
    assert.ok(
      evidence.pods.some((pod) =>
        pod.containers.some(
          (container) => container.name === "oauth-bootstrap" && container.exitCode === 1,
        ),
      ),
    );
    assert.doesNotMatch(
      JSON.stringify(evidence),
      /oauth-k3d-synthetic-(access|refresh)|credential|message|auth.json/,
    );

    assert.equal(
      (await sourceObject(replacement)).metadata.annotations["openclaw.dev/oauth-phase"],
      "claimed",
    );
    assert.equal(await missing("deployment", revisionName(failedRevision), placement), true);
    for (const kind of ["job", "secret"]) {
      assert.equal(await missing(kind, failedJob.metadata.name, placement), true);
    }
    assert.equal(
      (await resources("pods", placement)).some(
        ({ metadata }) => metadata.labels?.["job-name"] === failedJob.metadata.name,
      ),
      false,
    );
    assert.equal(
      (await resource("persistentvolumeclaim", claim.metadata.name, placement)).metadata.uid,
      claim.metadata.uid,
    );
    await fixture.stopWorker();
    await fixture.startWorker();
    assert.equal(
      (await fixture.request("GET", `${agentPath}/deployments/${failedRevision.id}`)).data.status,
      "failed",
    );
    assert.equal(await missing("job", failedJob.metadata.name, placement), true);
    const recovered = await fixture.request("GET", `${agentPath}/deployments/${failedRevision.id}`);
    assert.deepEqual(recovered.data.error.data.preparation, evidence);
    assert.equal(recovered.data.cleanup.status, "succeeded");
    await fixture.stopWorker();
  },
);
