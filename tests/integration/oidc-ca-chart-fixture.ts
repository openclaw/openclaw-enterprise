import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import Type, { type Static } from "typebox";
import { Check } from "typebox/value";
import { caAndLeaf } from "../helpers/certificates.mjs";
import {
  chartTooling,
  parseProductionChart,
  renderProductionChart,
} from "../helpers/production-chart.mjs";
import { findResource } from "../helpers/production-chart-resource.ts";

export const execute = promisify(execFile);
export const tooling: { skip: boolean | string } = await chartTooling();

export const oidcValues = {
  "auth.recoveryUserId": "existing-administrator",
  "auth.oidc.enabled": "true",
  "auth.oidc.issuer": "https://sso.example.test",
  "auth.oidc.authorizationUrl": "https://sso.example.test/authorize",
  "auth.oidc.tokenUrl": "https://sso.example.test/token",
  "auth.oidc.jwksUrl": "https://sso.example.test/jwks",
};
export const databaseCaValues = { "database.caSecretName": "database-ca" };
export const caValues = {
  ...databaseCaValues,
  "auth.oidc.caSecretName": "idp-ca",
  "auth.oidc.caSecretKey": "roots.pem",
};
export const gatewayValues = {
  "gatewayRouting.enabled": "true",
  "gatewayRouting.gatewayClassName": "private-envoy-gateway",
  "gatewayRouting.apiKeySecretName": "occ-gateway-api-key",
};
export const externalGateway = {
  ...gatewayValues,
  "gatewayRouting.issuerRef.name": "external-issuer",
};
export const externalGatewayCa = {
  ...externalGateway,
  "gatewayRouting.caSecretName": "gateway-ca",
  "gatewayRouting.caSecretKey": "gateway.pem",
};

const containerShape = Type.Object({
  name: Type.String(),
  image: Type.String(),
  command: Type.Optional(Type.Array(Type.String())),
  args: Type.Array(Type.String()),
  securityContext: Type.Object({
    allowPrivilegeEscalation: Type.Boolean(),
    readOnlyRootFilesystem: Type.Boolean(),
    capabilities: Type.Object({ drop: Type.Array(Type.String()) }),
  }),
  env: Type.Array(
    Type.Object({
      name: Type.String(),
      value: Type.Optional(Type.String()),
      valueFrom: Type.Optional(
        Type.Object({
          secretKeyRef: Type.Optional(Type.Object({ name: Type.String(), key: Type.String() })),
        }),
      ),
    }),
  ),
  volumeMounts: Type.Array(
    Type.Object({
      name: Type.String(),
      mountPath: Type.String(),
      readOnly: Type.Optional(Type.Boolean()),
    }),
  ),
});
const podTemplateShape = Type.Object({
  template: Type.Object({
    spec: Type.Object({
      securityContext: Type.Object({ runAsNonRoot: Type.Boolean() }),
      containers: Type.Array(containerShape),
      initContainers: Type.Optional(Type.Array(containerShape)),
      volumes: Type.Array(
        Type.Object({
          name: Type.String(),
          secret: Type.Optional(
            Type.Object({
              secretName: Type.String(),
              items: Type.Optional(
                Type.Array(Type.Object({ key: Type.String(), path: Type.String() })),
              ),
            }),
          ),
        }),
      ),
    }),
  }),
});
const resourceShape = Type.Object({
  kind: Type.String(),
  metadata: Type.Object({ name: Type.String() }),
  spec: Type.Optional(Type.Unknown()),
});
const resourcesShape = Type.Array(resourceShape);
const caSourcesShape = Type.Record(Type.String(), Type.String());

type ChartResource = Static<typeof resourceShape>;
type Pod = Static<typeof podTemplateShape>["template"]["spec"];
export type Container = Static<typeof containerShape>;

export async function render(values: Readonly<Record<string, string>>) {
  const rendered: unknown = await parseProductionChart(
    (await renderProductionChart(values)).stdout,
  );
  assert.ok(Check(resourcesShape, rendered), "Expected Helm to render named Kubernetes resources");
  return rendered;
}

export function podSpec(resource: ChartResource | undefined) {
  assert.ok(resource, "Expected a rendered workload");
  const spec = resource.spec;
  assert.ok(
    Check(podTemplateShape, spec),
    `Unexpected Pod template in ${resource.kind}/${resource.metadata.name}`,
  );
  return spec.template.spec;
}

export function pod(objects: ChartResource[], component: "api" | "worker") {
  return podSpec(findResource(objects, "Deployment", `openclaw-enterprise-${component}`));
}

export function preflightPod(stdout: string) {
  const resource: unknown = JSON.parse(stdout);
  assert.ok(Check(resourceShape, resource), "Expected a generated workload");
  assert.equal(resource.kind, "Job");
  return podSpec(resource);
}

export function firstContainer(pod: Pod) {
  const [container] = pod.containers;
  assert.ok(container, "Expected a workload container");
  return container;
}

export function assembler(pod: Pod) {
  const init = pod.initContainers?.find(({ name }) => name === "assemble-api-ca");
  assert.ok(init, "Expected the API CA init container");
  return init;
}

export function secretVolume(pod: Pod, name: string) {
  const secret = pod.volumes.find((volume) => volume.name === name)?.secret;
  assert.ok(secret, `Expected a Secret volume named ${name}`);
  return secret;
}

export function envValue(container: Container, name: string) {
  const value = container.env.find((entry) => entry.name === name)?.value;
  assert.ok(value !== undefined, `Expected a value for ${name}`);
  return value;
}

export function execFailure(error: unknown) {
  assert.ok(
    error instanceof Error &&
      "code" in error &&
      "stdout" in error &&
      typeof error.stdout === "string" &&
      "stderr" in error &&
      typeof error.stderr === "string",
    "Expected a failed subprocess with captured output",
  );
  return { code: error.code, stdout: error.stdout, stderr: error.stderr };
}

export async function certificates(directory: string, name: string, hostname: string) {
  const pki = join(directory, `${name}-pki`);
  await mkdir(pki);
  const paths = await caAndLeaf(pki, {
    caName: name,
    subject: `/O=Example Corp/CN=${hostname}`,
    subjectAltName: `DNS:${hostname}`,
    run: (command: string, args: string[]) => execute(command, args, { timeout: 10000 }),
  });
  return {
    "ca.pem": await readFile(paths.caPath, "utf8"),
    "ca.key": await readFile(paths.caKeyPath, "utf8"),
    "leaf.pem": await readFile(paths.certPath, "utf8"),
    "leaf.key": await readFile(paths.keyPath, "utf8"),
  };
}

// Materialize the rendered Secret items and emptyDir, and translate absolute mount
// paths into disposable local directories. Execute the rendered script unchanged.
export async function mountedPod(
  directory: string,
  api: Pod,
  secrets: Readonly<Record<string, string>>,
) {
  const volumes = new Map<string, string>();
  for (const volume of api.volumes) {
    const root = join(directory, volume.name);
    volumes.set(volume.name, root);
    await mkdir(root);
    if (volume.secret !== undefined) {
      for (const item of volume.secret.items ?? []) {
        const value = secrets[`${volume.secret.secretName}/${item.key}`];
        if (value !== undefined) {
          await writeFile(join(root, item.path), value);
        }
      }
    }
  }
  const resolve = (container: Container, path: string) => {
    const mount = container.volumeMounts.find(({ mountPath }) =>
      path.startsWith(join(mountPath, "/")),
    );
    assert.ok(mount, `No rendered mount for ${path}`);
    const root = volumes.get(mount.name);
    assert.ok(root, `No rendered volume named ${mount.name}`);
    return join(root, path.slice(mount.mountPath.length));
  };
  const init = assembler(api);
  const args = init.args.map((arg) => (arg.startsWith("/") ? resolve(init, arg) : arg));
  // The rendered source names are keyed by mount path; map them to the local files.
  const sourcePaths: unknown = JSON.parse(envValue(init, "OCC_CA_SOURCES"));
  assert.ok(Check(caSourcesShape, sourcePaths), "Expected mount paths and CA source names");
  const sources = Object.fromEntries(
    Object.entries(sourcePaths).map(([path, source]) => [resolve(init, path), source]),
  );
  const container = firstContainer(api);
  return {
    resolve: (path: string) => resolve(container, path),
    assemble: () =>
      execute(process.execPath, args, {
        env: { OCC_CA_SOURCES: JSON.stringify(sources) },
        timeout: 10000,
      }),
    output: resolve(container, envValue(container, "NODE_EXTRA_CA_CERTS")),
    oidcInput: resolve(init, "/etc/openclaw/oidc-ca/ca.crt"),
    gatewayInput: resolve(init, "/etc/openclaw/gateway-ca/ca.crt"),
  };
}
