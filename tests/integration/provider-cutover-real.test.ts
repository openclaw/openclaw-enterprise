import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";

const execute = promisify(execFile);
const agentLabel = "openclaw.dev/agent";
const revisionLabel = "openclaw.dev/revision";
const roleLabel = "openclaw.dev/workload-role";

type Workload = {
  metadata: { name: string; labels: Record<string, string> };
  spec: { template: { metadata: { labels: Record<string, string> } } };
  status: { availableReplicas?: number };
};

test(
  "dedicated provider routing withholds the candidate route until its Harness exists",
  { skip: process.env.OCC_TEST_PROVIDER_CUTOVER !== "1", timeout: 360_000 },
  async (t) => {
    const required = (key: string) => {
      const value = process.env[key];
      assert.ok(value, `Missing ${key}`);
      return value;
    };
    const context = required("OCC_TEST_KUBERNETES_CONTEXT");
    const kubeconfig = required("OCC_TEST_KUBERNETES_KUBECONFIG");
    const namespace = required("OCC_TEST_PROVIDER_TENANT");
    const agent = required("OCC_TEST_PROVIDER_AGENT");
    const cli = required("OCC_TEST_OCC_BIN");
    const localHost = (host: string) => ["localhost", "127.0.0.1", "[::1]"].includes(host);
    assert.ok(context.startsWith("k3d-") && localHost(new URL(required("OCC_URL")).hostname));
    const kube = async (...args: string[]) =>
      (await execute("kubectl", ["--context", context, "--kubeconfig", kubeconfig, ...args]))
        .stdout;
    const server = await kube(
      "config",
      "view",
      "--minify",
      "-o",
      "jsonpath={.clusters[0].cluster.server}",
    );
    assert.ok(localHost(new URL(server).hostname));
    const occ = async (...args: string[]) =>
      JSON.parse((await execute(cli, ["agent", ...args, "-o", "json"])).stdout);
    const listed = await occ("get", agent);
    assert.equal(listed.id, agent);
    const workloads = async (): Promise<Workload[]> =>
      JSON.parse(
        await kube("-n", namespace, "get", "deploy", "-l", `${agentLabel}=${agent}`, "-o", "json"),
      ).items;
    const gateway = (items: Workload[]) =>
      items.find((d) => d.spec.template.metadata.labels[roleLabel] === "gateway");
    const previous = gateway(await workloads());
    assert.equal(previous?.status.availableReplicas, 1);
    assert.ok(previous);
    const old = previous.spec.template.metadata.labels[revisionLabel];
    const policy = async () => {
      const items = JSON.parse(
        await kube(
          "-n",
          namespace,
          "get",
          "networkpolicy",
          "-l",
          `${agentLabel}=${agent}`,
          "-o",
          "json",
        ),
      ).items as {
        metadata: { name: string };
        spec: { egress?: { to?: { podSelector?: { matchLabels?: Record<string, string> } }[] }[] };
      }[];
      const route = items.find((item) => item.metadata.name.startsWith("allow-gateway-agent-"));
      if (!route) {
        return [];
      }
      return (route.spec.egress ?? [])
        .flatMap((rule) =>
          (rule.to ?? []).map((peer) => peer.podSelector?.matchLabels?.[revisionLabel]),
        )
        .sort();
    };
    assert.equal(listed.activeRevisionId, old, "select an active, disposable Agent");
    assert.deepEqual(await policy(), [old]);
    const directory = await temporaryDirectory(t, "provider-cutover-");
    const name = "provider-cutover-" + randomUUID();
    const file = join(directory, "admission.json");
    const resources = ["validatingadmissionpolicy", "validatingadmissionpolicybinding"];
    // Delay only new Harness Deployments for this Agent. Dedicated replacement
    // stops the predecessor before the worker attempts candidate preparation.
    const match = {
      resourceRules: [
        {
          apiGroups: ["apps"],
          apiVersions: ["v1"],
          operations: ["CREATE"],
          resources: ["deployments"],
        },
      ],
      namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": namespace } },
      objectSelector: { matchLabels: { [agentLabel]: agent, [roleLabel]: "agent" } },
    };
    const apiVersion = "admissionregistration.k8s.io/v1";
    const metadata = { name };
    const deny = {
      apiVersion,
      kind: "ValidatingAdmissionPolicy",
      metadata,
      spec: {
        failurePolicy: "Fail",
        matchConstraints: match,
        validations: [{ expression: "false", message: name }],
      },
    };
    const binding = {
      apiVersion,
      kind: "ValidatingAdmissionPolicyBinding",
      metadata,
      spec: { policyName: name, validationActions: ["Deny"] },
    };
    await writeFile(
      file,
      JSON.stringify({ apiVersion: "v1", kind: "List", items: [deny, binding] }),
    );
    t.after(async () => {
      for (const kind of resources.toReversed()) {
        await kube("delete", kind, name, "--ignore-not-found");
      }
    });
    await kube("create", "-f", file);
    const probe = join(directory, "candidate.json");
    const labels = { [agentLabel]: agent, [roleLabel]: "agent" };
    await writeFile(
      probe,
      JSON.stringify({
        apiVersion: "apps/v1",
        kind: "Deployment",
        metadata: { name, namespace, labels },
        spec: {
          replicas: 0,
          selector: { matchLabels: labels },
          template: {
            metadata: { labels },
            spec: { containers: [{ name: "probe", image: "registry.k8s.io/pause:3.10" }] },
          },
        },
      }),
    );
    const until = async (check: () => Promise<boolean>, label: string) => {
      const end = Date.now() + 145_000;
      while (Date.now() < end) {
        if (await check()) {
          return;
        }
        await delay(1000);
      }
      assert.fail("Timed out waiting for " + label);
    };
    await until(async () => {
      try {
        await kube("create", "--dry-run=server", "-f", probe);
        return false;
      } catch (error) {
        return error instanceof Error && error.message.includes("denied request: " + name);
      }
    }, "the scoped candidate hold");
    const next = await occ("deploy", agent);
    assert.notEqual(next.id, old);
    // Wait for a real worker reconciliation attempt, then inspect both routing owners.
    await until(
      async () => Boolean((await occ("deployment-status", agent, next.id)).progress?.lastAttempt),
      "candidate reconciliation",
    );
    const held = await workloads();
    assert.ok(
      !held.some(
        (item) =>
          item.spec.template.metadata.labels[roleLabel] === "agent" &&
          item.spec.template.metadata.labels[revisionLabel] === next.id,
      ),
      "candidate Harness should be absent",
    );
    assert.notEqual((await occ("get", agent)).activeRevisionId, next.id);
    assert.ok(
      !(await policy()).includes(next.id),
      "a bootstrap Gateway must not gain a route to the missing Harness",
    );
    await kube("delete", "validatingadmissionpolicybinding", name);
    await until(async () => {
      const current = gateway(await workloads());
      return (
        current !== undefined &&
        current.spec.template.metadata.labels[revisionLabel] === next.id &&
        current.status.availableReplicas === 1 &&
        (await occ("get", agent)).activeRevisionId === next.id &&
        JSON.stringify(await policy()) === JSON.stringify([next.id])
      );
    }, "the new serving Gateway and exclusive candidate route");
  },
);
