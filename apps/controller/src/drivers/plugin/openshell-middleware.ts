import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  loadPackageDefinition,
  ServerCredentials,
  type Server,
  type ServiceDefinition,
} from "@grpc/grpc-js";
import { loadSync } from "@grpc/proto-loader";
import type { TlsListenerConfiguration } from "../../composition/installation-fields.ts";

export function loadOpenShellMiddleware(): ServiceDefinition {
  const definition = loadSync(
    fileURLToPath(new URL("./proto/supervisor_middleware.proto", import.meta.url)),
    { keepCase: true, longs: String, enums: Number, defaults: false, oneofs: true },
  );
  const loaded = loadPackageDefinition(definition) as unknown as {
    openshell: { middleware: { v1: { SupervisorMiddleware: { service: ServiceDefinition } } } };
  };
  return loaded.openshell.middleware.v1.SupervisorMiddleware.service;
}

export async function bindOpenShellMiddleware(
  configuration: TlsListenerConfiguration,
  createServer: (publicKey: Buffer) => Server,
) {
  const [certificate, privateKey, publicKey] = await Promise.all([
    readFile(configuration.certificatePath),
    readFile(configuration.privateKeyPath),
    readFile(configuration.issuerPublicKeyPath),
  ]);
  const server = createServer(publicKey);
  try {
    await bindTls(
      server,
      `${configuration.host.includes(":") ? `[${configuration.host}]` : configuration.host}:${configuration.port}`,
      certificate,
      privateKey,
    );
  } catch (error) {
    server.forceShutdown();
    throw error;
  } finally {
    privateKey.fill(0);
  }
  return { close: () => server.forceShutdown() };
}

/** TLS is mandatory even on loopback; the JWT authenticates the supervisor separately. */
function bindTls(
  server: Server,
  address: string,
  certificate: Buffer,
  privateKey: Buffer,
): Promise<number> {
  const credentials = ServerCredentials.createSsl(
    null,
    [{ cert_chain: certificate, private_key: privateKey }],
    false,
  );
  return new Promise((resolve, reject) =>
    server.bindAsync(address, credentials, (error, port) =>
      error ? reject(error) : resolve(port),
    ),
  );
}
