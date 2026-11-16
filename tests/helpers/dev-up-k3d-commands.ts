import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { asRecord } from "../../packages/utils/src/objects.ts";
import type { CommandRequest } from "./fixture-command-server.ts";

type ResourceState = { clusters: string[]; compose: boolean };

export function parseDevUpResourceState(text: string): ResourceState {
  const parsed: unknown = JSON.parse(text);
  const state = asRecord(parsed);
  assert.ok(
    state &&
      Object.keys(state).length === 2 &&
      Array.isArray(state.clusters) &&
      typeof state.compose === "boolean",
    "Invalid dev-up resource ledger",
  );
  const clusters: unknown[] = state.clusters;
  assert.ok(
    clusters.every((name): name is string => typeof name === "string" && name.length > 0),
    "Invalid cluster name in dev-up resource ledger",
  );
  return { clusters, compose: state.compose };
}

// Hold only the external command before logging or mutating resources. The Go
// launcher owns cancellation, rollback and journal retention after dispatch.
export function holdK3dCreate(
  { command, args, env }: Pick<CommandRequest, "command" | "args" | "env">,
  directory: string,
): boolean {
  if (
    env.DEV_UP_LIFECYCLE_SCENARIO !== "cancelled-creation" ||
    command !== "k3d" ||
    args[0] !== "cluster" ||
    args[1] !== "create"
  ) {
    return false;
  }
  writeFileSync(join(directory, "creation-started"), "dispatched");
  return true;
}

type KubernetesCommand = "k3d" | "kubectl" | "helm";
type KubernetesCommandContext = {
  args: readonly string[];
  scenario: string | undefined;
  state: ResourceState;
  save: () => void;
  output: (value: string) => void;
  fail: (message: string) => never;
  serviceKeyFile: string;
};

export function kubernetesLifecycleCommand(
  command: KubernetesCommand,
  context: KubernetesCommandContext,
): void {
  switch (command) {
    case "k3d": {
      return k3d(context);
    }
    case "kubectl": {
      return kubectl(context);
    }
    case "helm": {
      return helm(context);
    }
  }
}

function k3d({ args, scenario, state, save, output, fail }: KubernetesCommandContext): void {
  const [verb, resource, name] = args;
  if (verb === "cluster" && resource === "list") {
    output(JSON.stringify(state.clusters.map((name) => ({ name }))));
  } else if (verb === "cluster" && resource === "create") {
    if (!name) {
      return fail("k3d cluster create requires a name");
    }
    if (scenario === "cluster-create-rolled-back") {
      // k3d's own rollback after a port clash: nothing of the cluster remains.
      return fail(
        "ERRO[0009] Failed Cluster Start: Failed to start server k3d-" +
          name +
          "-serverlb: Bind for 127.0.0.1:3000 failed: port is already allocated\n" +
          "FATA[0009] Cluster creation FAILED, all changes have been rolled back!",
      );
    }
    state.clusters.push(name);
    save();
    if (scenario === "cluster-create-failed") {
      fail("partial cluster creation");
    }
  } else if (verb === "cluster" && resource === "delete") {
    if (!name) {
      return fail("k3d cluster delete requires a name");
    }
    if (scenario === "cluster-delete-failed") {
      fail("cluster cleanup unavailable");
    }
    state.clusters = state.clusters.filter((cluster) => cluster !== name);
    save();
  } else if (verb === "kubeconfig" && resource === "get") {
    output(
      JSON.stringify({
        apiVersion: "v1",
        kind: "Config",
        "current-context": "k3d-occ-dev-owned",
        contexts: [
          { name: "k3d-occ-dev-owned", context: { cluster: "k3d-occ-dev-owned", user: "admin" } },
        ],
        clusters: [
          {
            name: "k3d-occ-dev-owned",
            cluster: {
              server: "https://127.0.0.1:6443",
              "certificate-authority-data": "fixture-ca",
            },
          },
        ],
        users: [{ name: "admin", user: { token: "fixture-kubernetes-token" } }],
      }),
    );
  } else if (verb !== "image") {
    fail("unexpected k3d: " + args.join(" "));
  }
}

function kubectl({ args, output, fail, serviceKeyFile }: KubernetesCommandContext): void {
  if (args.includes("get") && args.includes("--raw=/version")) {
    // Reachable.
  } else if (
    args[0] === "apply" ||
    args[0] === "rollout" ||
    args[0] === "create" ||
    args[0] === "patch"
  ) {
    // Inert.
  } else if (args[0] === "get" && args[1] === "node" && args[2]?.endsWith("-server-0")) {
    output(JSON.stringify({ spec: { podCIDR: "10.42.0.0/24" } }));
  } else if (args[0] === "get" && args[1] === "namespace") {
    if (!args[2]) {
      return fail("kubectl get namespace requires a name");
    }
    output(JSON.stringify({ metadata: { name: args[2] } }));
  } else if (args[0] === "-n" && args.includes("wait")) {
    // Ready.
  } else if (args[0] === "-n" && args.includes("rollout")) {
    // Rolled out.
  } else if (args[0] === "-n" && args.includes("delete")) {
    // Deleted.
  } else if (args[0] === "-n" && args.includes("exec")) {
    output(serviceKeyFile);
  } else if (
    args[0] === "-n" &&
    args.includes("pod") &&
    args.includes("bootstrap-password-prepare")
  ) {
    output("Succeeded");
  } else if (args[0] === "-n" && args.includes("pod") && args.includes("postgres-0")) {
    output("10.42.0.20");
  } else if (
    args[0] === "-n" &&
    args.includes("endpoints") &&
    args.includes("kubernetes") &&
    args.includes("jsonpath={.subsets[0].ports[0].port}")
  ) {
    output("6443");
  } else if (args[0] === "-n" && args.includes("endpoints") && args.includes("kubernetes")) {
    output("172.30.42.3");
  } else if (args[0] === "get" && args[1] === "service" && args[2] === "kubernetes") {
    output(JSON.stringify({ spec: { clusterIP: "10.43.0.1" } }));
  } else if (
    args[0] === "get" &&
    args[1] === "service" &&
    args[2] === "openshell-gateway" &&
    args.includes("jsonpath={.spec.clusterIP}")
  ) {
    output("10.43.0.50");
  } else if (args[0] === "get" && args[1] === "endpoints" && args[2] === "kubernetes") {
    output(JSON.stringify({ subsets: [{ addresses: [{ ip: "172.30.41.4" }] }] }));
  } else if (args[0] === "get" && args[1] === "namespaces") {
    output(
      JSON.stringify({
        items: [
          {
            metadata: {
              name: "oce-123456789012345",
              labels: { "openclaw.dev/namespace": "namespace_fixture" },
              annotations: { "openclaw.dev/namespace-id": "namespace_fixture" },
            },
          },
        ],
      }),
    );
  } else if (
    args[0] === "get" &&
    args[1] === "service" &&
    args.includes("jsonpath={.spec.ports[0].nodePort}")
  ) {
    output("30051");
  } else {
    fail("unexpected kubectl: " + args.join(" "));
  }
}

function helm({ args, output, fail }: KubernetesCommandContext): void {
  if ((args[0] === "show" && args[1] === "chart") || args[0] === "upgrade") {
    // Inert.
  } else if (args[0] === "template") {
    output(
      [
        "apiVersion: v1",
        "kind: ServiceAccount",
        "metadata:",
        "  name: openshell-sandbox",
        "  namespace: openclaw-workspace-template",
        "---",
        "apiVersion: rbac.authorization.k8s.io/v1",
        "kind: Role",
        "metadata:",
        "  name: openshell-workspace-sandbox",
        "  namespace: openclaw-workspace-template",
      ].join("\n"),
    );
  } else {
    fail("unexpected helm: " + args.join(" "));
  }
}
