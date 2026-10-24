import assert from "node:assert/strict";
import test from "node:test";
import { ConfigurationValidationError } from "../../packages/contracts/src/index.ts";
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
import { refusingPort } from "../helpers/available-port.mjs";
import { createInstallationDriverConfiguration } from "../helpers/installation-driver-configuration.mjs";
import { loadInstallationFile } from "../helpers/installation-file.mjs";

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

test("Kubernetes preflight names the unreachable API server endpoint", async (t) => {
  // A held loopback port refuses connections; a released one could be taken by a parallel test.
  const refusing = await refusingPort();
  t.after(() => refusing.release());
  const { port } = refusing;
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

// Two-cluster options; `network` overrides entries of the execution cluster's network.
function executionOptions(network = {}) {
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
      ...network,
    },
  };
  return configured;
}

test("startup reports Kubernetes configuration errors at their original paths", async (t) => {
  const config = createInstallationDriverConfiguration();
  const { compute } = config.drivers;
  const start = () => loadInstallationFile(t, config);
  // Keep the startup settings production requires that the driver-level options don't carry.
  const { images, servicePrincipalCredentials } = compute.configuration;
  const twoClusters = { ...executionOptions(), images, servicePrincipalCredentials };

  assert.equal((await start()).computeDriver.id, compute.id);
  compute.configuration = twoClusters;
  assert.equal((await start()).computeDriver.id, compute.id);

  for (const [change, path, message, code = "INVALID_FORMAT"] of [
    [
      (c) => {
        delete c.executionCluster.authentication.context;
      },
      "/executionCluster/authentication/context",
      "Explicit Kubernetes context must be explicitly configured.",
      "REQUIRED",
    ],
    [
      (c) => {
        c.gatewayRouting.gatewayName = "Bad_Name";
      },
      "/gatewayRouting/gatewayName",
      "Gateway routing Gateway name must be a DNS-safe Kubernetes resource name.",
    ],
    [
      (c) => {
        c.network.gatewayTrustedProxyCidrs = ["0.0.0.0/0"];
      },
      "/network/gatewayTrustedProxyCidrs/0",
      "Trusted proxy CIDRs cannot cover every address.",
    ],
    [
      (c) => {
        c.authentication.kubeconfigPath = "relative";
      },
      "/authentication/kubeconfigPath",
      "Dedicated kubeconfig path must be absolute.",
    ],
    [
      (c) => {
        c.executionCluster.authentication.kubeconfigPath = "relative";
      },
      "/executionCluster/authentication/kubeconfigPath",
      "Dedicated kubeconfig path must be absolute.",
    ],
    [
      (c) => {
        c.executionCluster.network.dns = { ...c.executionCluster.network.dns, namespace: "Bad_NS" };
      },
      "/executionCluster/network/dns/namespace",
      "DNS peer namespace must be a Kubernetes namespace name: a DNS label of at most 63 characters.",
    ],
    [
      (c) => {
        c.executionCluster.harnessRouting.hostname = "Bad_Host";
      },
      "/executionCluster/harnessRouting/hostname",
      "Harness routing hostname must be a DNS hostname without a port or path.",
    ],
    [
      (c) => {
        c.executionCluster.authentication = { mode: "inCluster" };
      },
      "/executionCluster/authentication",
      "The execution cluster requires its own explicit kubeconfig.",
    ],
    [
      (c) => {
        c.executionCluster.network.dns = {
          namespace: "kube-system",
          podLabels: { "private/key/name": "dns" },
        };
      },
      "/executionCluster/network/dns/podLabels",
      "DNS peer label keys must be Kubernetes label keys.",
    ],
    [
      (c) => {
        c.network.gatewayClients = [c.network.dns];
      },
      "/network/gatewayClients",
      "Gateway routing derives the Envoy gateway client peer; do not configure network.gatewayClients.",
    ],
  ]) {
    compute.configuration = structuredClone(twoClusters);
    change(compute.configuration);
    await assert.rejects(start, (error) => {
      assert.ok(error instanceof ConfigurationValidationError);
      assert.deepEqual(error.error.details, [{ path, code, message }]);
      assert.doesNotMatch(
        JSON.stringify(error.error.details),
        /relative|Bad_NS|Bad_Host|private\/key\/name/,
      );
      return true;
    });
  }
});

// Execution CIDR lists use the trusted proxy rule: no entry may cover every address.
test("two-cluster CIDR lists refuse ranges that cover every address", () => {
  const diagnostic = (path, code, message) => (error) => {
    assert.ok(error instanceof ConfigurationValidationError);
    assert.deepEqual(error.error.details, [{ path, code, message }]);
    return true;
  };
  for (const [key, description] of [
    ["harnessEndpointCidrs", "Harness endpoint CIDR"],
    ["gatewayEndpointCidrs", "Gateway endpoint CIDR"],
    ["pluginStatusProxySourceCidrs", "Execution status proxy CIDR"],
  ]) {
    for (const cidr of ["0.0.0.0/0", "::/0", "::ffff:0:0/96"]) {
      assert.throws(
        () => createKubernetesComputeDriver(executionOptions({ [key]: ["192.0.2.9/32", cidr] })),
        diagnostic(
          `/executionCluster/network/${key}/1`,
          "INVALID_FORMAT",
          `${description}s cannot cover every address.`,
        ),
        `${key} ${cidr}`,
      );
    }
    assert.throws(
      () => createKubernetesComputeDriver(executionOptions({ [key]: [] })),
      diagnostic(
        `/executionCluster/network/${key}`,
        "INVALID_VALUE",
        "Configuration does not satisfy minItems.",
      ),
    );
    assert.throws(
      () => createKubernetesComputeDriver(executionOptions({ [key]: ["192.0.2.9/33"] })),
      diagnostic(
        `/executionCluster/network/${key}/0`,
        "INVALID_FORMAT",
        `${description} 0 must be a valid IPv4 or IPv6 CIDR.`,
      ),
    );
    assert.doesNotThrow(() =>
      createKubernetesComputeDriver(executionOptions({ [key]: ["10.42.0.0/16", "::/96"] })),
    );
  }
});

// The documented status proxy source is the API server's address; a wider range, such as
// the Pod CIDR, admits every Pod in it to the status port. It starts, with a warning.
test("Kubernetes preflight warns about status proxy sources wider than one address", async () => {
  const configured = executionOptions({
    pluginStatusProxySourceCidrs: ["192.0.2.2/32", "10.42.0.0/16"],
  });
  configured.network.pluginStatusProxySourceCidrs = ["2001:db8::1/128", "2001:db8::/64"];
  const driver = createKubernetesComputeDriver(configured);
  let identity = 0;
  const clients = {
    version: {
      async getCode() {
        return { gitVersion: "v1.35.0" };
      },
    },
    core: {
      async listNamespace() {
        return { items: [] };
      },
      async readNamespace() {
        identity += 1;
        return { metadata: { uid: `cluster-${identity}` } };
      },
    },
  };
  driver.apiClients = Promise.resolve(clients);
  driver.executionApiClients = Promise.resolve(clients);
  const warning = (cidr) => ({
    code: "KUBERNETES_STATUS_PROXY_SOURCE_BROAD",
    message:
      `Plugin status proxy CIDR ${cidr} covers more than one address: every Pod in it ` +
      "can reach the Agent status port. Use the API server /32 or /128 source addresses.",
  });
  const result = await driver.preflight();
  assert.deepEqual(result, {
    warnings: [warning("2001:db8::/64"), warning("10.42.0.0/16")],
  });
  // The worker logs each warning; the log keeps only plain text, so the message must survive.
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
  for (const entry of result.warnings) {
    emitOccLogEvent(logger, { event: "compute.preflight-warning", ...entry });
  }
  assert.deepEqual(
    lines.map(({ code, message }) => ({ code, message })),
    result.warnings,
  );

  const exact = createKubernetesComputeDriver(executionOptions());
  exact.apiClients = Promise.resolve(clients);
  exact.executionApiClients = Promise.resolve(clients);
  assert.deepEqual(await exact.preflight(), { warnings: [] });
});

// A two-cluster Driver whose execution cluster answers SelfSubjectAccessReviews from
// `review(attributes)`, for one tenant Namespace. The upgrade helper's preflight
// Pods call verifyExecutionTenantGrants with each component's own identity.
function executionDriver(
  review,
  listNamespace = async ({ labelSelector }) => {
    assert.equal(labelSelector, "openclaw.dev/namespace");
    return {
      items: [{ metadata: { name: "oce-tenant", labels: { "openclaw.dev/namespace": "ns" } } }],
    };
  },
) {
  const driver = createKubernetesComputeDriver(executionOptions());
  const reviews = [];
  driver.executionApiClients = Promise.resolve({
    core: { listNamespace },
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

test("execution tenant grant check reads every Namespace page before any review", async () => {
  const events = [];
  const pages = {
    first: {
      items: [
        { metadata: { name: "oce-first", labels: { "openclaw.dev/namespace": "ns_a" } } },
        // An item without a name is not a Namespace to review.
        { metadata: { labels: { "openclaw.dev/namespace": "ns_unnamed" } } },
      ],
      metadata: { _continue: "page-2" },
    },
    "page-2": {
      items: [{ metadata: { name: "oce-second", labels: { "openclaw.dev/namespace": "ns_b" } } }],
      metadata: {},
    },
  };
  const { driver } = executionDriver(
    (attributes) => {
      events.push(`review ${attributes.namespace} ${ruleName(attributes)}`);
      // oce-first holds the current worker grant; oce-second only the older Pod read.
      return {
        allowed: attributes.namespace === "oce-first" || ruleName(attributes) === "get pods",
      };
    },
    async (request) => {
      events.push(`list ${request._continue ?? "first"}`);
      assert.equal(request.limit, 100);
      if (events.filter((event) => event.startsWith("list")).length > 2) {
        throw new Error("the Namespace list did not advance");
      }
      return pages[request._continue ?? "first"];
    },
  );
  await assert.rejects(
    driver.verifyExecutionTenantGrants("worker", { runtimeLogs: true }),
    (error) =>
      error.constructor.name === "ConfigurationFailure" &&
      error.message ===
        "The execution cluster's tenant worker grant in Namespace oce-second lacks patch pods, get jobs, create jobs, delete jobs. " +
          "Upgrade the openclaw-execution chart before this release.",
  );
  assert.deepEqual(events, [
    "list first",
    "list page-2",
    "review oce-first get pods",
    "review oce-first patch pods",
    "review oce-first get jobs",
    "review oce-first create jobs",
    "review oce-first delete jobs",
    "review oce-second get pods",
    "review oce-second patch pods",
    "review oce-second get jobs",
    "review oce-second create jobs",
    "review oce-second delete jobs",
  ]);
});

test("execution tenant grant check treats a review without a decision as missing", async () => {
  // Only an explicit `allowed: true` grants; an empty status is not an allowance.
  const { driver, reviews } = executionDriver((attributes) =>
    ruleName(attributes) === "get pods" ? { allowed: true } : {},
  );
  await assert.rejects(
    driver.verifyExecutionTenantGrants("worker", { runtimeLogs: false }),
    (error) =>
      error.constructor.name === "ConfigurationFailure" &&
      error.message ===
        "The execution cluster's tenant worker grant in Namespace oce-tenant lacks patch pods, get jobs, create jobs, delete jobs. " +
          "Upgrade the openclaw-execution chart before this release.",
  );
  assert.deepEqual(reviews.map(ruleName), [
    "get pods",
    "patch pods",
    "get jobs",
    "create jobs",
    "delete jobs",
  ]);
  assert.ok(
    reviews.filter(({ resource }) => resource === "jobs").every(({ group }) => group === "batch"),
  );
});

test("execution tenant grant check reports an invalid Namespace list as incomplete", async () => {
  const { driver, reviews } = executionDriver(
    () => ({ allowed: true }),
    async () => ({ items: null }),
  );
  await assert.rejects(
    driver.verifyExecutionTenantGrants("api", { runtimeLogs: true }),
    (error) =>
      error.constructor === Error &&
      error.cause?.message === "the Namespace list returned invalid data." &&
      error.message ===
        "The execution cluster tenant grant review failed: the Namespace list returned invalid data.",
  );
  assert.deepEqual(reviews, []);
});
