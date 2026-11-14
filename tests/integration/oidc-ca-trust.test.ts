import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type { RequestListener } from "node:http";
import { createServer } from "node:https";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import Type from "typebox";
import { Check } from "typebox/value";
import { oidcNonce } from "../../apps/controller/src/auth/oidc.ts";
import { readHarnessNodeCa } from "../../apps/controller/src/composition/installation-config.ts";
import {
  callbackState,
  createIdTokenSigner,
  loginSecret,
} from "../helpers/human-login-transport.ts";
import { listen } from "../helpers/listen.ts";
import { renderProductionChart } from "../helpers/production-chart.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";
import {
  assembler,
  caValues,
  certificates,
  databaseCaValues,
  execFailure,
  execute,
  externalGateway,
  externalGatewayCa,
  firstContainer,
  gatewayValues,
  mountedPod,
  oidcValues,
  pod,
  render,
  secretVolume,
  tooling,
  type Container,
} from "./oidc-ca-chart-fixture.ts";
import { verifyDatabaseStartupTrust } from "./oidc-ca-postgres-case.ts";

const callbackObservation = Type.Object({
  accepted: Type.Boolean(),
  publicRoots: Type.Number(),
});

test(
  "OIDC CA chart wiring adds trust only to the API and preserves Gateway selection",
  tooling,
  async () => {
    for (const gateway of [{}, gatewayValues, externalGateway, externalGatewayCa]) {
      const original = await render({ ...oidcValues, ...gateway, ...databaseCaValues });
      const configured = await render({ ...oidcValues, ...gateway, ...caValues });
      const api = pod(configured, "api");
      const init = assembler(api);
      const container = firstContainer(api);
      assert.deepEqual(init.command, ["node"]);
      assert.equal(init.image, container.image);
      assert.equal(api.securityContext.runAsNonRoot, true);
      assert.deepEqual(init.securityContext, container.securityContext);
      assert.equal(init.securityContext.allowPrivilegeEscalation, false);
      assert.equal(init.securityContext.readOnlyRootFilesystem, true);
      assert.deepEqual(init.securityContext.capabilities.drop, ["ALL"]);
      assert.deepEqual(secretVolume(api, "oidc-ca"), {
        secretName: "idp-ca",
        items: [{ key: "roots.pem", path: "ca.crt" }],
      });
      assert.deepEqual(
        container.env.filter(({ name }) => name === "NODE_EXTRA_CA_CERTS"),
        [{ name: "NODE_EXTRA_CA_CERTS", value: "/etc/openclaw/api-extra-ca/ca.crt" }],
      );
      assert.equal(
        container.volumeMounts.find(({ name }) => name === "api-extra-ca")?.readOnly,
        true,
      );
      assert.equal(
        container.volumeMounts.some(({ name }) => name === "oidc-ca"),
        false,
      );
      const hasGatewayCa = gateway === gatewayValues || gateway === externalGatewayCa;
      // Harness node enrollment reads the Gateway-only bundle, never the combined one.
      assert.deepEqual(
        container.env.filter(({ name }) => name === "OCC_GATEWAY_CA_PATH"),
        [
          {
            name: "OCC_GATEWAY_CA_PATH",
            value: hasGatewayCa ? "/etc/openclaw/gateway-ca/ca.crt" : "",
          },
        ],
      );
      assert.equal(
        firstContainer(pod(original, "api")).env.some(({ name }) => name === "OCC_GATEWAY_CA_PATH"),
        false,
      );
      // Init errors name the operator's Secret and key instead of the fixed mount paths.
      assert.deepEqual(init.env, [
        {
          name: "OCC_CA_SOURCES",
          value: JSON.stringify({
            ...(hasGatewayCa && {
              "/etc/openclaw/gateway-ca/ca.crt":
                gateway === externalGatewayCa
                  ? 'gatewayRouting.caSecretName Secret "gateway-ca" key "gateway.pem"'
                  : `chart-managed Gateway root Secret "${
                      secretVolume(api, "gateway-ca").secretName
                    }" key "tls.crt"`,
            }),
            "/etc/openclaw/oidc-ca/ca.crt":
              'auth.oidc.caSecretName Secret "idp-ca" key "roots.pem"',
          }),
        },
      ]);
      assert.deepEqual(
        container.env.filter(({ name }) => name === "OCC_DATABASE_CA_SOURCE"),
        [
          {
            name: "OCC_DATABASE_CA_SOURCE",
            value: 'database.caSecretName Secret "database-ca" key "ca.pem"',
          },
        ],
      );
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
    // A public CA Secret must not double as a credential Secret another component mounts.
    { ...caValues, "auth.oidc.caSecretName": "occ-database" },
    { ...caValues, "auth.oidc.caSecretName": "occ-auth" },
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
    { ...caValues, "auth.oidc.caSecretKey": "..roots.pem" },
  ]) {
    await assert.rejects(
      renderProductionChart({ ...oidcValues, ...values }),
      (failure: unknown) => {
        const error = execFailure(failure);
        assert.equal(error.code, 1);
        assert.match(error.stderr, /auth\.oidc.*(CA configuration|caSecret)/);
        return true;
      },
    );
  }
  for (const enabled of ["false", "true"]) {
    await assert.rejects(
      renderProductionChart(
        { ...oidcValues, ...caValues },
        { strings: { "auth.oidc.enabled": enabled } },
      ),
      (failure: unknown) => {
        const error = execFailure(failure);
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

test("OIDC CA reserves the assembled API CA mount from database.caMountPath", tooling, async () => {
  const values = {
    ...oidcValues,
    ...caValues,
    "database.caMountPath": "/etc/openclaw/api-extra-ca",
  };
  await assert.rejects(renderProductionChart(values), (failure: unknown) => {
    const error = execFailure(failure);
    assert.equal(error.code, 1);
    assert.match(error.stderr, /database\.caMountPath must be distinct from other active mounts/);
    return true;
  });
  // Without the OIDC CA, the database may use the mount path.
  const withoutOidcCa = {
    ...oidcValues,
    ...databaseCaValues,
    "database.caMountPath": values["database.caMountPath"],
  };
  const api = pod(await render(withoutOidcCa), "api");
  assert.equal(
    firstContainer(api).volumeMounts.filter(
      ({ mountPath }) => mountPath === "/etc/openclaw/api-extra-ca",
    ).length,
    1,
  );
});

test("OIDC CA may share a public trust bundle Secret with the Gateway CA", tooling, async () => {
  const shared = { ...externalGatewayCa, "gatewayRouting.caSecretName": "site-ca" };
  const api = pod(
    await render({ ...oidcValues, ...shared, ...caValues, "auth.oidc.caSecretName": "site-ca" }),
    "api",
  );
  assert.deepEqual(
    api.volumes
      .filter(({ name }) => ["oidc-ca", "gateway-ca"].includes(name))
      .map(({ secret }) => secret),
    [
      { secretName: "site-ca", items: [{ key: "roots.pem", path: "ca.crt" }] },
      { secretName: "site-ca", items: [{ key: "gateway.pem", path: "ca.crt" }] },
    ],
  );
});

async function tlsServer(
  t: TestContext,
  certificate: Awaited<ReturnType<typeof certificates>>,
  handler: RequestListener,
) {
  const server = createServer(
    { key: certificate["leaf.key"], cert: certificate["leaf.pem"] },
    handler,
  );
  return listen(t, server);
}

test(
  "rendered Harness node CA carries the Gateway root and never the IdP root",
  tooling,
  async (t) => {
    const directory = await temporaryDirectory(t, "occ-oidc-ca-");
    const idp = await certificates(directory, "idp", "sso.example.test");
    const gateway = await certificates(directory, "gateway", "gateway.example.test");
    const gatewayRoot = new X509Certificate(gateway["ca.pem"]).toString();
    const idpRoot = new X509Certificate(idp["ca.pem"]).toString();
    const nodeEnvironment = (container: Container, resolve: (path: string) => string) =>
      Object.fromEntries(
        container.env
          .filter(({ name }) => ["NODE_EXTRA_CA_CERTS", "OCC_GATEWAY_CA_PATH"].includes(name))
          .map(({ name, value }) => {
            assert.ok(value !== undefined, `Expected a rendered path for ${name}`);
            return [name, value === "" ? "" : resolve(value)];
          }),
      );
    const secrets = {
      "idp-ca/roots.pem": idp["ca.pem"],
      "gateway-ca/gateway.pem": gateway["ca.pem"],
    };

    const configured = pod(
      await render({ ...oidcValues, ...caValues, ...externalGatewayCa }),
      "api",
    );
    await mkdir(join(directory, "configured"));
    const wiring = await mountedPod(join(directory, "configured"), configured, secrets);
    await wiring.assemble();
    const combined = await readFile(wiring.output, "utf8");
    assert.ok(combined.includes(idpRoot.trim()), "the API bundle must carry the IdP root");
    const environment = nodeEnvironment(firstContainer(configured), wiring.resolve);
    assert.equal(await readHarnessNodeCa(environment), gatewayRoot);
    // Load-bearing: the combined API bundle alone would hand the IdP root to Harness Pods.
    const apiOnlyBundle = await readHarnessNodeCa({
      NODE_EXTRA_CA_CERTS: environment.NODE_EXTRA_CA_CERTS,
    });
    assert.ok(apiOnlyBundle?.includes(idpRoot.trim()));

    // OIDC CA without a private Gateway CA: Harness Pods get no extra CA.
    for (const gatewayOnly of [{}, externalGateway]) {
      const idpOnly = pod(await render({ ...oidcValues, ...caValues, ...gatewayOnly }), "api");
      const idpBundle = join(directory, "idp-only.pem");
      await writeFile(idpBundle, idp["ca.pem"]);
      const idpOnlyEnvironment = nodeEnvironment(firstContainer(idpOnly), () => idpBundle);
      assert.deepEqual(idpOnlyEnvironment, {
        NODE_EXTRA_CA_CERTS: idpBundle,
        OCC_GATEWAY_CA_PATH: "",
      });
      assert.equal(await readHarnessNodeCa(idpOnlyEnvironment), undefined);
    }

    // Without the opt-in the API's NODE_EXTRA_CA_CERTS stays the Gateway bundle.
    const original = pod(
      await render({ ...oidcValues, ...databaseCaValues, ...externalGatewayCa }),
      "api",
    );
    const gatewayCaPath = join(directory, "original-gateway.pem");
    await writeFile(gatewayCaPath, gateway["ca.pem"]);
    assert.deepEqual(
      nodeEnvironment(firstContainer(original), () => gatewayCaPath),
      {
        NODE_EXTRA_CA_CERTS: gatewayCaPath,
      },
    );
    assert.equal(
      await readHarnessNodeCa(nodeEnvironment(firstContainer(original), () => gatewayCaPath)),
      gatewayRoot,
    );
  },
);

test(
  "rendered OIDC CA assembly reaches the callback transport and preserves Gateway and public trust",
  tooling,
  async (t) => {
    const directory = await temporaryDirectory(t, "occ-oidc-ca-");
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
    const requests: [
      method: string | undefined,
      url: string | undefined,
      host: string | undefined,
    ][] = [];
    const provider: RequestListener = (request, response) => {
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
    const providerPort = await tlsServer(t, idp, provider);
    const gatewayPort = await tlsServer(t, gateway, (_request, response) =>
      response.end("gateway"),
    );
    const ports = {
      "sso.example.test": providerPort,
      "gateway.example.test": gatewayPort,
      "untrusted.example.test": await tlsServer(t, unrelated, (_request, response) =>
        response.end("unexpected"),
      ),
      "wrong-name.example.test": gatewayPort,
    };
    const replacementPort = await tlsServer(t, replacement, provider);
    const environment = Object.fromEntries(
      firstContainer(api)
        .env.filter(({ name }) => name.startsWith("OCC_AUTH_OIDC_"))
        .map(({ name, value }) => [
          name,
          value ?? (name.endsWith("CLIENT_ID") ? "tls-client" : "tls-client-secret"),
        ]),
    );
    const consume = async (expected: boolean, ssoPort = providerPort) => {
      const { stdout, stderr } = await execute(
        process.execPath,
        [
          "tests/fixtures/oidc-ca-consumer.mjs",
          JSON.stringify({ environment, ports: { ...ports, "sso.example.test": ssoPort } }),
        ],
        { env: { NODE_EXTRA_CA_CERTS: wiring.output }, timeout: 15000 },
      );
      assert.equal(stderr, "");
      const result: unknown = JSON.parse(stdout);
      assert.ok(
        Check(callbackObservation, result),
        "Expected callback acceptance and a public root count from the TLS consumer",
      );
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

    const idpSource = 'auth.oidc.caSecretName Secret "idp-ca" key "roots.pem"';
    // One line that names the operator's Secret and key, with no stack or mount path.
    const refusedWith = async (pattern: RegExp) => {
      await assert.rejects(wiring.assemble(), (failure: unknown) => {
        const error = execFailure(failure);
        assert.equal(error.code, 1);
        assert.match(error.stderr, /^assemble-api-ca: [^\n]+\n$/);
        assert.match(error.stderr, pattern);
        assert.equal(error.stderr.includes("/etc/openclaw"), false);
        assert.equal(error.stderr.includes(directory), false);
        assert.doesNotMatch(error.stderr, /\n\s+at |Error:|node:/);
        return true;
      });
      await assert.rejects(readFile(wiring.output), { code: "ENOENT" });
    };
    const leafSubject = new X509Certificate(idp["leaf.pem"]).subject.replace(/\n/g, ", ");
    // A subject value with a space stays whole: one comma between fields, none inside a value.
    assert.match(leafSubject, /^O=Example Corp, CN=/);
    const invalidBundles: [name: string, content: string | Buffer, problem: string][] = [
      ["empty", "", "the value is empty"],
      ["whitespace", " \n", "the value is empty"],
      [
        "malformed",
        "-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----",
        "certificate 1 of 1 has invalid base64",
      ],
      [
        "unparsable",
        "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----",
        "certificate 1 of 1 is not a valid X.509 certificate",
      ],
      ["DER", new X509Certificate(idp["ca.pem"]).raw, "the value is not PEM"],
      ["private key", idp["ca.key"], "the value contains a private key"],
      ["mixed key", idp["ca.pem"] + idp["ca.key"], "the value contains a private key"],
      ["trailing junk", idp["ca.pem"] + "junk", "the value has text outside its PEM"],
      [
        "leaf certificate",
        idp["ca.pem"] + idp["leaf.pem"],
        `certificate 2 of 2 (${leafSubject}) is not a CA certificate`,
      ],
      ["oversized", " ".repeat(1024 * 1024 + 1), "the value is larger than 1 MiB"],
    ];
    for (const [name, content, problem] of invalidBundles) {
      await t.test(`init refuses ${name} instead of leaving a stale bundle`, async () => {
        await writeFile(wiring.oidcInput, content);
        await refusedWith(
          new RegExp(`^assemble-api-ca: ${RegExp.escape(`${idpSource}: ${problem}`)}`),
        );
      });
    }
    await rm(wiring.oidcInput);
    await refusedWith(
      new RegExp(`^assemble-api-ca: ${RegExp.escape(idpSource)}: not found in the Pod`),
    );
    await writeFile(wiring.oidcInput, idp["ca.pem"]);
    await writeFile(wiring.gatewayInput, "broken gateway root");
    await refusedWith(
      /^assemble-api-ca: gatewayRouting\.caSecretName Secret "gateway-ca" key "gateway\.pem": the value is not PEM/,
    );
  },
);

test(
  "rendered API guard isolates real PostgreSQL TLS from IdP trust before startup",
  tooling,
  verifyDatabaseStartupTrust,
);
