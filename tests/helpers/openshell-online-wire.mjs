import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createOpenShellOnlineAuthority } from "../../apps/controller/src/drivers/egress-proxy/openshell-online-authority.ts";
import { harnessTlsFixture } from "./harness-tls.mjs";

const require = createRequire(new URL("../../apps/controller/package.json", import.meta.url));
export const grpc = require("@grpc/grpc-js");
const loader = require("@grpc/proto-loader");

export function token(keys, kind, sandboxId, audience = "online-authorizer") {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(
    JSON.stringify({ alg: "EdDSA", typ: "openshell-ext+jwt", kid: "gateway-key" }),
  ).toString("base64url");
  const claims = Buffer.from(
    JSON.stringify({
      iss: "https://gateway.example.test",
      aud: audience,
      sub:
        kind === "gateway"
          ? "https://gateway.example.test"
          : `spiffe://openshell/sandbox/${sandboxId}`,
      iat: now,
      exp: now + 300,
      jti: randomUUID(),
      caller_kind: kind,
      ...(kind === "supervisor" ? { sandbox_id: sandboxId } : {}),
    }),
  ).toString("base64url");
  const signed = `${header}.${claims}`;
  return `Bearer ${signed}.${sign(null, Buffer.from(signed), keys.privateKey).toString("base64url")}`;
}

export function invoke(client, method, request, bearer) {
  const metadata = new grpc.Metadata();
  metadata.set("authorization", bearer);
  return new Promise((resolve, reject) => {
    client[method](request, metadata, { deadline: Date.now() + 5000 }, (error, result) =>
      error ? reject(error) : resolve(result),
    );
  });
}

export async function openShellOnlineWire(
  t,
  registrationName,
  options,
  createAuthority = createOpenShellOnlineAuthority,
) {
  const { key, cert, caBundle, rootCertificatePath } = await harnessTlsFixture(t);
  const keys = generateKeyPairSync("ed25519");
  const server = createAuthority({
    ...options,
    identity: {
      issuer: "https://gateway.example.test",
      audience: "online-authorizer",
      keyId: "gateway-key",
      publicKey: keys.publicKey.export({ type: "spki", format: "pem" }),
    },
    registrationName,
  });
  const port = await new Promise((resolve, reject) =>
    server.bindAsync(
      "127.0.0.1:0",
      grpc.ServerCredentials.createSsl(
        null,
        [{ private_key: Buffer.from(key), cert_chain: Buffer.from(cert) }],
        false,
      ),
      (error, bound) => (error ? reject(error) : resolve(bound)),
    ),
  );
  t.after(() => server.forceShutdown());
  // An independently supplied released OpenShell proto can serve as the client decoder.
  const proto =
    process.env.OCC_TEST_OPENSHELL_MIDDLEWARE_PROTO ??
    fileURLToPath(
      new URL(
        "../../apps/controller/src/drivers/egress-proxy/proto/supervisor_middleware.proto",
        import.meta.url,
      ),
    );
  const definition = loader.loadSync(proto, {
    keepCase: true,
    longs: String,
    enums: Number,
    defaults: false,
    oneofs: true,
  });
  const Client =
    grpc.loadPackageDefinition(definition).openshell.middleware.v1.SupervisorMiddleware;
  const client = new Client(`localhost:${port}`, grpc.credentials.createSsl(Buffer.from(caBundle)));
  t.after(() => client.close());
  return {
    keys,
    client,
    endpoint: `https://localhost:${port}`,
    certFile: rootCertificatePath,
    close: () => server.forceShutdown(),
  };
}
