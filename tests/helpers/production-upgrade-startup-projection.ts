import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Supply the Kubernetes reads used to verify the serving writers. The real exec probe
// runs against a kubelet-style projection, independent of the Secret returned by GET.
export async function writeStartupProjection(directory: string, installation: string) {
  const projection = join(directory, "startup-projection");
  const generation = join(projection, "generation");
  await mkdir(generation, { recursive: true });
  await writeFile(join(generation, "installation.yaml"), installation);
  await symlink("generation", join(projection, "..data"));
  await symlink("..data/installation.yaml", join(projection, "installation.yaml"));
  const startedAt = new Date(Date.now() + 1_000).toISOString();
  const mountPath = "/etc/openclaw/installation";
  for (const component of ["api", "worker"]) {
    const deployment = `openclaw-enterprise-${component}`;
    const uid = `fixture-${component}`;
    const owner = (kind: string, name: string, ownerUid: string) => ({
      kind,
      name,
      uid: ownerUid,
      controller: true,
    });
    const replicaSet = {
      metadata: {
        name: `${component}-rs`,
        uid: `${uid}-rs`,
        ownerReferences: [owner("Deployment", deployment, uid)],
      },
    };
    const pod = {
      metadata: {
        name: `${component}-pod`,
        uid: `${uid}-pod`,
        ownerReferences: [owner("ReplicaSet", replicaSet.metadata.name, replicaSet.metadata.uid)],
      },
      spec: {
        containers: [
          {
            name: component,
            env: [{ name: "OCC_CONFIG_PATH", value: mountPath + "/installation.yaml" }],
            volumeMounts: [{ name: "installation-startup", mountPath, readOnly: true }],
          },
        ],
        volumes: [
          {
            name: "installation-startup",
            secret: {
              secretName: "occ-installation-startup",
              items: [{ key: "installation.yaml", path: "installation.yaml" }],
            },
          },
        ],
      },
      status: {
        phase: "Running",
        containerStatuses: [
          {
            name: component,
            ready: true,
            containerID: uid + "-container",
            state: { running: { startedAt } },
          },
        ],
      },
    };
    for (const [name, object] of Object.entries({
      deployment: {
        metadata: {
          name: deployment,
          uid,
          resourceVersion: "1",
          labels: {
            "app.kubernetes.io/instance": "oce",
            "app.kubernetes.io/component": component,
          },
        },
        spec: { replicas: 1 },
      },
      replicasets: { items: [replicaSet] },
      pod: { items: [pod] },
    })) {
      await writeFile(join(projection, `${component}-${name}.json`), JSON.stringify(object));
    }
  }
  return projection;
}

// Bash case arms shared by the upgrade command fixtures. Substitute only the local
// mount path in the probe supplied through kubectl exec, then use real system tools.
export const startupProjectionReads = `
  *' get deployment/openclaw-enterprise-'*' --output json')
    for arg in "$@"; do
      case "$arg" in deployment/openclaw-enterprise-*) component=\${arg##*-} ;; esac
    done
    cat "$TEST_PROJECTION/$component-deployment.json" ;;
  *' get pod --selector '*|*' get replicasets --selector '*)
    for arg in "$@"; do
      case "$arg" in pod|replicasets) kind=$arg ;; *,app.kubernetes.io/component=*) component=\${arg##*=} ;; esac
    done
    cat "$TEST_PROJECTION/$component-$kind.json" ;;
  *' exec api-pod -c api -- sh -ec '*|*' exec worker-pod -c worker -- sh -ec '*)
    probe=\${!#}
    PATH=/usr/bin:/bin OCC_CONFIG_PATH="$TEST_PROJECTION/installation.yaml" \\
      exec sh -ec "\${probe//\\/etc\\/openclaw\\/installation/$TEST_PROJECTION}" ;;
`;
