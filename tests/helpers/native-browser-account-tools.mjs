import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { GrpcOpenShellGatewayClient } from "../../apps/controller/src/drivers/sandbox/openshell-gateway-client.ts";
import { managedMcpNetwork } from "../../apps/controller/src/drivers/sandbox/openshell-managed-mcp-policy.ts";

const execute = promisify(execFile);
const run = async (program, args) =>
  (await execute(program, args, { timeout: 180_000, maxBuffer: 4_000_000 })).stdout.trim();

/** Run inside the pinned OpenShell stock with-docker-gateway.sh fixture. Its detached
 * sandbox has independent DNS; bind both it and the gateway to the same isolated recipient. */
export async function verifyNativeBrowserAccountTools({
  install,
  issuer,
  tokenOrigin,
  workspace,
  accounts,
  selectedTools,
  workerConfig,
  releaseFiles,
  withGateway,
  prepare,
  release,
}) {
  const {
    OPENSHELL_BIN: cli,
    OPENSHELL_GATEWAY: gateway,
    OPENSHELL_E2E_DOCKER_NETWORK_NAME: network,
    OPENSHELL_E2E_SANDBOX_NAMESPACE: sandboxNamespace,
    OCC_TEST_BROWSER_ACCOUNT_WORKER: archive,
    OCC_TEST_BROWSER_ACCOUNT_NODE_IMAGE: image,
    OCC_TEST_BROWSER_ACCOUNT_TLS_DIR: tlsDirectory,
    OCC_TEST_BROWSER_ACCOUNT_DNS: dns,
    XDG_CONFIG_HOME: config,
  } = process.env;
  assert(
    cli &&
      gateway &&
      network &&
      sandboxNamespace &&
      archive &&
      image &&
      config &&
      tlsDirectory &&
      dns,
    "Run the browser account qualification inside the stock disposable OpenShell Docker gateway.",
  );
  const gatewayDir = join(config, "openshell", "gateways", gateway);
  const { gateway_endpoint: endpoint } = JSON.parse(
    await readFile(join(gatewayDir, "metadata.json"), "utf8"),
  );
  assert.equal(new URL(endpoint).hostname, "127.0.0.1");
  const directory = await mkdtemp(join(tmpdir(), "oce-browser-account-tools-"));
  const name = "accounts-" + randomUUID().slice(0, 8);
  assert.match(dns, /^127\.93\.\d{1,3}\.\d{1,3}$/u);
  const origin = name + "-recipient";
  const resolver = name + "-dns";
  const shell = (...args) => run(cli, ["--workspace", workspace, ...args]);
  const { host, port, path } = install.endpoint;

  const auth = {
    mode: "mutualTls",
    certificatePath: join(gatewayDir, "mtls/tls.crt"),
    privateKeyPath: join(gatewayDir, "mtls/tls.key"),
  };
  let client;
  try {
    const certs = new URL(new URL(issuer).pathname + "/protocol/openid-connect/certs", tokenOrigin);
    const response = await fetch(certs, { signal: AbortSignal.timeout(10_000) });
    assert.equal(response.status, 200);
    const { keys } = await response.json();
    const configPath = join(directory, "issuer.json");
    await writeFile(
      configPath,
      JSON.stringify({
        issuer,
        keys,
        expectedSubjects: accounts.map(({ expectedSubject }) => expectedSubject),
        path,
        port,
      }),
    );
    const recipient = fileURLToPath(
      new URL("../fixtures/keycloak-account-mcp.mjs", import.meta.url),
    );
    await run("docker", [
      "run",
      "-d",
      "--pull",
      "never",
      "--name",
      origin,
      "--network",
      network,
      "--network-alias",
      host,
      "--mount",
      `type=bind,source=${recipient},target=/recipient.mjs,readonly`,
      "--mount",
      `type=bind,source=${configPath},target=/issuer.json,readonly`,
      "--mount",
      `type=bind,source=${join(tlsDirectory, "tls.crt")},target=/tls.crt,readonly`,
      "--mount",
      `type=bind,source=${join(tlsDirectory, "tls.key")},target=/tls.key,readonly`,
      image,
      "node",
      "/recipient.mjs",
      "/issuer.json",
    ]);
    const [container] = JSON.parse(await run("docker", ["inspect", origin]));
    const ip = container.NetworkSettings.Networks[network].IPAddress;
    assert.match(ip, /^(?:10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.)/u);
    // The stock supervisor has a host network namespace. Its trusted DNS must
    // resolve the reviewed service name only to this private recipient.
    const corefile = join(directory, "Corefile");
    await writeFile(
      corefile,
      `.:53 {
  hosts {
    ${ip} ${host}
  }
}
`,
    );
    await chmod(corefile, 0o644); // CoreDNS reads this public host mapping as a non-root user.
    const dnsImage =
      "rancher/mirrored-coredns-coredns@sha256:900f9c109f7a33545d3c811516e8376df9019147b750f5ce3e254468769176ea";
    await run("docker", [
      "run",
      "-d",
      "--pull",
      "never",
      "--name",
      resolver,
      "--network",
      network,
      "-p",
      dns + ":53:53/udp",
      "--mount",
      `type=bind,source=${corefile},target=/Corefile,readonly`,
      dnsImage,
      "-conf",
      "/Corefile",
    ]);
    // The real sender normally talks to a public provider. Pin the test recipient's
    // private address on all overlapping native endpoints, including its two profiles.
    const pin = (endpoint) => ({ ...endpoint, allowed_ips: [ip + "/32"] });
    class FixtureSenderGateway extends GrpcOpenShellGatewayClient {
      importProviderProfile(ws, profile, signal) {
        return super.importProviderProfile(
          ws,
          { ...profile, endpoints: profile.endpoints.map(pin) },
          signal,
        );
      }
    }
    client = new FixtureSenderGateway({
      endpoint,
      rootCertificatePath: join(gatewayDir, "mtls/ca.crt"),
      auth,
    });
    await client.createWorkspace(workspace, {}, AbortSignal.timeout(15_000));
    return await withGateway(client, async () => {
      const sources = [];
      for (const account of accounts) {
        const source = await prepare(account.handle);
        sources.push(source);
        const observed = await client.getProvider(
          workspace,
          account.provider,
          AbortSignal.timeout(10_000),
        );
        assert.equal(observed?.name, account.provider);
        const label = observed.labels["openclaw.dev/credential-source-id"];
        assert.match(label, /^acct-[A-Za-z0-9_-]+-id$/u);
        assert.equal(
          Buffer.from(label.slice(5, -3), "base64url").toString("hex"),
          account.profileId.slice("account-".length),
        );
      }
      const managed = managedMcpNetwork(install, selectedTools);
      const policy = {
        version: 1,
        landlock: { compatibility: "best_effort" },
        process: { run_as_user: "1000", run_as_group: "1000" },
        filesystem_policy: {
          include_workdir: true,
          read_only: ["/usr", "/lib", "/lib64", "/proc", "/etc", "/dev/urandom"],
          read_write: ["/sandbox", "/tmp", "/dev/null"],
        },
        network_policies: { [managed.name]: { ...managed, endpoints: managed.endpoints.map(pin) } },
      };
      // Send the production gRPC policy. The CLI's YAML tool matcher is a different representation.
      const resource = { name, workspace };
      await client.createSandbox(
        {
          ...resource,
          requestId: randomUUID(),
          labels: {},
          annotations: {},
          serviceExposures: [],
          spec: {
            log_level: "info",
            template: { image },
            policy,
            providers: accounts.map(({ provider }) => provider),
          },
        },
        AbortSignal.timeout(15_000),
      );
      // Docker runs the supervisor on the host network with a read-only rootfs.
      // Supply only its own resolver file, just as Kubernetes supplies Pod DNS.
      const configureDns = async () => {
        let supervisor;
        for (let attempt = 0; attempt < 200 && !supervisor; attempt++) {
          const names = await run("docker", [
            "ps",
            "--format",
            "{{.Names}}",
            "--filter",
            "label=openshell.ai/sandbox-name=" + name,
            "--filter",
            "label=openshell.ai/sandbox-namespace=" + sandboxNamespace,
          ]);
          supervisor = names.split("\n").find((item) => item.endsWith("-supervisor"));
          if (!supervisor) {
            await delay(100);
          }
        }
        assert(supervisor, "Stock gateway must create this sandbox's supervisor.");
        const [owned] = JSON.parse(await run("docker", ["inspect", supervisor]));
        assert(owned.Name.startsWith("/openshell-" + workspace + "--" + name + "-"));
        assert.match(owned.Id, /^[a-f0-9]{64}$/u);
        assert.equal(
          owned.ResolvConfPath,
          join("/var/lib/docker/containers", owned.Id, "resolv.conf"),
        );
        await run("docker", [
          "run",
          "--rm",
          "--pull",
          "never",
          "--network",
          "none",
          "--mount",
          `type=bind,source=${owned.ResolvConfPath},target=/owned-resolver`,
          image,
          "node",
          "-e",
          'require("node:fs").writeFileSync("/owned-resolver","nameserver "+process.argv[1]+"\\n")',
          dns,
        ]);
      };
      await configureDns();
      for (let attempt = 0; attempt < 90; attempt++) {
        const sandbox = await client.getSandbox(resource, AbortSignal.timeout(5_000));
        if (sandbox?.phase === "SANDBOX_PHASE_READY" || sandbox?.phase === 2) {
          break;
        }
        assert.notEqual(sandbox?.phase, "SANDBOX_PHASE_ERROR");
        if (attempt === 89) {
          throw new Error("Stock OpenShell did not admit the sender policy.");
        }
        await delay(500);
      }
      for (const source of sources) {
        await release(source);
      }
      // Feed the released package and admitted selection through the worker bootstrap.
      const input = join(directory, "accounts.json");
      await writeFile(
        input,
        JSON.stringify({
          releaseFiles,
          plugins: workerConfig,
          bindings: accounts,
        }),
      );
      for (const [local, remote] of [
        [archive, "worker.tgz"],
        [input, "accounts.json"],
      ]) {
        await shell("sandbox", "upload", "--no-git-ignore", name, local, "/sandbox/" + remote);
      }
      const result = JSON.parse(
        await shell(
          "sandbox",
          "exec",
          "--name",
          name,
          "--",
          "sh",
          "-c",
          "cd /sandbox && tar xzf worker.tgz && exec /usr/local/bin/node worker/call-accounts.mjs /sandbox/accounts.json",
        ),
      );
      assert.deepEqual(
        result.verifiedAccounts.map(({ handle, subject }) => [handle, subject]),
        accounts.map(({ handle, expectedSubject }) => [handle, expectedSubject]),
      );
      const receipts = (await run("docker", ["logs", origin]))
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.deepEqual(
        receipts,
        accounts.map(({ expectedSubject }) => ({ tool: "whoami", subject: expectedSubject })),
      );
      return result;
    });
  } catch (error) {
    const log = await run("docker", ["logs", origin]).catch(() => "");
    const refusals = log.split("\n").filter((line) => /^\{"rejection":"[a-z-]+"\}$/u.test(line));
    if (refusals.length) {
      throw new Error("MCP recipient refused authentication: " + refusals.join(", "), {
        cause: error,
      });
    }
    throw error;
  } finally {
    await shell("sandbox", "delete", name).catch(() => {});
    client?.close();
    await run("docker", ["rm", "-f", origin, resolver]).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}
