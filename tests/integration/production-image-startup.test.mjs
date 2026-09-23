import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { promisify } from "node:util";
import { imageSmokeTimeoutMultiplier } from "../helpers/image-smoke-timeout.mjs";

const execute = promisify(execFile);
const docker = process.env.OCC_DOCKER_BIN ?? "docker";
const image = process.env.OCC_TEST_PRODUCTION_IMAGE;
const imageTestOptions =
  image === undefined
    ? {
        skip: "Set OCC_TEST_PRODUCTION_IMAGE to a locally built production controller image tag.",
      }
    : {};

function productionResourceRequirements() {
  return {
    requests: { cpu: "100m", memory: "128Mi" },
    limits: { cpu: "500m", memory: "512Mi" },
  };
}

function workloadPeer(namespace, labels) {
  return { namespace, podLabels: labels };
}

function productionInstallation(adminKeyPath) {
  return {
    occ: { cluster: "production-image-smoke" },
    provider: [
      {
        id: "openai",
        type: "chatgpt",
        configuration: {
          workspaceId: "f7f33107-5fb9-4ee1-8922-3eae76b5b5a0",
          apiKeyPath: adminKeyPath,
          credentialTtlSeconds: 3600,
        },
        drivers: {
          service_account: "chatgpt-service-accounts",
        },
      },
    ],
    drivers: {
      configuration: {
        id: "config-kubernetes",
        configuration: { authentication: { mode: "inCluster" } },
      },
      iam: { id: "native-iam", configuration: {} },
      service_account: {
        id: "chatgpt-service-accounts",
        configuration: {},
      },
      secret: {
        id: "secret-kubernetes",
        configuration: { authentication: { mode: "inCluster" } },
      },
      compute: {
        id: "compute-kubernetes",
        configuration: {
          authentication: { mode: "inCluster" },
          images: {
            gateway: `registry.example.invalid/openclaw-gateway@sha256:${"a".repeat(64)}`,
            agent: `registry.example.invalid/openclaw-codex-agent@sha256:${"b".repeat(64)}`,
            requireImmutableDigest: true,
          },
          resources: {
            gateway: productionResourceRequirements(),
            agent: productionResourceRequirements(),
            namespace: {
              quota: { cpu: "2", memory: "2Gi" },
              containerDefaults: productionResourceRequirements(),
            },
          },
          network: {
            dns: workloadPeer("kube-system", { "k8s-app": "kube-dns" }),
            gatewayPort: 8787,
            gatewayTrustedProxyCidrs: ["127.0.0.1/32"],
            gatewayClients: [
              workloadPeer("openclaw-system", {
                "app.kubernetes.io/name": "openclaw-enterprise",
              }),
            ],
          },
          servicePrincipalCredentials: {
            mode: "projectedServiceAccountToken",
            audience: "openclaw-enterprise",
            expirationSeconds: 3600,
          },
          runtime: {
            transportSecretPrefix: "agent-transport",
            gatewayStorageClassName: "sqlite-block",
            channels: {
              proxyUrl: "http://198.51.100.10:8080",
            },
          },
        },
      },
      sandbox: {
        id: "sandbox-openshell",
        configuration: {
          gateway: {
            endpoint: "127.0.0.1:9",
            auth: { mode: "unauthenticated" },
          },
          kubernetes: {
            runtimeClassName: "openshell",
            serviceAccount: { mode: "gatewayConfigured" },
            sandboxDataMount: {
              subPath: "sandboxes",
              mountPath: "/sandbox/data",
              readOnly: false,
            },
          },
          policy: {
            process: { runAsUser: "1000", runAsGroup: "1000" },
            networkPolicies: [
              {
                name: "dns",
                endpoints: [{ host: "1.1.1.1", ports: [53], protocol: "udp" }],
                binaries: [{ path: "/app/bin/dns-client" }],
              },
            ],
          },
        },
      },
    },
  };
}
async function runDocker(args, options = {}) {
  return execute(docker, args, {
    timeout: 20_000 * imageSmokeTimeoutMultiplier,
    maxBuffer: 1_000_000,
    ...options,
  });
}

function imageFailureOutput(error) {
  return `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
}

function assertNoPackagingFailure(output) {
  assert.doesNotMatch(output, /ERR_MODULE_NOT_FOUND|Cannot find module|Cannot find package/);
  assert.doesNotMatch(output, /ENOENT: no such file or directory/);
  assert.doesNotMatch(output, /TypeScript .* is not supported in strip-only mode/);
  assert.doesNotMatch(output, /drivers\.sandbox selects unavailable bundled OpenShell/);
  assert.doesNotMatch(output, /OpenShell gRPC service was not found in the proto/);
}

function assertPersistenceBoundary(output, event) {
  const diagnostic = output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return undefined;
      }
    })
    .find((line) => line?.event === event);
  assert.ok(diagnostic, output);
  assert.equal(diagnostic.code, "PERSISTENCE_UNAVAILABLE");
  assert.doesNotMatch(output, /The platform persistence repository is unavailable/);
}

async function productionFixture(t) {
  const fixture = await mkdtemp(join(tmpdir(), "oce-production-image-"));
  await chmod(fixture, 0o755);
  t.after(() => rm(fixture, { recursive: true, force: true }));

  const adminKeyPath = "/tmp/oce-production-image/admin-key";
  await writeFile(join(fixture, "admin-key"), "test-chatgpt-admin-key\n", {
    encoding: "utf8",
    mode: 0o644,
  });
  await writeFile(
    join(fixture, "installation.json"),
    `${JSON.stringify(productionInstallation(adminKeyPath), undefined, 2)}\n`,
    { encoding: "utf8", mode: 0o644 },
  );
  return fixture;
}

test(
  "production image server startup loads bundled Kubernetes, OpenShell, and ChatGPT modules",
  imageTestOptions,
  async (t) => {
    const fixture = await productionFixture(t);

    let failure;
    try {
      await runDocker([
        "run",
        "--rm",
        "--network",
        "none",
        "--mount",
        `type=bind,src=${fixture},dst=/tmp/oce-production-image,readonly`,
        "-e",
        "NODE_ENV=production",
        "-e",
        "OCC_HOST=10.0.0.5",
        "-e",
        "OCC_PORT=3000",
        "-e",
        "OCC_CONFIG_PATH=/tmp/oce-production-image/installation.json",
        "-e",
        "OCC_AUTH_SECRET=openclaw-production-image-smoke-secret",
        "-e",
        "OCC_AUTH_BASE_URL=https://occ.example.invalid",
        "-e",
        "OCC_DATABASE_URL=postgresql://127.0.0.1:1/openclaw_enterprise",
        image,
      ]);
    } catch (error) {
      failure = error;
    }

    assert.ok(failure, "the smoke intentionally stops at the unavailable database boundary");
    assert.equal(failure.code, 1);
    const output = imageFailureOutput(failure);
    assertPersistenceBoundary(output, "startup-error");
    assertNoPackagingFailure(output);
  },
);

test(
  "production image worker startup loads the shared runtime graph",
  imageTestOptions,
  async (t) => {
    const fixture = await productionFixture(t);

    let failure;
    try {
      await runDocker([
        "run",
        "--rm",
        "--network",
        "none",
        "--mount",
        `type=bind,src=${fixture},dst=/tmp/oce-production-image,readonly`,
        "-e",
        "NODE_ENV=production",
        "-e",
        "OCC_CONFIG_PATH=/tmp/oce-production-image/installation.json",
        "-e",
        "OCC_DATABASE_URL=postgresql://127.0.0.1:1/openclaw_enterprise",
        image,
        "apps/controller/src/worker.mjs",
      ]);
    } catch (error) {
      failure = error;
    }

    assert.ok(failure, "the worker smoke intentionally stops at the database boundary");
    assert.equal(failure.code, 1);
    const output = imageFailureOutput(failure);
    assertPersistenceBoundary(output, "worker.startup-error");
    assertNoPackagingFailure(output);
  },
);

test("production image includes the OpenShell gRPC proto asset", imageTestOptions, async () => {
  const probe = String.raw`
    import assert from "node:assert/strict";
    import { GrpcOpenShellGatewayClient } from "./apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";

    const client = new GrpcOpenShellGatewayClient({
      endpoint: "127.0.0.1:9",
      auth: { mode: "unauthenticated" },
      requestTimeoutMs: ${1000 * imageSmokeTimeoutMultiplier},
    });
    try {
      await client.health(AbortSignal.timeout(${1500 * imageSmokeTimeoutMultiplier}));
      assert.fail("OpenShell probe unexpectedly reached an unavailable test endpoint.");
    } catch (error) {
      assert.equal(error?.code, 14);
      assert.match(String(error?.message), /UNAVAILABLE|ECONNREFUSED|No connection established/);
      process.stdout.write('{"event":"openshell-proto-loaded"}\n');
    } finally {
      client.close();
    }
  `;
  const { stdout, stderr } = await runDocker([
    "run",
    "--rm",
    "--network",
    "none",
    image,
    "--input-type=module",
    "--eval",
    probe,
  ]);
  assert.match(stdout, /"event":"openshell-proto-loaded"/);
  assertNoPackagingFailure(`${stdout}\n${stderr}`);
});

test("production image includes console shell and public assets", imageTestOptions, async () => {
  const { stdout: labels } = await runDocker([
    "image",
    "inspect",
    "--format",
    "{{json .Config.Labels}}",
    image,
  ]);
  const revision = JSON.parse(labels)?.["org.opencontainers.image.revision"] ?? "";
  const probe = String.raw`
    import assert from "node:assert/strict";
    import { readConsoleAsset } from "./apps/controller/src/console-assets.ts";

    const shell = await readConsoleAsset("/console/");
    assert.equal(shell.statusCode, 200);
    assert.match(shell.contentType, /text\/html/);
    assert.match(shell.body.toString("utf8"), /\/console\/console\.mjs/);

    const revision = shell.body.toString("utf8").match(/<meta name="occ-build-revision" content="([^"]*)" \/>/)?.[1];
    assert.ok(revision === "" || /^[a-f0-9]{40}$/.test(revision));
    if (process.env.EXPECTED_OCC_REVISION) {
      assert.equal(revision, process.env.EXPECTED_OCC_REVISION);
    }

    const css = await readConsoleAsset("/console/console.css");
    assert.equal(css.statusCode, 200);
    assert.match(css.contentType, /text\/css/);
    assert.ok(css.body.length > 0);

    const script = await readConsoleAsset("/console/console.mjs");
    assert.equal(script.statusCode, 200);
    assert.match(script.contentType, /javascript/);
    assert.match(script.body.toString("utf8"), /api\/auth\/session/);

    const unknown = await readConsoleAsset("/console/index.ts");
    assert.equal(unknown.statusCode, 404);
    assert.match(unknown.contentType, /text\/html/);
    assert.doesNotMatch(unknown.body.toString("utf8"), /createFastifyApp|OCC_AUTH_SECRET|apiKeyPath/);
    console.log(JSON.stringify({ event: "console-assets-loaded" }));
  `;
  const { stdout, stderr } = await runDocker([
    "run",
    "--rm",
    "--network",
    "none",
    "--env",
    `EXPECTED_OCC_REVISION=${revision}`,
    image,
    "--input-type=module",
    "--eval",
    probe,
  ]);
  assert.match(stdout, /"event":"console-assets-loaded"/);
  assertNoPackagingFailure(`${stdout}\n${stderr}`);
});
