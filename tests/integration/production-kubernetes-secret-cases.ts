import assert from "node:assert/strict";
import test from "node:test";
import Type, { type Static } from "typebox";
import { Check } from "typebox/value";

import { parseProductionChart, productionCollectorValues } from "../helpers/production-chart.ts";
import {
  gatewayRoutingValues,
  gatewaySandboxValues,
  repositoryCredentialValues,
  tooling,
  type ChartValues,
  type render as chartRender,
} from "../helpers/production-chart-network-fixture.ts";
import { findResource } from "../helpers/production-chart-resource.ts";

const chartResources = Type.Array(
  Type.Object({
    kind: Type.String(),
    metadata: Type.Object({
      name: Type.String(),
      labels: Type.Optional(Type.Record(Type.String(), Type.String())),
    }),
    spec: Type.Optional(Type.Unknown()),
  }),
);
const container = Type.Object({
  name: Type.String(),
  volumeMounts: Type.Optional(
    Type.Array(
      Type.Object({
        name: Type.String(),
        mountPath: Type.String(),
        readOnly: Type.Optional(Type.Boolean()),
      }),
    ),
  ),
});
const workloadSpec = Type.Object({
  template: Type.Object({
    spec: Type.Object({
      containers: Type.Array(container),
      initContainers: Type.Optional(Type.Array(container)),
      volumes: Type.Optional(
        Type.Array(
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
      ),
    }),
  }),
});
type ChartResources = Static<typeof chartResources>;
type Container = Static<typeof container>;

async function resources(stdout: string): Promise<ChartResources> {
  const objects: unknown = await parseProductionChart(stdout);
  assert.ok(Check(chartResources, objects), "Helm must render named Kubernetes resources");
  return objects;
}

function podSpec(workload: ChartResources[number] | undefined, expected: string) {
  assert.ok(workload, `Helm must render ${expected}`);
  assert.ok(Check(workloadSpec, workload.spec), `${workload.metadata.name} must have a Pod spec`);
  return workload.spec.template.spec;
}

function controlPlanePod(objects: ChartResources, kind: string, component: string) {
  const workload = objects.find(
    (object) =>
      object.kind === kind && object.metadata.labels?.["app.kubernetes.io/component"] === component,
  );
  return podSpec(workload, `${component} ${kind}`);
}

type SecretCollision = readonly [values: ChartValues, secret: string, holder: string];
type SecretOverrideCollision = readonly [
  values: ChartValues,
  setting: string,
  secret: string,
  holder: string,
];

function generatedGatewaySecretCollisions(rootSecret: string): readonly SecretCollision[] {
  return [
    [gatewayRoutingValues, "oce-agent-gateways-tls", "gatewayRouting.tlsSecretName"],
    [gatewayRoutingValues, rootSecret, "the generated Gateway root CA"],
  ];
}

function helmRefusal(expected: string) {
  return (error: unknown): boolean =>
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "number" &&
    error.code !== 0 &&
    "stderr" in error &&
    typeof error.stderr === "string" &&
    error.stderr.includes(expected);
}

function dedicatedSecretRefusal(setting: string, secret: string, holder: string) {
  return helmRefusal(`${setting} must name a dedicated Secret; ${secret} is also ${holder}`);
}

export function registerExecutionClusterSecretCases({
  render,
  executionClusterValues,
  chatgptValues,
  googleLoginValues,
  databaseCaValues,
  sandboxValues,
  gatewayRootSecret,
}: {
  render: typeof chartRender;
  executionClusterValues: ChartValues;
  chatgptValues: ChartValues;
  googleLoginValues: ChartValues;
  databaseCaValues: ChartValues;
  sandboxValues: ChartValues;
  gatewayRootSecret: string;
}) {
  test(
    "two-cluster packaging separates remote API identities without optional services",
    tooling,
    async () => {
      // This guard must apply even when the unrelated repository service is disabled.
      await assert.rejects(
        render({ "executionCluster.enabled": "true" }),
        /separate API and worker/,
      );
      await assert.rejects(
        render({
          ...executionClusterValues,
          "executionCluster.workerKubeconfigSecretName": "execution-api",
        }),
        /separate API and worker/,
      );
      await assert.rejects(
        render({
          ...executionClusterValues,
          "executionCluster.apiKubeconfigSecretName": "occ-auth",
        }),
        /executionCluster\.apiKubeconfigSecretName must name a dedicated Secret; occ-auth is also auth\.secretName/,
      );
      for (const cidr of [
        "not-a-cidr",
        "10.1.1.1/33",
        "0.0.0.0/0",
        "12345::/64",
        "::ffff:999.1.2.3/64",
      ]) {
        await assert.rejects(
          render({ ...executionClusterValues, "executionCluster.apiCidrs[0]": cidr }),
          /executionCluster\.apiCidrs/,
          cidr,
        );
      }
      await render({ ...executionClusterValues, "executionCluster.apiCidrs[0]": "10.1.1.0/28" });
      await render({ ...executionClusterValues, "executionCluster.apiCidrs[0]": "2001:db8::/64" });
      // Enabling these features reserves the Secrets they read and the Secrets cert-manager writes.
      const collisions: readonly SecretCollision[] = [
        [chatgptValues, "occ-chatgpt-admin", "backend.chatgpt.secretName"],
        [googleLoginValues, "occ-google-login", "auth.google.secretName"],
        ...generatedGatewaySecretCollisions(gatewayRootSecret),
        [databaseCaValues, "occ-rds-ca", "database.caSecretName"],
        [sandboxValues, "preview-wildcard", "gatewayRouting.sandbox.tlsSecretName"],
      ];
      for (const [values, secret, role] of collisions) {
        for (const key of ["apiKubeconfigSecretName", "workerKubeconfigSecretName"]) {
          await assert.rejects(
            render({ ...executionClusterValues, ...values, [`executionCluster.${key}`]: secret }),
            dedicatedSecretRefusal(`executionCluster.${key}`, secret, role),
            `${key} = ${secret}`,
          );
        }
        // Until that feature is enabled, its Secret name is free.
        await render({
          ...executionClusterValues,
          "executionCluster.apiKubeconfigSecretName": secret,
        });
        await render({ ...executionClusterValues, ...values });
      }
      const objects = await resources((await render(executionClusterValues)).stdout);
      for (const component of ["api", "worker"]) {
        const name = `openclaw-enterprise-${component}`;
        const pod = podSpec(findResource(objects, "Deployment", name), name);
        const volume = pod.volumes?.find(({ name }) => name === "execution-kubeconfig");
        assert.equal(volume?.secret?.secretName, `execution-${component}`);
      }
    },
  );
}

export function registerDatabaseCaCases({
  render,
  databaseCaValues,
  chatgptValues,
  executionClusterValues,
  externalGatewayRoutingValues,
}: {
  render: typeof chartRender;
  databaseCaValues: ChartValues;
  chatgptValues: ChartValues;
  executionClusterValues: ChartValues;
  externalGatewayRoutingValues: ChartValues;
}) {
  test(
    "database CA mounts stay distinct from active production volume mounts",
    tooling,
    async () => {
      const authorityValues = {
        "egressAuthority.enabled": "true",
        "egressAuthority.tlsSecretName": "authority-server-tls",
        "egressAuthority.issuerSecretName": "gateway-jwt-keys",
        "egressAuthority.clients[0].namespaceSelector.matchLabels.kubernetes\\.io/metadata\\.name":
          "openshell-system",
        "egressAuthority.clients[0].podSelector.matchLabels.app": "openshell-gateway",
      };
      const custodyValues = {
        ...authorityValues,
        "preparedGitHub.custodySecretName": "prepared-github-custody",
        "preparedGitHub.issuerCidrs[0]": "192.0.2.3/32",
      };
      const issuerCaValues = {
        ...custodyValues,
        "preparedGitHub.issuerCaConfigMapName": "prepared-github-issuer-ca",
      };
      const optionalFeatures = {
        ...repositoryCredentialValues,
        ...gatewayRoutingValues,
        ...chatgptValues,
        ...executionClusterValues,
      };
      for (const features of [
        {},
        optionalFeatures,
        { ...issuerCaValues, "backend.openshell.clientSecretName": "dedicated-openshell-admin" },
      ]) {
        const objects = await resources((await render(features)).stdout);
        // Derive the existing mounts from shipped workloads, independently of the validation list.
        const paths = new Set(
          objects
            .filter((object) => {
              const component = object.metadata.labels?.["app.kubernetes.io/component"];
              return (
                ["Deployment", "Job"].includes(object.kind) &&
                (component === "api" || component === "worker" || component === "initialization")
              );
            })
            .map((object) => podSpec(object, object.metadata.name))
            .flatMap((pod) => [...(pod.initContainers ?? []), ...pod.containers])
            .filter((container) =>
              ["api", "worker", "migration", "bootstrap"].includes(container.name),
            )
            .flatMap((container) => (container.volumeMounts ?? []).map((mount) => mount.mountPath)),
        );
        assert.ok(paths.size > 0);
        for (const mountPath of paths) {
          // Linux kubelet/runtime destinations alias these spellings. The CA must not
          // hide an active volume after admission accepts the distinct raw strings.
          for (const alias of [
            mountPath,
            mountPath.slice(1),
            `${mountPath}/`,
            `${mountPath}/.`,
            `${mountPath}/../${mountPath.split("/").at(-1)}`,
            // The controller image links /var/run to /run, and the runtime follows it.
            ...(mountPath.startsWith("/run/") ? [`/var${mountPath}`] : []),
            ...(mountPath.startsWith("/var/run/") ? [mountPath.slice("/var".length)] : []),
            // It links /var/lock to /run/lock too, so ".." from /var/lock lands in /run, not /var.
            ...(mountPath.startsWith("/run/")
              ? [
                  `/var/lock/..${mountPath.slice("/run".length)}`,
                  `/run/lock/..${mountPath.slice("/run".length)}`,
                ]
              : []),
          ]) {
            await assert.rejects(
              render({ ...features, ...databaseCaValues, "database.caMountPath": alias }),
              /database.caMountPath.*distinct/,
              alias,
            );
          }
        }
      }
      // Paths reserved by optional features remain available when those features are disabled.
      for (const mountPath of [
        "/etc/openclaw/openshell",
        "/etc/openclaw/egress/tls",
        "/etc/openclaw/egress/issuer",
        "/etc/openclaw/prepared-github",
        "/etc/openclaw/prepared-github-issuer",
        "/etc/openclaw/execution",
        "/etc/openclaw/repository-registry",
        "/etc/openclaw/repository-ca",
        "/var/run/secrets/kubernetes.io/serviceaccount",
        "/run/secrets/kubernetes.io/serviceaccount",
        "/run/openclaw/repository-control",
        "/var/run/openclaw/repository-control",
        "/etc/openclaw/gateway-api-key",
        "/etc/openclaw/gateway-ca",
        "/etc/openclaw/chatgpt",
        "/custom/database-ca",
        "custom/database-ca",
        "/custom/./database-ca",
      ]) {
        await render({ ...databaseCaValues, "database.caMountPath": mountPath });
      }
      // Custody does not reserve an issuer CA directory unless the issuer CA is mounted.
      await render({
        ...custodyValues,
        ...databaseCaValues,
        "database.caMountPath": "/etc/openclaw/prepared-github-issuer",
      });
      const ordinary = (await render()).stdout;
      await render({
        ...externalGatewayRoutingValues,
        ...databaseCaValues,
        "database.caMountPath": "/etc/openclaw/gateway-ca",
      });
      // The repository sidecar's private mounts do not occur in a database client.
      for (const mountPath of [
        "/etc/openclaw/repository-inputs",
        "/run/openclaw/repository-private",
      ]) {
        await render({
          ...optionalFeatures,
          ...databaseCaValues,
          "database.caMountPath": mountPath,
        });
      }
      for (const mountPath of ["/etc/openclaw/installation", "/run/openclaw-bootstrap"]) {
        assert.equal((await render({ "database.caMountPath": mountPath })).stdout, ordinary);
      }
    },
  );

  test(
    "optional database CA Secret mounts into every production database client",
    tooling,
    async () => {
      const objects = await resources((await render(databaseCaValues)).stdout);
      const initialization = controlPlanePod(objects, "Job", "initialization");
      const assertDatabaseCaMount = (container: Container | undefined) => {
        assert.ok(container, "Helm must render the database client container");
        assert.deepEqual(
          container.volumeMounts?.find(({ name }) => name === "database-ca"),
          { name: "database-ca", mountPath: "/etc/openclaw/database-ca", readOnly: true },
          container.name,
        );
      };
      for (const [role, pod] of [
        ["bootstrap", initialization],
        ["api", controlPlanePod(objects, "Deployment", "api")],
        ["worker", controlPlanePod(objects, "Deployment", "worker")],
      ] as const) {
        assert.deepEqual(pod.volumes?.find(({ name }) => name === "database-ca")?.secret, {
          secretName: "occ-rds-ca",
          items: [{ key: "ca.pem", path: "ca.pem" }],
        });
        assert.equal(pod.containers[0]?.name, role);
        assertDatabaseCaMount(pod.containers[0]);
      }
      assertDatabaseCaMount(
        initialization.initContainers?.find(({ name }) => name === "migration"),
      );
    },
  );
}

export function registerDedicatedSecretCases({
  render,
  chatgptValues,
  googleLoginValues,
  databaseCaValues,
  externalGatewayRoutingValues,
  sandboxValues,
  gatewayRootSecret,
}: {
  render: typeof chartRender;
  chatgptValues: ChartValues;
  googleLoginValues: ChartValues;
  databaseCaValues: ChartValues;
  externalGatewayRoutingValues: ChartValues;
  sandboxValues: ChartValues;
  gatewayRootSecret: string;
}) {
  test(
    "the chart refuses a gateway API key Secret that holds other credentials",
    tooling,
    async () => {
      // Envoy Gateway's apiKeyAuth accepts every entry of the gateway API key Secret as a
      // client key, so a shared Secret would make the ChatGPT admin key, a CA certificate or a
      // TLS key a valid x-api-key.
      const collisions: readonly SecretOverrideCollision[] = [
        [
          chatgptValues,
          "gatewayRouting.apiKeySecretName",
          "occ-chatgpt-admin",
          "backend.chatgpt.secretName",
        ],
        [
          chatgptValues,
          "backend.chatgpt.secretName",
          "occ-gateway-api-key",
          "backend.chatgpt.secretName",
        ],
        [databaseCaValues, "database.caSecretName", "occ-gateway-api-key", "database.caSecretName"],
        [
          sandboxValues,
          "gatewayRouting.sandbox.tlsSecretName",
          "occ-gateway-api-key",
          "gatewayRouting.sandbox.tlsSecretName",
        ],
      ];
      for (const [values, setting, secret, holder] of collisions) {
        await assert.rejects(
          render({ ...gatewayRoutingValues, ...values, [setting]: secret }),
          dedicatedSecretRefusal("gatewayRouting.apiKeySecretName", secret, holder),
          `${setting} = ${secret}`,
        );
        // The same values with distinct names render.
        await render({ ...gatewayRoutingValues, ...values });
      }
      // Without the ChatGPT Backend the chart does not reserve that name.
      await render({
        ...gatewayRoutingValues,
        "gatewayRouting.apiKeySecretName": "occ-chatgpt-admin",
      });
    },
  );

  const externalGatewayCaValues = {
    ...externalGatewayRoutingValues,
    "gatewayRouting.issuerRef.kind": "ClusterIssuer",
    "gatewayRouting.issuerRef.group": "cert-manager.io",
    "gatewayRouting.caSecretName": "occ-private-ca",
    "gatewayRouting.caSecretKey": "ca.crt",
  };
  const gatewayCertificateSecretCollisions: readonly SecretCollision[] = [
    ...generatedGatewaySecretCollisions(gatewayRootSecret),
    [externalGatewayCaValues, "occ-private-ca", "gatewayRouting.caSecretName"],
  ];

  test(
    "the chart refuses sign-in Secrets that share a Gateway certificate Secret",
    tooling,
    async () => {
      // cert-manager writes the generated Gateway TLS and root CA Secrets and would overwrite a
      // sign-in Secret sharing either name.
      for (const [routing, secret, role] of gatewayCertificateSecretCollisions) {
        await assert.rejects(
          render({ ...routing, ...googleLoginValues, "auth.google.secretName": secret }),
          dedicatedSecretRefusal("auth.google.secretName", secret, role),
          secret,
        );
        // Without gateway routing those names are free.
        await render({ ...googleLoginValues, "auth.google.secretName": secret });
      }
      await render({ ...externalGatewayCaValues, ...googleLoginValues });
    },
  );

  test(
    "the chart refuses log collector Secrets shared with any credential Secret",
    tooling,
    async () => {
      // cert-manager could overwrite a collector config that shares a Gateway certificate Secret.
      const collisions: readonly SecretCollision[] = [
        [{}, "occ-installation-startup", "installation.secretName"],
        [{}, "occ-database", "database.secretName"],
        [{}, "occ-auth", "auth.secretName"],
        ...gatewayCertificateSecretCollisions,
        [databaseCaValues, "occ-rds-ca", "database.caSecretName"],
        [sandboxValues, "preview-wildcard", "gatewayRouting.sandbox.tlsSecretName"],
        [chatgptValues, "occ-chatgpt-admin", "backend.chatgpt.secretName"],
      ];
      for (const [feature, secret, role] of collisions) {
        for (const key of ["configSecretName", "envSecretName"]) {
          const setting = `logging.collector.${key}`;
          await assert.rejects(
            render({ ...productionCollectorValues, ...feature, [setting]: secret }),
            dedicatedSecretRefusal(setting, secret, role),
            `${key} = ${secret}`,
          );
        }
      }
      await assert.rejects(
        render({
          ...productionCollectorValues,
          "logging.collector.envSecretName": "occ-otel-collector-config",
        }),
        /logging\.collector\.envSecretName must name a dedicated Secret; occ-otel-collector-config is also logging\.collector\.configSecretName/,
      );
      // A disabled feature's Secret name is free, as preflight treats the ChatGPT admin Secret.
      await render({
        ...productionCollectorValues,
        "logging.collector.configSecretName": "occ-chatgpt-admin",
      });
    },
  );

  test("the chart requires installation and database Secret names", tooling, async () => {
    // Reject an empty name at template time so Pods never reference an unnamed Secret.
    for (const [key, message] of [
      ["installation.secretName", "installation startup"],
      ["database.secretName", "database URL"],
    ] as const) {
      // `null` removes the key, which must fail the same way as an empty name.
      for (const value of ["", "null"]) {
        await assert.rejects(
          render({ [key]: value }),
          helmRefusal(`${key} must name the operator-created ${message} Secret`),
          `${key}=${value}`,
        );
      }
    }
  });

  test(
    "the chart refuses credential Secrets shared with the database CA or sandbox TLS Secret",
    tooling,
    async () => {
      const collisions: readonly SecretOverrideCollision[] = [
        [
          { ...databaseCaValues, ...googleLoginValues },
          "auth.google.secretName",
          "occ-rds-ca",
          "database.caSecretName",
        ],
        [
          { ...databaseCaValues, ...repositoryCredentialValues },
          "repositoryCredentials.appKeySecretName",
          "occ-rds-ca",
          "database.caSecretName",
        ],
        [databaseCaValues, "database.caSecretName", "occ-database", "database.secretName"],
        [
          { ...gatewaySandboxValues, ...googleLoginValues },
          "auth.google.secretName",
          "preview-wildcard",
          "gatewayRouting.sandbox.tlsSecretName",
        ],
        [
          { ...gatewaySandboxValues, ...repositoryCredentialValues },
          "repositoryCredentials.tlsSecretName",
          "preview-wildcard",
          "gatewayRouting.sandbox.tlsSecretName",
        ],
        [
          gatewaySandboxValues,
          "gatewayRouting.sandbox.tlsSecretName",
          "oce-agent-gateways-tls",
          "gatewayRouting.tlsSecretName",
        ],
      ];
      for (const [base, setting, secret, holder] of collisions) {
        await assert.rejects(
          render({ ...base, [setting]: secret }),
          dedicatedSecretRefusal(setting, secret, holder),
          `${setting} = ${secret}`,
        );
        // The same values with distinct names render.
        await render(base);
      }
    },
  );

  test("the chart lets the public CA settings share one trust bundle Secret", tooling, async () => {
    // Each CA setting mounts only its selected key of public trust data, so one trust bundle
    // Secret may serve all of them. Private and cert-manager Secrets stay dedicated.
    const base = {
      ...externalGatewayCaValues,
      ...databaseCaValues,
      ...repositoryCredentialValues,
    };
    const settings = [
      "database.caSecretName",
      "gatewayRouting.caSecretName",
      "repositoryCredentials.publicCaSecretName",
    ];
    for (const [index, first] of settings.entries()) {
      for (const second of settings.slice(index + 1)) {
        await render({ ...base, [first]: "occ-trust-bundle", [second]: "occ-trust-bundle" });
      }
    }
    const shared = Object.fromEntries(settings.map((setting) => [setting, "occ-trust-bundle"]));
    const objects = await resources((await render({ ...base, ...shared })).stdout);
    const name = "openclaw-enterprise-api";
    const api = podSpec(findResource(objects, "Deployment", name), name);
    assert.ok(api.volumes, "Helm must render API Pod volumes");
    assert.deepEqual(
      api.volumes
        .flatMap((volume) => {
          if (volume.secret?.secretName !== "occ-trust-bundle") {
            return [];
          }
          assert.ok(volume.secret.items, `${volume.name} must select the trust bundle key`);
          return [[volume.name, volume.secret.items.map(({ key }) => key)]];
        })
        .sort(),
      [
        ["database-ca", ["ca.pem"]],
        ["gateway-ca", ["ca.crt"]],
        ["repository-public-ca", ["ca.crt"]],
      ],
    );
    // The bundle still may not hold a credential or a Secret cert-manager writes.
    for (const [setting, secret, refused, holder] of [
      ["database.caSecretName", "occ-database", "database.caSecretName", "database.secretName"],
      [
        "repositoryCredentials.tlsSecretName",
        "occ-trust-bundle",
        "repositoryCredentials.tlsSecretName",
        "database.caSecretName",
      ],
      [
        "gatewayRouting.apiKeySecretName",
        "occ-trust-bundle",
        "gatewayRouting.apiKeySecretName",
        "database.caSecretName",
      ],
      [
        "gatewayRouting.tlsSecretName",
        "occ-trust-bundle",
        "database.caSecretName",
        "gatewayRouting.tlsSecretName",
      ],
    ] as const) {
      await assert.rejects(
        render({ ...base, ...shared, [setting]: secret }),
        dedicatedSecretRefusal(refused, secret, holder),
        `${setting} = ${secret}`,
      );
    }
    // An external issuer creates no root CA Secret, so its generated name is free.
    await render({ ...base, ...googleLoginValues, "auth.google.secretName": gatewayRootSecret });
    await assert.rejects(
      render({
        ...gatewayRoutingValues,
        ...googleLoginValues,
        "auth.google.secretName": gatewayRootSecret,
      }),
      /auth\.google\.secretName must name a dedicated Secret; \S+ is also the generated Gateway root CA/,
    );
  });
}
