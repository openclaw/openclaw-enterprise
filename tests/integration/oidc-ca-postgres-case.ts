import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { createServer as createTlsServer } from "node:tls";
import { syntheticCredentialUrl } from "../fixtures/synthetic-credential-url.mjs";
import { createInstallationDriverConfiguration } from "../helpers/installation-driver-configuration.mjs";
import { listen } from "../helpers/listen.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";
import {
  assembler,
  caValues,
  certificates,
  envValue,
  execFailure,
  execute,
  externalGatewayCa,
  firstContainer,
  mountedPod,
  oidcValues,
  pod,
  preflightPod,
  render,
  secretVolume,
} from "./oidc-ca-chart-fixture.ts";

export async function verifyDatabaseStartupTrust(t: TestContext) {
  const directory = await temporaryDirectory(t, "occ-oidc-ca-");
  const database = await certificates(directory, "database", "localhost");
  const idp = await certificates(directory, "idp", "localhost");
  const objects = await render({
    ...oidcValues,
    ...caValues,
    ...externalGatewayCa,
    "database.caMountPath": "/etc/openclaw/database-ca/",
  });
  const api = pod(objects, "api");
  const wiring = await mountedPod(directory, api, {
    "idp-ca/roots.pem": idp["ca.pem"],
    "gateway-ca/gateway.pem": idp["ca.pem"],
    "database-ca/ca.pem": database["ca.pem"],
  });
  await wiring.assemble();
  // Keep the rendered preloader and selected CA argument. Replace only the server
  // entrypoint so its real exported pool can stop at TLS without a database.
  const container = firstContainer(api);
  const args = container.args.map((arg) => {
    if (arg === "apps/controller/src/server.mjs") {
      return "tests/fixtures/oidc-ca-postgres-consumer.mjs";
    }
    return arg.startsWith("/") ? wiring.resolve(arg) : arg;
  });
  const databaseUrl = container.env.find(({ name }) => name === "OCC_DATABASE_URL");
  assert.ok(databaseUrl);
  const reference = databaseUrl.valueFrom?.secretKeyRef;
  assert.deepEqual(reference, { name: "occ-database", key: "application-url" });
  // The init container carries only public names, never a credential reference.
  assert.deepEqual(
    assembler(api).env.map(({ name, valueFrom }) => [name, valueFrom]),
    [["OCC_CA_SOURCES", undefined]],
  );
  const caPath = wiring.resolve("/etc/openclaw/database-ca/ca.pem");
  let accepted = 0;
  const server = createTlsServer(
    { key: database["leaf.key"], cert: database["leaf.pem"] },
    (socket) => {
      accepted++;
      socket.once("data", () => socket.destroy());
    },
  );
  server.on("tlsClientError", () => {});
  // Listen and connect through the same "localhost" lookup: the certificate names
  // DNS:localhost, and the guard refuses IP literal database hosts.
  const port = await listen(t, server, "localhost");
  const connection = (search: string, password = "synthetic-secret", host = "localhost") =>
    syntheticCredentialUrl({
      protocol: "postgresql",
      username: "synthetic-user",
      password,
      host,
      port,
      pathname: "/synthetic",
      search: `?sslnegotiation=direct&${search}`,
    });
  const selected = `sslmode=verify-full&sslrootcert=${encodeURIComponent(caPath)}`;
  const consume = (url: string, authMode = "password") =>
    execute(process.execPath, args, {
      env: {
        NODE_EXTRA_CA_CERTS: wiring.output,
        [databaseUrl.name]: url,
        OCC_DATABASE_CA_SOURCE: envValue(container, "OCC_DATABASE_CA_SOURCE"),
        OCC_DATABASE_AUTH: authMode,
        // Construction only; the server never requests authentication or a token.
        AZURE_CLIENT_ID: "synthetic-client",
        AZURE_TENANT_ID: "synthetic-tenant",
        AZURE_FEDERATED_TOKEN_FILE: join(directory, "unused-token"),
      },
      timeout: 10000,
    });
  for (const authMode of ["password", "azure-workload-identity"]) {
    const password = authMode === "password" ? "synthetic-secret" : "";
    server.setSecureContext({ key: database["leaf.key"], cert: database["leaf.pem"] });
    const before = accepted;
    const trusted = await consume(connection(selected, password), authMode);
    assert.match(trusted.stdout, /^entrypoint\n/);
    assert.equal(trusted.stderr, "");
    assert.equal(accepted, before + 1, "the selected database CA must authenticate TLS");
    // Same hostname, but signed only by the CA in NODE_EXTRA_CA_CERTS.
    server.setSecureContext({ key: idp["leaf.key"], cert: idp["leaf.pem"] });
    const rejected = await consume(connection(selected, password), authMode);
    assert.match(
      rejected.stdout,
      /UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT_LOCALLY|SELF_SIGNED_CERT_IN_CHAIN/,
    );
    assert.equal(accepted, before + 1, "IdP-only trust must not authenticate database TLS");
  }
  // Exercise both actual upgrade commands with this rendered CA profile. Use
  // the supported SSH Compute selection so configuration loading needs no
  // cluster; this test covers database trust, not Compute transport.
  const baseline = createInstallationDriverConfiguration();
  const compute = {
    id: "compute-ssh",
    configuration: {
      ssh: { identityFile: "/unused/id", knownHostsFile: "/unused/known_hosts" },
      hosts: { stable: { address: "192.0.2.1", user: "root" } },
      runtime: {
        nodePath: "/usr/bin/node",
        openclawPath: "/opt/openclaw/index.js",
        user: "openclaw",
        root: "/var/lib/openclaw",
      },
      network: { gatewayPortRange: { start: 18800, end: 18899 } },
    },
  };
  const configuration = {
    ...baseline,
    drivers: { ...baseline.drivers, compute },
  };
  const configurationPath = join(directory, "installation.json");
  const expectedPath = join(directory, "expected.json");
  const renderedPath = join(directory, "rendered.jsonl");
  await writeFile(configurationPath, JSON.stringify(configuration));
  await writeFile(expectedPath, JSON.stringify({ id: "ins_test", name: "Example" }));
  await writeFile(renderedPath, objects.map((object) => JSON.stringify(object)).join("\n"));
  const installationSecret = secretVolume(api, "installation-startup").secretName;
  const generate = async (action: "job" | "identity-job") => {
    const { stdout } = await execute(process.execPath, [
      "scripts/upgrade-startup-preflight.ts",
      action,
      renderedPath,
      "api",
      "preflight",
      "openclaw-system",
      "oce",
      installationSecret,
      "candidate-installation",
      container.image,
      "30",
      expectedPath,
      "none",
    ]);
    return preflightPod(stdout);
  };
  for (const action of ["job", "identity-job"] as const) {
    const generated = await generate(action);
    assert.deepEqual(generated.initContainers, api.initContainers);
    assert.deepEqual(
      generated.volumes.find(({ name }) => name === "oidc-ca"),
      api.volumes.find(({ name }) => name === "oidc-ca"),
    );
    const command = firstContainer(generated);
    const argv = command.args.map((arg) =>
      arg.startsWith("/etc/") ? wiring.resolve(arg) : arg.replaceAll("/app/", process.cwd() + "/"),
    );
    const environment = Object.fromEntries(
      command.env
        .filter(({ value }) => value !== undefined)
        .map(({ name, value }) => [name, value]),
    );
    const run = (url: string) =>
      execute(process.execPath, argv, {
        env: {
          ...environment,
          OCC_CONFIG_PATH: configurationPath,
          NODE_EXTRA_CA_CERTS: wiring.output,
          OCC_DATABASE_URL: url,
        },
        timeout: 20000,
      });
    const before = accepted;
    await assert.rejects(run(connection("sslmode=disable")), (failure: unknown) => {
      const error = execFailure(failure);
      assert.match(error.stderr, /^OIDC CA trust requires OCC_DATABASE_URL/);
      assert.doesNotMatch(error.stderr, /synthetic-secret|synthetic-user|postgresql:\/\//);
      return true;
    });
    assert.equal(accepted, before, "invalid trust must be refused before connecting");
    server.setSecureContext({ key: database["leaf.key"], cert: database["leaf.pem"] });
    // The TLS fixture deliberately closes before authentication/SQL. The trust
    // prerequisites pass, then the generated identity check fails safely.
    await assert.rejects(run(connection(selected)), (failure: unknown) => {
      const error = execFailure(failure);
      assert.match(
        error.stderr,
        /^Candidate application database Installation identity could not be verified\.\n$/,
      );
      return true;
    });
    assert.equal(accepted, before + 1, "the generated command accepts the scoped database CA");
  }
  // A chart-like payload is not permission to execute arbitrary preload code.
  const originalPreload = container.args[1];
  assert.ok(originalPreload, "Expected the rendered database CA preloader");
  container.args[1] = "data:text/javascript,throw new Error('untrusted')";
  await writeFile(renderedPath, objects.map((object) => JSON.stringify(object)).join("\n"));
  await assert.rejects(generate("identity-job"), /connection prerequisites are unsupported/);
  container.args[1] = originalPreload;
  const refused = async (url: string) => {
    await assert.rejects(consume(url), (failure: unknown) => {
      const error = execFailure(failure);
      assert.equal(error.code, 1);
      assert.equal(error.stdout, "", "the API entrypoint must not execute");
      assert.match(error.stderr, /^OIDC CA trust requires OCC_DATABASE_URL/);
      for (const secret of [url, "synthetic-secret", "synthetic-user"]) {
        assert.equal(
          error.stderr.includes(secret),
          false,
          "configuration errors must not expose credentials",
        );
      }
      return true;
    });
  };
  for (const query of [
    "sslmode=verify-full",
    selected.replace("verify-full", "disable"),
    selected.replace("verify-full", "no-verify"),
    selected.replace("verify-full", "require") + "&uselibpqcompat=true",
    `${selected}&sslmode=no-verify`,
    `${selected}&sslrootcert=`,
    `${selected}&connectionString=${encodeURIComponent(connection("sslmode=verify-full"))}`,
    `sslmode=verify-full&sslrootcert=${encodeURIComponent(wiring.output)}`,
  ]) {
    await refused(connection(query));
  }
  await refused("malformed synthetic-user synthetic-secret %");
  // pg sends no TLS servername for an IP host, so plain pg checks the certificate against
  // "localhost"; the shared pool checks the IP instead. The guard still refuses IP hosts,
  // including a host parameter override and a Unix socket, before any handshake.
  let ipHandshakes = 0;
  const ipServer = createTlsServer(
    { key: database["leaf.key"], cert: database["leaf.pem"] },
    (socket) => {
      ipHandshakes++;
      socket.once("data", () => socket.destroy());
    },
  );
  ipServer.on("tlsClientError", () => {});
  const ipPort = await listen(t, ipServer);
  const ipConnection = (search: string) =>
    syntheticCredentialUrl({
      protocol: "postgresql",
      username: "synthetic-user",
      password: "synthetic-secret",
      host: "127.0.0.1",
      port: ipPort,
      pathname: "/synthetic",
      search: `?sslnegotiation=direct&${search}`,
    });
  for (const url of [
    ipConnection(selected),
    connection(selected, undefined, "[::1]"),
    connection(`${selected}&host=127.0.0.1`),
    connection(`${selected}&host=${encodeURIComponent("/var/run/postgresql")}`),
  ]) {
    await refused(url);
  }
  assert.equal(ipHandshakes, 0, "an IP database host must not reach a TLS handshake");
  // Without the guard the shared pool still refuses that substitution: it checks the
  // certificate against the IP, which the DNS:localhost certificate does not carry.
  const unguarded = await execute(
    process.execPath,
    ["tests/fixtures/oidc-ca-postgres-consumer.mjs"],
    { env: { OCC_DATABASE_URL: ipConnection(selected) }, timeout: 10000 },
  );
  assert.match(unguarded.stdout, /^entrypoint\n\{"code":"ERR_TLS_CERT_ALTNAME_INVALID"\}\n$/);
  assert.equal(ipHandshakes, 0, "the unguarded client must not trust an IP host as localhost");
  // CA material problems name the operator's database CA Secret and key on one line.
  const databaseSource = 'database.caSecretName Secret "database-ca" key "ca.pem"';
  const invalidMaterial: [material: string | null, problem: string][] = [
    ["", "the value is empty"],
    ["not a certificate", "the value must hold only PEM CA certificates"],
    [
      database["leaf.pem"],
      `certificate 1 of 1 (${new X509Certificate(database["leaf.pem"]).subject.replace(/\n/g, ", ")}) is not a CA certificate`,
    ],
    [database["ca.pem"] + database["ca.key"], "the value must hold only PEM CA certificates"],
    [null, "not found in the Pod"],
  ];
  for (const [material, problem] of invalidMaterial) {
    if (material === null) {
      await rm(caPath);
    } else {
      await writeFile(caPath, material);
    }
    await assert.rejects(consume(connection(selected)), (failure: unknown) => {
      const error = execFailure(failure);
      assert.equal(error.code, 1);
      assert.equal(error.stdout, "", "the API entrypoint must not execute");
      assert.ok(
        error.stderr.startsWith(`check-api-database-ca: ${databaseSource}: ${problem}`),
        error.stderr,
      );
      assert.match(error.stderr, /^[^\n]+\n$/);
      for (const secret of ["synthetic-secret", "synthetic-user", "/etc/openclaw", directory]) {
        assert.equal(error.stderr.includes(secret), false);
      }
      return true;
    });
  }
  const output = await readFile(wiring.output, "utf8");
  assert.equal(output.includes("PRIVATE KEY"), false);
  assert.equal(output.includes("synthetic-secret"), false);
  assert.equal(output.includes(database["ca.pem"].trim()), false);
}
