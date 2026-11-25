import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { entries, isArray, readString, record } from "./egress-observation-values.ts";
import type { UpgradeSetup } from "./egress-upgrade-contracts.ts";

function runningIdentity(pod: Record<string, unknown>, name: unknown) {
  const status = [
    ...entries(record(pod.status).containerStatuses),
    ...entries(record(pod.status).initContainerStatuses),
  ].find((entry) => entry.name === name);
  const startedAt = record(record(status?.state).running).startedAt;
  assert.ok(
    typeof status?.containerID === "string" &&
      status.containerID &&
      typeof status.imageID === "string" &&
      status.imageID &&
      typeof startedAt === "string" &&
      startedAt,
    "a real running container identity is required",
  );
  return {
    containerID: status.containerID,
    imageID: status.imageID,
    startedAt,
    restartCount: status.restartCount,
  };
}

function configurationHash(spec: Record<string, unknown>, container: Record<string, unknown>) {
  const volumes = entries(spec.volumes);
  const tokenVolumes = new Set(
    volumes
      .filter(
        (volume) =>
          typeof volume.name === "string" &&
          /^kube-api-access-[a-z0-9]+$/.test(volume.name) &&
          entries(record(volume.projected).sources).some((source) => source.serviceAccountToken),
      )
      .map(({ name }) => name),
  );
  const normalize = (entry: Record<string, unknown>) => ({
    ...entry,
    ...(tokenVolumes.has(entry.name) && { name: "kube-api-access" }),
  });
  // Only normalize the API server's random projected-volume name. Keep the
  // token projection, mounts and every configured input in the comparison.
  const configuration = {
    args: container.args,
    command: container.command,
    env: container.env,
    envFrom: container.envFrom,
    volumeMounts:
      container.volumeMounts == null ? undefined : entries(container.volumeMounts).map(normalize),
    volumes: volumes.map(normalize),
    serviceAccountName: spec.serviceAccountName,
  };
  return createHash("sha256").update(JSON.stringify(configuration)).digest("hex");
}

export const controllerComponents = ["api", "worker"] as const;
type Component = (typeof controllerComponents)[number];

export function controllerContainers(pod: Record<string, unknown>) {
  const spec = record(pod.spec);
  return [...entries(spec.containers), ...entries(spec.initContainers)];
}

export async function observeControllerIdentities(
  setup: UpgradeSetup,
  rawPods: unknown,
  expectedImage: string,
) {
  const pods = entries(rawPods);
  assert.equal(pods.length, 2, "the disposable upgrade requires one API and one Worker Pod");
  const select = (component: Component) => {
    const matches = pods.filter(
      (pod) => record(record(pod.metadata).labels)["app.kubernetes.io/component"] === component,
    );
    assert.equal(matches.length, 1);
    const pod = matches[0];
    assert.ok(pod);
    const metadata = record(pod.metadata);
    const spec = record(pod.spec);
    const container = controllerContainers(pod).find(({ name }) => name === component);
    assert.equal(
      container?.image,
      expectedImage,
      "the application container must use the selected image",
    );
    assert.ok(container);
    const entry = component === "api" ? "server" : "worker";
    assert.ok(
      isArray(container.args) && container.args.includes(`apps/controller/src/${entry}.mjs`),
      "select the actual controller entrypoint",
    );
    assert.ok(typeof metadata.uid === "string" && metadata.uid);
    const identity = {
      component,
      name: readString(metadata.name),
      uid: metadata.uid,
      ...runningIdentity(pod, component),
      // A controller-only replacement must preserve its installed configuration.
      configurationSha256: configurationHash(spec, container),
    };
    return { identity, spec, container };
  };
  const api = select("api");
  const worker = select("worker");
  const observe = async ({ identity, spec, container }: ReturnType<typeof select>) => {
    assert.equal(
      entries(container.env).find(({ name }) => name === "OCC_CONFIG_PATH")?.value,
      "/etc/openclaw/installation/installation.yaml",
      "hash the selected production Installation file",
    );
    const mount = entries(container.volumeMounts).find(
      ({ mountPath }) => mountPath === "/etc/openclaw/installation",
    );
    const volume = entries(spec.volumes).find(({ name }) => name === mount?.name);
    assert.ok(
      mount?.readOnly &&
        entries(record(volume?.secret).items).some(({ path }) => path === "installation.yaml"),
      "select the production controller's mounted Installation input",
    );
    // Hash only the mounted Installation file, inside its owning container. Never
    // return its bytes or read unrelated Secrets and rotating identity projections.
    const digest = await setup.f.kubectl(
      "exec",
      identity.name,
      "--namespace",
      setup.input.controllerNamespace,
      "--container",
      identity.component,
      "--",
      "node",
      "-e",
      'const fs = require("node:fs"); const crypto = require("node:crypto"); process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync("/etc/openclaw/installation/installation.yaml")).digest("hex"));',
    );
    assert.match(digest, /^[a-f0-9]{64}$/);
    return { ...identity, installationSha256: digest };
  };
  const observed = [await observe(api), await observe(worker)] as const;
  assert.equal(observed[0].installationSha256, observed[1].installationSha256);
  return observed;
}

export function supplierIdentities(pods: readonly unknown[]) {
  return pods
    .map((value) => {
      const pod = record(value);
      const metadata = record(pod.metadata);
      return {
        name: readString(metadata.name),
        uid: readString(metadata.uid),
        containers: entries(record(pod.spec).containers).map(({ name, image }) => ({
          name,
          image,
          ...runningIdentity(pod, name),
        })),
      };
    })
    .sort((a, b) => a.uid.localeCompare(b.uid));
}
