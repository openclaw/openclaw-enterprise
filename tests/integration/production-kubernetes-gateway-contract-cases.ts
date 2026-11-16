import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isIP } from "node:net";
import { join } from "node:path";
import test from "node:test";
import { checkServerIdentity, rootCertificates } from "node:tls";

import Type, { type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";

import {
  createKubernetesComputeDriver,
  PLUGIN_RUNTIME_STATUS_PORT,
  type KubernetesComputeDriverOptions,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { ConfigurationValidationError } from "../../packages/contracts/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { conformanceKubernetesOptions } from "../helpers/kubernetes-compute.mjs";
import { parseProductionChart, renderExecutionChart } from "../helpers/production-chart.ts";
import {
  gatewayRoutingValues,
  gatewaySandboxValues,
  render,
  stringNameMessage,
  tooling,
  type ChartValues,
} from "../helpers/production-chart-network-fixture.ts";
import { findResource } from "../helpers/production-chart-resource.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";

const productionGatewayName = "oce-agent-gateways";
const namedResources = Type.Array(
  Type.Object({
    kind: Type.String(),
    metadata: Type.Object({ name: Type.String() }),
    spec: Type.Optional(Type.Unknown()),
  }),
);
type ChartResource = Static<typeof namedResources>[number];

const gatewaySpec = Type.Object({
  listeners: Type.Array(
    Type.Object({
      name: Type.String(),
      hostname: Type.Optional(Type.String()),
      tls: Type.Optional(
        Type.Object({ certificateRefs: Type.Array(Type.Object({ name: Type.String() })) }),
      ),
    }),
  ),
});
const leafCertificateSpec = Type.Object({
  isCA: Type.Optional(Type.Literal(false)),
  secretName: Type.String(),
  dnsNames: Type.Array(Type.String()),
  duration: Type.String(),
  renewBefore: Type.String(),
  issuerRef: Type.Object({
    name: Type.String(),
    kind: Type.String(),
    group: Type.String(),
  }),
});
const envoyProxySpec = Type.Object({
  provider: Type.Object({
    kubernetes: Type.Object({
      envoyDeployment: Type.Optional(Type.Unknown()),
      envoyService: Type.Object({ name: Type.String(), type: Type.String() }),
    }),
  }),
});
const deploymentSpec = Type.Object({
  template: Type.Object({
    spec: Type.Object({
      containers: Type.Array(
        Type.Object({
          name: Type.String(),
          env: Type.Array(
            Type.Object({ name: Type.String(), value: Type.Optional(Type.String()) }),
          ),
          volumeMounts: Type.Array(
            Type.Object({
              name: Type.String(),
              mountPath: Type.String(),
              readOnly: Type.Optional(Type.Boolean()),
            }),
          ),
        }),
      ),
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
const installationExample = Type.Object({
  drivers: Type.Object({
    compute: Type.Object({
      configuration: Type.Object({
        gatewayRouting: Type.Object({
          hostname: Type.Optional(Type.String()),
          sandbox: Type.Optional(Type.Object({ domain: Type.String() })),
        }),
      }),
    }),
  }),
});
const loadedGatewayRouting = Type.Object({
  hostname: Type.Optional(Type.String()),
  envoyNamespace: Type.String(),
});

type TenantGatewayPortCase =
  | readonly [gatewayPort: number, sandbox: boolean, refused: true, message: string]
  | readonly [gatewayPort: number, sandbox: boolean, refused: false];

type ExternalGatewayTrustCase = {
  externalGatewayRoutingValues: ChartValues;
  serviceName: string;
  rootSecret: string;
};

async function resources(stdout: string): Promise<ChartResource[]> {
  const decoded: unknown = await parseProductionChart(stdout);
  assert.ok(Check(namedResources, decoded), "Expected named Kubernetes resources from Helm");
  return decoded;
}

function resourceSpec<S extends TSchema>(
  objects: readonly ChartResource[],
  kind: string,
  name: string,
  schema: S,
): Static<S> {
  const resource = findResource(objects, kind, name);
  assert.ok(resource, `Expected Helm to render ${kind}/${name}`);
  assert.ok(Check(schema, resource.spec), `Unexpected spec in ${kind}/${name}`);
  return resource.spec;
}

function httpsListener(objects: readonly ChartResource[], gatewayName: string) {
  const listener = resourceSpec(objects, "Gateway", gatewayName, gatewaySpec).listeners.find(
    ({ name }) => name === "https",
  );
  assert.ok(listener, `Expected the https listener on Gateway/${gatewayName}`);
  return listener;
}

function helmRefusal(...messages: readonly string[]) {
  return (error: unknown): boolean => {
    const failure = asRecord(error);
    const stderr = failure?.stderr;
    return (
      typeof failure?.code === "number" &&
      failure.code !== 0 &&
      typeof stderr === "string" &&
      messages.every((message) => stderr.includes(message))
    );
  };
}

function configurationFailure(
  error: unknown,
  path: string,
  message: RegExp,
): asserts error is ConfigurationValidationError {
  assert.ok(error instanceof ConfigurationValidationError);
  const detail = error.error.details[0];
  assert.ok(detail, `Expected a configuration error at ${path}`);
  assert.equal(detail.path, path);
  assert.equal(detail.code, "INVALID_FORMAT");
  assert.ok(typeof detail.message === "string", `Expected a message at ${path}`);
  assert.match(detail.message, message);
}

async function readInstallationExample() {
  const controllerRequire = createRequire(
    new URL("../../apps/controller/package.json", import.meta.url),
  );
  const sdk: unknown = controllerRequire("@kubernetes/client-node");
  const loadYaml = asRecord(sdk)?.loadYaml;
  assert.ok(typeof loadYaml === "function", "Expected the Kubernetes SDK YAML loader");
  const source = await readFile(
    new URL("../../deploy/examples/production/installation.yaml", import.meta.url),
    "utf8",
  );
  const decoded: unknown = loadYaml(source.replace("<actual-proxy-source-cidr>", "192.0.2.10/32"));
  assert.ok(
    Check(installationExample, decoded),
    "Expected the production example's Compute routing",
  );
  return decoded;
}

export function registerTenantGatewayPortCase(): void {
  test(
    "the chart refuses tenant Gateway ports Compute refuses for the runtime status port",
    tooling,
    async () => {
      const compute = (gatewayPort: number, sandbox: boolean) => {
        const options: KubernetesComputeDriverOptions = conformanceKubernetesOptions({
          gatewayTrustedProxyCidrs: ["10.0.0.0/8"],
          runtime: { transportSecretPrefix: "transport", gatewayStorageClassName: "local-path" },
        });
        // Routed Compute takes no direct gateway clients.
        const { gatewayClients, ...network } = options.network;
        return createKubernetesComputeDriver({
          ...options,
          network: { ...network, gatewayPort },
          gatewayRouting: {
            gatewayName: productionGatewayName,
            gatewayNamespace: "openclaw-system",
            envoyNamespace: "envoy-gateway-system",
            ...(sandbox ? { sandbox: { domain: "previews.example.test" } } : {}),
          },
        });
      };
      // tenantGatewayPort must equal Compute's network.gatewayPort, so Helm refuses exactly
      // what controller startup refuses instead of installing a controller that cannot start.
      const cases: readonly TenantGatewayPortCase[] = [
        [
          PLUGIN_RUNTIME_STATUS_PORT,
          false,
          true,
          `Gateway port cannot use the reserved runtime status port ${PLUGIN_RUNTIME_STATUS_PORT}.`,
        ],
        [
          PLUGIN_RUNTIME_STATUS_PORT,
          true,
          true,
          `Gateway port cannot use the reserved runtime status port ${PLUGIN_RUNTIME_STATUS_PORT}.`,
        ],
        [
          PLUGIN_RUNTIME_STATUS_PORT - 1,
          true,
          true,
          `Gateway sandbox port cannot use the reserved runtime status port ${PLUGIN_RUNTIME_STATUS_PORT}.`,
        ],
        [PLUGIN_RUNTIME_STATUS_PORT - 1, false, false],
        [PLUGIN_RUNTIME_STATUS_PORT + 1, true, false],
        [8080, true, false],
      ];
      for (const [gatewayPort, sandbox, refused, message] of cases) {
        const row = JSON.stringify({ gatewayPort, sandbox });
        const chartValues = {
          ...(sandbox ? gatewaySandboxValues : gatewayRoutingValues),
          "gatewayRouting.tenantGatewayPort": String(gatewayPort),
        };
        if (refused) {
          assert.throws(
            () => compute(gatewayPort, sandbox),
            (error: unknown) => {
              assert.ok(error instanceof ConfigurationValidationError);
              assert.deepEqual(error.error.details, [
                { path: "/network/gatewayPort", code: "INVALID_VALUE", message },
              ]);
              return true;
            },
            row,
          );
          await assert.rejects(
            render(chartValues),
            helmRefusal(
              "gatewayRouting.tenantGatewayPort",
              `reserved runtime status port ${PLUGIN_RUNTIME_STATUS_PORT}`,
            ),
            row,
          );
        } else {
          assert.doesNotThrow(() => compute(gatewayPort, sandbox), row);
          await render(chartValues);
        }
      }
    },
  );
}

export function registerProductionGatewayHostnameCase(sandboxValues: ChartValues): void {
  test(
    "production Helm custom Gateway hostname follows the loaded Compute contract",
    tooling,
    async (t) => {
      const { loadInstallationConfiguration } =
        await import("../../apps/controller/src/composition/installation-config.ts");
      const directory = await temporaryDirectory(t, "occ-control-hostname-");
      const example = await readInstallationExample();
      // Node accepts PeerCertificate metadata for this identity check. Keep the
      // chart's rendered names as the only SANs and prevent common-name fallback.
      const [rootCertificate] = rootCertificates;
      assert.ok(rootCertificate);
      const peer = new X509Certificate(rootCertificate).toLegacyObject();
      const installationPath = join(directory, "installation.yaml");
      const load = () =>
        loadInstallationConfiguration({
          mode: "production",
          environment: { OCC_CONFIG_PATH: installationPath },
        });
      const invalid = [
        "192.168.1",
        "2130706433",
        "127.1",
        "0177.0.0.1",
        "0x7f000001",
        "0x7f.0.0.1",
        "0x",
        "0x.0.0.1",
        "1.2.3.4.5",
        "0.0.0.08",
        "api.0x10",
        "api.123",
        "999.1.2.3",
        "example.0x10",
        "Bad_Host",
        "proxy.example.test:443",
        "https://proxy.example.test",
        "proxy..example.test",
        `${"a".repeat(64)}.test`,
        `${"a".repeat(63)}.${"a".repeat(63)}.${"a".repeat(63)}.${"a".repeat(62)}`,
      ];
      const valid = [
        "192.168.1.1",
        "192.0.2.1",
        "0.0.0.0",
        "255.255.255.255",
        "0xdead.gateway.example.test",
        "proxy.example.test",
        `${"a".repeat(63)}.test`,
        `${"a".repeat(63)}.${"a".repeat(63)}.${"a".repeat(63)}.${"a".repeat(61)}`,
        "",
        undefined,
      ];
      for (const hostname of [...invalid, ...valid]) {
        const configuration = structuredClone(example);
        if (hostname === undefined) {
          delete configuration.drivers.compute.configuration.gatewayRouting.hostname;
        } else {
          configuration.drivers.compute.configuration.gatewayRouting.hostname = hostname;
        }
        await writeFile(installationPath, JSON.stringify(configuration));
        // Helm --set reads a bare integer or 0x hex as a number. Pass those spellings
        // with --set-string so the chart sees the hostname the Installation stores.
        const renderHostname = () => {
          if (hostname === undefined) {
            return render(gatewayRoutingValues);
          }
          if (/^(?:0x[0-9a-f]*|\d+)$/.test(hostname)) {
            return render(gatewayRoutingValues, {
              strings: { "gatewayRouting.hostname": hostname },
            });
          }
          return render({ ...gatewayRoutingValues, "gatewayRouting.hostname": hostname });
        };
        if (hostname !== undefined && invalid.includes(hostname)) {
          await assert.rejects(load(), (error: unknown) => {
            configurationFailure(
              error,
              "/gatewayRouting/hostname",
              hostname === "api.123"
                ? /Gateway routing hostname must be .*numeric or 0x last label parses as IPv4; use a DNS name resolving to the gateway that its TLS certificate covers/
                : /Gateway routing hostname must be a DNS hostname without a port or path/,
            );
            assert.doesNotMatch(JSON.stringify(error.error.details), /Bad_Host/);
            return true;
          });
          await assert.rejects(
            renderHostname(),
            helmRefusal(
              hostname === "api.123"
                ? "gatewayRouting.hostname must be a DNS hostname without a port or path. A numeric or 0x last label parses as IPv4; use a DNS name resolving to the gateway that its TLS certificate covers"
                : "gatewayRouting.hostname must be a DNS hostname without a port or path",
            ),
            hostname,
          );
          continue;
        }
        const loaded = await load();
        assert.ok(loaded, "Expected the production example to load");
        const routing = loaded.installation.drivers.compute.configuration.gatewayRouting;
        assert.ok(Check(loadedGatewayRouting, routing), "Expected loaded Compute routing");
        const objects = await resources((await renderHostname()).stdout);
        const listener = httpsListener(objects, productionGatewayName);
        const envoy = resourceSpec(objects, "EnvoyProxy", productionGatewayName, envoyProxySpec);
        const certificateName = `${productionGatewayName}-tls`;
        const certificate = resourceSpec(
          objects,
          "Certificate",
          certificateName,
          leafCertificateSpec,
        );
        assert.ok(
          listener.tls?.certificateRefs.some(({ name }) => name === certificate.secretName),
        );
        const expected =
          hostname ||
          `${envoy.provider.kubernetes.envoyService.name}.${routing.envoyNamespace}.svc`;
        assert.equal(listener.hostname, expected);
        assert.deepEqual(certificate.dnsNames, [expected]);
        // Admission preserves canonical IPv4 syntax, but the standard chart requests
        // DNS SANs, not IP SANs. A rendered address is not a usable TLS endpoint.
        const identityError = checkServerIdentity(expected, {
          ...peer,
          subject: {},
          subjectaltname: certificate.dnsNames.map((name) => `DNS:${name}`).join(", "),
        });
        if (isIP(expected) === 4) {
          assert.ok(identityError && "code" in identityError);
          assert.equal(identityError.code, "ERR_TLS_CERT_ALTNAME_INVALID");
        } else {
          assert.equal(identityError, undefined);
        }
        assert.equal(routing.hostname, hostname);
      }
      // Direct IPv4 passes address admission only; an Agent-prefixed suffix cannot be a URL host.
      for (const domain of ["192.0.2.1", "previews.example.test", "0xdead.previews.example.test"]) {
        const configuration = structuredClone(example);
        configuration.drivers.compute.configuration.gatewayRouting.sandbox = { domain };
        await writeFile(installationPath, JSON.stringify(configuration));
        const rendered = () =>
          render({ ...sandboxValues, "gatewayRouting.sandbox.domain": domain });
        if (domain === "192.0.2.1") {
          await assert.rejects(load(), (error: unknown) => {
            configurationFailure(
              error,
              "/gatewayRouting/sandbox/domain",
              /Sandbox domain must be a DNS hostname.*Agent label/,
            );
            return true;
          });
          await assert.rejects(
            rendered(),
            /gatewayRouting\.sandbox\.domain must be a DNS hostname.*Agent label/,
          );
        } else {
          assert.ok(await load(), "Expected the sandbox domain to load");
          await rendered();
        }
      }
    },
  );
}

export function registerExternalGatewayTrustCase({
  externalGatewayRoutingValues,
  serviceName,
  rootSecret,
}: ExternalGatewayTrustCase): void {
  test(
    "private Envoy Gateway routing preserves explicit hostnames and external CA trust",
    tooling,
    async () => {
      const configured = await resources(
        (
          await render({
            ...externalGatewayRoutingValues,
            "gatewayRouting.caSecretName": "occ-private-ca",
            "gatewayRouting.caSecretKey": "ca.crt",
          })
        ).stdout,
      );
      for (const component of ["api", "worker"]) {
        const deployment = resourceSpec(
          configured,
          "Deployment",
          `openclaw-enterprise-${component}`,
          deploymentSpec,
        );
        const pod = deployment.template.spec;
        const container = pod.containers.find(({ name }) => name === component);
        assert.ok(container, `Expected ${component} in its Deployment`);
        assert.deepEqual(pod.volumes.find(({ name }) => name === "gateway-ca")?.secret, {
          secretName: "occ-private-ca",
          items: [{ key: "ca.crt", path: "ca.crt" }],
        });
        assert.deepEqual(
          container.volumeMounts.find(({ name }) => name === "gateway-ca"),
          {
            name: "gateway-ca",
            mountPath: "/etc/openclaw/gateway-ca",
            readOnly: true,
          },
        );
        assert.equal(
          container.env.find(({ name }) => name === "NODE_EXTRA_CA_CERTS")?.value,
          "/etc/openclaw/gateway-ca/ca.crt",
        );
      }
      assert.equal(findResource(configured, "Certificate", rootSecret), undefined);
      assert.equal(findResource(configured, "Issuer", `${serviceName}-ca`), undefined);

      assert.equal(
        httpsListener(configured, productionGatewayName).hostname,
        "agents.example.internal",
      );
      const certificateName = `${productionGatewayName}-tls`;
      const leafCertificate = resourceSpec(
        configured,
        "Certificate",
        certificateName,
        leafCertificateSpec,
      );
      assert.deepEqual(leafCertificate, {
        secretName: certificateName,
        duration: "2160h",
        renewBefore: "720h",
        dnsNames: ["agents.example.internal"],
        issuerRef: {
          name: "occ-private-issuer",
          kind: "ClusterIssuer",
          group: "cert-manager.io",
        },
      });
      const envoyProxy = resourceSpec(
        configured,
        "EnvoyProxy",
        productionGatewayName,
        envoyProxySpec,
      );
      assert.equal(envoyProxy.provider.kubernetes.envoyDeployment, undefined);
      assert.deepEqual(envoyProxy.provider.kubernetes.envoyService, {
        name: serviceName,
        type: "ClusterIP",
      });
    },
  );
}

export function registerExecutionGatewayHostnameCase(): void {
  test("execution chart refuses a harness hostname Compute refuses", tooling, async () => {
    // A later --set or --set-string replaces the helper's routing.hostname.
    const renderHostname = (
      option: "--set" | "--set-string",
      hostname: string,
    ): Promise<{ stdout: string; stderr: string }> =>
      renderExecutionChart(option, `routing.hostname=${hostname}`);
    await assert.rejects(
      renderHostname("--set", "Bad_Host"),
      /routing\.hostname must be a DNS hostname without a port or path/,
    );
    // --set reads these as a number and a boolean; the chart names the field instead of failing in len.
    for (const hostname of ["123", "true"]) {
      await assert.rejects(
        renderHostname("--set", hostname),
        helmRefusal(`routing.hostname ${stringNameMessage}`),
        hostname,
      );
    }
    for (const hostname of [
      "123",
      "127.1",
      "0x",
      "0x.0.0.1",
      "1.2.3.4.5",
      "api.0x10",
      "api.123",
      "999.1.2.3",
      "example.0x10",
    ]) {
      await assert.rejects(
        renderHostname("--set-string", hostname),
        /routing\.hostname must be .*numeric or 0x last label parses as IPv4; use a DNS name resolving to the gateway that its TLS certificate covers/,
        hostname,
      );
    }
    for (const hostname of ["agents.example.invalid", "0xdead.gateway.example.test"]) {
      const rendered = await renderHostname("--set-string", hostname);
      assert.equal(
        httpsListener(await resources(rendered.stdout), "oce-harnesses").hostname,
        hostname,
      );
    }
  });
}
