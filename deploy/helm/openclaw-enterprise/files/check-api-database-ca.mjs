import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isIP } from "node:net";
import { resolve } from "node:path";

// Loaded before the API entrypoint, in its own process and credential environment.
// argv[2] is the chart-selected database CA file, never a connection URL.
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
  const ca = readFileSync(process.argv[2], "utf8");
  const blocks = ca.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
  if (
    Buffer.byteLength(ca) > 1024 * 1024 ||
    !blocks?.length ||
    blocks.some((block) => !new X509Certificate(block).ca) ||
    ca.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, "").trim()
  ) {
    throw new Error();
  }
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
} catch {
  // URL, parser and filesystem exceptions can contain credentials. Never print them.
  process.stderr.write(
    "OIDC CA trust requires OCC_DATABASE_URL with a DNS hostname (not an IP address), sslmode=verify-full and sslrootcert selecting the mounted database CA; duplicate parameters and nested connection strings are unsupported.\n",
  );
  process.exit(1);
}
