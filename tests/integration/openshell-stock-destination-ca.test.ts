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
  assert.throws(
    () => stockDestinationCa("fixture-platform", "git-fixture-ca", sourcePem.repeat(2)),
    { message: certificateOnly },
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
  const marker = "synthetic-ca-readback-marker";
  const binaryMarker = Buffer.from(marker).toString("base64");
  const readbackRefusal = "destination CA ConfigMap does not match the certificate-only input";
  const redactedReadbackRefusal = (unexpectedData: string) => (error: unknown) => {
    assert.ok(
      error instanceof Error && error.message === readbackRefusal,
      "expected the certificate-only readback refusal",
    );
    const diagnostic = inspect(error, { showHidden: true, depth: null, maxStringLength: null });
    assert.ok(
      !diagnostic.includes(unexpectedData),
      "ConfigMap readback refusal must omit returned data",
    );
    return true;
  };
  assert.throws(
    () =>
      assertStockDestinationCaReadback(
        { ...input.configMap, binaryData: { unrelated: binaryMarker } },
        expectedSource,
      ),
    redactedReadbackRefusal(binaryMarker),
    "nonempty binaryData",
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

  // A valid generation identity cannot authorize changed or additional data.
  for (const [description, readback] of Object.entries({
    "changed certificate bytes": { ...generation, data: { "ca.crt": managed.pem + marker } },
    "extra data key": { ...generation, data: { ...generation.data, extra: marker } },
    "empty binaryData": { ...generation, binaryData: {} },
  })) {
    assert.throws(
      () => assertStockDestinationCaReadback(readback, managed),
      redactedReadbackRefusal(marker),
      description,
    );
  }

  const items = [{ key: "ca.crt", path: "ca.crt" }];
  assertStockDestinationCaProjection({ name: managed.name, items }, managed.name);
  assert.throws(
    () => assertStockDestinationCaProjection({ name: "decoy", items }, managed.name),
    /must project the managed destination CA ConfigMap/u,
  );
  for (const [description, projection] of Object.entries({
    "missing projection items": { name: managed.name },
    "wrong projection key": { name: managed.name, items: [{ key: "other", path: "ca.crt" }] },
    "wrong projection path": { name: managed.name, items: [{ key: "ca.crt", path: "other" }] },
  })) {
    assert.throws(
      () => assertStockDestinationCaProjection(projection, managed.name),
      { message: "Supervisor CA volume must project only ca.crt to ca.crt" },
      description,
    );
  }
});

test("OpenShell stock Supervisor fixture refuses a substituted imported image", async (t) => {
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
  const indexDigest = sha256(index);
  const selected = stockSupervisorManifest(index, indexDigest, "linux/amd64");
  // Equivalent JSON still changes the bytes named by the upstream digests.
  const digestMismatch = { message: "stock image metadata does not match its digest" };
  assert.throws(
    () => stockSupervisorManifest(` ${index}`, indexDigest, "linux/amd64"),
    digestMismatch,
  );
  assert.throws(() => stockSupervisorManifest(index, indexDigest, "linux/arm64"), {
    message: "stock Supervisor index has no unique platform manifest",
  });
  const inspected = {
    Id: descriptor.digest,
    Descriptor: selected,
    Os: "linux",
    Architecture: "amd64",
  };
  const inspectedConfig = { Id: config, Os: "linux", Architecture: "amd64" };
  const inspectLocal = t.mock.fn(async () => inspectedConfig);
  await assert.rejects(
    stockSupervisorConfig(selected, ` ${manifest}`, inspectLocal, "linux/amd64"),
    digestMismatch,
  );
  assert.equal(
    inspectLocal.mock.callCount(),
    0,
    "unverified metadata must stop before local inspection",
  );

  // buildx may append a display newline to the exact bytes named by the descriptor.
  const calls: string[][] = [];
  const expectedConfig = await stockSupervisorConfig(
    selected,
    `${manifest}\n`,
    async (flags) => {
      calls.push(flags);
      return flags.length
        ? inspected
        : {
            Descriptor: {
              mediaType: "application/vnd.oci.image.index.v1+json",
              digest: sha256(index),
            },
          };
    },
    "linux/amd64",
  );
  assert.deepEqual(calls, [[], ["--platform", "linux/amd64"]]);
  assert.equal(
    await stockSupervisorConfig(
      selected,
      manifest,
      async (flags) => {
        assert.deepEqual(flags, []);
        return inspectedConfig;
      },
      "linux/amd64",
    ),
    expectedConfig,
  );

  await assert.rejects(
    stockSupervisorConfig(
      selected,
      manifest,
      async () => ({
        Id: sha256("substitute"),
        Os: "linux",
        Architecture: "amd64",
      }),
      "linux/amd64",
    ),
    /differs from the pinned config/u,
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
