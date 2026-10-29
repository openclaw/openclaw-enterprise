import { readFile } from "node:fs/promises";
import { certificateAuthority, signedLeaf } from "./certificates.mjs";
import { temporaryDirectory } from "./temporary-directory.mjs";

/**
 * Local test-owned CA and a localhost leaf; no host trust or credentials are read.
 * Callers pass the result straight to TLS servers as options, so no field may use a
 * TLS option name: the CA is `authority`, not `ca`.
 */
export async function harnessTlsFixture(t) {
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
