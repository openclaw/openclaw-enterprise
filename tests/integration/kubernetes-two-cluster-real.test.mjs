import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createKubernetesClient,
  validateExplicitK3dLoopbackContext,
} from "../helpers/kubernetes-real.mjs";

const execute = promisify(execFile);
const configurationFile = process.env.OCC_TEST_TWO_CLUSTER_CONFIG;

test(
  "installed OCE owns Gateway and Harness lifecycles across two real clusters",
  { skip: configurationFile === undefined, timeout: 900_000 },
  async (t) => {
    // The selected fixture is a complete Helm-installed OCE, with separate API
    // and worker credentials. Neither the controller nor its Drivers are mocked.
    const configuration = JSON.parse(await readFile(configurationFile, "utf8"));
    const origin = new URL(configuration.apiUrl);
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname));
    assert.ok(["http:", "https:"].includes(origin.protocol));
    assert.equal(origin.username + origin.password + origin.search + origin.hash, "");
    const authMethod = configuration.harnessAuthMethod ?? "api_key";
    assert.ok(["api_key", "codex_pat"].includes(authMethod), "Unsupported harnessAuthMethod.");
    const modelEnvironment = authMethod === "codex_pat" ? "CODEX_ACCESS_TOKEN" : "OPENAI_API_KEY";
    const modelCredential = process.env[modelEnvironment];
    assert.ok(modelCredential, `The selected real-runtime case requires ${modelEnvironment}.`);
    const key = JSON.parse(await readFile(configuration.serviceKeyFile, "utf8")).data.key;
    assert.equal(typeof key, "string");
    const planes = {};
    for (const plane of ["control", "execution"]) {
      await validateExplicitK3dLoopbackContext(configuration[plane]);
      planes[plane] = createKubernetesClient({
        selection: configuration[plane],
        waitTimeoutMs: 420_000,
      });
    }
    const cp = planes.control;
    const dp = planes.execution;
    const cpIdentity = await cp.resource("namespace", "kube-system");
    const dpIdentity = await dp.resource("namespace", "kube-system");
    assert.notEqual(cpIdentity.metadata.uid, dpIdentity.metadata.uid);

    assert.equal(
      typeof configuration.dockerContext,
      "string",
      "Select the owned local Docker context explicitly.",
    );
    const docker = async (...args) =>
      (
        await execute("docker", ["--context", configuration.dockerContext, ...args], {
          timeout: 30_000,
        })
      ).stdout;
    const dockerContext = JSON.parse(
      await docker("context", "inspect", configuration.dockerContext),
    )[0];
    assert.ok(
      dockerContext.Endpoints.docker.Host.startsWith("unix://"),
      "The outage test only operates on a local Docker VM.",
    );
    const executionNode = `${configuration.execution.kubernetesContext}-server-0`;
    const inspected = JSON.parse(await docker("inspect", executionNode))[0];
    assert.equal(
      inspected.Config.Labels["k3d.cluster"],
      configuration.execution.kubernetesContext.slice(4),
    );
    assert.equal(inspected.State.Running, true);
    const executionContainerId = inspected.Id;

    async function api(method, path, body) {
      const response = await fetch(new URL(path, origin), {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
        headers: {
          "x-api-key": key,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (response.status === 204) {
        return undefined;
      }
      const envelope = await response.json();
      assert.ok(response.ok, `${method} ${path}: ${response.status} ${envelope.error?.code}`);
      return envelope.data;
    }

    const tenant = await api("POST", "/namespaces", { name: `two-cluster-${randomUUID()}` });
    const base = `/namespaces/${tenant.id}`;
    const namespaces = {};
    // Admin grants are deliberately outside OCC worker authority. The worker
    // must wait for each grant and cannot create or escalate its own RoleBindings.
    for (const plane of ["execution", "control"]) {
      const client = planes[plane];
      const label = plane === "control" ? "gateway-namespace" : "namespace";
      namespaces[plane] = await client.waitFor(`${plane} tenant namespace`, async () => {
        const result = JSON.parse(
          await client.kubectl(
            "get",
            "namespaces",
            "-l",
            `openclaw.dev/${label}=${tenant.id}`,
            "-o",
            "json",
          ),
        ).items;
        assert.ok(result.length <= 1);
        return result[0]?.metadata.name;
      });
      const release = configuration[plane].release;
      assert.match(release, /^[a-z0-9][a-z0-9-]*$/);
      const grants =
        plane === "control"
          ? [
              ["worker", "openclaw-tenant-worker"],
              ["api", "openclaw-tenant-api"],
              ["api", "openclaw-tenant-configuration"],
            ]
          : [
              ["worker", "execution-tenant-worker"],
              ["api", "execution-tenant-api"],
            ];
      for (const [component, role] of grants) {
        await client.applyManifest(
          JSON.stringify({
            apiVersion: "rbac.authorization.k8s.io/v1",
            kind: "RoleBinding",
            metadata: { name: `${role}-${component}`, namespace: namespaces[plane] },
            subjects: [
              {
                kind: "ServiceAccount",
                name: `openclaw-enterprise-${component}`,
                namespace: configuration[plane].systemNamespace,
              },
            ],
            roleRef: {
              apiGroup: "rbac.authorization.k8s.io",
              kind: "ClusterRole",
              name: `${release}-${role}`,
            },
          }),
        );
      }
    }
    await cp.waitFor(
      "ready platform Namespace",
      async () => (await api("GET", base)).status === "ready",
    );

    const secret = await api("POST", `${base}/secrets`, {
      name: "Model",
      value: modelCredential,
    });
    const native = await api("POST", `${base}/configurations`, configuration.agentConfiguration);
    const agent = await api("POST", `${base}/agents`, {
      name: "two-cluster-lifecycle",
      configurationId: native.id,
      executionMode: "dedicated",
      harnessAuth: { method: authMethod, source: secret.ref },
    });
    const agentPath = `${base}/agents/${agent.id}`;
    const role = await api("POST", `${base}/iam/roles`, {
      name: "Exact model Secret",
      permissions: [{ action: "operate", resourceKind: "secret" }],
    });
    await api("POST", `${base}/iam/access-bindings`, {
      subjectKind: "identity",
      subjectId: agent.servicePrincipalId,
      roleId: role.id,
      resourceKind: "secret",
      resourceId: secret.id,
    });
    await api("POST", `${agentPath}/runtime-credentials`, {});

    async function waitForDeployment(revision) {
      await cp.waitFor("successful exact revision", async () => {
        const status = await api("GET", `${agentPath}/deployments/${revision.id}`);
        assert.notEqual(status.status, "failed", status.error?.code);
        return status.status === "succeeded";
      });
      return revision;
    }
    async function deploy() {
      return waitForDeployment(await api("POST", `${agentPath}/deploy`));
    }
    const authenticationPolicies = async () =>
      (await dp.resources("networkpolicies", namespaces.execution)).filter((policy) =>
        policy.metadata.name.startsWith("allow-agent-auth-"),
      );
    const first = await deploy();
    const pods = (plane, role) =>
      planes[plane].resources(
        "pods",
        namespaces[plane],
        "-l",
        `openclaw.dev/agent=${agent.id},openclaw.dev/workload-role=${role}`,
      );
    assert.equal((await pods("control", "gateway")).length, 1);
    assert.equal((await pods("execution", "gateway")).length, 0);
    assert.equal((await pods("control", "agent")).length, 0);

    const content = `Two-cluster workspace ${randomUUID()}\n`;
    const workspace = `${agentPath}/workspace/files/USER.md`;
    await api("PUT", workspace, { content });
    assert.equal((await api("GET", workspace)).content, content);
    const harness = (await pods("execution", "agent")).find(
      (pod) => pod.metadata.labels["openclaw.dev/revision"] === first.id,
    );
    assert.ok(harness);
    assert.equal(
      await dp.kubectl(
        "exec",
        harness.metadata.name,
        "-n",
        namespaces.execution,
        "-c",
        "agent",
        "--",
        "node",
        "-e",
        'process.stdout.write(require("node:fs").readFileSync("/home/node/workspace/USER.md","utf8"))',
      ),
      content,
    );

    // Inspect only delivery shape; assertion failures never expose credential bytes.
    const secrets = await dp.resources("secrets", namespaces.execution);
    const delivered = secrets.filter(
      (item) => item.metadata.labels?.["openclaw.dev/agent"] === agent.id,
    );
    assert.ok(delivered.some((item) => Object.hasOwn(item.data ?? {}, modelEnvironment)));
    assert.ok(delivered.every((item) => !Object.hasOwn(item.data ?? {}, "gateway-password")));
    assert.ok(delivered.every((item) => !Object.hasOwn(item.data ?? {}, "kubeconfig")));

    // Delete the exact observed Pod, then prove a new UID reconnects to the same
    // Gateway and serves the retained workspace through the normal OCE API.
    await dp.kubectl(
      "delete",
      "pod",
      harness.metadata.name,
      "-n",
      namespaces.execution,
      "--wait=false",
    );
    await dp.waitFor("replacement Harness Pod", async () =>
      (await pods("execution", "agent")).some(
        (pod) =>
          pod.metadata.uid !== harness.metadata.uid &&
          !pod.metadata.deletionTimestamp &&
          pod.status?.conditions?.some(
            (condition) => condition.type === "Ready" && condition.status === "True",
          ),
      ),
    );
    await cp.waitFor("workspace node reconnect", async () => {
      try {
        return (await api("GET", workspace)).content === content;
      } catch {
        return false;
      }
    });
    await api("POST", `${agentPath}/stop`);
    for (const [plane, role] of [
      ["control", "gateway"],
      ["execution", "agent"],
    ]) {
      await planes[plane].waitFor(
        `${plane} runtime stopped`,
        async () => (await pods(plane, role)).length === 0,
      );
    }
    await deploy();
    assert.equal((await api("GET", workspace)).content, content);
    const modelDigest = async (pod) => {
      const environment = pod.spec.containers.find((container) => container.name === "agent").env;
      const ref = environment.find((item) => item.name === modelEnvironment).valueFrom.secretKeyRef;
      const delivery = await dp.resource("secret", ref.name, namespaces.execution);
      return createHash("sha256")
        .update(Buffer.from(delivery.data[ref.key], "base64"))
        .digest("hex");
    };
    const digest = (value) => createHash("sha256").update(value).digest("hex");
    const liveHarness = (await pods("execution", "agent")).find(
      (pod) => !pod.metadata.deletionTimestamp,
    );
    assert.equal(await modelDigest(liveHarness), digest(modelCredential));
    // A deliberately invalid key proves source updates do not silently mutate
    // the active revision, while an attempted redeploy receives the new material
    // and fails native authentication before deployment can succeed. PAT login
    // rejects an invalid token before the API-key path's model probe runs.
    const invalidKey = `${authMethod === "codex_pat" ? "at-" : ""}test-only-invalid-${randomUUID()}`;
    await api("PATCH", `${base}/secrets/${secret.id}`, { value: invalidKey });
    assert.equal(await modelDigest(liveHarness), digest(modelCredential));
    const rejected = await api("POST", `${agentPath}/deploy`);
    const expectedFailure =
      authMethod === "codex_pat"
        ? { check: "login", code: "LOGIN_FAILED" }
        : { check: "model-probe", code: "MODEL_PROBE_FAILED" };
    const rejectedHarness = await dp.waitFor(
      "replacement credential failure evidence",
      async () => {
        const pod = (await pods("execution", "agent")).find(
          (item) => item.metadata.labels["openclaw.dev/revision"] === rejected.id,
        );
        if (!pod) {
          return false;
        }
        try {
          const status = JSON.parse(
            await dp.kubectl(
              "get",
              "--request-timeout=5s",
              "--raw",
              `/api/v1/namespaces/${namespaces.execution}/pods/${pod.metadata.name}:18791/proxy/openclaw/runtime/status`,
            ),
          );
          return status.revisionId === rejected.id &&
            status.podUid === pod.metadata.uid &&
            status.runtimeFailure?.check === expectedFailure.check &&
            status.runtimeFailure?.code === expectedFailure.code
            ? pod
            : false;
        } catch {
          return false;
        }
      },
    );
    // Failed startup evidence leaves reconciliation pending until its convergence
    // deadline. It must not be confused with a successfully activated revision.
    assert.notEqual(
      (await api("GET", `${agentPath}/deployments/${rejected.id}`)).status,
      "succeeded",
    );
    assert.equal(await modelDigest(rejectedHarness), digest(invalidKey));
    // Exclusive RWO replacement stops the predecessor. Workspace access can be
    // unavailable until valid credentials start its successor; verify retention below.
    await api("PATCH", `${base}/secrets/${secret.id}`, { value: modelCredential });
    const successor = await api("POST", `${agentPath}/deploy`);
    // Exclusive RWO replacement must stop the rejected workload before the
    // Agent-owned policy selects the corrected successor.
    await dp.waitFor("exclusive successor authentication policy", async () => {
      const selected = (await authenticationPolicies()).map(
        (policy) => policy.spec.podSelector.matchLabels["openclaw.dev/revision"],
      );
      const rejectedPods = (await pods("execution", "agent")).filter(
        (pod) => pod.metadata.labels["openclaw.dev/revision"] === rejected.id,
      );
      return (
        selected.includes(successor.id) &&
        !selected.includes(rejected.id) &&
        rejectedPods.length === 0
      );
    });
    await waitForDeployment(successor);
    assert.notEqual(successor.id, first.id);
    assert.equal((await api("GET", workspace)).content, content);
    await dp.waitFor("retired predecessor", async () =>
      (await pods("execution", "agent")).every(
        (pod) => pod.metadata.labels["openclaw.dev/revision"] === successor.id,
      ),
    );

    await dp.waitFor("authentication policy selects only the active revision", async () => {
      const remaining = await authenticationPolicies();
      return (
        remaining.length === 1 &&
        remaining[0].spec.podSelector.matchLabels["openclaw.dev/revision"] === successor.id
      );
    });

    // A real model must execute a shell command in the DP workspace. A successful
    // HTTP response or the model repeating a supplied marker alone is not proof.
    const marker = `OCE_TWO_CLUSTER_${randomUUID()}`;
    const toolPath = "/home/node/workspace/oce-two-cluster-tool-proof.txt";
    const prompt = `Use the shell tool to run this exact command: printf '%s' '${marker}' > ${toolPath}; cat ${toolPath}. Reply exactly with the file contents after the command succeeds.`;
    const gateway = (await pods("control", "gateway")).find(
      (pod) => !pod.metadata.deletionTimestamp,
    );
    assert.ok(gateway);
    const turn = JSON.parse(
      await cp.kubectl(
        "exec",
        gateway.metadata.name,
        "-n",
        namespaces.control,
        "-c",
        "gateway",
        "--",
        "node",
        "--input-type=module",
        "-e",
        `const url = 'http://127.0.0.1:8080/v1/chat/completions';
         const body = JSON.stringify({ model: 'openclaw', stream: false,
           messages: [{ role: 'user', content: ${JSON.stringify(prompt)} }] });
         const denied = await fetch(url, { method: 'POST', body,
           headers: { 'content-type': 'application/json' } });
         const response = await fetch(url, { method: 'POST', body,
           signal: AbortSignal.timeout(120000),
           headers: { 'content-type': 'application/json',
             authorization: 'Bearer ' + process.env.OPENCLAW_GATEWAY_PASSWORD } });
         const value = await response.json();
         console.log(JSON.stringify({ denied: denied.status, status: response.status,
           content: value.choices?.[0]?.message?.content, errorCode: value.error?.code }));`,
      ),
    );
    assert.equal(turn.denied, 401);
    assert.equal(turn.status, 200, turn.errorCode);
    assert.equal(turn.content, marker);
    const successorPod = (await pods("execution", "agent")).find(
      (pod) => pod.metadata.labels["openclaw.dev/revision"] === successor.id,
    );
    assert.ok(successorPod);
    assert.equal(
      await dp.kubectl(
        "exec",
        successorPod.metadata.name,
        "-n",
        namespaces.execution,
        "-c",
        "agent",
        "--",
        "cat",
        toolPath,
      ),
      marker,
    );

    // The exact owned k3d node is stopped, not a mock client. A failed DP read
    // must not be treated as absence or allow Agent metadata to disappear.
    let stopped = false;
    const restore = async () => {
      if (stopped) {
        await docker("start", executionContainerId);
        stopped = false;
      }
    };
    t.after(restore);
    try {
      stopped = true;
      await docker("stop", "--time", "10", executionContainerId);
      await assert.rejects(dp.kubectl("get", "namespace", "kube-system", "--request-timeout=5s"));
      await api("DELETE", agentPath);
      await cp.waitFor("worker observes unavailable DP during deletion", async () => {
        const output = await cp.kubectl(
          "logs",
          "deployment/openclaw-enterprise-worker",
          "-n",
          configuration.control.systemNamespace,
          "--since=60s",
        );
        return output.split("\n").some((line) => {
          try {
            const event = JSON.parse(line);
            return (
              event.agentId === agent.id &&
              event.operation === "agent.delete" &&
              event.outcome === "retry" &&
              event.code === "DEPENDENCY_UNAVAILABLE"
            );
          } catch {
            return false;
          }
        });
      });
      assert.ok(
        (await api("GET", `${base}/agents`)).some(
          (item) => item.id === agent.id && item.status === "deleting",
        ),
      );
    } finally {
      await restore();
    }
    await dp.waitFor("execution API recovery", async () => {
      try {
        return (
          (await dp.resource("namespace", "kube-system")).metadata.uid === dpIdentity.metadata.uid
        );
      } catch {
        return false;
      }
    });
    for (const plane of ["execution", "control"]) {
      await planes[plane].waitFor(
        `${plane} Agent cleanup`,
        async () =>
          (
            await planes[plane].resources(
              "pods",
              namespaces[plane],
              "-l",
              `openclaw.dev/agent=${agent.id}`,
            )
          ).length === 0,
      );
    }
    await cp.waitFor("Agent metadata cleanup", async () =>
      (await api("GET", `${base}/agents`)).every((item) => item.id !== agent.id),
    );
    await api("DELETE", `${base}/configurations/${native.id}`);
    await api("DELETE", `${base}/secrets/${secret.id}`);
    // Installations may seed default Presets into this test-owned Namespace.
    // Remove those ordinary children before requesting Namespace deletion.
    for (const preset of await api("GET", `${base}/presets`)) {
      await api("DELETE", `${base}/presets/${preset.id}`);
    }
    await api("DELETE", base);
    for (const plane of ["execution", "control"]) {
      await planes[plane].waitFor(
        `${plane} Namespace cleanup`,
        async () =>
          (
            await planes[plane].kubectl(
              "get",
              "namespace",
              namespaces[plane],
              "--ignore-not-found",
              "-o",
              "name",
            )
          ).trim() === "",
      );
    }
    t.diagnostic(
      "Real API/worker: separate placement, workspace RPC, Pod reconnect, stop/resume, credential refresh/rejection, revision replacement, model shell execution, DP outage recovery, and two-target deletion passed.",
    );
  },
);
