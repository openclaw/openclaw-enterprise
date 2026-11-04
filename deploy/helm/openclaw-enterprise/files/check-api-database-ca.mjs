import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isIP } from "node:net";
import { resolve } from "node:path";

// Loaded before the API entrypoint, in its own process and credential environment.
// argv[2] is the chart-selected database CA file, never a connection URL.
// OCC_DATABASE_CA_SOURCE names the operator's Secret and key for CA errors.
class CaError extends Error {}

function databaseCa(path) {
  let ca;
  try {
    ca = readFileSync(path, "utf8");
  } catch (error) {
    throw new CaError(
      error?.code === "ENOENT"
        ? "not found in the Pod; check that the Secret and key exist"
        : `cannot be read (${error?.code ?? "unknown error"})`,
    );
  }
  const blocks = ca.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
  if (Buffer.byteLength(ca) > 1024 * 1024) {
    throw new CaError("the value is larger than 1 MiB");
  }
  if (ca.trim() === "") {
    throw new CaError("the value is empty; it must hold one or more PEM CA certificates");
  }
  if (
    blocks.length === 0 ||
    ca.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, "").trim()
  ) {
    throw new CaError("the value must hold only PEM CA certificates (no keys or other text)");
  }
  blocks.forEach((block, index) => {
    let certificate;
    try {
      certificate = new X509Certificate(block);
    } catch {
      throw new CaError(
        `certificate ${index + 1} of ${blocks.length} is not a valid X.509 certificate`,
      );
    }
    if (!certificate.ca) {
      throw new CaError(
        `certificate ${index + 1} of ${blocks.length} (${certificate.subject.replace(/\n/g, ", ")}) is not a CA certificate; use the database server's issuing CA`,
      );
    }
  });
  return ca;
}

try {
  const databaseUrl = process.env.OCC_DATABASE_URL;
  const url = new URL(databaseUrl);
  const parameters = url.searchParams;
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    new Set(parameters.keys()).size !== [...parameters.keys()].length ||
    parameters.has("connectionString") ||
    parameters.get("sslmode") !== "verify-full" ||
    parameters.get("sslrootcert") !== process.argv[2]
  ) {
    throw new Error();
  }
  const ca = databaseCa(process.argv[2]);
  // Use the installed consumer's parser, including its ssl/URL precedence rules.
  // Workload identity uses the same parser and preserves ssl.ca when adding its token.
  const require = createRequire(resolve("packages/occ/package.json"));
  const { Client } = require("pg");
  const { host, ssl } = new Client({ connectionString: databaseUrl }).connectionParameters;
  if (
    !ssl ||
    ssl.ca !== ca ||
    ssl.rejectUnauthorized === false ||
    ssl.checkServerIdentity !== undefined ||
    // pg sets the TLS servername only for DNS hosts. For an IP literal Node then checks
    // the certificate against "localhost", so verify-full would not verify the host.
    // A Unix socket path has no certificate identity either.
    typeof host !== "string" ||
    isIP(host.replace(/^\[(.*)\]$/, "$1")) !== 0 ||
    host.startsWith("/")
  ) {
    throw new Error();
  }
} catch (error) {
  if (error instanceof CaError) {
    // Only certificate subjects (public) and chart-supplied names reach this message.
    const source = process.env.OCC_DATABASE_CA_SOURCE || "the database CA";
    process.stderr.write(
      `check-api-database-ca: ${source}: ${error.message.replace(/\s+/g, " ")}\n`,
    );
    process.exit(1);
  }
  // URL, parser and filesystem exceptions can contain credentials. Never print them.
  process.stderr.write(
    "OIDC CA trust requires OCC_DATABASE_URL with a DNS hostname (not an IP address), sslmode=verify-full and sslrootcert selecting the mounted database CA; duplicate parameters and nested connection strings are unsupported.\n",
  );
  process.exit(1);
}
