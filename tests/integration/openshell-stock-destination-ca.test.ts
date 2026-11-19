import assert from "node:assert/strict";
import { createServer, get } from "node:https";
import test from "node:test";
import { inspect } from "node:util";
import { createTlsMaterial } from "../fixtures/repository-credentials/process.ts";
import { listen } from "../helpers/listen.ts";
import { stockDestinationCa } from "../helpers/openshell-stock-destination-ca.ts";

function request(url: string, ca?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const outgoing = get(url, { ca }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    outgoing.once("error", reject);
  });
}

test("OpenShell stock destination CA fixture trusts only its certificate input", async (t) => {
  const tls = await createTlsMaterial(t);
  const fixture = stockDestinationCa("fixture-platform", "git-fixture-ca", tls.ca.toString());
  assert.equal(fixture.configMap.immutable, true);
  assert.deepEqual(Object.keys(fixture.configMap.data), ["ca.crt"]);
  assert.equal(fixture.network.additionalCaConfigMapName, fixture.configMap.metadata.name);

  // A real TLS connection distinguishes a usable trust input from an arbitrary PEM string.
  const server = createServer({ key: tls.key, cert: tls.cert }, (_request, response) =>
    response.end(),
  );
  const port = await listen(t, server);
  const url = `https://127.0.0.1:${port}/`;
  await assert.rejects(request(url), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" });
  assert.equal(await request(url, fixture.configMap.data["ca.crt"]), 200);

  const rejected = `${tls.ca.toString()}-----BEGIN PRIVATE KEY-----\nsynthetic-rejected-material\n-----END PRIVATE KEY-----\n`;
  assert.throws(
    () => stockDestinationCa("fixture-platform", "git-fixture-ca", rejected),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /exactly one certificate and no private material/u);
      for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(error))) {
        assert.equal(
          inspect(descriptor.value, { showHidden: true, maxStringLength: null }).includes(
            "synthetic-rejected-material",
          ),
          false,
        );
      }
      return true;
    },
  );
  assert.throws(
    () => stockDestinationCa("fixture-platform", "git-fixture-ca", tls.ca.toString().repeat(2)),
    { message: /exactly one certificate and no private material/u },
  );
});
