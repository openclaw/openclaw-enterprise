// Feed a rendered Agent Pod or Deployment on stdin. Run on the dedicated lab
// context as an operator authorized to impersonate the ReplicaSet controller.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const controller = process.argv[2] ?? "system:serviceaccount:kube-system:replicaset-controller";
const resource = JSON.parse(readFileSync(0, "utf8"));
const template = resource.spec.template ?? resource;
const approved = {
  apiVersion: "v1",
  kind: "Pod",
  metadata: {
    generateName: "stock-check-",
    namespace: resource.metadata.namespace,
    labels: template.metadata.labels,
    annotations: template.metadata.annotations,
  },
  spec: template.spec,
};

function check(name, mutate, denial = "ValidatingAdmissionPolicy 'oce-strands-box'") {
  const pod = structuredClone(approved);
  mutate?.(pod.spec.containers[1], pod.spec, pod);
  const impersonation = name === "wrong creator" ? [] : ["--as", controller];
  const { status, stderr, error } = spawnSync(
    "kubectl",
    [...impersonation, "create", "--dry-run=server", "-f", "-"],
    { input: JSON.stringify(pod), encoding: "utf8" },
  );
  if (error) throw error;
  if (denial ? status === 0 || !stderr.includes(denial) : status !== 0) {
    throw new Error(`${name} returned ${status}\n${stderr}`);
  }
  console.log(`${name} ${denial ? "denied" : "approved"}`);
}

check("rendered Agent", null, null);
check("wrong creator");
check("wrong tenant", (_, s, p) => {
  p.metadata.namespace = "default";
  delete s.serviceAccountName;
  delete s.serviceAccount;
});
check("wrong image", (c) => (c.image = "invalid.example/unapproved:latest"));
check("wrong launcher", (c) => (c.command = ["/bin/true"]));
check("lifecycle hook", (c) => (c.lifecycle = { postStart: { exec: { command: ["/bin/true"] } } }));
check("injected environment", (c) => c.env.push({ name: "UNEXPECTED", value: "test" }));
check("mount over launcher", (c) => (c.volumeMounts[0].mountPath = "/opt/oce"));
check("missing AppArmor", (c) => delete c.securityContext.appArmorProfile);
check("wrong seccomp", (c) => (c.securityContext.seccompProfile = { type: "RuntimeDefault" }));
check("unmasked sibling", (_, s) => (s.containers[0].securityContext.procMount = "Unmasked"));
check(
  "init capabilities",
  (_, s) => (s.initContainers[0].securityContext.capabilities.add = ["NET_BIND_SERVICE"]),
);
check("host volume", (_, s) => s.volumes.push({ name: "extra", hostPath: { path: "/tmp" } }));
check(
  "ordinary tenant enforcement",
  (_, s) => delete s.runtimeClassName,
  'violates PodSecurity "restricted:',
);
