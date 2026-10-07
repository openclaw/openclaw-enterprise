import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KubernetesApiUnavailableError } from "../../apps/controller/src/drivers/kubernetes/client.ts";
import {
  createKubernetesComputeDriver,
  kubernetesGatewayNamespaceName,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { createOccLogger, emitOccLogEvent } from "../../apps/controller/src/logging.ts";
import { startupDependencyFailure } from "../../apps/controller/src/startup-failure.ts";
import {
  conformanceKubernetesOptions,
  createTestKubernetesComputeDriver,
} from "../helpers/kubernetes-compute.mjs";
import { availablePort } from "../helpers/available-port.mjs";

function driverForVersion(gitVersion) {
  const driver = createTestKubernetesComputeDriver("compute-kubernetes-preflight");
  let namespaceReads = 0;
  driver.apiClients = Promise.resolve({
    version: {
      async getCode() {
        return { gitVersion };
      },
    },
    core: {
      async listNamespace() {
        namespaceReads += 1;
        return { items: [] };
      },
    },
  });
  return { driver, namespaceReads: () => namespaceReads };
}

test("Kubernetes preflight warns below 1.35 without blocking authenticated access", async () => {
  const fixture = driverForVersion("v1.34.12+k3s1");

  const result = await fixture.driver.preflight();

  assert.deepEqual(result, {
    warnings: [
      {
        code: "KUBERNETES_VERSION_BELOW_MINIMUM",
        message: "Kubernetes 1.34.12 is below the supported minimum 1.35.0.",
      },
    ],
  });
  assert.equal(
    fixture.namespaceReads(),
    1,
    "an advisory version warning must not skip the authenticated namespace preflight",
  );
});

test("Kubernetes preflight accepts supported Kubernetes release families", async () => {
  for (const gitVersion of ["v1.35.0", "v1.35.0+k3s1", "v1.35.8+k3s1", "v1.36.4+k3s1"]) {
    const fixture = driverForVersion(gitVersion);
    assert.deepEqual(await fixture.driver.preflight(), { warnings: [] });
    assert.equal(fixture.namespaceReads(), 1);
  }
});

test("single-cluster preflight refuses legacy split storage on a later namespace page", async () => {
  const fixture = driverForVersion("v1.35.0");
  const { core } = await fixture.driver.apiClients;
  const namespaceId = "ns_upgrade_00000000-0000-4000-8000-000000000001";
  const legacy = {
    metadata: {
      name: kubernetesGatewayNamespaceName(namespaceId),
      labels: { "openclaw.dev/gateway-namespace": namespaceId },
    },
  };
  const original = structuredClone(legacy);
  let pages = 0;
  core.listNamespace = async ({ _continue: cursor }) => {
    pages += 1;
    if (cursor === undefined) {
      return { items: [], metadata: { _continue: "next-page" } };
    }
    assert.equal(cursor, "next-page");
    return { items: [legacy] };
  };
  await assert.rejects(fixture.driver.preflight(), /Existing split-layout Gateway storage/);
  assert.equal(pages, 2, "upgrade detection must inspect every namespace page");
  assert.deepEqual(legacy, original, "preflight must not alter legacy storage ownership");
});

test("single-cluster preflight accepts canonical storage in a shared tenant namespace", async () => {
  const fixture = driverForVersion("v1.35.0");
  const { core } = await fixture.driver.apiClients;
  core.listNamespace = async () => ({
    items: [
      {
        metadata: {
          name: "adopted-tenant",
          labels: {
            "openclaw.dev/gateway-namespace": "ns_shared",
            "openclaw.dev/namespace": "ns_shared",
          },
        },
      },
    ],
  });
  assert.deepEqual(await fixture.driver.preflight(), { warnings: [] });
});

test("Kubernetes preflight rejects an invalid API server version response", async () => {
  const fixture = driverForVersion("current");
  await assert.rejects(fixture.driver.preflight(), /version preflight returned invalid data/);
  assert.equal(fixture.namespaceReads(), 0);
});

test("Kubernetes preflight names the unreachable API server endpoint", async () => {
  // A just-released loopback port refuses connections.
  const port = await availablePort();
  const directory = await mkdtemp(join(tmpdir(), "occ-kubernetes-preflight-"));
  try {
    const kubeconfigPath = join(directory, "kubeconfig");
    await writeFile(
      kubeconfigPath,
      [
        "apiVersion: v1",
        "kind: Config",
        `clusters: [{name: target, cluster: {server: "https://127.0.0.1:${port}"}}]`,
        "users: [{name: operator, user: {token: preflight-token}}]",
        "contexts: [{name: target, context: {cluster: target, user: operator}}]",
        "current-context: target",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    const driver = createTestKubernetesComputeDriver("compute-kubernetes-unreachable", {
      authentication: { mode: "kubeconfig", kubeconfigPath, context: "target" },
    });

    const error = await driver.preflight().then(
      () => assert.fail("preflight must fail when the Kubernetes API is unreachable"),
      (failure) => failure,
    );

    assert.ok(error instanceof KubernetesApiUnavailableError, String(error));
    assert.equal(error.host, "127.0.0.1");
    assert.equal(error.port, port);
    assert.deepEqual(startupDependencyFailure(error), {
      code: "KUBERNETES_API_UNAVAILABLE",
      host: "127.0.0.1",
      port,
    });
    assert.equal(startupDependencyFailure(new Error("fetch failed")), undefined);

    const lines = [];
    const logger = createOccLogger({
      component: "occ-worker",
      destination: {
        write(chunk) {
          lines.push(JSON.parse(String(chunk)));
          return true;
        },
      },
    });
    emitOccLogEvent(logger, { event: "worker.startup-error", ...startupDependencyFailure(error) });
    assert.deepEqual(
      lines.map(({ severity, event, code, host, port: loggedPort }) => ({
        severity,
        event,
        code,
        host,
        port: loggedPort,
      })),
      [
        {
          severity: "ERROR",
          event: "worker.startup-error",
          code: "KUBERNETES_API_UNAVAILABLE",
          host: "127.0.0.1",
          port,
        },
      ],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Kubernetes preflight keeps TLS and HTTP failures distinct from an unreachable server", async () => {
  const trust = Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("self-signed certificate in certificate chain"), {
      code: "SELF_SIGNED_CERT_IN_CHAIN",
    }),
  });
  const forbidden = Object.assign(new Error("Forbidden"), { code: 403 });
  for (const failure of [trust, forbidden]) {
    const driver = createTestKubernetesComputeDriver("compute-kubernetes-reachable");
    driver.apiClients = Promise.resolve({
      server: "https://10.43.0.1:443",
      version: {
        async getCode() {
          throw failure;
        },
      },
    });
    await assert.rejects(driver.preflight(), (error) => error === failure);
  }
});

test("Kubernetes preflight reports a refused connection with the in-cluster endpoint", async () => {
  const refused = Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("connect ECONNREFUSED 10.43.0.1:443"), {
      code: "ECONNREFUSED",
    }),
  });
  const driver = createTestKubernetesComputeDriver("compute-kubernetes-refused");
  driver.apiClients = Promise.resolve({
    server: "https://10.43.0.1",
    version: {
      async getCode() {
        throw refused;
      },
    },
  });
  await assert.rejects(driver.preflight(), (error) => {
    assert.ok(error instanceof KubernetesApiUnavailableError);
    assert.deepEqual(startupDependencyFailure(error), {
      code: "KUBERNETES_API_UNAVAILABLE",
      host: "10.43.0.1",
      port: 443,
    });
    assert.equal(error.cause, refused);
    return true;
  });
});

test("Kubernetes preflight without a recorded endpoint keeps the original failure", async () => {
  const refused = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  const driver = createTestKubernetesComputeDriver("compute-kubernetes-no-endpoint");
  driver.apiClients = Promise.resolve({
    version: {
      async getCode() {
        throw refused;
      },
    },
  });
  await assert.rejects(driver.preflight(), (error) => error === refused);
});

// A two-cluster Driver whose execution cluster answers SelfSubjectAccessReviews from
// `review(attributes)`, for one tenant Namespace. The upgrade helper's preflight
// Pods call verifyExecutionTenantGrants with each component's own identity.
function executionDriver(review) {
  const configured = conformanceKubernetesOptions({
    gatewayTrustedProxyCidrs: ["127.0.0.1/32"],
    runtime: { transportSecretPrefix: "transport", gatewayStorageClassName: "local-path" },
  });
  delete configured.network.gatewayClients;
  configured.gatewayRouting = {
    hostname: "gateway.example.test",
    gatewayName: "gateway",
    gatewayNamespace: "system",
    envoyNamespace: "envoy",
  };
  configured.executionCluster = {
    authentication: { ...configured.authentication, context: "execution" },
    harnessRouting: { ...configured.gatewayRouting, hostname: "harness.example.test" },
    network: {
      dns: configured.network.dns,
      harnessEndpointCidrs: ["192.0.2.2/32"],
      gatewayEndpointCidrs: ["192.0.2.1/32"],
      pluginStatusProxySourceCidrs: ["192.0.2.2/32"],
    },
  };
  const driver = createKubernetesComputeDriver(configured);
  const reviews = [];
  driver.executionApiClients = Promise.resolve({
    core: {
      async listNamespace({ labelSelector }) {
        assert.equal(labelSelector, "openclaw.dev/namespace");
        return {
          items: [{ metadata: { name: "oce-tenant", labels: { "openclaw.dev/namespace": "ns" } } }],
        };
      },
    },
    authorization: {
      async createSelfSubjectAccessReview({ body }) {
        const attributes = body.spec.resourceAttributes;
        reviews.push(attributes);
        return { status: review(attributes) };
      },
    },
  });
  return { driver, reviews };
}

const ruleName = ({ verb, resource, subresource }) =>
  `${verb} ${resource}${subresource ? `/${subresource}` : ""}`;

test("execution tenant grant check names the API's missing Pod reads without runtime logs", async () => {
  // The release-era tenant API role: Deployment lists only.
  const { driver, reviews } = executionDriver((attributes) => ({
    allowed: attributes.group === "apps" && ruleName(attributes) === "list deployments",
  }));
  await assert.rejects(
    driver.verifyExecutionTenantGrants("api", { runtimeLogs: false }),
    (error) =>
      error.constructor.name === "ConfigurationFailure" &&
      error.message ===
        "The execution cluster's tenant api grant in Namespace oce-tenant lacks get pods, " +
          "list pods, get pods/proxy. Upgrade the openclaw-execution chart before this release.",
  );
  // Without runtime logs the check never asks for log or Event reads.
  assert.deepEqual(reviews.map(ruleName), [
    "list deployments",
    "get pods",
    "list pods",
    "get pods/proxy",
  ]);
});

test("execution tenant grant check reports an unevaluated review as incomplete", async () => {
  const { driver } = executionDriver(() => ({
    allowed: false,
    evaluationError: "webhook authorizer unavailable",
  }));
  await assert.rejects(
    driver.verifyExecutionTenantGrants("worker", { runtimeLogs: true }),
    (error) =>
      error.constructor.name !== "ConfigurationFailure" &&
      error.message ===
        "The execution cluster tenant grant review failed: could not evaluate get pods in " +
          "Namespace oce-tenant: webhook authorizer unavailable",
  );
});
