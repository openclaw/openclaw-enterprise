import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import Type from "typebox";
import { Check } from "typebox/value";

import { parseProductionChart } from "../helpers/production-chart.ts";
import {
  protectedRepositoryValues,
  render,
  repositoryCredentialValues,
  tooling,
  type ChartValues,
} from "../helpers/production-chart-network-fixture.ts";
import { findResource, namedChartResource } from "../helpers/production-chart-resource.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";
import { caValues, oidcValues } from "./oidc-ca-chart-fixture.ts";

const execute = promisify(execFile);
const components = ["api", "worker"] as const;
const chartResources = Type.Array(namedChartResource);
const container = Type.Object({
  name: Type.String(),
  image: Type.String(),
  command: Type.Optional(Type.Array(Type.String())),
  args: Type.Optional(Type.Array(Type.String())),
  securityContext: Type.Optional(
    Type.Object({ readOnlyRootFilesystem: Type.Optional(Type.Boolean()) }),
  ),
  volumeMounts: Type.Optional(
    Type.Array(Type.Object({ name: Type.String(), mountPath: Type.String() })),
  ),
});
const deploymentShape = Type.Object({
  spec: Type.Object({
    template: Type.Object({
      spec: Type.Object({
        automountServiceAccountToken: Type.Optional(Type.Boolean()),
        securityContext: Type.Optional(Type.Unknown()),
        containers: Type.Array(container),
        initContainers: Type.Optional(Type.Array(container)),
        volumes: Type.Array(
          Type.Object({
            name: Type.String(),
            emptyDir: Type.Optional(Type.Unknown()),
            projected: Type.Optional(
              Type.Object({
                defaultMode: Type.Optional(Type.Number()),
                sources: Type.Array(
                  Type.Object({ serviceAccountToken: Type.Optional(Type.Unknown()) }),
                ),
              }),
            ),
          }),
        ),
      }),
    }),
  }),
});

async function controllerPods(values: ChartValues) {
  const resources = await parseProductionChart((await render(values)).stdout);
  assert.ok(Check(chartResources, resources), "Expected Helm to render named Kubernetes resources");
  return components.map((component) => {
    const name = `openclaw-enterprise-${component}`;
    const deployment = findResource(resources, "Deployment", name);
    assert.ok(Check(deploymentShape, deployment), `Expected a rendered Pod template in ${name}`);
    return { component, pod: deployment.spec.template.spec };
  });
}

test("controller Kubernetes client projection excludes auxiliary containers", tooling, async () => {
  const variants = [
    {},
    repositoryCredentialValues,
    { ...protectedRepositoryValues, "repositoryCredentials.delivery": "credential-proxy" },
    { ...oidcValues, ...caValues },
    {
      ...protectedRepositoryValues,
      "openshellGit.enabled": "true",
      "openshellGit.tlsSecretName": "openshell-git-tls",
      "openshellGit.issuerPublicKeyConfigMapName": "openshell-gateway-public",
      "openshellGit.clients[0].namespaceSelector.matchLabels.kubernetes\\.io/metadata\\.name":
        "openshell-system",
      "openshellGit.clients[0].podSelector.matchLabels.app": "openshell-supervisor",
    },
  ];
  for (const values of variants) {
    for (const { component, pod } of await controllerPods(values)) {
      // Disable automatic credentials for every container and explicitly mount the Kubernetes
      // client's standard files only in the controller, including when it is a native sidecar.
      assert.equal(pod.automountServiceAccountToken, false);
      const volumes = pod.volumes.filter((volume) =>
        volume.projected?.sources.some((source) => source.serviceAccountToken),
      );
      assert.equal(volumes.length, 1);
      const [access] = volumes;
      assert.ok(access?.projected, "Expected the controller's Kubernetes client projection");
      assert.equal(access.projected.defaultMode, 0o440);
      assert.deepEqual(access.projected.sources, [
        { serviceAccountToken: { path: "token", expirationSeconds: 3600 } },
        { configMap: { name: "kube-root-ca.crt", items: [{ key: "ca.crt", path: "ca.crt" }] } },
        {
          downwardAPI: {
            items: [
              {
                path: "namespace",
                fieldRef: { apiVersion: "v1", fieldPath: "metadata.namespace" },
              },
            ],
          },
        },
      ]);
      const containers = [...(pod.initContainers ?? []), ...pod.containers];
      const consumers = containers.filter((container) =>
        container.volumeMounts?.some(({ name }) => name === access.name),
      );
      assert.deepEqual(
        consumers.map(({ name }) => name),
        [component],
      );
      assert.deepEqual(
        consumers[0]?.volumeMounts?.find(({ name }) => name === access.name),
        {
          name: access.name,
          mountPath: "/var/run/secrets/kubernetes.io/serviceaccount",
          readOnly: true,
        },
      );
    }
  }
});

test("controller scratch stays private with read-only API and worker roots", tooling, async (t) => {
  const directory = await temporaryDirectory(t, "occ-controller-scratch-");
  const variants = [
    ["default", {}],
    ["with-broker", repositoryCredentialValues],
  ] as const;
  for (const [variant, values] of variants) {
    for (const { component, pod } of await controllerPods(values)) {
      const containers = [...(pod.initContainers ?? []), ...pod.containers];
      const controller = containers.find(({ name }) => name === component);
      assert.ok(controller, `Expected the rendered ${component} controller`);
      const scratch = pod.volumes.find(({ name }) => name === "controller-scratch");
      assert.deepEqual(scratch?.emptyDir, { medium: "Memory", sizeLimit: "64Mi" });
      assert.deepEqual(pod.securityContext, {
        runAsNonRoot: true,
        runAsUser: 1000,
        runAsGroup: 1000,
        fsGroup: 1000,
        seccompProfile: { type: "RuntimeDefault" },
      });
      assert.equal(controller.securityContext?.readOnlyRootFilesystem, true);
      assert.deepEqual(
        controller.volumeMounts?.find(({ mountPath }) => mountPath === "/tmp"),
        {
          name: "controller-scratch",
          mountPath: "/tmp",
          subPath: "private",
        },
      );
      const init = pod.initContainers?.[0];
      assert.ok(init, "Expected scratch preparation before the controller starts");
      assert.equal(init.name, "prepare-controller-scratch");
      assert.equal(init.image, controller.image);
      assert.deepEqual(init.securityContext, controller.securityContext);
      assert.deepEqual(init.volumeMounts, [{ name: "controller-scratch", mountPath: "/scratch" }]);
      assert.deepEqual(
        containers
          .filter((container) =>
            container.volumeMounts?.some(({ name }) => name === "controller-scratch"),
          )
          .map(({ name }) => name),
        ["prepare-controller-scratch", component],
      );

      // Use the rendered initializer with a disposable path and check that it repairs permissive
      // existing scratch. An initializer that only creates the directory would leave it exposed.
      const command = init.command?.[0];
      assert.ok(command && init.command && init.args, "Expected an executable scratch initializer");
      assert.equal(init.args.at(-1), "/scratch/private");
      const scratchPath = join(directory, `${component}-${variant}`);
      const args = [...init.command.slice(1), ...init.args.slice(0, -1), scratchPath];
      await execute(command, args);
      const initial = await stat(scratchPath);
      assert.equal(initial.mode & 0o777, 0o700);
      assert.equal(initial.uid, process.getuid?.());
      await chmod(scratchPath, 0o777);
      await execute(command, args);
      const metadata = await stat(scratchPath);
      assert.equal(metadata.mode & 0o777, 0o700);
      assert.equal(metadata.uid, process.getuid?.());
      const temporary = await mkdtemp(join(scratchPath, "caller-"));
      await writeFile(join(temporary, "scratch"), "temporary caller output");
    }
  }
});
