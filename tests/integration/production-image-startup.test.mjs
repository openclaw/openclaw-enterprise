import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { imageSmokeTimeoutMultiplier } from "../helpers/image-smoke-timeout.ts";
import {
  assertNoPackagingFailure,
  registerProductionImageControllerStartupCases,
  runDocker,
} from "./production-image-controller-startup-cases.ts";

const image = process.env.OCC_TEST_PRODUCTION_IMAGE;
const imageTestOptions =
  image === undefined
    ? {
        skip: "Set OCC_TEST_PRODUCTION_IMAGE to a locally built production controller image tag.",
      }
    : {};

test(
  "development bootstrap mount copies support a different reader UID",
  imageTestOptions,
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "occ-bootstrap-mounts-"));
    const project = `occ-mounts-${randomBytes(6).toString("hex")}`;
    const file = join(directory, "compose.json");
    const compose = ["compose", "--project-name", project, "-f", file];
    t.after(async () => {
      await runDocker([...compose, "down", "--remove-orphans"]);
      await rm(directory, { recursive: true, force: true });
    });
    const reader = process.getuid() === 1001 ? 1002 : 1001;
    const password = "synthetic-admin-password";
    const key = `occ_${randomBytes(32).toString("base64url")}`;
    for (const [name, value] of Object.entries({
      "admin-password": password,
      "admin-service-key": key,
    })) {
      await writeFile(join(directory, name), value, { mode: 0o600 });
      await writeFile(join(directory, `mount-${name}`), value, { mode: 0o600 });
    }
    const probe = `import {bootstrapCredentials} from '/app/scripts/lib/bootstrap-credentials.ts'; await bootstrapCredentials({OCC_BOOTSTRAP_ADMIN_PASSWORD_INPUT_FILE:'/run/secrets/password', OCC_BOOTSTRAP_SERVICE_KEY_INPUT_FILE:'/run/secrets/key'}); console.log('credentials-readable');`;
    await writeFile(
      file,
      JSON.stringify({
        services: {
          bootstrap: {
            image,
            user: `${reader}:${reader}`,
            network_mode: "none",
            read_only: true,
            cap_drop: ["ALL"],
            security_opt: ["no-new-privileges:true"],
            entrypoint: ["node"],
            command: ["--input-type=module", "-e", probe],
            secrets: [
              { source: "password", target: "password" },
              { source: "key", target: "key" },
            ],
          },
        },
        secrets: {
          password: { file: join(directory, "mount-admin-password") },
          key: { file: join(directory, "mount-admin-service-key") },
        },
      }),
    );
    // Prove the real Secret mount is unreadable before launcher ownership preparation.
    await assert.rejects(runDocker([...compose, "run", "--rm", "--no-deps", "bootstrap"]), {
      code: 1,
      stderr: /must be readable regular UTF-8 text/,
    });
    const cli = join(directory, "occ");
    execFileSync("go", ["build", "-o", cli, "./cmd/occ"], { stdio: "pipe" });
    execFileSync(
      cli,
      ["dev", "prepare-bootstrap-mounts", "--directory", directory, "--", ...compose.slice(1)],
      { env: { ...process.env, OCC_DEVELOPMENT_CONTAINER_ENGINE: "docker" }, stdio: "pipe" },
    );
    assert.match(
      (await runDocker([...compose, "run", "--rm", "--no-deps", "bootstrap"])).stdout,
      /credentials-readable/,
    );
    for (const name of ["admin-password", "admin-service-key"]) {
      const input = await open(join(directory, name), "r");
      try {
        const metadata = await input.stat();
        assert.equal(metadata.uid, process.getuid());
        assert.equal(metadata.mode & 0o777, 0o600);
        assert.equal(
          (await input.readFile("utf8")) === (name === "admin-password" ? password : key),
          true,
        );
      } finally {
        await input.close();
      }
    }
  },
);

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
    backend: [
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
      {
        id: "openshell",
        type: "openshell",
        configuration: {
          endpoint: "127.0.0.1:9",
          auth: { mode: "unauthenticated" },
          insecureTransport: "network-policy",
        },
        drivers: { sandbox: "sandbox-openshell", credential_gateway: "openshell-credentials" },
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
      credential_gateway: {
        id: "openshell-credentials",
        configuration: { binaries: ["/app/bin/model-client"] },
      },
      sandbox: {
        id: "sandbox-openshell",
        configuration: {
          gateway: {
            workspaceMode: "operator",
          },
          kubernetes: {
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
                endpoints: [{ host: "1.1.1.1", ports: [53], protocol: "tcp" }],
                binaries: [{ path: "/app/bin/dns-client" }],
              },
            ],
          },
        },
      },
    },
  };
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
  // The nonroot container must read these synthetic files under any host umask.
  await chmod(join(fixture, "admin-key"), 0o644);
  await chmod(join(fixture, "installation.json"), 0o644);
  return fixture;
}

registerProductionImageControllerStartupCases({ image, imageTestOptions, productionFixture });

test(
  "production image runs the chart's pre-upgrade Installation check",
  imageTestOptions,
  async (t) => {
    assert.ok(image !== undefined);
    // The initialization hook runs this script with the chart's security context before
    // Helm replaces the API, so a refused Installation leaves the old Pods serving.
    const script = await readFile(
      new URL(
        "../../deploy/helm/openclaw-enterprise/files/check-installation.mjs",
        import.meta.url,
      ),
      "utf8",
    );
    const fixture = await productionFixture(t);
    const check = [
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--user",
      "1000:1000",
      "--mount",
      `type=bind,src=${fixture},dst=/tmp/oce-production-image,readonly`,
      "-e",
      "NODE_ENV=production",
      "-e",
      "OCC_CONFIG_PATH=/tmp/oce-production-image/installation.json",
      image,
      "--input-type=module",
      "-e",
      script,
    ];
    const passed = await runDocker(check, { timeout: 60_000 * imageSmokeTimeoutMultiplier });
    assert.equal(passed.stdout, "installation-startup-ready\n");
    assertNoPackagingFailure(passed.stderr);

    const path = join(fixture, "installation.json");
    const installation = JSON.parse(await readFile(path, "utf8"));
    const invalidDriver = structuredClone(installation);
    invalidDriver.drivers.compute.configuration.runtime.gatewayStorageClassName = "Bad_Class";
    await writeFile(path, JSON.stringify(invalidDriver), { mode: 0o644 });
    await assert.rejects(
      runDocker(check, { timeout: 60_000 * imageSmokeTimeoutMultiplier }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /installation-check:.*DRIVER_CONFIGURATION_INVALID/);
        const details = JSON.parse(error.stderr.trim().split("DRIVER_CONFIGURATION_INVALID: ")[1]);
        assert.deepEqual(details, [
          {
            path: "/runtime/gatewayStorageClassName",
            code: "INVALID_FORMAT",
            message:
              "SQLite-compatible gateway storage class must be a DNS-safe Kubernetes resource name.",
          },
        ]);
        assert.doesNotMatch(error.stderr, /Bad_Class/);
        return true;
      },
    );
    installation.presets = { files: ["presets/missing.json"] };
    await writeFile(path, `${JSON.stringify(installation, undefined, 2)}\n`, {
      encoding: "utf8",
      mode: 0o644,
    });
    await assert.rejects(
      runDocker(check, { timeout: 60_000 * imageSmokeTimeoutMultiplier }),
      (error) => {
        assert.equal(error.code, 1);
        assert.equal(
          error.stderr,
          "installation-check: API and worker startup would refuse the Installation (PRESET_FILE_INVALID): presets.files: Preset file /tmp/oce-production-image/presets/missing.json is unavailable.\n",
        );
        return true;
      },
    );
  },
);

test("production image includes the OpenShell gRPC proto asset", imageTestOptions, async () => {
  assert.ok(image !== undefined);
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
      assert.equal(error?.grpcStatus, 14);
      assert.match(String(error?.message), /OpenShell Health failed with gRPC status 14/);
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
  assert.ok(image !== undefined);
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
    import { execFileSync } from "node:child_process";
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

    // Parse the shipped bytes as JavaScript. Browser tests load the module and its imports.
    const dom = await readConsoleAsset("/console/dom.mjs");
    assert.equal(dom.statusCode, 200);
    assert.match(dom.contentType, /javascript/);
    assert.ok(dom.body.length > 0);
    execFileSync(process.execPath, ["--no-strip-types", "--check", "--input-type=module"], {
      input: dom.body,
    });

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
