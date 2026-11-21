import assert from "node:assert/strict";
import { createHash, X509Certificate } from "node:crypto";
import { createServer, get } from "node:https";
import test from "node:test";
import { inspect } from "node:util";
import { createTlsMaterial } from "../fixtures/repository-credentials/process.ts";
import { listen } from "../helpers/listen.ts";
import {
  assertStockDestinationCaProjection,
  assertStockDestinationCaReadback,
  stockDestinationCa,
  stockManagedDestinationCa,
} from "../helpers/openshell-stock-destination-ca.ts";
import {
  assertStockSupervisorImport,
  stockSupervisorConfig,
  stockSupervisorManifest,
} from "../helpers/openshell-stock-supervisor-image.ts";

function request(url: string, ca?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const outgoing = get(url, { ca, agent: false }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    outgoing.once("error", reject);
  });
}

function pem(der: Buffer): string {
  const body = der
    .toString("base64")
    .match(/.{1,48}/gu)
    ?.join("\r\n");
  return `-----BEGIN CERTIFICATE-----\r\n${body}\r\n-----END CERTIFICATE-----\r\n`;
}

test("OpenShell destination CA fixture accepts a single CA and refuses a substituted ConfigMap", async (t) => {
  const tls = await createTlsMaterial(t);
  const certificate = new X509Certificate(tls.ca);
  const sourcePem = pem(certificate.raw);
  const input = stockDestinationCa("fixture-platform", "git-fixture-ca", sourcePem);
  assert.equal(input.configMap.data["ca.crt"], sourcePem);
  assert.equal(input.normalizedPem, tls.ca.toString());

  // A parser can accept an auxiliary trust record appended inside one PEM block.
  const withAuxiliaryTrust = pem(Buffer.concat([certificate.raw, Buffer.from([0x30, 0x00])]));
  const certificateOnly = /exactly one certificate and no private material/u;
  assert.throws(
    () => stockDestinationCa("fixture-platform", "git-fixture-ca", withAuxiliaryTrust),
    {
      message: certificateOnly,
    },
  );
  const rejected = `${sourcePem}-----BEGIN PRIVATE KEY-----\nsynthetic-rejected-material\n-----END PRIVATE KEY-----\n`;
  assert.throws(
    () => stockDestinationCa("fixture-platform", "git-fixture-ca", rejected),
    (error: unknown) =>
      error instanceof Error &&
      certificateOnly.test(error.message) &&
      !inspect(error, { showHidden: true }).includes("synthetic-rejected-material"),
  );

  // Trust only the fixture certificate on a real TLS connection.
  const server = createServer({ key: tls.key, cert: tls.cert }, (_request, response) =>
    response.end(),
  );
  const url = `https://127.0.0.1:${await listen(t, server)}/`;
  await assert.rejects(request(url), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" });
  assert.equal(await request(url, input.normalizedPem), 200);

  const expectedSource = { ...input.configMap.metadata, pem: sourcePem };
  assertStockDestinationCaReadback(input.configMap, expectedSource);
  assert.throws(
    () =>
      assertStockDestinationCaReadback(
        { ...input.configMap, metadata: { ...input.configMap.metadata, name: "decoy" } },
        expectedSource,
      ),
    /ConfigMap identity does not match/u,
  );
  assert.throws(
    () =>
      assertStockDestinationCaReadback(
        { ...input.configMap, binaryData: { unrelated: "YQ==" } },
        expectedSource,
      ),
    /does not match the certificate-only input/u,
  );

  const managed = stockManagedDestinationCa(
    "fixture-sandbox",
    "fixture-gateway",
    input.normalizedPem,
  );
  const metadata = {
    namespace: managed.namespace,
    name: managed.name,
    labels: {
      "openshell.ai/managed-by": "openshell",
      "openshell.ai/gateway-id": managed.owner.gatewayId,
    },
    annotations: { "openshell.ai/additional-ca-generation": managed.owner.generation },
  };
  const generation = { ...input.configMap, metadata, data: { "ca.crt": input.normalizedPem } };
  assertStockDestinationCaReadback(generation, managed);
  // A Sandbox owner would let garbage collection delete trust needed by its replacement.
  const sandbox = {
    apiVersion: "agents.x-k8s.io/v1beta1",
    kind: "Sandbox",
    name: "original",
    uid: "original-uid",
  };
  for (const ownerReferences of [[sandbox], []]) {
    assert.throws(
      () =>
        assertStockDestinationCaReadback(
          { ...generation, metadata: { ...metadata, ownerReferences } },
          managed,
        ),
      /managed destination CA ConfigMap must omit ownerReferences/u,
    );
  }

  const items = [{ key: "ca.crt", path: "ca.crt" }];
  assertStockDestinationCaProjection({ name: managed.name, items }, managed.name);
  assert.throws(
    () => assertStockDestinationCaProjection({ name: "decoy", items }, managed.name),
    /must project the managed destination CA ConfigMap/u,
  );
});

test("OpenShell stock Supervisor fixture refuses a substituted imported image", async () => {
  const sha256 = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
  const config = sha256("stock config");
  const mediaType = "application/vnd.oci.image.manifest.v1+json";
  const manifest = JSON.stringify({ mediaType, config: { digest: config } });
  const descriptor = {
    mediaType,
    digest: sha256(manifest),
    platform: { os: "linux", architecture: "amd64" },
  };
  const index = JSON.stringify({
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: [descriptor],
  });
  const selected = stockSupervisorManifest(index, sha256(index), "linux/amd64");
  const inspected = {
    Id: descriptor.digest,
    Descriptor: selected,
    Os: "linux",
    Architecture: "amd64",
  };
  // buildx may append a display newline to the exact bytes named by the descriptor.
  const expectedConfig = await stockSupervisorConfig(
    selected,
    `${manifest}\n`,
    inspected,
    "linux/amd64",
  );
  assert.equal(
    await stockSupervisorConfig(
      selected,
      manifest,
      { Id: config, Os: "linux", Architecture: "amd64" },
      "linux/amd64",
    ),
    expectedConfig,
  );

  // Local import can rewrite its manifest; the image config must stay stock.
  const imported = JSON.stringify({ schemaVersion: 2, config: { digest: config } });
  assertStockSupervisorImport(imported, sha256(imported), expectedConfig);
  const substitute = JSON.stringify({
    schemaVersion: 2,
    config: { digest: sha256("foreign config") },
  });
  assert.throws(
    () => assertStockSupervisorImport(substitute, sha256(substitute), expectedConfig),
    /must use the pinned stock config/u,
  );
  assert.throws(
    () => assertStockSupervisorImport(substitute, sha256(imported), expectedConfig),
    /does not match its digest/u,
  );
});
