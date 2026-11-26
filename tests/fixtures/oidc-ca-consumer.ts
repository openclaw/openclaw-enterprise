import assert from "node:assert/strict";
import { get } from "node:https";
import { getCACertificates, rootCertificates } from "node:tls";
import {
  oidcLoginConfiguration,
  oidcProviderId,
  type ResolvedOidcLoginConfiguration,
} from "../../apps/controller/src/auth/oidc.ts";
import { resolveOidcEnrollmentPolicy } from "../../apps/controller/src/auth/oidc-enrollment.ts";
import {
  Agent,
  buildConnector,
  setGlobalDispatcher,
} from "../../apps/controller/node_modules/undici/index.js";

const gatewayHost = "gateway.example.test";
const untrustedHost = "untrusted.example.test";
const wrongNameHost = "wrong-name.example.test";
const hosts = ["sso.example.test", gatewayHost, untrustedHost, wrongNameHost];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readInput(argument: string | undefined) {
  let input: unknown;
  try {
    input = argument === undefined ? undefined : JSON.parse(argument);
  } catch {
    throw new Error("OIDC CA fixture input must be valid JSON");
  }
  if (!isRecord(input) || !isRecord(input.environment) || !isRecord(input.ports)) {
    throw new Error("OIDC CA fixture requires environment and port mappings");
  }
  const environment = Object.fromEntries(
    Object.entries(input.environment).map(([name, value]): [string, string] => {
      if (typeof value !== "string") {
        throw new Error("OIDC CA fixture environment values must be strings");
      }
      return [name, value];
    }),
  );
  const suppliedPorts = input.ports;
  if (Object.keys(suppliedPorts).length !== hosts.length) {
    throw new Error("OIDC CA fixture requires exactly four TLS destination ports");
  }
  const ports = new Map<string, number>(
    hosts.map((host) => {
      const port = suppliedPorts[host];
      if (
        !Object.hasOwn(suppliedPorts, host) ||
        typeof port !== "number" ||
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65535
      ) {
        throw new Error("OIDC CA fixture requires valid TLS destination ports");
      }
      return [host, port];
    }),
  );
  return { environment, ports };
}

const { environment, ports } = readInput(process.argv[2]);
let oidc: ResolvedOidcLoginConfiguration | undefined;
try {
  const configuration = oidcLoginConfiguration(environment);
  if (configuration !== undefined) {
    const { enrollment, ...provider } = configuration;
    oidc = {
      ...provider,
      enrollment:
        enrollment === undefined ? undefined : resolveOidcEnrollmentPolicy(enrollment, []),
    };
  }
} catch {
  // The production parser can throw a JSON syntax error containing enrollment input.
  throw new Error("OIDC CA fixture configuration is invalid");
}
assert.ok(oidc, "OIDC CA fixture configuration is required");
const gatewayPort = ports.get(gatewayHost);
assert.ok(gatewayPort, "OIDC CA fixture gateway port is required");

const connect = buildConnector({});
// Redirect TCP destinations only. Production URLs, TLS SNI/hostname checks, native
// fetch, token exchange and JWKS validation all remain real in this fresh process.
const dispatcher = new Agent({
  connect(options, callback) {
    const port = ports.get(options.hostname);
    if (port === undefined) {
      callback(new Error("Unexpected TLS destination"), null);
      return;
    }
    connect(
      { ...options, hostname: "127.0.0.1", servername: options.hostname, port: String(port) },
      callback,
    );
  },
});
setGlobalDispatcher(dispatcher);
try {
  const { createLoginFixture } = await import("../helpers/human-login-transport.ts");
  const fixture = createLoginFixture({ provider: "oidc", providers: { oidc } });
  await fixture.callback();
  // The State fixture stops at account lookup. Recording the exact subject proves
  // that the production callback verified the provider's signed identity.
  const accepted = fixture.subjects.length === 1;
  if (accepted) {
    assert.deepEqual(fixture.subjects, [[oidcProviderId(oidc), "ca-fixture-user"]]);
  } else {
    assert.deepEqual(fixture.denials, [["PROVIDER_UNAVAILABLE", "oidc"]]);
    assert.equal(fixture.operationalLogs()[0]?.cause, "tls");
  }
  const gateway = await new Promise<number | undefined>((resolve, reject) => {
    get(`https://127.0.0.1:${gatewayPort}/gateway`, { servername: gatewayHost }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    }).on("error", reject);
  });
  assert.equal(gateway, 200);
  const failures: Record<string, string> = {};
  for (const host of [untrustedHost, wrongNameHost]) {
    try {
      await fetch(`https://${host}/probe`, { signal: AbortSignal.timeout(5000) });
    } catch (failure) {
      assert.ok(failure instanceof Error);
      assert.equal(failure.message, "fetch failed");
      assert.ok(isRecord(failure.cause) && typeof failure.cause.code === "string");
      failures[host] = failure.cause.code;
      continue;
    }
    assert.fail(`${host} unexpectedly trusted`);
  }
  const untrustedFailure = failures[untrustedHost];
  assert.equal(failures[wrongNameHost], "ERR_TLS_CERT_ALTNAME_INVALID");
  assert.ok(untrustedFailure);
  assert.match(
    untrustedFailure,
    /UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT_LOCALLY|SELF_SIGNED_CERT_IN_CHAIN/,
  );
  const defaults = new Set(getCACertificates("default"));
  assert.ok(rootCertificates.length > 0);
  assert.ok(rootCertificates.every((certificate) => defaults.has(certificate)));
  console.log(
    JSON.stringify({ accepted, gateway, publicRoots: rootCertificates.length, failures }),
  );
} finally {
  await dispatcher.close();
}
