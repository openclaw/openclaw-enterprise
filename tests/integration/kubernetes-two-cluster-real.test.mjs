import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createKubernetesClient,
  validateExplicitK3dLoopbackContext,
} from "../helpers/kubernetes-real.mjs";

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
    assert.ok(process.env.OPENAI_API_KEY, "The selected real-runtime case requires a model key.");
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
      value: process.env.OPENAI_API_KEY,
    });
    const native = await api("POST", `${base}/configurations`, configuration.agentConfiguration);
    const agent = await api("POST", `${base}/agents`, {
      name: "two-cluster-lifecycle",
      configurationId: native.id,
      executionMode: "dedicated",
      harnessAuth: { method: "api_key", source: secret.ref },
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

    async function deploy() {
      const revision = await api("POST", `${agentPath}/deploy`);
      await cp.waitFor("successful exact revision", async () => {
        const status = await api("GET", `${agentPath}/deployments/${revision.id}`);
        assert.notEqual(status.status, "failed", status.error?.code);
        return status.status === "succeeded";
      });
      return revision;
    }
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
    assert.ok(delivered.some((item) => Object.hasOwn(item.data ?? {}, "OPENAI_API_KEY")));
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
    const successor = await deploy();
    assert.notEqual(successor.id, first.id);
    assert.equal((await api("GET", workspace)).content, content);
    await dp.waitFor("retired predecessor", async () =>
      (await pods("execution", "agent")).every(
        (pod) => pod.metadata.labels["openclaw.dev/revision"] === successor.id,
      ),
    );

    await api("DELETE", agentPath);
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
      "Real API/worker: separate placement, workspace RPC, Pod reconnect, revision replacement, and two-target deletion passed.",
    );
  },
);
