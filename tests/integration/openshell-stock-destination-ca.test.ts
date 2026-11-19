import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, get } from "node:https";
import test from "node:test";
import { inspect } from "node:util";
import { createTlsMaterial } from "../fixtures/repository-credentials/process.ts";
import { listen } from "../helpers/listen.ts";
import {
  assertStockDestinationCaProjection,
  assertStockDestinationCaReadback,
  stockDestinationCa,
} from "../helpers/openshell-stock-destination-ca.ts";
import {
  stockSupervisorConfig,
  stockSupervisorManifest,
} from "../helpers/openshell-stock-supervisor-image.ts";

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

  const certificateDer = Buffer.from(
    tls.ca.toString().replace(/-----[^-]+-----|\s/gu, ""),
    "base64",
  );
  const asPem = (der: Buffer, width: number) => {
    const body = der
      .toString("base64")
      .match(new RegExp(`.{1,${width}}`, "gu"))
      ?.join("\r\n");
    return `-----BEGIN CERTIFICATE-----\r\n${body}\r\n-----END CERTIFICATE-----\r\n`;
  };
  const normalized = asPem(certificateDer, 48);
  assert.equal(
    stockDestinationCa("fixture-platform", "git-fixture-ca", normalized).configMap.data["ca.crt"],
    normalized,
  );
  // An empty OpenSSL auxiliary trust record follows the certificate DER inside one PEM block.
  const withAuxiliaryTrust = asPem(Buffer.concat([certificateDer, Buffer.from([0x30, 0x00])]), 64);
  assert.throws(
    () => stockDestinationCa("fixture-platform", "git-fixture-ca", withAuxiliaryTrust),
    { message: "destination trust must contain exactly one certificate and no private material" },
  );

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

test("stock CA readback and projection refuse substituted or extra material without retaining it", () => {
  const marker = "invented-private-readback-marker";
  assertStockDestinationCaProjection([{ key: "ca.crt", path: "ca.crt" }]);
  assertStockDestinationCaReadback({ data: { "ca.crt": "certificate" } }, "certificate");
  for (const items of [
    undefined,
    [{ key: "other", path: "ca.crt" }],
    [{ key: "ca.crt", path: "other" }],
  ]) {
    assert.throws(
      () => assertStockDestinationCaProjection(items),
      /unexpected key-to-path mapping/u,
    );
  }
  for (const map of [
    { data: { "ca.crt": "certificate", extra: marker } },
    { data: { "ca.crt": `certificate${marker}` } },
    { data: { "ca.crt": "certificate" }, binaryData: { other: marker } },
    { data: { "ca.crt": "certificate" }, binaryData: {} },
  ]) {
    assert.throws(
      () => assertStockDestinationCaReadback(map, "certificate"),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(
          error.message,
          "destination CA ConfigMap readback does not match the certificate-only input",
        );
        assert.equal(
          inspect(error, { showHidden: true, maxStringLength: null }).includes(marker),
          false,
        );
        return true;
      },
    );
  }
});

test("stock Supervisor identity binds the pinned index, platform manifest and config", async () => {
  const sha = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
  const config = sha("config");
  const mediaType = "application/vnd.oci.image.manifest.v1+json";
  const manifest = JSON.stringify({ mediaType, config: { digest: config } });
  const descriptor = {
    mediaType,
    digest: sha(manifest),
    platform: { os: "linux", architecture: "amd64" },
  };
  const index = JSON.stringify({
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: [descriptor],
  });
  const selected = stockSupervisorManifest(index, sha(index), "linux/amd64");
  const inspected = {
    Id: descriptor.digest,
    Descriptor: selected,
    Os: "linux",
    Architecture: "amd64",
  };
  assert.equal(await stockSupervisorConfig(selected, manifest, inspected, "linux/amd64"), config);
  assert.equal(
    await stockSupervisorConfig(
      selected,
      manifest,
      { Id: config, Os: "linux", Architecture: "amd64" },
      "linux/amd64",
    ),
    config,
  );
  assert.throws(
    () => stockSupervisorManifest(index + "forged", sha(index), "linux/amd64"),
    /does not match/u,
  );
  assert.throws(
    () => stockSupervisorManifest(index, sha(index), "linux/arm64"),
    /unique platform/u,
  );
  await assert.rejects(
    stockSupervisorConfig(selected, manifest + "forged", inspected, "linux/amd64"),
    /does not match/u,
  );
  await assert.rejects(
    stockSupervisorConfig(
      selected,
      manifest,
      { Id: sha("other"), Os: "linux", Architecture: "amd64" },
      "linux/amd64",
    ),
    /pinned config/u,
  );
});
