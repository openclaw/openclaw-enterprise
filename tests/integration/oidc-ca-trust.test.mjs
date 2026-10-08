import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { createServer as createTlsServer } from "node:tls";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { syntheticCredentialUrl } from "../fixtures/synthetic-credential-url.mjs";
import { oidcNonce } from "../../apps/controller/src/auth/oidc.ts";
import {
  callbackState,
  createIdTokenSigner,
  loginSecret,
} from "../helpers/human-login-transport.mjs";
import {
  chartTooling,
  parseProductionChart,
  renderProductionChart,
} from "../helpers/production-chart.mjs";

const execute = promisify(execFile);
const tooling = await chartTooling();
const oidcValues = {
  "auth.recoveryUserId": "existing-administrator",
  "auth.oidc.enabled": "true",
  "auth.oidc.issuer": "https://sso.example.test",
  "auth.oidc.authorizationUrl": "https://sso.example.test/authorize",
  "auth.oidc.tokenUrl": "https://sso.example.test/token",
  "auth.oidc.jwksUrl": "https://sso.example.test/jwks",
};
const databaseCaValues = { "database.caSecretName": "database-ca" };
const caValues = {
  ...databaseCaValues,
  "auth.oidc.caSecretName": "idp-ca",
  "auth.oidc.caSecretKey": "roots.pem",
};
const gatewayValues = {
  "gatewayRouting.enabled": "true",
  "gatewayRouting.gatewayClassName": "private-envoy-gateway",
  "gatewayRouting.apiKeySecretName": "occ-gateway-api-key",
};
const externalGateway = { ...gatewayValues, "gatewayRouting.issuerRef.name": "external-issuer" };
const externalGatewayCa = {
  ...externalGateway,
  "gatewayRouting.caSecretName": "gateway-ca",
  "gatewayRouting.caSecretKey": "gateway.pem",
};
const render = async (values) => parseProductionChart((await renderProductionChart(values)).stdout);
const pod = (objects, component) =>
  objects.find(
    (object) =>
      object.kind === "Deployment" && object.metadata.name === `openclaw-enterprise-${component}`,
  ).spec.template.spec;

test(
  "OIDC CA chart wiring adds trust only to the API and preserves Gateway selection",
  tooling,
  async () => {
    for (const gateway of [{}, gatewayValues, externalGateway, externalGatewayCa]) {
      const original = await render({ ...oidcValues, ...gateway, ...databaseCaValues });
      const configured = await render({ ...oidcValues, ...gateway, ...caValues });
      const api = pod(configured, "api");
      const init = api.initContainers.find(({ name }) => name === "assemble-api-ca");
      const container = api.containers[0];
      assert.deepEqual(init.command, ["node"]);
      assert.equal(init.image, container.image);
      assert.equal(api.securityContext.runAsNonRoot, true);
      assert.deepEqual(init.securityContext, container.securityContext);
      assert.equal(init.securityContext.allowPrivilegeEscalation, false);
      assert.equal(init.securityContext.readOnlyRootFilesystem, true);
      assert.deepEqual(init.securityContext.capabilities.drop, ["ALL"]);
      assert.deepEqual(api.volumes.find(({ name }) => name === "oidc-ca").secret, {
        secretName: "idp-ca",
        items: [{ key: "roots.pem", path: "ca.crt" }],
      });
      assert.deepEqual(
        container.env.filter(({ name }) => name === "NODE_EXTRA_CA_CERTS"),
        [{ name: "NODE_EXTRA_CA_CERTS", value: "/etc/openclaw/api-extra-ca/ca.crt" }],
      );
      assert.equal(
        container.volumeMounts.find(({ name }) => name === "api-extra-ca").readOnly,
        true,
      );
      assert.equal(
        container.volumeMounts.some(({ name }) => name === "oidc-ca"),
        false,
      );
      const hasGatewayCa = gateway === gatewayValues || gateway === externalGatewayCa;
      assert.deepEqual(init.args.slice(3), [
        "/etc/openclaw/api-extra-ca/ca.crt",
        "/etc/openclaw/oidc-ca/ca.crt",
        ...(hasGatewayCa ? ["/etc/openclaw/gateway-ca/ca.crt"] : []),
      ]);
      // The new public CA must not reach workers, Jobs, or other rendered workloads.
      assert.deepEqual(pod(configured, "worker"), pod(original, "worker"));
      assert.deepEqual(
        configured.filter((object) => object.metadata?.name !== "openclaw-enterprise-api"),
        original.filter((object) => object.metadata?.name !== "openclaw-enterprise-api"),
      );
      assert.equal(pod(original, "api").initContainers, undefined);
    }
  },
);

test("OIDC CA chart refuses partial, malformed and disabled configuration", tooling, async () => {
  for (const values of [
    { ...caValues, "auth.oidc.enabled": "false", "auth.recoveryUserId": "" },
    { ...caValues, "auth.oidc.caSecretName": "occ-oidc-login" },
    { ...caValues, "database.caSecretName": "" },
    { ...caValues, "database.caSecretName": "idp-ca" },
    { "auth.oidc.caSecretName": "idp-ca" },
    { "auth.oidc.caSecretKey": "roots.pem" },
    ...["true", "42", "Bad_Name", "../ca", "bad..name", "a".repeat(254)].map((value) => ({
      ...caValues,
      "auth.oidc.caSecretName": value,
    })),
    ...["false", "42", "..", "a/b", "a".repeat(254)].map((value) => ({
      ...caValues,
      "auth.oidc.caSecretKey": value,
    })),
  ]) {
    await assert.rejects(renderProductionChart({ ...oidcValues, ...values }), (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /auth\.oidc.*(CA configuration|caSecret)/);
      return true;
    });
  }
  for (const enabled of ["false", "true"]) {
    await assert.rejects(
      renderProductionChart(
        { ...oidcValues, ...caValues },
        { strings: { "auth.oidc.enabled": enabled } },
      ),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(
          error.stderr,
          /auth\.oidc CA configuration requires auth\.oidc\.enabled: true/,
        );
        return true;
      },
    );
  }
});

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "occ-oidc-ca-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function certificates(directory, name, hostname) {
  const file = (suffix) => join(directory, `${name}-${suffix}`);
  const run = (args) => execute("openssl", args, { timeout: 10000 });
  await run([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "2",
    "-subj",
    `/CN=${name}`,
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign",
    "-keyout",
    file("ca.key"),
    "-out",
    file("ca.pem"),
  ]);
  await run([
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-subj",
    `/CN=${hostname}`,
    "-keyout",
    file("leaf.key"),
    "-out",
    file("leaf.csr"),
  ]);
  await writeFile(
    file("ext"),
    `subjectAltName=DNS:${hostname}\nbasicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\n`,
  );
  await run([
    "x509",
    "-req",
    "-in",
    file("leaf.csr"),
    "-CA",
    file("ca.pem"),
    "-CAkey",
    file("ca.key"),
    "-CAcreateserial",
    "-days",
    "2",
    "-extfile",
    file("ext"),
    "-out",
    file("leaf.pem"),
  ]);
  return Object.fromEntries(
    await Promise.all(
      ["ca.pem", "ca.key", "leaf.pem", "leaf.key"].map(async (suffix) => [
        suffix,
        await readFile(file(suffix), "utf8"),
      ]),
    ),
  );
}

// Materialize the rendered Secret items and emptyDir, and translate absolute mount
// paths into disposable local directories. Execute the rendered script unchanged.
async function mountedPod(directory, api, secrets) {
  const volumes = new Map();
  for (const volume of api.volumes) {
    const root = join(directory, volume.name);
    volumes.set(volume.name, root);
    await mkdir(root);
    for (const item of volume.secret?.items ?? []) {
      const value = secrets[`${volume.secret.secretName}/${item.key}`];
      if (value !== undefined) {
        await writeFile(join(root, item.path), value);
      }
    }
  }
  const resolve = (container, path) => {
    const mount = container.volumeMounts.find(({ mountPath }) => path.startsWith(`${mountPath}/`));
    assert.ok(mount, `No rendered mount for ${path}`);
    return join(volumes.get(mount.name), path.slice(mount.mountPath.length + 1));
  };
  const init = api.initContainers.find(({ name }) => name === "assemble-api-ca");
  const args = init.args.map((arg) => (arg.startsWith("/") ? resolve(init, arg) : arg));
  const extraCa = api.containers[0].env.find(({ name }) => name === "NODE_EXTRA_CA_CERTS").value;
  return {
    resolve: (path) => resolve(api.containers[0], path),
    assemble: () => execute(process.execPath, args, { env: {}, timeout: 10000 }),
    output: resolve(api.containers[0], extraCa),
    oidcInput: resolve(init, "/etc/openclaw/oidc-ca/ca.crt"),
    gatewayInput: resolve(init, "/etc/openclaw/gateway-ca/ca.crt"),
  };
}

async function tlsServer(t, certificate, handler) {
  const server = createServer(
    { key: certificate["leaf.key"], cert: certificate["leaf.pem"] },
    handler,
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return server.address().port;
}

test(
  "rendered OIDC CA assembly reaches the callback transport and preserves Gateway and public trust",
  tooling,
  async (t) => {
    const directory = await temporaryDirectory(t);
    const idp = await certificates(directory, "idp", "sso.example.test");
    const gateway = await certificates(directory, "gateway", "gateway.example.test");
    const unrelated = await certificates(directory, "unrelated", "untrusted.example.test");
    const replacement = await certificates(directory, "replacement", "sso.example.test");
    const api = pod(await render({ ...oidcValues, ...caValues, ...externalGatewayCa }), "api");
    const wiring = await mountedPod(directory, api, {
      "idp-ca/roots.pem": idp["ca.pem"],
      "gateway-ca/gateway.pem": gateway["ca.pem"],
    });
    const signer = createIdTokenSigner();
    const token = signer.sign({
      iss: "https://sso.example.test",
      aud: "tls-client",
      sub: "ca-fixture-user",
      nonce: oidcNonce(loginSecret, callbackState),
      iat: Math.floor(Date.now() / 1000) - 5,
      exp: Math.floor(Date.now() / 1000) + 300,
    });
    const requests = [];
    const provider = (request, response) => {
      requests.push([request.method, request.url, request.headers.host]);
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify(
          request.url === "/token"
            ? { access_token: "fixture-access", id_token: token }
            : signer.jwks,
        ),
      );
    };
    const ports = {
      "sso.example.test": await tlsServer(t, idp, provider),
      "gateway.example.test": await tlsServer(t, gateway, (_request, response) =>
        response.end("gateway"),
      ),
      "untrusted.example.test": await tlsServer(t, unrelated, (_request, response) =>
        response.end("unexpected"),
      ),
    };
    ports["wrong-name.example.test"] = ports["gateway.example.test"];
    const replacementPort = await tlsServer(t, replacement, provider);
    const environment = Object.fromEntries(
      api.containers[0].env
        .filter(({ name }) => name.startsWith("OCC_AUTH_OIDC_"))
        .map(({ name, value }) => [
          name,
          value ?? (name.endsWith("CLIENT_ID") ? "tls-client" : "tls-client-secret"),
        ]),
    );
    const consume = async (expected, providerPort = ports["sso.example.test"]) => {
      const { stdout, stderr } = await execute(
        process.execPath,
        [
          "tests/fixtures/oidc-ca-consumer.mjs",
          JSON.stringify({ environment, ports: { ...ports, "sso.example.test": providerPort } }),
        ],
        { env: { NODE_EXTRA_CA_CERTS: wiring.output }, timeout: 15000 },
      );
      assert.equal(stderr, "");
      const result = JSON.parse(stdout);
      assert.equal(result.accepted, expected);
      assert.ok(result.publicRoots > 0);
    };
    await wiring.assemble();
    await consume(true);
    assert.deepEqual(requests, [
      ["POST", "/token", "sso.example.test"],
      ["GET", "/jwks", "sso.example.test"],
    ]);
    // Secret projection changes do not rebuild the init snapshot. Only replacing the
    // Pod reruns assembly and starts a Node process with the new trust bundle.
    await writeFile(wiring.oidcInput, replacement["ca.pem"]);
    await consume(true);
    await consume(false, replacementPort);
    // Operators can overlap old and new public CA certificates during rotation.
    await writeFile(wiring.oidcInput, idp["ca.pem"] + replacement["ca.pem"]);
    await wiring.assemble();
    await consume(true);
    await consume(true, replacementPort);
    await writeFile(wiring.oidcInput, replacement["ca.pem"]);
    await wiring.assemble();
    await consume(true, replacementPort);
    await consume(false);

    for (const [name, content] of [
      ["empty", ""],
      ["whitespace", " \n"],
      ["malformed", "-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----"],
      ["private key", idp["ca.key"]],
      ["mixed key", idp["ca.pem"] + idp["ca.key"]],
      ["trailing junk", idp["ca.pem"] + "junk"],
      ["leaf certificate", idp["leaf.pem"]],
      ["oversized", " ".repeat(1024 * 1024 + 1)],
    ]) {
      await t.test(`init refuses ${name} instead of leaving a stale bundle`, async () => {
        await writeFile(wiring.oidcInput, content);
        await assert.rejects(wiring.assemble(), (error) => error.code === 1);
        await assert.rejects(readFile(wiring.output), { code: "ENOENT" });
      });
    }
    await rm(wiring.oidcInput);
    await assert.rejects(
      wiring.assemble(),
      (error) => error.code === 1 && /ENOENT/.test(error.stderr),
    );
    await writeFile(wiring.oidcInput, idp["ca.pem"]);
    await writeFile(wiring.gatewayInput, "broken gateway root");
    await assert.rejects(wiring.assemble(), (error) => error.code === 1);
    await assert.rejects(readFile(wiring.output), { code: "ENOENT" });
  },
);

test(
  "rendered API guard isolates real PostgreSQL TLS from IdP trust before startup",
  tooling,
  async (t) => {
    const directory = await temporaryDirectory(t);
    const database = await certificates(directory, "database", "localhost");
    const idp = await certificates(directory, "idp", "localhost");
    const api = pod(await render({ ...oidcValues, ...caValues, ...externalGatewayCa }), "api");
    const wiring = await mountedPod(directory, api, {
      "idp-ca/roots.pem": idp["ca.pem"],
      "gateway-ca/gateway.pem": idp["ca.pem"],
      "database-ca/ca.pem": database["ca.pem"],
    });
    await wiring.assemble();
    // Keep the rendered preloader and selected CA argument. Replace only the server
    // entrypoint so its real exported pool can stop at TLS without a database.
    const container = api.containers[0];
    const args = container.args.map((arg) => {
      if (arg === "apps/controller/src/server.mjs") {
        return "tests/fixtures/oidc-ca-postgres-consumer.mjs";
      }
      return arg.startsWith("/") ? wiring.resolve(arg) : arg;
    });
    const reference = container.env.find(({ name }) => name === "OCC_DATABASE_URL").valueFrom
      .secretKeyRef;
    assert.deepEqual(reference, { name: "occ-database", key: "application-url" });
    assert.equal(api.initContainers[0].env, undefined);
    const caPath = wiring.resolve("/etc/openclaw/database-ca/ca.pem");
    let accepted = 0;
    const sockets = new Set();
    const server = createTlsServer(
      { key: database["leaf.key"], cert: database["leaf.pem"] },
      (socket) => {
        accepted++;
        socket.once("data", () => socket.destroy());
      },
    );
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    server.on("tlsClientError", () => {});
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise((resolve) => server.close(resolve));
    });
    const connection = (search, password = "synthetic-secret") =>
      syntheticCredentialUrl({
        protocol: "postgresql",
        username: "synthetic-user",
        password,
        host: "127.0.0.1",
        port: server.address().port,
        pathname: "/synthetic",
        search: `?sslnegotiation=direct&${search}`,
      });
    const selected = `sslmode=verify-full&sslrootcert=${encodeURIComponent(caPath)}`;
    const consume = (url, authMode = "password") =>
      execute(process.execPath, args, {
        env: {
          NODE_EXTRA_CA_CERTS: wiring.output,
          [container.env.find(({ name }) => name === "OCC_DATABASE_URL").name]: url,
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
    const refused = async (url) => {
      await assert.rejects(consume(url), (error) => {
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
    for (const material of [
      "",
      "not a certificate",
      database["leaf.pem"],
      database["ca.pem"] + database["ca.key"],
    ]) {
      await writeFile(caPath, material);
      await refused(connection(selected));
    }
    await rm(caPath);
    await refused(connection(selected));
    const output = await readFile(wiring.output, "utf8");
    assert.equal(output.includes("PRIVATE KEY"), false);
    assert.equal(output.includes("synthetic-secret"), false);
    assert.equal(output.includes(database["ca.pem"].trim()), false);
  },
);
