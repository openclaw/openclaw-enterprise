import { readFile } from "node:fs/promises";

import { certificateAuthority, signedLeaf } from "./certificates.ts";
import type { CleanupRegistrar } from "./cleanup-registrar.ts";
import { temporaryDirectory } from "./temporary-directory.ts";

/**
 * Local test-owned CA and a localhost leaf; no host trust or credentials are read.
 * The result also serves as TLS server options. The `authority` field keeps the
 * fixture CA separate from the server's `ca` option.
 */
export async function harnessTlsFixture(t: CleanupRegistrar) {
  const directory = await temporaryDirectory(t, "oce-harness-tls-");
  const ca = await certificateAuthority(directory, { caName: "Harness fixture CA", days: 1 });
  const leaf = await signedLeaf(directory, ca, {
    name: "server",
    // Not a host name: clients fall back to the CN when a leaf has no SAN, so only
    // the SAN may name localhost.
    commonName: "Harness fixture server",
    subjectAltName: "DNS:localhost",
    days: 1,
  });
  return {
    directory,
    authority: ca,
    rootCertificatePath: ca.caPath,
    caBundle: await readFile(ca.caPath, "utf8"),
    cert: leaf.cert,
    key: leaf.key,
    certPath: leaf.certPath,
    keyPath: leaf.keyPath,
  };
}
