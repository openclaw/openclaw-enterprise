import assert from "node:assert/strict";
import { get } from "node:https";
import { createRequire } from "node:module";
import { getCACertificates, rootCertificates } from "node:tls";
import { oidcLoginConfiguration, oidcProviderId } from "../../apps/controller/src/auth/oidc.ts";
import { createLoginFixture } from "../helpers/human-login-transport.mjs";

const require = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
const { Agent, buildConnector, setGlobalDispatcher } = require("undici");
const { environment, ports } = JSON.parse(process.argv[2]);
const connect = buildConnector({});
// Redirect TCP destinations only. Production URLs, TLS SNI/hostname checks, native
// fetch, token exchange and JWKS validation all remain real in this fresh process.
const dispatcher = new Agent({
  connect(options, callback) {
    const port = ports[options.hostname];
    if (port === undefined) {
      callback(new Error("Unexpected TLS destination"));
      return;
    }
    connect({ ...options, hostname: "127.0.0.1", servername: options.hostname, port }, callback);
  },
});
setGlobalDispatcher(dispatcher);
try {
  const oidc = oidcLoginConfiguration(environment);
  const fixture = createLoginFixture({ provider: "oidc", providers: { oidc } });
  await fixture.callback();
  // The existing State fixture stops at account lookup; this proves the production
  // callback verified the provider identity, not database admission or a session.
  const accepted = fixture.subjects.length === 1;
  if (accepted) {
    assert.deepEqual(fixture.subjects, [[oidcProviderId(oidc), "ca-fixture-user"]]);
  } else {
    assert.deepEqual(fixture.denials, [["PROVIDER_UNAVAILABLE", "oidc"]]);
    assert.equal(fixture.operationalLogs()[0].cause, "tls");
  }
  const gateway = await new Promise((resolve, reject) => {
    get(
      `https://127.0.0.1:${ports["gateway.example.test"]}/gateway`,
      { servername: "gateway.example.test" },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      },
    ).on("error", reject);
  });
  assert.equal(gateway, 200);
  const failures = {};
  for (const host of ["untrusted.example.test", "wrong-name.example.test"]) {
    try {
      await fetch(`https://${host}/probe`, { signal: AbortSignal.timeout(5000) });
      assert.fail(`${host} unexpectedly trusted`);
    } catch (error) {
      assert.equal(error.message, "fetch failed");
      failures[host] = error.cause.code;
    }
  }
  assert.equal(failures["wrong-name.example.test"], "ERR_TLS_CERT_ALTNAME_INVALID");
  assert.match(
    failures["untrusted.example.test"],
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
